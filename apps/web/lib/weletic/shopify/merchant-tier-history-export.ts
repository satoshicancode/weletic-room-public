import type { Prisma } from "@prisma/client";
import { Prisma as PrismaSql } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  MAX_TIER_HISTORY_EXPORT_ROWS,
  merchantTierHistoryExportRequestSchema,
  merchantTierHistoryExportResponseSchema,
} from "../loyalty/tier-history-export-contract";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";

const redactionPath = '$."shopifyCustomerRedaction"';

type TierHistoryRecord = {
  id: string;
  accountId: string;
  effectiveAt: Date;
  fromTierCurrentName: string | null;
  toTierCurrentName: string | null;
  changeReason: string;
};
type CandidateRecord = Pick<TierHistoryRecord, "id" | "accountId">;

function accountPseudonym(storeId: string, accountId: string) {
  return `account_${createHash("sha256")
    .update(JSON.stringify(["tier-history-v1", storeId, accountId]))
    .digest("hex")
    .slice(0, 32)}`;
}

/** Signed and audited owner-only export. Candidate discovery does not lock a
 * store's entire tier history during its global sort. The same transaction
 * locks only selected accounts, then rechecks privacy and event existence with
 * a current locking read. An erasure that wins the account lock is excluded.
 * Names are CURRENT tier labels; historical labels were not snapshotted.
 * Never export notes or IDs. */
export async function readShopifyMerchantTierHistoryExportInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = merchantTierHistoryExportRequestSchema.parse(request);
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
  const candidates = await tx.$queryRaw<CandidateRecord[]>(PrismaSql.sql`
    SELECT h.id, h.accountId
    FROM WeleticLoyaltyTierHistory h
    INNER JOIN WeleticLoyaltyAccount a
      ON a.id = h.accountId AND BINARY a.id = BINARY h.accountId
    WHERE a.storeId = ${actor.storeId}
      AND BINARY a.storeId = BINARY ${actor.storeId}
      AND COALESCE(JSON_CONTAINS_PATH(a.metadata, 'one', ${redactionPath}), 0) = 0
      AND h.effectiveAt >= ${startAt} AND h.effectiveAt <= ${endAt}
    ORDER BY h.effectiveAt ASC, BINARY h.id ASC
    LIMIT ${MAX_TIER_HISTORY_EXPORT_ROWS + 1}
  `);
  if (candidates.length > MAX_TIER_HISTORY_EXPORT_ROWS + 1)
    throw new Error("Tier history export exceeded its query bound");
  if (candidates.length > MAX_TIER_HISTORY_EXPORT_ROWS)
    return merchantTierHistoryExportResponseSchema.parse({
      status: "too_large",
      coverage: "retained_nonredacted_tier_events_only",
      installationGeneration: actor.installationGeneration,
      filter: data.filter,
      rows: [],
    });
  let records: TierHistoryRecord[] = [];
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
    records = await tx.$queryRaw<TierHistoryRecord[]>(PrismaSql.sql`
      SELECT h.id, h.accountId, h.effectiveAt, h.changeReason,
             fromTier.name AS fromTierCurrentName,
             toTier.name AS toTierCurrentName
      FROM WeleticLoyaltyTierHistory h
      INNER JOIN WeleticLoyaltyAccount a
        ON a.id = h.accountId AND BINARY a.id = BINARY h.accountId
      LEFT JOIN WeleticLoyaltyTier fromTier
        ON fromTier.id = h.fromTierId AND BINARY fromTier.id = BINARY h.fromTierId
        AND fromTier.programId = a.programId
      LEFT JOIN WeleticLoyaltyTier toTier
        ON toTier.id = h.toTierId AND BINARY toTier.id = BINARY h.toTierId
        AND toTier.programId = a.programId
      WHERE h.id IN (${PrismaSql.join(candidates.map((row) => row.id))})
        AND a.storeId = ${actor.storeId}
        AND BINARY a.storeId = BINARY ${actor.storeId}
        AND COALESCE(JSON_CONTAINS_PATH(a.metadata, 'one', ${redactionPath}), 0) = 0
        AND h.effectiveAt >= ${startAt} AND h.effectiveAt <= ${endAt}
      ORDER BY h.effectiveAt ASC, BINARY h.id ASC
      FOR UPDATE
    `);
  }
  if (records.length > MAX_TIER_HISTORY_EXPORT_ROWS)
    throw new Error("Tier history current read exceeded its query bound");
  return merchantTierHistoryExportResponseSchema.parse({
    status: "available",
    coverage: "retained_nonredacted_tier_events_only",
    installationGeneration: actor.installationGeneration,
    filter: data.filter,
    rows: records.map((record) => ({
      accountPseudonym: accountPseudonym(actor.storeId, record.accountId),
      effectiveAt: record.effectiveAt.toISOString(),
      fromTierCurrentName: record.fromTierCurrentName,
      toTierCurrentName: record.toTierCurrentName,
      changeReason: record.changeReason,
    })),
  });
}
