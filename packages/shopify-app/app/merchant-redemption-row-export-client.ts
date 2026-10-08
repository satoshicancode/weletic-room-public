import {
  merchantRedemptionRowExportRequestSchema,
  verifyMerchantRedemptionRowExportResponse,
  type MerchantRedemptionRowExportRequest,
} from "../../../apps/web/lib/weletic/loyalty/redemption-row-export-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantRedemptionRowExportClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  return async (request: MerchantRedemptionRowExportRequest) => {
    const parsed = merchantRedemptionRowExportRequestSchema.safeParse(request);
    if (!parsed.success) throw new StaffAccessClientError("invalid");
    const data = await post(
      "/api/merchant/analytics/redemption-rows",
      parsed.data,
    );
    try {
      return verifyMerchantRedemptionRowExportResponse(parsed.data, data);
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}
