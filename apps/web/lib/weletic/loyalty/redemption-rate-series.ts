import type { readMerchantPointActivitySeries } from "./activity-series";

type ActivitySeries = Awaited<
  ReturnType<typeof readMerchantPointActivitySeries>
>;

/** Ratio of observed reward-spend debits to non-backfill earn credits in each
 * UTC month. Both source categories come from the same bounded ledger read. */
export function deriveMerchantRedemptionRateSeries(series: ActivitySeries) {
  const base = {
    status: series.status,
    bucket: "utc_month" as const,
    coverage: "recorded_ledger_only" as const,
  };
  if (series.status !== "available") return { ...base, rows: [] };

  const byMonth = new Map<string, { earned: bigint; redeemed: bigint }>();
  for (const row of series.rows) {
    const earned = BigInt(row.earned) - BigInt(row.backfilled);
    const redeemed = BigInt(row.redeemed);
    if (earned < BigInt(0) || redeemed < BigInt(0))
      throw new Error("Redemption rate source categories are inconsistent");
    const month = row.date.slice(0, 7);
    const bucket = byMonth.get(month) ?? {
      earned: BigInt(0),
      redeemed: BigInt(0),
    };
    bucket.earned += earned;
    bucket.redeemed += redeemed;
    byMonth.set(month, bucket);
  }
  return {
    ...base,
    rows: Array.from(byMonth, ([month, { earned, redeemed }]) => ({
      month,
      earnedPoints: earned.toString(),
      redeemedPoints: redeemed.toString(),
      redemptionRateBasisPoints:
        earned === BigInt(0)
          ? null
          : (
              (redeemed * BigInt(10_000) + earned / BigInt(2)) /
              earned
            ).toString(),
    })),
  };
}
