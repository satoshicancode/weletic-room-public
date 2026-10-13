import { z } from "zod";
import { merchantAnalyticsFilterSchema } from "./merchant-analytics-contract";

const instant = z.string().datetime({ offset: true });
const integer = z.string().regex(/^-?(?:0|[1-9]\d*)$/);
const DAY_MS = 86_400_000;
export const MAX_ACCOUNT_ROW_EXPORT_ROWS = 2_000;

export const merchantAccountRowExportRequestSchema = z
  .object({
    filter: merchantAnalyticsFilterSchema,
    expectedInstallationGeneration: z.string().min(1).max(64),
  })
  .strict()
  .refine(
    ({ filter }) => {
      if (!filter.startAt || !filter.endAt) return false;
      const startDay = Date.parse(
        `${new Date(filter.startAt).toISOString().slice(0, 10)}T00:00:00Z`,
      );
      const endDay = Date.parse(
        `${new Date(filter.endAt).toISOString().slice(0, 10)}T00:00:00Z`,
      );
      const days = Math.floor((endDay - startDay) / DAY_MS) + 1;
      return days >= 1 && days <= 366;
    },
    {
      message: "A UTC range of at most 366 days is required",
      path: ["filter"],
    },
  );

export const merchantAccountRowExportResponseSchema = z
  .object({
    status: z.enum(["available", "too_large"]),
    coverage: z.literal("current_retained_nonredacted_accounts_by_enrollment"),
    installationGeneration: z.string().min(1).max(64),
    filter: merchantAnalyticsFilterSchema,
    rows: z
      .array(
        z
          .object({
            accountPseudonym: z.string().regex(/^account_[a-f0-9]{32}$/),
            enrolledAt: instant,
            accountStatus: z.enum(["active", "suspended", "closed"]),
            currentTierOrder: z.number().int().positive().nullable(),
            cachedPointsBalance: integer,
            cachedPendingPoints: integer,
            lifetimePointsEarned: integer,
            lifetimePointsRedeemed: integer,
          })
          .strict(),
      )
      .max(MAX_ACCOUNT_ROW_EXPORT_ROWS),
  })
  .strict()
  .refine(({ status, rows }) => status === "available" || rows.length === 0);

export type MerchantAccountRowExportRequest = z.infer<
  typeof merchantAccountRowExportRequestSchema
>;
export type MerchantAccountRowExportResponse = z.infer<
  typeof merchantAccountRowExportResponseSchema
>;

export function verifyMerchantAccountRowExportResponse(
  request: MerchantAccountRowExportRequest,
  value: unknown,
) {
  const result = merchantAccountRowExportResponseSchema.parse(value);
  if (
    result.installationGeneration !== request.expectedInstallationGeneration ||
    JSON.stringify(result.filter) !== JSON.stringify(request.filter)
  )
    throw new Error("Account row export response escaped its request");
  return result;
}
