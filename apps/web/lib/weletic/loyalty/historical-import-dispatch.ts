import type { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { claimHistoricalImportExecutionLeaseInTransaction } from "./historical-import-execution-lease";
import { HistoricalImportConflictError } from "./historical-import-persistence";
import { enqueueOutboxJobFromProgramTransaction } from "./outbox";

/** Internal initial-commit dispatch, not merchant authorization. The caller must
 * authorize the actor and verify preview state in this same fresh transaction.
 * No worker token escapes this function or enters the durable payload.
 * A worker may recover the source only after this initiating lease expires;
 * scheduling at that database-derived time avoids consuming retries waiting for
 * ownership. The dispatcher must still recheck ownership at execution time.
 */
type DispatchRequest = {
  tx: Prisma.TransactionClient;
  request: {
    storeId: string;
    programId: string;
    sourceId: string;
    installationGeneration: string;
    expectedRevision: string;
  };
};
export function queueHistoricalImportCommitInTransaction(
  args: DispatchRequest,
) {
  return queueHistoricalImportInTransaction({ ...args, phase: "committing" });
}
export function queueHistoricalImportRollbackInTransaction(
  args: DispatchRequest,
) {
  return queueHistoricalImportInTransaction({ ...args, phase: "rolling_back" });
}
async function queueHistoricalImportInTransaction({
  tx,
  request,
  phase,
}: DispatchRequest & { phase: "committing" | "rolling_back" }) {
  const { lease, expiresAt } =
    await claimHistoricalImportExecutionLeaseInTransaction({
      tx,
      request: { ...request, phase },
    });
  const payload = {
    sourceId: lease.sourceId,
    programId: lease.programId,
    installationGeneration: lease.installationGeneration,
    sourceRevision: lease.revision,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify([lease.storeId, payload]))
    .digest("hex");
  const queued = await enqueueOutboxJobFromProgramTransaction({
    tx,
    storeId: lease.storeId,
    jobType:
      phase === "committing"
        ? "HISTORICAL_IMPORT_COMMIT"
        : "HISTORICAL_IMPORT_ROLLBACK",
    payload,
    idempotencyKey: `historical-import-${phase === "committing" ? "commit" : "rollback"}:${digest}`,
    scheduledFor: expiresAt,
  });
  // This transaction just advanced a preview source. An existing job for its
  // new revision cannot be a valid initial dispatch, regardless of its status.
  // Do not accept the shared enqueue helper's generic duplicate-key shortcut.
  if (!queued.created) throw new HistoricalImportConflictError();
  return { sourceId: lease.sourceId, status: phase };
}
