import {
  allocateCommissionProportionally,
  calculateCommission,
  selectCommissionRule,
  serializeGroupRewardCommission,
  type CommissionRuleContext,
} from "@/lib/weletic/commissions/rules";
import { WeleticCommissionRule } from "@prisma/client";
import { describe, expect, test } from "vitest";

const now = new Date("2026-08-14T00:00:00Z");
const baseRule = {
  logicalKey: "default",
  version: 1,
  programId: "program_1",
  partnerId: null,
  scope: "program",
  ruleType: "percentage",
  fixedAmountMode: "line",
  priority: 0,
  collectionExternalId: null,
  productId: null,
  variantId: null,
  promotionCode: null,
  tag: null,
  basisPoints: 1000,
  fixedAmount: null,
  currency: null,
  minOrderAmount: null,
  maxCommissionAmount: null,
  effectiveAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: null,
  active: true,
  createdByUserId: null,
  createdAt: now,
} satisfies Omit<WeleticCommissionRule, "id">;

const context: CommissionRuleContext = {
  programId: "program_1",
  partnerId: "partner_1",
  productId: "product_1",
  variantId: "variant_1",
  collectionExternalIds: ["collection_1"],
  productTags: ["bottoms", "high-support", "yenergy"],
  promotionCodes: ["SUMMER"],
  accountingCurrency: "USD",
  commissionableAmount: BigInt(10_005),
  quantity: 1,
  occurredAt: now,
};

describe("Weletic commission rules", () => {
  test("does not serialize a generic Sale Reward for Shopify products", () => {
    expect(
      serializeGroupRewardCommission({
        reward: {
          id: "reward_percentage",
        },
        currency: "USD",
      }),
    ).toBeNull();
  });

  test("serializes the dedicated Shopify base rate", () => {
    expect(
      serializeGroupRewardCommission({
        reward: {
          id: "reward_shopify",
          config: {
            type: "shopify_ecommerce",
            customerSegmentMode: "none",
            baseRateType: "flat",
            baseReturningRate: 12.34,
            baseNewRate: 20,
            shopifySegment: null,
            collectionOverrides: [],
            productOverrides: [],
            variantOverrides: [],
            subscriptionRules: {
              mode: "first_sale",
              recurringOrderCount: null,
            },
          },
        },
        currency: "USD",
      }),
    ).toEqual({
      ruleId: "reward_shopify",
      source: "default_group",
      type: "fixed",
      basisPoints: null,
      fixedAmount: "1234",
      currency: "USD",
      minOrderAmount: null,
    });
  });

  test("allocates order-level fixed earnings across refundable lines", () => {
    expect(
      allocateCommissionProportionally({
        total: BigInt(1_000),
        amounts: [BigInt(2_000), BigInt(3_000), BigInt(5_000)],
      }),
    ).toEqual([BigInt(200), BigInt(300), BigInt(500)]);
  });

  test("allocates proportionally with fractional rounding and ensures sum equals total", () => {
    // 100 split 3 ways across equal amounts (33 + 33 + 34)
    const result = allocateCommissionProportionally({
      total: BigInt(100),
      amounts: [BigInt(100), BigInt(100), BigInt(100)],
    });
    expect(result).toEqual([BigInt(33), BigInt(33), BigInt(34)]);
    expect(result.reduce((a, b) => a + b, BigInt(0))).toBe(BigInt(100));
  });

  test("handles zero-value lines and all-zero lines correctly", () => {
    // Mixed zero and positive lines
    const mixed = allocateCommissionProportionally({
      total: BigInt(1000),
      amounts: [BigInt(0), BigInt(500), BigInt(0), BigInt(500)],
    });
    expect(mixed).toEqual([BigInt(0), BigInt(500), BigInt(0), BigInt(500)]);
    expect(mixed.reduce((a, b) => a + b, BigInt(0))).toBe(BigInt(1000));

    // All zero lines allocates remainder to the last line
    const allZeros = allocateCommissionProportionally({
      total: BigInt(500),
      amounts: [BigInt(0), BigInt(0)],
    });
    expect(allZeros).toEqual([BigInt(0), BigInt(500)]);

    // Empty array returns empty
    expect(
      allocateCommissionProportionally({
        total: BigInt(500),
        amounts: [],
      }),
    ).toEqual([]);

    // Single line gets full total
    expect(
      allocateCommissionProportionally({
        total: BigInt(750),
        amounts: [BigInt(1234)],
      }),
    ).toEqual([BigInt(750)]);
  });

  test("chooses the most specific eligible rule", () => {
    const rules = [
      { ...baseRule, id: "program" },
      {
        ...baseRule,
        id: "product",
        logicalKey: "product",
        scope: "product" as const,
        productId: "product_1",
        basisPoints: 1500,
      },
      {
        ...baseRule,
        id: "promotion",
        logicalKey: "promotion",
        scope: "promotion" as const,
        promotionCode: "summer",
        basisPoints: 2000,
      },
    ];
    expect(selectCommissionRule(rules, context)?.id).toBe("promotion");
  });

  test("uses an inactive rule version when its effective interval contains the order", () => {
    const historicalRule = {
      ...baseRule,
      id: "historical",
      active: false,
      expiresAt: new Date("2026-09-01T00:00:00Z"),
    };

    expect(selectCommissionRule([historicalRule], context)?.id).toBe(
      "historical",
    );
  });

  test("enforces strict 7-tier specificity hierarchy (Promotion > Variant > Product > Collection == Tag > Partner > Program)", () => {
    const programRule = {
      ...baseRule,
      id: "rule_program",
      scope: "program" as const,
      basisPoints: 500,
    };
    const partnerRule = {
      ...baseRule,
      id: "rule_partner",
      scope: "partner" as const,
      partnerId: "partner_1",
      basisPoints: 800,
    };
    const tagRule = {
      ...baseRule,
      id: "rule_tag",
      scope: "tag" as const,
      tag: "high-support",
      basisPoints: 1200,
    };
    const collectionRule = {
      ...baseRule,
      id: "rule_collection",
      scope: "collection" as const,
      collectionExternalId: "collection_1",
      basisPoints: 1400,
    };
    const productRule = {
      ...baseRule,
      id: "rule_product",
      scope: "product" as const,
      productId: "product_1",
      basisPoints: 1800,
    };
    const variantRule = {
      ...baseRule,
      id: "rule_variant",
      scope: "variant" as const,
      variantId: "variant_1",
      basisPoints: 2200,
    };
    const promotionRule = {
      ...baseRule,
      id: "rule_promotion",
      scope: "promotion" as const,
      promotionCode: "summer",
      basisPoints: 3000,
    };

    // Full hierarchy ladder tests
    // 1. Promotion (5) beats all
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
        context,
      )?.id,
    ).toBe("rule_promotion");
    // 2. Variant (4) beats Product (3), Collection (2), Tag (2), Partner (1), Program (0)
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
        context,
      )?.id,
    ).toBe("rule_variant");
    // 3. Product (3) beats Collection (2), Tag (2), Partner (1), Program (0)
    expect(
      selectCommissionRule(
        [programRule, partnerRule, tagRule, collectionRule, productRule],
        context,
      )?.id,
    ).toBe("rule_product");
    // 4. Collection (2) beats Partner (1), Program (0)
    expect(
      selectCommissionRule([programRule, partnerRule, collectionRule], context)
        ?.id,
    ).toBe("rule_collection");
    // 5. Tag (2) beats Partner (1), Program (0)
    expect(
      selectCommissionRule([programRule, partnerRule, tagRule], context)?.id,
    ).toBe("rule_tag");
    // 6. Partner (1) beats Program (0)
    expect(selectCommissionRule([programRule, partnerRule], context)?.id).toBe(
      "rule_partner",
    );
    // 7. Program (0) is base fallback
    expect(selectCommissionRule([programRule], context)?.id).toBe(
      "rule_program",
    );
  });

  test("matches tag rule with case-insensitive trim comparison", () => {
    const tagRuleUppercase = {
      ...baseRule,
      id: "rule_tag_upper",
      scope: "tag" as const,
      tag: "  HIGH-SUPPORT  ",
      basisPoints: 1500,
    };
    const matchingContext: CommissionRuleContext = {
      ...context,
      productTags: ["bottoms", "high-support", "yenergy"],
    };
    expect(selectCommissionRule([tagRuleUppercase], matchingContext)?.id).toBe(
      "rule_tag_upper",
    );

    // Non-matching tag returns undefined (or fallback)
    const nonMatchingContext: CommissionRuleContext = {
      ...context,
      productTags: ["tops", "cloudsoft"],
    };
    expect(
      selectCommissionRule([tagRuleUppercase], nonMatchingContext),
    ).toBeUndefined();

    // Context without tags returns undefined
    const noTagContext: CommissionRuleContext = {
      ...context,
      productTags: undefined,
    };
    expect(
      selectCommissionRule([tagRuleUppercase], noTagContext),
    ).toBeUndefined();
  });

  test("deterministic conflict resolution: priority DESC -> version DESC -> createdAt DESC", () => {
    const timeA = new Date("2026-08-01T00:00:00Z");
    const timeB = new Date("2026-08-10T00:00:00Z");

    // Equal level rules (both collection rules): higher priority wins
    const collRuleLowPriority = {
      ...baseRule,
      id: "coll_low_prio",
      scope: "collection" as const,
      collectionExternalId: "collection_1",
      priority: 10,
      version: 1,
      createdAt: timeB,
      basisPoints: 1000,
    };
    const collRuleHighPriority = {
      ...baseRule,
      id: "coll_high_prio",
      scope: "collection" as const,
      collectionExternalId: "collection_1",
      priority: 1000,
      version: 1,
      createdAt: timeA,
      basisPoints: 2000,
    };
    expect(
      selectCommissionRule([collRuleLowPriority, collRuleHighPriority], context)
        ?.id,
    ).toBe("coll_high_prio");

    // Same priority: higher version wins
    const collRuleV1 = {
      ...baseRule,
      id: "coll_v1",
      scope: "collection" as const,
      collectionExternalId: "collection_1",
      priority: 100,
      version: 1,
      createdAt: timeB,
      basisPoints: 1200,
    };
    const collRuleV2 = {
      ...baseRule,
      id: "coll_v2",
      scope: "collection" as const,
      collectionExternalId: "collection_1",
      priority: 100,
      version: 2,
      createdAt: timeA,
      basisPoints: 1500,
    };
    expect(selectCommissionRule([collRuleV1, collRuleV2], context)?.id).toBe(
      "coll_v2",
    );

    // Same priority and version: newer createdAt wins
    const collRuleOlder = {
      ...baseRule,
      id: "coll_older",
      scope: "collection" as const,
      collectionExternalId: "collection_1",
      priority: 100,
      version: 1,
      createdAt: timeA,
      basisPoints: 1100,
    };
    const collRuleNewer = {
      ...baseRule,
      id: "coll_newer",
      scope: "collection" as const,
      collectionExternalId: "collection_1",
      priority: 100,
      version: 1,
      createdAt: timeB,
      basisPoints: 1300,
    };
    expect(
      selectCommissionRule([collRuleOlder, collRuleNewer], context)?.id,
    ).toBe("coll_newer");
  });

  test("modifier dynamic priority (1000 - modIndex * 10) resolves conflicting same-level rules in top-to-bottom UI order", () => {
    // Simulate two collection modifiers on the same product:
    // Modifier 0 (top of UI list): Collection A -> priority = 1000
    // Modifier 1 (second in UI list): Collection B -> priority = 990
    const mod0Rule = {
      ...baseRule,
      id: "mod0_coll_a",
      scope: "collection" as const,
      collectionExternalId: "coll_a",
      priority: Math.max(10, 1000 - 0 * 10), // 1000
      basisPoints: 2000, // 20%
    };
    const mod1Rule = {
      ...baseRule,
      id: "mod1_coll_b",
      scope: "collection" as const,
      collectionExternalId: "coll_b",
      priority: Math.max(10, 1000 - 1 * 10), // 990
      basisPoints: 1500, // 15%
    };

    const multiCollContext: CommissionRuleContext = {
      ...context,
      collectionExternalIds: ["coll_a", "coll_b"],
    };

    const selected = selectCommissionRule(
      [mod1Rule, mod0Rule],
      multiCollContext,
    );
    expect(selected?.id).toBe("mod0_coll_a");
    expect(selected?.priority).toBe(1000);
  });

  test("does not apply another partner's private rule", () => {
    const rules = [
      { ...baseRule, id: "program" },
      {
        ...baseRule,
        id: "partner",
        logicalKey: "partner",
        scope: "partner" as const,
        partnerId: "partner_2",
        basisPoints: 2500,
      },
    ];
    expect(selectCommissionRule(rules, context)?.id).toBe("program");
  });

  test("calculates and rounds percentage earnings in minor units", () => {
    expect(
      calculateCommission({ rule: { ...baseRule, id: "program" }, context }),
    ).toBe(BigInt(1001));
  });

  test("applies minimum thresholds to the order rather than each line", () => {
    const rule = {
      ...baseRule,
      id: "minimum-order",
      minOrderAmount: BigInt(15_000),
    };
    expect(
      selectCommissionRule([rule], {
        ...context,
        commissionableAmount: BigInt(10_005),
        orderAmount: BigInt(20_010),
      })?.id,
    ).toBe("minimum-order");
  });

  test("labels catalog previews without comparing different currencies", () => {
    const rule = {
      ...baseRule,
      id: "minimum-order-preview",
      minOrderAmount: BigInt(15_000),
    };
    expect(
      selectCommissionRule([rule], {
        ...context,
        commissionableAmount: BigInt(100),
        skipOrderThreshold: true,
      })?.id,
    ).toBe("minimum-order-preview");
  });

  test("rejects fixed rules in a different accounting currency", () => {
    expect(() =>
      calculateCommission({
        rule: {
          ...baseRule,
          id: "fixed",
          ruleType: "fixed",
          basisPoints: null,
          fixedAmount: BigInt(500),
          currency: "JPY",
        },
        context,
      }),
    ).toThrow("does not match");
  });

  test("matches product rule using Shopify Product GID format", () => {
    const productGidRule = {
      ...baseRule,
      id: "product_gid_rule",
      scope: "product" as const,
      productId: "gid://shopify/Product/88990011",
      basisPoints: 2000,
    };
    const matchingContext: CommissionRuleContext = {
      ...context,
      productId: "prod_1",
      productExternalId: "gid://shopify/Product/88990011",
    };
    expect(selectCommissionRule([productGidRule], matchingContext)?.id).toBe(
      "product_gid_rule",
    );
  });

  test("matches collection rule when product belongs to Shopify collection GID", () => {
    const collectionGidRule = {
      ...baseRule,
      id: "collection_gid_rule",
      scope: "collection" as const,
      collectionExternalId: "gid://shopify/Collection/101",
      basisPoints: 1500,
    };
    const matchingContext: CommissionRuleContext = {
      ...context,
      collectionExternalIds: [
        "gid://shopify/Collection/101",
        "gid://shopify/Collection/102",
      ],
    };
    expect(selectCommissionRule([collectionGidRule], matchingContext)?.id).toBe(
      "collection_gid_rule",
    );
  });

  test("matches variant rule using Shopify Variant GID format", () => {
    const variantGidRule = {
      ...baseRule,
      id: "variant_gid_rule",
      scope: "variant" as const,
      variantId: "gid://shopify/ProductVariant/55443322",
      basisPoints: 2500,
    };
    const matchingContext: CommissionRuleContext = {
      ...context,
      variantId: "var_1",
      variantExternalId: "gid://shopify/ProductVariant/55443322",
    };
    expect(selectCommissionRule([variantGidRule], matchingContext)?.id).toBe(
      "variant_gid_rule",
    );
  });

  test("settles 3-item heterogeneous order with exact minor units sum ($16 + $4 + $2 = $22)", () => {
    const leggingRule = {
      ...baseRule,
      id: "rule_leggings",
      scope: "product" as const,
      productId: "gid://shopify/Product/88990011",
      basisPoints: 2000, // 20%
    };
    const topsCollectionRule = {
      ...baseRule,
      id: "rule_tops_coll",
      scope: "collection" as const,
      collectionExternalId: "gid://shopify/Collection/101",
      basisPoints: 1000, // 10%
    };
    const baseSaleRule = {
      ...baseRule,
      id: "rule_base_sale",
      scope: "partner" as const,
      partnerId: "partner_1",
      basisPoints: 1000, // 10% base
    };

    const rules = [leggingRule, topsCollectionRule, baseSaleRule];

    // Line 1: Leggings $80.00 (20% rule) -> $16.00
    const line1Ctx: CommissionRuleContext = {
      ...context,
      productExternalId: "gid://shopify/Product/88990011",
      commissionableAmount: BigInt(8000),
    };
    const line1Rule = selectCommissionRule(rules, line1Ctx)!;
    const line1Earnings = calculateCommission({
      rule: line1Rule,
      context: line1Ctx,
    });
    expect(line1Rule.id).toBe("rule_leggings");
    expect(line1Earnings).toBe(BigInt(1600));

    // Line 2: Tank Top $40.00 (10% collection rule) -> $4.00
    const line2Ctx: CommissionRuleContext = {
      ...context,
      productId: "prod_tank",
      productExternalId: "gid://shopify/Product/99990022",
      collectionExternalIds: ["gid://shopify/Collection/101"],
      commissionableAmount: BigInt(4000),
    };
    const line2Rule = selectCommissionRule(rules, line2Ctx)!;
    const line2Earnings = calculateCommission({
      rule: line2Rule,
      context: line2Ctx,
    });
    expect(line2Rule.id).toBe("rule_tops_coll");
    expect(line2Earnings).toBe(BigInt(400));

    // Line 3: Headband $20.00 (no condition match -> fallback to base 10%) -> $2.00
    const line3Ctx: CommissionRuleContext = {
      ...context,
      productId: "prod_headband",
      productExternalId: "gid://shopify/Product/77770033",
      collectionExternalIds: ["gid://shopify/Collection/999"],
      commissionableAmount: BigInt(2000),
    };
    const line3Rule = selectCommissionRule(rules, line3Ctx)!;
    const line3Earnings = calculateCommission({
      rule: line3Rule,
      context: line3Ctx,
    });
    expect(line3Rule.id).toBe("rule_base_sale");
    expect(line3Earnings).toBe(BigInt(200));

    // Total Consolidated Commission
    const totalEarnings = line1Earnings + line2Earnings + line3Earnings;
    expect(totalEarnings).toBe(BigInt(2200)); // $22.00
  });

  test("line isolation invariant: non-matching line strictly falls back to base rate and never inherits higher sibling rates", () => {
    // Rule for high-tier variant (30%)
    const highTierVariantRule = {
      ...baseRule,
      id: "rule_vip_variant",
      scope: "variant" as const,
      variantId: "gid://shopify/ProductVariant/99999",
      basisPoints: 3000, // 30%
    };
    // Rule for specific collection (20%)
    const collectionRule = {
      ...baseRule,
      id: "rule_coll_20",
      scope: "collection" as const,
      collectionExternalId: "gid://shopify/Collection/special",
      basisPoints: 2000, // 20%
    };
    // Partner group base sale reward (10%)
    const partnerBaseRule = {
      ...baseRule,
      id: "rule_partner_base_10",
      scope: "partner" as const,
      partnerId: "partner_1",
      basisPoints: 1000, // 10%
    };

    const rules = [highTierVariantRule, collectionRule, partnerBaseRule];

    // Sibling Line 1 (VIP Variant with 30% rate): $100 -> $30.00
    const line1Ctx: CommissionRuleContext = {
      ...context,
      variantExternalId: "gid://shopify/ProductVariant/99999",
      commissionableAmount: BigInt(10000),
    };
    const line1Rule = selectCommissionRule(rules, line1Ctx)!;
    expect(line1Rule.id).toBe("rule_vip_variant");
    expect(calculateCommission({ rule: line1Rule, context: line1Ctx })).toBe(
      BigInt(3000),
    );

    // Target Line 2 (Unmatched Accessory): $50 -> MUST get 10% = $5.00, NEVER 20% or 30%
    const line2Ctx: CommissionRuleContext = {
      ...context,
      productId: "prod_plain_accessory",
      productExternalId: "gid://shopify/Product/accessory_1",
      variantId: "var_plain",
      variantExternalId: "gid://shopify/ProductVariant/accessory_var_1",
      collectionExternalIds: ["gid://shopify/Collection/general"],
      productTags: ["accessories"],
      commissionableAmount: BigInt(5000),
    };
    const line2Rule = selectCommissionRule(rules, line2Ctx)!;
    expect(line2Rule.id).toBe("rule_partner_base_10");
    expect(calculateCommission({ rule: line2Rule, context: line2Ctx })).toBe(
      BigInt(500),
    );
  });
});
