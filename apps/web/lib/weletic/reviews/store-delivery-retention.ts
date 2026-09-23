import { prisma } from "@/lib/prisma";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { Prisma } from "@prisma/client";

/** Erases expired store-invitation transport evidence even when a worker was
 * interrupted. It does not require a current installation or send anything.
 */
export async function clearExpiredStoreReviewDeliveryEvidence({
  batchSize = 50,
  now = new Date(),
}: { batchSize?: number; now?: Date } = {}) {
  if (
    !Number.isInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100 ||
    !Number.isFinite(now.getTime())
  )
    throw new Error("Invalid store review retention batch");
  const due = {
    expiresAt: { lte: now },
    AND: [
      {
        OR: [
          { tokenHash: { not: null } },
          { encryptedDeliveryToken: { not: null } },
          { encryptedDeliverySnapshot: { not: null } },
          { status: { in: ["sending", "failed"] } },
        ],
      },
      {
        OR: [
          { deliveryLeaseExpiresAt: null },
          { deliveryLeaseExpiresAt: { lte: now } },
        ],
      },
    ],
  } satisfies Prisma.WeleticStoreReviewRequestWhereInput;
  const candidates = await prisma.weleticStoreReviewRequest.findMany({
    where: due,
    orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    take: batchSize,
    select: {
      id: true,
      storeId: true,
      installationGeneration: true,
      store: { select: { projectId: true } },
      shopper: { select: { shopifyCustomerId: true } },
    },
  });
  let cleared = 0;
  let deferred = 0;
  for (const candidate of candidates) {
    const erase = () =>
      prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${candidate.storeId} FOR UPDATE`;
        const where = {
          ...due,
          id: candidate.id,
          storeId: candidate.storeId,
          installationGeneration: candidate.installationGeneration,
        };
        const current = await tx.weleticStoreReviewRequest.findFirst({
          where,
          select: { status: true, deliveryAttempts: true },
        });
        if (!current) return 0;
        const unfinished = ["queued", "sending", "failed"].includes(
          current.status,
        );
        const result = await tx.weleticStoreReviewRequest.updateMany({
          where,
          data: {
            ...(unfinished
              ? {
                  status: "expired" as const,
                  lastError:
                    current.deliveryAttempts > 0
                      ? "email_delivery_expired_unreconciled"
                      : null,
                }
              : {}),
            tokenHash: null,
            encryptedDeliveryToken: null,
            encryptedDeliverySnapshot: null,
            deliveryToken: null,
            deliveryLeaseExpiresAt: null,
          },
        });
        if (result.count === 1)
          await tx.weleticLoyaltyOutboxJob.updateMany({
            where: {
              storeId: candidate.storeId,
              jobType: "REVIEW_REQUEST_EMAIL",
              idempotencyKey: `store_review_request_email:${candidate.id}`,
              status: { in: ["pending", "processing", "failed"] },
            },
            data: { status: "cancelled", lockedAt: null, lockedBy: null },
          });
        return result.count;
      });
    cleared += candidate.shopper.shopifyCustomerId
      ? await withShopifyCustomerSettlementLocks({
          workspaceId: candidate.store.projectId,
          storeId: candidate.storeId,
          shopifyCustomerId: candidate.shopper.shopifyCustomerId,
          onLocked: () => {
            deferred++;
            return 0;
          },
          fn: erase,
        })
      : await erase();
  }
  return { scanned: candidates.length, cleared, deferred };
}
