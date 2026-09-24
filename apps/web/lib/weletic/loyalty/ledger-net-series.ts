import type { Prisma } from "@prisma/client";

const MAX_UTC_DAYS = 366;
const DAY_MS = 86_400_000;

/** Cumulative signed ledger movement from the earliest retained entry, not
 * historical wallet liability or a reconstruction of missing Shopify history.
 * Both reads run inside the caller's store-authorized snapshot transaction. */
export async function readMerchantLedgerNetSeries({
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
    bucket: "utc_day" as const,
    coverage: "recorded_ledger_net_only" as const,
  };
  if (!startAt || !endAt)
    return {
      ...base,
      status: "range_required" as const,
      openingNetPoints: null,
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
      openingNetPoints: null,
      rows: [],
    };

  // Cast before SUM so exact signed BIGINT movements stay exact and the
  // minimum signed BIGINT does not overflow during arithmetic.
  const [opening] = await tx.$queryRaw<Array<{ net: string }>>`
    SELECT CAST(COALESCE(SUM(CAST(pointsDelta AS DECIMAL(65, 0))), 0) AS CHAR) AS net
    FROM WeleticPointsLedgerEntry
    WHERE storeId = ${storeId} AND createdAt < ${startAt}
  `;
  if (!opening || !/^-?(?:0|[1-9]\d*)$/.test(opening.net))
    throw new Error("Ledger opening net is inconsistent");
  const grouped = await tx.$queryRaw<Array<{ day: string; net: string }>>`
    SELECT DATE_FORMAT(createdAt, '%Y-%m-%d') AS day,
           CAST(SUM(CAST(pointsDelta AS DECIMAL(65, 0))) AS CHAR) AS net
    FROM WeleticPointsLedgerEntry
    WHERE storeId = ${storeId} AND createdAt >= ${startAt} AND createdAt <= ${endAt}
    GROUP BY DATE_FORMAT(createdAt, '%Y-%m-%d')
    ORDER BY day ASC
  `;
  const byDay = new Map<string, bigint>();
  for (let index = 0; index < days; index++)
    byDay.set(
      new Date(startDay + index * DAY_MS).toISOString().slice(0, 10),
      BigInt(0),
    );
  const seen = new Set<string>();
  for (const row of grouped) {
    if (
      !byDay.has(row.day) ||
      seen.has(row.day) ||
      !/^-?(?:0|[1-9]\d*)$/.test(row.net)
    )
      throw new Error("Ledger net escaped the authorized range");
    byDay.set(row.day, BigInt(row.net));
    seen.add(row.day);
  }
  let cumulative = BigInt(opening.net);
  return {
    ...base,
    status: "available" as const,
    openingNetPoints: cumulative.toString(),
    rows: Array.from(byDay, ([date, change]) => {
      cumulative += change;
      return {
        date,
        netChangePoints: change.toString(),
        cumulativeNetPoints: cumulative.toString(),
      };
    }),
  };
}
