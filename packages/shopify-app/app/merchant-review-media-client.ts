import {
  merchantReviewMediaInputSchema,
  merchantReviewMediaResponseSchema,
} from "@weletic/contracts/reviews/merchant-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantReviewMediaClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return async (mediaId: string) => {
    const input = merchantReviewMediaInputSchema.safeParse({ mediaId });
    if (!input.success) throw new StaffAccessClientError("invalid");
    const result = merchantReviewMediaResponseSchema.safeParse(
      await post("/api/merchant/review-media", input.data),
    );
    if (!result.success) throw new StaffAccessClientError("unavailable");
    return result.data;
  };
}
