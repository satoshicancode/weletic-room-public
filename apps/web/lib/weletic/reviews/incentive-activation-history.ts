import type { Prisma } from "@prisma/client";
import { ReviewError } from "./contracts";
import {
  readReviewIncentivePolicySnapshot,
  reviewIncentivePolicyDigest,
} from "./incentive-policy";

/** Caller holds the store's review mutation fence. Resolve only new order
 * invitations; never rewrite an order already bound by any invitation.
 */
export async function reviewPolicyAtOrderTime(
  tx: Prisma.TransactionClient,
  storeId: string,
  orderTime: Date,
  currentPolicyId: string | null,
) {
  if (!Number.isFinite(orderTime.getTime()))
    throw new ReviewError("unavailable", "Review order time is unavailable");
  const newest = await tx.weleticReviewIncentiveActivation.findFirst({
    where: { storeId },
    orderBy: [{ effectiveAt: "desc" }, { policyRevision: "desc" }],
  });
  // Reader-before-writer compatibility: pre-cutover stores have no history.
  if (!newest) return currentPolicyId;
  if (newest.storeId !== storeId || newest.policyId !== currentPolicyId)
    throw new ReviewError(
      "unavailable",
      "Review activation history requires reconciliation",
    );
  const effective = await tx.weleticReviewIncentiveActivation.findFirst({
    where: { storeId, effectiveAt: { lte: orderTime } },
    orderBy: [{ effectiveAt: "desc" }, { policyRevision: "desc" }],
  });
  if (effective) {
    const snapshot = await readReviewIncentivePolicySnapshot(
      tx,
      storeId,
      effective.policyId,
    );
    if (
      effective.storeId !== storeId ||
      !snapshot ||
      reviewIncentivePolicyDigest(snapshot) !== effective.contentDigest
    )
      throw new ReviewError(
        "unavailable",
        "Review activation history requires reconciliation",
      );
    return effective.policyId;
  }
  const first = await tx.weleticReviewIncentiveActivation.findFirst({
    where: { storeId },
    orderBy: [{ effectiveAt: "asc" }, { policyRevision: "asc" }],
  });
  if (!first || first.storeId !== storeId)
    throw new ReviewError(
      "unavailable",
      "Review activation history requires reconciliation",
    );
  // Preserve the state that existed before the first recorded cutover, rather
  // than applying today's none/points/coupon policy to a historical order.
  await readReviewIncentivePolicySnapshot(tx, storeId, first.previousPolicyId);
  return first.previousPolicyId;
}
