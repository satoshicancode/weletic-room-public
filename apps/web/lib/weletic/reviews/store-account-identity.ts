import { prisma } from "@/lib/prisma";
import { ReviewError } from "./contracts";

/** Identity comes only from the verified Shopify customer-account gateway. */
export async function resolveStoreReviewAccountIdentity(
  shop: string,
  customerId: string,
) {
  const store = await prisma.weleticShopifyStore.findUnique({
    where: { shopDomain: shop },
    select: {
      id: true,
      installationGeneration: true,
      complianceState: true,
      storeAccessState: true,
    },
  });
  if (
    !store?.installationGeneration ||
    store.complianceState !== "active" ||
    store.storeAccessState !== "active"
  )
    throw new ReviewError("not_found", "Store unavailable");
  const shoppers = await prisma.weleticShopper.findMany({
    where: {
      storeId: store.id,
      shopifyCustomerId: {
        in: [customerId, `gid://shopify/Customer/${customerId}`],
      },
    },
    select: { id: true },
    take: 2,
  });
  if (!shoppers.length)
    throw new ReviewError("not_found", "Review invitation unavailable");
  if (shoppers.length !== 1)
    throw new ReviewError("unavailable", "Review identity unavailable");
  return {
    storeId: store.id,
    shopperId: shoppers[0].id,
    installationGeneration: store.installationGeneration,
  };
}
