import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import {
  Prisma,
  type WeleticLoyaltyAccount,
  type WeleticLoyaltyImportRowExecution,
} from "@prisma/client";
import { z } from "zod";
import { assertHistoricalImportExecutionLeaseInTransaction } from "./historical-import-execution-lease";
import {
  HistoricalImportRollbackContainedError,
  reverseImportOpeningBalanceInTransaction,
} from "./historical-import-ledger";
import { HistoricalImportConflictError } from "./historical-import-persistence";
import { readHistoricalImportExecutionProofInTransaction } from "./historical-import-reconciliation-service";
import { prepareHistoricalImportFieldRollback } from "./historical-import-rollback-fields";

const options = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  timeout: 30_000,
};

export const HISTORICAL_IMPORT_ROLLBACK_TRANSACTION_ROWS = 10;

/** Private atomic rollback row. Never delete the opening entry or enrollment.
 * Field preparation, financial correction, job cancellation, tier history and
 * execution acknowledgement commit together. Containment is recorded only in
 * a fresh transaction AFTER a failed correction transaction has fully aborted.
 */
export async function rollbackHistoricalImportRow({
  lease,
  snapshotId,
}: {
  lease: unknown;
  snapshotId: unknown;
}) {
  const result = await rollbackHistoricalImportRows({
    lease,
    snapshotIds: [snapshotId],
  });
  return result.results[0];
}

/** One fresh locked transaction and full-source proof per bounded group. Never
 * reuse the proof across transactions. A failure aborts the entire group before
 * a separate same-lease transaction may contain the conflicting row. */
export async function rollbackHistoricalImportRows({
  lease,
  snapshotIds,
}: {
  lease: unknown;
  snapshotIds: unknown;
}) {
  const ids = z
    .array(z.string().min(1).max(191))
    .min(1)
    .max(HISTORICAL_IMPORT_ROLLBACK_TRANSACTION_ROWS)
    .refine((values) => new Set(values).size === values.length)
    .parse(snapshotIds);
  let failingId: string | null = null;
  try {
    return await prisma.$transaction(async (tx) => {
      const current = await assertHistoricalImportExecutionLeaseInTransaction({
        tx,
        lease,
      });
      const scope = current.lease;
      if (scope.phase !== "rolling_back")
        throw new HistoricalImportConflictError();
      const proof = await readHistoricalImportExecutionProofInTransaction({
        tx,
        ...scope,
      });
      if (
        !proof.summary.reconciled ||
        proof.summary.issues.length ||
        proof.summary.sourceStatus !== "rolling_back" ||
        proof.rowStates.some(
          (state) => state !== "committed" && state !== "rolled_back",
        ) ||
        proof.sourceRevision !== scope.revision ||
        proof.sourceInstallationGeneration !== scope.installationGeneration ||
        proof.normalizedSha256 !== current.source.normalizedSha256
      )
        throw new HistoricalImportConflictError();
      const results: Array<{
        executionId: string;
        replayed: boolean;
        contained: boolean;
      }> = [];
      for (const id of ids) {
        failingId = id;
        const records = await tx.$queryRaw<
          WeleticLoyaltyImportRowExecution[]
        >(Prisma.sql`
        SELECT * FROM WeleticLoyaltyImportRowExecution
        WHERE snapshotId = ${id} AND sourceId = ${scope.sourceId} AND storeId = ${scope.storeId} AND programId = ${scope.programId} FOR UPDATE
      `);
        const record = records[0];
        if (
          records.length !== 1 ||
          record.snapshotId !== id ||
          record.sourceId !== scope.sourceId ||
          record.storeId !== scope.storeId ||
          record.programId !== scope.programId ||
          !record.ledgerEntryId ||
          !Number.isInteger(record.ledgerVersionBefore) ||
          record.ledgerVersionBefore < 0 ||
          record.ledgerVersionAfter !== record.ledgerVersionBefore + 1 ||
          record.containmentCode !== null
        )
          throw new HistoricalImportConflictError();
        if (record.status === "rolled_back") {
          if (!record.reversalLedgerEntryId || !record.rolledBackAt)
            throw new HistoricalImportConflictError();
          results.push({
            executionId: record.id,
            replayed: true,
            contained: false,
          });
          continue;
        }
        if (
          record.status !== "committed" ||
          record.reversalLedgerEntryId !== null ||
          record.rolledBackAt !== null
        )
          throw new HistoricalImportConflictError();
        const snapshot = await tx.weleticLoyaltyImportRowSnapshot.findFirst({
          where: {
            id,
            sourceId: scope.sourceId,
            storeId: scope.storeId,
            programId: scope.programId,
            redactedAt: null,
          },
        });
        if (!snapshot) throw new HistoricalImportConflictError();
        const accounts = await tx.$queryRaw<WeleticLoyaltyAccount[]>(Prisma.sql`
        SELECT * FROM WeleticLoyaltyAccount WHERE id = ${record.accountId} AND storeId = ${scope.storeId} AND programId = ${scope.programId} FOR UPDATE
      `);
        const account = accounts[0];
        if (
          accounts.length !== 1 ||
          account.id !== record.accountId ||
          account.storeId !== scope.storeId ||
          account.programId !== scope.programId
        )
          throw new HistoricalImportConflictError();
        const fields = await prepareHistoricalImportFieldRollback({
          tx,
          account,
          execution: record,
          installationGeneration: scope.installationGeneration,
        });
        const correction = await reverseImportOpeningBalanceInTransaction({
          tx,
          storeId: scope.storeId,
          programId: scope.programId,
          accountId: account.id,
          shopperId: account.shopperId,
          sourceId: scope.sourceId,
          snapshotId: id,
          normalizedSha256: current.source.normalizedSha256,
          openingBalance: snapshot.openingBalance,
          originalLedgerEntryId: record.ledgerEntryId,
          expectedLedgerVersion: record.ledgerVersionAfter,
        });
        if (
          correction.sequenceNumber !== record.ledgerVersionAfter + 1 ||
          correction.accountId !== account.id ||
          correction.storeId !== scope.storeId ||
          correction.pointsDelta !== -snapshot.openingBalance ||
          correction.pendingDelta !== BigInt(0) ||
          correction.balanceAfter !==
            account.cachedPointsBalance - snapshot.openingBalance
        )
          throw new HistoricalImportConflictError();
        const restored = await tx.weleticLoyaltyAccount.updateMany({
          where: {
            id: account.id,
            storeId: scope.storeId,
            programId: scope.programId,
            status: "active",
            ledgerVersion: correction.sequenceNumber,
          },
          data: fields.patch,
        });
        if (restored.count !== 1) throw new HistoricalImportConflictError();
        if (fields.tierTransition)
          await tx.weleticLoyaltyTierHistory.create({
            data: {
              id: createWeleticId("wtier_"),
              accountId: account.id,
              ...fields.tierTransition,
              changeReason: "manual_override",
              notes: `Historical import rollback ${scope.sourceId}, row ${id}`,
              qualifyingSpendSnapshot: account.tierSpendRolling12Months,
              qualifyingPointsSnapshot: account.tierPointsRolling12Months,
              effectiveAt: current.now,
            },
          });
        if (fields.birthdayJobId) {
          const cancelled = await tx.weleticLoyaltyOutboxJob.updateMany({
            where: {
              id: fields.birthdayJobId,
              storeId: scope.storeId,
              jobType: "BIRTHDAY_REWARD",
              status: { in: ["pending", "failed", "dead_letter"] },
              lockedAt: null,
              lockedBy: null,
            },
            data: { status: "cancelled" },
          });
          if (cancelled.count !== 1) throw new HistoricalImportConflictError();
        }
        const changed = await tx.weleticLoyaltyImportRowExecution.updateMany({
          where: {
            id: record.id,
            snapshotId: id,
            sourceId: scope.sourceId,
            storeId: scope.storeId,
            programId: scope.programId,
            status: "committed",
            ledgerEntryId: record.ledgerEntryId,
            ledgerVersionAfter: record.ledgerVersionAfter,
            reversalLedgerEntryId: null,
          },
          data: {
            status: "rolled_back",
            reversalLedgerEntryId: correction.id,
            rolledBackAt: current.now,
          },
        });
        if (changed.count !== 1) throw new HistoricalImportConflictError();
        results.push({
          executionId: record.id,
          replayed: false,
          contained: false,
        });
      }
      // Expired leases or queue ownership changes must abort the whole group,
      // including when full-source verification used most of its lifetime.
      await assertHistoricalImportExecutionLeaseInTransaction({ tx, lease });
      return { results, contained: false };
    }, options);
  } catch (error) {
    if (!(error instanceof HistoricalImportRollbackContainedError)) throw error;
    if (failingId === null) throw new HistoricalImportConflictError();
    const id = failingId;
    return prisma.$transaction(async (tx) => {
      const current = await assertHistoricalImportExecutionLeaseInTransaction({
        tx,
        lease,
      });
      const scope = current.lease;
      if (scope.phase !== "rolling_back" || scope.revision >= 2147483647)
        throw new HistoricalImportConflictError();
      const record = await tx.weleticLoyaltyImportRowExecution.findFirst({
        where: {
          snapshotId: id,
          sourceId: scope.sourceId,
          storeId: scope.storeId,
          programId: scope.programId,
          status: "committed",
          reversalLedgerEntryId: null,
        },
      });
      if (!record) throw new HistoricalImportConflictError();
      const contained = await tx.weleticLoyaltyImportRowExecution.updateMany({
        where: {
          id: record.id,
          status: "committed",
          reversalLedgerEntryId: null,
        },
        data: {
          status: "contained",
          containmentCode: "automatic_rollback_conflict",
        },
      });
      const stopped = await tx.weleticLoyaltyImportSource.updateMany({
        where: {
          id: scope.sourceId,
          storeId: scope.storeId,
          programId: scope.programId,
          installationGeneration: scope.installationGeneration,
          status: "rolling_back",
          revision: scope.revision,
          leaseId: scope.leaseId,
        },
        data: {
          status: "contained",
          revision: { increment: 1 },
          leaseId: null,
          leaseExpiresAt: null,
        },
      });
      if (contained.count !== 1 || stopped.count !== 1)
        throw new HistoricalImportConflictError();
      return {
        results: [{ executionId: record.id, replayed: false, contained: true }],
        contained: true,
      };
    }, options);
  }
}
