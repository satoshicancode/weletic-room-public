import {
  manualReviewTranslationInputSchema,
  manualReviewTranslationReadInputSchema,
  manualReviewTranslationReadResponseSchema,
  manualReviewTranslationWriteResponseSchema,
  type ManualReviewTranslationInput,
} from "../../../apps/web/lib/weletic/reviews/translation-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

// Routes require the additive translation schema before deployment.
export function createMerchantReviewTranslationsClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  // A removed/redacted source is a definitive loss of content access, not an
  // ambiguous mutation result. Clear cached editor content for 404/410 too.
  const privacyAwareTransport: typeof fetch = async (...args) => {
    const response = await transport(...args);
    if (response.status === 404 || response.status === 410)
      throw new StaffAccessClientError("denied");
    return response;
  };
  const post = createMerchantJsonPost(getToken, privacyAwareTransport);
  return {
    async read(input: unknown) {
      const parsed = manualReviewTranslationReadInputSchema.safeParse(input);
      if (!parsed.success) throw new StaffAccessClientError("invalid");
      const response = manualReviewTranslationReadResponseSchema.safeParse(
        await post("/api/merchant/review-translations/read", parsed.data),
      );
      if (!response.success || response.data.reviewId !== parsed.data.reviewId)
        throw new StaffAccessClientError("unavailable");
      return response.data;
    },
    async save(input: ManualReviewTranslationInput) {
      const parsed = manualReviewTranslationInputSchema.safeParse(input);
      if (!parsed.success) throw new StaffAccessClientError("invalid");
      const response = manualReviewTranslationWriteResponseSchema.safeParse(
        await post("/api/merchant/review-translations/write", parsed.data),
      );
      if (
        !response.success ||
        response.data.reviewId !== parsed.data.reviewId ||
        response.data.locale !== parsed.data.locale ||
        response.data.revision !==
          parsed.data.expectedTranslationRevision + 1 ||
        response.data.status !==
          (parsed.data.action === "save" ? "active" : "removed")
      )
        throw new StaffAccessClientError("unavailable");
      return response.data;
    },
  };
}
