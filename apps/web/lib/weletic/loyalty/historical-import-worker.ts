import { prisma } from "@/lib/prisma";
import { Prisma, type WeleticLoyaltyOutboxJob } from "@prisma/client";
import { processHistoricalImportCommitBatch } from "./historical-import-commit-batch";
import { continueHistoricalImportCommit } from "./historical-import-continuation";
import { verifyHistoricalImportCommitCompletionInTransaction } from "./historical-import-execution-lease";
import {
  HistoricalImportExecutionContainedError,
  HistoricalImportJobPayloadSchema,
  HistoricalImportLeasePendingError,
  HistoricalImportOutboxClaimSchema,
} from "./historical-import-job-contract";
import { recoverHistoricalImportCommitFromOutbox } from "./historical-import-recovery";
import { isLoyaltyMaintenanceBlockedError } from "./maintenance-write-fence";

export type HistoricalImportWorkerClaim = {
  ownerToken: string;
  claimedAt: Date;
  attempt: number;
};

/** The outbox owns claiming, retry/backoff and dead letters. This handler owns
 * one bounded source batch, never an unauthenticated or process-local import.
 * Continuation already requeues the job atomically and MUST NOT be acknowledged
 * by the generic completion path. Nothing here starts a timer or scheduler.
 */
export async function executeHistoricalImportCommitJob({
  job,
  queueClaim,
}: {
  job: WeleticLoyaltyOutboxJob;
  queueClaim: HistoricalImportWorkerClaim | undefined;
}): Promise<{ historicalImportOutcome: "completed" | "continued" }> {
  try {
    if (job.jobType !== "HISTORICAL_IMPORT_COMMIT" || !queueClaim)
      throw new Error("Import requires an owned commit job.");
    const payload = HistoricalImportJobPayloadSchema.parse(job.payload);
    const claim = HistoricalImportOutboxClaimSchema.parse({
      ...queueClaim,
      jobId: job.id,
      sourceRevision: payload.sourceRevision,
    });
    const scope = {
      storeId: job.storeId,
      programId: payload.programId,
      sourceId: payload.sourceId,
      installationGeneration: payload.installationGeneration,
    };
    const alreadyCompleted = await prisma.$transaction(
      (tx) =>
        verifyHistoricalImportCommitCompletionInTransaction({
          tx,
          scope,
          claim,
        }),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 30_000,
      },
    );
    if (alreadyCompleted) return { historicalImportOutcome: "completed" };
    const recovered = await recoverHistoricalImportCommitFromOutbox({
      scope,
      claim,
    });
    const batch = await processHistoricalImportCommitBatch({
      lease: recovered.lease,
      maxRows: 50,
    });
    if (batch.completed) return { historicalImportOutcome: "completed" };
    // Only actual successful progress resets the failure budget. A no-progress
    // source must fail/reconcile, not create an infinite successful retry loop.
    if (batch.processed < 1 || !batch.lease)
      throw new Error("Import made no progress.");
    await continueHistoricalImportCommit({ lease: batch.lease });
    return { historicalImportOutcome: "continued" };
  } catch (error) {
    if (
      isLoyaltyMaintenanceBlockedError(error) ||
      error instanceof HistoricalImportLeasePendingError ||
      error instanceof HistoricalImportExecutionContainedError
    )
      throw error;
    // The generic outbox records error.message. Do not persist Prisma input,
    // shopper identifiers, signed material or lease secrets from nested errors.
    throw new Error(
      "Historical import commit execution failed; reconcile the source before redrive.",
    );
  }
}
