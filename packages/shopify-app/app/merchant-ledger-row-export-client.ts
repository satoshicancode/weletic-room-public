import {
  merchantLedgerRowExportRequestSchema,
  verifyMerchantLedgerRowExportResponse,
  type MerchantLedgerRowExportRequest,
} from "../../../apps/web/lib/weletic/loyalty/ledger-row-export-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantLedgerRowExportClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  return async (request: MerchantLedgerRowExportRequest) => {
    const parsed = merchantLedgerRowExportRequestSchema.safeParse(request);
    if (!parsed.success) throw new StaffAccessClientError("invalid");
    const data = await post("/api/merchant/analytics/ledger-rows", parsed.data);
    try {
      return verifyMerchantLedgerRowExportResponse(parsed.data, data);
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}
