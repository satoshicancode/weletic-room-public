import {
  canonicalizeLoyaltyDiscountCode,
  getPersistedLoyaltyDiscountProvisioningIdentity,
} from "./redemption-discount-identity";
import {
  getRewardDefinitionFromProvisioningSnapshot,
  matchesShopifyCustomerSelectionDigest,
  readLoyaltyRedemptionProvisioningSnapshot,
} from "./redemption-provisioning-snapshot";
import { parseReferralCouponRewardSnapshotForIdentity } from "./referral-coupon-snapshot";
import {
  matchesRewardExpiryCommunicationEvidence,
  type RewardExpiryCommunication,
  type RewardExpiryReceiptInput,
} from "./reward-expiry-communication-contract";
import {
  matchesLoyaltyRewardDiscountConfiguration,
  type ShopifyDiscountResult,
} from "./shopify-discounts";

/** Compare a fresh exact-code Shopify observation, never a stored boolean.
 * Shopify's asyncUsageCount is eventually consistent: zero is not an atomic
 * guarantee against checkout. Local used/refund checks and settlement locks
 * remain required, as do generation/privacy/consent checks around provider I/O.
 * This function performs no remote request, sends or financial mutations. */
export function matchesRewardExpiryDiscountEvidence({
  event,
  receipt,
  remote,
  shopifyCustomerId,
  now,
}: {
  event: RewardExpiryCommunication;
  receipt: RewardExpiryReceiptInput;
  remote: ShopifyDiscountResult | null;
  shopifyCustomerId: string;
  now: Date;
}): boolean {
  try {
    if (
      !remote ||
      remote.status !== "ACTIVE" ||
      remote.asyncUsageCount !== 0 ||
      !shopifyCustomerId.trim() ||
      !matchesRewardExpiryCommunicationEvidence({ event, receipt, now })
    )
      return false;
    if (receipt.kind === "redemption") {
      const { input } = receipt;
      const row = input.redemption;
      const snapshot = readLoyaltyRedemptionProvisioningSnapshot(row.metadata);
      if (!snapshot || !row.shopifyDiscountCode) return false;
      const ownership = getPersistedLoyaltyDiscountProvisioningIdentity({
        identity: {
          storeId: input.storeId,
          accountId: input.accountId,
          redemptionId: row.id,
          rewardDefinitionId: row.rewardDefinitionId,
          discountCode: row.shopifyDiscountCode,
        },
        metadata: row.metadata,
      });
      if (
        !ownership ||
        remote.id !== row.shopifyDiscountId ||
        remote.title !== ownership.expectedTitle ||
        canonicalizeLoyaltyDiscountCode(remote.code) !==
          row.shopifyDiscountCodeCanonical ||
        !matchesShopifyCustomerSelectionDigest({
          digest: snapshot.customerSelectionDigest,
          storeId: event.storeId,
          shopifyCustomerId,
        })
      )
        return false;
      return matchesLoyaltyRewardDiscountConfiguration({
        remote,
        rewardDefinition: getRewardDefinitionFromProvisioningSnapshot({
          snapshot,
          provisioningName: ownership.provisioningName,
        }),
        startsAt: new Date(snapshot.startsAt),
        expiresAt: new Date(event.expiresAt),
        expectedShopCurrency: snapshot.shopCurrency,
        shopifyCustomerId,
      });
    }
    if (receipt.input.receipt.kind !== "coupon") return false;
    const row = receipt.input.receipt.redemption;
    const snapshot = parseReferralCouponRewardSnapshotForIdentity(
      (row.metadata as Record<string, unknown>).rewardSnapshot,
      { ...receipt.input.identity, rewardDefinitionId: row.rewardDefinitionId },
    );
    if (
      remote.id !== row.shopifyDiscountId ||
      remote.title !== snapshot.expectedTitle ||
      canonicalizeLoyaltyDiscountCode(remote.code) !==
        row.shopifyDiscountCodeCanonical ||
      !matchesShopifyCustomerSelectionDigest({
        digest: snapshot.customerSelectionDigest,
        storeId: event.storeId,
        shopifyCustomerId,
      })
    )
      return false;
    return matchesLoyaltyRewardDiscountConfiguration({
      remote,
      rewardDefinition: {
        ...snapshot,
        id: snapshot.rewardDefinitionId,
        name: snapshot.provisioningName,
      },
      startsAt: new Date(snapshot.startsAt),
      expiresAt: new Date(event.expiresAt),
      expectedShopCurrency: snapshot.shopCurrency,
      shopifyCustomerId,
    });
  } catch {
    return false;
  }
}
