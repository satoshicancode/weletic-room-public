import { createWeleticId } from "@/lib/weletic/ids";
import {
  reviewCouponAwardSchema,
  reviewIncentivePolicyDigest,
  reviewIncentivePolicySnapshotSchema,
} from "@/lib/weletic/reviews/incentive-policy";
import { matchesShopifyCustomerPrivacyTombstoneOwner } from "@/lib/weletic/shopify/privacy-identity";
import type { Prisma, WeleticRewardRedemption } from "@prisma/client";
import { readShopifyCouponUseAmount } from "./coupon-use-amount";
import {
  canonicalizeLoyaltyDiscountCode,
  getLoyaltyDiscountOwnershipFingerprint,
  getPersistedLoyaltyDiscountProvisioningIdentity,
} from "./redemption-discount-identity";
import {
  assertProvisioningReplayMatchesSnapshot,
  createLoyaltyRedemptionProvisioningSnapshot,
  readLoyaltyRedemptionProvisioningSnapshot,
} from "./redemption-provisioning-snapshot";
import { DIRECT_REVIEW_REWARD_SOURCE } from "./reward-ownership";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const numericId = (value: string | null, resource: "Order" | "Customer") => {
  const raw = value?.trim() ?? "";
  const prefix = `gid://shopify/${resource}/`;
  const id = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
  return /^[1-9]\d{0,29}$/.test(id) ? id : null;
};
const verifiedDiscountId = (
  value: string | null | undefined,
): value is string =>
  typeof value === "string" &&
  /^gid:\/\/shopify\/DiscountCodeNode\/[1-9]\d{0,29}$/.test(value);

/** Called only inside the store-fenced SERIALIZABLE paid-order transaction.
 * Records provider-reported usage, not eligibility or a second incentive. Never
 * enrolls a shopper, creates points, or performs network I/O during retries.
 */
export async function settleShopperCouponUse({
  tx,
  redemption,
  installationGeneration,
  orderId,
  shopifyCustomerId,
  usedAt,
  orderDiscountEvidence,
}: {
  tx: Prisma.TransactionClient;
  redemption: WeleticRewardRedemption;
  installationGeneration: string | null;
  orderId: string;
  shopifyCustomerId: string | null;
  usedAt: Date;
  orderDiscountEvidence?: unknown;
}): Promise<{
  marked: boolean;
  corrected: false;
  issue?: `shopper_coupon_${string}`;
}> {
  const refuse = (issue: `shopper_coupon_${string}`) => ({
    marked: false,
    corrected: false as const,
    issue,
  });
  const externalId = numericId(orderId, "Order");
  const customerId = numericId(shopifyCustomerId, "Customer");
  if (!externalId || !customerId || !Number.isFinite(usedAt.getTime()))
    return refuse("shopper_coupon_invalid_order_identity");
  if (
    !installationGeneration ||
    redemption.accountId !== null ||
    !redemption.shopperId ||
    redemption.fulfillmentSource !== DIRECT_REVIEW_REWARD_SOURCE ||
    !redemption.fulfillmentReference ||
    redemption.pointsSpent !== BigInt(0) ||
    redemption.ledgerEntryId !== null ||
    redemption.artifactKind !== "discount_code"
  )
    return refuse("shopper_coupon_invalid_ownership");
  const storeId = redemption.storeId;
  const retainedStore = await tx.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: { complianceState: true, financialRetentionUntil: true },
  });
  if (
    retainedStore?.complianceState === "redacted" &&
    retainedStore.financialRetentionUntil &&
    retainedStore.financialRetentionUntil <= new Date()
  ) {
    // Do not resurrect an expired financial fact on a delayed webhook replay.
    return { marked: false, corrected: false };
  }
  const shopper = await tx.weleticShopper.findFirst({
    where: { storeId, id: redemption.shopperId },
  });
  if (
    !shopper ||
    (numericId(shopper.shopifyCustomerId, "Customer") !== customerId &&
      !(await matchesShopifyCustomerPrivacyTombstoneOwner({
        tx,
        storeId,
        shopperId: shopper.id,
        shopifyCustomerId: customerId,
      })))
  )
    return refuse("shopper_coupon_customer_mismatch");
  const claim = await tx.weleticReviewIncentiveClaim.findFirst({
    where: {
      storeId,
      id: redemption.fulfillmentReference,
      shopperId: shopper.id,
    },
  });
  const policy = claim
    ? await tx.weleticReviewIncentivePolicy.findFirst({
        where: { storeId, id: claim.policyId },
      })
    : null;
  if (!claim || !policy) return refuse("shopper_coupon_claim_unavailable");
  const ownershipIdentity = {
    storeId,
    redemptionId: redemption.id,
    ownerKind: "shopper" as const,
    shopperId: shopper.id,
    fulfillmentSource: DIRECT_REVIEW_REWARD_SOURCE,
    fulfillmentReference: claim.id,
    rewardDefinitionId: redemption.rewardDefinitionId,
    discountCode: redemption.shopifyDiscountCode,
  };
  // Keep database calls outside the parse-error boundary: deadlocks and other
  // transient database failures must reach the outer transaction retry helper.
  const cleanup = await tx.weleticShopifyVoucherCleanup.findUnique({
    where: { storeId_redemptionId: { storeId, redemptionId: redemption.id } },
  });
  let usageLimit: number | null;
  let perCustomerLimit: number | null;
  try {
    const award = reviewCouponAwardSchema.parse(claim.awardSnapshot);
    const promised = reviewIncentivePolicySnapshotSchema.parse(policy.snapshot);
    if (
      policy.contentDigest !== reviewIncentivePolicyDigest(promised) ||
      JSON.stringify(award) !== JSON.stringify(promised.award) ||
      award.terms.rewardDefinitionId !== redemption.rewardDefinitionId
    )
      return refuse("shopper_coupon_policy_mismatch");
    usageLimit = award.terms.usageLimit;
    perCustomerLimit = award.terms.usageLimitPerCustomer;
    const metadata = object(redemption.metadata);
    const direct = object(metadata.directFulfillment);
    const ownership = getPersistedLoyaltyDiscountProvisioningIdentity({
      identity: ownershipIdentity,
      metadata: redemption.metadata,
    });
    if (
      ownership?.version === 2 &&
      direct.version === 1 &&
      direct.claimId === claim.id &&
      direct.installationGeneration === installationGeneration &&
      verifiedDiscountId(redemption.shopifyDiscountId) &&
      redemption.status !== "provisioning" &&
      ["fulfilled", "reversed", "invalidated", "privacy_redacted"].includes(
        claim.status,
      )
    ) {
      const snapshot = readLoyaltyRedemptionProvisioningSnapshot(
        redemption.metadata,
      );
      if (!snapshot?.currencyVerifiedAt)
        return refuse("shopper_coupon_snapshot_unavailable");
      const expected = createLoyaltyRedemptionProvisioningSnapshot({
        reward: { ...award.terms, id: award.terms.rewardDefinitionId },
        pointsCost: BigInt(0),
        discountValue: award.terms.discountValue,
        expiresInDays: award.terms.expiresInDays,
        shopCurrency: award.terms.shopCurrency,
        currencyVerifiedAt: new Date(snapshot.currencyVerifiedAt),
        customerSelectionDigest: snapshot.customerSelectionDigest,
        startsAt: new Date(snapshot.startsAt),
        expiresAt: redemption.expiresAt,
      });
      if (snapshot.contentDigest !== expected.contentDigest)
        return refuse("shopper_coupon_snapshot_mismatch");
      assertProvisioningReplayMatchesSnapshot({
        snapshot,
        pointsCostOverride: BigInt(0),
        storeId,
        shopifyCustomerId: customerId,
      });
    } else {
      // Privacy cleanup intentionally replaces provisioning metadata. Its
      // retained, remotely verified ownership snapshot is the alternative proof.
      const snapshot = object(cleanup?.ownershipSnapshot);
      if (
        !cleanup?.remoteVerifiedAt ||
        !verifiedDiscountId(cleanup.expectedDiscountId) ||
        (redemption.shopifyDiscountId !== null &&
          cleanup.expectedDiscountId !== redemption.shopifyDiscountId) ||
        snapshot.version !== 2 ||
        snapshot.kind !== "shopper" ||
        snapshot.captureError !== null ||
        snapshot.shopperId !== shopper.id ||
        snapshot.claimId !== claim.id ||
        snapshot.installationGeneration !== installationGeneration ||
        snapshot.ownershipFingerprint !==
          getLoyaltyDiscountOwnershipFingerprint(ownershipIdentity) ||
        cleanup.expectedDiscountCodeCanonical !==
          canonicalizeLoyaltyDiscountCode(redemption.shopifyDiscountCode) ||
        !["deactivated", "used_preserved"].includes(cleanup.remoteOutcome ?? "")
      )
        return refuse("shopper_coupon_provisioning_unverified");
    }
  } catch {
    return refuse("shopper_coupon_evidence_invalid");
  }
  const amount = readShopifyCouponUseAmount(
    orderDiscountEvidence,
    redemption.shopifyDiscountCode,
  );
  const existing = await tx.weleticRewardCouponUse.findUnique({
    where: {
      storeId_redemptionId_orderExternalId: {
        storeId,
        redemptionId: redemption.id,
        orderExternalId: externalId,
      },
    },
  });
  if (existing) {
    if (
      existing.shopperId !== shopper.id ||
      existing.installationGeneration !== installationGeneration ||
      existing.source !== "shopify_orders_paid" ||
      existing.usedAt.getTime() !== usedAt.getTime() ||
      existing.discountAmountMinor !== amount.discountAmountMinor ||
      existing.currency !== amount.currency ||
      existing.amountUnavailableReason !== amount.amountUnavailableReason
    )
      return refuse("shopper_coupon_use_evidence_conflict");
    return { marked: false, corrected: false };
  }
  await tx.weleticRewardCouponUse.create({
    data: {
      id: createWeleticId("wrcu_"),
      storeId,
      redemptionId: redemption.id,
      shopperId: shopper.id,
      orderExternalId: externalId,
      installationGeneration,
      source: "shopify_orders_paid",
      usedAt,
      ...amount,
      priorRedemptionStatus: redemption.status,
    },
  });
  // Provider cleanup can have observed usage before its order webhook. Fill the
  // absent order projection, but never replace an already identified first use.
  if (redemption.status !== "used" || redemption.orderId === null) {
    await tx.weleticRewardRedemption.update({
      where: { id: redemption.id },
      data: {
        status: "used",
        ...(redemption.orderId === null ? { orderId: externalId, usedAt } : {}),
      },
    });
  }
  const uses = await tx.weleticRewardCouponUse.count({
    where: { storeId, redemptionId: redemption.id },
  });
  if (
    cleanup?.status === "completed" &&
    ["invalidated", "privacy_redacted"].includes(claim.status)
  ) {
    const { completeReviewInvalidationFromVoucherCleanup } = await import(
      "@/lib/weletic/reviews/incentive-invalidation-completion"
    );
    await completeReviewInvalidationFromVoucherCleanup({
      tx,
      storeId,
      cleanupId: cleanup.id,
    });
  }
  const issue =
    (usageLimit !== null && usageLimit > 0 && uses > usageLimit) ||
    (perCustomerLimit === 1 && uses > 1)
      ? "shopper_coupon_usage_limit_exceeded"
      : amount.amountUnavailableReason
        ? "shopper_coupon_amount_unavailable"
        : undefined;
  return {
    marked: redemption.status !== "used",
    corrected: false,
    ...(issue ? { issue } : {}),
  };
}
