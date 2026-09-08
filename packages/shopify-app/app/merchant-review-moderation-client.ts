import {
  auditedReviewModerationInputSchema,
  auditedReviewModerationResponseSchema,
  type AuditedReviewModerationInput,
} from "../../../apps/web/lib/weletic/reviews/moderation-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantReviewModerationClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return async (input: AuditedReviewModerationInput) => {
    const patch = auditedReviewModerationInputSchema.safeParse(input);
    if (!patch.success) throw new StaffAccessClientError("invalid");
    const result = auditedReviewModerationResponseSchema.safeParse(
      await post("/api/merchant/review-moderation", patch.data),
    );
    if (
      !result.success ||
      result.data.reviewId !== patch.data.reviewId ||
      result.data.version !== patch.data.version + 1 ||
      (patch.data.status !== undefined &&
        result.data.status !== patch.data.status)
    )
      throw new StaffAccessClientError("unavailable");
    return result.data;
  };
}
