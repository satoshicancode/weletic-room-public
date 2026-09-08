import { prisma } from "@/lib/prisma";
import { shouldDispatchShopifyFlowForStore } from "@/lib/weletic/loyalty/flow-lifecycle";
import {
  classifyShopifyFlowDispatchError,
  dispatchShopifyFlowTrigger,
  SHOPIFY_FLOW_TRIGGER_HANDLES,
  ShopifyFlowDispatchError,
} from "@/lib/weletic/loyalty/flow-triggers";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import {
  FlowTriggerPayloadSchema,
  type FlowTriggerPayload,
} from "@/lib/weletic/loyalty/outbox";
import {
  resolveShopifyOfflineCredentials,
  ShopifyDiscountError,
} from "@/lib/weletic/loyalty/shopify-discounts";
import {
  assertShopifyStoreAcceptsOperationalWrites,
  isShopifyStoreOperationalWritesBlocked,
} from "@/lib/weletic/shopify/store-compliance-state";

export async function handleFlowTrigger(
  storeId: string,
  rawPayload: unknown,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
): Promise<void> {
  let payload: FlowTriggerPayload;
  try {
    payload = FlowTriggerPayloadSchema.parse(rawPayload);
  } catch (error) {
    throw new ShopifyFlowDispatchError(
      error instanceof Error ? error.message : "Invalid Shopify Flow payload.",
      false,
    );
  }
  if (!(await shouldDispatchShopifyFlowForStore(storeId))) return;

  const account = await prisma.weleticLoyaltyAccount.findFirst({
    where: { id: payload.accountId, storeId, status: "active" },
    select: {
      cachedPointsBalance: true,
      nextExpiryDate: true,
      pointsExpiryPolicyVersion: true,
      shopper: { select: { shopifyCustomerId: true } },
    },
  });
  if (!account) return;

  if (payload.handle === SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EXPIRING_SOON) {
    if (
      account.cachedPointsBalance <= BigInt(0) ||
      account.nextExpiryDate?.toISOString() !== payload.expiryDate ||
      (payload.policyVersion !== undefined &&
        account.pointsExpiryPolicyVersion !== payload.policyVersion)
    ) {
      return;
    }
  }

  const customerGid = account.shopper.shopifyCustomerId;
  const flowPayload =
    payload.handle === SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED
      ? {
          customerGid,
          pointsDelta: payload.pointsDelta,
          pointsBalance: payload.pointsBalance,
          reason: payload.reason,
          orderId: payload.orderId,
        }
      : payload.handle === SHOPIFY_FLOW_TRIGGER_HANDLES.VIP_TIER_CHANGED
        ? {
            customerGid,
            previousTier: payload.previousTier,
            newTier: payload.newTier,
            multiplier: payload.multiplier,
          }
        : payload.handle === SHOPIFY_FLOW_TRIGGER_HANDLES.REWARD_REDEEMED
          ? {
              customerGid,
              rewardType: payload.rewardType,
              discountCode: payload.discountCode,
              pointsSpent: payload.pointsSpent,
            }
          : {
              customerGid,
              pointsExpiring: account.cachedPointsBalance.toString(),
              expiryDate: payload.expiryDate,
              urgency: payload.urgency,
            };

  const assertCurrentInstallation = () =>
    assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action: "loyalty_outbox:FLOW_TRIGGER",
      expectedInstallationGeneration: payload.installationGeneration ?? null,
      loyaltyMaintenancePermit,
    });
  try {
    // Admission happened before the customer lock. Reconnect or privacy may
    // have invalidated this event while it waited for that lock.
    await assertCurrentInstallation();
    const credentials = await resolveShopifyOfflineCredentials({ storeId });
    // Credential resolution can await refresh I/O. Never let an old event
    // adopt a newer installation's credential during that interval.
    await assertCurrentInstallation();
    await dispatchShopifyFlowTrigger({
      storeId,
      shopDomain: credentials.shopDomain,
      offlineToken: credentials.accessToken,
      handle: payload.handle,
      payload: flowPayload,
    });
  } catch (error) {
    if (isShopifyStoreOperationalWritesBlocked(error)) return;
    if (error instanceof ShopifyDiscountError)
      throw classifyShopifyFlowDispatchError(error);
    throw error;
  }
}
