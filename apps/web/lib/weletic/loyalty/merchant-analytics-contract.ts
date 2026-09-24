import { z } from "zod";

const integer = z.string().regex(/^-?(?:0|[1-9]\d*)$/);
const count = z.string().regex(/^(?:0|[1-9]\d*)$/);
const instant = z.string().datetime({ offset: true });
export const merchantAnalyticsFilterSchema = z
  .object({ startAt: instant.nullable(), endAt: instant.nullable() })
  .strict()
  .refine(
    ({ startAt, endAt }) =>
      !startAt || !endAt || new Date(startAt) <= new Date(endAt),
    { message: "Start must not be after end", path: ["endAt"] },
  );

export const merchantAnalyticsRequestSchema = z.discriminatedUnion(
  "operation",
  [
    z
      .object({
        operation: z.literal("read"),
        filter: merchantAnalyticsFilterSchema,
      })
      .strict(),
    z
      .object({
        operation: z.literal("export"),
        filter: merchantAnalyticsFilterSchema,
        format: z.enum(["csv", "json"]),
        expectedInstallationGeneration: z.string().min(1).max(64),
      })
      .strict(),
  ],
);

export const merchantAnalyticsSnapshotSchema = z
  .object({
    storeId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
    generatedAt: instant,
    filter: merchantAnalyticsFilterSchema,
    currency: z.string().regex(/^[A-Z]{3}$/),
    canExport: z.boolean(),
    financialStatus: z.enum([
      "available",
      "temporarily_unavailable",
      "data_quality_error",
    ]),
    financialReason: z.string().nullable(),
    liability: z
      .object({
        circulatingPoints: integer,
        pendingPoints: integer,
        debtPoints: integer,
        currentMinorUnits: integer.nullable(),
        pendingMinorUnits: integer.nullable(),
        potentialMinorUnits: integer.nullable(),
        totalMembers: count,
        activeMembers: count,
      })
      .strict(),
    activity: z
      .object({
        earned: integer,
        redeemed: integer,
        refundReversed: integer,
        expired: integer,
        backfilled: integer,
        backfillCorrected: integer,
        manualCredits: integer,
        manualDebits: integer,
      })
      .strict(),
    activitySeries: z
      .object({
        status: z.enum(["available", "range_required", "range_too_wide"]),
        bucket: z.literal("utc_day"),
        rows: z
          .array(
            z
              .object({
                date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                earned: integer,
                redeemed: integer,
                refundReversed: integer,
                expired: integer,
                backfilled: integer,
                backfillCorrected: integer,
                manualCredits: integer,
                manualDebits: integer,
              })
              .strict(),
          )
          .max(366),
      })
      .strict()
      .refine(
        ({ status, rows }) => status === "available" || rows.length === 0,
      ),
    ledgerNetSeries: z
      .object({
        status: z.enum(["available", "range_required", "range_too_wide"]),
        bucket: z.literal("utc_day"),
        coverage: z.literal("recorded_ledger_net_only"),
        openingNetPoints: integer.nullable(),
        rows: z
          .array(
            z
              .object({
                date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                netChangePoints: integer,
                cumulativeNetPoints: integer,
              })
              .strict(),
          )
          .max(366),
      })
      .strict()
      .refine(({ status, openingNetPoints, rows }) => {
        if (status !== "available")
          return openingNetPoints === null && rows.length === 0;
        if (openingNetPoints === null || rows.length === 0) return false;
        let running = BigInt(openingNetPoints);
        let previous = "";
        for (const row of rows) {
          if (row.date <= previous) return false;
          running += BigInt(row.netChangePoints);
          if (row.cumulativeNetPoints !== running.toString()) return false;
          previous = row.date;
        }
        return true;
      }),
    redemptionRateSeries: z
      .object({
        status: z.enum(["available", "range_required", "range_too_wide"]),
        bucket: z.literal("utc_month"),
        coverage: z.literal("recorded_ledger_only"),
        rows: z
          .array(
            z
              .object({
                month: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
                earnedPoints: count,
                redeemedPoints: count,
                redemptionRateBasisPoints: count.nullable(),
              })
              .strict()
              .refine(
                ({
                  earnedPoints,
                  redeemedPoints,
                  redemptionRateBasisPoints,
                }) => {
                  const earned = BigInt(earnedPoints);
                  const redeemed = BigInt(redeemedPoints);
                  return earned === BigInt(0)
                    ? redemptionRateBasisPoints === null
                    : redemptionRateBasisPoints ===
                        (
                          (redeemed * BigInt(10_000) + earned / BigInt(2)) /
                          earned
                        ).toString();
                },
              ),
          )
          .max(14),
      })
      .strict()
      .refine(
        ({ status, rows }) => status === "available" || rows.length === 0,
      ),
    orderEarningSeries: z
      .object({
        status: z.enum(["available", "range_required", "range_too_wide"]),
        bucket: z.literal("utc_day"),
        coverage: z.literal("recorded_orders_only"),
        rows: z
          .array(
            z
              .object({
                date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                recordedOrders: count,
                earningOrders: count,
                rateBasisPoints: count.nullable(),
              })
              .strict()
              .refine(({ recordedOrders, earningOrders, rateBasisPoints }) => {
                const recorded = BigInt(recordedOrders);
                const earning = BigInt(earningOrders);
                return (
                  earning <= recorded &&
                  (recorded === BigInt(0)
                    ? rateBasisPoints === null
                    : rateBasisPoints ===
                      (
                        (earning * BigInt(10_000) + recorded / BigInt(2)) /
                        recorded
                      ).toString())
                );
              }),
          )
          .max(366),
      })
      .strict()
      .refine(
        ({ status, rows }) => status === "available" || rows.length === 0,
      ),
    referralEconomics: z
      .object({
        total: count,
        successful: count,
        revenueMinorUnits: integer.nullable(),
        costMinorUnits: integer.nullable(),
      })
      .strict(),
    referrals: z.array(
      z
        .object({
          status: z.enum([
            "pending",
            "qualified",
            "rewarded",
            "cancelled",
            "fraud_blocked",
          ]),
          count,
        })
        .strict(),
    ),
    rewards: z.array(
      z
        .object({
          status: z.enum([
            "active",
            "provisioning",
            "issued",
            "used",
            "failed",
            "cancelled",
            "expired",
          ]),
          artifact: z.enum(["discount_code", "gift_card", "store_credit"]),
          count,
          pointsSpent: integer,
        })
        .strict(),
    ),
    tiers: z.array(
      z
        .object({
          name: z.string(),
          assignment: z.enum(["configured", "unassigned", "unavailable"]),
          members: count,
          pointsBalance: integer,
          rollingSpendMinorUnits: integer,
        })
        .strict(),
    ),
  })
  .strict()
  .refine(({ filter, ledgerNetSeries }) => {
    if (!filter.startAt || !filter.endAt)
      return ledgerNetSeries.status === "range_required";
    const startDay = Date.parse(
      `${new Date(filter.startAt).toISOString().slice(0, 10)}T00:00:00Z`,
    );
    const endDay = Date.parse(
      `${new Date(filter.endAt).toISOString().slice(0, 10)}T00:00:00Z`,
    );
    const days = Math.floor((endDay - startDay) / 86_400_000) + 1;
    if (days < 1 || days > 366)
      return ledgerNetSeries.status === "range_too_wide";
    if (
      ledgerNetSeries.status !== "available" ||
      ledgerNetSeries.rows.length !== days
    )
      return false;
    return ledgerNetSeries.rows.every(
      (row, index) =>
        row.date ===
        new Date(startDay + index * 86_400_000).toISOString().slice(0, 10),
    );
  });

export const merchantAnalyticsResponseSchema = z
  .object({
    snapshot: merchantAnalyticsSnapshotSchema,
    download: z
      .object({
        filename: z.enum([
          "weletic-loyalty-analytics.csv",
          "weletic-loyalty-analytics.json",
        ]),
        contentType: z.enum([
          "text/csv; charset=utf-8",
          "application/json; charset=utf-8",
        ]),
        content: z.string().max(8 * 1024 * 1024),
      })
      .strict()
      .nullable(),
  })
  .strict();

export type MerchantAnalyticsRequest = z.infer<
  typeof merchantAnalyticsRequestSchema
>;
export type MerchantAnalyticsSnapshot = z.infer<
  typeof merchantAnalyticsSnapshotSchema
>;
export type MerchantAnalyticsResponse = z.infer<
  typeof merchantAnalyticsResponseSchema
>;

export function verifyMerchantAnalyticsResponse(
  request: MerchantAnalyticsRequest,
  value: unknown,
) {
  const result = merchantAnalyticsResponseSchema.parse(value);
  if (
    result.snapshot.filter.startAt !== request.filter.startAt ||
    result.snapshot.filter.endAt !== request.filter.endAt ||
    (request.operation === "read" && result.download !== null) ||
    (request.operation === "export" &&
      (!result.snapshot.canExport ||
        result.snapshot.installationGeneration !==
          request.expectedInstallationGeneration ||
        result.download?.filename !==
          `weletic-loyalty-analytics.${request.format}` ||
        result.download.contentType !==
          (request.format === "csv"
            ? "text/csv; charset=utf-8"
            : "application/json; charset=utf-8")))
  )
    throw new Error("Analytics acknowledgement mismatch");
  return result;
}
