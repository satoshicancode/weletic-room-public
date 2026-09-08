import { prisma } from "@/lib/prisma";
import { upsertShopifyCustomerPrivacyTombstones } from "@/lib/weletic/shopify/privacy-identity";
import { Prisma } from "@prisma/client";

/** Compatibility redaction lacks the durable worker's customer-lock phase.
 * Fence new awards before draining existing coupons or scrubbing identity.
 */
export async function fenceShopperIncentiveRedaction({
  storeId,
  shopperId,
  shopifyCustomerId,
  accountId,
  sourceRequestId,
  redactedAt,
}: {
  storeId: string;
  shopperId: string;
  shopifyCustomerId: string;
  accountId: string | null;
  sourceRequestId?: string | null;
  redactedAt: Date;
}) {
  await prisma.$transaction(async (tx) => {
    const stores = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM WeleticShopifyStore WHERE id = ${storeId} LIMIT 1 FOR UPDATE
    `);
    if (!stores[0]) throw new Error("Shopper redaction store is unavailable.");
    const shopper = await tx.weleticShopper.findUnique({
      where: { storeId_id: { storeId, id: shopperId } },
    });
    if (!shopper || shopper.shopifyCustomerId !== String(shopifyCustomerId))
      throw new Error("Shopper identity changed before redaction fencing.");
    await upsertShopifyCustomerPrivacyTombstones({
      storeId,
      shopperId: shopper.id,
      shopifyCustomerId: shopper.shopifyCustomerId,
      email: shopper.email,
      accountId,
      sourceRequestId,
      redactedAt,
      tx,
    });
  });
}
