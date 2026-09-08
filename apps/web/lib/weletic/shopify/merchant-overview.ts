import type { Prisma } from "@prisma/client";
import { authorizeShopifyMerchantInTransaction } from "./staff-authorization";

/** Native operational overview only. Affiliate, financial and customer records
 * deliberately have no projection here. Authorization and reads share one TX.
 */
export async function readShopifyMerchantOverviewInTransaction({
  tx,
  envelope,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
}) {
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "overview.read",
  });
  const store = await tx.weleticShopifyStore.findUniqueOrThrow({
    where: { id: actor.storeId },
    select: {
      shopDomain: true,
      syncStatus: true,
      lastFullSyncAt: true,
      _count: { select: { products: true, markets: true } },
    },
  });
  return {
    shop: store.shopDomain,
    canManageStaff: actor.owner,
    catalog: {
      products: store._count.products,
      markets: store._count.markets,
      syncStatus: store.syncStatus,
      lastSyncAt: store.lastFullSyncAt?.toISOString() ?? null,
    },
  };
}
