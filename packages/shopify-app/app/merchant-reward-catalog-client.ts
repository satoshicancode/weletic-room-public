import { verifyRewardCatalogAcknowledgement } from "../../../apps/web/lib/weletic/loyalty/reward-catalog-acknowledgement";
import {
  rewardCatalogRequestSchema,
  type RewardCatalogContain,
  type RewardCatalogWrite,
} from "../../../apps/web/lib/weletic/loyalty/reward-catalog-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";
export function createMerchantRewardCatalogClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  async function request(value: unknown) {
    const input = rewardCatalogRequestSchema.safeParse(value);
    if (!input.success) throw new StaffAccessClientError("invalid");
    const response = await post("/api/merchant/reward-catalog", input.data);
    try {
      return verifyRewardCatalogAcknowledgement(input.data, response);
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  }
  return {
    read: () => request({ operation: "read" }),
    save: (input: RewardCatalogWrite) => request({ operation: "save", input }),
    contain: (input: RewardCatalogContain) =>
      request({ operation: "contain", input }),
  };
}
