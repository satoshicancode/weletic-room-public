import { prisma } from "@/lib/prisma";
import {
  addRetentionDays,
  getShopifyCustomerTombstoneRetentionDays,
  getShopifyFinancialRetentionDays,
} from "./compliance-config";
import { deleteExpiredPendingInstallations } from "./pending-installation-retention";

const MAX_RETENTION_DELETE_BATCH = 100;

function boundedBatchSize(batchSize: number) {
  return Math.min(
    MAX_RETENTION_DELETE_BATCH,
    Math.max(1, Math.trunc(batchSize)),
  );
}

export async function deleteExpiredShopifyPrivacyTombstonesBatch({
  batchSize = 50,
  now = new Date(),
}: {
  batchSize?: number;
  now?: Date;
} = {}) {
  if (!Number.isFinite(batchSize) || !Number.isFinite(now.getTime())) {
    throw new Error("Invalid privacy retention batch parameters");
  }
  const take = boundedBatchSize(batchSize);
  const captureCutoff = addRetentionDays(
    now,
    -Math.min(
      getShopifyCustomerTombstoneRetentionDays(),
      getShopifyFinancialRetentionDays(),
    ),
  ).toISOString();
  // The trusted writer stores canonical UTC ISO strings. Both deadlines apply:
  // stored expiry never grows, and a shorter current policy takes effect now.
  // Atomic JSON_REMOVE preserves unrelated metadata and evaluates eligibility
  // on the locked current row, without a select/update race. Erasure deliberately
  // includes suspended/uninstalled stores, independent of loyalty writer gates.
  // LIMIT bounds writes, not rows examined: JSON scan cost needs live EXPLAIN.
  const referralSnapshotsDeleted = await prisma.$executeRaw`
    UPDATE WeleticLoyaltyReferral
    SET metadata = JSON_REMOVE(metadata, '$.friendPrivacySnapshot'),
        updatedAt = UTC_TIMESTAMP(3)
    WHERE JSON_CONTAINS_PATH(metadata, 'one', '$.friendPrivacySnapshot') = 1
      AND (
        COALESCE(JSON_TYPE(JSON_EXTRACT(metadata, '$.friendPrivacySnapshot')) <> 'OBJECT', TRUE)
        OR COALESCE(CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.friendPrivacySnapshot.retainUntil'))), 0) <> 24
        OR COALESCE(CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.friendPrivacySnapshot.capturedAt'))), 0) <> 24
        OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.friendPrivacySnapshot.retainUntil')), '') NOT REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.friendPrivacySnapshot.capturedAt')), '') NOT REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
        OR JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.friendPrivacySnapshot.retainUntil')) <= ${now.toISOString()}
        OR JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.friendPrivacySnapshot.capturedAt')) <= ${captureCutoff}
        OR JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.friendPrivacySnapshot.capturedAt')) > ${now.toISOString()}
        OR JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.friendPrivacySnapshot.retainUntil')) <= JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.friendPrivacySnapshot.capturedAt'))
      )
    ORDER BY id ASC
    LIMIT ${take}
  `;
  const [customerRows, shopRows] = await Promise.all([
    prisma.weleticShopifyCustomerPrivacyTombstone.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take,
      select: { id: true, expiresAt: true, updatedAt: true },
    }),
    prisma.weleticShopifyShopPrivacyTombstone.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take,
      select: { id: true, expiresAt: true, updatedAt: true },
    }),
  ]);

  const [customerResult, shopResult] = await Promise.all([
    customerRows.length > 0
      ? prisma.weleticShopifyCustomerPrivacyTombstone.deleteMany({
          where: {
            expiresAt: { lte: now },
            OR: customerRows.map(({ id, expiresAt, updatedAt }) => ({
              id,
              expiresAt,
              updatedAt,
            })),
          },
        })
      : { count: 0 },
    shopRows.length > 0
      ? prisma.weleticShopifyShopPrivacyTombstone.deleteMany({
          where: {
            expiresAt: { lte: now },
            OR: shopRows.map(({ id, expiresAt, updatedAt }) => ({
              id,
              expiresAt,
              updatedAt,
            })),
          },
        })
      : { count: 0 },
  ]);

  return {
    pendingInstallations: {
      deleted: await prisma.$transaction((tx) =>
        deleteExpiredPendingInstallations(tx, { batchSize: take, now }),
      ),
    },
    referralSnapshots: { deleted: referralSnapshotsDeleted },
    customer: {
      selected: customerRows.length,
      deleted: customerResult.count,
    },
    shop: {
      selected: shopRows.length,
      deleted: shopResult.count,
    },
  };
}
