import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { ShopifyStoreOperationalWritesBlockedError } from "@/lib/weletic/shopify/store-compliance-state";
import { ReviewError } from "./contracts";
import { fulfillReviewPointsClaimInTransaction } from "./incentive-points";
import {
  ReviewPointsRecoveryPayloadSchema,
  ReviewPointsRecoveryPendingError,
  ReviewPointsRecoveryReconciliationError,
} from "./points-recovery-contract";
import { withReviewMutation } from "./transaction";

/** Uses the original financial writer and promise, never enrolls a shopper or
 * substitutes the currently active incentive policy. Queue wiring is separate.
 */
export async function recoverReviewPoints({
  storeId,
  payload: input,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  payload: unknown;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const payload = ReviewPointsRecoveryPayloadSchema.parse(input);
  const result = await withReviewMutation(
    storeId,
    async (tx, generation) => {
      if (generation !== payload.installationGeneration)
        throw new ReviewError(
          "conflict",
          "Review recovery installation changed",
        );
      const claim = await tx.weleticReviewIncentiveClaim.findFirst({
        where: {
          id: payload.claimId,
          storeId,
          shopperId: payload.shopperId,
        },
        select: { id: true },
      });
      if (!claim)
        throw new ReviewError(
          "unavailable",
          "Owned review incentive claim is unavailable",
        );
      // This writer checks immutable participation, policy digest, privacy,
      // invalidation, module/account eligibility and exact ledger idempotency.
      return fulfillReviewPointsClaimInTransaction({
        tx,
        storeId,
        claimId: claim.id,
        generation,
      });
    },
    payload.installationGeneration,
    loyaltyMaintenancePermit,
  ).catch((error) => {
    if (error instanceof ShopifyStoreOperationalWritesBlockedError) {
      if (
        [
          "pending_approval",
          "suspended",
          "frozen",
          "currency_unverified",
        ].includes(error.complianceState ?? "")
      )
        throw new ReviewPointsRecoveryPendingError();
      throw new ReviewPointsRecoveryReconciliationError();
    }
    throw error;
  });
  // Throw outside the transaction: persist the truthful waiting reason, while
  // telling the queue not to complete an unfulfilled promise.
  if (result.status === "pending") throw new ReviewPointsRecoveryPendingError();
  return result;
}
