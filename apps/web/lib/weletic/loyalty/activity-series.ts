import type { Prisma, WeleticPointsLedgerEntryType } from "@prisma/client";
import { LEDGER_ANALYTICS_CLASSIFICATIONS } from "./analytics";

const MAX_UTC_DAYS = 366;
const DAY_MS = 86_400_000;

type ActivityValues = {
  earned: bigint;
  redeemed: bigint;
  refundReversed: bigint;
  expired: bigint;
  backfilled: bigint;
  backfillCorrected: bigint;
  manualCredits: bigint;
  manualDebits: bigint;
};

function emptyValues(): ActivityValues {
  return {
    earned: BigInt(0),
    redeemed: BigInt(0),
    refundReversed: BigInt(0),
    expired: BigInt(0),
    backfilled: BigInt(0),
    backfillCorrected: BigInt(0),
    manualCredits: BigInt(0),
    manualDebits: BigInt(0),
  };
}

/** Selected instants are inclusive; grouping is by the persisted UTC date.
 * This is ledger activity, not historical balance or liability reconstruction.
 */
export async function readMerchantPointActivitySeries({
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
  if (!startAt || !endAt)
    return {
      status: "range_required" as const,
      bucket: "utc_day" as const,
      rows: [],
    };
  const startDay = Date.parse(
    `${startAt.toISOString().slice(0, 10)}T00:00:00Z`,
  );
  const endDay = Date.parse(`${endAt.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.floor((endDay - startDay) / DAY_MS) + 1;
  if (days < 1 || days > MAX_UTC_DAYS)
    return {
      status: "range_too_wide" as const,
      bucket: "utc_day" as const,
      rows: [],
    };

  // Aggregate in MySQL so the report does not materialize every ledger row.
  // Cast before negation: the minimum signed BIGINT has no positive BIGINT twin.
  const grouped = await tx.$queryRaw<
    Array<{
      day: string;
      entryType: WeleticPointsLedgerEntryType;
      positive: Prisma.Decimal;
      negative: Prisma.Decimal;
    }>
  >`
    SELECT DATE_FORMAT(createdAt, '%Y-%m-%d') AS day,
           entryType,
           SUM(CASE WHEN pointsDelta > 0 THEN CAST(pointsDelta AS DECIMAL(65, 0)) ELSE 0 END) AS positive,
           SUM(CASE WHEN pointsDelta < 0 THEN -CAST(pointsDelta AS DECIMAL(65, 0)) ELSE 0 END) AS negative
    FROM WeleticPointsLedgerEntry
    WHERE storeId = ${storeId} AND createdAt >= ${startAt} AND createdAt <= ${endAt}
    GROUP BY DATE_FORMAT(createdAt, '%Y-%m-%d'), entryType
    ORDER BY day ASC, entryType ASC
  `;
  const byDay = new Map<string, ActivityValues>();
  for (let index = 0; index < days; index++)
    byDay.set(
      new Date(startDay + index * DAY_MS).toISOString().slice(0, 10),
      emptyValues(),
    );
  for (const row of grouped) {
    const bucket = byDay.get(row.day);
    if (!bucket)
      throw new Error("Ledger activity escaped the authorized range");
    const positive = BigInt(row.positive.toFixed(0));
    const negative = BigInt(row.negative.toFixed(0));
    const type = row.entryType;
    if (LEDGER_ANALYTICS_CLASSIFICATIONS.earned.has(type))
      bucket.earned += positive;
    if (LEDGER_ANALYTICS_CLASSIFICATIONS.backfill.has(type))
      bucket.backfilled += positive;
    if (LEDGER_ANALYTICS_CLASSIFICATIONS.redeemed.has(type))
      bucket.redeemed += negative;
    if (LEDGER_ANALYTICS_CLASSIFICATIONS.refunded.has(type))
      bucket.refundReversed += negative;
    if (LEDGER_ANALYTICS_CLASSIFICATIONS.expired.has(type))
      bucket.expired += negative;
    if (LEDGER_ANALYTICS_CLASSIFICATIONS.backfillCorrection.has(type))
      bucket.backfillCorrected += negative;
    if (LEDGER_ANALYTICS_CLASSIFICATIONS.manualAdjustment.has(type)) {
      bucket.manualCredits += positive;
      bucket.manualDebits += negative;
    }
  }
  return {
    status: "available" as const,
    bucket: "utc_day" as const,
    rows: Array.from(byDay, ([date, values]) => ({
      date,
      ...Object.fromEntries(
        Object.entries(values).map(([key, value]) => [key, value.toString()]),
      ),
    })) as Array<{ date: string } & Record<keyof ActivityValues, string>>,
  };
}
