import { recordWeleticRefund } from "@/lib/weletic/commerce/record-refund";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  isShopifyStoreOperationalWritesBlocked,
} from "@/lib/weletic/shopify/store-compliance-state";

export async function refundsCreate({
  event,
  workspaceId,
  storeId,
  expectedInstallationGeneration,
  privacyMinimizedFinancialSettlement: forcePrivacyMinimizedSettlement = false,
  loyaltyMaintenancePermit,
}: {
  event: unknown;
  workspaceId: string;
  storeId?: string;
  expectedInstallationGeneration?: string | null;
  privacyMinimizedFinancialSettlement?: boolean;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  let privacyMinimizedFinancialSettlement = forcePrivacyMinimizedSettlement;
  if (!forcePrivacyMinimizedSettlement) {
    try {
      await assertShopifyStoreAcceptsOperationalWrites({
        ...(storeId ? { storeId } : { workspaceId }),
        action: "refunds_create",
        expectedInstallationGeneration,
        loyaltyMaintenancePermit,
      });
    } catch (error) {
      if (
        !isShopifyStoreOperationalWritesBlocked(error) ||
        (error.complianceState !== "frozen" &&
          error.complianceState !== "redacted")
      ) {
        throw error;
      }
      privacyMinimizedFinancialSettlement = true;
    }
  }

  const result = await recordWeleticRefund(
    { event, workspaceId },
    {
      privacyMinimizedFinancialSettlement,
      expectedInstallationGeneration,
      loyaltyMaintenancePermit,
    },
  );
  if (privacyMinimizedFinancialSettlement) {
    return result.duplicate
      ? "[Shopify] Frozen-store refund financial settlement was already processed."
      : "[Shopify] Frozen-store refund processed through privacy-minimized financial settlement only.";
  }
  return result.duplicate
    ? "[Shopify] Refund already processed."
    : "[Shopify] Refund processed successfully.";
}
