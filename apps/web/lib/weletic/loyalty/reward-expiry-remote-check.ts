import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import type { LoyaltyMaintenancePermit } from "./maintenance-write-fence";
import type { RewardExpiryCommunication } from "./reward-expiry-communication-contract";
import { readCurrentRewardExpiryReceipt } from "./reward-expiry-communication-source";
import { matchesRewardExpiryDiscountEvidence } from "./reward-expiry-discount-evidence";
import {
  lookupDiscountByCode,
  resolveShopifyOfflineCredentials,
} from "./shopify-discounts";

/** Read-only Shopify observation before first send AND retry. Do not keep the
 * network call inside a short Prisma transaction or persist a usability flag.
 * The caller holds the customer's settlement lock through final provider I/O;
 * retained delivery rechecks local source/privacy/admission under its own fence. */
export async function isRewardExpiryDiscountCurrentlyUsable({
  db,
  event,
  shopifyCustomerId,
  loyaltyMaintenancePermit,
}: {
  db: Parameters<typeof readCurrentRewardExpiryReceipt>[0]["db"];
  event: RewardExpiryCommunication;
  shopifyCustomerId: string;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}): Promise<boolean> {
  const receipt = await readCurrentRewardExpiryReceipt({ db, event });
  if (!receipt) return false;
  const row =
    receipt.kind === "redemption"
      ? receipt.input.redemption
      : receipt.input.receipt.kind === "coupon"
        ? receipt.input.receipt.redemption
        : null;
  if (!row?.shopifyDiscountCode) return false;
  const fence = () =>
    assertShopifyStoreAcceptsOperationalWrites({
      storeId: event.storeId,
      expectedInstallationGeneration: event.installationGeneration,
      action: "loyalty_reward_expiry_remote_read",
      loyaltyMaintenancePermit,
    });
  await fence();
  const credentials = await resolveShopifyOfflineCredentials({
    storeId: event.storeId,
  });
  await fence();
  // Transport/auth failures propagate to the existing retry/dead-letter path.
  // A missing, edited, inactive or used discount is a suppression, not a retry.
  const remote = await lookupDiscountByCode(
    credentials.shopDomain,
    credentials.accessToken,
    row.shopifyDiscountCode,
  );
  await fence();
  return matchesRewardExpiryDiscountEvidence({
    event,
    receipt,
    remote,
    shopifyCustomerId,
    now: new Date(),
  });
}
