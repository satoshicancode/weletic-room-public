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
  .strict();

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
