import {
  merchantTierHistoryExportRequestSchema,
  verifyMerchantTierHistoryExportResponse,
  type MerchantTierHistoryExportRequest,
} from "../../../apps/web/lib/weletic/loyalty/tier-history-export-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantTierHistoryExportClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  return async (request: MerchantTierHistoryExportRequest) => {
    const parsed = merchantTierHistoryExportRequestSchema.safeParse(request);
    if (!parsed.success) throw new StaffAccessClientError("invalid");
    const data = await post(
      "/api/merchant/analytics/tier-history",
      parsed.data,
    );
    try {
      return verifyMerchantTierHistoryExportResponse(parsed.data, data);
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}
