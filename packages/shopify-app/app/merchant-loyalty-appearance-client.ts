import {
  loyaltyAppearanceRequestSchema,
  verifyLoyaltyAppearanceResponse,
  type LoyaltyAppearanceRequest,
} from "../../../apps/web/lib/weletic/loyalty/appearance-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantLoyaltyAppearanceClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  return async (request: LoyaltyAppearanceRequest) => {
    const parsed = loyaltyAppearanceRequestSchema.safeParse(request);
    if (!parsed.success) throw new StaffAccessClientError("invalid");
    const value = await post("/api/merchant/loyalty-appearance", parsed.data);
    try {
      return verifyLoyaltyAppearanceResponse(parsed.data, value);
    } catch {
      throw new StaffAccessClientError("unavailable");
    }
  };
}
