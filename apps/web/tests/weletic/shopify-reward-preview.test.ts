import {
  previewShopifyEcommerceReward,
  type ShopifyRewardPreviewLineInput,
} from "@/lib/weletic/commissions/shopify-reward-preview";
import type { ShopifyEcommerceRewardConfig } from "@/lib/zod/schemas/shopify-ecommerce-reward";
import { describe, expect, it } from "vitest";

const config = (
  overrides: Partial<ShopifyEcommerceRewardConfig> = {},
): ShopifyEcommerceRewardConfig => ({
  type: "shopify_ecommerce",
  activation: { published: false, startsAt: null, endsAt: null },
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

const line = (
  overrides: Partial<ShopifyRewardPreviewLineInput> = {},
): ShopifyRewardPreviewLineInput => ({
  key: "line-1",
  title: "Standard product",
  productExternalId: "gid://shopify/Product/1",
  variantExternalId: "gid://shopify/ProductVariant/1",
  collectionExternalIds: [],
  unitAmount: BigInt(10_000),
  quantity: 1,
  ...overrides,
});

describe("Shopify reward side-effect-free preview", () => {
  it("explains a mixed cart using variant, product, collection, and base precedence", () => {
    const result = previewShopifyEcommerceReward({
      rawConfig: config({
        variantOverrides: [
          {
            id: "gid://shopify/ProductVariant/11",
            title: "Blue variant",
            returningRate: 40,
            newRate: 45,
          },
        ],
        productOverrides: [
          {
            id: "gid://shopify/Product/2",
            title: "Product two",
            returningRate: 30,
            newRate: 35,
          },
        ],
        collectionOverrides: [
          {
            id: "gid://shopify/Collection/3",
            title: "Collection three",
            returningRate: 20,
            newRate: 25,
          },
        ],
      }),
      accountingCurrency: "USD",
      customer: "returning",
      order: { kind: "one_time" },
      lines: [
        line({
          key: "variant",
          title: "Variant",
          variantExternalId: "11",
          productExternalId: "gid://shopify/Product/2",
          collectionExternalIds: ["gid://shopify/Collection/3"],
        }),
        line({
          key: "product",
          title: "Product",
          variantExternalId: "12",
          productExternalId: "2",
          collectionExternalIds: ["gid://shopify/Collection/3"],
        }),
        line({
          key: "collection",
          title: "Collection",
          variantExternalId: "13",
          productExternalId: "3",
          collectionExternalIds: ["3"],
        }),
        line({
          key: "base",
          title: "Base",
          variantExternalId: "14",
          productExternalId: "4",
        }),
      ],
    });

    expect(
      result?.lines.map(({ source, commission }) => [source, commission]),
    ).toEqual([
      ["variant", BigInt(4_000)],
      ["product", BigInt(3_000)],
      ["collection", BigInt(2_000)],
      ["default_group", BigInt(1_000)],
    ]);
    expect(result?.totalCommission).toBe(BigInt(10_000));
  });

  it("switches rates for new customers and Shopify segment members", () => {
    const newCustomer = previewShopifyEcommerceReward({
      rawConfig: config(),
      accountingCurrency: "USD",
      customer: "new",
      order: { kind: "one_time" },
      lines: [line()],
    });
    const segmentMember = previewShopifyEcommerceReward({
      rawConfig: config({
        customerSegmentMode: "shopify_segment",
        baseNewRate: 10,
        shopifySegment: {
          id: "gid://shopify/Segment/8",
          name: "VIP",
          rate: 25,
        },
      }),
      accountingCurrency: "USD",
      customer: "segment_member",
      order: { kind: "one_time" },
      lines: [line()],
    });

    expect(newCustomer?.totalCommission).toBe(BigInt(2_000));
    expect(segmentMember?.totalCommission).toBe(BigInt(2_500));
  });

  it("previews first sales and the configured number of renewals", () => {
    const limited = config({
      subscriptionRules: {
        mode: "limited_recurring_orders",
        recurringOrderCount: 2,
      },
    });
    const preview = (
      order: Parameters<typeof previewShopifyEcommerceReward>[0]["order"],
    ) =>
      previewShopifyEcommerceReward({
        rawConfig: limited,
        accountingCurrency: "USD",
        customer: "returning",
        order,
        lines: [line()],
      });

    expect(preview({ kind: "first_subscription" })?.totalCommission).toBe(
      BigInt(1_000),
    );
    expect(
      preview({ kind: "renewal", renewalNumber: 2 })?.totalCommission,
    ).toBe(BigInt(1_000));
    expect(
      preview({ kind: "renewal", renewalNumber: 3 })?.lines[0],
    ).toMatchObject({
      source: "subscription",
      commission: BigInt(0),
    });
  });

  it("allocates each flat rule once across its matching line items", () => {
    const result = previewShopifyEcommerceReward({
      rawConfig: config({
        baseRateType: "flat",
        baseReturningRate: 10,
        baseNewRate: 10,
        productOverrides: [
          {
            id: "gid://shopify/Product/2",
            title: "Product two",
            returningRate: 5,
            newRate: 5,
          },
        ],
      }),
      accountingCurrency: "USD",
      customer: "returning",
      order: { kind: "one_time" },
      lines: [
        line({ key: "base-1", unitAmount: BigInt(3_000) }),
        line({
          key: "base-2",
          productExternalId: "gid://shopify/Product/3",
          unitAmount: BigInt(7_000),
        }),
        line({
          key: "override",
          productExternalId: "gid://shopify/Product/2",
          unitAmount: BigInt(2_000),
        }),
      ],
    });

    expect(result?.lines.map(({ commission }) => commission)).toEqual([
      BigInt(300),
      BigInt(700),
      BigInt(500),
    ]);
    expect(result?.totalCommission).toBe(BigInt(1_500));
  });

  it("rejects invalid quantities and renewal numbers without writing state", () => {
    expect(
      previewShopifyEcommerceReward({
        rawConfig: config(),
        accountingCurrency: "USD",
        customer: "returning",
        order: { kind: "renewal", renewalNumber: 0 },
        lines: [line()],
      }),
    ).toBeNull();
    expect(
      previewShopifyEcommerceReward({
        rawConfig: config(),
        accountingCurrency: "USD",
        customer: "returning",
        order: { kind: "one_time" },
        lines: [line({ quantity: 0 })],
      }),
    ).toBeNull();
  });
});
