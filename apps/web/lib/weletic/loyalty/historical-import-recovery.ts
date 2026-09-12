import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import {
  assertHistoricalImportExecutionLeaseInTransaction,
  recoverHistoricalImportCommitLeaseInTransaction,
  recoverHistoricalImportRollbackLeaseInTransaction,
} from "./historical-import-execution-lease";
import { HistoricalImportOutboxClaimSchema } from "./historical-import-job-contract";

/** Internal supervisor boundary, not a public API or merchant authorization.
 * Scope must come from trusted durable work. Own the transaction so a prior
 * repeatable-read snapshot cannot hide completed rows during recovery proof.
 * Returns private lease material; never serialize it to a shopper or merchant.
 * No scheduler invokes this until dispatch and schema release gates pass.
 */
export async function recoverHistoricalImportCommit({
  scope,
}: {
  scope: unknown;
}) {
  return prisma.$transaction(
    (tx) => recoverHistoricalImportCommitLeaseInTransaction({ tx, scope }),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    },
  );
}

/** Outbox-only recovery: source recovery and claim binding commit together.
 * A replaced/cancelled queue owner aborts the new source lease. Every subsequent
 * row, renewal and finalization rechecks this private binding under locks.
 */
export async function recoverHistoricalImportCommitFromOutbox({
  scope,
  claim,
}: {
  scope: unknown;
  claim: unknown;
}) {
  const outboxClaim = HistoricalImportOutboxClaimSchema.parse(claim);
  return prisma.$transaction(
    async (tx) => {
      const recovered = await recoverHistoricalImportCommitLeaseInTransaction({
        tx,
        scope,
      });
      const lease = { ...recovered.lease, outboxClaim };
      await assertHistoricalImportExecutionLeaseInTransaction({ tx, lease });
      return { lease, expiresAt: recovered.expiresAt };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    },
  );
}

export async function recoverHistoricalImportRollbackFromOutbox({
  scope,
  claim,
}: {
  scope: unknown;
  claim: unknown;
}) {
  const outboxClaim = HistoricalImportOutboxClaimSchema.parse(claim);
  return prisma.$transaction(
    async (tx) => {
      const recovered = await recoverHistoricalImportRollbackLeaseInTransaction(
        { tx, scope },
      );
      const lease = { ...recovered.lease, outboxClaim };
      await assertHistoricalImportExecutionLeaseInTransaction({ tx, lease });
      return { lease, expiresAt: recovered.expiresAt };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    },
  );
}
