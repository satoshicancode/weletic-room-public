import {
  merchantAccountRowExportRequestSchema,
  verifyMerchantAccountRowExportResponse,
  type MerchantAccountRowExportRequest,
} from "../../../apps/web/lib/weletic/loyalty/account-row-export-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantAccountRowExportClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  return async (request: MerchantAccountRowExportRequest) => {
    const parsed = merchantAccountRowExportRequestSchema.safeParse(request);
    if (!parsed.success) throw new StaffAccessClientError("invalid");
    const data = await post(
      "/api/merchant/analytics/account-rows",
      parsed.data,
    );
    try {
      return verifyMerchantAccountRowExportResponse(parsed.data, data);
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}
