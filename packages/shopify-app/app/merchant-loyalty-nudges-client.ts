import {
  loyaltyNudgeRequestSchema,
  verifyLoyaltyNudgeResponse,
  type LoyaltyNudgeRequest,
} from "../../../apps/web/lib/weletic/loyalty/nudge-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantLoyaltyNudgeClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  return async (request: LoyaltyNudgeRequest) => {
    const parsed = loyaltyNudgeRequestSchema.safeParse(request);
    if (!parsed.success) throw new StaffAccessClientError("invalid");
    const value = await post("/api/merchant/loyalty-nudges", parsed.data);
    try {
      return verifyLoyaltyNudgeResponse(parsed.data, value);
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}
