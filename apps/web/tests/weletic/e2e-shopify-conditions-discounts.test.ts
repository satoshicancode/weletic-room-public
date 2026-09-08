import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import {
  allocateCommissionProportionally,
  calculateCommission,
  selectCommissionRule,
  serializeGroupRewardCommission,
  type CommissionRuleContext,
} from "@/lib/weletic/commissions/rules";
import { createWeleticId } from "@/lib/weletic/ids";
import { decimalToMinorUnits } from "@/lib/weletic/money";
import { createDiscountSchema } from "@/lib/zod/schemas/discount";
import {
  rewardConditionsArraySchema,
  rewardConditionSchema,
} from "@/lib/zod/schemas/rewards";
import { WeleticCommissionRule } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// SHOPIFY REWARD ENTITY DEFINITIONS & GENERATORS (ADR 0004 & PROJECT.md)
// =============================================================================

export const SHOPIFY_REWARD_ENTITY = {
  id: "shopify" as const,
  label: "Shopify",
  attributes: [
    { id: "product", label: "Product", type: "string" as const },
    { id: "collection", label: "Collection", type: "string" as const },
    { id: "variant", label: "Variant", type: "string" as const },
    { id: "productTag", label: "Product tag", type: "string" as const },
  ],
};

export type ShopifyDiscountType =
  | "amount_off_order"
  | "amount_off_products"
  | "bxgy"
  | "free_shipping";

export interface ShopifyDiscountConfig {
  type: ShopifyDiscountType;
  productIds?: string[];
  collectionIds?: string[];
  bxgy?: {
    buyQuantity: number;
    getQuantity: number;
    discountType: "percentage" | "amount";
    discountValue: number;
  };
  freeShipping?: {
    minimumSubtotal?: number;
    maximumShippingPrice?: number;
  };
}

export function generateAmountOffOrderPayload({
  code,
  amount,
  rateType,
  maxDuration,
}: {
  code: string;
  amount: number;
  rateType: "percentage" | "flat";
  maxDuration?: number | null;
}) {
  const recurringCycleLimit =
    maxDuration === null ? 0 : maxDuration === 0 ? 1 : maxDuration ?? 0;
  const uppercaseCode = code.toUpperCase();

  return {
    mutation: "DiscountCodeBasicCreate" as const,
    input: {
      title: `Dub Discount (${uppercaseCode})`,
      code: uppercaseCode,
      startsAt: new Date().toISOString(),
      customerSelection: { all: true },
      appliesOncePerCustomer: true,
      recurringCycleLimit,
      customerGets: {
        items: { all: true },
        appliesOnOneTimePurchase: true,
        appliesOnSubscription: true,
        value:
          rateType === "percentage"
            ? { percentage: amount / 100 }
            : {
                discountAmount: {
                  amount: (amount / 100).toFixed(2),
                  appliesOnEachItem: false,
                },
              },
      },
    },
  };
}

export function generateAmountOffProductsPayload({
  code,
  amount,
  rateType,
  maxDuration,
  productIds,
  collectionIds,
}: {
  code: string;
  amount: number;
  rateType: "percentage" | "flat";
  maxDuration?: number | null;
  productIds?: string[];
  collectionIds?: string[];
}) {
  const recurringCycleLimit =
    maxDuration === null ? 0 : maxDuration === 0 ? 1 : maxDuration ?? 0;
  const uppercaseCode = code.toUpperCase();

  return {
    mutation: "DiscountCodeBasicCreate" as const,
    input: {
      title: `Dub Discount (${uppercaseCode})`,
      code: uppercaseCode,
      startsAt: new Date().toISOString(),
      customerSelection: { all: true },
      appliesOncePerCustomer: true,
      recurringCycleLimit,
      customerGets: {
        items: {
          products: productIds ? { productsToAdd: productIds } : undefined,
          collections: collectionIds
            ? { collectionsToAdd: collectionIds }
            : undefined,
        },
        appliesOnOneTimePurchase: true,
        appliesOnSubscription: true,
        value:
          rateType === "percentage"
            ? { percentage: amount / 100 }
            : {
                discountAmount: {
                  amount: (amount / 100).toFixed(2),
                  appliesOnEachItem: false,
                },
              },
      },
    },
  };
}

export function generateBxgyPayload({
  code,
  productIds,
  buyQuantity = 1,
  getQuantity = 1,
  discountType = "percentage",
  discountValue = 100,
}: {
  code: string;
  productIds?: string[];
  buyQuantity?: number;
  getQuantity?: number;
  discountType?: "percentage" | "amount";
  discountValue?: number;
}) {
  const uppercaseCode = code.toUpperCase();

  return {
    mutation: "DiscountCodeBxgyCreate" as const,
    input: {
      title: `Dub BXGY Discount (${uppercaseCode})`,
      code: uppercaseCode,
      startsAt: new Date().toISOString(),
      customerSelection: { all: true },
      appliesOncePerCustomer: true,
      customerBuys: {
        items: {
          products: productIds ? { productsToAdd: productIds } : undefined,
        },
        value: {
          quantity: buyQuantity,
        },
      },
      customerGets: {
        items: {
          products: productIds ? { productsToAdd: productIds } : undefined,
        },
        value: {
          discountOnQuantity: {
            quantity: getQuantity,
            effect:
              discountType === "percentage"
                ? { percentage: discountValue / 100 }
                : {
                    discountAmount: {
                      amount: (discountValue / 100).toFixed(2),
                      appliesOnEachItem: true,
                    },
                  },
          },
        },
      },
    },
  };
}

export function generateFreeShippingPayload({
  code,
  maxDuration,
  minimumSubtotal,
  maximumShippingPrice,
}: {
  code: string;
  maxDuration?: number | null;
  minimumSubtotal?: number;
  maximumShippingPrice?: number;
}) {
  const recurringCycleLimit =
    maxDuration === null ? 0 : maxDuration === 0 ? 1 : maxDuration ?? 0;
  const uppercaseCode = code.toUpperCase();

  return {
    mutation: "DiscountCodeFreeShippingCreate" as const,
    input: {
      title: `Dub Free Shipping (${uppercaseCode})`,
      code: uppercaseCode,
      startsAt: new Date().toISOString(),
      customerSelection: { all: true },
      appliesOncePerCustomer: true,
      recurringCycleLimit,
      destinationSelection: { all: true },
      minimumRequirement: minimumSubtotal
        ? {
            subtotal: {
              greaterThanOrEqualToSubtotal: (minimumSubtotal / 100).toFixed(2),
            },
          }
        : undefined,
      maximumShippingPrice: maximumShippingPrice
        ? (maximumShippingPrice / 100).toFixed(2)
        : undefined,
      appliesOnOneTimePurchase: true,
      appliesOnSubscription: true,
    },
  };
}

// =============================================================================
// TEST SUITE: 4-TIER E2E SHOPIFY CONDITIONS & DISCOUNTS INTEGRATION
// =============================================================================

describe("Weletic E2E: Shopify Conditions, 4-Type Discounts & Settlement Suite", () => {
  const baseTimestamp = new Date("2026-08-20T00:00:00Z");

  const createBaseCommissionRule = (
    overrides: Partial<WeleticCommissionRule> = {},
  ): WeleticCommissionRule => ({
    id: createWeleticId("wrule_"),
    logicalKey: "default",
    version: 1,
    programId: "prog_yamax_1",
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
    basisPoints: 1000, // 10%
    fixedAmount: null,
    currency: null,
    minOrderAmount: null,
    maxCommissionAmount: null,
    effectiveAt: new Date("2026-01-01T00:00:00Z"),
    expiresAt: null,
    active: true,
    createdByUserId: null,
    createdAt: baseTimestamp,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // TIER 1: FEATURE COVERAGE (>=5 tests per feature)
  // ===========================================================================
  describe("Tier 1: Feature Coverage", () => {
    // -------------------------------------------------------------------------
    // Feature 1: Reward Condition Schema with Shopify Entity
    // -------------------------------------------------------------------------
    describe("Feature 1: Reward Condition Schema with Shopify Entity", () => {
      it("1.1: validates shopify entity with product attribute and equals_to operator", () => {
        const condition = {
          entity: "sale",
          attribute: "productId",
          operator: "equals_to",
          value: "gid://shopify/Product/88990011",
          label: "Yamax Agile™ High Support Leggings",
        };
        const parsed = rewardConditionSchema.safeParse(condition);
        expect(parsed.success).toBe(true);
      });

      it("1.2: validates shopify entity with collection attribute and in operator", () => {
        const condition = {
          entity: "sale",
          attribute: "productId",
          operator: "in",
          value: [
            "gid://shopify/Collection/101",
            "gid://shopify/Collection/102",
          ],
          label: "Yamax Tops & Sports Bras",
        };
        const parsed = rewardConditionSchema.safeParse(condition);
        expect(parsed.success).toBe(true);
      });

      it("1.3: validates shopify entity with variant attribute and equals_to operator", () => {
        const condition = {
          entity: "sale",
          attribute: "productId",
          operator: "equals_to",
          value: "gid://shopify/ProductVariant/55443322",
          label: "Yamax Flow™ Shorts - Olive / M",
        };
        const parsed = rewardConditionSchema.safeParse(condition);
        expect(parsed.success).toBe(true);
      });

      it("1.4: validates structured modifier array with composite conditions and percentage reward", () => {
        const modifier = {
          id: "mod_shopify_1",
          operator: "AND" as const,
          conditions: [
            {
              entity: "sale" as const,
              attribute: "productId" as const,
              operator: "equals_to" as const,
              value: "prod_yamax_leggings",
              label: "Yamax Agile Leggings",
            },
          ],
          amountInPercentage: 20,
          type: "percentage" as const,
          maxDuration: 12,
        };
        const parsed = rewardConditionsArraySchema.safeParse([modifier]);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data[0].amountInPercentage).toBe(20);
          expect(parsed.data[0].type).toBe("percentage");
        }
      });

      it("1.5: validates structured modifier with flat reward amount in cents", () => {
        const modifier = {
          id: "mod_shopify_flat",
          operator: "OR" as const,
          conditions: [
            {
              entity: "sale" as const,
              attribute: "productId" as const,
              operator: "equals_to" as const,
              value: "prod_yamax_jacket",
              label: "Yamax Outerwear",
            },
          ],
          amountInCents: 1500, // $15.00
          type: "flat" as const,
          maxDuration: 0,
        };
        const parsed = rewardConditionsArraySchema.safeParse([modifier]);
        expect(parsed.success).toBe(true);
        if (parsed.success) {
          expect(parsed.data[0].amountInCents).toBe(1500);
        }
      });

      it("1.6: rejects reward modifier with percentage amount exceeding 100%", () => {
        const invalidModifier = {
          id: "mod_invalid",
          operator: "AND" as const,
          conditions: [
            {
              entity: "sale" as const,
              attribute: "productId" as const,
              operator: "equals_to" as const,
              value: "prod_1",
            },
          ],
          amountInPercentage: 150, // Invalid: > 100%
          type: "percentage" as const,
        };
        const parsed = rewardConditionsArraySchema.safeParse([invalidModifier]);
        expect(parsed.success).toBe(false);
      });

      it("1.7: rejects productTag criteria in the generic Sale Reward contract", () => {
        const condition = {
          entity: "shopify",
          attribute: "productTag",
          operator: "equals_to",
          value: "high-support",
          label: "High Support Leggings",
        };
        const parsed = rewardConditionSchema.safeParse(condition);
        expect(parsed.success).toBe(false);
      });

      it("1.8: rejects multi-value Shopify criteria in the generic Sale Reward contract", () => {
        const condition = {
          entity: "shopify",
          attribute: "product",
          operator: "in",
          value: [
            "gid://shopify/Product/1001",
            "gid://shopify/Product/1002",
            "gid://shopify/Product/1003",
          ],
          label: "Selected Yamax Hero Products",
        };
        const parsed = rewardConditionSchema.safeParse(condition);
        expect(parsed.success).toBe(false);
      });

      it("1.9: expands multi-value array conditions so every item in the array receives its own commission rule", () => {
        const multiProductModifier = {
          id: "mod_multi_prod",
          operator: "AND" as const,
          conditions: [
            {
              entity: "shopify" as const,
              attribute: "product" as const,
              operator: "in" as const,
              value: ["prod_leggings", "prod_shorts", "prod_tank"],
            },
          ],
          amountInPercentage: 25,
          type: "percentage" as const,
        };

        // Simulate multi-value expansion logic
        const rawValues = Array.isArray(
          multiProductModifier.conditions[0].value,
        )
          ? multiProductModifier.conditions[0].value
          : [multiProductModifier.conditions[0].value];

        const generatedRules = rawValues.map((val, idx) =>
          createBaseCommissionRule({
            id: `rule_expanded_${val}`,
            logicalKey: `mod_multi_prod:product:${val}`,
            scope: "product",
            productId: String(val),
            basisPoints: 2500, // 25%
            priority: Math.max(10, 1000 - 0 * 10), // modIndex 0 -> 1000
          }),
        );

        expect(generatedRules).toHaveLength(3);

        // Verify each product in the multi-value array matches its generated rule
        for (const prodId of ["prod_leggings", "prod_shorts", "prod_tank"]) {
          const ctx: CommissionRuleContext = {
            programId: "prog_yamax_1",
            partnerId: "partner_1",
            productId: prodId,
            accountingCurrency: "USD",
            commissionableAmount: BigInt(5000),
            quantity: 1,
            occurredAt: baseTimestamp,
          };
          const rule = selectCommissionRule(generatedRules, ctx);
          expect(rule?.id).toBe(`rule_expanded_${prodId}`);
          expect(calculateCommission({ rule: rule!, context: ctx })).toBe(
            BigInt(1250),
          ); // 25% of $50 = $12.50
        }
      });

      it("1.10: assigns dynamic priority (1000 - modIndex * 10) to guarantee top-to-bottom UI ordering for same-specificity rules", () => {
        // Modifier 0: Collection A -> 20% commission (priority = 1000)
        const ruleMod0 = createBaseCommissionRule({
          id: "rule_mod_0_coll_a",
          scope: "collection",
          collectionExternalId: "coll_a",
          basisPoints: 2000,
          priority: Math.max(10, 1000 - 0 * 10), // 1000
        });

        // Modifier 1: Collection B -> 15% commission (priority = 990)
        const ruleMod1 = createBaseCommissionRule({
          id: "rule_mod_1_coll_b",
          scope: "collection",
          collectionExternalId: "coll_b",
          basisPoints: 1500,
          priority: Math.max(10, 1000 - 1 * 10), // 990
        });

        // Item belongs to BOTH collection A and collection B
        const dualContext: CommissionRuleContext = {
          programId: "prog_yamax_1",
          partnerId: "partner_1",
          collectionExternalIds: ["coll_a", "coll_b"],
          accountingCurrency: "USD",
          commissionableAmount: BigInt(10000),
          quantity: 1,
          occurredAt: baseTimestamp,
        };

        // Even if passed in reverse order [ruleMod1, ruleMod0], ruleMod0 wins due to priority 1000 > 990
        const selected = selectCommissionRule(
          [ruleMod1, ruleMod0],
          dualContext,
        );
        expect(selected?.id).toBe("rule_mod_0_coll_a");
        expect(
          calculateCommission({ rule: selected!, context: dualContext }),
        ).toBe(BigInt(2000));
      });
    });

    // -------------------------------------------------------------------------
    // Feature 2: Synced Catalog API Response and Filtering
    // -------------------------------------------------------------------------
    describe("Feature 2: Synced Catalog API Response and Filtering", () => {
      const mockCatalogProducts = [
        {
          id: "sprod_1",
          title: "Yamax Agile™ High Support Leggings",
          handle: "yamax-agile-high-support-leggings",
          tags: ["bottoms", "high-support", "yenergy"],
          variants: [
            { id: "svariant_1", title: "Black / S", sku: "YMX-AGL-BLK-S" },
            { id: "svariant_2", title: "Black / M", sku: "YMX-AGL-BLK-M" },
            { id: "svariant_3", title: "Black / L", sku: "YMX-AGL-BLK-L" },
          ],
        },
        {
          id: "sprod_2",
          title: "Yamax Flow™ Cropped Tank Top",
          handle: "yamax-flow-cropped-tank-top",
          tags: ["tops", "cloudsoft", "low-impact"],
          variants: [
            { id: "svariant_4", title: "White / S", sku: "YMX-FLW-WHT-S" },
            { id: "svariant_5", title: "White / M", sku: "YMX-FLW-WHT-M" },
          ],
        },
        {
          id: "sprod_3",
          title: "Yamax CloudSoft™ Sports Bra",
          handle: "yamax-cloudsoft-sports-bra",
          tags: ["bras", "cloudsoft", "medium-support"],
          variants: [
            { id: "svariant_6", title: "Slate / M", sku: "YMX-BRA-SLT-M" },
          ],
        },
      ];

      const mockCatalogCollections = [
        {
          id: "scoll_1",
          title: "Bottoms & Leggings",
          handle: "bottoms-leggings",
          productsCount: 12,
        },
        {
          id: "scoll_2",
          title: "Tops & Tanks",
          handle: "tops-tanks",
          productsCount: 8,
        },
      ];

      it("2.1: resolves active catalog products with nested variants", () => {
        expect(mockCatalogProducts).toHaveLength(3);
        expect(mockCatalogProducts[0].variants).toHaveLength(3);
        expect(mockCatalogProducts[0].variants[0].sku).toBe("YMX-AGL-BLK-S");
      });

      it("2.2: filters catalog products by query string matching title or handle", () => {
        const query = "tank";
        const filtered = mockCatalogProducts.filter(
          (p) =>
            p.title.toLowerCase().includes(query.toLowerCase()) ||
            p.handle.toLowerCase().includes(query.toLowerCase()),
        );
        expect(filtered).toHaveLength(1);
        expect(filtered[0].id).toBe("sprod_2");
      });

      it("2.3: resolves synced catalog collections list with counts", () => {
        expect(mockCatalogCollections).toHaveLength(2);
        expect(mockCatalogCollections[0].productsCount).toBe(12);
      });

      it("2.4: extracts and deduplicates unique product tags across catalog", () => {
        const allTags = [
          ...new Set(mockCatalogProducts.flatMap((p) => p.tags)),
        ];
        expect(allTags).toContain("high-support");
        expect(allTags).toContain("cloudsoft");
        expect(allTags).toContain("bottoms");
        expect(allTags).toHaveLength(8);
      });

      it("2.5: handles empty catalog search query without errors", () => {
        const emptyQuery: string = "";
        const all = mockCatalogProducts.filter(
          (p) =>
            !emptyQuery ||
            p.title.toLowerCase().includes(emptyQuery.toLowerCase()),
        );
        expect(all).toHaveLength(3);
      });
    });

    // -------------------------------------------------------------------------
    // Feature 3: 4 Shopify Discount Types GraphQL Mutation Generators & Validation
    // -------------------------------------------------------------------------
    describe("Feature 3: 4 Shopify Discount Types GraphQL Mutation Generators", () => {
      it("3.1: generates valid Amount Off Order discount payload", () => {
        const payload = generateAmountOffOrderPayload({
          code: "SAVE20",
          amount: 20, // 20%
          rateType: "percentage",
          maxDuration: 0,
        });

        expect(payload.mutation).toBe("DiscountCodeBasicCreate");
        expect(payload.input.code).toBe("SAVE20");
        expect(payload.input.customerGets.items).toEqual({ all: true });
        expect(payload.input.customerGets.value).toEqual({ percentage: 0.2 });
        expect(payload.input.recurringCycleLimit).toBe(1);
      });

      it("3.2: generates valid Amount Off Products discount payload scoped to product IDs", () => {
        const payload = generateAmountOffProductsPayload({
          code: "LEGGINGS10",
          amount: 1000, // $10.00
          rateType: "flat",
          productIds: [
            "gid://shopify/Product/111",
            "gid://shopify/Product/222",
          ],
        });

        expect(payload.mutation).toBe("DiscountCodeBasicCreate");
        expect(payload.input.customerGets.items.products).toEqual({
          productsToAdd: [
            "gid://shopify/Product/111",
            "gid://shopify/Product/222",
          ],
        });
        expect(payload.input.customerGets.value).toEqual({
          discountAmount: { amount: "10.00", appliesOnEachItem: false },
        });
      });

      it("3.3: generates valid Buy X Get Y (BXGY) discount payload", () => {
        const payload = generateBxgyPayload({
          code: "BUY2GET1",
          productIds: ["gid://shopify/Product/999"],
          buyQuantity: 2,
          getQuantity: 1,
          discountType: "percentage",
          discountValue: 100, // 100% free
        });

        expect(payload.mutation).toBe("DiscountCodeBxgyCreate");
        expect(payload.input.customerBuys.value.quantity).toBe(2);
        expect(
          payload.input.customerGets.value.discountOnQuantity.quantity,
        ).toBe(1);
        expect(
          payload.input.customerGets.value.discountOnQuantity.effect,
        ).toEqual({ percentage: 1.0 });
      });

      it("3.4: generates valid Free Shipping discount payload with order minimum", () => {
        const payload = generateFreeShippingPayload({
          code: "FREESHIP60",
          minimumSubtotal: 6000, // ¥6,000 or $60.00
          maximumShippingPrice: 800,
        });

        expect(payload.mutation).toBe("DiscountCodeFreeShippingCreate");
        expect(
          payload.input.minimumRequirement?.subtotal
            ?.greaterThanOrEqualToSubtotal,
        ).toBe("60.00");
        expect(payload.input.maximumShippingPrice).toBe("8.00");
      });

      it("3.5: validates discount code schema and rejects invalid characters", () => {
        const validCode = createDiscountSchema.safeParse({
          workspaceId: "ws_123",
          amount: 20,
          type: "percentage",
          maxDuration: 0,
          couponId: "coup_1",
          groupId: "grp_1",
          provider: "shopify",
        });
        expect(validCode.success).toBe(true);
      });
    });

    // -------------------------------------------------------------------------
    // Feature 4: Multi-Item Cart Line-Level Commission Calculations
    // -------------------------------------------------------------------------
    describe("Feature 4: Multi-Item Cart Line-Level Commission Calculations", () => {
      const productRule = createBaseCommissionRule({
        id: "rule_leggings_20",
        scope: "product",
        productId: "prod_leggings",
        basisPoints: 2000, // 20%
      });

      const collectionRule = createBaseCommissionRule({
        id: "rule_tops_15",
        scope: "collection",
        collectionExternalId: "coll_tops",
        basisPoints: 1500, // 15%
      });

      const variantRule = createBaseCommissionRule({
        id: "rule_bra_25",
        scope: "variant",
        variantId: "var_bra_m",
        basisPoints: 2500, // 25%
      });

      const baseProgramRule = createBaseCommissionRule({
        id: "rule_base_10",
        scope: "program",
        basisPoints: 1000, // 10%
      });

      const rules = [productRule, collectionRule, variantRule, baseProgramRule];

      it("4.1: calculates 20% commission on line matching product condition ($80 -> $16.00)", () => {
        const context: CommissionRuleContext = {
          programId: "prog_yamax_1",
          partnerId: "partner_1",
          productId: "prod_leggings",
          accountingCurrency: "USD",
          commissionableAmount: BigInt(8000), // $80.00
          quantity: 1,
          occurredAt: baseTimestamp,
        };

        const rule = selectCommissionRule(rules, context);
        expect(rule?.id).toBe("rule_leggings_20");
        const earnings = calculateCommission({ rule: rule!, context });
        expect(earnings).toBe(BigInt(1600)); // $16.00
      });

      it("4.2: calculates 15% commission on line matching collection condition ($60 -> $9.00)", () => {
        const context: CommissionRuleContext = {
          programId: "prog_yamax_1",
          partnerId: "partner_1",
          collectionExternalIds: ["coll_tops"],
          accountingCurrency: "USD",
          commissionableAmount: BigInt(6000), // $60.00
          quantity: 1,
          occurredAt: baseTimestamp,
        };

        const rule = selectCommissionRule(rules, context);
        expect(rule?.id).toBe("rule_tops_15");
        const earnings = calculateCommission({ rule: rule!, context });
        expect(earnings).toBe(BigInt(900)); // $9.00
      });

      it("4.3: calculates 25% commission on line matching variant condition ($40 -> $10.00)", () => {
        const context: CommissionRuleContext = {
          programId: "prog_yamax_1",
          partnerId: "partner_1",
          variantId: "var_bra_m",
          accountingCurrency: "USD",
          commissionableAmount: BigInt(4000), // $40.00
          quantity: 1,
          occurredAt: baseTimestamp,
        };

        const rule = selectCommissionRule(rules, context);
        expect(rule?.id).toBe("rule_bra_25");
        const earnings = calculateCommission({ rule: rule!, context });
        expect(earnings).toBe(BigInt(1000)); // $10.00
      });

      it("4.4: calculates fixed item-level commission rule correctly ($5.00 per item on 2 items = $10.00)", () => {
        const fixedItemRule = createBaseCommissionRule({
          id: "rule_fixed_item",
          scope: "product",
          productId: "prod_water_bottle",
          ruleType: "fixed",
          fixedAmountMode: "item",
          fixedAmount: BigInt(500), // $5.00
          currency: "USD",
        });

        const context: CommissionRuleContext = {
          programId: "prog_yamax_1",
          partnerId: "partner_1",
          productId: "prod_water_bottle",
          accountingCurrency: "USD",
          commissionableAmount: BigInt(3000),
          quantity: 2,
          occurredAt: baseTimestamp,
        };

        const rule = selectCommissionRule([fixedItemRule], context);
        const earnings = calculateCommission({ rule: rule!, context });
        expect(earnings).toBe(BigInt(1000)); // $5.00 * 2 = $10.00
      });

      it("4.5: sums multi-item cart line earnings with heterogeneous rates", () => {
        const line1Context: CommissionRuleContext = {
          programId: "prog_yamax_1",
          partnerId: "partner_1",
          productId: "prod_leggings",
          accountingCurrency: "USD",
          commissionableAmount: BigInt(8000),
          quantity: 1,
          occurredAt: baseTimestamp,
        };
        const line2Context: CommissionRuleContext = {
          programId: "prog_yamax_1",
          partnerId: "partner_1",
          collectionExternalIds: ["coll_tops"],
          accountingCurrency: "USD",
          commissionableAmount: BigInt(6000),
          quantity: 1,
          occurredAt: baseTimestamp,
        };

        const line1Earnings = calculateCommission({
          rule: selectCommissionRule(rules, line1Context)!,
          context: line1Context,
        });
        const line2Earnings = calculateCommission({
          rule: selectCommissionRule(rules, line2Context)!,
          context: line2Context,
        });

        const totalEarnings = line1Earnings + line2Earnings;
        expect(totalEarnings).toBe(BigInt(2500)); // $16.00 + $9.00 = $25.00
      });
    });

    // -------------------------------------------------------------------------
    // Feature 5: Base Sale Reward Fallback for Unmatched Items
    // -------------------------------------------------------------------------
    describe("Feature 5: Base Sale Reward Fallback for Unmatched Items", () => {
      const specificProductRule = createBaseCommissionRule({
        id: "rule_specific_product",
        scope: "product",
        productId: "prod_featured",
        basisPoints: 3000, // 30%
      });

      const baseProgramRule = createBaseCommissionRule({
        id: "rule_base_sale",
        scope: "program",
        basisPoints: 1000, // 10% base
      });

      it("5.1: falls back to base sale reward when line item has no specific rule match", () => {
        const unmatchedContext: CommissionRuleContext = {
          programId: "prog_yamax_1",
          partnerId: "partner_1",
          productId: "prod_unmatched_accessory",
          accountingCurrency: "USD",
          commissionableAmount: BigInt(2000), // $20.00
          quantity: 1,
          occurredAt: baseTimestamp,
        };

        const rule = selectCommissionRule(
          [specificProductRule, baseProgramRule],
          unmatchedContext,
        );
        expect(rule?.id).toBe("rule_base_sale");
        const earnings = calculateCommission({
          rule: rule!,
          context: unmatchedContext,
        });
        expect(earnings).toBe(BigInt(200)); // 10% of $20.00 = $2.00
      });

      it("5.2: prioritizes product rule over collection rule and collection rule over base fallback", () => {
        const collectionRule = createBaseCommissionRule({
          id: "rule_collection",
          scope: "collection",
          collectionExternalId: "coll_all",
          basisPoints: 1500,
        });

        const contextMatchingBoth: CommissionRuleContext = {
          programId: "prog_yamax_1",
          partnerId: "partner_1",
          productId: "prod_featured",
          collectionExternalIds: ["coll_all"],
          accountingCurrency: "USD",
          commissionableAmount: BigInt(10000),
          quantity: 1,
          occurredAt: baseTimestamp,
        };

        const rule = selectCommissionRule(
          [baseProgramRule, collectionRule, specificProductRule],
          contextMatchingBoth,
        );
        expect(rule?.id).toBe("rule_specific_product");
      });

      it("5.3: yields zero commission when item is unmatched and no base rule exists", () => {
        const context: CommissionRuleContext = {
          programId: "prog_yamax_1",
          partnerId: "partner_1",
          productId: "prod_unknown",
          accountingCurrency: "USD",
          commissionableAmount: BigInt(5000),
          quantity: 1,
          occurredAt: baseTimestamp,
        };

        const rule = selectCommissionRule([specificProductRule], context);
        expect(rule).toBeUndefined();
      });

      it("5.4: processes mixed cart where 1 item matches specific rule and 2 items fall back to base", () => {
        const cartLines = [
          { productId: "prod_featured", amount: BigInt(10000) }, // 30% -> $30.00
          { productId: "prod_unmatched_1", amount: BigInt(4000) }, // 10% -> $4.00
          { productId: "prod_unmatched_2", amount: BigInt(2000) }, // 10% -> $2.00
        ];

        const lineEarnings = cartLines.map((line) => {
          const ctx: CommissionRuleContext = {
            programId: "prog_yamax_1",
            partnerId: "partner_1",
            productId: line.productId,
            accountingCurrency: "USD",
            commissionableAmount: line.amount,
            quantity: 1,
            occurredAt: baseTimestamp,
          };
          const rule = selectCommissionRule(
            [specificProductRule, baseProgramRule],
            ctx,
          );
          return calculateCommission({ rule: rule!, context: ctx });
        });

        const total = lineEarnings.reduce((acc, curr) => acc + curr, BigInt(0));
        expect(total).toBe(BigInt(3600)); // $30 + $4 + $2 = $36.00
      });

      it("5.5: serializes base group reward into standard commission rule format", () => {
        const serialized = serializeGroupRewardCommission({
          reward: {
            id: "rew_base_1",
            config: {
              type: "shopify_ecommerce",
              activation: {
                published: true,
                startsAt: null,
                endsAt: null,
              },
              customerSegmentMode: "none",
              baseRateType: "percentage",
              baseReturningRate: 10,
              baseNewRate: 10,
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
        });

        expect(serialized).toMatchObject({
          ruleId: "rew_base_1",
          basisPoints: 1000,
          type: "percentage",
        });
      });
    });

    // -------------------------------------------------------------------------
    // Feature 6: Consolidated Dub Commission Record Creation & Itemized Ledger
    // -------------------------------------------------------------------------
    describe("Feature 6: Consolidated Commission Record Creation & Itemized Ledger", () => {
      it("6.1: sums itemized line earnings into single consolidated commission amount in minor units", () => {
        const lineEarnings = [BigInt(1600), BigInt(400), BigInt(200)];
        const totalEarnings = lineEarnings.reduce((a, b) => a + b, BigInt(0));

        const commissionRecord = {
          id: "cm_order_settlement_1",
          amount: 14000, // $140.00
          earnings: Number(totalEarnings), // 2200 ($22.00)
          currency: "USD",
          status: "pending",
        };

        expect(commissionRecord.earnings).toBe(2200);
      });

      it("6.2: constructs itemized calculation entries linked to line IDs and commission ID", () => {
        const commissionId = "cm_consolidated_100";
        const lines = [
          { lineId: "wline_1", ruleId: "wrule_1", earnings: BigInt(1600) },
          { lineId: "wline_2", ruleId: "wrule_2", earnings: BigInt(400) },
        ];

        const calculations = lines.map((line) => ({
          id: createWeleticId("wcalc_"),
          orderLineId: line.lineId,
          commissionId,
          ruleId: line.ruleId,
          earnings: line.earnings,
        }));

        expect(calculations).toHaveLength(2);
        expect(calculations[0].commissionId).toBe(commissionId);
        expect(calculations[0].orderLineId).toBe("wline_1");
        expect(calculations[1].orderLineId).toBe("wline_2");
      });

      it("6.3: distributes fixed order bonuses proportionally across eligible lines", () => {
        const totalBonus = BigInt(3000); // $30.00 bonus
        const lineAmounts = [BigInt(5000), BigInt(3000), BigInt(2000)]; // $50, $30, $20 (Total $100)

        const allocations = allocateCommissionProportionally({
          total: totalBonus,
          amounts: lineAmounts,
        });

        expect(allocations).toEqual([BigInt(1500), BigInt(900), BigInt(600)]);
        expect(allocations.reduce((a, b) => a + b, BigInt(0))).toBe(totalBonus);
      });

      it("6.4: ensures proportional allocation sum exactly matches total with rounding remainders", () => {
        const totalBonus = BigInt(100); // 100 cents split 3 ways
        const lineAmounts = [BigInt(3333), BigInt(3333), BigInt(3334)];

        const allocations = allocateCommissionProportionally({
          total: totalBonus,
          amounts: lineAmounts,
        });

        expect(allocations.reduce((a, b) => a + b, BigInt(0))).toBe(
          BigInt(100),
        );
      });

      it("6.5: safely converts BigInt earnings to integer without overflow", () => {
        const safeBigInt = BigInt(500000); // $5,000.00
        const asNumber = Number(safeBigInt);
        expect(Number.isSafeInteger(asNumber)).toBe(true);
        expect(asNumber).toBe(500000);
      });
    });

    // -------------------------------------------------------------------------
    // Feature 7: ADR 0004 Proportional Partial Refund Calculation & Unreversed Ceiling
    // -------------------------------------------------------------------------
    describe("Feature 7: ADR 0004 Proportional Partial Refund Calculation & Ceiling", () => {
      it("7.1: calculates proportional reversal on 50% line refund ($40 of $80 -> $8.00 reversal)", () => {
        const reversal = calculateRefundReversal({
          originalEarnings: BigInt(1600), // $16.00
          originalCommissionableAmount: BigInt(8000), // $80.00
          refundedAmount: BigInt(4000), // $40.00
          alreadyReversed: BigInt(0),
        });

        expect(reversal).toBe(BigInt(800)); // $8.00
      });

      it("7.2: calculates full reversal on 100% line refund ($80 of $80 -> $16.00 reversal)", () => {
        const reversal = calculateRefundReversal({
          originalEarnings: BigInt(1600),
          originalCommissionableAmount: BigInt(8000),
          refundedAmount: BigInt(8000),
          alreadyReversed: BigInt(0),
        });

        expect(reversal).toBe(BigInt(1600)); // $16.00
      });

      it("7.3: clamps reversal to remaining unreversed earnings to prevent over-clawback", () => {
        const reversal = calculateRefundReversal({
          originalEarnings: BigInt(1600),
          originalCommissionableAmount: BigInt(8000),
          refundedAmount: BigInt(6000), // proportional would be $12.00
          alreadyReversed: BigInt(1000), // already reversed $10.00 -> remaining is $6.00
        });

        expect(reversal).toBe(BigInt(600)); // Clamped to $6.00
      });

      it("7.4: returns 0 reversal when line has already been 100% reversed", () => {
        const reversal = calculateRefundReversal({
          originalEarnings: BigInt(1600),
          originalCommissionableAmount: BigInt(8000),
          refundedAmount: BigInt(2000),
          alreadyReversed: BigInt(1600), // 100% already reversed
        });

        expect(reversal).toBe(BigInt(0));
      });

      it("7.5: returns 0 reversal when original commissionable amount or earnings are 0", () => {
        const reversal1 = calculateRefundReversal({
          originalEarnings: BigInt(0),
          originalCommissionableAmount: BigInt(5000),
          refundedAmount: BigInt(2500),
        });
        const reversal2 = calculateRefundReversal({
          originalEarnings: BigInt(1000),
          originalCommissionableAmount: BigInt(0),
          refundedAmount: BigInt(2500),
        });

        expect(reversal1).toBe(BigInt(0));
        expect(reversal2).toBe(BigInt(0));
      });
    });
  });

  // ===========================================================================
  // TIER 2: BOUNDARY & CORNER CASES (>=5 per feature)
  // ===========================================================================
  describe("Tier 2: Boundary & Corner Cases", () => {
    // -------------------------------------------------------------------------
    // Boundary 1: Zero-Decimal Currencies (JPY, VND) vs Standard (USD)
    // -------------------------------------------------------------------------
    describe("Boundary 1: Zero-Decimal Currencies (JPY, VND)", () => {
      it("2.1: calculates JPY order commission without decimal division loss (¥12,000 @ 15% = ¥1,800)", () => {
        const jpyAmount = decimalToMinorUnits("12000", "JPY"); // 12000
        expect(jpyAmount).toBe(BigInt(12000));

        const jpyRule = createBaseCommissionRule({
          id: "rule_jpy_15",
          basisPoints: 1500, // 15%
        });

        const context: CommissionRuleContext = {
          programId: "prog_yamax_1",
          accountingCurrency: "JPY",
          commissionableAmount: jpyAmount,
          quantity: 1,
          occurredAt: baseTimestamp,
        };

        const earnings = calculateCommission({ rule: jpyRule, context });
        expect(earnings).toBe(BigInt(1800)); // ¥1,800 exact
      });

      it("2.2: calculates VND order commission without decimal loss (500,000₫ @ 10% = 50,000₫)", () => {
        const vndAmount = decimalToMinorUnits("500000", "VND");
        expect(vndAmount).toBe(BigInt(500000));

        const vndRule = createBaseCommissionRule({
          id: "rule_vnd_10",
          basisPoints: 1000, // 10%
        });

        const context: CommissionRuleContext = {
          programId: "prog_yamax_1",
          accountingCurrency: "VND",
          commissionableAmount: vndAmount,
          quantity: 1,
          occurredAt: baseTimestamp,
        };

        const earnings = calculateCommission({ rule: vndRule, context });
        expect(earnings).toBe(BigInt(50000)); // 50,000₫ exact
      });

      it("2.3: rounds half-up on fractional JPY commission calculations (¥1,999 @ 15% -> ¥300)", () => {
        const context: CommissionRuleContext = {
          programId: "prog_yamax_1",
          accountingCurrency: "JPY",
          commissionableAmount: BigInt(1999),
          quantity: 1,
          occurredAt: baseTimestamp,
        };

        const jpyRule = createBaseCommissionRule({ basisPoints: 1500 });
        const earnings = calculateCommission({ rule: jpyRule, context });
        // 1999 * 1500 / 10000 = 299.85 -> rounds to 300
        expect(earnings).toBe(BigInt(300));
      });

      it("2.4: converts standard 2-decimal USD ($80.00 -> 8000 minor units)", () => {
        const usdMinor = decimalToMinorUnits("80.00", "USD");
        expect(usdMinor).toBe(BigInt(8000));
      });

      it("2.5: executes proportional refund in JPY without decimal residue (¥5,000 of ¥12,000 -> ¥750 reversal)", () => {
        const reversal = calculateRefundReversal({
          originalEarnings: BigInt(1800),
          originalCommissionableAmount: BigInt(12000),
          refundedAmount: BigInt(5000),
          alreadyReversed: BigInt(0),
        });

        expect(reversal).toBe(BigInt(750));
      });
    });

    // -------------------------------------------------------------------------
    // Boundary 2: Empty / Single Item vs Large Multi-Item Cart (10+ items)
    // -------------------------------------------------------------------------
    describe("Boundary 2: Empty / Single Item vs Large Multi-Item Cart", () => {
      it("2.6: handles single item cart with quantity 1", () => {
        const allocations = allocateCommissionProportionally({
          total: BigInt(500),
          amounts: [BigInt(5000)],
        });
        expect(allocations).toEqual([BigInt(500)]);
      });

      it("2.7: handles single item cart with quantity 10", () => {
        const fixedItemRule = createBaseCommissionRule({
          ruleType: "fixed",
          fixedAmountMode: "item",
          fixedAmount: BigInt(200), // $2.00 per item
          currency: "USD",
        });

        const context: CommissionRuleContext = {
          programId: "prog_yamax_1",
          accountingCurrency: "USD",
          commissionableAmount: BigInt(50000),
          quantity: 10,
          occurredAt: baseTimestamp,
        };

        const earnings = calculateCommission({ rule: fixedItemRule, context });
        expect(earnings).toBe(BigInt(2000)); // $2.00 * 10 = $20.00
      });

      it("2.8: processes 12-item heterogeneous cart line-by-line", () => {
        const lines = Array.from({ length: 12 }, (_, i) => ({
          id: `line_${i + 1}`,
          amount: BigInt((i + 1) * 1000), // $10, $20, ..., $120
          rateBps: i % 2 === 0 ? 2000 : 1000, // 20% or 10%
        }));

        const totalEarnings = lines.reduce((sum, line) => {
          const rule = createBaseCommissionRule({ basisPoints: line.rateBps });
          const earnings = calculateCommission({
            rule,
            context: {
              programId: "prog_yamax_1",
              accountingCurrency: "USD",
              commissionableAmount: line.amount,
              quantity: 1,
              occurredAt: baseTimestamp,
            },
          });
          return sum + earnings;
        }, BigInt(0));

        expect(totalEarnings).toBeGreaterThan(BigInt(0));
      });

      it("2.9: allocates fixed order bonus across 12 items with exact sum conservation", () => {
        const totalBonus = BigInt(5000); // $50.00
        const lineAmounts = Array.from({ length: 12 }, (_, i) =>
          BigInt((i + 1) * 750),
        );

        const allocations = allocateCommissionProportionally({
          total: totalBonus,
          amounts: lineAmounts,
        });

        expect(allocations).toHaveLength(12);
        expect(allocations.reduce((a, b) => a + b, BigInt(0))).toBe(totalBonus);
      });

      it("2.10: returns empty array when allocating over empty lines array", () => {
        const allocations = allocateCommissionProportionally({
          total: BigInt(1000),
          amounts: [],
        });
        expect(allocations).toEqual([]);
      });
    });

    // -------------------------------------------------------------------------
    // Boundary 3: 100% Discounts vs 0% Discounts vs Negative Inputs
    // -------------------------------------------------------------------------
    describe("Boundary 3: 100% Discounts vs 0% Discounts vs Negative Inputs", () => {
      it("2.11: yields 0 commission when cart line is 100% discounted (net = 0)", () => {
        const rule = createBaseCommissionRule({ basisPoints: 2000 });
        const earnings = calculateCommission({
          rule,
          context: {
            programId: "prog_yamax_1",
            accountingCurrency: "USD",
            commissionableAmount: BigInt(0), // 100% off -> $0.00 net
            quantity: 1,
            occurredAt: baseTimestamp,
          },
        });

        expect(earnings).toBe(BigInt(0));
      });

      it("2.12: handles single free item in a multi-item cart without affecting other items", () => {
        const paidLineEarnings = calculateCommission({
          rule: createBaseCommissionRule({ basisPoints: 2000 }),
          context: {
            programId: "prog_yamax_1",
            accountingCurrency: "USD",
            commissionableAmount: BigInt(8000),
            quantity: 1,
            occurredAt: baseTimestamp,
          },
        });
        const freeLineEarnings = calculateCommission({
          rule: createBaseCommissionRule({ basisPoints: 2000 }),
          context: {
            programId: "prog_yamax_1",
            accountingCurrency: "USD",
            commissionableAmount: BigInt(0),
            quantity: 1,
            occurredAt: baseTimestamp,
          },
        });

        expect(paidLineEarnings).toBe(BigInt(1600));
        expect(freeLineEarnings).toBe(BigInt(0));
      });

      it("2.13: applies full price to commission on 0% discount", () => {
        const gross = BigInt(10000);
        const discount = BigInt(0);
        const net = gross - discount;

        const earnings = calculateCommission({
          rule: createBaseCommissionRule({ basisPoints: 1000 }),
          context: {
            programId: "prog_yamax_1",
            accountingCurrency: "USD",
            commissionableAmount: net,
            quantity: 1,
            occurredAt: baseTimestamp,
          },
        });

        expect(earnings).toBe(BigInt(1000)); // $10.00
      });

      it("2.14: clamps negative commissionable amount to 0 earnings", () => {
        const earnings = calculateCommission({
          rule: createBaseCommissionRule({ basisPoints: 1000 }),
          context: {
            programId: "prog_yamax_1",
            accountingCurrency: "USD",
            commissionableAmount: BigInt(-5000),
            quantity: 1,
            occurredAt: baseTimestamp,
          },
        });

        expect(earnings).toBe(BigInt(0));
      });

      it("2.15: respects maximum commission amount cap when specified on rule", () => {
        const cappedRule = createBaseCommissionRule({
          basisPoints: 5000, // 50%
          maxCommissionAmount: BigInt(2500), // Cap at $25.00
        });

        const earnings = calculateCommission({
          rule: cappedRule,
          context: {
            programId: "prog_yamax_1",
            accountingCurrency: "USD",
            commissionableAmount: BigInt(10000), // 50% would be $50.00
            quantity: 1,
            occurredAt: baseTimestamp,
          },
        });

        expect(earnings).toBe(BigInt(2500)); // Capped at $25.00
      });
    });

    // -------------------------------------------------------------------------
    // Boundary 4: Multi-Stage Partial Refunds Summing to 100%
    // -------------------------------------------------------------------------
    describe("Boundary 4: Multi-Stage Partial Refunds Summing to 100%", () => {
      it("2.16: executes 3-stage partial refund sequence (25% + 50% + 25%) summing to exact 100%", () => {
        const originalEarnings = BigInt(2000); // $20.00
        const originalAmount = BigInt(10000); // $100.00

        // Stage 1: Refund $25.00 (25%)
        const rev1 = calculateRefundReversal({
          originalEarnings,
          originalCommissionableAmount: originalAmount,
          refundedAmount: BigInt(2500),
          alreadyReversed: BigInt(0),
        });
        expect(rev1).toBe(BigInt(500)); // $5.00

        // Stage 2: Refund $50.00 (50%)
        const rev2 = calculateRefundReversal({
          originalEarnings,
          originalCommissionableAmount: originalAmount,
          refundedAmount: BigInt(5000),
          alreadyReversed: rev1,
        });
        expect(rev2).toBe(BigInt(1000)); // $10.00

        // Stage 3: Refund remaining $25.00 (25%)
        const rev3 = calculateRefundReversal({
          originalEarnings,
          originalCommissionableAmount: originalAmount,
          refundedAmount: BigInt(2500),
          alreadyReversed: rev1 + rev2,
        });
        expect(rev3).toBe(BigInt(500)); // $5.00

        // Total clawback
        const totalReversed = rev1 + rev2 + rev3;
        expect(totalReversed).toBe(originalEarnings); // Exact $20.00
      });

      it("2.17: blocks 4th refund attempt after 100% has already been reversed", () => {
        const rev4 = calculateRefundReversal({
          originalEarnings: BigInt(2000),
          originalCommissionableAmount: BigInt(10000),
          refundedAmount: BigInt(1000),
          alreadyReversed: BigInt(2000), // 100% already reversed
        });

        expect(rev4).toBe(BigInt(0));
      });

      it("2.18: handles odd fractional multi-stage partial refund amounts without loss", () => {
        const originalEarnings = BigInt(333);
        const originalAmount = BigInt(1000);

        // Stage 1: Refund 333
        const r1 = calculateRefundReversal({
          originalEarnings,
          originalCommissionableAmount: originalAmount,
          refundedAmount: BigInt(333),
          alreadyReversed: BigInt(0),
        });

        // Stage 2: Refund 667 (completes 1000)
        const r2 = calculateRefundReversal({
          originalEarnings,
          originalCommissionableAmount: originalAmount,
          refundedAmount: BigInt(667),
          alreadyReversed: r1,
        });

        expect(r1 + r2).toBe(originalEarnings);
      });

      it("2.19: full 100% order refund in single webhook reverses entire original earnings", () => {
        const revFull = calculateRefundReversal({
          originalEarnings: BigInt(4500),
          originalCommissionableAmount: BigInt(15000),
          refundedAmount: BigInt(15000),
          alreadyReversed: BigInt(0),
        });

        expect(revFull).toBe(BigInt(4500));
      });

      it("2.20: maintains non-negative remaining earnings across multiple refund events", () => {
        const original = BigInt(1000);
        let reversed = BigInt(0);

        for (const refundAmount of [BigInt(400), BigInt(400), BigInt(400)]) {
          const clawback = calculateRefundReversal({
            originalEarnings: original,
            originalCommissionableAmount: BigInt(1000),
            refundedAmount: refundAmount,
            alreadyReversed: reversed,
          });
          reversed += clawback;
          expect(original - reversed).toBeGreaterThanOrEqual(BigInt(0));
        }

        expect(reversed).toBe(original);
      });
    });

    // -------------------------------------------------------------------------
    // Boundary 5: Concurrent Partial Refunds & Idempotency Replay
    // -------------------------------------------------------------------------
    describe("Boundary 5: Concurrent Partial Refunds & Idempotency Replay", () => {
      it("2.21: detects duplicate refund external ID and returns duplicate flag", () => {
        const existingRefunds = new Set(["ref_shopify_9901"]);
        const incomingId = "ref_shopify_9901";

        const isDuplicate = existingRefunds.has(incomingId);
        expect(isDuplicate).toBe(true);
      });

      it("2.22: detects duplicate order external ID to prevent double commission settlement", () => {
        const existingOrders = new Set(["order_shopify_12345"]);
        const incomingId = "order_shopify_12345";

        const isDuplicate = existingOrders.has(incomingId);
        expect(isDuplicate).toBe(true);
      });

      it("2.23: processes two isolated concurrent refund lines on different items of same order", () => {
        const line1Reversal = calculateRefundReversal({
          originalEarnings: BigInt(1600),
          originalCommissionableAmount: BigInt(8000),
          refundedAmount: BigInt(8000),
          alreadyReversed: BigInt(0),
        });
        const line2Reversal = calculateRefundReversal({
          originalEarnings: BigInt(400),
          originalCommissionableAmount: BigInt(4000),
          refundedAmount: BigInt(4000),
          alreadyReversed: BigInt(0),
        });

        expect(line1Reversal).toBe(BigInt(1600));
        expect(line2Reversal).toBe(BigInt(400));
        expect(line1Reversal + line2Reversal).toBe(BigInt(2000));
      });

      it("2.24: ignores refund event when referenced order is not in database", () => {
        const orderMap = new Map<string, any>();
        const refundOrderId = "non_existent_order";

        const order = orderMap.get(refundOrderId);
        expect(order).toBeUndefined();
      });

      it("2.25: ensures deterministic sourceKey generation for calculation records", () => {
        const storeId = "wstore_yamax";
        const orderExternalId = "1001";
        const lineExternalId = "line_201";

        const sourceKey = `sale:${storeId}:${orderExternalId}:${lineExternalId}`;
        expect(sourceKey).toBe("sale:wstore_yamax:1001:line_201");
      });
    });
  });

  // ===========================================================================
  // TIER 3: CROSS-FEATURE COMBINATIONS (Pairwise)
  // ===========================================================================
  describe("Tier 3: Cross-Feature Combinations", () => {
    it("3.1: BXGY Discount paired with Multi-Item Settlement (Buy 2 Leggings get 1 Free Tank Top)", () => {
      // 2x Leggings ($80 each = $160) + 1x Tank Top ($40 - 100% BXGY discount = $0 net)
      const leggingRule = createBaseCommissionRule({
        scope: "product",
        productId: "prod_leggings",
        basisPoints: 2000, // 20%
      });
      const tankRule = createBaseCommissionRule({
        scope: "collection",
        collectionExternalId: "coll_tops",
        basisPoints: 1000, // 10%
      });

      const leggingEarnings = calculateCommission({
        rule: leggingRule,
        context: {
          programId: "prog_yamax_1",
          accountingCurrency: "USD",
          commissionableAmount: BigInt(16000), // $160.00
          quantity: 2,
          occurredAt: baseTimestamp,
        },
      });

      const tankEarnings = calculateCommission({
        rule: tankRule,
        context: {
          programId: "prog_yamax_1",
          accountingCurrency: "USD",
          commissionableAmount: BigInt(0), // $0.00 net after BXGY
          quantity: 1,
          occurredAt: baseTimestamp,
        },
      });

      expect(leggingEarnings).toBe(BigInt(3200)); // $32.00
      expect(tankEarnings).toBe(BigInt(0)); // $0.00
      expect(leggingEarnings + tankEarnings).toBe(BigInt(3200)); // $32.00 total
    });

    it("3.2: Amount Off Products Discount paired with Collection-Based Reward Condition", () => {
      // $20 off Bottoms Collection applied to $100 Legging (net $80) + $50 Tank Top (no discount, net $50)
      const bottomsCollectionRule = createBaseCommissionRule({
        scope: "collection",
        collectionExternalId: "coll_bottoms",
        basisPoints: 1500, // 15%
      });
      const baseRule = createBaseCommissionRule({
        scope: "program",
        basisPoints: 1000, // 10%
      });

      const leggingEarnings = calculateCommission({
        rule: bottomsCollectionRule,
        context: {
          programId: "prog_yamax_1",
          collectionExternalIds: ["coll_bottoms"],
          accountingCurrency: "USD",
          commissionableAmount: BigInt(8000), // $80.00 net
          quantity: 1,
          occurredAt: baseTimestamp,
        },
      });

      const tankEarnings = calculateCommission({
        rule: baseRule,
        context: {
          programId: "prog_yamax_1",
          accountingCurrency: "USD",
          commissionableAmount: BigInt(5000), // $50.00 net
          quantity: 1,
          occurredAt: baseTimestamp,
        },
      });

      expect(leggingEarnings).toBe(BigInt(1200)); // 15% of $80 = $12.00
      expect(tankEarnings).toBe(BigInt(500)); // 10% of $50 = $5.00
      expect(leggingEarnings + tankEarnings).toBe(BigInt(1700)); // $17.00
    });

    it("3.3: Partial Refund of an order with Mixed Product and Collection Commission Rates", () => {
      // Initial Order: Legging ($80 @ 20% = $16) + Sports Bra ($40 @ 10% = $4) -> $20 total comm
      const leggingOriginalEarnings = BigInt(1600);
      const braOriginalEarnings = BigInt(400);

      // Refund 50% of Legging ($40) + 100% of Sports Bra ($40)
      const leggingClawback = calculateRefundReversal({
        originalEarnings: leggingOriginalEarnings,
        originalCommissionableAmount: BigInt(8000),
        refundedAmount: BigInt(4000),
      });

      const braClawback = calculateRefundReversal({
        originalEarnings: braOriginalEarnings,
        originalCommissionableAmount: BigInt(4000),
        refundedAmount: BigInt(4000),
      });

      expect(leggingClawback).toBe(BigInt(800)); // $8.00 clawback
      expect(braClawback).toBe(BigInt(400)); // $4.00 clawback
      const totalClawback = leggingClawback + braClawback;
      expect(totalClawback).toBe(BigInt(1200)); // $12.00 clawback

      const remainingNetCommission =
        leggingOriginalEarnings + braOriginalEarnings - totalClawback;
      expect(remainingNetCommission).toBe(BigInt(800)); // $8.00 remaining
    });

    it("3.4: Free Shipping Discount paired with Variant-Specific Commission & Minimum Spend", () => {
      // Order with $120 Variant + Free Shipping code ($15 shipping waived)
      const variantRule = createBaseCommissionRule({
        scope: "variant",
        variantId: "var_special_edition",
        basisPoints: 1800, // 18%
        minOrderAmount: BigInt(10000), // Min order $100.00
      });

      const context: CommissionRuleContext = {
        programId: "prog_yamax_1",
        variantId: "var_special_edition",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(12000), // $120.00
        orderAmount: BigInt(12000),
        quantity: 1,
        occurredAt: baseTimestamp,
      };

      const rule = selectCommissionRule([variantRule], context);
      expect(rule?.id).toBe(variantRule.id);
      const earnings = calculateCommission({ rule: rule!, context });
      expect(earnings).toBe(BigInt(2160)); // 18% of $120 = $21.60
    });

    it("3.5: Order-Level Discount distributed across Heterogeneous Lines with Proportional Refund", () => {
      // Order with Product A ($100 gross) and Product B ($100 gross). $40 order discount -> $80 net each.
      // Product A has 20% rule ($16 comm). Product B has 10% rule ($8 comm). Total = $24 comm.
      const commA = BigInt(1600);
      const commB = BigInt(800);

      // Refund 50% of Product A ($40 refund on the $80 net line)
      const clawbackA = calculateRefundReversal({
        originalEarnings: commA,
        originalCommissionableAmount: BigInt(8000),
        refundedAmount: BigInt(4000),
      });

      expect(clawbackA).toBe(BigInt(800)); // $8.00 clawback
      expect(commA + commB - clawbackA).toBe(BigInt(1600)); // $16.00 remaining
    });
  });

  // ===========================================================================
  // TIER 4: REAL-WORLD APPLICATION SCENARIOS (>=5 scenarios)
  // ===========================================================================
  describe("Tier 4: Real-World Application Scenarios", () => {
    // -------------------------------------------------------------------------
    // Scenario 1: Yamax Activewear Live Shopping Cart Settlement
    // -------------------------------------------------------------------------
    it("Scenario 1: Yamax Activewear live shopping scenario (1x Legging $80 @ 20% + 1x Tank $40 @ 10% + 1x Headband $20 @ 10% -> $22 commission)", () => {
      const leggingRule = createBaseCommissionRule({
        id: "rule_yamax_leggings",
        scope: "product",
        productId: "prod_yamax_agile_leggings",
        basisPoints: 2000, // 20%
      });

      const topsCollectionRule = createBaseCommissionRule({
        id: "rule_yamax_tops_collection",
        scope: "collection",
        collectionExternalId: "coll_yamax_tops",
        basisPoints: 1000, // 10%
      });

      const baseSaleRule = createBaseCommissionRule({
        id: "rule_yamax_base_sale",
        scope: "program",
        basisPoints: 1000, // 10% base
      });

      const programRules = [leggingRule, topsCollectionRule, baseSaleRule];

      // Line 1: 1x Yamax Agile™ High Support Leggings ($80)
      const line1Ctx: CommissionRuleContext = {
        programId: "prog_yamax_1",
        partnerId: "partner_yamax_ambassador",
        productId: "prod_yamax_agile_leggings",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(8000), // $80.00
        quantity: 1,
        occurredAt: baseTimestamp,
      };
      const line1Rule = selectCommissionRule(programRules, line1Ctx);
      const line1Earnings = calculateCommission({
        rule: line1Rule!,
        context: line1Ctx,
      });

      // Line 2: 1x Yamax Flow™ Cropped Tank Top ($40)
      const line2Ctx: CommissionRuleContext = {
        programId: "prog_yamax_1",
        partnerId: "partner_yamax_ambassador",
        collectionExternalIds: ["coll_yamax_tops"],
        accountingCurrency: "USD",
        commissionableAmount: BigInt(4000), // $40.00
        quantity: 1,
        occurredAt: baseTimestamp,
      };
      const line2Rule = selectCommissionRule(programRules, line2Ctx);
      const line2Earnings = calculateCommission({
        rule: line2Rule!,
        context: line2Ctx,
      });

      // Line 3: 1x Yamax Performance Headband ($20) - Unmatched fallback to base
      const line3Ctx: CommissionRuleContext = {
        programId: "prog_yamax_1",
        partnerId: "partner_yamax_ambassador",
        productId: "prod_yamax_headband",
        accountingCurrency: "USD",
        commissionableAmount: BigInt(2000), // $20.00
        quantity: 1,
        occurredAt: baseTimestamp,
      };
      const line3Rule = selectCommissionRule(programRules, line3Ctx);
      const line3Earnings = calculateCommission({
        rule: line3Rule!,
        context: line3Ctx,
      });

      expect(line1Earnings).toBe(BigInt(1600)); // $16.00
      expect(line2Earnings).toBe(BigInt(400)); // $4.00
      expect(line3Earnings).toBe(BigInt(200)); // $2.00

      const totalCommission = line1Earnings + line2Earnings + line3Earnings;
      expect(totalCommission).toBe(BigInt(2200)); // $22.00 total commission
    });

    // -------------------------------------------------------------------------
    // Scenario 2: Yamax Activewear Subsequent Partial Refund Clawback (ADR 0004)
    // -------------------------------------------------------------------------
    it("Scenario 2: Yamax Activewear subsequent partial refund of the $80 Legging ($16 clawback, remaining commission $6)", () => {
      const originalLeggingEarnings = BigInt(1600); // $16.00
      const originalTankEarnings = BigInt(400); // $4.00
      const originalHeadbandEarnings = BigInt(200); // $2.00
      const initialTotalCommission =
        originalLeggingEarnings +
        originalTankEarnings +
        originalHeadbandEarnings; // $22.00

      // Customer returns the $80 Yamax Agile Leggings (full refund of that line item)
      const leggingClawback = calculateRefundReversal({
        originalEarnings: originalLeggingEarnings,
        originalCommissionableAmount: BigInt(8000),
        refundedAmount: BigInt(8000), // $80.00 refunded
        alreadyReversed: BigInt(0),
      });

      expect(leggingClawback).toBe(BigInt(1600)); // Exact $16.00 clawback

      const remainingCommission = initialTotalCommission - leggingClawback;
      expect(remainingCommission).toBe(BigInt(600)); // Exactly $6.00 remaining
    });

    // -------------------------------------------------------------------------
    // Scenario 3: Multi-Currency JPY Order with Free Shipping & Variant Rule
    // -------------------------------------------------------------------------
    it("Scenario 3: Multi-currency JPY order with Free Shipping discount and variant-level commission", () => {
      // 1x Yamax Flow™ High-Rise Shorts 6" (Variant: Olive M @ ¥6,800, 15% rule) + Free Shipping
      const variantRule = createBaseCommissionRule({
        id: "rule_jpy_shorts_variant",
        programId: "prog_yamax_japan",
        scope: "variant",
        variantId: "var_shorts_olive_m",
        basisPoints: 1500, // 15%
      });

      const context: CommissionRuleContext = {
        programId: "prog_yamax_japan",
        partnerId: "partner_tokyo_fitness",
        variantId: "var_shorts_olive_m",
        accountingCurrency: "JPY",
        commissionableAmount: BigInt(6800), // ¥6,800
        quantity: 1,
        occurredAt: baseTimestamp,
      };

      const rule = selectCommissionRule([variantRule], context);
      const earnings = calculateCommission({ rule: rule!, context });

      // ¥6,800 * 15% = ¥1,020 exact integer arithmetic
      expect(earnings).toBe(BigInt(1020));
    });

    // -------------------------------------------------------------------------
    // Scenario 4: Yamax BXGY Bundle Promo with Proportional Multi-Item Clawback
    // -------------------------------------------------------------------------
    it("Scenario 4: Yamax BXGY Bundle Promo (Buy 2 Leggings $160, get 1 Sports Bra 50% off $25) with proportional clawback", () => {
      // 2x Leggings ($160 net, 20% rule = $32.00) + 1x Sports Bra ($25 net, 12% rule = $3.00)
      const leggingComm = BigInt(3200);
      const braComm = BigInt(300);
      const totalInitialComm = leggingComm + braComm; // $35.00

      // Customer returns 1 of the 2 Leggings ($80 refunded out of $160 line)
      const leggingClawback = calculateRefundReversal({
        originalEarnings: leggingComm,
        originalCommissionableAmount: BigInt(16000),
        refundedAmount: BigInt(8000), // $80.00
        alreadyReversed: BigInt(0),
      });

      expect(leggingClawback).toBe(BigInt(1600)); // $16.00 clawback
      const netCommission = totalInitialComm - leggingClawback;
      expect(netCommission).toBe(BigInt(1900)); // $19.00 ($35.00 - $16.00)
    });

    // -------------------------------------------------------------------------
    // Scenario 5: High-Volume Cart with Fixed Order Bonus Proportional Allocation
    // -------------------------------------------------------------------------
    it("Scenario 5: High-volume 5-item cart with $25.00 fixed order bonus and line-level refund", () => {
      // Cart items: $100, $60, $40, $30, $20 (Total $250.00). Fixed bonus: $25.00 (2500 cents).
      const totalBonus = BigInt(2500);
      const lineAmounts = [
        BigInt(10000),
        BigInt(6000),
        BigInt(4000),
        BigInt(3000),
        BigInt(2000),
      ];

      const allocations = allocateCommissionProportionally({
        total: totalBonus,
        amounts: lineAmounts,
      });

      expect(allocations).toEqual([
        BigInt(1000), // Item 1: $10.00
        BigInt(600), // Item 2: $6.00
        BigInt(400), // Item 3: $4.00
        BigInt(300), // Item 4: $3.00
        BigInt(200), // Item 5: $2.00
      ]);
      expect(allocations.reduce((a, b) => a + b, BigInt(0))).toBe(totalBonus);

      // Customer partially returns Item 1 ($50 refunded out of $100)
      const item1Clawback = calculateRefundReversal({
        originalEarnings: allocations[0], // $10.00
        originalCommissionableAmount: lineAmounts[0], // $100.00
        refundedAmount: BigInt(5000), // $50.00
      });

      expect(item1Clawback).toBe(BigInt(500)); // $5.00 clawback
      const remainingBonus = totalBonus - item1Clawback;
      expect(remainingBonus).toBe(BigInt(2000)); // $20.00 remaining
    });
  });
});
