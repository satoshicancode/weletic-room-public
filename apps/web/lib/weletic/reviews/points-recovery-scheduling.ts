import { enqueueOutboxJobFromProgramTransaction } from "@/lib/weletic/loyalty/outbox";
import type { Prisma } from "@prisma/client";
import { ReviewError } from "./contracts";
import {
  ReviewPointsRecoveryPayloadSchema,
  reviewPointsRecoveryKey,
} from "./points-recovery-contract";

/** Caller owns the store/program transaction fence. One durable queue identity
 * per claim; a producer must never reset cancelled/completed/dead-letter jobs.
 */
export async function scheduleReviewPointsRecovery({
  tx,
  storeId,
  claimId,
  shopperId,
  installationGeneration,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  claimId: string;
  shopperId: string;
  installationGeneration: string;
}) {
  const payload = ReviewPointsRecoveryPayloadSchema.parse({
    claimId,
    shopperId,
    installationGeneration,
  });
  const claim = await tx.weleticReviewIncentiveClaim.findFirst({
    where: { id: claimId, storeId, shopperId, status: "reserved" },
    select: {
      subjectType: true,
      awardSnapshot: true,
      validationSnapshot: true,
    },
  });
  const award = claim?.awardSnapshot;
  const validation = claim?.validationSnapshot;
  if (
    !claim ||
    claim.subjectType !== "product" ||
    !award ||
    typeof award !== "object" ||
    Array.isArray(award) ||
    award.kind !== "points" ||
    !validation ||
    typeof validation !== "object" ||
    Array.isArray(validation) ||
    validation.installationGeneration !== installationGeneration
  )
    throw new ReviewError(
      "conflict",
      "Review recovery source requires reconciliation",
    );

  const result = await enqueueOutboxJobFromProgramTransaction({
    tx,
    storeId,
    jobType: "REVIEW_POINTS_RECOVERY",
    payload,
    idempotencyKey: reviewPointsRecoveryKey(claimId),
    priority: -5,
  });
  const persisted = ReviewPointsRecoveryPayloadSchema.parse(result.job.payload);
  if (
    result.job.storeId !== storeId ||
    result.job.jobType !== "REVIEW_POINTS_RECOVERY" ||
    persisted.claimId !== claimId ||
    persisted.shopperId !== shopperId ||
    persisted.installationGeneration !== installationGeneration
  )
    throw new ReviewError(
      "conflict",
      "Review recovery queue identity conflicts",
    );
  return result;
}
