import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import {
  allocateCommissionProportionally,
  calculateCommission,
  selectCommissionRule,
  type CommissionRuleContext,
} from "@/lib/weletic/commissions/rules";
import { currencyMinorUnits } from "@/lib/weletic/money";
import { WeleticCommissionRule } from "@prisma/client";
import { describe, expect, it } from "vitest";

const now = new Date("2026-08-20T12:00:00.000Z");

function divideAndRound(numerator: bigint, denominator: bigint) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * BigInt(2) >= denominator ? quotient + BigInt(1) : quotient;
}

function createRule(
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
    createdAt: overrides.createdAt ?? now,
  };
}

describe("Empirical Challenger: Line-Level Specificity & Multi-Item Settlement Adversarial Stress Harness", () => {
  // ===========================================================================
  // 1. SPECIFICITY HIERARCHY & DETERMINISTIC CONFLICT RESOLUTION
  // ===========================================================================
  describe("1. Specificity Hierarchy & Competing Rules Resolution", () => {
    it("1.1: 7-level strict hierarchy ladder selects the most specific rule", () => {
      const promotionRule = createRule({
        id: "rule_promo",
        scope: "promotion",
        promotionCode: "VIP50",
        basisPoints: 5000,
      });
      const variantRule = createRule({
        id: "rule_variant",
        scope: "variant",
        variantId: "gid://shopify/ProductVariant/v101",
        basisPoints: 4000,
      });
      const productRule = createRule({
        id: "rule_product",
        scope: "product",
        productId: "gid://shopify/Product/p201",
        basisPoints: 3000,
      });
      const collectionRule = createRule({
        id: "rule_collection",
        scope: "collection",
        collectionExternalId: "gid://shopify/Collection/c301",
        basisPoints: 2000,
      });
      const tagRule = createRule({
        id: "rule_tag",
        scope: "tag",
        tag: "yenergy",
        basisPoints: 1500,
      });
      const partnerRule = createRule({
        id: "rule_partner",
        scope: "partner",
        partnerId: "partner_top",
        basisPoints: 1200,
      });
      const programRule = createRule({
        id: "rule_program",
        scope: "program",
        basisPoints: 1000,
      });

      const fullContext: CommissionRuleContext = {
        programId: "prog_yamax",
        partnerId: "partner_top",
        productId: "p201",
        productExternalId: "gid://shopify/Product/p201",
        variantId: "v101",
        variantExternalId: "gid://shopify/ProductVariant/v101",
        collectionExternalIds: ["gid://shopify/Collection/c301"],
        productTags: ["yenergy", "bottoms"],
        promotionCodes: ["VIP50"],
        accountingCurrency: "USD",
        commissionableAmount: BigInt(10000),
        quantity: 1,
        occurredAt: now,
      };

      // Promotion beats all
      expect(
        selectCommissionRule(
          [
            programRule,
            partnerRule,
            tagRule,
            collectionRule,
            productRule,
            variantRule,
            promotionRule,
          ],
          fullContext,
        )?.id,
      ).toBe("rule_promo");

      // Variant beats Product, Collection, Tag, Partner, Program
      expect(
        selectCommissionRule(
          [
            programRule,
            partnerRule,
            tagRule,
            collectionRule,
            productRule,
            variantRule,
          ],
          fullContext,
        )?.id,
      ).toBe("rule_variant");

      // Product beats Collection, Tag, Partner, Program
      expect(
        selectCommissionRule(
          [programRule, partnerRule, tagRule, collectionRule, productRule],
          fullContext,
        )?.id,
      ).toBe("rule_product");

      // Collection & Tag beat Partner, Program
      expect(
        selectCommissionRule(
          [programRule, partnerRule, collectionRule],
          fullContext,
        )?.id,
      ).toBe("rule_collection");
      expect(
        selectCommissionRule([programRule, partnerRule, tagRule], fullContext)
          ?.id,
      ).toBe("rule_tag");

      // Partner beats Program
      expect(
        selectCommissionRule([programRule, partnerRule], fullContext)?.id,
      ).toBe("rule_partner");

      // Program is fallback
      expect(selectCommissionRule([programRule], fullContext)?.id).toBe(
        "rule_program",
      );
    });

    it("1.2: Deterministic resolution for competing same-level rules (priority DESC -> version DESC -> createdAt DESC)", () => {
      const timeEarly = new Date("2026-08-01T00:00:00Z");
      const timeLate = new Date("2026-08-15T00:00:00Z");

      // Collection Rule A vs Collection Rule B with different priorities
      const collLowPriority = createRule({
        id: "coll_low_prio",
        scope: "collection",
        collectionExternalId: "coll_1",
        priority: 10,
        version: 1,
        createdAt: timeLate,
      });
      const collHighPriority = createRule({
        id: "coll_high_prio",
        scope: "collection",
        collectionExternalId: "coll_2",
        priority: 100,
        version: 1,
        createdAt: timeEarly,
      });

      const multiCollCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        collectionExternalIds: ["coll_1", "coll_2"],
        accountingCurrency: "USD",
        commissionableAmount: BigInt(5000),
        quantity: 1,
        occurredAt: now,
      };

      expect(
        selectCommissionRule([collLowPriority, collHighPriority], multiCollCtx)
          ?.id,
      ).toBe("coll_high_prio");

      // Tag Rule vs Collection Rule (both Level 2): priority decides winner
      const tagRuleHigherPrio = createRule({
        id: "tag_rule_prio_990",
        scope: "tag",
        tag: "high-support",
        priority: 990,
        version: 1,
      });
      const collRuleLowerPrio = createRule({
        id: "coll_rule_prio_980",
        scope: "collection",
        collectionExternalId: "coll_1",
        priority: 980,
        version: 1,
      });

      const tagAndCollCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        collectionExternalIds: ["coll_1"],
        productTags: ["high-support"],
        accountingCurrency: "USD",
        commissionableAmount: BigInt(5000),
        quantity: 1,
        occurredAt: now,
      };

      expect(
        selectCommissionRule(
          [collRuleLowerPrio, tagRuleHigherPrio],
          tagAndCollCtx,
        )?.id,
      ).toBe("tag_rule_prio_990");

      // Same priority: version decides
      const ruleV1 = createRule({
        id: "rule_v1",
        scope: "product",
        productId: "p1",
        priority: 50,
        version: 1,
      });
      const ruleV2 = createRule({
        id: "rule_v2",
        scope: "product",
        productId: "p1",
        priority: 50,
        version: 2,
      });
      const prodCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        productId: "p1",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(5000),
        quantity: 1,
        occurredAt: now,
      };
      expect(selectCommissionRule([ruleV1, ruleV2], prodCtx)?.id).toBe(
        "rule_v2",
      );

      // Same priority and version: createdAt decides
      const ruleOlder = createRule({
        id: "rule_older",
        scope: "product",
        productId: "p1",
        priority: 50,
        version: 1,
        createdAt: timeEarly,
      });
      const ruleNewer = createRule({
        id: "rule_newer",
        scope: "product",
        productId: "p1",
        priority: 50,
        version: 1,
        createdAt: timeLate,
      });
      expect(selectCommissionRule([ruleOlder, ruleNewer], prodCtx)?.id).toBe(
        "rule_newer",
      );
    });

    it("1.3: Top-to-bottom modifier priority index formula (1000 - modIndex * 10) resolves overlapping modifiers", () => {
      // Simulate Reward.modifiers parsing where top modifier gets 1000, next 990, next 980
      const mod1_LeggingsCategory = createRule({
        id: "mod_index_0_leggings",
        scope: "collection",
        collectionExternalId: "coll_leggings",
        priority: Math.max(10, 1000 - 0 * 10), // 1000
        basisPoints: 2000, // 20%
      });
      const mod2_SummerSaleCategory = createRule({
        id: "mod_index_1_summer",
        scope: "collection",
        collectionExternalId: "coll_summer",
        priority: Math.max(10, 1000 - 1 * 10), // 990
        basisPoints: 1500, // 15%
      });
      const mod3_ClearanceCategory = createRule({
        id: "mod_index_2_clearance",
        scope: "collection",
        collectionExternalId: "coll_clearance",
        priority: Math.max(10, 1000 - 2 * 10), // 980
        basisPoints: 1200, // 12%
      });

      const productInAllThreeCollectionsCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        collectionExternalIds: [
          "coll_clearance",
          "coll_summer",
          "coll_leggings",
        ],
        accountingCurrency: "USD",
        commissionableAmount: BigInt(8000),
        quantity: 1,
        occurredAt: now,
      };

      const selected = selectCommissionRule(
        [
          mod3_ClearanceCategory,
          mod2_SummerSaleCategory,
          mod1_LeggingsCategory,
        ],
        productInAllThreeCollectionsCtx,
      );

      // Must pick the top-most modifier (mod1_LeggingsCategory with priority 1000)
      expect(selected?.id).toBe("mod_index_0_leggings");
      expect(selected?.priority).toBe(1000);
      expect(selected?.basisPoints).toBe(2000);
    });

    it("1.4: Strict boundary timestamp evaluation (effectiveAt and expiresAt)", () => {
      const timeStart = new Date("2026-08-20T10:00:00Z");
      const timeEnd = new Date("2026-08-20T18:00:00Z");

      const timedFlashRule = createRule({
        id: "rule_flash_sale",
        scope: "program",
        effectiveAt: timeStart,
        expiresAt: timeEnd,
        basisPoints: 3000,
      });

      const baseFallbackRule = createRule({
        id: "rule_base",
        scope: "program",
        effectiveAt: new Date(0),
        expiresAt: null,
        basisPoints: 1000,
      });

      const rules = [timedFlashRule, baseFallbackRule];

      // Before start time -> base fallback
      const beforeCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(10000),
        quantity: 1,
        occurredAt: new Date("2026-08-20T09:59:59Z"),
      };
      expect(selectCommissionRule(rules, beforeCtx)?.id).toBe("rule_base");

      // Exactly at effectiveAt -> flash rule active
      const exactStartCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(10000),
        quantity: 1,
        occurredAt: timeStart,
      };
      expect(selectCommissionRule(rules, exactStartCtx)?.id).toBe(
        "rule_flash_sale",
      );

      // Mid-flight -> flash rule active
      const midCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(10000),
        quantity: 1,
        occurredAt: new Date("2026-08-20T14:00:00Z"),
      };
      expect(selectCommissionRule(rules, midCtx)?.id).toBe("rule_flash_sale");

      // Exactly at expiresAt -> expired! Fall back to base rule
      const exactEndCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(10000),
        quantity: 1,
        occurredAt: timeEnd,
      };
      expect(selectCommissionRule(rules, exactEndCtx)?.id).toBe("rule_base");

      // After expiresAt -> expired! Fall back to base rule
      const afterCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(10000),
        quantity: 1,
        occurredAt: new Date("2026-08-20T18:00:01Z"),
      };
      expect(selectCommissionRule(rules, afterCtx)?.id).toBe("rule_base");
    });
  });

  // ===========================================================================
  // 2. HETEROGENEOUS 50+ ITEM CARTS, LINE ISOLATION & ZERO CONTAMINATION
  // ===========================================================================
  describe("2. Heterogeneous 50+ Item Carts & Strict Line Isolation", () => {
    it("2.1: 52-line heterogeneous cart across all specificity tiers settles cleanly with exact sum equality", () => {
      // 5 distinct rule types
      const variantRule = createRule({
        id: "rule_vip_var",
        scope: "variant",
        variantId: "gid://shopify/ProductVariant/v_special",
        basisPoints: 3500, // 35%
      });
      const productRule = createRule({
        id: "rule_prod_leggings",
        scope: "product",
        productId: "gid://shopify/Product/p_leggings",
        basisPoints: 2500, // 25%
      });
      const collectionRule = createRule({
        id: "rule_coll_tops",
        scope: "collection",
        collectionExternalId: "gid://shopify/Collection/c_tops",
        basisPoints: 1800, // 18%
      });
      const tagRule = createRule({
        id: "rule_tag_yenergy",
        scope: "tag",
        tag: "yenergy",
        basisPoints: 1500, // 15%
      });
      const partnerBaseRule = createRule({
        id: "rule_partner_base",
        scope: "partner",
        partnerId: "partner_1",
        basisPoints: 1000, // 10%
      });

      const rules = [
        variantRule,
        productRule,
        collectionRule,
        tagRule,
        partnerBaseRule,
      ];

      // Generate 52 lines:
      // Lines 0-9 (10 lines): VIP Variant -> 35%
      // Lines 10-19 (10 lines): Leggings Product -> 25%
      // Lines 20-29 (10 lines): Tops Collection -> 18%
      // Lines 30-39 (10 lines): Yenergy Tag -> 15%
      // Lines 40-51 (12 lines): Unmatched generic items -> 10% base
      const lines = Array.from({ length: 52 }, (_, idx) => {
        let variantExternalId: string | undefined;
        let productExternalId: string | undefined;
        let collectionExternalIds: string[] = [];
        let productTags: string[] = [];

        if (idx < 10) {
          variantExternalId = "gid://shopify/ProductVariant/v_special";
        } else if (idx < 20) {
          productExternalId = "gid://shopify/Product/p_leggings";
        } else if (idx < 30) {
          collectionExternalIds = ["gid://shopify/Collection/c_tops"];
        } else if (idx < 40) {
          productTags = ["yenergy", "activewear"];
        } else {
          productExternalId = `gid://shopify/Product/unmatched_${idx}`;
          collectionExternalIds = ["gid://shopify/Collection/c_misc"];
          productTags = ["unmatched"];
        }

        const price = BigInt(3000 + idx * 150); // $30.00 to $106.50
        const ctx: CommissionRuleContext = {
          programId: "prog_yamax",
          partnerId: "partner_1",
          productExternalId,
          variantExternalId,
          collectionExternalIds,
          productTags,
          accountingCurrency: "USD",
          commissionableAmount: price,
          quantity: 1,
          occurredAt: now,
        };

        const matchedRule = selectCommissionRule(rules, ctx)!;
        const earnings = calculateCommission({
          rule: matchedRule,
          context: ctx,
        });

        return { idx, price, matchedRule, earnings };
      });

      // Verify rule assignments
      expect(
        lines.filter((l) => l.matchedRule.id === "rule_vip_var"),
      ).toHaveLength(10);
      expect(
        lines.filter((l) => l.matchedRule.id === "rule_prod_leggings"),
      ).toHaveLength(10);
      expect(
        lines.filter((l) => l.matchedRule.id === "rule_coll_tops"),
      ).toHaveLength(10);
      expect(
        lines.filter((l) => l.matchedRule.id === "rule_tag_yenergy"),
      ).toHaveLength(10);
      expect(
        lines.filter((l) => l.matchedRule.id === "rule_partner_base"),
      ).toHaveLength(12);

      // Verify line math integrity using divideAndRound
      for (const line of lines) {
        if (line.idx < 10) {
          expect(line.earnings).toBe(
            divideAndRound(line.price * BigInt(3500), BigInt(10000)),
          );
        } else if (line.idx < 20) {
          expect(line.earnings).toBe(
            divideAndRound(line.price * BigInt(2500), BigInt(10000)),
          );
        } else if (line.idx < 30) {
          expect(line.earnings).toBe(
            divideAndRound(line.price * BigInt(1800), BigInt(10000)),
          );
        } else if (line.idx < 40) {
          expect(line.earnings).toBe(
            divideAndRound(line.price * BigInt(1500), BigInt(10000)),
          );
        } else {
          expect(line.earnings).toBe(
            divideAndRound(line.price * BigInt(1000), BigInt(10000)),
          );
        }
      }

      const totalConsolidatedCommission = lines.reduce(
        (sum, l) => sum + l.earnings,
        BigInt(0),
      );
      const lineEarningsSum = lines
        .map((l) => l.earnings)
        .reduce((a, b) => a + b, BigInt(0));

      expect(totalConsolidatedCommission).toBe(lineEarningsSum);
      expect(totalConsolidatedCommission).toBeGreaterThan(BigInt(0));
    });

    it("2.2: Line Isolation Invariant: Modifying Line A has zero mathematical effect on Line B", () => {
      const rules = [
        createRule({
          id: "rule_var_special",
          scope: "variant",
          variantId: "gid://shopify/ProductVariant/v_special",
          basisPoints: 3000,
        }),
        createRule({
          id: "rule_base_fallback",
          scope: "partner",
          partnerId: "partner_1",
          basisPoints: 1000,
        }),
      ];

      // Line B: Unmodified target line ($75.00 base fallback -> $7.50)
      const lineBCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        partnerId: "partner_1",
        productId: "prod_plain",
        productExternalId: "gid://shopify/Product/prod_plain",
        variantId: "var_plain",
        variantExternalId: "gid://shopify/ProductVariant/var_plain",
        collectionExternalIds: ["coll_general"],
        productTags: ["standard"],
        accountingCurrency: "USD",
        commissionableAmount: BigInt(7500),
        quantity: 1,
        occurredAt: now,
      };

      const matchedRuleB = selectCommissionRule(rules, lineBCtx)!;
      const earningsB_Initial = calculateCommission({
        rule: matchedRuleB,
        context: lineBCtx,
      });
      expect(earningsB_Initial).toBe(BigInt(750));

      // Adversarial mutations of sibling Line A:
      // Mutation 1: Line A price increases from $10 to $1,000,000
      // Mutation 2: Line A gets 100% discount
      // Mutation 3: Line A quantity becomes 10,000
      // Mutation 4: Line A switches from standard rule to VIP variant rule
      const lineAMutations: CommissionRuleContext[] = [
        { ...lineBCtx, commissionableAmount: BigInt(100_000_000), quantity: 1 },
        { ...lineBCtx, commissionableAmount: BigInt(0), quantity: 1 },
        { ...lineBCtx, commissionableAmount: BigInt(5000), quantity: 10000 },
        {
          ...lineBCtx,
          variantExternalId: "gid://shopify/ProductVariant/v_special",
          commissionableAmount: BigInt(50000),
        },
      ];

      for (const mutatedA of lineAMutations) {
        const matchedRuleA = selectCommissionRule(rules, mutatedA)!;
        calculateCommission({ rule: matchedRuleA, context: mutatedA });

        // Check Line B again
        const recheckMatchedB = selectCommissionRule(rules, lineBCtx)!;
        const recheckEarningsB = calculateCommission({
          rule: recheckMatchedB,
          context: lineBCtx,
        });

        expect(recheckMatchedB.id).toBe("rule_base_fallback");
        expect(recheckEarningsB).toBe(earningsB_Initial);
      }
    });

    it("2.3: No Rate Contamination / No Upward Bleed: Unmatched items strictly receive base reward", () => {
      const highRateVariantRule = createRule({
        id: "rule_high_rate_50",
        scope: "variant",
        variantId: "gid://shopify/ProductVariant/super_item",
        basisPoints: 5000, // 50%
      });
      const basePartnerRule = createRule({
        id: "rule_base_10",
        scope: "partner",
        partnerId: "partner_yamax",
        basisPoints: 1000, // 10%
      });

      const rules = [highRateVariantRule, basePartnerRule];

      // Sibling has 50% VIP rate
      const siblingCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        partnerId: "partner_yamax",
        variantExternalId: "gid://shopify/ProductVariant/super_item",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(10000),
        quantity: 1,
        occurredAt: now,
      };
      const siblingRule = selectCommissionRule(rules, siblingCtx)!;
      expect(siblingRule.id).toBe("rule_high_rate_50");
      expect(
        calculateCommission({ rule: siblingRule, context: siblingCtx }),
      ).toBe(BigInt(5000));

      // Regular item in same cart MUST NEVER inherit the 50% rate
      const regularCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        partnerId: "partner_yamax",
        productId: "prod_regular",
        productExternalId: "gid://shopify/Product/regular",
        variantId: "var_regular",
        variantExternalId: "gid://shopify/ProductVariant/regular",
        collectionExternalIds: ["coll_all"],
        productTags: ["apparel"],
        accountingCurrency: "USD",
        commissionableAmount: BigInt(10000),
        quantity: 1,
        occurredAt: now,
      };
      const regularRule = selectCommissionRule(rules, regularCtx)!;
      expect(regularRule.id).toBe("rule_base_10");
      expect(
        calculateCommission({ rule: regularRule, context: regularCtx }),
      ).toBe(BigInt(1000));
    });
  });

  // ===========================================================================
  // 3. ZERO-PRICED, 100% DISCOUNTED, EXTREME QUANTITIES & CURRENCY VALUES
  // ===========================================================================
  describe("3. Edge Cases & Boundary Values (Zero, Extreme Quantities, Large Currencies)", () => {
    it("3.1: Zero-priced items ($0.00 free gifts) return exactly $0 commission without division by zero", () => {
      const percentageRule = createRule({ basisPoints: 2000 });
      const zeroCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(0),
        quantity: 5,
        occurredAt: now,
      };

      const earnings = calculateCommission({
        rule: percentageRule,
        context: zeroCtx,
      });
      expect(earnings).toBe(BigInt(0));
    });

    it("3.2: 100% discounted items (shopGross = $100, discount = $100 -> net = $0) return $0", () => {
      const shopGross = BigInt(10000);
      const lineShopDiscount = BigInt(10000);
      const lineAccountingNet = shopGross - lineShopDiscount;
      expect(lineAccountingNet).toBe(BigInt(0));

      const rule = createRule({ basisPoints: 1500 });
      const ctx: CommissionRuleContext = {
        programId: "prog_yamax",
        accountingCurrency: "USD",
        commissionableAmount: lineAccountingNet,
        quantity: 1,
        occurredAt: now,
      };

      expect(calculateCommission({ rule, context: ctx })).toBe(BigInt(0));
    });

    it("3.3: Negative commissionable amount input is clamped to 0", () => {
      const rule = createRule({ basisPoints: 1500 });
      const negativeCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(-5000),
        quantity: 1,
        occurredAt: now,
      };

      expect(calculateCommission({ rule, context: negativeCtx })).toBe(
        BigInt(0),
      );
    });

    it("3.4: Extreme quantity (1,000,000 items) on a flat per-item reward computes accurately", () => {
      const fixedItemRule = createRule({
        ruleType: "fixed",
        fixedAmountMode: "item",
        fixedAmount: BigInt(250), // $2.50 per item
        currency: "USD",
        basisPoints: null,
      });

      const extremeQtyCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(500_000_000), // $5,000,000.00
        quantity: 1_000_000,
        occurredAt: now,
      };

      const earnings = calculateCommission({
        rule: fixedItemRule,
        context: extremeQtyCtx,
      });
      // 1,000,000 * 250 cents = 250,000,000 cents ($2,500,000.00)
      expect(earnings).toBe(BigInt(250_000_000));
    });

    it("3.5: Large currency values ($10,000,000.00 = 1,000,000,000 cents) calculate without precision loss", () => {
      const bigAmount = BigInt(1_000_000_000); // $10,000,000.00
      const rule = createRule({ basisPoints: 1750 }); // 17.5%

      const ctx: CommissionRuleContext = {
        programId: "prog_yamax",
        accountingCurrency: "USD",
        commissionableAmount: bigAmount,
        quantity: 1,
        occurredAt: now,
      };

      const earnings = calculateCommission({ rule, context: ctx });
      // $10M * 17.5% = $1.75M = 175,000,000 cents
      expect(earnings).toBe(BigInt(175_000_000));
    });

    it("3.6: Zero-decimal currencies (JPY, VND) operate on whole integer minor units with 0 scale", () => {
      expect(currencyMinorUnits("JPY")).toBe(0);
      expect(currencyMinorUnits("VND")).toBe(0);

      // JPY ¥19,999 @ 15% commission = round(19999 * 1500 / 10000) = round(2999.85) = 3000
      const jpyRule = createRule({ basisPoints: 1500 });
      const jpyCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        accountingCurrency: "JPY",
        commissionableAmount: BigInt(19999),
        quantity: 1,
        occurredAt: now,
      };

      const jpyEarnings = calculateCommission({
        rule: jpyRule,
        context: jpyCtx,
      });
      expect(jpyEarnings).toBe(BigInt(3000));

      // VND 15,500,000₫ @ 12% = 1,860,000₫
      const vndRule = createRule({ basisPoints: 1200 });
      const vndCtx: CommissionRuleContext = {
        programId: "prog_yamax",
        accountingCurrency: "VND",
        commissionableAmount: BigInt(15_500_000),
        quantity: 1,
        occurredAt: now,
      };

      const vndEarnings = calculateCommission({
        rule: vndRule,
        context: vndCtx,
      });
      expect(vndEarnings).toBe(BigInt(1_860_000));
    });
  });

  // ===========================================================================
  // 4. PENNY CONSERVATION IN PROPORTIONAL ALLOCATIONS
  // ===========================================================================
  describe("4. Penny Conservation in Proportional Allocation (`allocateCommissionProportionally`)", () => {
    it("4.1: Fixed order bonus across 50 heterogeneous lines guarantees sum(allocations) === totalBonus", () => {
      const totalBonus = BigInt(10000); // $100.00
      // 50 lines with irregular prime and odd price amounts
      const amounts = Array.from({ length: 50 }, (_, i) =>
        BigInt(719 + ((i * 313) % 4321)),
      );

      const allocations = allocateCommissionProportionally({
        total: totalBonus,
        amounts,
      });

      expect(allocations).toHaveLength(50);
      const allocatedSum = allocations.reduce((a, b) => a + b, BigInt(0));
      expect(allocatedSum).toBe(totalBonus); // Exact 10,000 cents, zero drift!

      for (const alloc of allocations) {
        expect(alloc).toBeGreaterThanOrEqual(BigInt(0));
      }
    });

    it("4.2: Mixed zero and non-zero lines allocate remainder only across non-zero qualifying lines", () => {
      const totalBonus = BigInt(5000); // $50.00
      const amounts = [
        BigInt(0), // Line 1: $0 gift
        BigInt(2500), // Line 2: $25.00
        BigInt(0), // Line 3: $0 free item
        BigInt(7500), // Line 4: $75.00
        BigInt(0), // Line 5: $0
      ];

      const allocations = allocateCommissionProportionally({
        total: totalBonus,
        amounts,
      });

      expect(allocations).toHaveLength(5);
      expect(allocations[0]).toBe(BigInt(0));
      expect(allocations[1]).toBe(BigInt(1250)); // 25% of $50 = $12.50
      expect(allocations[2]).toBe(BigInt(0));
      expect(allocations[3]).toBe(BigInt(3750)); // 75% of $50 = $37.50
      expect(allocations[4]).toBe(BigInt(0));

      expect(allocations.reduce((a, b) => a + b, BigInt(0))).toBe(totalBonus);
    });

    it("4.3: Extreme price disparity ($0.01 trinket to $10,000.00 order) conserves every single penny", () => {
      const totalBonus = BigInt(10000); // $100.00
      const amounts = [
        BigInt(1), // $0.01
        BigInt(2), // $0.02
        BigInt(1_000_000), // $10,000.00
      ];

      const allocations = allocateCommissionProportionally({
        total: totalBonus,
        amounts,
      });

      expect(allocations).toHaveLength(3);
      expect(allocations.reduce((a, b) => a + b, BigInt(0))).toBe(totalBonus);
      expect(allocations[0]).toBe(BigInt(0));
      expect(allocations[1]).toBe(BigInt(0));
      expect(allocations[2]).toBe(BigInt(10000));
    });

    it("4.4: All-zero order assigns entire bonus to the last line gracefully without NaN or error", () => {
      const totalBonus = BigInt(3000);
      const amounts = [BigInt(0), BigInt(0), BigInt(0)];

      const allocations = allocateCommissionProportionally({
        total: totalBonus,
        amounts,
      });

      expect(allocations).toEqual([BigInt(0), BigInt(0), BigInt(3000)]);
      expect(allocations.reduce((a, b) => a + b, BigInt(0))).toBe(totalBonus);
    });
  });

  // ===========================================================================
  // 5. ADR 0004 PROPORTIONAL REFUND REVERSAL & CLAWBACK INTEGRITY
  // ===========================================================================
  describe("5. ADR 0004 Proportional Refund Reversal & Ceiling Clamping", () => {
    it("5.1: Multi-stage partial refund on heterogeneous order reverses only the targeted line", () => {
      // Order with 3 lines:
      // Line 1: $100 @ 20% -> $20.00 earnings
      // Line 2: $50 @ 10% -> $5.00 earnings
      // Line 3: $30 @ 10% -> $3.00 earnings
      const line1Amount = BigInt(10000);
      const line1Earnings = BigInt(2000);

      const line2Amount = BigInt(5000);
      const line2Earnings = BigInt(500);

      // Refund 1: 50% of Line 1 ($50.00)
      const rev1 = calculateRefundReversal({
        originalEarnings: line1Earnings,
        originalCommissionableAmount: line1Amount,
        refundedAmount: BigInt(5000),
        alreadyReversed: BigInt(0),
      });
      expect(rev1).toBe(BigInt(1000)); // $10.00 clawback

      // Refund 2: Remaining 50% of Line 1 ($50.00)
      const rev2 = calculateRefundReversal({
        originalEarnings: line1Earnings,
        originalCommissionableAmount: line1Amount,
        refundedAmount: BigInt(5000),
        alreadyReversed: rev1,
      });
      expect(rev2).toBe(BigInt(1000)); // $10.00 clawback
      expect(rev1 + rev2).toBe(line1Earnings); // 100% of Line 1 reversed

      // Line 2 remains 100% intact with 0 clawback
      const revLine2 = calculateRefundReversal({
        originalEarnings: line2Earnings,
        originalCommissionableAmount: line2Amount,
        refundedAmount: BigInt(0),
        alreadyReversed: BigInt(0),
      });
      expect(revLine2).toBe(BigInt(0));
    });

    it("5.2: Over-refund clamp: 200% refund attempt clamps cumulative reversal strictly to original earnings", () => {
      const originalAmount = BigInt(10000);
      const originalEarnings = BigInt(2500); // $25.00

      const excessiveRefund = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: BigInt(20000), // 200% refund ($200.00)
        alreadyReversed: BigInt(0),
      });

      expect(excessiveRefund).toBe(originalEarnings); // Strictly $25.00
    });
  });
});
