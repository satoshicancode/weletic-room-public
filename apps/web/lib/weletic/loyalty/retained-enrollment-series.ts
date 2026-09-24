import { Prisma } from "@prisma/client";

const MAX_UTC_DAYS = 366;
const DAY_MS = 86_400_000;
const count = /^(?:0|[1-9]\d*)$/;
// Match SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY without loading the privacy worker.
const redactionPath = '$."shopifyCustomerRedaction"';

/** A current retained-account projection over recorded enrollment timestamps.
 * Erased accounts and missing pre-Weletic history cannot be reconstructed. */
export async function readMerchantRetainedEnrollmentSeries({
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
    coverage: "retained_account_enrollments_only" as const,
  };
  if (!startAt || !endAt)
    return {
      ...base,
      status: "range_required" as const,
      openingRetainedAccounts: null,
      rows: [],
    };
  const startDay = Date.parse(
    `${startAt.toISOString().slice(0, 10)}T00:00:00Z`,
  );
  const endDay = Date.parse(`${endAt.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.floor((endDay - startDay) / DAY_MS) + 1;
  if (days < 1 || days > MAX_UTC_DAYS)
    return {
      ...base,
      status: "range_too_wide" as const,
      openingRetainedAccounts: null,
      rows: [],
    };

  const [opening] = await tx.$queryRaw<
    Array<{ openingRetainedAccounts: string }>
  >(Prisma.sql`
    SELECT CAST(COUNT(*) AS CHAR) AS openingRetainedAccounts
    FROM WeleticLoyaltyAccount
    WHERE storeId = ${storeId} AND BINARY storeId = BINARY ${storeId}
      AND enrolledAt < ${startAt}
      AND COALESCE(JSON_CONTAINS_PATH(metadata, 'one', ${redactionPath}), 0) = 0
  `);
  if (!opening || !count.test(opening.openingRetainedAccounts))
    throw new Error("Retained enrollment opening count is inconsistent");
  const grouped = await tx.$queryRaw<
    Array<{ month: string; newRetainedAccounts: string }>
  >(Prisma.sql`
    SELECT DATE_FORMAT(enrolledAt, '%Y-%m') AS month,
           CAST(COUNT(*) AS CHAR) AS newRetainedAccounts
    FROM WeleticLoyaltyAccount
    WHERE storeId = ${storeId} AND BINARY storeId = BINARY ${storeId}
      AND enrolledAt >= ${startAt} AND enrolledAt <= ${endAt}
      AND COALESCE(JSON_CONTAINS_PATH(metadata, 'one', ${redactionPath}), 0) = 0
    GROUP BY month ORDER BY month ASC
  `);
  const months = new Map<string, string>();
  const cursor = new Date(startDay);
  cursor.setUTCDate(1);
  const finalMonth = new Date(endDay).toISOString().slice(0, 7);
  while (cursor.toISOString().slice(0, 7) <= finalMonth) {
    months.set(cursor.toISOString().slice(0, 7), "0");
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const seen = new Set<string>();
  for (const row of grouped) {
    if (
      !months.has(row.month) ||
      seen.has(row.month) ||
      !count.test(row.newRetainedAccounts) ||
      BigInt(row.newRetainedAccounts) === BigInt(0)
    )
      throw new Error("Retained enrollment escaped the authorized range");
    months.set(row.month, row.newRetainedAccounts);
    seen.add(row.month);
  }
  let cumulative = BigInt(opening.openingRetainedAccounts);
  return {
    ...base,
    status: "available" as const,
    openingRetainedAccounts: opening.openingRetainedAccounts,
    rows: Array.from(months, ([month, newRetainedAccounts]) => {
      cumulative += BigInt(newRetainedAccounts);
      return {
        month,
        newRetainedAccounts,
        cumulativeRetainedAccounts: cumulative.toString(),
      };
    }),
  };
}
