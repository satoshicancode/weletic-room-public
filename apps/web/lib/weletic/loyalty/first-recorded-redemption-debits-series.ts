import type { Prisma } from "@prisma/client";

const MAX_UTC_DAYS = 366;
const DAY_MS = 86_400_000;
const count = /^(?:0|[1-9]\d*)$/;
const redactionPath = '$."shopifyCustomerRedaction"';

/** Cohorts of retained accounts with negative reward-redemption ledger debits.
 * A debit can precede remote issuance and later be compensated; this is not a
 * successful-use or lifetime shopper cohort. */
export async function readMerchantFirstRecordedRedemptionDebitsSeries({
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
    coverage: "retained_reward_debit_accounts_only" as const,
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
  // debit on the same account still establishes returning classification.
  const grouped = await tx.$queryRaw<
    Array<{
      month: string;
      debitAccounts: string;
      firstRecordedDebitAccounts: string;
    }>
  >`
    SELECT active.month,
           CAST(COUNT(*) AS CHAR) AS debitAccounts,
           CAST(SUM(CASE WHEN NOT EXISTS (
             SELECT 1 FROM WeleticPointsLedgerEntry h
             WHERE h.accountId = active.accountId
               AND h.storeId = ${storeId}
               AND BINARY h.storeId = BINARY ${storeId}
               AND h.createdAt < CASE
                 WHEN active.month = DATE_FORMAT(${startAt}, '%Y-%m') THEN ${startAt}
                 ELSE STR_TO_DATE(CONCAT(active.month, '-01'), '%Y-%m-%d')
               END
               AND h.entryType = 'REDEEM_REWARD'
               AND h.pointsDelta < 0
           ) THEN 1 ELSE 0 END) AS CHAR) AS firstRecordedDebitAccounts
    FROM (
      SELECT DISTINCT e.accountId, DATE_FORMAT(e.createdAt, '%Y-%m') AS month
      FROM WeleticPointsLedgerEntry e
      INNER JOIN WeleticLoyaltyAccount a
        ON a.id = e.accountId AND BINARY a.id = BINARY e.accountId
        AND a.storeId = e.storeId AND BINARY a.storeId = BINARY e.storeId
      WHERE e.storeId = ${storeId}
        AND BINARY e.storeId = BINARY ${storeId}
        AND COALESCE(JSON_CONTAINS_PATH(a.metadata, 'one', ${redactionPath}), 0) = 0
        AND e.createdAt >= ${startAt} AND e.createdAt <= ${endAt}
        AND e.entryType = 'REDEEM_REWARD'
        AND e.pointsDelta < 0
    ) active
    GROUP BY active.month ORDER BY active.month ASC
  `;

  const byMonth = new Map<
    string,
    {
      debitAccounts: string;
      firstRecordedDebitAccounts: string;
      returningDebitAccounts: string;
    }
  >();
  const cursor = new Date(startDay);
  cursor.setUTCDate(1);
  const finalMonth = new Date(endDay).toISOString().slice(0, 7);
  while (cursor.toISOString().slice(0, 7) <= finalMonth) {
    byMonth.set(cursor.toISOString().slice(0, 7), {
      debitAccounts: "0",
      firstRecordedDebitAccounts: "0",
      returningDebitAccounts: "0",
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const seen = new Set<string>();
  for (const row of grouped) {
    if (
      !byMonth.has(row.month) ||
      seen.has(row.month) ||
      !count.test(row.debitAccounts) ||
      !count.test(row.firstRecordedDebitAccounts) ||
      BigInt(row.firstRecordedDebitAccounts) > BigInt(row.debitAccounts)
    )
      throw new Error("Redemption debit cohort escaped the authorized range");
    byMonth.set(row.month, {
      debitAccounts: row.debitAccounts,
      firstRecordedDebitAccounts: row.firstRecordedDebitAccounts,
      returningDebitAccounts: (
        BigInt(row.debitAccounts) - BigInt(row.firstRecordedDebitAccounts)
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
