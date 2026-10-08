import type { Prisma } from "@prisma/client";

const MAX_UTC_DAYS = 366;
const DAY_MS = 86_400_000;

/** Counts persisted commerce orders by their recorded order timestamp. A
 * positive current purchase-points grant counts once per order, including
 * historical backfill and grants later reversed by refund. These are observed
 * Weletic records, not a reconstruction of missing Shopify orders. */
export async function readMerchantOrderEarningSeries({
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
      coverage: "recorded_orders_only" as const,
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
      coverage: "recorded_orders_only" as const,
      rows: [],
    };

  // The grant is unique per (storeId, orderId), so each recorded order appears
  // at most once. SQL groups before returning data to avoid shopper/order rows.
  const grouped = await tx.$queryRaw<
    Array<{ day: string; recordedOrders: string; earningOrders: string }>
  >`
    SELECT DATE_FORMAT(o.occurredAt, '%Y-%m-%d') AS day,
           CAST(COUNT(*) AS CHAR) AS recordedOrders,
           CAST(SUM(CASE WHEN g.grossPoints > 0 THEN 1 ELSE 0 END) AS CHAR) AS earningOrders
    FROM WeleticCommerceOrder o
    LEFT JOIN WeleticLoyaltyEarnGrant g
      ON g.storeId = o.storeId AND g.orderId = o.id
    WHERE o.storeId = ${storeId}
      AND o.occurredAt >= ${startAt} AND o.occurredAt <= ${endAt}
    GROUP BY DATE_FORMAT(o.occurredAt, '%Y-%m-%d')
    ORDER BY day ASC
  `;
  const byDay = new Map<
    string,
    {
      recordedOrders: string;
      earningOrders: string;
      rateBasisPoints: string | null;
    }
  >();
  for (let index = 0; index < days; index++)
    byDay.set(new Date(startDay + index * DAY_MS).toISOString().slice(0, 10), {
      recordedOrders: "0",
      earningOrders: "0",
      rateBasisPoints: null,
    });
  for (const row of grouped) {
    if (!byDay.has(row.day))
      throw new Error("Order activity escaped the authorized range");
    const recorded = BigInt(row.recordedOrders);
    const earning = BigInt(row.earningOrders);
    if (recorded <= 0 || earning < 0 || earning > recorded)
      throw new Error("Order earning series is inconsistent");
    byDay.set(row.day, {
      recordedOrders: recorded.toString(),
      earningOrders: earning.toString(),
      // 10,000 basis points = 100%; round half up without Number precision loss.
      rateBasisPoints: (
        (earning * BigInt(10_000) + recorded / BigInt(2)) /
        recorded
      ).toString(),
    });
  }
  return {
    status: "available" as const,
    bucket: "utc_day" as const,
    coverage: "recorded_orders_only" as const,
    rows: Array.from(byDay, ([date, values]) => ({ date, ...values })),
  };
}
