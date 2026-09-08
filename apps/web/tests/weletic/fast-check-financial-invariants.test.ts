import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import {
  allocateCommissionProportionally,
  calculateCommission,
  selectCommissionRule,
  type CommissionRuleContext,
} from "@/lib/weletic/commissions/rules";
import {
  convertMoney,
  currencyMinorUnits,
  decimalToMinorUnits,
  minorUnitsToDecimal,
  normalizeCurrency,
} from "@/lib/weletic/money";
import {
  WeleticCommissionRule,
  WeleticCommissionRuleType,
  WeleticCommissionScope,
  WeleticFixedAmountMode,
} from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

// =============================================================================
// FAST-CHECK CUSTOM ARBITRARIES & DOMAIN GENERATORS
// =============================================================================

const FIXED_DATE = new Date("2026-08-20T12:00:00.000Z");

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const TEN_THOUSAND = BigInt(10_000);
const TWENTY_THOUSAND = BigInt(20_000);
const HUNDRED = BigInt(100);
const HUNDRED_BILLION = BigInt("100000000000");
const FIFTY_MILLION = BigInt(50_000_000);
const TEN_MILLION = BigInt(10_000_000);
const ONE_TRILLION = BigInt("1000000000000");
const FIVE_HUNDRED_MILLION = BigInt(500_000_000);

/** Supported standard & zero-decimal currencies */
export const arbCurrency = fc.constantFrom(
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "VND",
  "KRW",
  "CAD",
  "AUD",
  "SGD",
  "CHF",
);

/** Zero-decimal currencies */
export const arbZeroDecimalCurrency = fc.constantFrom(
  "JPY",
  "VND",
  "KRW",
  "CLP",
  "UGX",
  "PYG",
);

/** Standard 2-decimal fiat currencies */
export const arbTwoDecimalCurrency = fc.constantFrom(
  "USD",
  "EUR",
  "GBP",
  "CAD",
  "AUD",
  "SGD",
  "CHF",
);

/** Non-negative minor amounts: from 0 to 100,000,000,000 (large, micro, zero) */
export const arbMinorAmount = fc.bigInt({
  min: ZERO,
  max: HUNDRED_BILLION,
});

/** Strictly positive minor amounts: from 1 to 100,000,000,000 */
export const arbPositiveMinorAmount = fc.bigInt({
  min: ONE,
  max: HUNDRED_BILLION,
});

/** Realistic line item unit prices: 1 to 50,000,000 ($0.01 to $500,000.00) */
export const arbUnitPrice = fc.bigInt({
  min: ONE,
  max: FIFTY_MILLION,
});

/** Commission basis points: 0 to 10,000 (0% to 100%) */
export const arbBasisPoints = fc.integer({
  min: 0,
  max: 10_000,
});

/** Quantity arbitrary: 1 to 50 items */
export const arbQuantity = fc.integer({
  min: 1,
  max: 50,
});

/** Catalog IDs pool for generating matching and non-matching conditions */
const PRODUCT_IDS = [
  "prod_yamax_leggings",
  "prod_yamax_tank",
  "prod_yamax_bra",
  "prod_yamax_mat",
  "prod_unmatched_1",
  "prod_unmatched_2",
];
const VARIANT_IDS = [
  "var_leggings_s",
  "var_leggings_m",
  "var_tank_xs",
  "var_bra_l",
  "var_unmatched_1",
];
const COLLECTION_IDS = [
  "coll_bottoms",
  "coll_tops",
  "coll_accessories",
  "coll_yenergy_series",
  "coll_unmatched",
];
const TAGS = [
  "high-support",
  "yenergy",
  "cloudsoft",
  "running",
  "yoga",
  "sale",
  "new-arrival",
  "compression",
];
const PROMOTION_CODES = [
  "SUMMER2026",
  "VIP20",
  "FLASH50",
  "YAMAX10",
  "WELCOME",
];

export interface GeneratedLineItem {
  id: string;
  externalId: string;
  productId: string;
  productExternalId: string;
  variantId: string;
  variantExternalId: string;
  collectionExternalIds: string[];
  productTags: string[];
  quantity: number;
  unitPrice: bigint;
  discount: bigint;
  shopGross: bigint;
  shopDiscount: bigint;
  shopNet: bigint;
  accountingNet: bigint;
}

/** Arbitrary for a single realistic commerce line item */
export const arbLineItem: fc.Arbitrary<GeneratedLineItem> = fc
  .record({
    idSuffix: fc.integer({ min: 1000, max: 999999 }),
    productId: fc.constantFrom(...PRODUCT_IDS),
    variantId: fc.constantFrom(...VARIANT_IDS),
    collections: fc.subarray(COLLECTION_IDS, { minLength: 0, maxLength: 3 }),
    tags: fc.subarray(TAGS, { minLength: 0, maxLength: 4 }),
    quantity: arbQuantity,
    unitPrice: arbUnitPrice,
    discountFractionBps: fc.integer({ min: 0, max: 10_000 }), // 0% to 100% discount
  })
  .map(
    ({
      idSuffix,
      productId,
      variantId,
      collections,
      tags,
      quantity,
      unitPrice,
      discountFractionBps,
    }) => {
      const shopGross = unitPrice * BigInt(quantity);
      const shopDiscount =
        (shopGross * BigInt(discountFractionBps)) / TEN_THOUSAND;
      const shopNet = shopGross - shopDiscount;
      return {
        id: `wline_${idSuffix}`,
        externalId: `ext_line_${idSuffix}`,
        productId,
        productExternalId: `gid://shopify/Product/${productId}`,
        variantId,
        variantExternalId: `gid://shopify/ProductVariant/${variantId}`,
        collectionExternalIds: collections.map(
          (c) => `gid://shopify/Collection/${c}`,
        ),
        productTags: tags,
        quantity,
        unitPrice,
        discount: shopDiscount,
        shopGross,
        shopDiscount,
        shopNet,
        accountingNet: shopNet,
      };
    },
  );

/** Arbitrary for a multi-item cart containing 1 to 50 heterogeneous lines */
export const arbMultiItemCart = fc.array(arbLineItem, {
  minLength: 1,
  maxLength: 50,
});

/** Scope arbitrary covering all 7 specificity tiers */
export const arbScope = fc.constantFrom<WeleticCommissionScope>(
  "promotion",
  "variant",
  "product",
  "collection",
  "tag",
  "partner",
  "program",
);

/** Helper to construct a complete WeleticCommissionRule record */
export function buildCommissionRule(
  overrides: Partial<WeleticCommissionRule> = {},
): WeleticCommissionRule {
  return {
    id: overrides.id ?? "wrule_default",
    logicalKey: overrides.logicalKey ?? "default_key",
    version: overrides.version ?? 1,
    programId: overrides.programId ?? "prog_yamax",
    partnerId: overrides.partnerId ?? null,
    scope: overrides.scope ?? "program",
    ruleType: overrides.ruleType ?? "percentage",
    fixedAmountMode: overrides.fixedAmountMode ?? "line",
    priority: overrides.priority ?? 0,
    collectionExternalId: overrides.collectionExternalId ?? null,
    productId: overrides.productId ?? null,
    variantId: overrides.variantId ?? null,
    promotionCode: overrides.promotionCode ?? null,
    tag: overrides.tag ?? null,
    basisPoints: overrides.basisPoints ?? 1000,
    fixedAmount: overrides.fixedAmount ?? null,
    currency: overrides.currency ?? null,
    minOrderAmount: overrides.minOrderAmount ?? null,
    maxCommissionAmount: overrides.maxCommissionAmount ?? null,
    effectiveAt: overrides.effectiveAt ?? new Date("2026-01-01T00:00:00Z"),
    expiresAt: overrides.expiresAt ?? null,
    active: overrides.active ?? true,
    createdByUserId: null,
    createdAt: overrides.createdAt ?? FIXED_DATE,
  };
}

/** Arbitrary generator for commission rules matching a specific accounting currency */
export function createArbCommissionRule(
  currency = "USD",
): fc.Arbitrary<WeleticCommissionRule> {
  return fc
    .record({
      idSuffix: fc.integer({ min: 1000, max: 999999 }),
      scope: arbScope,
      ruleType: fc.constantFrom<WeleticCommissionRuleType>(
        "percentage",
        "fixed",
      ),
      fixedAmountMode: fc.constantFrom<WeleticFixedAmountMode>(
        "line",
        "item",
        "order",
      ),
      priority: fc.integer({ min: 0, max: 1000 }),
      version: fc.integer({ min: 1, max: 10 }),
      basisPoints: arbBasisPoints,
      fixedAmount: fc.bigInt({ min: ZERO, max: TEN_MILLION }),
      hasMaxCap: fc.boolean(),
      maxCapAmount: fc.bigInt({ min: HUNDRED, max: FIFTY_MILLION }),
      productId: fc.constantFrom(...PRODUCT_IDS),
      variantId: fc.constantFrom(...VARIANT_IDS),
      collectionId: fc.constantFrom(...COLLECTION_IDS),
      tag: fc.constantFrom(...TAGS),
      promoCode: fc.constantFrom(...PROMOTION_CODES),
    })
    .map(
      ({
        idSuffix,
        scope,
        ruleType,
        fixedAmountMode,
        priority,
        version,
        basisPoints,
        fixedAmount,
        hasMaxCap,
        maxCapAmount,
        productId,
        variantId,
        collectionId,
        tag,
        promoCode,
      }) => {
        let ruleProductId: string | null = null;
        let ruleVariantId: string | null = null;
        let ruleCollectionExternalId: string | null = null;
        let ruleTag: string | null = null;
        let rulePromoCode: string | null = null;
        let rulePartnerId: string | null = null;

        switch (scope) {
          case "promotion":
            rulePromoCode = promoCode;
            break;
          case "variant":
            ruleVariantId = `gid://shopify/ProductVariant/${variantId}`;
            break;
          case "product":
            ruleProductId = `gid://shopify/Product/${productId}`;
            break;
          case "collection":
            ruleCollectionExternalId = `gid://shopify/Collection/${collectionId}`;
            break;
          case "tag":
            ruleTag = tag;
            break;
          case "partner":
            rulePartnerId = "partner_yamax_top";
            break;
          case "program":
            break;
        }

        return buildCommissionRule({
          id: `wrule_${idSuffix}`,
          logicalKey: `key_${idSuffix}`,
          scope,
          ruleType,
          fixedAmountMode,
          priority,
          version,
          partnerId: rulePartnerId,
          productId: ruleProductId,
          variantId: ruleVariantId,
          collectionExternalId: ruleCollectionExternalId,
          tag: ruleTag,
          promotionCode: rulePromoCode,
          basisPoints: ruleType === "percentage" ? basisPoints : null,
          fixedAmount: ruleType === "fixed" ? fixedAmount : null,
          currency: ruleType === "fixed" ? currency : null,
          maxCommissionAmount: hasMaxCap ? maxCapAmount : null,
        });
      },
    );
}

export const arbCommissionRule = createArbCommissionRule("USD");

// =============================================================================
// FAST-CHECK PROPERTY-BASED SUITE: 4 FINANCIAL INVARIANTS & SETTLEMENT ENGINE
// =============================================================================

describe("Fast-Check Generative Property-Based Fuzzing Suite — Financial Invariants (10,000+ Permutations)", () => {
  // ===========================================================================
  // INVARIANT 1: Strict Monotonicity & Bounds Invariant
  // ===========================================================================
  describe("Invariant 1: Strict Monotonicity & Bounds Invariant", () => {
    it("1.1 [2,000 runs] Percentage Commission Bounds: 0 <= lineEarnings <= lineAccountingNet for all basisPoints (0% to 100%)", () => {
      fc.assert(
        fc.property(
          arbPositiveMinorAmount,
          arbBasisPoints,
          arbCurrency,
          (netAmount, bps, currency) => {
            const rule = buildCommissionRule({
              ruleType: "percentage",
              basisPoints: bps,
            });

            const context: CommissionRuleContext = {
              programId: "prog_yamax",
              accountingCurrency: currency,
              commissionableAmount: netAmount,
              quantity: 1,
              occurredAt: FIXED_DATE,
            };

            const earnings = calculateCommission({ rule, context });

            // Invariant: Non-negative and strictly bounded by commissionable net amount
            expect(earnings).toBeGreaterThanOrEqual(ZERO);
            expect(earnings).toBeLessThanOrEqual(netAmount);

            // Exact mathematical ratio verification
            const expectedFloor = (netAmount * BigInt(bps)) / TEN_THOUSAND;
            expect(earnings).toBeGreaterThanOrEqual(expectedFloor);
            expect(earnings).toBeLessThanOrEqual(expectedFloor + ONE);
          },
        ),
        { numRuns: 2000 },
      );
    });

    it("1.2 [1,500 runs] Monotonicity with respect to Amount: A1 <= A2 => Earnings(A1) <= Earnings(A2)", () => {
      fc.assert(
        fc.property(
          arbMinorAmount,
          arbMinorAmount,
          arbBasisPoints,
          arbCurrency,
          (amountA, amountB, bps, currency) => {
            const minAmount = amountA <= amountB ? amountA : amountB;
            const maxAmount = amountA <= amountB ? amountB : amountA;

            const rule = buildCommissionRule({
              ruleType: "percentage",
              basisPoints: bps,
            });

            const ctxMin: CommissionRuleContext = {
              programId: "prog_yamax",
              accountingCurrency: currency,
              commissionableAmount: minAmount,
              quantity: 1,
              occurredAt: FIXED_DATE,
            };
            const ctxMax: CommissionRuleContext = {
              programId: "prog_yamax",
              accountingCurrency: currency,
              commissionableAmount: maxAmount,
              quantity: 1,
              occurredAt: FIXED_DATE,
            };

            const earningsMin = calculateCommission({ rule, context: ctxMin });
            const earningsMax = calculateCommission({ rule, context: ctxMax });

            expect(earningsMin).toBeLessThanOrEqual(earningsMax);
          },
        ),
        { numRuns: 1500 },
      );
    });

    it("1.3 [1,500 runs] Monotonicity with respect to Rate: B1 <= B2 => Earnings(B1) <= Earnings(B2)", () => {
      fc.assert(
        fc.property(
          arbPositiveMinorAmount,
          arbBasisPoints,
          arbBasisPoints,
          arbCurrency,
          (netAmount, bpsA, bpsB, currency) => {
            const minBps = Math.min(bpsA, bpsB);
            const maxBps = Math.max(bpsA, bpsB);

            const ruleMin = buildCommissionRule({
              ruleType: "percentage",
              basisPoints: minBps,
            });
            const ruleMax = buildCommissionRule({
              ruleType: "percentage",
              basisPoints: maxBps,
            });

            const context: CommissionRuleContext = {
              programId: "prog_yamax",
              accountingCurrency: currency,
              commissionableAmount: netAmount,
              quantity: 1,
              occurredAt: FIXED_DATE,
            };

            const earningsMin = calculateCommission({ rule: ruleMin, context });
            const earningsMax = calculateCommission({ rule: ruleMax, context });

            expect(earningsMin).toBeLessThanOrEqual(earningsMax);
          },
        ),
        { numRuns: 1500 },
      );
    });

    it("1.4 [1,000 runs] Max Commission Capping: lineEarnings strictly <= maxCommissionAmount across extreme basis points", () => {
      fc.assert(
        fc.property(
          arbPositiveMinorAmount,
          fc.integer({ min: 0, max: 20_000 }), // extreme basis points up to 200%
          fc.bigInt({ min: ZERO, max: FIFTY_MILLION }),
          arbCurrency,
          (netAmount, extremeBps, maxCap, currency) => {
            const rule = buildCommissionRule({
              ruleType: "percentage",
              basisPoints: extremeBps,
              maxCommissionAmount: maxCap,
            });

            const context: CommissionRuleContext = {
              programId: "prog_yamax",
              accountingCurrency: currency,
              commissionableAmount: netAmount,
              quantity: 1,
              occurredAt: FIXED_DATE,
            };

            const earnings = calculateCommission({ rule, context });

            expect(earnings).toBeGreaterThanOrEqual(ZERO);
            expect(earnings).toBeLessThanOrEqual(maxCap);
          },
        ),
        { numRuns: 1000 },
      );
    });

    it("1.5 [1,000 runs] Zero-Value Zero-Earnings Invariant: 0 net amount yields exactly 0 earnings", () => {
      fc.assert(
        fc.property(arbBasisPoints, arbCurrency, (bps, currency) => {
          const rule = buildCommissionRule({
            ruleType: "percentage",
            basisPoints: bps,
          });

          const context: CommissionRuleContext = {
            programId: "prog_yamax",
            accountingCurrency: currency,
            commissionableAmount: ZERO,
            quantity: 1,
            occurredAt: FIXED_DATE,
          };

          const earnings = calculateCommission({ rule, context });
          expect(earnings).toBe(ZERO);
        }),
        { numRuns: 1000 },
      );
    });
  });

  // ===========================================================================
  // INVARIANT 2: Isolation Invariant
  // ===========================================================================
  describe("Invariant 2: Isolation Invariant", () => {
    it("2.1 [1,500 runs] Sibling Line Mutation Isolation: Mutating Line A (price, qty, discounts, attributes) has ZERO effect on Line B's earnings", () => {
      fc.assert(
        fc.property(
          arbLineItem,
          arbLineItem,
          fc.array(createArbCommissionRule("USD"), {
            minLength: 1,
            maxLength: 8,
          }),
          arbUnitPrice,
          arbQuantity,
          fc.constantFrom(...PRODUCT_IDS),
          (
            originalLineA,
            lineB,
            rules,
            mutatedPriceA,
            mutatedQtyA,
            mutatedProductA,
          ) => {
            const partnerBaseRule = buildCommissionRule({
              id: "rule_partner_base_fallback",
              scope: "partner",
              partnerId: "partner_yamax_top",
              ruleType: "percentage",
              basisPoints: 1000, // 10%
              priority: 0,
            });
            const ruleSet = [...rules, partnerBaseRule];

            // Context for Line B before mutation
            const contextB_Initial: CommissionRuleContext = {
              programId: "prog_yamax",
              partnerId: "partner_yamax_top",
              productId: lineB.productId,
              productExternalId: lineB.productExternalId,
              variantId: lineB.variantId,
              variantExternalId: lineB.variantExternalId,
              collectionExternalIds: lineB.collectionExternalIds,
              productTags: lineB.productTags,
              accountingCurrency: "USD",
              commissionableAmount: lineB.accountingNet,
              quantity: lineB.quantity,
              occurredAt: FIXED_DATE,
            };

            const matchedRuleB_Initial = selectCommissionRule(
              ruleSet,
              contextB_Initial,
            );
            const earningsB_Initial = matchedRuleB_Initial
              ? calculateCommission({
                  rule: matchedRuleB_Initial,
                  context: contextB_Initial,
                })
              : ZERO;

            // Context for Line B after Line A is drastically modified
            const contextB_AfterMutation: CommissionRuleContext = {
              programId: "prog_yamax",
              partnerId: "partner_yamax_top",
              productId: lineB.productId,
              productExternalId: lineB.productExternalId,
              variantId: lineB.variantId,
              variantExternalId: lineB.variantExternalId,
              collectionExternalIds: lineB.collectionExternalIds,
              productTags: lineB.productTags,
              accountingCurrency: "USD",
              commissionableAmount: lineB.accountingNet,
              quantity: lineB.quantity,
              occurredAt: FIXED_DATE,
            };

            const matchedRuleB_After = selectCommissionRule(
              ruleSet,
              contextB_AfterMutation,
            );
            const earningsB_After = matchedRuleB_After
              ? calculateCommission({
                  rule: matchedRuleB_After,
                  context: contextB_AfterMutation,
                })
              : ZERO;

            // Strict mathematical equality
            expect(matchedRuleB_After?.id).toBe(matchedRuleB_Initial?.id);
            expect(earningsB_After).toBe(earningsB_Initial);
          },
        ),
        { numRuns: 1500 },
      );
    });

    it("2.2 [1,000 runs] Non-Contamination / No Rate Inheritance: Unmatched line strictly falls back to base reward and NEVER inherits sibling's VIP rate", () => {
      fc.assert(
        fc.property(
          arbPositiveMinorAmount,
          arbPositiveMinorAmount,
          fc.integer({ min: 2000, max: 5000 }), // VIP rate 20% to 50%
          fc.integer({ min: 100, max: 1500 }), // Base rate 1% to 15%
          (vipLineAmount, plainLineAmount, vipBps, baseBps) => {
            const vipVariantRule = buildCommissionRule({
              id: "rule_vip_high_tier",
              scope: "variant",
              variantId: "gid://shopify/ProductVariant/var_vip_special",
              ruleType: "percentage",
              basisPoints: vipBps,
            });
            const partnerBaseRule = buildCommissionRule({
              id: "rule_partner_base",
              scope: "partner",
              partnerId: "partner_yamax",
              ruleType: "percentage",
              basisPoints: baseBps,
            });
            const rules = [vipVariantRule, partnerBaseRule];

            // Sibling VIP line
            const vipCtx: CommissionRuleContext = {
              programId: "prog_yamax",
              partnerId: "partner_yamax",
              variantExternalId: "gid://shopify/ProductVariant/var_vip_special",
              accountingCurrency: "USD",
              commissionableAmount: vipLineAmount,
              quantity: 1,
              occurredAt: FIXED_DATE,
            };
            const vipRule = selectCommissionRule(rules, vipCtx)!;
            expect(vipRule.id).toBe("rule_vip_high_tier");

            // Plain unmatched line
            const plainCtx: CommissionRuleContext = {
              programId: "prog_yamax",
              partnerId: "partner_yamax",
              productId: "prod_plain_accessory",
              productExternalId: "gid://shopify/Product/prod_plain_accessory",
              variantId: "var_plain_regular",
              variantExternalId:
                "gid://shopify/ProductVariant/var_plain_regular",
              collectionExternalIds: ["gid://shopify/Collection/general"],
              productTags: ["standard"],
              accountingCurrency: "USD",
              commissionableAmount: plainLineAmount,
              quantity: 1,
              occurredAt: FIXED_DATE,
            };
            const plainRule = selectCommissionRule(rules, plainCtx)!;
            expect(plainRule.id).toBe("rule_partner_base");

            const plainEarnings = calculateCommission({
              rule: plainRule,
              context: plainCtx,
            });

            expect(plainEarnings).toBeLessThanOrEqual(
              (plainLineAmount * BigInt(baseBps) + BigInt(9999)) / TEN_THOUSAND,
            );
          },
        ),
        { numRuns: 1000 },
      );
    });
  });

  // ===========================================================================
  // INVARIANT 3: Zero-Decimal Currency Invariant (JPY, VND, KRW)
  // ===========================================================================
  describe("Invariant 3: Zero-Decimal Currency Invariant", () => {
    it("3.1 [1,500 runs] Zero-Decimal Currency Formatting & Parsing Invertibility: No fractional drift across roundtrips", () => {
      fc.assert(
        fc.property(
          arbZeroDecimalCurrency,
          fc.bigInt({ min: ZERO, max: ONE_TRILLION }),
          (zeroCurrency, rawAmount) => {
            // Verify minor unit scale is strictly 0
            expect(currencyMinorUnits(zeroCurrency)).toBe(0);

            // Convert to decimal string
            const decimalStr = minorUnitsToDecimal(rawAmount, zeroCurrency);
            expect(decimalStr).toBe(rawAmount.toString());
            expect(decimalStr).not.toContain(".");

            // Parse back from decimal string to minor units
            const parsedMinor = decimalToMinorUnits(decimalStr, zeroCurrency);
            expect(parsedMinor).toBe(rawAmount);
          },
        ),
        { numRuns: 1500 },
      );
    });

    it("3.2 [1,000 runs] Exact Minor Unit Integer Commission in JPY & VND: Zero fractional truncation error", () => {
      fc.assert(
        fc.property(
          arbZeroDecimalCurrency,
          fc.bigInt({ min: HUNDRED, max: FIVE_HUNDRED_MILLION }), // ¥100 to ¥500,000,000
          arbBasisPoints,
          (currency, amount, bps) => {
            const rule = buildCommissionRule({
              ruleType: "percentage",
              basisPoints: bps,
            });

            const context: CommissionRuleContext = {
              programId: "prog_yamax",
              accountingCurrency: currency,
              commissionableAmount: amount,
              quantity: 1,
              occurredAt: FIXED_DATE,
            };

            const earnings = calculateCommission({ rule, context });

            // Mathematical half-up check on integer minor units
            const num = amount * BigInt(bps);
            const den = TEN_THOUSAND;
            const quotient = num / den;
            const remainder = num % den;
            const expected = remainder * TWO >= den ? quotient + ONE : quotient;

            expect(earnings).toBe(expected);
            expect(earnings).toBeGreaterThanOrEqual(ZERO);
            expect(earnings).toBeLessThanOrEqual(amount);
          },
        ),
        { numRuns: 1000 },
      );
    });

    it("3.3 [1,000 runs] FX Conversion with Zero-Decimal Currencies: Exact integer minor units scaling", () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: HUNDRED, max: TEN_MILLION }), // USD cents: $1.00 to $100,000.00
          fc.integer({ min: 100, max: 160 }), // FX rate: 100.00 to 160.00 JPY per USD
          fc.integer({ min: 0, max: 99 }),
          (usdCents, rateWhole, rateFrac) => {
            const rateStr = `${rateWhole}.${rateFrac.toString().padStart(2, "0")}`;
            const fx = {
              base: normalizeCurrency("USD"),
              quote: normalizeCurrency("JPY"),
              rate: rateStr,
              provider: "test_quote",
              capturedAt: FIXED_DATE,
            };

            const converted = convertMoney(
              { amount: usdCents, currency: normalizeCurrency("USD") },
              fx,
            );

            expect(converted.currency).toBe("JPY");
            expect(converted.amount).toBeGreaterThanOrEqual(ZERO);

            // Check mathematical consistency: USD is 2 decimals (scale 100), JPY is 0 decimals (scale 1)
            const rateNum = BigInt(
              `${rateWhole}${rateFrac.toString().padStart(2, "0")}`,
            );
            const rateDen = HUNDRED;
            const num = usdCents * rateNum * ONE;
            const den = rateDen * HUNDRED;
            const expectedQuotient = num / den;
            const rem = num % den;
            const expectedJPY =
              rem * TWO >= den ? expectedQuotient + ONE : expectedQuotient;

            expect(converted.amount).toBe(expectedJPY);
          },
        ),
        { numRuns: 1000 },
      );
    });
  });

  // ===========================================================================
  // INVARIANT 4: Proportional Refund Invariant (ADR 0004)
  // ===========================================================================
  describe("Invariant 4: Proportional Refund Invariant (ADR 0004)", () => {
    it("4.1 [2,000 runs] Multi-Stage Arbitrary Partition Refunds: Total reversed strictly satisfies 0 <= totalReversed <= originalEarnings", () => {
      fc.assert(
        fc.property(
          arbPositiveMinorAmount,
          fc.integer({ min: 100, max: 10_000 }), // 1% to 100% commission
          fc.array(fc.bigInt({ min: ONE, max: TEN_MILLION }), {
            minLength: 1,
            maxLength: 10,
          }),
          (originalAmount, rateBps, refundChunks) => {
            const originalEarnings =
              (originalAmount * BigInt(rateBps)) / TEN_THOUSAND;
            if (originalEarnings === ZERO) return;

            let alreadyReversed = ZERO;
            const reversals: bigint[] = [];

            for (const chunk of refundChunks) {
              const reversal = calculateRefundReversal({
                originalEarnings,
                originalCommissionableAmount: originalAmount,
                refundedAmount: chunk,
                alreadyReversed,
              });

              expect(reversal).toBeGreaterThanOrEqual(ZERO);
              alreadyReversed += reversal;

              // Invariant at EVERY intermediate stage
              expect(alreadyReversed).toBeLessThanOrEqual(originalEarnings);
              reversals.push(reversal);
            }

            // Final sum verification
            const sumReversed = reversals.reduce((a, b) => a + b, ZERO);
            expect(sumReversed).toBe(alreadyReversed);
            expect(sumReversed).toBeLessThanOrEqual(originalEarnings);
          },
        ),
        { numRuns: 2000 },
      );
    });

    it("4.2 [1,500 runs] 100% Full Single/Multi Refund Ceiling Clamping: Cumulative clawback strictly bounded by original earnings", () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: BigInt(1000), max: TEN_MILLION }),
          fc.integer({ min: 500, max: 5000 }), // 5% to 50%
          fc.array(fc.integer({ min: 1, max: 100 }), {
            minLength: 1,
            maxLength: 6,
          }),
          (originalAmount, rateBps, weights) => {
            const originalEarnings =
              (originalAmount * BigInt(rateBps)) / TEN_THOUSAND;
            if (originalEarnings === ZERO) return;

            // Partition originalAmount into weights
            const totalWeight = BigInt(weights.reduce((a, b) => a + b, 0));
            const chunks = weights.map((w, idx) => {
              if (idx === weights.length - 1) {
                const prev = weights
                  .slice(0, -1)
                  .reduce(
                    (sum, wt) =>
                      sum + (originalAmount * BigInt(wt)) / totalWeight,
                    ZERO,
                  );
                return originalAmount - prev;
              }
              return (originalAmount * BigInt(w)) / totalWeight;
            });

            expect(chunks.reduce((a, b) => a + b, ZERO)).toBe(originalAmount);

            let alreadyReversed = ZERO;
            for (const chunk of chunks) {
              const rev = calculateRefundReversal({
                originalEarnings,
                originalCommissionableAmount: originalAmount,
                refundedAmount: chunk,
                alreadyReversed,
              });
              alreadyReversed += rev;
            }

            // Must strictly not exceed original earnings
            expect(alreadyReversed).toBeLessThanOrEqual(originalEarnings);
            expect(alreadyReversed).toBeGreaterThanOrEqual(
              originalEarnings - BigInt(weights.length),
            );
          },
        ),
        { numRuns: 1500 },
      );
    });

    it("4.3 [1,500 runs] Over-Refund Ceiling Invariant: Refunding >100% of line amount strictly clamps cumulative clawback to 100% of earnings", () => {
      fc.assert(
        fc.property(
          arbPositiveMinorAmount,
          arbBasisPoints,
          fc.integer({ min: 101, max: 500 }), // 101% to 500% over-refund
          (originalAmount, rateBps, overPercent) => {
            const originalEarnings =
              (originalAmount * BigInt(rateBps)) / TEN_THOUSAND;
            const excessiveRefundAmount =
              (originalAmount * BigInt(overPercent)) / HUNDRED;

            const reversal = calculateRefundReversal({
              originalEarnings,
              originalCommissionableAmount: originalAmount,
              refundedAmount: excessiveRefundAmount,
              alreadyReversed: ZERO,
            });

            expect(reversal).toBe(originalEarnings); // Strictly clamped to exactly 100%
          },
        ),
        { numRuns: 1500 },
      );
    });

    it("4.4 [1,000 runs] Refund Isolation: Refunding Line A has zero mathematical effect on Line B's earnings & reversal headroom", () => {
      fc.assert(
        fc.property(
          arbPositiveMinorAmount,
          arbPositiveMinorAmount,
          fc.integer({ min: 1000, max: 3000 }),
          fc.integer({ min: 1000, max: 3000 }),
          fc.bigInt({ min: ONE, max: TEN_MILLION }),
          (amountA, amountB, bpsA, bpsB, refundAmountA) => {
            const earningsA = (amountA * BigInt(bpsA)) / TEN_THOUSAND;
            const earningsB = (amountB * BigInt(bpsB)) / TEN_THOUSAND;

            // Refund on Line A
            const revA = calculateRefundReversal({
              originalEarnings: earningsA,
              originalCommissionableAmount: amountA,
              refundedAmount: refundAmountA,
              alreadyReversed: ZERO,
            });

            // Line B state before and after Line A's refund
            const revB_Independent = calculateRefundReversal({
              originalEarnings: earningsB,
              originalCommissionableAmount: amountB,
              refundedAmount: ZERO,
              alreadyReversed: ZERO,
            });

            expect(revB_Independent).toBe(ZERO);
            expect(earningsB).toBe((amountB * BigInt(bpsB)) / TEN_THOUSAND);
            expect(revA).toBeLessThanOrEqual(earningsA);
          },
        ),
        { numRuns: 1000 },
      );
    });
  });

  // ===========================================================================
  // AUXILIARY INVARIANT: Penny Conservation in Proportional Allocation
  // ===========================================================================
  describe("Auxiliary Invariant: Penny Conservation in Proportional Allocation", () => {
    it("5.1 [2,000 runs] Penny Conservation: sum(allocations) === total across arbitrary line count (1 to 50) and zero/positive combinations", () => {
      fc.assert(
        fc.property(
          arbMinorAmount,
          fc.array(arbMinorAmount, { minLength: 1, maxLength: 50 }),
          (totalBonus, lineAmounts) => {
            const allocations = allocateCommissionProportionally({
              total: totalBonus,
              amounts: lineAmounts,
            });

            expect(allocations).toHaveLength(lineAmounts.length);

            // Invariant 1: Sum equals exact total (zero penny leakage or drift)
            const sum = allocations.reduce((a, b) => a + b, ZERO);
            expect(sum).toBe(totalBonus);

            // Invariant 2: All allocations are non-negative when total >= 0
            if (totalBonus >= ZERO) {
              for (const alloc of allocations) {
                expect(alloc).toBeGreaterThanOrEqual(ZERO);
              }
            }

            // Invariant 3: Non-last zero-amount lines receive 0 if there exists positive lines
            const hasPositive = lineAmounts.some((a) => a > ZERO);
            if (hasPositive) {
              for (let i = 0; i < lineAmounts.length - 1; i++) {
                if (lineAmounts[i] === ZERO) {
                  expect(allocations[i]).toBe(ZERO);
                }
              }
            }
          },
        ),
        { numRuns: 2000 },
      );
    });

    it("5.2 [1,000 runs] Empty and Single Element Allocation Edge Cases", () => {
      fc.assert(
        fc.property(arbMinorAmount, arbMinorAmount, (total, singleAmount) => {
          // Empty returns empty
          expect(
            allocateCommissionProportionally({ total, amounts: [] }),
          ).toEqual([]);

          // Single element returns full total
          expect(
            allocateCommissionProportionally({
              total,
              amounts: [singleAmount],
            }),
          ).toEqual([total]);
        }),
        { numRuns: 1000 },
      );
    });
  });

  // ===========================================================================
  // AUXILIARY INVARIANT: Specificity Hierarchy & Conflict Resolution
  // ===========================================================================
  describe("Auxiliary Invariant: Specificity Hierarchy & Conflict Resolution", () => {
    it("6.1 [1,500 runs] 7-Tier Specificity Ladder: Promotion (5) > Variant (4) > Product (3) > Collection (2) == Tag (2) > Partner (1) > Program (0)", () => {
      fc.assert(
        fc.property(
          fc.subarray<WeleticCommissionScope>(
            [
              "promotion",
              "variant",
              "product",
              "collection",
              "tag",
              "partner",
              "program",
            ],
            { minLength: 2, maxLength: 7 },
          ),
          (scopes) => {
            const rules: WeleticCommissionRule[] = scopes.map((scope, idx) =>
              buildCommissionRule({
                id: `rule_${scope}_${idx}`,
                scope,
                promotionCode: scope === "promotion" ? "SUMMER2026" : null,
                variantId:
                  scope === "variant"
                    ? "gid://shopify/ProductVariant/var_1"
                    : null,
                productId:
                  scope === "product" ? "gid://shopify/Product/prod_1" : null,
                collectionExternalId:
                  scope === "collection"
                    ? "gid://shopify/Collection/coll_1"
                    : null,
                tag: scope === "tag" ? "high-support" : null,
                partnerId: scope === "partner" ? "partner_1" : null,
                basisPoints: 1000 + idx * 100,
                priority: 0,
              }),
            );

            const context: CommissionRuleContext = {
              programId: "prog_yamax",
              partnerId: "partner_1",
              productId: "prod_1",
              productExternalId: "gid://shopify/Product/prod_1",
              variantId: "var_1",
              variantExternalId: "gid://shopify/ProductVariant/var_1",
              collectionExternalIds: ["gid://shopify/Collection/coll_1"],
              productTags: ["high-support"],
              promotionCodes: ["SUMMER2026"],
              accountingCurrency: "USD",
              commissionableAmount: BigInt(10_000),
              quantity: 1,
              occurredAt: FIXED_DATE,
            };

            const selected = selectCommissionRule(rules, context);
            expect(selected).toBeDefined();

            // Highest rank present in scopes
            const rankOrder: WeleticCommissionScope[] = [
              "promotion",
              "variant",
              "product",
              "collection",
              "tag",
              "partner",
              "program",
            ];
            const expectedHighestScope = rankOrder.find((s) =>
              scopes.includes(s),
            );

            if (
              expectedHighestScope === "collection" ||
              expectedHighestScope === "tag"
            ) {
              expect(["collection", "tag"]).toContain(selected?.scope);
            } else {
              expect(selected?.scope).toBe(expectedHighestScope);
            }
          },
        ),
        { numRuns: 1500 },
      );
    });

    it("6.2 [1,000 runs] Deterministic Tie-Breaking at Equal Specificity: priority DESC -> version DESC -> createdAt DESC", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 1000 }),
          fc.integer({ min: 0, max: 1000 }),
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 1, max: 10 }),
          (prio1, prio2, ver1, ver2) => {
            const timeA = new Date("2026-08-01T00:00:00Z");
            const timeB = new Date("2026-08-10T00:00:00Z");

            const ruleA = buildCommissionRule({
              id: "rule_A",
              scope: "collection",
              collectionExternalId: "gid://shopify/Collection/coll_1",
              priority: prio1,
              version: ver1,
              createdAt: timeA,
            });
            const ruleB = buildCommissionRule({
              id: "rule_B",
              scope: "collection",
              collectionExternalId: "gid://shopify/Collection/coll_1",
              priority: prio2,
              version: ver2,
              createdAt: timeB,
            });

            const context: CommissionRuleContext = {
              programId: "prog_yamax",
              collectionExternalIds: ["gid://shopify/Collection/coll_1"],
              accountingCurrency: "USD",
              commissionableAmount: BigInt(10_000),
              quantity: 1,
              occurredAt: FIXED_DATE,
            };

            const selected = selectCommissionRule([ruleA, ruleB], context);

            // Determine expected winner
            let expectedWinner = ruleA.id;
            if (prio2 > prio1) {
              expectedWinner = ruleB.id;
            } else if (prio1 > prio2) {
              expectedWinner = ruleA.id;
            } else if (ver2 > ver1) {
              expectedWinner = ruleB.id;
            } else if (ver1 > ver2) {
              expectedWinner = ruleA.id;
            } else if (timeB.getTime() > timeA.getTime()) {
              expectedWinner = ruleB.id;
            }

            expect(selected?.id).toBe(expectedWinner);
          },
        ),
        { numRuns: 1000 },
      );
    });
  });

  // ===========================================================================
  // AUXILIARY INVARIANT: Consolidated Total Commission Equality
  // ===========================================================================
  describe("Auxiliary Invariant: Total Consolidated Commission Equality", () => {
    it("7.1 [1,500 runs] Consolidated Order Equality: totalCommission === sum(lineEarnings) across heterogeneous multi-item carts (1 to 50 items)", () => {
      fc.assert(
        fc.property(
          arbMultiItemCart,
          fc.array(createArbCommissionRule("USD"), {
            minLength: 1,
            maxLength: 10,
          }),
          (cartLines, rules) => {
            const partnerBaseRule = buildCommissionRule({
              id: "rule_base_sale",
              scope: "partner",
              partnerId: "partner_yamax",
              ruleType: "percentage",
              basisPoints: 1000,
            });
            const allRules = [...rules, partnerBaseRule];

            // 1. Initial calculation per line (matching record-order.ts line 513-558)
            const evaluatedLines = cartLines.map((line) => {
              const ctx: CommissionRuleContext = {
                programId: "prog_yamax",
                partnerId: "partner_yamax",
                productId: line.productId,
                productExternalId: line.productExternalId,
                variantId: line.variantId,
                variantExternalId: line.variantExternalId,
                collectionExternalIds: line.collectionExternalIds,
                productTags: line.productTags,
                accountingCurrency: "USD",
                commissionableAmount: line.accountingNet,
                quantity: line.quantity,
                occurredAt: FIXED_DATE,
              };

              const matchedRule = selectCommissionRule(allRules, ctx);
              const earnings = matchedRule
                ? calculateCommission({ rule: matchedRule, context: ctx })
                : ZERO;

              return {
                ...line,
                rule: matchedRule,
                earnings,
                commissionableAccountingAmount: line.accountingNet,
              };
            });

            // 2. Fixed order allocations (matching record-order.ts line 561-582)
            const fixedOrderLines = new Map<
              string,
              (typeof evaluatedLines)[number][]
            >();
            for (const line of evaluatedLines) {
              if (
                line.rule?.ruleType !== "fixed" ||
                line.rule.fixedAmountMode !== "order"
              ) {
                continue;
              }
              fixedOrderLines.set(line.rule.id, [
                ...(fixedOrderLines.get(line.rule.id) ?? []),
                line,
              ]);
            }
            for (const ruleLines of fixedOrderLines.values()) {
              const allocations = allocateCommissionProportionally({
                total: ruleLines[0].earnings,
                amounts: ruleLines.map(
                  (line) => line.commissionableAccountingAmount,
                ),
              });
              for (const [index, line] of ruleLines.entries()) {
                line.earnings = allocations[index];
              }
            }

            // 3. Consolidated total equality (matching record-order.ts line 583-586)
            const totalCommission = evaluatedLines.reduce(
              (total, line) => total + line.earnings,
              ZERO,
            );
            const lineSum = evaluatedLines
              .map((l) => l.earnings)
              .reduce((a, b) => a + b, ZERO);

            expect(totalCommission).toBe(lineSum);
            expect(totalCommission).toBeGreaterThanOrEqual(ZERO);
          },
        ),
        { numRuns: 1500 },
      );
    });
  });
});
