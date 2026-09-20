import {
  openReviewPolicyReadResponseSchema,
  openReviewPolicyWriteResponseSchema,
  openReviewPolicyWriteSchema,
} from "../../../apps/web/lib/weletic/reviews/open-policy-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantOpenReviewPolicyClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return {
    async read() {
      const response = openReviewPolicyReadResponseSchema.safeParse(
        await post("/api/merchant/open-review-policy/read", {}),
      );
      if (!response.success) throw new StaffAccessClientError("unavailable");
      return response.data;
    },
    async save(input: unknown) {
      const parsed = openReviewPolicyWriteSchema.safeParse(input);
      if (!parsed.success) throw new StaffAccessClientError("invalid");
      const response = openReviewPolicyWriteResponseSchema.safeParse(
        await post("/api/merchant/open-review-policy/write", parsed.data),
      );
      if (
        !response.success ||
        response.data.revision !== parsed.data.expectedRevision + 1 ||
        response.data.policy.enabled !== parsed.data.policy.enabled ||
        response.data.policy.photoUploadsEnabled !==
          parsed.data.policy.photoUploadsEnabled ||
        response.data.policy.maxSubmissionsPer24Hours !==
          parsed.data.policy.maxSubmissionsPer24Hours
      )
        throw new StaffAccessClientError("unavailable");
      return response.data;
    },
  };
}
