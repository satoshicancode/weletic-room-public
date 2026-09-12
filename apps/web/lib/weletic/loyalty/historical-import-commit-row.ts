import { deriveAllShopifyCustomerPrivacyIdentities } from "@/lib/weletic/shopify/privacy-identity";
import {
  Prisma,
  type WeleticLoyaltyAccount,
  type WeleticLoyaltyImportRowSnapshot,
} from "@prisma/client";
import { z } from "zod";
import {
  HISTORICAL_IMPORT_MAX_SOURCE_ROWS,
  historicalImportRowSchema,
} from "./historical-import-contract";
import { assertHistoricalImportExecutionLeaseInTransaction } from "./historical-import-execution-lease";
import { planHistoricalImportBirthday } from "./historical-import-fields";
import { HistoricalImportConflictError } from "./historical-import-persistence";
import { hasShopifyCustomerRedactionTombstone } from "./shopper-privacy";

/** Current row validation, not a financial mutation. The initiating orchestrator
 * must verify the WHOLE immutable manifest before it grants this execution lease.
 * Retain this transaction's locks through enrollment/ledger/field/execution writes.
 * No caller-provided customer, balance, birthday or tier values are accepted. */
export async function readHistoricalImportCommitRowInTransaction({
  tx,
  lease,
  snapshotId,
}: {
  tx: Prisma.TransactionClient;
  lease: unknown;
  snapshotId: unknown;
}) {
  const id = z.string().min(1).max(191).parse(snapshotId);
  const execution = await assertHistoricalImportExecutionLeaseInTransaction({
    tx,
    lease,
  });
  const scope = execution.lease;
  if (scope.phase !== "committing") throw new HistoricalImportConflictError();
  const snapshots = await tx.$queryRaw<
    WeleticLoyaltyImportRowSnapshot[]
  >(Prisma.sql`
    SELECT * FROM WeleticLoyaltyImportRowSnapshot
    WHERE id = ${id} AND sourceId = ${scope.sourceId}
      AND storeId = ${scope.storeId} AND programId = ${scope.programId}
    FOR UPDATE
  `);
  const snapshot = snapshots[0];
  if (
    snapshots.length !== 1 ||
    snapshot.id !== id ||
    snapshot.sourceId !== scope.sourceId ||
    snapshot.storeId !== scope.storeId ||
    snapshot.programId !== scope.programId ||
    snapshot.redactedAt !== null ||
    typeof snapshot.openingBalance !== "bigint" ||
    !Number.isInteger(snapshot.rowNumber) ||
    snapshot.rowNumber < 1 ||
    snapshot.rowNumber > HISTORICAL_IMPORT_MAX_SOURCE_ROWS ||
    (snapshot.birthdayMonth === null) !== (snapshot.birthdayDay === null)
  )
    throw new HistoricalImportConflictError();
  const parsed = historicalImportRowSchema.safeParse({
    shopifyCustomerId: snapshot.shopifyCustomerId,
    openingBalance: snapshot.openingBalance.toString(),
    ...(snapshot.birthdayMonth === null
      ? {}
      : {
          birthday: {
            month: snapshot.birthdayMonth,
            day: snapshot.birthdayDay,
          },
        }),
    ...(snapshot.tierId === null ? {} : { tierId: snapshot.tierId }),
  });
  if (!parsed.success) throw new HistoricalImportConflictError();
  const row = parsed.data;
  const numericId = row.shopifyCustomerId.slice(
    "gid://shopify/Customer/".length,
  );
  const shoppers = await tx.$queryRaw<
    Array<{
      id: string;
      storeId: string;
      shopifyCustomerId: string;
      email: string | null;
    }>
  >(Prisma.sql`
    SELECT id, storeId, shopifyCustomerId, email FROM WeleticShopper
    WHERE storeId = ${scope.storeId} AND shopifyCustomerId IN (${row.shopifyCustomerId}, ${numericId})
    FOR UPDATE
  `);
  const shopper = shoppers[0];
  if (
    shoppers.length !== 1 ||
    shopper.storeId !== scope.storeId ||
    ![row.shopifyCustomerId, numericId].includes(shopper.shopifyCustomerId)
  )
    throw new HistoricalImportConflictError();
  // Detect a malformed foreign-owned account rather than hiding it with a
  // store filter and mistakenly treating this shopper as unenrolled.
  const accounts = await tx.$queryRaw<WeleticLoyaltyAccount[]>(Prisma.sql`
    SELECT * FROM WeleticLoyaltyAccount WHERE shopperId = ${shopper.id} FOR UPDATE
  `);
  if (accounts.length > 1) throw new HistoricalImportConflictError();
  const account = accounts[0] ?? null;
  if (
    account &&
    (account.storeId !== scope.storeId ||
      account.programId !== scope.programId ||
      account.shopperId !== shopper.id ||
      account.status !== "active" ||
      hasShopifyCustomerRedactionTombstone(account.metadata))
  )
    throw new HistoricalImportConflictError();
  const identities = deriveAllShopifyCustomerPrivacyIdentities({
    storeId: scope.storeId,
    shopifyCustomerId: row.shopifyCustomerId,
    email: shopper.email,
  });
  // A current locking read must observe tombstones even if a Repeatable Read
  // snapshot was established earlier. Retained owner links do not expire here.
  const ownerPredicates = [
    Prisma.sql`shopperId = ${shopper.id}`,
    ...(account ? [Prisma.sql`accountId = ${account.id}`] : []),
  ];
  const identityPredicates = identities.map(
    (identity) => Prisma.sql`(
    identityKind = ${identity.identityKind} AND identityKeyId = ${identity.identityKeyId}
    AND customerDigest = ${identity.customerDigest}
  )`,
  );
  if (!identityPredicates.length) throw new HistoricalImportConflictError();
  const tombstones = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyCustomerPrivacyTombstone
    WHERE storeId = ${scope.storeId} AND (
      (${Prisma.join(ownerPredicates, " OR ")}) OR
      (expiresAt > ${execution.now} AND (${Prisma.join(identityPredicates, " OR ")}))
    ) LIMIT 1 FOR UPDATE
  `);
  if (tombstones.length) throw new HistoricalImportConflictError();
  if (row.tierId) {
    const tiers = await tx.$queryRaw<
      Array<{ id: string; programId: string }>
    >(Prisma.sql`
      SELECT id, programId FROM WeleticLoyaltyTier
      WHERE id = ${row.tierId} AND programId = ${scope.programId} AND deletedAt IS NULL
      FOR UPDATE
    `);
    if (
      tiers.length !== 1 ||
      tiers[0].id !== row.tierId ||
      tiers[0].programId !== scope.programId
    )
      throw new HistoricalImportConflictError();
  }
  const balance = account?.cachedPointsBalance ?? BigInt(0);
  const after = balance + BigInt(row.openingBalance);
  if (
    after > BigInt("9223372036854775807") ||
    after < BigInt("-9223372036854775808") ||
    (account &&
      (!Number.isInteger(account.ledgerVersion) ||
        account.ledgerVersion < 0 ||
        account.ledgerVersion >= 2147483647))
  )
    throw new HistoricalImportConflictError();
  let birthday;
  try {
    birthday = planHistoricalImportBirthday({
      metadata: account?.metadata ?? null,
      birthday: row.birthday,
      now: execution.now,
    });
  } catch {
    throw new HistoricalImportConflictError();
  }
  return {
    lease: scope,
    now: execution.now,
    snapshot,
    row,
    shopper,
    account,
    birthday,
    balanceAfter: after,
  };
}
