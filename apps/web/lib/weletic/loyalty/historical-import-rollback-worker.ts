import { prisma } from "@/lib/prisma";
import { Prisma, type WeleticLoyaltyOutboxJob } from "@prisma/client";
import { continueHistoricalImportRollback } from "./historical-import-continuation";
import { verifyHistoricalImportRollbackCompletionInTransaction } from "./historical-import-execution-lease";
import {
  HistoricalImportExecutionContainedError,
  HistoricalImportJobPayloadSchema,
  HistoricalImportLeasePendingError,
  HistoricalImportOutboxClaimSchema,
} from "./historical-import-job-contract";
import { recoverHistoricalImportRollbackFromOutbox } from "./historical-import-recovery";
import { processHistoricalImportRollbackBatch } from "./historical-import-rollback-batch";
import type { HistoricalImportWorkerClaim } from "./historical-import-worker";
import { isLoyaltyMaintenanceBlockedError } from "./maintenance-write-fence";

/** One owned rollback slice. Containment is terminal, not success or an
 * automatic redrive instruction. Generic outbox failures persist no raw fields.
 */
export async function executeHistoricalImportRollbackJob({
  job,
  queueClaim,
}: {
  job: WeleticLoyaltyOutboxJob;
  queueClaim: HistoricalImportWorkerClaim | undefined;
}): Promise<{ historicalImportOutcome: "completed" | "continued" }> {
  try {
    if (job.jobType !== "HISTORICAL_IMPORT_ROLLBACK" || !queueClaim)
      throw new Error("Rollback requires an owned job.");
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
    const completed = await prisma.$transaction(
      (tx) =>
        verifyHistoricalImportRollbackCompletionInTransaction({
          tx,
          scope,
          claim,
        }),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 30_000,
      },
    );
    if (completed) return { historicalImportOutcome: "completed" };
    const recovered = await recoverHistoricalImportRollbackFromOutbox({
      scope,
      claim,
    });
    const batch = await processHistoricalImportRollbackBatch({
      lease: recovered.lease,
      maxRows: 50,
    });
    if (batch.contained) throw new HistoricalImportExecutionContainedError();
    if (batch.completed) return { historicalImportOutcome: "completed" };
    if (batch.processed < 1 || !batch.lease)
      throw new Error("Rollback made no progress.");
    await continueHistoricalImportRollback({ lease: batch.lease });
    return { historicalImportOutcome: "continued" };
  } catch (error) {
    if (
      isLoyaltyMaintenanceBlockedError(error) ||
      error instanceof HistoricalImportLeasePendingError ||
      error instanceof HistoricalImportExecutionContainedError
    )
      throw error;
    throw new Error(
      "Historical import rollback execution failed; reconcile the source before redrive.",
    );
  }
}
