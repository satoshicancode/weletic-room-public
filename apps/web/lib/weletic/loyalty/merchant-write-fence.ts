import { prisma } from "@/lib/prisma";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";

export async function withActiveStoreLoyaltyMutation<T>({
  storeId,
  action,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
  operation,
}: {
  storeId: string;
  action: string;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit | null;
  operation: (
    tx: Prisma.TransactionClient,
    installationGeneration: string | null,
  ) => Promise<T>;
}): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      const store = await assertShopifyStoreAcceptsOperationalWrites({
        storeId,
        action,
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
        tx,
      });
      return operation(tx, store?.installationGeneration ?? null);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function assertActiveLoyaltyAccountForMutation({
  tx,
  storeId,
  accountId,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  accountId: string;
}) {
  const account = await tx.weleticLoyaltyAccount.findFirst({
    where: { id: accountId, storeId },
    select: { id: true, status: true, metadata: true },
  });
  if (
    !account ||
    account.status !== "active" ||
    hasShopifyCustomerRedactionTombstone(account.metadata)
  ) {
    throw new Error(
      `Active loyalty account ${accountId} is unavailable for this store.`,
    );
  }
  return account;
}
