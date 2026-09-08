import {
  assertRecordedShopifyOrder,
  classifyLifetimeShopifyCustomerOrder,
  isExplicitShopifyCommissionRuleKey,
  resolveOrderAttributionTransition,
  resolveShopifySubscriptionCycle,
  retainKnownShopifyCustomerSnapshot,
  selectCapturedReward,
  selectEffectiveRuleVersions,
  shopifyOrderSettlementLockKey,
} from "@/lib/weletic/commerce/order-attribution";
import { isRewardAvailableAt } from "@/lib/weletic/commissions/reward-availability";
import {
  resolveShopifyEcommerceCommission,
  sameShopifyId,
} from "@/lib/weletic/commissions/shopify-reward";
import { rewardConditionsArraySchema } from "@/lib/zod/schemas/rewards";
import {
  countShopifyRewardOverrides,
  getShopifyRewardLifecycleStatus,
  resolveShopifyRewardConfigAt,
  ShopifyEcommerceRewardConfigSchema,
  type ShopifyEcommerceRewardConfig,
} from "@/lib/zod/schemas/shopify-ecommerce-reward";
import { describe, expect, it } from "vitest";

const config = (
  overrides: Partial<ShopifyEcommerceRewardConfig> = {},
): ShopifyEcommerceRewardConfig => ({
  type: "shopify_ecommerce",
  activation: { published: true, startsAt: null, endsAt: null },
  customerSegmentMode: "new_vs_returning",
  baseRateType: "percentage",
  baseReturningRate: 10,
  baseNewRate: 20,
  shopifySegment: null,
  collectionOverrides: [],
  productOverrides: [],
  variantOverrides: [],
  subscriptionRules: { mode: "first_sale", recurringOrderCount: null },
  ...overrides,
});

describe("Shopify eCommerce reward settlement resolver", () => {
  it("counts variant, product, and collection overrides", () => {
    expect(
      countShopifyRewardOverrides(
        config({
          variantOverrides: [
            {
              id: "gid://shopify/ProductVariant/1",
              title: "Variant",
              returningRate: 10,
            },
          ],
          productOverrides: [
            {
              id: "gid://shopify/Product/1",
              title: "Product",
              returningRate: 10,
            },
          ],
          collectionOverrides: [
            {
              id: "gid://shopify/Collection/1",
              title: "Collection",
              returningRate: 10,
            },
          ],
        }),
      ),
    ).toBe(3);
  });

  it("defaults legacy Shopify reward configurations to active", () => {
    const { activation: _activation, ...legacyConfig } = config();
    const parsed = ShopifyEcommerceRewardConfigSchema.parse(legacyConfig);

    expect(parsed.activation).toEqual({
      published: true,
      startsAt: null,
      endsAt: null,
    });
  });

  it.each([
    ["draft", { published: false, startsAt: null, endsAt: null }, "draft"],
    [
      "scheduled",
      {
        published: true,
        startsAt: "2026-09-02T00:00:00.000Z",
        endsAt: null,
      },
      "scheduled",
    ],
    [
      "active",
      {
        published: true,
        startsAt: "2026-08-01T00:00:00.000Z",
        endsAt: "2026-09-02T00:00:00.000Z",
      },
      "active",
    ],
    [
      "ended",
      {
        published: true,
        startsAt: "2026-08-01T00:00:00.000Z",
        endsAt: "2026-09-01T00:00:00.000Z",
      },
      "ended",
    ],
  ] as const)("derives the %s lifecycle state", (_, activation, expected) => {
    expect(
      getShopifyRewardLifecycleStatus({
        activation,
        at: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).toBe(expected);
  });

  it("rejects a reward window whose end is not after its start", () => {
    expect(
      ShopifyEcommerceRewardConfigSchema.safeParse(
        config({
          activation: {
            published: true,
            startsAt: "2026-09-02T00:00:00.000Z",
            endsAt: "2026-09-01T00:00:00.000Z",
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("resolves scheduled rewards only inside their order-time window", () => {
    const scheduled = config({
      activation: {
        published: true,
        startsAt: "2026-09-01T00:00:00.000Z",
        endsAt: "2026-10-01T00:00:00.000Z",
      },
    });

    const resolveAt = (occurredAt: string) =>
      resolveShopifyRewardConfigAt({
        rawConfig: scheduled,
        occurredAt: new Date(occurredAt),
        currentEffectiveAt: new Date("2026-08-20T00:00:00.000Z"),
      });

    expect(resolveAt("2026-08-31T23:59:59.999Z")).toBeNull();
    expect(resolveAt("2026-09-01T00:00:00.000Z")).not.toBeNull();
    expect(resolveAt("2026-10-01T00:00:00.000Z")).toBeNull();
  });

  it("does not resolve draft rewards for commission", () => {
    expect(
      resolveShopifyEcommerceCommission({
        rawConfig: config({
          activation: { published: false, startsAt: null, endsAt: null },
        }),
        accountingCurrency: "USD",
        customerContext: { classification: "returning" },
        occurredAt: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("hides inactive Shopify rewards without changing generic Dub rewards", () => {
    const at = new Date("2026-09-01T00:00:00.000Z");

    expect(isRewardAvailableAt({ config: null }, at)).toBe(true);
    expect(
      isRewardAvailableAt(
        {
          config: {
            activation: { published: false, startsAt: null, endsAt: null },
          },
        },
        at,
      ),
    ).toBe(true);
    expect(
      isRewardAvailableAt(
        { config: { type: "shopify_ecommerce", baseReturningRate: 101 } },
        at,
      ),
    ).toBe(false);
    expect(isRewardAvailableAt({ config: config() }, at)).toBe(true);
    expect(
      isRewardAvailableAt(
        {
          config: config({
            activation: { published: false, startsAt: null, endsAt: null },
          }),
        },
        at,
      ),
    ).toBe(false);
    expect(
      isRewardAvailableAt(
        {
          config: config({
            activation: {
              published: true,
              startsAt: "2026-09-02T00:00:00.000Z",
              endsAt: null,
            },
          }),
        },
        at,
      ),
    ).toBe(false);
  });

  it("never resurrects generated Shopify or legacy Sale Reward rules as manual rules", () => {
    expect(
      isExplicitShopifyCommissionRuleKey("shopify-config:reward:base"),
    ).toBe(false);
    expect(
      isExplicitShopifyCommissionRuleKey("dub-sale-reward:reward:modifier"),
    ).toBe(false);
    expect(isExplicitShopifyCommissionRuleKey("manual:partner:vip")).toBe(true);
  });

  it.each([
    ["variantOverrides", "ProductVariant"],
    ["productOverrides", "Product"],
    ["collectionOverrides", "Collection"],
  ] as const)(
    "rejects numeric and GID aliases duplicated in %s",
    (overrideKey, resourceType) => {
      const override = {
        id: "123",
        title: "First",
        returningRate: 10,
      };
      const duplicate = {
        ...override,
        id: `gid://shopify/${resourceType}/123`,
        title: "Duplicate",
      };

      expect(
        ShopifyEcommerceRewardConfigSchema.safeParse(
          config({ [overrideKey]: [override, duplicate] }),
        ).success,
      ).toBe(false);
    },
  );

  it("rejects Shopify entities in generic Sale Reward modifiers", () => {
    expect(
      rewardConditionsArraySchema.safeParse([
        {
          operator: "AND",
          maxDuration: null,
          conditions: [
            {
              entity: "shopify",
              attribute: "product",
              operator: "equals_to",
              value: "gid://shopify/Product/1",
            },
          ],
        },
      ]).success,
    ).toBe(false);
  });

  it("only grants new-customer status from complete lifetime order history", () => {
    const currentOrderId = "gid://shopify/Order/2";
    expect(
      classifyLifetimeShopifyCustomerOrder({
        numberOfOrders: 1,
        visibleOrderIds: [currentOrderId],
        currentOrderId,
      }),
    ).toBe("new");
    expect(
      classifyLifetimeShopifyCustomerOrder({
        numberOfOrders: 2,
        visibleOrderIds: [currentOrderId],
        currentOrderId,
      }),
    ).toBe("returning");
    expect(
      classifyLifetimeShopifyCustomerOrder({
        numberOfOrders: 2,
        visibleOrderIds: [currentOrderId, "gid://shopify/Order/3"],
        currentOrderId,
      }),
    ).toBe("new");
  });

  it("retains the factual customer snapshot during delayed attribution", () => {
    expect(
      retainKnownShopifyCustomerSnapshot({
        sequence: 1,
        classification: "new",
      }),
    ).toEqual({ sequence: 1, classification: "new" });
    expect(
      retainKnownShopifyCustomerSnapshot({
        sequence: 5,
        classification: "unknown",
      }),
    ).toBeNull();
  });

  it("retains the captured group reward after a later replacement", () => {
    const captured = {
      rewardId: "reward_a",
    };
    expect(
      selectCapturedReward({
        snapshot: {
          rewards: [captured],
          groups: [{ groupId: "group_1", rewardId: "reward_a" }],
          enrollmentOverrides: [],
        },
        groupId: "group_1",
      }),
    ).toEqual(captured);
    expect(
      selectCapturedReward({
        snapshot: {
          rewards: [captured],
          groups: [{ groupId: "group_1", rewardId: "reward_a" }],
          enrollmentOverrides: [],
        },
        groupId: "group_2",
      }),
    ).toBeNull();
  });

  it("captures only sparse enrollment-level reward overrides", () => {
    const enrollmentReward = { rewardId: "reward_partner" };
    expect(
      selectCapturedReward({
        snapshot: {
          rewards: [enrollmentReward],
          groups: [{ groupId: "group_1", rewardId: null }],
          enrollmentOverrides: [
            { partnerId: "partner_1", rewardId: "reward_partner" },
          ],
        },
        groupId: "group_1",
        partnerId: "partner_1",
      }),
    ).toEqual(enrollmentReward);
  });

  it("settles delayed attribution with the config effective at order time", () => {
    const historical = config({ baseReturningRate: 10 });
    const current = config({
      baseReturningRate: 20,
      history: [
        {
          effectiveAt: "2026-08-01T00:00:00.000Z",
          config: historical,
        },
        {
          effectiveAt: "2026-08-20T00:00:00.000Z",
          config: config({ baseReturningRate: 20 }),
        },
      ],
    });

    expect(
      resolveShopifyRewardConfigAt({
        rawConfig: current,
        occurredAt: new Date("2026-08-10T00:00:00.000Z"),
        currentEffectiveAt: new Date("2026-08-20T00:00:00.000Z"),
      })?.baseReturningRate,
    ).toBe(10);
  });

  it("uses lifecycle history when a later configuration becomes a draft", () => {
    const historical = config({ baseReturningRate: 10 });
    const currentDraft = config({
      activation: { published: false, startsAt: null, endsAt: null },
    });
    const current = config({
      ...currentDraft,
      history: [
        {
          effectiveAt: "2026-08-01T00:00:00.000Z",
          config: historical,
        },
        {
          effectiveAt: "2026-08-20T00:00:00.000Z",
          config: currentDraft,
        },
      ],
    });

    expect(
      resolveShopifyRewardConfigAt({
        rawConfig: current,
        occurredAt: new Date("2026-08-10T00:00:00.000Z"),
        currentEffectiveAt: new Date("2026-08-20T00:00:00.000Z"),
      })?.baseReturningRate,
    ).toBe(10);
    expect(
      resolveShopifyRewardConfigAt({
        rawConfig: current,
        occurredAt: new Date("2026-08-21T00:00:00.000Z"),
        currentEffectiveAt: new Date("2026-08-20T00:00:00.000Z"),
      }),
    ).toBeNull();
  });

  it("does not resurrect an older manual rule after its replacement expires", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const rules = [
      {
        id: "v1",
        logicalKey: "manual-rule",
        version: 1,
        createdAt,
        expiresAt: null,
      },
      {
        id: "v2",
        logicalKey: "manual-rule",
        version: 2,
        createdAt: new Date("2026-05-01T00:00:00.000Z"),
        expiresAt: new Date("2026-06-01T00:00:00.000Z"),
      },
    ];

    expect(
      selectEffectiveRuleVersions(
        rules,
        new Date("2026-05-15T00:00:00.000Z"),
      ).map(({ id }) => id),
    ).toEqual(["v2"]);
    expect(
      selectEffectiveRuleVersions(rules, new Date("2026-06-02T00:00:00.000Z")),
    ).toEqual([]);
  });

  it("uses one canonical order lock across sale attachment and refunds", () => {
    expect(
      shopifyOrderSettlementLockKey("workspace_1", "gid://shopify/Order/123"),
    ).toBe("weletic:shopify:order:workspace_1:123");
    expect(shopifyOrderSettlementLockKey("workspace_1", 123)).toBe(
      "weletic:shopify:order:workspace_1:123",
    );
  });

  it("uses a scoped selling-plan item series for recurrence", () => {
    expect(
      resolveShopifySubscriptionCycle({
        subscriptionSeriesKey: null,
        priorOrderCount: 4,
      }),
    ).toBe("not_subscription");
    expect(
      resolveShopifySubscriptionCycle({
        subscriptionSeriesKey: "selling-plan:1:item:1",
        priorOrderCount: 0,
      }),
    ).toBe("first");
    expect(
      resolveShopifySubscriptionCycle({
        subscriptionSeriesKey: "selling-plan:1:item:1",
        priorOrderCount: 1,
      }),
    ).toBe("recurring");
  });

  it("retries a refund that arrives before its paid order", () => {
    expect(() => assertRecordedShopifyOrder(null, 123)).toThrow(
      "retry the refund webhook",
    );
  });

  it("upgrades an unattributed factual order exactly once", () => {
    expect(
      resolveOrderAttributionTransition({
        orderExists: false,
        requestedPartnerId: null,
      }),
    ).toBe("create");
    expect(
      resolveOrderAttributionTransition({
        orderExists: true,
        existingPartnerId: null,
        requestedPartnerId: "partner_1",
      }),
    ).toBe("attach");
    expect(
      resolveOrderAttributionTransition({
        orderExists: true,
        existingPartnerId: "partner_1",
        requestedPartnerId: "partner_1",
      }),
    ).toBe("duplicate");
    expect(
      resolveOrderAttributionTransition({
        orderExists: true,
        existingPartnerId: "partner_1",
        requestedPartnerId: "partner_2",
      }),
    ).toBe("conflict");
  });

  it("uses lifetime customer classification and treats unknown guests as returning", () => {
    const rawConfig = config();

    expect(
      resolveShopifyEcommerceCommission({
        rawConfig,
        accountingCurrency: "USD",
        customerContext: { classification: "new" },
      })?.basisPoints,
    ).toBe(2_000);
    expect(
      resolveShopifyEcommerceCommission({
        rawConfig,
        accountingCurrency: "USD",
        customerContext: { classification: "returning" },
      })?.basisPoints,
    ).toBe(1_000);
    expect(
      resolveShopifyEcommerceCommission({
        rawConfig,
        accountingCurrency: "USD",
        customerContext: { classification: "unknown" },
      })?.basisPoints,
    ).toBe(1_000);
  });

  it("selects variant before product and collection and never suffix-matches Shopify IDs", () => {
    const rawConfig = config({
      variantOverrides: [
        {
          id: "gid://shopify/ProductVariant/456",
          title: "Product — Blue / 42",
          returningRate: 50,
          newRate: 60,
        },
      ],
      collectionOverrides: [
        {
          id: "gid://shopify/Collection/77",
          title: "Collection",
          returningRate: 15,
          newRate: 25,
        },
      ],
      productOverrides: [
        {
          id: "gid://shopify/Product/123",
          title: "Product",
          returningRate: 30,
          newRate: 40,
        },
      ],
    });

    const exactVariant = resolveShopifyEcommerceCommission({
      rawConfig,
      accountingCurrency: "USD",
      productContext: {
        productExternalId: "123",
        variantExternalId: "456",
        collectionExternalIds: ["77"],
      },
      customerContext: { classification: "returning" },
    });
    expect(exactVariant).toMatchObject({
      source: "variant",
      specificity: 4,
      basisPoints: 5_000,
    });

    const exactProduct = resolveShopifyEcommerceCommission({
      rawConfig,
      accountingCurrency: "USD",
      productContext: {
        productExternalId: "123",
        collectionExternalIds: ["77"],
      },
      customerContext: { classification: "returning" },
    });
    expect(exactProduct).toMatchObject({
      source: "product",
      basisPoints: 3_000,
    });

    const suffixCollision = resolveShopifyEcommerceCommission({
      rawConfig,
      accountingCurrency: "USD",
      productContext: {
        productExternalId: "gid://shopify/Product/99123",
        collectionExternalIds: ["gid://shopify/Collection/77"],
      },
      customerContext: { classification: "returning" },
    });
    expect(suffixCollision).toMatchObject({
      source: "collection",
      basisPoints: 1_500,
    });
    expect(
      sameShopifyId(
        "Product",
        "gid://shopify/Product/123",
        "gid://shopify/Product/99123",
      ),
    ).toBe(false);
  });

  it("applies selected Shopify segment rates, including scope overrides", () => {
    const rawConfig = config({
      customerSegmentMode: "shopify_segment",
      shopifySegment: {
        id: "gid://shopify/Segment/9",
        name: "VIP",
        rate: 22,
      },
      productOverrides: [
        {
          id: "gid://shopify/Product/123",
          title: "Product",
          returningRate: 30,
          segmentRate: 45,
        },
      ],
    });

    expect(
      resolveShopifyEcommerceCommission({
        rawConfig,
        accountingCurrency: "USD",
        productContext: { productExternalId: "123" },
        customerContext: {
          classification: "returning",
          segmentIds: ["9"],
        },
      }),
    ).toMatchObject({
      source: "product",
      basisPoints: 4_500,
      matchedSegmentId: "gid://shopify/Segment/9",
    });

    expect(
      resolveShopifyEcommerceCommission({
        rawConfig,
        accountingCurrency: "USD",
        customerContext: {
          classification: "returning",
          segmentIds: [],
        },
      })?.basisPoints,
    ).toBe(1_000);
  });

  it("normalizes the unreleased boolean subscription config", () => {
    const parsed = ShopifyEcommerceRewardConfigSchema.parse({
      ...config(),
      subscriptionRules: { firstSaleOnly: false, recurringRate: 7.5 },
    });

    expect(parsed.subscriptionRules).toEqual({
      mode: "every_recurring_order",
      recurringOrderCount: null,
    });
  });

  it("supports first-sale-only subscription commission", () => {
    const recurring = resolveShopifyEcommerceCommission({
      rawConfig: config(),
      accountingCurrency: "USD",
      customerContext: { classification: "returning" },
      subscriptionContext: {
        sellingPlanId: "gid://shopify/SellingPlan/5",
        sequence: 2,
        cycle: "recurring",
      },
    });
    expect(recurring).toMatchObject({
      source: "subscription",
      basisPoints: 0,
      subscriptionCycle: "recurring",
    });
  });

  it("uses the normal new and returning rate matrix on subscription orders", () => {
    const everyOrder = config({
      productOverrides: [
        {
          id: "gid://shopify/Product/8",
          title: "Subscription product",
          returningRate: 15,
          newRate: 25,
        },
      ],
      subscriptionRules: {
        mode: "every_recurring_order",
        recurringOrderCount: null,
      },
    });
    const productContext = {
      productExternalId: "gid://shopify/Product/8",
    };

    const firstOrder = resolveShopifyEcommerceCommission({
      rawConfig: everyOrder,
      accountingCurrency: "USD",
      productContext,
      customerContext: { classification: "new" },
      subscriptionContext: {
        sellingPlanId: "gid://shopify/SellingPlan/5",
        sequence: 1,
        cycle: "first",
      },
    });
    const recurringOrder = resolveShopifyEcommerceCommission({
      rawConfig: everyOrder,
      accountingCurrency: "USD",
      productContext,
      customerContext: { classification: "returning" },
      subscriptionContext: {
        sellingPlanId: "gid://shopify/SellingPlan/5",
        sequence: 4,
        cycle: "recurring",
      },
    });

    expect(firstOrder).toMatchObject({
      source: "product",
      basisPoints: 2_500,
      subscriptionCycle: "first",
    });
    expect(recurringOrder).toMatchObject({
      source: "product",
      basisPoints: 1_500,
      subscriptionCycle: "recurring",
    });
  });

  it("stops commission after the configured number of recurring orders", () => {
    const limited = config({
      subscriptionRules: {
        mode: "limited_recurring_orders",
        recurringOrderCount: 2,
      },
    });

    const resolveSequence = (sequence: number | null) =>
      resolveShopifyEcommerceCommission({
        rawConfig: limited,
        accountingCurrency: "USD",
        customerContext: { classification: "returning" },
        subscriptionContext: {
          sellingPlanId: "gid://shopify/SellingPlan/5",
          sequence,
          cycle: "recurring",
        },
      });

    expect(resolveSequence(2)).toMatchObject({
      source: "default_group",
      basisPoints: 1_000,
    });
    expect(resolveSequence(3)).toMatchObject({
      source: "default_group",
      basisPoints: 1_000,
    });
    expect(resolveSequence(4)).toMatchObject({
      source: "subscription",
      basisPoints: 0,
    });
    expect(resolveSequence(null)).toMatchObject({
      source: "subscription",
      basisPoints: 0,
    });
  });

  it("fails closed when a selling-plan category is unknown", () => {
    expect(
      resolveShopifyEcommerceCommission({
        rawConfig: config(),
        accountingCurrency: "USD",
        customerContext: { classification: "returning" },
        subscriptionContext: {
          sellingPlanId: "gid://shopify/SellingPlan/5",
          sequence: null,
          cycle: "unknown",
        },
      }),
    ).toBeNull();
  });

  it("converts flat major-unit configuration into integer minor units", () => {
    const resolved = resolveShopifyEcommerceCommission({
      rawConfig: config({
        baseRateType: "flat",
        baseReturningRate: 12.34,
      }),
      accountingCurrency: "USD",
      customerContext: { classification: "returning" },
    });

    expect(resolved).toMatchObject({
      type: "fixed",
      basisPoints: null,
      fixedAmount: BigInt(1_234),
    });

    expect(
      resolveShopifyEcommerceCommission({
        rawConfig: config({
          baseRateType: "flat",
          baseReturningRate: 12.6,
        }),
        accountingCurrency: "JPY",
        customerContext: { classification: "returning" },
      })?.fixedAmount,
    ).toBe(BigInt(13));
    expect(
      resolveShopifyEcommerceCommission({
        rawConfig: config({
          baseRateType: "flat",
          baseReturningRate: 1.234,
        }),
        accountingCurrency: "BHD",
        customerContext: { classification: "returning" },
      })?.fixedAmount,
    ).toBe(BigInt(1_234));
  });
});
