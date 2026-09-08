import { prisma } from "@/lib/prisma";

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
  const take = boundedBatchSize(batchSize);
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
