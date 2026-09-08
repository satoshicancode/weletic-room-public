import { shopifyMerchantOverviewResponseSchema } from "../../../apps/web/lib/weletic/shopify/staff-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createMerchantOverviewClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return async () => {
    const result = shopifyMerchantOverviewResponseSchema.safeParse(
      await post("/api/merchant/overview", {}),
    );
    if (!result.success) throw new StaffAccessClientError("unavailable");
    return result.data;
  };
}
