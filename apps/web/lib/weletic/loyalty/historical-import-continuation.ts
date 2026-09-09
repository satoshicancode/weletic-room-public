import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { assertHistoricalImportExecutionLeaseInTransaction } from "./historical-import-execution-lease";
import { HistoricalImportConflictError } from "./historical-import-persistence";

/** Private worker handoff after a successful bounded commit batch. Requeue the
 * SAME durable job and relinquish source ownership atomically. Never mark this
 * job completed: source completion still requires independent reconciliation.
 * A crash before commit preserves the existing claim for timeout recovery; a
 * crash after commit leaves durable pending work and invalidates the old token.
 */
export function continueHistoricalImportCommit(args: { lease: unknown }) {
  return continueHistoricalImportExecution({ ...args, phase: "committing" });
}
export function continueHistoricalImportRollback(args: { lease: unknown }) {
  return continueHistoricalImportExecution({ ...args, phase: "rolling_back" });
}
async function continueHistoricalImportExecution({
  lease,
  phase,
}: {
  lease: unknown;
  phase: "committing" | "rolling_back";
}) {
  return prisma.$transaction(
    async (tx) => {
      const current = await assertHistoricalImportExecutionLeaseInTransaction({
        tx,
        lease,
      });
      const scope = current.lease;
      const claim = scope.outboxClaim;
      if (!claim || scope.phase !== phase || scope.revision >= 2147483647)
        throw new HistoricalImportConflictError();
      const released = await tx.weleticLoyaltyImportSource.updateMany({
        where: {
          id: scope.sourceId,
          storeId: scope.storeId,
          programId: scope.programId,
          installationGeneration: scope.installationGeneration,
          status: phase,
          revision: scope.revision,
          leaseId: scope.leaseId,
          leaseExpiresAt: current.source.leaseExpiresAt,
        },
        // Retain an expired UUID so the normal verified recovery path can reclaim
        // it. Null lease state is not recovery authority. Revision rotation also
        // invalidates the old private token immediately, without a TTL wait.
        data: { revision: { increment: 1 }, leaseExpiresAt: current.now },
      });
      if (released.count !== 1) throw new HistoricalImportConflictError();
      const queued = await tx.weleticLoyaltyOutboxJob.updateMany({
        where: {
          id: claim.jobId,
          storeId: scope.storeId,
          jobType:
            phase === "committing"
              ? "HISTORICAL_IMPORT_COMMIT"
              : "HISTORICAL_IMPORT_ROLLBACK",
          status: "processing",
          lockedBy: claim.ownerToken,
          lockedAt: claim.claimedAt,
          attempts: claim.attempt,
        },
        data: {
          status: "pending",
          scheduledFor: current.now,
          nextRetryAt: null,
          lockedBy: null,
          lockedAt: null,
          attempts: 0,
          lastError: null,
        },
      });
      if (queued.count !== 1) throw new HistoricalImportConflictError();
      return { continued: true as const };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    },
  );
}
