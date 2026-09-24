import type { Prisma } from "@prisma/client";

const MAX_UTC_DAYS = 366;
const DAY_MS = 86_400_000;
const count = /^(?:0|[1-9]\d*)$/;

/** Account cohorts from retained positive earning ledger entries. Import,
 * correction and manual entries do not establish a qualifying earn. This is
 * not a lifetime shopper cohort when earlier or erased history is missing. */
export async function readMerchantFirstRecordedEarnersSeries({
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
    coverage: "retained_qualifying_ledger_accounts_only" as const,
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

  // Materialize only accounts active in the selected range. For each account
  // and month, an account-scoped history lookup checks for an earlier earn.
  // Aggregate in SQL; no account ID leaves the DB.
  const grouped = await tx.$queryRaw<
    Array<{
      month: string;
      activeAccounts: string;
      firstRecordedAccounts: string;
    }>
  >`
    SELECT active.month,
           CAST(COUNT(*) AS CHAR) AS activeAccounts,
           CAST(SUM(CASE WHEN NOT EXISTS (
             SELECT 1 FROM WeleticPointsLedgerEntry h
             WHERE h.accountId = active.accountId
               AND h.storeId = ${storeId}
               AND h.createdAt < CASE
                 WHEN active.month = DATE_FORMAT(${startAt}, '%Y-%m') THEN ${startAt}
                 ELSE STR_TO_DATE(CONCAT(active.month, '-01'), '%Y-%m-%d')
               END
               AND h.entryType IN ('EARN_ORDER', 'EARN_REFERRAL', 'EARN_BONUS', 'TIER_BONUS')
               AND h.pointsDelta > 0
           ) THEN 1 ELSE 0 END) AS CHAR) AS firstRecordedAccounts
    FROM (
      SELECT DISTINCT e.accountId, DATE_FORMAT(e.createdAt, '%Y-%m') AS month
      FROM WeleticPointsLedgerEntry e
      WHERE e.storeId = ${storeId}
        AND e.createdAt >= ${startAt} AND e.createdAt <= ${endAt}
        AND e.entryType IN ('EARN_ORDER', 'EARN_REFERRAL', 'EARN_BONUS', 'TIER_BONUS')
        AND e.pointsDelta > 0
    ) active
    GROUP BY active.month ORDER BY active.month ASC
  `;

  const byMonth = new Map<
    string,
    {
      activeAccounts: string;
      firstRecordedAccounts: string;
      returningAccounts: string;
    }
  >();
  const cursor = new Date(startDay);
  cursor.setUTCDate(1);
  const finalMonth = new Date(endDay).toISOString().slice(0, 7);
  while (cursor.toISOString().slice(0, 7) <= finalMonth) {
    byMonth.set(cursor.toISOString().slice(0, 7), {
      activeAccounts: "0",
      firstRecordedAccounts: "0",
      returningAccounts: "0",
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const seen = new Set<string>();
  for (const row of grouped) {
    if (
      !byMonth.has(row.month) ||
      seen.has(row.month) ||
      !count.test(row.activeAccounts) ||
      !count.test(row.firstRecordedAccounts) ||
      BigInt(row.firstRecordedAccounts) > BigInt(row.activeAccounts)
    )
      throw new Error("Earn cohort escaped the authorized range");
    byMonth.set(row.month, {
      activeAccounts: row.activeAccounts,
      firstRecordedAccounts: row.firstRecordedAccounts,
      returningAccounts: (
        BigInt(row.activeAccounts) - BigInt(row.firstRecordedAccounts)
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
