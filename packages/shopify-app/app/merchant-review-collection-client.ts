import {
  reviewCollectionReadResponseSchema,
  reviewCollectionWriteInputSchema,
  type ReviewCollectionWriteInput,
} from "../../../apps/web/lib/weletic/reviews/collection-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantReviewCollectionClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return {
    async read() {
      const result = reviewCollectionReadResponseSchema.safeParse(
        await post("/api/merchant/review-collection/read", {}),
      );
      if (!result.success) throw new StaffAccessClientError("unavailable");
      return result.data;
    },
    async write(input: ReviewCollectionWriteInput) {
      const parsed = reviewCollectionWriteInputSchema.safeParse(input);
      if (!parsed.success) throw new StaffAccessClientError("invalid");
      const result = reviewCollectionReadResponseSchema.safeParse(
        await post("/api/merchant/review-collection/write", parsed.data),
      );
      if (
        !result.success ||
        result.data.revision !== parsed.data.expectedRevision + 1 ||
        result.data.installationGeneration !==
          parsed.data.expectedInstallationGeneration ||
        JSON.stringify(result.data.policy) !==
          JSON.stringify(parsed.data.policy)
      )
        throw new StaffAccessClientError("unavailable");
      return result.data;
    },
  };
}
