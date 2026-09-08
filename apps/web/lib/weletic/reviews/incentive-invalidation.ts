import { createWeleticId } from "@/lib/weletic/ids";
import { DIRECT_REVIEW_REWARD_SOURCE } from "@/lib/weletic/loyalty/reward-ownership";
import { enqueueVoucherPrivacyCleanup } from "@/lib/weletic/loyalty/voucher-privacy-cleanup";
import { z } from "zod";
import { ReviewError } from "./contracts";
import {
  reviewIncentiveDecisionSchema,
  reviewInvalidationAwardSchema,
  reviewInvalidationSnapshotSchema,
} from "./incentive-decision";
import { reviewIncentivePointsKey } from "./incentive-points";
import {
  reviewIncentivePolicyDigest,
  reviewIncentivePolicySnapshotSchema,
  selectReviewIncentiveAward,
} from "./incentive-policy";
import { reverseReviewPointsClaimInTransaction } from "./incentive-reversal";
import { withReviewMutation } from "./transaction";

/** Internal confirmed-invalidity boundary. No public adjudication route or
 * automatic moderation/refund caller is activated here. The original claim,
 * policy, award and validation snapshots remain intact.
 */
export function invalidateReviewIncentive({
  storeId,
  claimId,
  expectedInstallationGeneration,
  decision: input,
}: {
  storeId: string;
  claimId: string;
  expectedInstallationGeneration: string;
  decision: z.input<typeof reviewIncentiveDecisionSchema>;
}) {
  const decision = reviewIncentiveDecisionSchema.parse(input);
  if (!expectedInstallationGeneration)
    throw new ReviewError("unavailable", "Installation identity is required");
  return withReviewMutation(
    storeId,
    async (tx, generation) => {
      if (!generation)
        throw new ReviewError(
          "unavailable",
          "Installation identity is required",
        );
      const claim = await tx.weleticReviewIncentiveClaim.findFirst({
        where: { id: claimId, storeId },
        include: {
          policy: true,
          order: true,
          shopper: { include: { privacyTombstones: true } },
        },
      });
      if (
        !claim ||
        claim.subjectType !== "product" ||
        claim.shopper.storeId !== storeId ||
        claim.order.storeId !== storeId ||
        claim.order.shopperId !== claim.shopperId ||
        claim.policy.storeId !== storeId ||
        claim.shopper.privacyTombstones.length
      )
        throw new ReviewError(
          "unavailable",
          "Owned review claim is unavailable",
        );
      const policy = reviewIncentivePolicySnapshotSchema.parse(
        claim.policy.snapshot,
      );
      if (
        claim.policy.contentDigest !== reviewIncentivePolicyDigest(policy) ||
        !z
          .object({ installationGeneration: z.literal(generation) })
          .safeParse(claim.validationSnapshot).success
      )
        throw new ReviewError(
          "conflict",
          "Claim evidence requires reconciliation",
        );
      // Validate the immutable award against the finite original policy choices,
      // not edited review content or today's settings. Fraud adjudication must
      // remain possible after an edit without inventing a different award.
      const awards = [
        { hasPhoto: false, hasVideo: false },
        { hasPhoto: true, hasVideo: false },
        { hasPhoto: false, hasVideo: true },
        { hasPhoto: true, hasVideo: true },
      ].map((media) => selectReviewIncentiveAward(policy, media));
      const claimedAward = reviewInvalidationAwardSchema.parse(
        claim.awardSnapshot,
      );
      const award = awards.find(
        (candidate) =>
          JSON.stringify(candidate) === JSON.stringify(claimedAward),
      );
      if (
        !award ||
        award.kind === "none" ||
        (award.kind === "points" && award.points === "0")
      )
        throw new ReviewError(
          "conflict",
          "Claim award requires reconciliation",
        );
      const review = await tx.weleticProductReview.findFirst({
        where: { id: claim.sourceReviewId, storeId },
        include: { request: true },
      });
      if (
        !review ||
        review.shopperId !== claim.shopperId ||
        review.redactedAt ||
        review.status === "redacted" ||
        review.participationStatus === "privacy_redacted" ||
        review.request.storeId !== storeId ||
        review.request.shopperId !== claim.shopperId ||
        review.request.orderId !== claim.orderId ||
        review.request.incentivePolicyId !== claim.policyId ||
        review.request.installationGeneration !== generation
      )
        throw new ReviewError(
          "conflict",
          "Review ownership requires reconciliation",
        );
      const redemptions = await tx.weleticRewardRedemption.findMany({
        where: { storeId, fulfillmentReference: claimId },
        take: 2,
      });
      const existing = await tx.weleticReviewIncentiveInvalidation.findUnique({
        where: { storeId_claimId: { storeId, claimId } },
      });
      if (existing) {
        const snapshot = reviewInvalidationSnapshotSchema.parse(
          existing.decisionSnapshot,
        );
        if (
          existing.shopperId !== claim.shopperId ||
          existing.installationGeneration !== generation ||
          existing.decisionId !== decision.decisionId ||
          existing.actorUserId !== decision.actorUserId ||
          existing.reason !== decision.reason ||
          snapshot?.revision !== "review_invalidation_v1" ||
          snapshot.policyId !== claim.policyId ||
          snapshot.policyDigest !== claim.policy.contentDigest ||
          snapshot.sourceReviewId !== review.id ||
          JSON.stringify(snapshot.award) !== JSON.stringify(award) ||
          !["invalidated", "reversed"].includes(claim.status) ||
          review.participationStatus !== "invalidated"
        )
          throw new ReviewError(
            "conflict",
            "Invalidation decision requires reconciliation",
          );
        if (award.kind === "points") {
          if (
            snapshot.redemptionId !== null ||
            existing.cleanupId !== null ||
            redemptions.length ||
            !existing.completedAt
          )
            throw new ReviewError(
              "conflict",
              "Points invalidation ownership requires reconciliation",
            );
          if (snapshot.originalStatus === "fulfilled") {
            if (existing.outcome !== "points_reversed")
              throw new ReviewError(
                "conflict",
                "Points invalidation outcome requires reconciliation",
              );
            await reverseReviewPointsClaimInTransaction({
              tx,
              storeId,
              claimId,
              generation,
              decision,
            });
          } else {
            if (
              existing.outcome !== "unpaid_cancelled" ||
              claim.status !== "invalidated" ||
              review.rewardStatus !== "invalidated" ||
              review.rewardLedgerId ||
              (await tx.weleticPointsLedgerEntry.findFirst({
                where: {
                  storeId,
                  OR: [
                    { idempotencyKey: reviewIncentivePointsKey(claimId) },
                    {
                      referenceType: {
                        in: ["REVIEW_INCENTIVE", "REVIEW_INCENTIVE_REVERSAL"],
                      },
                      referenceId: claimId,
                    },
                  ],
                },
                select: { id: true },
              }))
            )
              throw new ReviewError(
                "conflict",
                "Unpaid invalidation financial evidence requires reconciliation",
              );
          }
        } else {
          const redemption = redemptions[0];
          const cleanup = existing.cleanupId
            ? await tx.weleticShopifyVoucherCleanup.findUnique({
                where: { storeId_id: { storeId, id: existing.cleanupId } },
              })
            : null;
          if (
            redemptions.length !== 1 ||
            !redemption ||
            redemption.id !== snapshot.redemptionId ||
            redemption.accountId !== null ||
            redemption.shopperId !== claim.shopperId ||
            redemption.fulfillmentSource !== DIRECT_REVIEW_REWARD_SOURCE ||
            redemption.pointsSpent !== BigInt(0) ||
            redemption.ledgerEntryId !== null ||
            redemption.artifactKind !== "discount_code" ||
            redemption.rewardDefinitionId !== award.terms.rewardDefinitionId ||
            !cleanup ||
            cleanup.redemptionId !== redemption.id ||
            ![
              "pending",
              "coupon_used",
              "coupon_absent",
              "coupon_deactivated",
            ].includes(existing.outcome) ||
            (existing.outcome === "pending"
              ? cleanup.status === "completed"
              : cleanup.status !== "completed" || !existing.completedAt)
          )
            throw new ReviewError(
              "conflict",
              "Coupon invalidation ownership requires reconciliation",
            );
        }
        return {
          status: "already_recorded" as const,
          invalidationId: existing.id,
          outcome: existing.outcome,
        };
      }
      if (!["reserved", "fulfilled"].includes(claim.status))
        throw new ReviewError(
          "conflict",
          "Claim is not eligible for a new decision",
        );
      if (
        await tx.weleticReviewIncentiveInvalidation.findUnique({
          where: {
            storeId_decisionId: { storeId, decisionId: decision.decisionId },
          },
        })
      )
        throw new ReviewError(
          "conflict",
          "Decision identity already belongs to another claim",
        );
      let outcome: string;
      if (award.kind === "points") {
        if (redemptions.length)
          throw new ReviewError(
            "conflict",
            "Points claim has conflicting coupon fulfillment",
          );
        if (claim.status === "fulfilled") {
          await reverseReviewPointsClaimInTransaction({
            tx,
            storeId,
            claimId,
            generation,
            decision,
          });
          outcome = "points_reversed";
        } else {
          const ledger = await tx.weleticPointsLedgerEntry.findFirst({
            where: {
              storeId,
              OR: [
                { idempotencyKey: reviewIncentivePointsKey(claimId) },
                {
                  referenceType: {
                    in: ["REVIEW_INCENTIVE", "REVIEW_INCENTIVE_REVERSAL"],
                  },
                  referenceId: claimId,
                },
              ],
            },
            select: { id: true },
          });
          if (
            ledger ||
            review.rewardLedgerId ||
            ["awarded", "reversed"].includes(review.rewardStatus)
          )
            throw new ReviewError(
              "conflict",
              "Unpaid claim has financial evidence",
            );
          outcome = "unpaid_cancelled";
        }
      } else {
        const redemption = redemptions[0];
        if (
          redemptions.length !== 1 ||
          !redemption ||
          redemption.accountId !== null ||
          redemption.shopperId !== claim.shopperId ||
          redemption.pointsSpent !== BigInt(0) ||
          redemption.ledgerEntryId !== null ||
          redemption.fulfillmentSource !== DIRECT_REVIEW_REWARD_SOURCE ||
          redemption.artifactKind !== "discount_code" ||
          redemption.rewardDefinitionId !== award.terms.rewardDefinitionId ||
          redemption.settlementQuarantinedAt ||
          review.rewardLedgerId
        )
          throw new ReviewError(
            "conflict",
            "Coupon ownership requires reconciliation",
          );
        outcome = "pending";
      }
      const invalidation = await tx.weleticReviewIncentiveInvalidation.create({
        data: {
          id: createWeleticId("wrevinv_"),
          storeId,
          claimId,
          shopperId: claim.shopperId,
          ...decision,
          installationGeneration: generation,
          outcome,
          decisionSnapshot: {
            revision: "review_invalidation_v1",
            policyId: claim.policyId,
            policyDigest: claim.policy.contentDigest,
            sourceReviewId: review.id,
            originalStatus: claim.status,
            award,
            redemptionId: redemptions[0]?.id ?? null,
          },
          completedAt: outcome === "pending" ? null : new Date(),
        },
      });
      if (outcome !== "points_reversed") {
        await tx.weleticReviewIncentiveClaim.update({
          where: { id: claimId },
          data: { status: "invalidated" },
        });
        await tx.weleticProductReview.update({
          where: { id: review.id },
          data: {
            participationStatus: "invalidated",
            rewardStatus:
              outcome === "pending" ? "recovery_pending" : "invalidated",
            rewardReason: decision.reason,
          },
        });
      }
      if (outcome === "pending") {
        const cleanup = await enqueueVoucherPrivacyCleanup({
          tx,
          redemption: redemptions[0],
          source: "review_invalidation",
        });
        if (!cleanup)
          throw new ReviewError(
            "conflict",
            "Coupon cleanup reservation failed",
          );
        await tx.weleticReviewIncentiveInvalidation.update({
          where: { id: invalidation.id },
          data: { cleanupId: cleanup.id },
        });
      }
      return {
        status: "recorded" as const,
        invalidationId: invalidation.id,
        outcome,
      };
    },
    expectedInstallationGeneration,
  );
}
