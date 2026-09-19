import {
  merchantReviewCouponListInputSchema,
  merchantReviewCouponListResponseSchema,
  merchantReviewIncentiveActivationInputSchema,
  merchantReviewIncentiveActivationResponseSchema,
  merchantReviewIncentiveDraftInputSchema,
  merchantReviewIncentiveDraftResponseSchema,
  merchantReviewIncentiveReadResponseSchema,
  type MerchantReviewCouponListInput,
  type MerchantReviewIncentiveActivationInput,
  type MerchantReviewIncentiveDraftInput,
} from "../../../apps/web/lib/weletic/reviews/incentive-merchant-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantReviewIncentivesClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return {
    async activate(input: MerchantReviewIncentiveActivationInput) {
      const parsed =
        merchantReviewIncentiveActivationInputSchema.safeParse(input);
      if (!parsed.success) throw new StaffAccessClientError("invalid");
      const response =
        merchantReviewIncentiveActivationResponseSchema.safeParse(
          await post("/api/merchant/review-incentives/activate", parsed.data),
        );
      if (
        !response.success ||
        response.data.policyId !== parsed.data.policyId ||
        response.data.revision !== parsed.data.expectedRevision
      )
        throw new StaffAccessClientError("unavailable");
      return response.data;
    },
    async coupons(input: MerchantReviewCouponListInput = {}) {
      const query = merchantReviewCouponListInputSchema.safeParse(input);
      if (!query.success) throw new StaffAccessClientError("invalid");
      const result = merchantReviewCouponListResponseSchema.safeParse(
        await post("/api/merchant/review-incentives/coupons", query.data),
      );
      if (
        !result.success ||
        (result.data.nextCursor !== null &&
          result.data.nextCursor === query.data.cursor) ||
        new Set(result.data.items.map((item) => item.id)).size !==
          result.data.items.length
      )
        throw new StaffAccessClientError("unavailable");
      return result.data;
    },
    async read() {
      const response = merchantReviewIncentiveReadResponseSchema.safeParse(
        await post("/api/merchant/review-incentives/read", {}),
      );
      if (!response.success) throw new StaffAccessClientError("unavailable");
      return response.data;
    },
    async draft(input: MerchantReviewIncentiveDraftInput) {
      const parsed = merchantReviewIncentiveDraftInputSchema.safeParse(input);
      if (!parsed.success) throw new StaffAccessClientError("invalid");
      const response = merchantReviewIncentiveDraftResponseSchema.safeParse(
        await post("/api/merchant/review-incentives/draft", parsed.data),
      );
      if (
        !response.success ||
        response.data.revision !== parsed.data.expectedRevision + 1
      )
        throw new StaffAccessClientError("unavailable");
      return response.data;
    },
  };
}
