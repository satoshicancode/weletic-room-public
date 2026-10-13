import {
  merchantReviewCreateInputSchema,
  merchantReviewCreateResponseSchema,
  type MerchantReviewCreateInput,
} from "@weletic/contracts/reviews/merchant-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantReviewCreateClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return async (input: MerchantReviewCreateInput) => {
    const parsed = merchantReviewCreateInputSchema.safeParse(input);
    if (!parsed.success) throw new StaffAccessClientError("invalid");
    const result = merchantReviewCreateResponseSchema.safeParse(
      await post("/api/merchant/review-create", parsed.data),
    );
    if (!result.success) throw new StaffAccessClientError("unavailable");
    return result.data;
  };
}
