import { createWeleticId } from "@/lib/weletic/ids";
import type { Prisma } from "@prisma/client";
import { readHistoricalImportCommitRowInTransaction } from "./historical-import-commit-row";
import { HistoricalImportConflictError } from "./historical-import-persistence";

/** Internal row-transaction step, not an independently committable operation.
 * Caller must verify the immutable manifest before claiming the execution lease,
 * check row-execution idempotency, then retain these locks through opening-balance,
 * field and execution writes. Propagate failures to roll back the whole transaction.
 * Never use normal shopper enrollment here: it may issue synthetic signup rewards.
 */
export async function enrollHistoricalImportAccountInTransaction({
  tx,
  lease,
  snapshotId,
}: {
  tx: Prisma.TransactionClient;
  lease: unknown;
  snapshotId: unknown;
}) {
  const row = await readHistoricalImportCommitRowInTransaction({
    tx,
    lease,
    snapshotId,
  });
  if (row.account)
    return { ...row, account: row.account, accountCreated: false };

  // The reader holds store/program/source/shopper locks and checked both
  // retained-owner and current hashed-identity privacy tombstones. A conflicting
  // unique shopper account creation must abort, never adopt an unchecked account.
  const account = await tx.weleticLoyaltyAccount.create({
    data: {
      id: createWeleticId("wacc_"),
      storeId: row.lease.storeId,
      programId: row.lease.programId,
      shopperId: row.shopper.id,
      status: "active",
      ledgerVersion: 0,
      cachedPointsBalance: BigInt(0),
      cachedPendingPoints: BigInt(0),
      lifetimePointsEarned: BigInt(0),
      lifetimePointsRedeemed: BigInt(0),
    },
  });
  if (
    account.storeId !== row.lease.storeId ||
    account.programId !== row.lease.programId ||
    account.shopperId !== row.shopper.id ||
    account.status !== "active" ||
    account.ledgerVersion !== 0 ||
    account.cachedPointsBalance !== BigInt(0) ||
    account.cachedPendingPoints !== BigInt(0) ||
    account.lifetimePointsEarned !== BigInt(0) ||
    account.lifetimePointsRedeemed !== BigInt(0)
  )
    throw new HistoricalImportConflictError();
  return { ...row, account, accountCreated: true };
}
