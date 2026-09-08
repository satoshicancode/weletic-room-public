import {
  assertAccountBackedReward,
  assertRewardAccountRelation,
  shopperRewardOwnershipWhere,
} from "@/lib/weletic/loyalty/reward-ownership";
import { describe, expect, it } from "vitest";

describe("reward ownership boundaries", () => {
  it("retains legacy account ownership without reclassifying historical sources", () => {
    expect(() =>
      assertAccountBackedReward({ accountId: "account-1" }),
    ).not.toThrow();
    expect(() =>
      assertAccountBackedReward({
        accountId: "account-1",
        fulfillmentSource: null,
      }),
    ).not.toThrow();
  });
  it.each([null, ""])(
    "rejects missing account %s before points operations",
    (accountId) => {
      expect(() => assertAccountBackedReward({ accountId })).toThrow(
        "direct shopper fulfillment",
      );
    },
  );
  it("does not treat a malformed direct award with an account as an exchange", () => {
    expect(() =>
      assertAccountBackedReward({
        accountId: "account-1",
        fulfillmentSource: "review_incentive_v1",
      }),
    ).toThrow();
    expect(() => assertRewardAccountRelation({ account: null })).toThrow(
      "points operations are forbidden",
    );
  });
  it("requires a zero-point, shopper-owned coupon and a source reference", () => {
    expect(
      shopperRewardOwnershipWhere({
        storeId: "s",
        shopperId: "p",
        accountId: null,
      }),
    ).toEqual({
      storeId: "s",
      OR: [
        {
          accountId: null,
          shopperId: "p",
          shopper: { storeId: "s", id: "p" },
          fulfillmentSource: "review_incentive_v1",
          fulfillmentReference: { not: null },
          pointsSpent: BigInt(0),
          ledgerEntryId: null,
          artifactKind: "discount_code",
        },
      ],
    });
  });
  it("fences account and shopper identity independently for legacy reads", () => {
    expect(
      shopperRewardOwnershipWhere({
        storeId: "s",
        shopperId: "p",
        accountId: "a",
      }).OR?.[0],
    ).toEqual({
      accountId: "a",
      fulfillmentSource: null,
      account: { storeId: "s", shopperId: "p" },
    });
  });
});
