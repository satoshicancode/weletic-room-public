import { createHash } from "node:crypto";

/** Content identity excludes rating and publication. Media IDs must be validated
 * uploads attached to this review, never caller-supplied eligibility evidence.
 */
export function reviewParticipationContentDigest(review: {
  id: string;
  requestId: string;
  body: string;
  title: string;
  mediaIds: string[];
}) {
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
