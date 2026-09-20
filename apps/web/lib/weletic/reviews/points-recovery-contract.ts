import { z } from "zod";

// Durable identities only: never accept a points amount, policy, account balance,
// or enrollment instruction from a queue payload.
export const ReviewPointsRecoveryPayloadSchema = z
  .object({
    claimId: z.string().min(1).max(191),
    shopperId: z.string().min(1).max(191),
    installationGeneration: z.string().min(1).max(64),
  })
  .strict();

export const reviewPointsRecoveryKey = (claimId: string) =>
  `review_points_recovery:${claimId}`;

/** Eligibility waiting is not a failed financial attempt. The outbox must
 * restore only its winning lease and defer, without resetting real failures.
 */
export class ReviewPointsRecoveryPendingError extends Error {
  constructor() {
    super("Review points recovery is waiting for eligible module enrollment");
    this.name = "ReviewPointsRecoveryPendingError";
  }
}

export class ReviewPointsRecoveryReconciliationError extends Error {
  constructor() {
    super("Review points recovery requires installation reconciliation");
    this.name = "ReviewPointsRecoveryReconciliationError";
  }
}
