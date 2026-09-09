import {
  loyaltyCommunicationsRequestSchema,
  verifyLoyaltyCommunicationsResponse,
  type LoyaltyCommunicationsRequest,
} from "../../../apps/web/lib/weletic/loyalty/communications-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantCommunicationsClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  return async (request: LoyaltyCommunicationsRequest) => {
    const parsed = loyaltyCommunicationsRequestSchema.safeParse(request);
    if (!parsed.success) throw new StaffAccessClientError("invalid");
    const value = await post("/api/merchant/communications", parsed.data);
    try {
      return verifyLoyaltyCommunicationsResponse(parsed.data, value);
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}
