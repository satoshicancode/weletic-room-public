import {
  auditedReviewModerationInputSchema,
  auditedReviewModerationResponseSchema,
  type AuditedReviewModerationInput,
} from "../../../apps/web/lib/weletic/reviews/moderation-contract";
import {
  storeMerchantListInputSchema,
  storeMerchantListResponseSchema,
  type StoreMerchantListInput,
} from "../../../apps/web/lib/weletic/reviews/store-merchant-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantStoreReviewsClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return {
    async list(input: StoreMerchantListInput) {
      const query = storeMerchantListInputSchema.safeParse(input);
      if (!query.success) throw new StaffAccessClientError("invalid");
      const result = storeMerchantListResponseSchema.safeParse(
        await post("/api/merchant/store-reviews", query.data),
      );
      if (
        !result.success ||
        result.data.items.length > query.data.limit ||
        (result.data.nextCursor !== null &&
          result.data.nextCursor === query.data.cursor)
      )
        throw new StaffAccessClientError("unavailable");
      return result.data;
    },
    async moderate(input: AuditedReviewModerationInput) {
      const patch = auditedReviewModerationInputSchema.safeParse(input);
      if (!patch.success) throw new StaffAccessClientError("invalid");
      const result = auditedReviewModerationResponseSchema.safeParse(
        await post("/api/merchant/store-review-moderation", patch.data),
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
    },
  };
}
