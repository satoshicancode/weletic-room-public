import { createHash } from "node:crypto";
import { z } from "zod";
import { openReviewPolicySchema } from "./open-policy-contract";

export const OPEN_REVIEW_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
export {
  DEFAULT_OPEN_REVIEW_POLICY,
  openReviewPolicyReadSchema,
  openReviewPolicySchema,
  openReviewPolicyWriteSchema,
} from "./open-policy-contract";

export function openReviewPolicySnapshot(input: unknown) {
  const policy = openReviewPolicySchema.parse(input);
  // Explicit field ordering makes the immutable digest independent of JSON key
  // order. A disable remains an explicit revision, not deletion of history.
  const contentDigest = createHash("sha256")
    .update(
      JSON.stringify([
        "weletic-open-review-policy-v1",
        policy.enabled,
        policy.photoUploadsEnabled,
        policy.maxSubmissionsPer24Hours,
      ]),
    )
    .digest("hex");
  return { policy, contentDigest };
}

/** Query specification, not rate enforcement. The writer must hold the store
 * lock, check an owned replay first, then count and insert in the same transaction.
 * Count all accepted attempts, including subsequently hidden or erased content;
 * a moderation or privacy action must not reset the abuse budget.
 */
export function openReviewRateCountWhere(input: {
  storeId: string;
  shopperId: string;
  now: Date;
}) {
  const { storeId, shopperId, now } = z
    .object({
      storeId: z.string().min(1).max(191),
      shopperId: z.string().min(1).max(191),
      now: z.date(),
    })
    .strict()
    .parse(input);
  const cutoff = new Date(now.getTime() - OPEN_REVIEW_RATE_WINDOW_MS);
  if (!Number.isFinite(cutoff.getTime()))
    throw new Error("Invalid rate window");
  return {
    storeId,
    shopperId,
    // Include future timestamps conservatively if the clock moved backwards.
    createdAt: { gt: cutoff },
  };
}
