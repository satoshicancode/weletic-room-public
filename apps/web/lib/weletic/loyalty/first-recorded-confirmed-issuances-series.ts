import type { Prisma } from "@prisma/client";

const MAX_UTC_DAYS = 366;
const DAY_MS = 86_400_000;
const count = /^(?:0|[1-9]\d*)$/;
const redactionPath = '$."shopifyCustomerRedaction"';

/** Cohorts of retained accounts with locally confirmed reward issuance.
 * Confirmation is a durable app observation, not exact remote creation time,
 * discount use, or a complete shopper-lifetime redemption history. */
export async function readMerchantFirstRecordedConfirmedIssuancesSeries({
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
    coverage: "retained_confirmed_point_issuance_accounts_only" as const,
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

  // Filter redacted accounts before materializing account-months. An earlier
  // confirmed issuance on the same account establishes returning classification.
  const grouped = await tx.$queryRaw<
    Array<{
      month: string;
      confirmedAccounts: string;
      firstRecordedConfirmedAccounts: string;
    }>
  >`
    SELECT active.month,
           CAST(COUNT(*) AS CHAR) AS confirmedAccounts,
           CAST(SUM(CASE WHEN NOT EXISTS (
             SELECT 1 FROM WeleticRewardRedemption h
             WHERE h.accountId = active.accountId
               AND BINARY h.accountId = BINARY active.accountId
               AND h.storeId = ${storeId}
               AND BINARY h.storeId = BINARY ${storeId}
               AND h.issuanceConfirmedAt < CASE
                 WHEN active.month = DATE_FORMAT(${startAt}, '%Y-%m') THEN ${startAt}
                 ELSE STR_TO_DATE(CONCAT(active.month, '-01'), '%Y-%m-%d')
               END
               AND h.pointsSpent > 0
           ) THEN 1 ELSE 0 END) AS CHAR) AS firstRecordedConfirmedAccounts
    FROM (
      SELECT DISTINCT BINARY e.accountId AS accountId,
                      DATE_FORMAT(e.issuanceConfirmedAt, '%Y-%m') AS month
      FROM WeleticRewardRedemption e
      INNER JOIN WeleticLoyaltyAccount a
        ON a.id = e.accountId AND BINARY a.id = BINARY e.accountId
        AND a.storeId = e.storeId AND BINARY a.storeId = BINARY e.storeId
      WHERE e.storeId = ${storeId}
        AND BINARY e.storeId = BINARY ${storeId}
        AND COALESCE(JSON_CONTAINS_PATH(a.metadata, 'one', ${redactionPath}), 0) = 0
        AND e.issuanceConfirmedAt >= ${startAt} AND e.issuanceConfirmedAt <= ${endAt}
        AND e.pointsSpent > 0
    ) active
    GROUP BY active.month ORDER BY active.month ASC
  `;

  const byMonth = new Map<
    string,
    {
      confirmedAccounts: string;
      firstRecordedConfirmedAccounts: string;
      returningConfirmedAccounts: string;
    }
  >();
  const cursor = new Date(startDay);
  cursor.setUTCDate(1);
  const finalMonth = new Date(endDay).toISOString().slice(0, 7);
  while (cursor.toISOString().slice(0, 7) <= finalMonth) {
    byMonth.set(cursor.toISOString().slice(0, 7), {
      confirmedAccounts: "0",
      firstRecordedConfirmedAccounts: "0",
      returningConfirmedAccounts: "0",
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const seen = new Set<string>();
  for (const row of grouped) {
    if (
      !byMonth.has(row.month) ||
      seen.has(row.month) ||
      !count.test(row.confirmedAccounts) ||
      !count.test(row.firstRecordedConfirmedAccounts) ||
      BigInt(row.firstRecordedConfirmedAccounts) > BigInt(row.confirmedAccounts)
    )
      throw new Error("Confirmed issuance cohort escaped the authorized range");
    byMonth.set(row.month, {
      confirmedAccounts: row.confirmedAccounts,
      firstRecordedConfirmedAccounts: row.firstRecordedConfirmedAccounts,
      returningConfirmedAccounts: (
        BigInt(row.confirmedAccounts) -
        BigInt(row.firstRecordedConfirmedAccounts)
      ).toString(),
    });
    seen.add(row.month);
  }
  return {
    ...base,
    status: "available" as const,
    rows: Array.from(byMonth, ([month, values]) => ({ month, ...values })),
  };
}
