import {
  retargetShopifyRewardOverrideDraft,
  serializeShopifyEcommerceRewardDraft,
  ShopifyEcommerceRewardDraft,
  validateShopifyEcommerceRewardDraft,
} from "@/lib/weletic/commissions/shopify-reward-form";
import { ShopifyEcommerceRewardConfig } from "@/lib/zod/schemas/shopify-ecommerce-reward";
import { describe, expect, it } from "vitest";

const fallbackConfig: ShopifyEcommerceRewardConfig = {
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
};

const createDraft = (
  overrides: Partial<ShopifyEcommerceRewardDraft> = {},
): ShopifyEcommerceRewardDraft => ({
  lifecycleMode: "active",
  startsAt: "",
  endsAt: "",
  customerSegmentMode: "new_vs_returning",
  baseRateType: "percentage",
  baseReturningRate: "10",
  baseNewRate: "20",
  shopifySegment: null,
  collectionOverrides: [],
  productOverrides: [],
  variantOverrides: [],
  subscriptionMode: "first_sale",
  recurringOrderCount: "1",
  ...overrides,
});

describe("Shopify eCommerce reward form", () => {
  it.each([
    ["draft", { published: false, startsAt: null, endsAt: null }],
    ["active", { published: true, startsAt: null, endsAt: null }],
  ] as const)(
    "serializes the %s lifecycle mode",
    (lifecycleMode, activation) => {
      const config = serializeShopifyEcommerceRewardDraft({
        draft: createDraft({ lifecycleMode }),
        fallbackConfig,
      });

      expect(config?.activation).toEqual(activation);
    },
  );

  it("serializes a scheduled reward window as ISO timestamps", () => {
    const config = serializeShopifyEcommerceRewardDraft({
      draft: createDraft({
        lifecycleMode: "scheduled",
        startsAt: "2026-09-01T09:00",
        endsAt: "2026-09-30T18:00",
      }),
      fallbackConfig,
    });

    expect(config?.activation).toEqual({
      published: true,
      startsAt: new Date("2026-09-01T09:00").toISOString(),
      endsAt: new Date("2026-09-30T18:00").toISOString(),
    });
  });

  it("allows an open-ended schedule", () => {
    const config = serializeShopifyEcommerceRewardDraft({
      draft: createDraft({
        lifecycleMode: "scheduled",
        startsAt: "2026-09-01T09:00",
        endsAt: "",
      }),
      fallbackConfig,
    });

    expect(config?.activation.endsAt).toBeNull();
  });

  it.each([
    ["missing start", "", ""],
    ["invalid end", "2026-09-02T09:00", "not-a-date"],
    ["end before start", "2026-09-02T09:00", "2026-09-01T09:00"],
  ])("rejects a scheduled lifecycle with %s", (_, startsAt, endsAt) => {
    const draft = createDraft({
      lifecycleMode: "scheduled",
      startsAt,
      endsAt,
    });

    expect(validateShopifyEcommerceRewardDraft(draft).lifecycleValid).toBe(
      false,
    );
    expect(
      serializeShopifyEcommerceRewardDraft({ draft, fallbackConfig }),
    ).toBeNull();
  });

  it("serializes the all-customer mode without coercing a hidden blank new-customer rate to zero", () => {
    const config = serializeShopifyEcommerceRewardDraft({
      draft: createDraft({
        customerSegmentMode: "none",
        baseReturningRate: "12.5",
        baseNewRate: "",
      }),
      fallbackConfig,
    });

    expect(config).toMatchObject({
      customerSegmentMode: "none",
      baseReturningRate: 12.5,
      baseNewRate: 20,
      shopifySegment: null,
    });
  });

  it("serializes distinct new and returning customer rates", () => {
    const config = serializeShopifyEcommerceRewardDraft({
      draft: createDraft({
        baseReturningRate: "8.5",
        baseNewRate: "24",
      }),
      fallbackConfig,
    });

    expect(config).toMatchObject({
      customerSegmentMode: "new_vs_returning",
      baseReturningRate: 8.5,
      baseNewRate: 24,
    });
  });

  it("preserves flat-rate mode in the configuration payload", () => {
    const config = serializeShopifyEcommerceRewardDraft({
      draft: createDraft({
        baseRateType: "flat",
        baseReturningRate: "7.5",
        baseNewRate: "12",
      }),
      fallbackConfig,
    });

    expect(config).toMatchObject({
      baseRateType: "flat",
      baseReturningRate: 7.5,
      baseNewRate: 12,
    });
  });

  it("requires and serializes a Shopify segment and its member rate", () => {
    const invalidDraft = createDraft({
      customerSegmentMode: "shopify_segment",
    });
    expect(validateShopifyEcommerceRewardDraft(invalidDraft).valid).toBe(false);

    const config = serializeShopifyEcommerceRewardDraft({
      draft: {
        ...invalidDraft,
        shopifySegment: {
          id: "gid://shopify/Segment/1",
          name: "VIP",
          rate: "30",
        },
      },
      fallbackConfig,
    });

    expect(config?.shopifySegment).toEqual({
      id: "gid://shopify/Segment/1",
      name: "VIP",
      rate: 30,
    });
  });

  it("preserves variant, product, and collection overrides while parsing editable rate drafts", () => {
    const config = serializeShopifyEcommerceRewardDraft({
      draft: createDraft({
        variantOverrides: [
          {
            id: "gid://shopify/ProductVariant/1",
            title: "Running Shoes — Blue / 42",
            returningRate: "18",
            newRate: "28",
          },
        ],
        productOverrides: [
          {
            id: "gid://shopify/Product/1",
            title: "Running Shoes",
            returningRate: "15",
            newRate: "25",
          },
        ],
        collectionOverrides: [
          {
            id: "gid://shopify/Collection/1",
            title: "Footwear",
            returningRate: "12",
            newRate: "22",
          },
        ],
      }),
      fallbackConfig,
    });

    expect(config?.variantOverrides[0]).toMatchObject({
      title: "Running Shoes — Blue / 42",
      returningRate: 18,
      newRate: 28,
    });
    expect(config?.productOverrides[0]).toMatchObject({
      title: "Running Shoes",
      returningRate: 15,
      newRate: 25,
    });
    expect(config?.collectionOverrides[0]).toMatchObject({
      title: "Footwear",
      returningRate: 12,
      newRate: 22,
    });
  });

  it("serializes override edits and removals without changing precedence order", () => {
    const draft = createDraft({
      productOverrides: [
        {
          id: "gid://shopify/Product/1",
          title: "Running Shoes",
          returningRate: "16",
          newRate: "26",
        },
      ],
      collectionOverrides: [],
    });
    const config = serializeShopifyEcommerceRewardDraft({
      draft,
      fallbackConfig,
    });

    expect(config?.productOverrides).toEqual([
      expect.objectContaining({
        id: "gid://shopify/Product/1",
        returningRate: 16,
        newRate: 26,
      }),
    ]);
    expect(config?.collectionOverrides).toEqual([]);
  });

  it("preserves commission rates when a product condition becomes a collection condition", () => {
    const converted = retargetShopifyRewardOverrideDraft({
      override: {
        id: "gid://shopify/Product/1",
        title: "Running Shoes",
        image: "https://example.com/shoes.jpg",
        returningRate: "16",
        newRate: "26",
        segmentRate: "31",
      },
      scope: "collection",
      target: {
        id: "gid://shopify/Collection/1",
        title: "Footwear",
      },
    });

    expect(converted).toEqual({
      id: "gid://shopify/Collection/1",
      title: "Footwear",
      returningRate: "16",
      newRate: "26",
      segmentRate: "31",
    });
    expect(converted).not.toHaveProperty("image");
  });

  it("creates a product-shaped condition when a collection condition becomes a product condition", () => {
    const converted = retargetShopifyRewardOverrideDraft({
      override: {
        id: "gid://shopify/Collection/1",
        title: "Footwear",
        returningRate: "12",
        newRate: "22",
      },
      scope: "product",
      target: {
        id: "gid://shopify/Product/2",
        title: "Trail Shoes",
      },
    });

    expect(converted).toEqual({
      id: "gid://shopify/Product/2",
      title: "Trail Shoes",
      image: null,
      returningRate: "12",
      newRate: "22",
    });
  });

  it("preserves rates when a product condition becomes a variant condition", () => {
    const converted = retargetShopifyRewardOverrideDraft({
      override: {
        id: "gid://shopify/Product/2",
        title: "Trail Shoes",
        image: null,
        returningRate: "14",
        newRate: "24",
      },
      scope: "variant",
      target: {
        id: "gid://shopify/ProductVariant/22",
        title: "Trail Shoes — Green / 42",
      },
    });

    expect(converted).toEqual({
      id: "gid://shopify/ProductVariant/22",
      title: "Trail Shoes — Green / 42",
      returningRate: "14",
      newRate: "24",
    });
    expect(converted).not.toHaveProperty("image");
  });

  it("preserves collection order because the first matching collection wins", () => {
    const config = serializeShopifyEcommerceRewardDraft({
      draft: createDraft({
        collectionOverrides: [
          {
            id: "gid://shopify/Collection/priority",
            title: "Priority collection",
            returningRate: "18",
            newRate: "28",
          },
          {
            id: "gid://shopify/Collection/fallback",
            title: "Fallback collection",
            returningRate: "12",
            newRate: "22",
          },
        ],
      }),
      fallbackConfig,
    });

    expect(config?.collectionOverrides.map(({ id }) => id)).toEqual([
      "gid://shopify/Collection/priority",
      "gid://shopify/Collection/fallback",
    ]);
  });

  it.each(["first_sale", "every_recurring_order"] as const)(
    "stores a null recurring count for %s mode",
    (subscriptionMode) => {
      const config = serializeShopifyEcommerceRewardDraft({
        draft: createDraft({ subscriptionMode, recurringOrderCount: "99" }),
        fallbackConfig,
      });

      expect(config?.subscriptionRules).toEqual({
        mode: subscriptionMode,
        recurringOrderCount: null,
      });
    },
  );

  it("stores the renewal limit for limited recurring commission", () => {
    const config = serializeShopifyEcommerceRewardDraft({
      draft: createDraft({
        subscriptionMode: "limited_recurring_orders",
        recurringOrderCount: "3",
      }),
      fallbackConfig,
    });

    expect(config?.subscriptionRules).toEqual({
      mode: "limited_recurring_orders",
      recurringOrderCount: 3,
    });
  });

  it.each(["", "-1", "101", "not-a-number"])(
    "rejects invalid visible rates without silently coercing %s",
    (invalidValue) => {
      const rateDraft = createDraft({ baseReturningRate: invalidValue });
      expect(validateShopifyEcommerceRewardDraft(rateDraft).valid).toBe(false);
      expect(
        serializeShopifyEcommerceRewardDraft({
          draft: rateDraft,
          fallbackConfig,
        }),
      ).toBeNull();
    },
  );

  it.each(["", "0", "1.5", "not-a-number"])(
    "rejects an invalid limited recurring-order count of %s",
    (invalidValue) => {
      const countDraft = createDraft({
        subscriptionMode: "limited_recurring_orders",
        recurringOrderCount: invalidValue,
      });
      expect(validateShopifyEcommerceRewardDraft(countDraft).valid).toBe(false);
    },
  );
});
