import { createHash } from "node:crypto";

/** Content identity excludes rating and publication. Media IDs must be validated
 * uploads attached to this review, never caller-supplied eligibility evidence.
 */
export function reviewParticipationContentDigest(review: {
  id: string;
  requestId: string | null;
  body: string;
  title: string;
  mediaIds: string[];
}) {
  if (!review.requestId)
    throw new Error("Invitation evidence is required for review incentives");
  return createHash("sha256")
    .update(
      JSON.stringify([
        review.id,
        review.requestId,
        review.body,
        review.title,
        [...review.mediaIds].sort(),
      ]),
    )
    .digest("hex");
}

/** Separate domain/version preserves all historical product evidence bytes.
 * Store feedback currently accepts text only; it cannot claim media bonuses.
 */
export function storeReviewParticipationContentDigest(review: {
  id: string;
  requestId: string | null;
  body: string;
  title: string;
}) {
  if (!review.requestId)
    throw new Error(
      "Invitation evidence is required for store review incentives",
    );
  return createHash("sha256")
    .update(
      JSON.stringify([
        "store_review_participation_v1",
        review.id,
        review.requestId,
        review.body,
        review.title,
      ]),
    )
    .digest("hex");
}
