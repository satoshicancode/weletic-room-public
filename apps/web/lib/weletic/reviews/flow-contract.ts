import { z } from "zod";

export const REVIEW_FLOW_HANDLES = {
  SUBMITTED: "weletic-review-submitted",
  PUBLISHED: "weletic-review-published",
} as const;

// Persist owned identifiers and event-time facts, not email, content, invitation
// tokens or loyalty membership. The worker must resolve current owned identity
// and privacy/module eligibility before exposing a Shopify customer reference.
const fields = {
  reviewId: z.string().regex(/^wreview_[A-Za-z0-9_-]{20}$/),
  version: z.number().int().positive().max(2_147_483_647),
  installationGeneration: z.string().min(1).max(64),
  occurredAt: z.string().datetime({ offset: true }),
  rating: z.number().int().min(1).max(5),
  verifiedPurchase: z.boolean(),
};

export const ReviewSubmittedFlowJobSchema = z
  .object({ ...fields, handle: z.literal(REVIEW_FLOW_HANDLES.SUBMITTED) })
  .strict();
export const ReviewPublishedFlowJobSchema = z
  .object({ ...fields, handle: z.literal(REVIEW_FLOW_HANDLES.PUBLISHED) })
  .strict();
export const ReviewFlowJobSchema = z.discriminatedUnion("handle", [
  ReviewSubmittedFlowJobSchema,
  ReviewPublishedFlowJobSchema,
]);
export type ReviewFlowJob = z.infer<typeof ReviewFlowJobSchema>;

/** Store-scoped outbox uniqueness is supplied by the existing queue. This event
 * identity is also exposed to workflows: remote timeout retries are at-least-once,
 * not a claim that Shopify deduplicates requests or financial actions for us.
 */
export function reviewFlowEventId(input: ReviewFlowJob): string {
  const event = ReviewFlowJobSchema.parse(input);
  return `${event.reviewId}:${event.handle}:${event.version}`;
}

/** Only an actual transition into publication creates a publication event.
 * Reply-only edits do not. Hiding then republishing is a new versioned event,
 * never permission to issue a second built-in participation incentive.
 */
export function isReviewPublicationTransition(previous: string, next: string) {
  return previous !== "published" && next === "published";
}
