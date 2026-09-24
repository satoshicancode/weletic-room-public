import type { Prisma } from "@prisma/client";
import { Prisma as PrismaSql } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  MAX_REDEMPTION_ROW_EXPORT_ROWS,
  merchantRedemptionRowExportRequestSchema,
  merchantRedemptionRowExportResponseSchema,
} from "../loyalty/redemption-row-export-contract";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";

const redactionPath = '$."shopifyCustomerRedaction"';

type Candidate = { id: string; accountId: string };
type RedemptionRecord = Candidate & {
  createdAt: Date;
  status: string;
  artifactKind: string;
  pointsSpent: bigint;
  usedAt: Date | null;
};

function accountPseudonym(storeId: string, accountId: string) {
  return `account_${createHash("sha256")
    .update(JSON.stringify(["redemption-account-row-v1", storeId, accountId]))
    .digest("hex")
    .slice(0, 32)}`;
}

function redemptionPseudonym(storeId: string, redemptionId: string) {
  return `redemption_${createHash("sha256")
    .update(JSON.stringify(["redemption-row-v1", storeId, redemptionId]))
    .digest("hex")
    .slice(0, 32)}`;
}

/** Read the bounded retained points redemptions under the signed owner audit.
 * Candidate discovery can use the store/date index without locking all rows.
 * Lock selected accounts, then recheck current privacy state and row existence
 * in the same transaction. Current status is a snapshot, not an event history.
 * Never export raw shopper, order, discount, reference or metadata fields. */
export async function readShopifyMerchantRedemptionRowExportInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = merchantRedemptionRowExportRequestSchema.parse(request);
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
    FROM WeleticRewardRedemption e
    INNER JOIN WeleticLoyaltyAccount a
      ON a.id = e.accountId AND BINARY a.id = BINARY e.accountId
    WHERE e.storeId = ${actor.storeId}
      AND BINARY e.storeId = BINARY ${actor.storeId}
      AND a.storeId = ${actor.storeId}
      AND BINARY a.storeId = BINARY ${actor.storeId}
      AND COALESCE(JSON_CONTAINS_PATH(a.metadata, 'one', ${redactionPath}), 0) = 0
      AND e.accountId IS NOT NULL AND e.pointsSpent > 0
      AND e.createdAt >= ${startAt} AND e.createdAt <= ${endAt}
    ORDER BY e.createdAt ASC, BINARY e.id ASC
    LIMIT ${MAX_REDEMPTION_ROW_EXPORT_ROWS + 1}
  `);
  if (candidates.length > MAX_REDEMPTION_ROW_EXPORT_ROWS + 1)
    throw new Error("Redemption row export exceeded its query bound");
  if (candidates.length > MAX_REDEMPTION_ROW_EXPORT_ROWS)
    return merchantRedemptionRowExportResponseSchema.parse({
      status: "too_large",
      coverage: "retained_nonredacted_points_redemptions_only",
      installationGeneration: actor.installationGeneration,
      filter: data.filter,
      rows: [],
    });

  let records: RedemptionRecord[] = [];
  if (candidates.length) {
    const accountIds = [
      ...new Set(candidates.map((row) => row.accountId)),
    ].sort();
    const candidateIds = candidates.map((row) => row.id);
    await tx.$queryRaw(PrismaSql.sql`
      SELECT id FROM WeleticLoyaltyAccount FORCE INDEX (PRIMARY)
      WHERE id IN (${PrismaSql.join(accountIds)})
        AND BINARY id IN (${PrismaSql.join(accountIds)})
        AND storeId = ${actor.storeId}
        AND BINARY storeId = BINARY ${actor.storeId}
      ORDER BY BINARY id FOR UPDATE
    `);
    records = await tx.$queryRaw<RedemptionRecord[]>(PrismaSql.sql`
      SELECT e.id, e.accountId, e.createdAt, e.status, e.artifactKind,
             e.pointsSpent, e.usedAt
      FROM WeleticRewardRedemption e FORCE INDEX (PRIMARY)
      STRAIGHT_JOIN WeleticLoyaltyAccount a FORCE INDEX (PRIMARY)
        ON a.id = e.accountId AND BINARY a.id = BINARY e.accountId
      WHERE e.id IN (${PrismaSql.join(candidateIds)})
        AND BINARY e.id IN (${PrismaSql.join(candidateIds)})
        AND e.storeId = ${actor.storeId}
        AND BINARY e.storeId = BINARY ${actor.storeId}
        AND a.storeId = ${actor.storeId}
        AND BINARY a.storeId = BINARY ${actor.storeId}
        AND COALESCE(JSON_CONTAINS_PATH(a.metadata, 'one', ${redactionPath}), 0) = 0
        AND e.accountId IS NOT NULL AND e.pointsSpent > 0
        AND e.createdAt >= ${startAt} AND e.createdAt <= ${endAt}
      ORDER BY e.createdAt ASC, BINARY e.id ASC
      FOR UPDATE
    `);
  }
  if (records.length > MAX_REDEMPTION_ROW_EXPORT_ROWS)
    throw new Error("Redemption row current read exceeded its query bound");
  return merchantRedemptionRowExportResponseSchema.parse({
    status: "available",
    coverage: "retained_nonredacted_points_redemptions_only",
    installationGeneration: actor.installationGeneration,
    filter: data.filter,
    rows: records.map((record) => ({
      accountPseudonym: accountPseudonym(actor.storeId, record.accountId),
      redemptionPseudonym: redemptionPseudonym(actor.storeId, record.id),
      createdAt: record.createdAt.toISOString(),
      currentStatus: record.status,
      artifactKind: record.artifactKind,
      pointsSpent: record.pointsSpent.toString(),
      usedAt: record.usedAt?.toISOString() ?? null,
    })),
  });
}
