import {
  storeReviewSettingsReadResponseSchema,
  storeReviewSettingsWriteInputSchema,
  type StoreReviewSettingsWriteInput,
} from "../../../apps/web/lib/weletic/reviews/store-settings-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantStoreReviewSettingsClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return {
    async read() {
      const result = storeReviewSettingsReadResponseSchema.safeParse(
        await post("/api/merchant/store-review-settings/read", {}),
      );
      if (!result.success) throw new StaffAccessClientError("unavailable");
      return result.data;
    },
    async write(input: StoreReviewSettingsWriteInput) {
      const patch = storeReviewSettingsWriteInputSchema.safeParse(input);
      if (!patch.success) throw new StaffAccessClientError("invalid");
      const result = storeReviewSettingsReadResponseSchema.safeParse(
        await post("/api/merchant/store-review-settings/write", patch.data),
      );
      if (
        !result.success ||
        result.data.revision !== patch.data.expectedRevision + 1 ||
        result.data.installationGeneration !==
          patch.data.expectedInstallationGeneration ||
        JSON.stringify(result.data.policy) !== JSON.stringify(patch.data.policy)
      )
        throw new StaffAccessClientError("unavailable");
      return result.data;
    },
  };
}
