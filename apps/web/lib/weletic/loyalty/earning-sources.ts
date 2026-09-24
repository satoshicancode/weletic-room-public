import { WeleticPointsLedgerEntryType as Entry, Prisma } from "@prisma/client";

const earningTypes = new Set<Entry>([
  Entry.EARN_ORDER,
  Entry.EARN_REFERRAL,
  Entry.EARN_BONUS,
  Entry.TIER_BONUS,
]);
const count = /^(?:0|[1-9]\d*)$/;

/** Gross positive recorded earning entries by source. A later reversal remains
 * a separate ledger movement; this is not a net balance or unique-shopper count.
 */
export async function readMerchantEarningSources({
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
  const rows = await tx.$queryRaw<
    Array<{ entryType: Entry; eventCount: string; pointsEarned: string }>
  >(Prisma.sql`
    SELECT entryType,
           CAST(COUNT(*) AS CHAR) AS eventCount,
           CAST(SUM(CAST(pointsDelta AS DECIMAL(65, 0))) AS CHAR) AS pointsEarned
    FROM WeleticPointsLedgerEntry
    WHERE storeId = ${storeId}
      ${startAt ? Prisma.sql`AND createdAt >= ${startAt}` : Prisma.empty}
      ${endAt ? Prisma.sql`AND createdAt <= ${endAt}` : Prisma.empty}
      AND entryType IN ('EARN_ORDER', 'EARN_REFERRAL', 'EARN_BONUS', 'TIER_BONUS')
      AND pointsDelta > 0
    GROUP BY entryType
  `);
  const seen = new Set<Entry>();
  for (const row of rows) {
    if (
      !earningTypes.has(row.entryType) ||
      seen.has(row.entryType) ||
      !count.test(row.eventCount) ||
      !count.test(row.pointsEarned) ||
      BigInt(row.eventCount) === BigInt(0) ||
      BigInt(row.pointsEarned) === BigInt(0)
    )
      throw new Error("Earning source aggregate is inconsistent");
    seen.add(row.entryType);
  }
  return {
    coverage: "retained_positive_earning_ledger_only" as const,
    rows: rows.sort((a, b) => {
      const left = BigInt(a.pointsEarned);
      const right = BigInt(b.pointsEarned);
      return left > right
        ? -1
        : left < right
          ? 1
          : a.entryType.localeCompare(b.entryType);
    }),
  };
}
