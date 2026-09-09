import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { assertHistoricalImportExecutionLeaseInTransaction } from "./historical-import-execution-lease";
import { HistoricalImportConflictError } from "./historical-import-persistence";
import { readHistoricalImportExecutionProofInTransaction } from "./historical-import-reconciliation-service";

/** Internal worker operation, not merchant authorization. Uses a fresh snapshot
 * after locking the active source, preventing concurrent row/containment changes
 * while independent manifest and ledger proof is read. No row or financial writes.
 * An incomplete source stays in progress; corruption/expired ownership throws.
 */
export async function finalizeHistoricalImportExecution({
  lease,
}: {
  lease: unknown;
}) {
  return prisma.$transaction(
    async (tx) => {
      const initial = await assertHistoricalImportExecutionLeaseInTransaction({
        tx,
        lease,
      });
      const scope = initial.lease;
      const proof = await readHistoricalImportExecutionProofInTransaction({
        tx,
        sourceId: scope.sourceId,
        storeId: scope.storeId,
        programId: scope.programId,
      });
      if (
        !proof.summary.reconciled ||
        proof.summary.issues.length ||
        proof.summary.sourceStatus !== scope.phase ||
        proof.summary.rowCount < 1
      )
        throw new HistoricalImportConflictError();
      const complete =
        scope.phase === "committing"
          ? proof.rowsFullyCommitted
          : proof.rowsFullyRolledBack;
      if (!complete) return { finalized: false as const };
      // Reconciliation can take time. Recheck database time/lease immediately
      // before CAS instead of finalizing with ownership that expired during reads.
      const current = await assertHistoricalImportExecutionLeaseInTransaction({
        tx,
        lease,
      });
      if (current.lease.revision >= 2147483647)
        throw new HistoricalImportConflictError();
      const status = scope.phase === "committing" ? "committed" : "rolled_back";
      const changed = await tx.weleticLoyaltyImportSource.updateMany({
        where: {
          id: scope.sourceId,
          storeId: scope.storeId,
          programId: scope.programId,
          installationGeneration: scope.installationGeneration,
          status: scope.phase,
          revision: scope.revision,
          leaseId: scope.leaseId,
          leaseExpiresAt: current.source.leaseExpiresAt,
          normalizedSha256: current.source.normalizedSha256,
        },
        data: {
          status,
          revision: { increment: 1 },
          leaseId: null,
          leaseExpiresAt: null,
          completedAt: current.now,
        },
      });
      if (changed.count !== 1) throw new HistoricalImportConflictError();
      return { finalized: true as const, status };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    },
  );
}
