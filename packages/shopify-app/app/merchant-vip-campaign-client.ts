import { verifyVipCampaignAcknowledgement } from "../../../apps/web/lib/weletic/loyalty/vip-campaign-acknowledgement";
import {
  vipCampaignRequestSchema,
  type VipCampaignRequest,
} from "../../../apps/web/lib/weletic/loyalty/vip-campaign-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantVipCampaignClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  async function request(value: VipCampaignRequest) {
    const input = vipCampaignRequestSchema.safeParse(value);
    if (!input.success) throw new StaffAccessClientError("invalid");
    const response = await post("/api/merchant/vip-campaigns", input.data);
    try {
      return verifyVipCampaignAcknowledgement(input.data, response);
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  }
  return {
    read: () => request({ operation: "read" }),
    mutate: (input: Exclude<VipCampaignRequest, { operation: "read" }>) =>
      request(input),
  };
}
