import { z } from "zod";

export class HistoricalImportExecutionContainedError extends Error {
  constructor() {
    super(
      "Historical import execution is contained; manual reconciliation is required.",
    );
    this.name = "HistoricalImportExecutionContainedError";
  }
}

export class HistoricalImportLeasePendingError extends Error {
  readonly retryAt: Date;
  constructor(retryAt: Date) {
    super("Historical import source ownership has not expired.");
    this.name = "HistoricalImportLeasePendingError";
    this.retryAt = new Date(z.date().parse(retryAt));
  }
}

export const HistoricalImportJobPayloadSchema = z
  .object({
    sourceId: z.string().min(1).max(191),
    programId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
    sourceRevision: z.number().int().min(0).max(2147483647),
  })
  .strict();
export type HistoricalImportJobPayload = z.infer<
  typeof HistoricalImportJobPayloadSchema
>;

/** Private, process-local ownership proof. Never persist in job payloads or
 * expose to merchant/customer APIs. Outbox claims are checked by locking reads. */
export const HistoricalImportOutboxClaimSchema = z
  .object({
    jobId: z.string().min(1).max(191),
    ownerToken: z.string().min(1).max(191),
    claimedAt: z.date(),
    attempt: z.number().int().min(1).max(2147483647),
    sourceRevision: z.number().int().min(0).max(2147483647),
  })
  .strict();
export type HistoricalImportOutboxClaim = z.infer<
  typeof HistoricalImportOutboxClaimSchema
>;
// Soft delivery budget, checked only between atomic rows. A slow row is never
// aborted halfway through accounting/containment. Retain room for recovery and
// continuation within the outbox's default five-minute claim window.
export const HISTORICAL_IMPORT_BATCH_TARGET_MS = 30_000;
