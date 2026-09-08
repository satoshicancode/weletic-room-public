import { describe, expect, it } from "vitest";
import {
  classifyLoyaltyPurchaseLine,
  getEligibleLoyaltyOrderSubtotal,
  getExpectedShopifyDiscountPurchaseConfiguration,
  getShopifyDiscountPurchaseFields,
  isLoyaltyPurchaseLineEligible,
  loyaltyPurchasePolicySchema,
} from "../../lib/weletic/loyalty/purchase-policy";

const oneTimeLine = {};
const subscriptionLine = (sequence: number) => ({
  sellingPlanId: "gid://shopify/SellingPlan/1",
  subscriptionSeriesKey: "series-a",
  subscriptionSequence: sequence,
});

describe("loyalty purchase policy", () => {
  it("fails closed when subscription identity is incomplete", () => {
    expect(classifyLoyaltyPurchaseLine(oneTimeLine)).toEqual({
      kind: "one_time",
    });
    expect(classifyLoyaltyPurchaseLine(subscriptionLine(2))).toEqual({
      kind: "subscription",
      sequence: 2,
    });
    expect(
      classifyLoyaltyPurchaseLine({
        sellingPlanId: "gid://shopify/SellingPlan/1",
      }),
    ).toEqual({ kind: "unknown" });
    expect(
      classifyLoyaltyPurchaseLine({
        subscriptionSeriesKey: "series-a",
        subscriptionSequence: 1,
      }),
    ).toEqual({ kind: "unknown" });
  });

  it("supports one-time, first, first-N, and every subscription payment", () => {
    const firstThree = loyaltyPurchasePolicySchema.parse({
      purchaseType: "both",
      subscriptionCadence: "first_n_payments",
      subscriptionPaymentLimit: 3,
    });
    expect(
      isLoyaltyPurchaseLineEligible({ policy: firstThree, line: oneTimeLine }),
    ).toBe(true);
    expect(
      isLoyaltyPurchaseLineEligible({
        policy: firstThree,
        line: subscriptionLine(3),
      }),
    ).toBe(true);
    expect(
      isLoyaltyPurchaseLineEligible({
        policy: firstThree,
        line: subscriptionLine(4),
      }),
    ).toBe(false);
  });

  it("maps exact native Shopify discount semantics", () => {
    expect(
      getShopifyDiscountPurchaseFields({
        purchaseType: "one_time",
        subscriptionCadence: "first_payment",
        subscriptionPaymentLimit: null,
      }),
    ).toEqual({});
    const subscription = {
      purchaseType: "subscription" as const,
      subscriptionCadence: "every_payment" as const,
      subscriptionPaymentLimit: null,
    };
    expect(getShopifyDiscountPurchaseFields(subscription)).toEqual({
      appliesOnOneTimePurchase: false,
      appliesOnSubscription: true,
      recurringCycleLimit: 0,
    });
    expect(
      getExpectedShopifyDiscountPurchaseConfiguration(subscription),
    ).toEqual({
      appliesOnOneTimePurchase: false,
      appliesOnSubscription: true,
      recurringCycleLimit: 0,
    });
  });

  it("uses only tenant-bound eligible immutable order lines", async () => {
    const findMany = async () => [
      { ...oneTimeLine, shopNet: BigInt(500) },
      { ...subscriptionLine(1), shopNet: BigInt(700) },
      { ...subscriptionLine(2), shopNet: BigInt(900) },
      {
        sellingPlanId: "gid://shopify/SellingPlan/1",
        shopNet: BigInt(1_100),
      },
    ];
    const subtotal = await getEligibleLoyaltyOrderSubtotal({
      tx: { weleticCommerceOrderLine: { findMany } } as never,
      storeId: "store-a",
      orderId: "order-a",
      policy: {
        purchaseType: "both",
        subscriptionCadence: "first_payment",
        subscriptionPaymentLimit: null,
      },
      testFallbackSubtotal: BigInt(0),
    });
    expect(subtotal).toBe(BigInt(1_200));
  });
});
