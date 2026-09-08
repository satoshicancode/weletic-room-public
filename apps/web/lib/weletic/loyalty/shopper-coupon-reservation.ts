import { createWeleticId } from "@/lib/weletic/ids";
import {
  reviewCouponAwardSchema,
  reviewIncentivePolicyDigest,
  reviewIncentivePolicySnapshotSchema,
} from "@/lib/weletic/reviews/incentive-policy";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { enqueueOutboxJobFromProgramTransaction } from "./outbox";
import {
  canonicalizeLoyaltyDiscountCode,
  createLoyaltyDiscountProvisioningIdentity,
  mergeLoyaltyDiscountOwnershipMetadata,
} from "./redemption-discount-identity";
import {
  createLoyaltyRedemptionProvisioningSnapshot,
  getShopifyCustomerSelectionDigest,
} from "./redemption-provisioning-snapshot";
import { DIRECT_REVIEW_REWARD_SOURCE } from "./reward-ownership";

/** Caller owns the store mutation transaction. No network, loyalty account,
 * points debit, or second coupon catalog is involved in this reservation.
 */
export async function reserveShopperReviewCoupon({
  tx,
  storeId,
  claimId,
  installationGeneration,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  claimId: string;
  installationGeneration: string;
}) {
  const claim = await tx.weleticReviewIncentiveClaim.findFirst({
    where: { id: claimId, storeId, status: "reserved" },
    include: {
      policy: true,
      shopper: { include: { privacyTombstones: true } },
      order: true,
    },
  });
  if (
    !claim ||
    claim.shopper.storeId !== storeId ||
    claim.policy.storeId !== storeId ||
    claim.order.storeId !== storeId ||
    claim.order.shopperId !== claim.shopperId ||
    claim.shopper.privacyTombstones.length
  )
    throw new Error("Shopper incentive reservation is unavailable");
  const award = reviewCouponAwardSchema.parse(claim.awardSnapshot);
  const promised = reviewIncentivePolicySnapshotSchema.parse(
    claim.policy.snapshot,
  );
  if (
    claim.policy.contentDigest !== reviewIncentivePolicyDigest(promised) ||
    JSON.stringify(promised.award) !== JSON.stringify(award)
  )
    throw new Error("Shopper incentive promise requires reconciliation");
  const store = await tx.weleticShopifyStore.findUniqueOrThrow({
    where: { id: storeId },
  });
  if (
    !store.currencyVerifiedAt ||
    store.installationGeneration !== installationGeneration ||
    store.complianceState !== "active" ||
    store.shopCurrency !== award.terms.shopCurrency
  )
    throw new Error("Shopper incentive currency or installation changed");
  const existing = await tx.weleticRewardRedemption.findUnique({
    where: {
      storeId_fulfillmentSource_fulfillmentReference: {
        storeId,
        fulfillmentSource: DIRECT_REVIEW_REWARD_SOURCE,
        fulfillmentReference: claim.id,
      },
    },
  });
  if (existing) {
    if (
      existing.accountId !== null ||
      existing.shopperId !== claim.shopperId ||
      existing.pointsSpent !== BigInt(0) ||
      existing.ledgerEntryId !== null ||
      existing.artifactKind !== "discount_code" ||
      existing.rewardDefinitionId !== award.terms.rewardDefinitionId
    )
      throw new Error("Shopper incentive ownership requires reconciliation");
    return existing;
  }
  const reward = await tx.weleticRewardDefinition.findFirst({
    where: { id: award.terms.rewardDefinitionId, storeId },
    select: { id: true },
  });
  if (!reward) throw new Error("Promised coupon catalog record is unavailable");
  const id = createWeleticId("wredemp_");
  const code = `WLI-${createHash("sha256")
    .update(JSON.stringify([storeId, claim.id]))
    .digest("hex")
    .slice(0, 24)
    .toUpperCase()}`;
  const startsAt = new Date();
  const expiresAt = award.terms.expiresInDays
    ? new Date(startsAt.getTime() + award.terms.expiresInDays * 86_400_000)
    : null;
  const ownership = createLoyaltyDiscountProvisioningIdentity({
    identity: {
      storeId,
      redemptionId: id,
      ownerKind: "shopper",
      shopperId: claim.shopperId,
      fulfillmentSource: DIRECT_REVIEW_REWARD_SOURCE,
      fulfillmentReference: claim.id,
      rewardDefinitionId: reward.id,
      discountCode: code,
    },
    rewardName: award.terms.name,
  });
  const provisioningSnapshot = createLoyaltyRedemptionProvisioningSnapshot({
    reward: { ...award.terms, id: reward.id },
    pointsCost: BigInt(0),
    discountValue: award.terms.discountValue,
    expiresInDays: award.terms.expiresInDays,
    shopCurrency: store.shopCurrency,
    currencyVerifiedAt: store.currencyVerifiedAt,
    customerSelectionDigest: getShopifyCustomerSelectionDigest({
      storeId,
      shopifyCustomerId: claim.shopper.shopifyCustomerId,
    }),
    startsAt,
    expiresAt,
  });
  const redemption = await tx.weleticRewardRedemption.create({
    data: {
      id,
      storeId,
      shopperId: claim.shopperId,
      accountId: null,
      fulfillmentSource: DIRECT_REVIEW_REWARD_SOURCE,
      fulfillmentReference: claim.id,
      rewardDefinitionId: reward.id,
      pointsSpent: BigInt(0),
      ledgerEntryId: null,
      shopifyDiscountCode: code,
      shopifyDiscountCodeCanonical: canonicalizeLoyaltyDiscountCode(code),
      artifactKind: "discount_code",
      status: "provisioning",
      expiresAt,
      idempotencyKey: `review_incentive:${claim.id}`,
      metadata: mergeLoyaltyDiscountOwnershipMetadata({
        ownership,
        metadata: {
          rewardSnapshot: {
            name: award.terms.name,
            rewardType: award.terms.rewardType,
          },
          provisioningSnapshot,
          directFulfillment: {
            version: 1,
            claimId: claim.id,
            installationGeneration,
          },
        },
      }),
    },
  });
  await enqueueOutboxJobFromProgramTransaction({
    tx,
    storeId,
    jobType: "SHOPPER_REWARD_PROVISION",
    payload: { redemptionId: id, claimId: claim.id, installationGeneration },
    idempotencyKey: `shopper_reward_provision:${id}`,
  });
  return redemption;
}
