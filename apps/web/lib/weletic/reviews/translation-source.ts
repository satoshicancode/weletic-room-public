import { createHash } from "node:crypto";

/** Source version remains a separate audit field. Moderation/reply-only version
 * changes do not change this digest; source text is never copied into audit rows.
 * This is identity/freshness evidence, not a secret or an authorization token.
 */
export function reviewTranslationSourceDigest(input: {
  storeId: string;
  reviewId: string;
  title: string;
  body: string;
}) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "weletic-review-translation-source-v1",
        input.storeId,
        input.reviewId,
        input.title,
        input.body,
      ]),
    )
    .digest("hex");
}
