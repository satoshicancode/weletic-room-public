import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { upsertWeleticShopper } from "@/lib/weletic/loyalty/shopper";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";

export async function customersSync({
  event,
  workspaceId,
  storeId,
  expectedInstallationGeneration,
  loyaltyMaintenancePermit,
}: {
  event: any;
  workspaceId: string;
  storeId?: string;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const store = await assertShopifyStoreAcceptsOperationalWrites({
    ...(storeId ? { storeId } : { workspaceId }),
    action: "customer_sync",
    expectedInstallationGeneration,
    loyaltyMaintenancePermit,
  });

  if (!store) {
    throw new Error(
      `Cannot sync Shopify customer: store is missing for workspace ${workspaceId}`,
    );
  }

  if (!event?.id) {
    throw new Error("Shopify customer webhook is missing a customer id.");
  }

  const result = await withShopifyCustomerSettlementLocks({
    storeId: store.id,
    workspaceId,
    shopifyCustomerId: event.id,
    fn: () =>
      upsertWeleticShopper({
        storeId: store.id,
        customer: event,
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
      }),
  });

  if (!result) {
    throw new Error("Shopify customer webhook is missing a customer id.");
  }

  if (result.privacyTombstoned) {
    return "[Shopify] Redacted customer sync ignored.";
  }

  return result.loyaltyAccountCreated
    ? "[Shopify] Customer and loyalty account created."
    : "[Shopify] Customer profile updated.";
}
