import { describe, expect, it } from "vitest";
import {
  rewardCatalogFieldsSchema,
  rewardCatalogWriteSchema,
  type RewardCatalogFields,
} from "../../lib/weletic/loyalty/reward-catalog-contract";

const amount: RewardCatalogFields = {
  name: "Order discount",
  description: null,
  rewardType: "amount_off",
  salesChannel: "online_store",
  exchangeType: "fixed",
  pointsCost: "100",
  pointsStep: null,
  minPointsCost: null,
  maxPointsCost: null,
  discountValue: "1",
  maxDiscountValue: null,
  minOrderAmount: null,
  appliesToResource: "entire_order",
  entitledProductIds: [],
  entitledVariantIds: [],
  entitledCollectionIds: [],
  combinesWithOrderDiscounts: false,
  combinesWithProductDiscounts: false,
  combinesWithShippingDiscounts: false,
  usageLimit: 1,
  usageLimitPerCustomer: 1,
  expiresInDays: null,
  status: "inactive",
};
const parse = (patch: Record<string, unknown>) =>
  rewardCatalogFieldsSchema.safeParse({ ...amount, ...patch });

describe("new reward catalog exact contract", () => {
  it("retains one minor unit per 100 points and signed BigInt bounds", () => {
    expect(parse({}).data).toEqual(amount);
    expect(parse({ pointsCost: "9223372036854775807" }).success).toBe(true);
    expect(parse({ pointsCost: "9223372036854775808" }).success).toBe(false);
  });
  it.each([
    0,
    100,
    true,
    null,
    "",
    "0",
    "-1",
    "1.1",
    "1e3",
    "01",
    "0xFF",
    " 100",
    "9".repeat(100),
  ])("rejects noncanonical points %j", (pointsCost) => {
    expect(parse({ pointsCost }).success).toBe(false);
  });
  it.each(["0", "1.01", "1.00", "100000000", "1e6", "01", "-1", 100])(
    "rejects invalid minor-unit amount %j",
    (discountValue) => {
      expect(parse({ discountValue }).success).toBe(false);
    },
  );
  it("retains the full existing money column range without float conversion", () => {
    expect(parse({ discountValue: "99999999" }).data?.discountValue).toBe(
      "99999999",
    );
  });
  it.each(["1", "1.01", "99.99", "100", "100.00"])(
    "allows supported percentages %s",
    (discountValue) => {
      expect(
        parse({ rewardType: "percentage_off", discountValue }).success,
      ).toBe(true);
    },
  );
  it.each(["0.99", "100.01", "1.001", null])(
    "rejects unsupported percentages %j",
    (discountValue) => {
      expect(
        parse({ rewardType: "percentage_off", discountValue }).success,
      ).toBe(false);
    },
  );
  const incremental = {
    exchangeType: "incremental",
    pointsStep: "100",
    minPointsCost: "200",
    maxPointsCost: "9007199254741000",
  };
  it("validates very large incremental limits with integer arithmetic", () => {
    expect(parse(incremental).success).toBe(true);
    expect(parse({ ...incremental, maxDiscountValue: "500" }).success).toBe(
      true,
    );
    expect(parse({ maxDiscountValue: "500" }).success).toBe(false);
    expect(
      parse({ ...incremental, maxPointsCost: "9007199254741001" }).success,
    ).toBe(false);
  });
  it.each([
    { pointsStep: "0" },
    { pointsStep: "invalid" },
    { pointsStep: null },
    { minPointsCost: null },
    { minPointsCost: "201" },
    { maxPointsCost: "100" },
    { rewardType: "percentage_off" },
  ])("rejects incompatible incremental fields without throwing %j", (patch) => {
    expect(parse({ ...incremental, ...patch }).success).toBe(false);
  });
  it("rejects ignored fixed-reward limits and unknown capabilities", () => {
    expect(parse({ pointsStep: "100" }).success).toBe(false);
    expect(parse({ purchaseType: "subscription" }).success).toBe(false);
    expect(parse({ salesChannel: "pos" }).success).toBe(false);
  });
  it("requires an explicit product cap and scope", () => {
    const product = {
      rewardType: "free_product",
      discountValue: null,
      maxDiscountValue: "500",
      appliesToResource: "specific_items",
      entitledProductIds: ["gid://shopify/Product/123"],
    };
    expect(parse(product).success).toBe(true);
    expect(parse({ ...product, maxDiscountValue: null }).success).toBe(false);
    expect(
      parse({ ...product, appliesToResource: "entire_order" }).success,
    ).toBe(false);
    expect(
      parse({
        ...product,
        entitledProductIds: [],
        entitledCollectionIds: ["gid://shopify/Collection/123"],
      }).success,
    ).toBe(false);
  });
  it("keeps collection and product scopes mutually exclusive", () => {
    const scoped = {
      appliesToResource: "specific_items",
      entitledCollectionIds: ["gid://shopify/Collection/123"],
    };
    expect(parse(scoped).success).toBe(true);
    expect(
      parse({ ...scoped, entitledProductIds: ["gid://shopify/Product/123"] })
        .success,
    ).toBe(false);
    expect(
      parse({ ...scoped, appliesToResource: "entire_order" }).success,
    ).toBe(false);
    expect(parse({ appliesToResource: "specific_items" }).success).toBe(false);
  });
  it.each([
    { entitledProductIds: ["123"] },
    { entitledProductIds: ["gid://shopify/Collection/123"] },
    { entitledProductIds: ["gid://shopify/Product/0"] },
    { entitledProductIds: ["gid://shopify/Product/01"] },
    {
      entitledProductIds: [
        "gid://shopify/Product/123",
        "gid://shopify/Product/123",
      ],
    },
  ])(
    "rejects noncanonical or duplicate product IDs %j",
    ({ entitledProductIds }) => {
      expect(
        parse({ appliesToResource: "specific_items", entitledProductIds })
          .success,
      ).toBe(false);
    },
  );
  it("caps each identifier list at 100", () => {
    const entitledProductIds = Array.from(
      { length: 101 },
      (_, index) => `gid://shopify/Product/${index + 1}`,
    );
    expect(
      parse({
        appliesToResource: "specific_items",
        entitledProductIds: entitledProductIds.slice(0, 100),
      }).success,
    ).toBe(true);
    expect(
      parse({ appliesToResource: "specific_items", entitledProductIds })
        .success,
    ).toBe(false);
  });
  it.each(["gift_card", "store_credit"])(
    "does not silently ignore code conditions for %s",
    (rewardType) => {
      const financial = {
        rewardType,
        usageLimit: null,
        usageLimitPerCustomer: 0,
      };
      expect(parse(financial).success).toBe(true);
      expect(
        parse({ ...financial, combinesWithOrderDiscounts: true }).success,
      ).toBe(false);
      expect(parse({ ...financial, minOrderAmount: "100" }).success).toBe(
        false,
      );
      expect(parse({ ...financial, usageLimit: 2 }).success).toBe(false);
      expect(parse({ ...financial, usageLimitPerCustomer: 1 }).success).toBe(
        false,
      );
    },
  );
  it("limits shipping fields to those actually fulfilled", () => {
    expect(
      parse({ rewardType: "free_shipping", discountValue: null }).success,
    ).toBe(true);
    expect(parse({ rewardType: "free_shipping" }).success).toBe(false);
    expect(
      parse({
        rewardType: "free_shipping",
        discountValue: null,
        maxDiscountValue: "100",
      }).success,
    ).toBe(false);
  });
  it.each([0, -1, 1.5, 2147483648, "1", true])(
    "rejects invalid integer limits %j",
    (usageLimit) => {
      expect(parse({ usageLimit }).success).toBe(false);
    },
  );
  it("bounds labels and requires explicit ownership-free writes", () => {
    expect(parse({ expiresInDays: 36500 }).success).toBe(true);
    expect(parse({ expiresInDays: 36501 }).success).toBe(false);
    expect(parse({ name: "a".repeat(192) }).success).toBe(false);
    expect(parse({ name: "bad\nname" }).success).toBe(false);
    expect(parse({ description: "a".repeat(192) }).success).toBe(false);
    const input = {
      expectedInstallationGeneration: "generation",
      expectedRevision: "a".repeat(64),
      rewardId: null,
      reward: amount,
    };
    expect(rewardCatalogWriteSchema.safeParse(input).success).toBe(true);
    expect(
      rewardCatalogWriteSchema.safeParse({ ...input, storeId: "other-store" })
        .success,
    ).toBe(false);
    expect(
      rewardCatalogWriteSchema.safeParse({ ...input, expectedRevision: null })
        .success,
    ).toBe(false);
  });
});
