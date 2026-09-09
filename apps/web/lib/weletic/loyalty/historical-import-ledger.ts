import { Prisma, type WeleticLoyaltyAccount } from "@prisma/client";
import { appendPointsLedgerEntry } from "./ledger";
import { hasShopifyCustomerRedactionTombstone } from "./shopper-privacy";

export const IMPORT_OPENING_BALANCE_REFERENCE =
  "LOYALTY_IMPORT_OPENING_BALANCE";
export const IMPORT_ROLLBACK_REFERENCE = "LOYALTY_IMPORT_ROLLBACK";

export class HistoricalImportRollbackContainedError extends Error {
  constructor() {
    super("Historical import rollback requires containment");
    this.name = "HistoricalImportRollbackContainedError";
  }
}

/**
 * Financial primitive only. The orchestrator must first authorize staff, lock
 * store/program/source, verify immutable snapshots and resolve a privacy-eligible
 * shopper. Birthday/tier changes and durable row execution belong in that same
 * transaction. This function never emits earn events or evaluates VIP rewards.
 */
export async function postImportOpeningBalanceInTransaction({
  tx,
  storeId,
  programId,
  accountId,
  shopperId,
  sourceId,
  snapshotId,
  normalizedSha256,
  openingBalance,
  expectedLedgerVersion,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  programId: string;
  accountId: string;
  shopperId: string;
  sourceId: string;
  snapshotId: string;
  normalizedSha256: string;
  openingBalance: bigint;
  expectedLedgerVersion: number;
}) {
  if (
    typeof openingBalance !== "bigint" ||
    openingBalance < BigInt(0) ||
    openingBalance > BigInt("9223372036854775807") ||
    !Number.isInteger(expectedLedgerVersion) ||
    expectedLedgerVersion < 0 ||
    expectedLedgerVersion >= 2147483647 ||
    !/^[a-f0-9]{64}$/.test(normalizedSha256)
  )
    throw new Error("Invalid opening-balance ledger input");
  const locked = await tx.$queryRaw<
    Array<
      Pick<
        WeleticLoyaltyAccount,
        | "id"
        | "storeId"
        | "programId"
        | "shopperId"
        | "status"
        | "metadata"
        | "ledgerVersion"
        | "cachedPointsBalance"
      >
    >
  >(Prisma.sql`
    SELECT id, storeId, programId, shopperId, status, metadata,
      ledgerVersion, cachedPointsBalance FROM WeleticLoyaltyAccount
    WHERE id = ${accountId} AND storeId = ${storeId} AND programId = ${programId}
    FOR UPDATE
  `);
  if (locked.length !== 1 || locked[0].id !== accountId)
    throw new Error("Opening-balance account unavailable");
  // Use the current locking read, not a Repeatable Read MVCC snapshot that
  // could predate a privacy closure without a ledger-version increment.
  const account = locked[0];
  if (
    !account ||
    account.storeId !== storeId ||
    account.programId !== programId ||
    account.shopperId !== shopperId ||
    account.status !== "active" ||
    hasShopifyCustomerRedactionTombstone(account.metadata)
  )
    throw new Error("Opening-balance account unavailable");
  // Do not rely on appendPointsLedgerEntry.expectedLedgerVersion: the existing
  // primitive does not enforce that optional field. Verify under our row lock.
  if (account.ledgerVersion !== expectedLedgerVersion)
    throw new Error("Opening-balance account revision changed");
  const balanceAfter = account.cachedPointsBalance + openingBalance;
  if (
    balanceAfter > BigInt("9223372036854775807") ||
    balanceAfter < BigInt("-9223372036854775808")
  )
    throw new Error("Opening-balance account would overflow");
  return appendPointsLedgerEntry({
    tx,
    storeId,
    accountId,
    entryType: "MANUAL_ADJUSTMENT",
    pointsDelta: openingBalance,
    pendingDelta: BigInt(0),
    referenceType: IMPORT_OPENING_BALANCE_REFERENCE,
    referenceId: snapshotId,
    idempotencyKey: `loyalty_import_opening:${sourceId}:${snapshotId}`,
    reason: "Historical opening balance",
    metadata: { sourceId, snapshotId, normalizedSha256 },
  });
}

/**
 * Append-only financial reversal. Caller owns auth/store/program/source locks,
 * verified execution evidence and birthday/tier/expiry-state restoration in the
 * same transaction. Any later ledger activity contains this automatic rollback.
 */
export async function reverseImportOpeningBalanceInTransaction({
  tx,
  storeId,
  programId,
  accountId,
  shopperId,
  sourceId,
  snapshotId,
  normalizedSha256,
  openingBalance,
  originalLedgerEntryId,
  expectedLedgerVersion,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  programId: string;
  accountId: string;
  shopperId: string;
  sourceId: string;
  snapshotId: string;
  normalizedSha256: string;
  openingBalance: bigint;
  originalLedgerEntryId: string;
  expectedLedgerVersion: number;
}) {
  const contain = () => {
    throw new HistoricalImportRollbackContainedError();
  };
  if (
    typeof openingBalance !== "bigint" ||
    openingBalance < BigInt(0) ||
    openingBalance > BigInt("9223372036854775807") ||
    !Number.isInteger(expectedLedgerVersion) ||
    expectedLedgerVersion < 1 ||
    expectedLedgerVersion >= 2147483647 ||
    !/^[a-f0-9]{64}$/.test(normalizedSha256)
  )
    return contain();
  const accounts = await tx.$queryRaw<
    Array<
      Pick<
        WeleticLoyaltyAccount,
        | "id"
        | "storeId"
        | "programId"
        | "shopperId"
        | "status"
        | "metadata"
        | "ledgerVersion"
        | "cachedPointsBalance"
      >
    >
  >(Prisma.sql`
    SELECT id, storeId, programId, shopperId, status, metadata,
      ledgerVersion, cachedPointsBalance FROM WeleticLoyaltyAccount
    WHERE id = ${accountId} AND storeId = ${storeId} AND programId = ${programId}
    FOR UPDATE
  `);
  const account = accounts[0];
  if (
    accounts.length !== 1 ||
    account.id !== accountId ||
    account.storeId !== storeId ||
    account.programId !== programId ||
    account.shopperId !== shopperId ||
    account.status !== "active" ||
    hasShopifyCustomerRedactionTombstone(account.metadata) ||
    account.ledgerVersion !== expectedLedgerVersion
  )
    return contain();
  const original = await tx.weleticPointsLedgerEntry.findFirst({
    where: { id: originalLedgerEntryId, storeId, accountId },
  });
  const metadata = original?.metadata;
  if (
    !original ||
    original.entryType !== "MANUAL_ADJUSTMENT" ||
    original.referenceType !== IMPORT_OPENING_BALANCE_REFERENCE ||
    original.referenceId !== snapshotId ||
    original.idempotencyKey !==
      `loyalty_import_opening:${sourceId}:${snapshotId}` ||
    original.pointsDelta !== openingBalance ||
    original.pendingDelta !== BigInt(0) ||
    original.grantId !== null ||
    original.sequenceNumber !== expectedLedgerVersion ||
    original.balanceAfter !== account.cachedPointsBalance ||
    !metadata ||
    typeof metadata !== "object" ||
    Array.isArray(metadata) ||
    metadata.sourceId !== sourceId ||
    metadata.snapshotId !== snapshotId ||
    metadata.normalizedSha256 !== normalizedSha256
  )
    return contain();
  const restoredBalance = account.cachedPointsBalance - openingBalance;
  if (
    restoredBalance < BigInt("-9223372036854775808") ||
    restoredBalance > BigInt("9223372036854775807")
  )
    return contain();
  return appendPointsLedgerEntry({
    tx,
    storeId,
    accountId,
    entryType: "MANUAL_ADJUSTMENT",
    pointsDelta: -openingBalance,
    pendingDelta: BigInt(0),
    referenceType: IMPORT_ROLLBACK_REFERENCE,
    referenceId: snapshotId,
    idempotencyKey: `loyalty_import_rollback:${sourceId}:${snapshotId}`,
    reason: "Historical opening balance rollback",
    metadata: { sourceId, snapshotId, normalizedSha256, originalLedgerEntryId },
  });
}
