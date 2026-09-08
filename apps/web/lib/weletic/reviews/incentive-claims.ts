import { createWeleticId } from "@/lib/weletic/ids";
import { reserveShopperReviewCoupon } from "@/lib/weletic/loyalty/shopper-coupon-reservation";
import type { Prisma } from "@prisma/client";
import { ReviewError } from "./contracts";
import { reviewParticipationContentDigest } from "./incentive-evidence";
import { fulfillReviewPointsClaimInTransaction } from "./incentive-points";
import {
  reviewIncentivePolicyDigest,
  selectReviewIncentiveAward,
} from "./incentive-policy";
import {
  assertReviewPurchase,
  assertReviewPurchaseNotSuppressed,
  reviewRequestInclude,
} from "./purchase";
import { withReviewMutation } from "./transaction";
export { reviewParticipationContentDigest } from "./incentive-evidence";

/** Reserves only after durable trusted validation, including a shared coupon/job
 * when promised. Points for an active loyalty account are fulfilled in the same
 * transaction; otherwise the immutable claim remains reserved. No remote
 * issuance, enrollment or publication-based participation evidence occurs.
 */
export function reserveProductReviewIncentive({
  storeId,
  reviewId,
  expectedInstallationGeneration,
}: {
  storeId: string;
  reviewId: string;
  expectedInstallationGeneration: string;
}) {
  return withReviewMutation(
    storeId,
    (tx, generation) =>
      reserveProductReviewIncentiveInTransaction({
        tx,
        storeId,
        reviewId,
        generation,
      }),
    expectedInstallationGeneration,
  );
}

/** Caller holds the store-first mutation fence; submission must not nest a
 * second store-locking transaction around its token, claim or financial writes.
 */
export async function reserveProductReviewIncentiveInTransaction({
  tx,
  storeId,
  reviewId,
  generation,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  reviewId: string;
  generation: string | null;
}) {
  const settings = await tx.weleticReviewSettings.findUnique({
    where: { storeId },
  });
  if (!settings?.enabled)
    throw new ReviewError("disabled", "Reviews are unavailable");
  const review = await tx.weleticProductReview.findFirst({
    where: { id: reviewId, storeId },
    include: { request: { include: reviewRequestInclude }, media: true },
  });
  if (
    !review ||
    review.status === "redacted" ||
    review.redactedAt ||
    review.request.storeId !== storeId ||
    review.request.shopperId !== review.shopperId ||
    review.request.productId !== review.productId ||
    review.request.status !== "submitted"
  )
    throw new ReviewError("not_found", "Review unavailable");
  assertReviewPurchase(review.request, generation);
  await assertReviewPurchaseNotSuppressed(tx, review.request);
  if (
    await tx.weleticReviewOrderCancellation.findUnique({
      where: {
        storeId_orderExternalId: {
          storeId,
          orderExternalId: review.request.order.externalId,
        },
      },
    })
  )
    throw new ReviewError("unavailable", "Purchase is no longer eligible");
  const media = review.media.filter(
    (item) =>
      item.status === "uploaded" &&
      item.storeId === storeId &&
      item.requestId === review.requestId,
  );
  const digest = reviewParticipationContentDigest({
    ...review,
    mediaIds: media.map((item) => item.id),
  });
  if (
    !review.verifiedPurchase ||
    review.participationStatus !== "validated" ||
    !review.participationValidatedAt ||
    review.participationValidationRevision !== "purchase_abuse_v1" ||
    review.participationContentDigest !== digest
  )
    throw new ReviewError(
      "unavailable",
      "Trusted participation validation is required",
    );
  if (!review.request.incentivePolicyId)
    throw new ReviewError(
      "unavailable",
      "Historical review uses its original reward policy",
    );
  if (
    await tx.weleticReviewRequest.findFirst({
      where: {
        storeId,
        orderId: review.request.orderId,
        incentivePolicyId: null,
      },
      select: { id: true },
    })
  )
    throw new ReviewError(
      "unavailable",
      "Order has legacy review invitations; incentive reconciliation is required",
    );
  const policy = await tx.weleticReviewIncentivePolicy.findUnique({
    where: {
      storeId_id: { storeId, id: review.request.incentivePolicyId },
    },
  });
  if (
    !policy ||
    policy.contentDigest !== reviewIncentivePolicyDigest(policy.snapshot)
  )
    throw new ReviewError(
      "unavailable",
      "Promised incentive policy is unavailable",
    );
  const award = selectReviewIncentiveAward(policy.snapshot, {
    hasPhoto: media.some((item) => item.contentType.startsWith("image/")),
    // Uploaded currently means validated photos, not quarantined video.
    hasVideo: false,
  });
  if (
    award.kind === "none" ||
    (award.kind === "points" && award.points === "0")
  )
    return { status: "no_incentive" as const, claim: null, created: false };
  const existing = await tx.weleticReviewIncentiveClaim.findUnique({
    where: {
      storeId_orderId: { storeId, orderId: review.request.orderId },
    },
  });
  if (existing) {
    if (existing.shopperId !== review.shopperId)
      throw new ReviewError(
        "conflict",
        "Order incentive ownership requires reconciliation",
      );
    return {
      status: "already_claimed" as const,
      claim: existing,
      created: false,
    };
  }
  const claim = await tx.weleticReviewIncentiveClaim.create({
    data: {
      id: createWeleticId("wrevclaim_"),
      storeId,
      orderId: review.request.orderId,
      shopperId: review.shopperId,
      policyId: policy.id,
      sourceReviewId: review.id,
      subjectType: "product",
      awardSnapshot: award,
      validationSnapshot: {
        revision: review.participationValidationRevision,
        validatedAt: review.participationValidatedAt.toISOString(),
        contentDigest: digest,
        installationGeneration: generation,
      },
    },
  });
  // The promise influences participation even before fulfillment. Published
  // content must disclose a reserved coupon or points awaiting enrollment.
  await tx.weleticProductReview.update({
    where: { id: review.id },
    data: { incentivized: true },
  });
  if (award.kind === "coupon") {
    if (!generation)
      throw new ReviewError(
        "unavailable",
        "Current installation identity is required",
      );
    await reserveShopperReviewCoupon({
      tx,
      storeId,
      claimId: claim.id,
      installationGeneration: generation,
    });
  } else if (award.kind === "points") {
    if (!generation)
      throw new ReviewError(
        "unavailable",
        "Current installation identity is required",
      );
    const fulfillment = await fulfillReviewPointsClaimInTransaction({
      tx,
      storeId,
      claimId: claim.id,
      generation,
    });
    if (fulfillment.status === "fulfilled")
      return {
        status: "fulfilled" as const,
        claim: await tx.weleticReviewIncentiveClaim.findUniqueOrThrow({
          where: { id: claim.id },
        }),
        created: true,
      };
  }
  return { status: "reserved" as const, claim, created: true };
}
