import type { Prisma } from "@prisma/client";
import { Prisma as PrismaSql } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  MAX_LEDGER_ROW_EXPORT_ROWS,
  merchantLedgerRowExportRequestSchema,
  merchantLedgerRowExportResponseSchema,
} from "../loyalty/ledger-row-export-contract";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";

const redactionPath = '$."shopifyCustomerRedaction"';

type Candidate = { id: string; accountId: string };
type LedgerRecord = Candidate & {
  sequenceNumber: number;
  createdAt: Date;
  entryType: string;
  pointsDelta: bigint;
  pendingDelta: bigint;
  balanceAfter: bigint;
};

function accountPseudonym(storeId: string, accountId: string) {
  return `account_${createHash("sha256")
    .update(JSON.stringify(["ledger-row-v1", storeId, accountId]))
    .digest("hex")
    .slice(0, 32)}`;
}

/** Read the bounded retained ledger under the signed owner audit. Candidate
 * discovery can use the store/date index without locking the entire ledger.
 * Lock selected accounts, then recheck current privacy state and row existence
 * in the same transaction. Never export raw shopper, order, grant, reference,
 * idempotency, reason or metadata fields. */
export async function readShopifyMerchantLedgerRowExportInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = merchantLedgerRowExportRequestSchema.parse(request);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "analytics.export",
  });
  if (!actor.owner) throw new ShopifyStaffAuthorizationError("access_denied");
  if (actor.installationGeneration !== data.expectedInstallationGeneration)
    throw new ShopifyStaffAuthorizationError("invalid_actor");

  const startAt = new Date(data.filter.startAt!);
  const endAt = new Date(data.filter.endAt!);
  const candidates = await tx.$queryRaw<Candidate[]>(PrismaSql.sql`
    SELECT e.id, e.accountId
    FROM WeleticPointsLedgerEntry e
    INNER JOIN WeleticLoyaltyAccount a
      ON a.id = e.accountId AND BINARY a.id = BINARY e.accountId
    WHERE e.storeId = ${actor.storeId}
      AND BINARY e.storeId = BINARY ${actor.storeId}
      AND a.storeId = ${actor.storeId}
      AND BINARY a.storeId = BINARY ${actor.storeId}
      AND COALESCE(JSON_CONTAINS_PATH(a.metadata, 'one', ${redactionPath}), 0) = 0
      AND e.createdAt >= ${startAt} AND e.createdAt <= ${endAt}
    ORDER BY e.createdAt ASC, BINARY e.id ASC
    LIMIT ${MAX_LEDGER_ROW_EXPORT_ROWS + 1}
  `);
  if (candidates.length > MAX_LEDGER_ROW_EXPORT_ROWS + 1)
    throw new Error("Ledger row export exceeded its query bound");
  if (candidates.length > MAX_LEDGER_ROW_EXPORT_ROWS)
    return merchantLedgerRowExportResponseSchema.parse({
      status: "too_large",
      coverage: "retained_nonredacted_ledger_entries_only",
      installationGeneration: actor.installationGeneration,
      filter: data.filter,
      rows: [],
    });

  let records: LedgerRecord[] = [];
  if (candidates.length) {
    const accountIds = [
      ...new Set(candidates.map((row) => row.accountId)),
    ].sort();
    await tx.$queryRaw(PrismaSql.sql`
      SELECT id FROM WeleticLoyaltyAccount
      WHERE id IN (${PrismaSql.join(accountIds)})
        AND storeId = ${actor.storeId}
        AND BINARY storeId = BINARY ${actor.storeId}
      ORDER BY BINARY id FOR UPDATE
    `);
    records = await tx.$queryRaw<LedgerRecord[]>(PrismaSql.sql`
      SELECT e.id, e.accountId, e.sequenceNumber, e.createdAt,
             e.entryType, e.pointsDelta, e.pendingDelta, e.balanceAfter
      FROM WeleticPointsLedgerEntry e
      INNER JOIN WeleticLoyaltyAccount a
        ON a.id = e.accountId AND BINARY a.id = BINARY e.accountId
      WHERE e.id IN (${PrismaSql.join(candidates.map((row) => row.id))})
        AND e.storeId = ${actor.storeId}
        AND BINARY e.storeId = BINARY ${actor.storeId}
        AND a.storeId = ${actor.storeId}
        AND BINARY a.storeId = BINARY ${actor.storeId}
        AND COALESCE(JSON_CONTAINS_PATH(a.metadata, 'one', ${redactionPath}), 0) = 0
        AND e.createdAt >= ${startAt} AND e.createdAt <= ${endAt}
      ORDER BY e.createdAt ASC, BINARY e.id ASC
      FOR UPDATE
    `);
  }
  if (records.length > MAX_LEDGER_ROW_EXPORT_ROWS)
    throw new Error("Ledger row current read exceeded its query bound");
  return merchantLedgerRowExportResponseSchema.parse({
    status: "available",
    coverage: "retained_nonredacted_ledger_entries_only",
    installationGeneration: actor.installationGeneration,
    filter: data.filter,
    rows: records.map((record) => ({
      accountPseudonym: accountPseudonym(actor.storeId, record.accountId),
      sequenceNumber: record.sequenceNumber,
      createdAt: record.createdAt.toISOString(),
      entryType: record.entryType,
      pointsDelta: record.pointsDelta.toString(),
      pendingDelta: record.pendingDelta.toString(),
      balanceAfter: record.balanceAfter.toString(),
    })),
  });
}
