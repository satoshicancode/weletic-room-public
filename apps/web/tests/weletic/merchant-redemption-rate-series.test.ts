import { expect, it } from "vitest";
import type { readMerchantPointActivitySeries } from "../../lib/weletic/loyalty/activity-series";
import { deriveMerchantRedemptionRateSeries } from "../../lib/weletic/loyalty/redemption-rate-series";

type ActivitySeries = Awaited<
  ReturnType<typeof readMerchantPointActivitySeries>
>;

function day({
  date,
  earned,
  redeemed,
  backfilled = "0",
}: {
  date: string;
  earned: string;
  redeemed: string;
  backfilled?: string;
}) {
  return {
    date,
    earned,
    redeemed,
    backfilled,
    refundReversed: "0",
    expired: "0",
    backfillCorrected: "0",
    manualCredits: "0",
    manualDebits: "0",
  };
}

it("groups ledger days by UTC month, excludes opening backfill and permits a rate above 100%", () => {
  const series = {
    status: "available",
    bucket: "utc_day",
    rows: [
      day({
        date: "2026-09-30",
        earned: "110",
        backfilled: "10",
        redeemed: "150",
      }),
      day({ date: "2026-10-01", earned: "0", redeemed: "10" }),
      day({ date: "2026-10-31", earned: "0", redeemed: "0" }),
      day({ date: "2026-11-01", earned: "3", redeemed: "1" }),
    ],
  } as ActivitySeries;
  expect(deriveMerchantRedemptionRateSeries(series)).toEqual({
    status: "available",
    bucket: "utc_month",
    coverage: "recorded_ledger_only",
    rows: [
      {
        month: "2026-09",
        earnedPoints: "100",
        redeemedPoints: "150",
        redemptionRateBasisPoints: "15000",
      },
      {
        month: "2026-10",
        earnedPoints: "0",
        redeemedPoints: "10",
        redemptionRateBasisPoints: null,
      },
      {
        month: "2026-11",
        earnedPoints: "3",
        redeemedPoints: "1",
        redemptionRateBasisPoints: "3333",
      },
    ],
  });
});

it("keeps exact counts above Number precision and rounds half up", () => {
  const huge = BigInt("9007199254740993");
  const series = {
    status: "available",
    bucket: "utc_day",
    rows: [
      day({
        date: "2026-09-01",
        earned: huge.toString(),
        redeemed: (huge / BigInt(2)).toString(),
      }),
    ],
  } as ActivitySeries;
  const row = deriveMerchantRedemptionRateSeries(series).rows[0];
  expect(row).toMatchObject({
    earnedPoints: huge.toString(),
    redeemedPoints: (huge / BigInt(2)).toString(),
    redemptionRateBasisPoints: "5000",
  });
  const halfBasisPoint = deriveMerchantRedemptionRateSeries({
    status: "available",
    bucket: "utc_day",
    rows: [day({ date: "2026-09-01", earned: "20000", redeemed: "1" })],
  } as ActivitySeries);
  expect(halfBasisPoint.rows[0].redemptionRateBasisPoints).toBe("1");
});

it("propagates the bounded range status without inventing a denominator", () => {
  for (const status of ["range_required", "range_too_wide"] as const)
    expect(
      deriveMerchantRedemptionRateSeries({
        status,
        bucket: "utc_day",
        rows: [],
      }),
    ).toEqual({
      status,
      bucket: "utc_month",
      coverage: "recorded_ledger_only",
      rows: [],
    });
});

it("fails closed when overlapping backfill exceeds earned points", () => {
  const series = {
    status: "available",
    bucket: "utc_day",
    rows: [
      day({ date: "2026-09-01", earned: "5", backfilled: "6", redeemed: "0" }),
    ],
  } as ActivitySeries;
  expect(() => deriveMerchantRedemptionRateSeries(series)).toThrow(
    "inconsistent",
  );
});
