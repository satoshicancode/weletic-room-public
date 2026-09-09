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
import { readReferralPrivacySnapshot } from "@/lib/weletic/loyalty/referral-privacy-snapshot";
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

  const isCurrentReferralCompletionEligible = async () => {
    if (payload.handle !== SHOPIFY_FLOW_TRIGGER_HANDLES.REFERRAL_COMPLETED)
      return true;
    // A clawback or privacy closure before delivery invalidates completion.
    const referral = await prisma.weleticLoyaltyReferral.findFirst({
      where: {
        id: payload.referralId,
        storeId,
        advocateAccountId: payload.accountId,
        qualifyingOrderId: payload.orderId,
        status: "rewarded",
        advocateAccount: { storeId, status: "active" },
        OR: [
          { refereeAccount: { storeId, status: "active" } },
          { refereeAccountId: null },
        ],
      },
      select: {
        advocatePointsAwarded: true,
        refereePointsAwarded: true,
        refereeAccountId: true,
        refereeShopperId: true,
        friendEmailDigest: true,
        metadata: true,
      },
    });
    if (
      !referral ||
      referral.advocatePointsAwarded.toString() !== payload.advocatePoints ||
      referral.refereePointsAwarded.toString() !== payload.friendPoints
    )
      return false;
    const metadata =
      referral.metadata &&
      typeof referral.metadata === "object" &&
      !Array.isArray(referral.metadata)
        ? referral.metadata
        : {};
    if ("privacyRedactedAt" in metadata) return false;
    const identities =
      referral.refereeAccountId === null
        ? readReferralPrivacySnapshot({
            value: metadata.friendPrivacySnapshot,
            storeId,
            referralId: payload.referralId,
            friendEmailDigest: referral.friendEmailDigest,
          })
        : [];
    if (identities === null) return false;
    // Retained owner tombstones do not expire while that financial owner exists.
    // Anonymous friends require a current, scope-checked privacy identity snapshot.
    const ownerConditions = [
      ...(referral.refereeAccountId
        ? [{ accountId: referral.refereeAccountId }]
        : []),
      ...(referral.refereeShopperId
        ? [{ shopperId: referral.refereeShopperId }]
        : []),
    ];
    if (!ownerConditions.length && !identities.length) return false;
    const tombstone =
      await prisma.weleticShopifyCustomerPrivacyTombstone.findFirst({
        where: {
          storeId,
          OR: [
            ...ownerConditions,
            ...(identities.length
              ? [{ expiresAt: { gt: new Date() }, OR: identities }]
              : []),
          ],
        },
        select: { id: true },
      });
    return !tombstone;
  };
  if (!(await isCurrentReferralCompletionEligible())) return;

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
    payload.handle === SHOPIFY_FLOW_TRIGGER_HANDLES.REFERRAL_COMPLETED
      ? {
          customerGid,
          referralId: payload.referralId,
          orderId: payload.orderId,
          advocatePoints: payload.advocatePoints,
          friendPoints: payload.friendPoints,
        }
      : payload.handle === SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED
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
    // Credential refresh can outlive a refund or either customer's closure.
    // Re-read eligibility rather than dispatching the earlier observation.
    // This is not a cross-customer lock across the remote Shopify request.
    if (!(await isCurrentReferralCompletionEligible())) return;
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
