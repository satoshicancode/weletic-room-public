import { z } from "zod";
import { merchantAnalyticsFilterSchema } from "./merchant-analytics-contract";

const instant = z.string().datetime({ offset: true });
const DAY_MS = 86_400_000;
const MAX_UTC_DAYS = 366;
export const MAX_TIER_HISTORY_EXPORT_ROWS = 2_000;

export const merchantTierHistoryExportRequestSchema = z
  .object({
    filter: merchantAnalyticsFilterSchema,
    expectedInstallationGeneration: z.string().min(1).max(64),
  })
  .strict()
  .refine(
    ({ filter }) => {
      if (!filter.startAt || !filter.endAt) return false;
      const first = Date.parse(
        `${new Date(filter.startAt).toISOString().slice(0, 10)}T00:00:00Z`,
      );
      const last = Date.parse(
        `${new Date(filter.endAt).toISOString().slice(0, 10)}T00:00:00Z`,
      );
      const days = Math.floor((last - first) / DAY_MS) + 1;
      return days >= 1 && days <= MAX_UTC_DAYS;
    },
    {
      message: "A UTC range of at most 366 days is required",
      path: ["filter"],
    },
  );

const tierChangeReasonSchema = z.enum([
  "threshold_reached",
  "manual_override",
  "annual_downgrade",
  "bonus_promotion",
  "grace_period_expired",
  "program_activation",
]);

export const merchantTierHistoryExportResponseSchema = z
  .object({
    status: z.enum(["available", "too_large"]),
    coverage: z.literal("retained_nonredacted_tier_events_only"),
    installationGeneration: z.string().min(1).max(64),
    filter: merchantAnalyticsFilterSchema,
    rows: z
      .array(
        z
          .object({
            accountPseudonym: z.string().regex(/^account_[a-f0-9]{32}$/),
            effectiveAt: instant,
            fromTierCurrentName: z.string().nullable(),
            toTierCurrentName: z.string().nullable(),
            changeReason: tierChangeReasonSchema,
          })
          .strict(),
      )
      .max(MAX_TIER_HISTORY_EXPORT_ROWS),
  })
  .strict()
  .refine(({ status, rows }) => status === "available" || rows.length === 0);

export type MerchantTierHistoryExportRequest = z.infer<
  typeof merchantTierHistoryExportRequestSchema
>;
export type MerchantTierHistoryExportResponse = z.infer<
  typeof merchantTierHistoryExportResponseSchema
>;

export function verifyMerchantTierHistoryExportResponse(
  request: MerchantTierHistoryExportRequest,
  value: unknown,
) {
  const result = merchantTierHistoryExportResponseSchema.parse(value);
  if (
    result.installationGeneration !== request.expectedInstallationGeneration ||
    JSON.stringify(result.filter) !== JSON.stringify(request.filter)
  )
    throw new Error("Tier history export response escaped its request");
  return result;
}
