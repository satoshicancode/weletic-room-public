import type { Prisma } from "@prisma/client";

const MAX_UTC_DAYS = 366;
const DAY_MS = 86_400_000;
const count = /^(?:0|[1-9]\d*)$/;

/** Retained tier-history events by recorded reason, not reconstructed
 * historical membership or a claim about tier direction. */
export async function readMerchantRecordedTierChangeSeries({
  tx,
  storeId,
  startAt,
  endAt,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  startAt: Date | null;
  endAt: Date | null;
}) {
  const base = {
    bucket: "utc_month" as const,
    coverage: "retained_tier_change_reasons_only" as const,
  };
  if (!startAt || !endAt)
    return { ...base, status: "range_required" as const, rows: [] };
  const startDay = Date.parse(
    `${startAt.toISOString().slice(0, 10)}T00:00:00Z`,
  );
  const endDay = Date.parse(`${endAt.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.floor((endDay - startDay) / DAY_MS) + 1;
  if (days < 1 || days > MAX_UTC_DAYS)
    return { ...base, status: "range_too_wide" as const, rows: [] };

  const grouped = await tx.$queryRaw<
    Array<{
      month: string;
      totalChanges: string;
      thresholdReached: string;
      bonusPromotion: string;
      annualDowngrade: string;
      gracePeriodExpired: string;
      programActivation: string;
      manualOverride: string;
      otherReasons: string;
    }>
  >`
    SELECT DATE_FORMAT(h.effectiveAt, '%Y-%m') AS month,
           CAST(COUNT(*) AS CHAR) AS totalChanges,
           CAST(SUM(CASE WHEN h.changeReason = 'threshold_reached' THEN 1 ELSE 0 END) AS CHAR) AS thresholdReached,
           CAST(SUM(CASE WHEN h.changeReason = 'bonus_promotion' THEN 1 ELSE 0 END) AS CHAR) AS bonusPromotion,
           CAST(SUM(CASE WHEN h.changeReason = 'annual_downgrade' THEN 1 ELSE 0 END) AS CHAR) AS annualDowngrade,
           CAST(SUM(CASE WHEN h.changeReason = 'grace_period_expired' THEN 1 ELSE 0 END) AS CHAR) AS gracePeriodExpired,
           CAST(SUM(CASE WHEN h.changeReason = 'program_activation' THEN 1 ELSE 0 END) AS CHAR) AS programActivation,
           CAST(SUM(CASE WHEN h.changeReason = 'manual_override' THEN 1 ELSE 0 END) AS CHAR) AS manualOverride,
           CAST(SUM(CASE WHEN h.changeReason NOT IN (
             'threshold_reached', 'bonus_promotion', 'annual_downgrade',
             'grace_period_expired', 'program_activation', 'manual_override'
           ) THEN 1 ELSE 0 END) AS CHAR) AS otherReasons
    FROM WeleticLoyaltyAccount a
    JOIN WeleticLoyaltyTierHistory h ON h.accountId = a.id
    WHERE a.storeId = ${storeId}
      AND h.effectiveAt >= ${startAt} AND h.effectiveAt <= ${endAt}
    GROUP BY DATE_FORMAT(h.effectiveAt, '%Y-%m')
    ORDER BY month ASC
  `;

  const empty = () => ({
    totalChanges: "0",
    thresholdReached: "0",
    bonusPromotion: "0",
    annualDowngrade: "0",
    gracePeriodExpired: "0",
    programActivation: "0",
    manualOverride: "0",
    otherReasons: "0",
  });
  const byMonth = new Map<string, ReturnType<typeof empty>>();
  const cursor = new Date(startDay);
  cursor.setUTCDate(1);
  const finalMonth = new Date(endDay).toISOString().slice(0, 7);
  while (cursor.toISOString().slice(0, 7) <= finalMonth) {
    byMonth.set(cursor.toISOString().slice(0, 7), empty());
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const seen = new Set<string>();
  for (const row of grouped) {
    const {
      month,
      totalChanges,
      thresholdReached,
      bonusPromotion,
      annualDowngrade,
      gracePeriodExpired,
      programActivation,
      manualOverride,
      otherReasons,
    } = row;
    const reasons = [
      thresholdReached,
      bonusPromotion,
      annualDowngrade,
      gracePeriodExpired,
      programActivation,
      manualOverride,
      otherReasons,
    ];
    if (
      !byMonth.has(month) ||
      seen.has(month) ||
      !count.test(totalChanges) ||
      reasons.some((value) => !count.test(value)) ||
      BigInt(totalChanges) !==
        reasons.reduce((sum, value) => sum + BigInt(value), BigInt(0))
    )
      throw new Error("Tier history escaped the authorized range");
    byMonth.set(month, {
      totalChanges,
      thresholdReached,
      bonusPromotion,
      annualDowngrade,
      gracePeriodExpired,
      programActivation,
      manualOverride,
      otherReasons,
    });
    seen.add(month);
  }
  return {
    ...base,
    status: "available" as const,
    rows: Array.from(byMonth, ([month, values]) => ({ month, ...values })),
  };
}
