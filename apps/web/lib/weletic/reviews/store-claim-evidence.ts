import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ReviewError } from "./contracts";
import { reviewInvalidationAwardSchema } from "./incentive-decision";
import { storeReviewParticipationContentDigest } from "./incentive-evidence";
import {
  reviewIncentivePolicyDigest,
  selectReviewIncentiveAward,
} from "./incentive-policy";
import { assertReviewPurchaseNotSuppressed } from "./purchase";
import {
  assertStoreReviewPurchaseIdentity,
  assertStoreReviewRequestLineBindings,
  storeReviewRequestInclude,
} from "./store-purchase";

/** Revalidate the saved text-only promise before a provider can issue value.
 * Later refunds do not revoke accepted participation; identity and privacy do.
 */
export async function assertStoreReviewClaimEvidence({
  tx,
  storeId,
  generation,
  claim,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  generation: string;
  claim: Prisma.WeleticReviewIncentiveClaimGetPayload<{
    include: { policy: true };
  }>;
}) {
  const review = await tx.weleticStoreReview.findFirst({
    where: { id: claim.sourceReviewId, storeId, source: "invitation" },
    include: { request: { include: storeReviewRequestInclude } },
  });
  const validation = z
    .object({
      revision: z.literal("store_purchase_abuse_v1"),
      validatedAt: z.string().datetime(),
      contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
      installationGeneration: z.literal(generation),
    })
    .strict()
    .parse(claim.validationSnapshot);
  if (
    claim.subjectType !== "store" ||
    claim.storeId !== storeId ||
    !review?.request ||
    review.shopperId !== claim.shopperId ||
    review.request.shopperId !== claim.shopperId ||
    review.request.storeId !== storeId ||
    review.request.orderId !== claim.orderId ||
    review.request.incentivePolicyId !== claim.policyId ||
    review.request.status !== "submitted" ||
    review.redactedAt ||
    review.status === "redacted" ||
    !review.verifiedPurchase ||
    review.participationStatus !== "validated" ||
    review.participationValidationRevision !== validation.revision ||
    review.participationValidatedAt?.toISOString() !== validation.validatedAt ||
    review.participationContentDigest !== validation.contentDigest ||
    storeReviewParticipationContentDigest(review) !==
      validation.contentDigest ||
    claim.policy.storeId !== storeId ||
    claim.policy.id !== claim.policyId ||
    reviewIncentivePolicyDigest(claim.policy.snapshot) !==
      claim.policy.contentDigest ||
    JSON.stringify(
      selectReviewIncentiveAward(claim.policy.snapshot, {
        hasPhoto: false,
        hasVideo: false,
      }),
    ) !==
      JSON.stringify(reviewInvalidationAwardSchema.parse(claim.awardSnapshot))
  )
    throw new ReviewError(
      "conflict",
      "Store review claim evidence requires reconciliation",
    );
  assertStoreReviewRequestLineBindings(review.request);
  assertStoreReviewPurchaseIdentity(review.request, generation);
  await assertReviewPurchaseNotSuppressed(tx, review.request);
  return review;
}
