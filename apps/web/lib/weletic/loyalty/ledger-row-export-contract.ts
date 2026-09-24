import { z } from "zod";
import { merchantAnalyticsFilterSchema } from "./merchant-analytics-contract";

const instant = z.string().datetime({ offset: true });
const integer = z.string().regex(/^-?(?:0|[1-9]\d*)$/);
const DAY_MS = 86_400_000;
export const MAX_LEDGER_ROW_EXPORT_ROWS = 2_000;

export const merchantLedgerRowExportRequestSchema = z
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
      return days >= 1 && days <= 366;
    },
    {
      message: "A UTC range of at most 366 days is required",
      path: ["filter"],
    },
  );

const ledgerEntryType = z.enum([
  "EARN_ORDER",
  "EARN_REFERRAL",
  "EARN_BONUS",
  "REDEEM_REWARD",
  "REFUND_REVERSAL",
  "MANUAL_ADJUSTMENT",
  "EXPIRATION",
  "BACKFILL",
  "BACKFILL_CORRECTION",
  "TIER_BONUS",
]);

export const merchantLedgerRowExportResponseSchema = z
  .object({
    status: z.enum(["available", "too_large"]),
    coverage: z.literal("retained_nonredacted_ledger_entries_only"),
    installationGeneration: z.string().min(1).max(64),
    filter: merchantAnalyticsFilterSchema,
    rows: z
      .array(
        z
          .object({
            accountPseudonym: z.string().regex(/^account_[a-f0-9]{32}$/),
            sequenceNumber: z.number().int().positive(),
            createdAt: instant,
            entryType: ledgerEntryType,
            pointsDelta: integer,
            pendingDelta: integer,
            balanceAfter: integer,
          })
          .strict(),
      )
      .max(MAX_LEDGER_ROW_EXPORT_ROWS),
  })
  .strict()
  .refine(({ status, rows }) => status === "available" || rows.length === 0);

export type MerchantLedgerRowExportRequest = z.infer<
  typeof merchantLedgerRowExportRequestSchema
>;
export type MerchantLedgerRowExportResponse = z.infer<
  typeof merchantLedgerRowExportResponseSchema
>;

export function verifyMerchantLedgerRowExportResponse(
  request: MerchantLedgerRowExportRequest,
  value: unknown,
) {
  const result = merchantLedgerRowExportResponseSchema.parse(value);
  if (
    result.installationGeneration !== request.expectedInstallationGeneration ||
    JSON.stringify(result.filter) !== JSON.stringify(request.filter)
  )
    throw new Error("Ledger row export response escaped its request");
  return result;
}
