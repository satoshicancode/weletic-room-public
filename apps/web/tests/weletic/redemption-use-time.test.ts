import { getShopifyOrderUseTime } from "@/lib/weletic/loyalty/redemption-use-time";
import { expect, it } from "vitest";

const observedAt = new Date("2026-09-25T10:00:00.000Z");

it("retains a Shopify order's parseable creation time as event evidence", () => {
  expect(
    getShopifyOrderUseTime("2026-09-24T12:34:56.000Z", observedAt),
  ).toEqual({
    usedAt: new Date("2026-09-24T12:34:56.000Z"),
    usedAtBasis: "shopify_order_created_at",
  });
});

it.each([
  null,
  undefined,
  "",
  "not-an-instant",
  2026,
  "2026-09-24",
  "2026-09-24T12:34:56",
  "2026-02-30T12:34:56Z",
])(
  "labels %s as webhook observation rather than order event time",
  (createdAt) => {
    expect(getShopifyOrderUseTime(createdAt, observedAt)).toEqual({
      usedAt: observedAt,
      usedAtBasis: "webhook_observed_at",
    });
  },
);

it("rejects an invalid local observation time", () => {
  expect(() => getShopifyOrderUseTime(null, new Date(Number.NaN))).toThrow(
    "A valid webhook observation time is required.",
  );
});
