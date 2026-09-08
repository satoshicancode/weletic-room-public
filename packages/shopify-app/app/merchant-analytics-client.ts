import {
  merchantAnalyticsRequestSchema,
  verifyMerchantAnalyticsResponse,
  type MerchantAnalyticsRequest,
} from "../../../apps/web/lib/weletic/loyalty/merchant-analytics-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantAnalyticsClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  return async (request: MerchantAnalyticsRequest) => {
    const parsed = merchantAnalyticsRequestSchema.safeParse(request);
    if (!parsed.success) throw new StaffAccessClientError("invalid");
    const data = await post("/api/merchant/analytics", parsed.data);
    try {
      return verifyMerchantAnalyticsResponse(parsed.data, data);
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}
