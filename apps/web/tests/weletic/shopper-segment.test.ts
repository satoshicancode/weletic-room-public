import { shopperSegmentWhere } from "@/lib/weletic/shoppers/segment-filter";
import {
  emptyShopperSegment,
  hasShopperSegment,
  shopperSegmentSchema,
} from "@/lib/weletic/shoppers/segment-query";
import { describe, expect, it } from "vitest";

describe("shopper segment contracts", () => {
  it("preserves existing unfiltered requests and strips unrelated URL fields", () => {
    expect(
      shopperSegmentSchema.parse({
        workspaceId: "untrusted",
        search: "Fixture",
      }),
    ).toEqual(emptyShopperSegment);
    expect(hasShopperSegment(emptyShopperSegment)).toBe(false);
  });
  it.each([
    { minPoints: "1.5" },
    { minPoints: "1.5", maxPoints: "10" },
    { minPoints: "0", maxPoints: "not-a-number" },
    { maxPoints: "1e3" },
    { minPoints: "-0" },
    { minPoints: "01" },
    { minPoints: "9223372036854775808" },
    { minPoints: "-9223372036854775809" },
    { minPoints: "5", maxPoints: "4" },
    { loyalty: "partner" },
    { vip: "gold" },
    { purchase: "first_purchase" },
    { purchasedFrom: "2026-01-01" },
    { purchase: "has_order", purchasedFrom: "2026-02-30" },
    {
      purchase: "has_order",
      purchasedFrom: "2026-09-06",
      purchasedBefore: "2026-09-06",
    },
    { purchase: "has_order", purchasedBefore: "2026-13-01" },
    { loyalty: "not_enrolled", minPoints: "0" },
    { loyalty: "not_enrolled", vip: "unassigned" },
  ])("rejects invalid/contradictory facts %j", (value) => {
    expect(shopperSegmentSchema.safeParse(value).success).toBe(false);
  });
  it("compares exact negative and large balances without rounding", () => {
    const segment = shopperSegmentSchema.parse({
      loyalty: "suspended",
      minPoints: " -9223372036854775808 ",
      maxPoints: "9007199254740993",
    });
    expect(hasShopperSegment(segment)).toBe(true);
    expect(shopperSegmentWhere("store-a", segment)).toEqual({
      AND: [
        {
          loyaltyAccount: {
            is: {
              storeId: "store-a",
              status: "suspended",
              cachedPointsBalance: {
                gte: BigInt("-9223372036854775808"),
                lte: BigInt("9007199254740993"),
              },
            },
          },
        },
      ],
    });
  });
  it.each(["has_order", "no_order"] as const)(
    "scopes %s to paid/partially-refunded orders and a half-open UTC date window",
    (purchase) => {
      const segment = shopperSegmentSchema.parse({
        purchase,
        purchasedFrom: "2024-02-29",
        purchasedBefore: "2024-03-01",
      });
      expect(shopperSegmentWhere("store-a", segment)).toEqual({
        AND: [
          {
            orders: {
              [purchase === "has_order" ? "some" : "none"]: {
                storeId: "store-a",
                status: { in: ["paid", "partially_refunded"] },
                occurredAt: {
                  gte: new Date("2024-02-29T00:00:00Z"),
                  lt: new Date("2024-03-01T00:00:00Z"),
                },
              },
            },
          },
        ],
      });
    },
  );
  it("does not synthesize an account for an unenrolled shopper", () => {
    expect(
      shopperSegmentWhere(
        "store-a",
        shopperSegmentSchema.parse({ loyalty: "not_enrolled" }),
      ),
    ).toEqual({ AND: [{ loyaltyAccount: { is: null } }] });
  });
});
