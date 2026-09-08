import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import { scheduleTierReviewAfterQualifyingActivity } from "@/lib/weletic/loyalty/tier-review-scheduling";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ReviewError } from "./contracts";
import { reviewParticipationContentDigest } from "./incentive-evidence";
import {
  reviewIncentivePolicyDigest,
  selectReviewIncentiveAward,
} from "./incentive-policy";
import {
  assertReviewPurchaseIdentity,
  assertReviewPurchaseNotSuppressed,
  reviewRequestInclude,
} from "./purchase";
import { withReviewMutation } from "./transaction";

const pointsAwardSchema = z
  .object({
    kind: z.literal("points"),
    points: z
      .string()
      .regex(/^[1-9]\d{0,18}$/)
      .refine(
        (value) =>
          /^[1-9]\d{0,18}$/.test(value) &&
          BigInt(value) <= BigInt("9223372036854775807"),
      ),
  })
  .strict();
const validationSchema = z
  .object({
    revision: z.literal("purchase_abuse_v1"),
    validatedAt: z.string().datetime(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    installationGeneration: z.string().min(1),
  })
  .strict();

export const reviewIncentivePointsKey = (claimId: string) =>
  `review_incentive_points:${claimId}`;

/** The caller must hold the store/program mutation fence. Claim, ledger, review
 * marker and downstream events commit together; no network or enrollment occurs.
 */
export async function fulfillReviewPointsClaimInTransaction({
  tx,
  storeId,
  claimId,
  generation,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  claimId: string;
  generation: string;
}) {
  const claim = await tx.weleticReviewIncentiveClaim.findFirst({
    where: { id: claimId, storeId },
    include: { policy: true },
  });
  if (
    !claim ||
    claim.subjectType !== "product" ||
    !["reserved", "fulfilled"].includes(claim.status)
  )
    throw new ReviewError(
      "unavailable",
      "Review incentive claim is not eligible for points fulfillment",
    );
  const award = pointsAwardSchema.parse(claim.awardSnapshot);
  const validation = validationSchema.parse(claim.validationSnapshot);
  if (
    validation.installationGeneration !== generation ||
    claim.policy.storeId !== storeId ||
    claim.policy.contentDigest !==
      reviewIncentivePolicyDigest(claim.policy.snapshot)
  )
    throw new ReviewError(
      "conflict",
      "Review incentive policy or installation requires reconciliation",
    );
  const review = await tx.weleticProductReview.findFirst({
    where: { id: claim.sourceReviewId, storeId },
    include: { request: { include: reviewRequestInclude }, media: true },
  });
  if (
    !review ||
    review.shopperId !== claim.shopperId ||
    review.redactedAt ||
    review.status === "redacted" ||
    review.request.storeId !== storeId ||
    review.request.shopperId !== claim.shopperId ||
    review.request.orderId !== claim.orderId ||
    review.request.incentivePolicyId !== claim.policyId ||
    review.request.productId !== review.productId ||
    review.request.status !== "submitted" ||
    !review.verifiedPurchase ||
    review.participationStatus !== "validated"
  )
    throw new ReviewError(
      "unavailable",
      "Validated review participation is unavailable",
    );
  await assertReviewPurchaseNotSuppressed(tx, review.request);
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
    digest !== validation.contentDigest ||
    review.participationContentDigest !== digest ||
    review.participationValidationRevision !== validation.revision ||
    review.participationValidatedAt?.toISOString() !== validation.validatedAt ||
    JSON.stringify(
      selectReviewIncentiveAward(claim.policy.snapshot, {
        hasPhoto: media.some((item) => item.contentType.startsWith("image/")),
        hasVideo: false,
      }),
    ) !== JSON.stringify(award)
  )
    throw new ReviewError(
      "conflict",
      "Review incentive differs from its immutable participation evidence",
    );
  // Historical invitations or either coupon source must never share this award.
  if (
    (await tx.weleticReviewRequest.findFirst({
      where: { storeId, orderId: claim.orderId, incentivePolicyId: null },
      select: { id: true },
    })) ||
    (await tx.weleticRewardRedemption.findFirst({
      where: { storeId, fulfillmentReference: claim.id },
      select: { id: true },
    }))
  )
    throw new ReviewError(
      "conflict",
      "Review incentive has conflicting historical or coupon fulfillment",
    );
  const idempotencyKey = reviewIncentivePointsKey(claim.id);
  const existing = await tx.weleticPointsLedgerEntry.findUnique({
    where: { storeId_idempotencyKey: { storeId, idempotencyKey } },
    include: { account: true },
  });
  if (existing) {
    if (
      claim.status !== "fulfilled" ||
      existing.account.storeId !== storeId ||
      existing.account.shopperId !== claim.shopperId ||
      existing.entryType !== "EARN_BONUS" ||
      existing.pointsDelta !== BigInt(award.points) ||
      existing.pendingDelta !== BigInt(0) ||
      existing.referenceType !== "REVIEW_INCENTIVE" ||
      existing.referenceId !== claim.id ||
      existing.grantId !== null ||
      review.rewardLedgerId !== existing.id ||
      review.rewardStatus !== "awarded"
    )
      throw new ReviewError(
        "conflict",
        "Review incentive ledger evidence requires reconciliation",
      );
    return {
      status: "already_fulfilled" as const,
      ledgerEntryId: existing.id,
      points: existing.pointsDelta.toString(),
    };
  }
  if (
    claim.status === "fulfilled" ||
    review.rewardLedgerId ||
    review.rewardStatus === "awarded" ||
    review.rewardStatus === "reversed"
  )
    throw new ReviewError(
      "conflict",
      "Review incentive ledger evidence is missing or conflicting",
    );
  // A durable claim already passed purchase validation. Ordinary refunds revoke
  // unused invitations, not a legitimate participant's promised award. Keep
  // identity/privacy/generation checks; explicit invalidation blocks above.
  assertReviewPurchaseIdentity(review.request, generation);
  const settings = await tx.weleticReviewSettings.findUnique({
    where: { storeId },
  });
  const account = await tx.weleticLoyaltyAccount.findFirst({
    where: { storeId, shopperId: claim.shopperId },
    include: { program: true },
  });
  if (
    !settings?.enabled ||
    !account ||
    account.status !== "active" ||
    hasShopifyCustomerRedactionTombstone(account.metadata) ||
    account.program.storeId !== storeId ||
    account.program.status !== "active" ||
    account.program.killSwitchActive
  ) {
    await tx.weleticProductReview.update({
      where: { id: review.id },
      data: { rewardReason: "active_reviews_and_loyalty_account_required" },
    });
    return {
      status: "pending" as const,
      reason: "active_reviews_and_loyalty_account_required" as const,
    };
  }
  const entry = await appendPointsLedgerEntry({
    storeId,
    accountId: account.id,
    entryType: "EARN_BONUS",
    pointsDelta: BigInt(award.points),
    referenceType: "REVIEW_INCENTIVE",
    referenceId: claim.id,
    idempotencyKey,
    reason: "Validated review participation",
    metadata: { claimId: claim.id, policyId: claim.policyId },
    tx,
  });
  await tx.weleticReviewIncentiveClaim.update({
    where: { id: claim.id },
    data: { status: "fulfilled" },
  });
  await tx.weleticProductReview.update({
    where: { id: review.id },
    data: {
      rewardStatus: "awarded",
      rewardReason: null,
      rewardLedgerId: entry.id,
      incentivized: true,
    },
  });
  await enqueueFlowTriggerJob({
    storeId,
    eventId: entry.id,
    payload: {
      accountId: account.id,
      handle: "weletic-points-earned",
      pointsDelta: entry.pointsDelta.toString(),
      pointsBalance: entry.balanceAfter.toString(),
      reason: "validated_review_participation",
      orderId: review.request.order.externalId,
    },
    tx,
  });
  await scheduleTierReviewAfterQualifyingActivity({
    storeId,
    accountId: account.id,
    activityKey: idempotencyKey,
    reason: "validated_review_participation",
    tx,
  });
  return {
    status: "fulfilled" as const,
    ledgerEntryId: entry.id,
    points: entry.pointsDelta.toString(),
  };
}

/** Fenced internal retry entry point. Merchant retries share the transaction
 * core above; automatic enrollment recovery is not wired yet.
 */
export function fulfillProductReviewPointsIncentive({
  storeId,
  claimId,
  expectedInstallationGeneration,
}: {
  storeId: string;
  claimId: string;
  expectedInstallationGeneration: string;
}) {
  return withReviewMutation(
    storeId,
    (tx, generation) => {
      if (!generation)
        throw new ReviewError(
          "unavailable",
          "Current installation identity is required",
        );
      return fulfillReviewPointsClaimInTransaction({
        tx,
        storeId,
        claimId,
        generation,
      });
    },
    expectedInstallationGeneration,
  );
}
