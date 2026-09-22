import { createWeleticId } from "@/lib/weletic/ids";
import { reserveShopperReviewCoupon } from "@/lib/weletic/loyalty/shopper-coupon-reservation";
import type { Prisma } from "@prisma/client";
import { ReviewError } from "./contracts";
import { storeReviewParticipationContentDigest } from "./incentive-evidence";
import { fulfillReviewPointsClaimInTransaction } from "./incentive-points";
import {
  reviewIncentivePolicyDigest,
  selectReviewIncentiveAward,
} from "./incentive-policy";
import {
  assertStoreReviewRequestLineBindings,
  assertStoreReviewSubmissionPurchase,
  storeReviewRequestInclude,
} from "./store-purchase";

/** Caller owns the active store/program transaction. The existing unique
 * (storeId, orderId) claim arbitrates product and store participation together.
 * No enrollment or remote issuance occurs here; saved promises remain immutable.
 */
export async function reserveStoreReviewIncentiveInTransaction({
  tx,
  storeId,
  reviewId,
  generation,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  reviewId: string;
  generation: string;
}) {
  const [settings, storeSettings] = await Promise.all([
    tx.weleticReviewSettings.findUnique({ where: { storeId } }),
    tx.weleticStoreReviewSettings.findUnique({ where: { storeId } }),
  ]);
  if (!settings?.enabled || !storeSettings?.enabled)
    throw new ReviewError("disabled", "Store reviews unavailable");
  const review = await tx.weleticStoreReview.findFirst({
    where: { id: reviewId, storeId, source: "invitation" },
    include: { request: { include: storeReviewRequestInclude } },
  });
  if (
    !review?.request ||
    review.redactedAt ||
    review.status === "redacted" ||
    review.request.shopperId !== review.shopperId ||
    review.request.status !== "submitted"
  )
    throw new ReviewError("not_found", "Store review unavailable");
  assertStoreReviewRequestLineBindings(review.request);
  await assertStoreReviewSubmissionPurchase({
    tx,
    storeId,
    generation,
    request: review.request,
  });
  const digest = storeReviewParticipationContentDigest(review);
  if (
    !review.verifiedPurchase ||
    review.participationStatus !== "validated" ||
    !review.participationValidatedAt ||
    review.participationValidationRevision !== "store_purchase_abuse_v1" ||
    review.participationContentDigest !== digest
  )
    throw new ReviewError(
      "unavailable",
      "Trusted store participation is required",
    );
  if (
    !review.request.incentivePolicyId ||
    (await tx.weleticReviewRequest.findFirst({
      where: {
        storeId,
        orderId: review.request.orderId,
        incentivePolicyId: null,
      },
      select: { id: true },
    })) ||
    (await tx.weleticReviewOrderCancellation.findUnique({
      where: {
        storeId_orderExternalId: {
          storeId,
          orderExternalId: review.request.order.externalId,
        },
      },
    }))
  )
    throw new ReviewError(
      "unavailable",
      "Order incentive requires reconciliation",
    );
  const policy = await tx.weleticReviewIncentivePolicy.findUnique({
    where: { storeId_id: { storeId, id: review.request.incentivePolicyId } },
  });
  if (
    !policy ||
    policy.contentDigest !== reviewIncentivePolicyDigest(policy.snapshot)
  )
    throw new ReviewError(
      "unavailable",
      "Promised incentive policy unavailable",
    );
  const award = selectReviewIncentiveAward(policy.snapshot, {
    hasPhoto: false,
    hasVideo: false,
  });
  if (
    award.kind === "none" ||
    (award.kind === "points" && award.points === "0")
  )
    return { status: "no_incentive" as const, claim: null, created: false };
  const existing = await tx.weleticReviewIncentiveClaim.findUnique({
    where: { storeId_orderId: { storeId, orderId: review.request.orderId } },
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
      shopperId: review.request.shopperId,
      policyId: policy.id,
      sourceReviewId: review.id,
      subjectType: "store",
      awardSnapshot: award,
      validationSnapshot: {
        revision: "store_purchase_abuse_v1",
        validatedAt: review.participationValidatedAt.toISOString(),
        contentDigest: digest,
        installationGeneration: generation,
      },
    },
  });
  await tx.weleticStoreReview.update({
    where: { id: review.id },
    data: { incentivized: true },
  });
  if (award.kind === "coupon")
    await reserveShopperReviewCoupon({
      tx,
      storeId,
      claimId: claim.id,
      installationGeneration: generation,
    });
  else if (award.kind === "points") {
    const result = await fulfillReviewPointsClaimInTransaction({
      tx,
      storeId,
      claimId: claim.id,
      generation,
    });
    if (result.status === "fulfilled")
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
