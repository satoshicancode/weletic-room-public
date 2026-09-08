import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import { scheduleTierReviewAfterQualifyingActivity } from "@/lib/weletic/loyalty/tier-review-scheduling";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ReviewError } from "./contracts";
import { reviewIncentiveDecisionSchema } from "./incentive-decision";
import { reviewIncentivePointsKey } from "./incentive-points";
import { reviewIncentivePolicyDigest } from "./incentive-policy";
import { withReviewMutation } from "./transaction";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,191}$/);
const decisionSchema = reviewIncentiveDecisionSchema;
const reversalEvidenceSchema = decisionSchema
  .extend({
    revision: z.literal("review_incentive_reversal_v1"),
    originalAwardEntryId: identifier,
    claimId: identifier,
    policyId: identifier,
  })
  .strict();
const awardSchema = z
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

export const reviewIncentiveReversalKey = (claimId: string) =>
  `review_incentive_reversal:${claimId}`;

/** Internal financial boundary, not a fraud detector or a moderation action.
 * A future authorized caller must supply a confirmed, audited decision. Never
 * call automatically for rating, publication, refunds or privacy erasure.
 * Caller owns the store/program fence. No original financial row is rewritten.
 */
export async function reverseReviewPointsClaimInTransaction({
  tx,
  storeId,
  claimId,
  generation,
  decision: input,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  claimId: string;
  generation: string;
  decision: z.input<typeof decisionSchema>;
}) {
  const decision = decisionSchema.parse(input);
  const claim = await tx.weleticReviewIncentiveClaim.findFirst({
    where: { id: claimId, storeId },
    include: {
      policy: true,
      shopper: { include: { privacyTombstones: true } },
    },
  });
  if (
    !claim ||
    claim.subjectType !== "product" ||
    !["fulfilled", "reversed"].includes(claim.status) ||
    claim.shopper.storeId !== storeId ||
    claim.shopper.privacyTombstones.length
  )
    throw new ReviewError(
      "unavailable",
      "Owned fulfilled review claim is unavailable",
    );
  const awardSnapshot = awardSchema.parse(claim.awardSnapshot);
  const validation = z
    .object({ installationGeneration: z.literal(generation) })
    .safeParse(claim.validationSnapshot);
  if (
    !validation.success ||
    claim.policy.storeId !== storeId ||
    claim.policy.contentDigest !==
      reviewIncentivePolicyDigest(claim.policy.snapshot)
  )
    throw new ReviewError(
      "conflict",
      "Review incentive evidence requires reconciliation",
    );

  const review = await tx.weleticProductReview.findFirst({
    where: { id: claim.sourceReviewId, storeId },
    include: { request: true },
  });
  const award = await tx.weleticPointsLedgerEntry.findUnique({
    where: {
      storeId_idempotencyKey: {
        storeId,
        idempotencyKey: reviewIncentivePointsKey(claim.id),
      },
    },
    include: { account: { include: { program: true } } },
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
    review.request.installationGeneration !== generation ||
    !award ||
    award.account.storeId !== storeId ||
    award.account.shopperId !== claim.shopperId ||
    award.account.program.storeId !== storeId ||
    hasShopifyCustomerRedactionTombstone(award.account.metadata) ||
    award.entryType !== "EARN_BONUS" ||
    award.pointsDelta !== BigInt(awardSnapshot.points) ||
    award.pendingDelta !== BigInt(0) ||
    award.grantId !== null ||
    award.referenceType !== "REVIEW_INCENTIVE" ||
    award.referenceId !== claim.id ||
    review.rewardLedgerId !== award.id
  )
    throw new ReviewError(
      "conflict",
      "Original review award ownership or ledger evidence is unavailable",
    );
  if (
    await tx.weleticRewardRedemption.findFirst({
      where: { storeId, fulfillmentReference: claim.id },
      select: { id: true },
    })
  )
    throw new ReviewError(
      "conflict",
      "Points claim has conflicting coupon fulfillment",
    );

  const idempotencyKey = reviewIncentiveReversalKey(claim.id);
  const existing = await tx.weleticPointsLedgerEntry.findUnique({
    where: { storeId_idempotencyKey: { storeId, idempotencyKey } },
  });
  const evidence = {
    ...decision,
    revision: "review_incentive_reversal_v1" as const,
    originalAwardEntryId: award.id,
    claimId: claim.id,
    policyId: claim.policyId,
  };
  if (existing) {
    const persisted = reversalEvidenceSchema.safeParse(existing.metadata);
    if (
      claim.status !== "reversed" ||
      review.rewardStatus !== "reversed" ||
      review.participationStatus !== "invalidated" ||
      existing.accountId !== award.accountId ||
      existing.entryType !== "REFUND_REVERSAL" ||
      existing.pointsDelta !== -award.pointsDelta ||
      existing.pendingDelta !== BigInt(0) ||
      existing.grantId !== null ||
      existing.referenceType !== "REVIEW_INCENTIVE_REVERSAL" ||
      existing.referenceId !== claim.id ||
      !persisted.success ||
      JSON.stringify(persisted.data) !==
        JSON.stringify(reversalEvidenceSchema.parse(evidence))
    )
      throw new ReviewError(
        "conflict",
        "Review reversal decision or ledger requires reconciliation",
      );
    return {
      status: "already_reversed" as const,
      ledgerEntryId: existing.id,
      pointsReversed: award.pointsDelta.toString(),
      balanceAfter: existing.balanceAfter.toString(),
    };
  }
  if (claim.status !== "fulfilled" || review.rewardStatus !== "awarded")
    throw new ReviewError(
      "conflict",
      "Review reversal ledger evidence is missing",
    );

  // Reversal uses the original award, never current settings/media or the
  // remaining balance. Spending an invalid award does not cap its correction.
  const entry = await appendPointsLedgerEntry({
    tx,
    storeId,
    accountId: award.accountId,
    entryType: "REFUND_REVERSAL",
    pointsDelta: -award.pointsDelta,
    referenceType: "REVIEW_INCENTIVE_REVERSAL",
    referenceId: claim.id,
    idempotencyKey,
    reason: decision.reason,
    metadata: evidence,
  });
  await tx.weleticReviewIncentiveClaim.update({
    where: { id: claim.id },
    data: { status: "reversed" },
  });
  await tx.weleticProductReview.update({
    where: { id: review.id },
    data: {
      rewardStatus: "reversed",
      rewardReason: decision.reason,
      participationStatus: "invalidated",
    },
  });
  await scheduleTierReviewAfterQualifyingActivity({
    tx,
    storeId,
    accountId: award.accountId,
    activityKey: idempotencyKey,
    reason: "review_incentive_reversed",
  });
  return {
    status: "reversed" as const,
    ledgerEntryId: entry.id,
    pointsReversed: award.pointsDelta.toString(),
    balanceAfter: entry.balanceAfter.toString(),
  };
}

/** Gated internal entry point. No route or worker is activated by this service. */
export function reverseFulfilledReviewPointsIncentive({
  storeId,
  claimId,
  expectedInstallationGeneration,
  decision,
}: {
  storeId: string;
  claimId: string;
  expectedInstallationGeneration: string;
  decision: z.input<typeof decisionSchema>;
}) {
  return withReviewMutation(
    storeId,
    (tx, generation) => {
      if (!generation)
        throw new ReviewError(
          "unavailable",
          "Current installation identity is required",
        );
      return reverseReviewPointsClaimInTransaction({
        tx,
        storeId,
        claimId,
        generation,
        decision,
      });
    },
    expectedInstallationGeneration,
  );
}
