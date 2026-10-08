import type { Prisma } from "@prisma/client";
import { Prisma as PrismaSql } from "@prisma/client";
import { createHash } from "node:crypto";
import {
  MAX_ACCOUNT_ROW_EXPORT_ROWS,
  merchantAccountRowExportRequestSchema,
  merchantAccountRowExportResponseSchema,
} from "../loyalty/account-row-export-contract";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";

const redactionPath = '$."shopifyCustomerRedaction"';

type Candidate = { id: string };
type AccountRecord = Candidate & {
  enrolledAt: Date;
  status: string;
  tierOrder: number | null;
  cachedPointsBalance: bigint;
  cachedPendingPoints: bigint;
  lifetimePointsEarned: bigint;
  lifetimePointsRedeemed: bigint;
};

function accountPseudonym(storeId: string, accountId: string) {
  return `account_${createHash("sha256")
    .update(JSON.stringify(["account-row-v1", storeId, accountId]))
    .digest("hex")
    .slice(0, 32)}`;
}

/** Current retained account snapshot by recorded enrollment date. The
 * candidate query is bounded, then selected account rows are locked and
 * privacy-filtered again, so an erasure that wins the lock cannot escape.
 * No shopper, customer, referral, contact or raw account identifier leaves
 * this signed owner-only gateway. */
export async function readShopifyMerchantAccountRowExportInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = merchantAccountRowExportRequestSchema.parse(request);
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
  // Discovery only proves whether the cap is exceeded. Sorting here would
  // scan the whole range before refusing a large export; the locked read below
  // orders the rows that can actually be returned.
  const candidates = await tx.$queryRaw<Candidate[]>(PrismaSql.sql`
    SELECT a.id
    FROM WeleticLoyaltyAccount a
    WHERE a.storeId = ${actor.storeId}
      AND BINARY a.storeId = BINARY ${actor.storeId}
      AND COALESCE(JSON_CONTAINS_PATH(a.metadata, 'one', ${redactionPath}), 0) = 0
      AND a.enrolledAt >= ${startAt} AND a.enrolledAt <= ${endAt}
    LIMIT ${MAX_ACCOUNT_ROW_EXPORT_ROWS + 1}
  `);
  if (candidates.length > MAX_ACCOUNT_ROW_EXPORT_ROWS + 1)
    throw new Error("Account row export exceeded its query bound");
  if (candidates.length > MAX_ACCOUNT_ROW_EXPORT_ROWS)
    return merchantAccountRowExportResponseSchema.parse({
      status: "too_large",
      coverage: "current_retained_nonredacted_accounts_by_enrollment",
      installationGeneration: actor.installationGeneration,
      filter: data.filter,
      rows: [],
    });

  let records: AccountRecord[] = [];
  if (candidates.length) {
    const ids = candidates.map((row) => row.id).sort();
    await tx.$queryRaw(PrismaSql.sql`
      SELECT id FROM WeleticLoyaltyAccount
      WHERE id IN (${PrismaSql.join(ids)})
        AND storeId = ${actor.storeId}
        AND BINARY storeId = BINARY ${actor.storeId}
      ORDER BY BINARY id FOR UPDATE
    `);
    records = await tx.$queryRaw<AccountRecord[]>(PrismaSql.sql`
      SELECT a.id, a.enrolledAt, a.status, t.tierOrder,
             a.cachedPointsBalance, a.cachedPendingPoints,
             a.lifetimePointsEarned, a.lifetimePointsRedeemed
      FROM WeleticLoyaltyAccount a
      LEFT JOIN WeleticLoyaltyTier t
        ON t.id = a.currentTierId AND BINARY t.id = BINARY a.currentTierId
        AND t.programId = a.programId AND BINARY t.programId = BINARY a.programId
      WHERE a.id IN (${PrismaSql.join(ids)})
        AND BINARY a.id IN (${PrismaSql.join(ids)})
        AND a.storeId = ${actor.storeId}
        AND BINARY a.storeId = BINARY ${actor.storeId}
        AND COALESCE(JSON_CONTAINS_PATH(a.metadata, 'one', ${redactionPath}), 0) = 0
        AND a.enrolledAt >= ${startAt} AND a.enrolledAt <= ${endAt}
      ORDER BY a.enrolledAt ASC, BINARY a.id ASC
      FOR UPDATE
    `);
  }
  if (records.length > MAX_ACCOUNT_ROW_EXPORT_ROWS)
    throw new Error("Account row current read exceeded its query bound");
  return merchantAccountRowExportResponseSchema.parse({
    status: "available",
    coverage: "current_retained_nonredacted_accounts_by_enrollment",
    installationGeneration: actor.installationGeneration,
    filter: data.filter,
    rows: records.map((row) => ({
      accountPseudonym: accountPseudonym(actor.storeId, row.id),
      enrolledAt: row.enrolledAt.toISOString(),
      accountStatus: row.status,
      currentTierOrder: row.tierOrder,
      cachedPointsBalance: row.cachedPointsBalance.toString(),
      cachedPendingPoints: row.cachedPendingPoints.toString(),
      lifetimePointsEarned: row.lifetimePointsEarned.toString(),
      lifetimePointsRedeemed: row.lifetimePointsRedeemed.toString(),
    })),
  });
}
