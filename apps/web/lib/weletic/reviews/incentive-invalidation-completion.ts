import { getLoyaltyDiscountOwnershipFingerprint } from "@/lib/weletic/loyalty/redemption-discount-identity";
import { DIRECT_REVIEW_REWARD_SOURCE } from "@/lib/weletic/loyalty/reward-ownership";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  reviewInvalidationAwardSchema,
  reviewInvalidationSnapshotSchema,
} from "./incentive-decision";
import {
  reviewIncentivePolicyDigest,
  reviewIncentivePolicySnapshotSchema,
} from "./incentive-policy";

/** Called by the existing voucher worker in its winning-lease transaction.
 * Privacy may have taken over the same cleanup; only outcome projections are
 * advanced, never the confirmed decision or erased review/customer fields.
 */
export async function completeReviewInvalidationFromVoucherCleanup({
  tx,
  storeId,
  cleanupId,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  cleanupId: string;
}) {
  const invalidation = await tx.weleticReviewIncentiveInvalidation.findUnique({
    where: { storeId_cleanupId: { storeId, cleanupId } },
  });
  if (!invalidation) return;
  const snapshot = reviewInvalidationSnapshotSchema.parse(
    invalidation.decisionSnapshot,
  );
  const cleanup = await tx.weleticShopifyVoucherCleanup.findUnique({
    where: { storeId_id: { storeId, id: cleanupId } },
  });
  const claim = await tx.weleticReviewIncentiveClaim.findFirst({
    where: { id: invalidation.claimId, storeId },
    include: { policy: true },
  });
  const redemption = await tx.weleticRewardRedemption.findFirst({
    where: { id: snapshot.redemptionId ?? "", storeId },
  });
  const owner = z
    .object({
      version: z.literal(2),
      kind: z.literal("shopper"),
      shopperId: z.literal(invalidation.shopperId),
      claimId: z.literal(invalidation.claimId),
      installationGeneration: z.literal(invalidation.installationGeneration),
      ownershipFingerprint: z.string(),
      captureError: z.null(),
    })
    .safeParse(cleanup?.ownershipSnapshot);
  const policy = reviewIncentivePolicySnapshotSchema.safeParse(
    claim?.policy.snapshot,
  );
  const award = reviewInvalidationAwardSchema.safeParse(claim?.awardSnapshot);
  if (
    !cleanup ||
    cleanup.status !== "completed" ||
    !cleanup.completedAt ||
    !["used_preserved", "deactivated", "verified_absent"].includes(
      cleanup.remoteOutcome ?? "",
    ) ||
    !claim ||
    claim.policyId !== snapshot.policyId ||
    claim.sourceReviewId !== snapshot.sourceReviewId ||
    claim.policy.storeId !== storeId ||
    claim.policy.contentDigest !== snapshot.policyDigest ||
    !policy.success ||
    reviewIncentivePolicyDigest(policy.data) !== snapshot.policyDigest ||
    policy.data.award.kind !== "coupon" ||
    JSON.stringify(policy.data.award) !== JSON.stringify(snapshot.award) ||
    !award.success ||
    JSON.stringify(award.data) !== JSON.stringify(snapshot.award) ||
    claim.shopperId !== invalidation.shopperId ||
    !["invalidated", "privacy_redacted"].includes(claim.status) ||
    snapshot.award.kind !== "coupon" ||
    !redemption ||
    cleanup.redemptionId !== redemption.id ||
    redemption.accountId !== null ||
    redemption.shopperId !== invalidation.shopperId ||
    redemption.fulfillmentSource !== DIRECT_REVIEW_REWARD_SOURCE ||
    redemption.fulfillmentReference !== claim.id ||
    redemption.pointsSpent !== BigInt(0) ||
    redemption.ledgerEntryId !== null ||
    redemption.artifactKind !== "discount_code" ||
    redemption.rewardDefinitionId !== snapshot.award.terms.rewardDefinitionId ||
    !owner.success ||
    owner.data.ownershipFingerprint !==
      getLoyaltyDiscountOwnershipFingerprint({
        storeId,
        redemptionId: redemption.id,
        ownerKind: "shopper",
        shopperId: invalidation.shopperId,
        fulfillmentSource: DIRECT_REVIEW_REWARD_SOURCE,
        fulfillmentReference: claim.id,
        rewardDefinitionId: redemption.rewardDefinitionId,
        discountCode: redemption.shopifyDiscountCode,
      })
  )
    throw new Error(
      "Review invalidation cleanup evidence requires reconciliation",
    );
  const used =
    cleanup.remoteOutcome === "used_preserved" ||
    redemption.status === "used" ||
    (await tx.weleticRewardCouponUse.count({
      where: {
        storeId,
        redemptionId: redemption.id,
        shopperId: invalidation.shopperId,
      },
    })) > 0;
  const outcome = used
    ? "coupon_used"
    : cleanup.remoteOutcome === "verified_absent"
      ? "coupon_absent"
      : "coupon_deactivated";
  await tx.weleticReviewIncentiveInvalidation.update({
    where: { id: invalidation.id },
    data: {
      outcome,
      completedAt: invalidation.completedAt ?? cleanup.completedAt,
    },
  });
  await tx.weleticProductReview.updateMany({
    where: {
      id: snapshot.sourceReviewId,
      storeId,
      shopperId: invalidation.shopperId,
      redactedAt: null,
      status: { not: "redacted" },
      participationStatus: "invalidated",
    },
    data: {
      rewardStatus: used ? "unrecoverable" : "invalidated",
      rewardReason: invalidation.reason,
    },
  });
}
