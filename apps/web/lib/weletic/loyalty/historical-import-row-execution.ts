import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import {
  Prisma,
  type WeleticLoyaltyAccount,
  type WeleticLoyaltyImportRowExecution,
} from "@prisma/client";
import { z } from "zod";
import { applyHistoricalImportFieldsInTransaction } from "./historical-import-apply-fields";
import { enrollHistoricalImportAccountInTransaction } from "./historical-import-enrollment";
import { assertHistoricalImportExecutionLeaseInTransaction } from "./historical-import-execution-lease";
import { captureHistoricalImportFields } from "./historical-import-fields";
import {
  IMPORT_OPENING_BALANCE_REFERENCE,
  IMPORT_ROLLBACK_REFERENCE,
  postImportOpeningBalanceInTransaction,
} from "./historical-import-ledger";
import { HistoricalImportConflictError } from "./historical-import-persistence";
import { readHistoricalImportReconciliationInTransaction } from "./historical-import-reconciliation-service";

/** Internal worker entry point, NOT a merchant authorization boundary.
 * The initiating operation must authorize staff and verify the whole immutable
 * manifest before granting the lease. The outbox batch retains private source
 * and queue ownership; no public gateway may invoke this primitive directly.
 * Own the transaction so callers cannot commit enrollment/fields without the
 * ledger and execution record, or supply an older Repeatable Read snapshot.
 */
export async function executeHistoricalImportRow({
  lease,
  snapshotId,
}: {
  lease: unknown;
  snapshotId: unknown;
}) {
  const id = z.string().min(1).max(191).parse(snapshotId);
  return prisma.$transaction(
    async (tx) => {
      const executionLease =
        await assertHistoricalImportExecutionLeaseInTransaction({ tx, lease });
      const scope = executionLease.lease;
      if (scope.phase !== "committing")
        throw new HistoricalImportConflictError();
      const records = await tx.$queryRaw<
        WeleticLoyaltyImportRowExecution[]
      >(Prisma.sql`
      SELECT * FROM WeleticLoyaltyImportRowExecution WHERE snapshotId = ${id} FOR UPDATE
    `);
      if (records.length) {
        const record = records[0];
        if (
          records.length !== 1 ||
          record.snapshotId !== id ||
          record.sourceId !== scope.sourceId ||
          record.storeId !== scope.storeId ||
          record.programId !== scope.programId ||
          record.status !== "committed" ||
          !record.ledgerEntryId ||
          record.reversalLedgerEntryId !== null ||
          !Number.isInteger(record.ledgerVersionBefore) ||
          record.ledgerVersionBefore < 0 ||
          record.ledgerVersionAfter !== record.ledgerVersionBefore + 1 ||
          record.ledgerVersionAfter > 2147483647 ||
          !record.committedAt ||
          record.containmentCode !== null ||
          record.rolledBackAt !== null
        )
          throw new HistoricalImportConflictError();
        // Replays are verified from immutable evidence, not today's wallet or
        // birthday eligibility: subsequent legitimate shopper activity is allowed.
        const evidence = await readHistoricalImportReconciliationInTransaction({
          tx,
          sourceId: scope.sourceId,
          storeId: scope.storeId,
          programId: scope.programId,
        });
        const original = await tx.weleticPointsLedgerEntry.findFirst({
          where: {
            id: record.ledgerEntryId,
            storeId: scope.storeId,
            accountId: record.accountId,
          },
        });
        if (
          !evidence.reconciled ||
          !original ||
          original.sequenceNumber !== record.ledgerVersionAfter
        )
          throw new HistoricalImportConflictError();
        return { executionId: record.id, replayed: true };
      }
      // A financial write without its atomic execution record is corruption, not
      // a resumable pending row. Do not adopt it through ledger idempotency.
      const orphan = await tx.weleticPointsLedgerEntry.findFirst({
        where: {
          OR: [
            {
              idempotencyKey: `loyalty_import_opening:${scope.sourceId}:${id}`,
            },
            {
              idempotencyKey: `loyalty_import_rollback:${scope.sourceId}:${id}`,
            },
            {
              referenceType: {
                in: [
                  IMPORT_OPENING_BALANCE_REFERENCE,
                  IMPORT_ROLLBACK_REFERENCE,
                ],
              },
              referenceId: id,
            },
            {
              AND: [
                { metadata: { path: "$.sourceId", equals: scope.sourceId } },
                { metadata: { path: "$.snapshotId", equals: id } },
              ],
            },
          ],
        },
        select: { id: true },
      });
      if (orphan) throw new HistoricalImportConflictError();
      const enrolled = await enrollHistoricalImportAccountInTransaction({
        tx,
        lease: scope,
        snapshotId: id,
      });
      const fields = await applyHistoricalImportFieldsInTransaction({
        tx,
        lease: scope,
        snapshotId: id,
      });
      const account = enrolled.account;
      const ledger = await postImportOpeningBalanceInTransaction({
        tx,
        storeId: scope.storeId,
        programId: scope.programId,
        accountId: account.id,
        shopperId: enrolled.shopper.id,
        sourceId: scope.sourceId,
        snapshotId: id,
        normalizedSha256: executionLease.source.normalizedSha256,
        openingBalance: BigInt(enrolled.row.openingBalance),
        expectedLedgerVersion: account.ledgerVersion,
      });
      if (
        ledger.storeId !== scope.storeId ||
        ledger.accountId !== account.id ||
        ledger.sequenceNumber !== account.ledgerVersion + 1 ||
        ledger.balanceAfter !== enrolled.balanceAfter ||
        ledger.pointsDelta !== BigInt(enrolled.row.openingBalance) ||
        ledger.pendingDelta !== BigInt(0) ||
        ledger.grantId !== null
      )
        throw new HistoricalImportConflictError();
      const finalAccounts = await tx.$queryRaw<
        WeleticLoyaltyAccount[]
      >(Prisma.sql`
      SELECT * FROM WeleticLoyaltyAccount
      WHERE id = ${account.id} AND storeId = ${scope.storeId} AND programId = ${scope.programId}
      FOR UPDATE
    `);
      const finalAccount = finalAccounts[0];
      if (
        finalAccounts.length !== 1 ||
        finalAccount.id !== account.id ||
        finalAccount.storeId !== scope.storeId ||
        finalAccount.programId !== scope.programId ||
        finalAccount.shopperId !== enrolled.shopper.id ||
        finalAccount.status !== "active" ||
        finalAccount.ledgerVersion !== ledger.sequenceNumber ||
        finalAccount.cachedPointsBalance !== ledger.balanceAfter ||
        finalAccount.cachedPendingPoints !== account.cachedPendingPoints ||
        finalAccount.lifetimePointsEarned !== account.lifetimePointsEarned ||
        finalAccount.lifetimePointsRedeemed !== account.lifetimePointsRedeemed
      )
        throw new HistoricalImportConflictError();
      // This captures expiry changes made by the ledger, not intermediate fields.
      // The normal expiry sweep will schedule from the ledger's durable null marker.
      const finalFields = captureHistoricalImportFields(finalAccount);
      const executionId = createWeleticId("wlimpr_");
      await tx.weleticLoyaltyImportRowExecution.create({
        data: {
          id: executionId,
          sourceId: scope.sourceId,
          snapshotId: id,
          storeId: scope.storeId,
          programId: scope.programId,
          accountId: account.id,
          status: "committed",
          ledgerEntryId: ledger.id,
          ledgerVersionBefore: account.ledgerVersion,
          ledgerVersionAfter: ledger.sequenceNumber,
          fieldStateBefore: fields.before as Prisma.InputJsonValue,
          fieldStateAfter: finalFields as Prisma.InputJsonValue,
          committedAt: executionLease.now,
        },
      });
      return { executionId, replayed: false };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 30_000,
    },
  );
}
