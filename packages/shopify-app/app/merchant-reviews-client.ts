import {
  merchantReviewListInputSchema,
  merchantReviewListResponseSchema,
  type MerchantReviewListInput,
} from "../../../apps/web/lib/weletic/reviews/merchant-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantReviewsClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return async (input: MerchantReviewListInput) => {
    const query = merchantReviewListInputSchema.safeParse(input);
    if (!query.success) throw new StaffAccessClientError("invalid");
    const result = merchantReviewListResponseSchema.safeParse(
      await post("/api/merchant/reviews", query.data),
    );
    if (
      !result.success ||
      result.data.view !== query.data.view ||
      result.data.items.length > query.data.limit ||
      (result.data.nextCursor !== null &&
        result.data.nextCursor === query.data.cursor)
    )
      throw new StaffAccessClientError("unavailable");
    return result.data;
  };
}
