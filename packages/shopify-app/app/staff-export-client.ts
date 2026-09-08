import { shopifyStaffExportInputSchema } from "../../../apps/web/lib/weletic/shopify/staff-contract";
import {
  shopifyStaffExportResponseSchema,
  type ShopifyStaffExportPage,
} from "../../../apps/web/lib/weletic/shopify/staff-export-contract";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

export function createStaffExportClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return async (input: unknown, previous?: ShopifyStaffExportPage) => {
    const parsed = shopifyStaffExportInputSchema.safeParse(input);
    if (
      !parsed.success ||
      (parsed.data.cursor &&
        (!previous ||
          previous.nextCursor !== parsed.data.cursor ||
          previous.kind !== parsed.data.kind))
    )
      throw new StaffAccessClientError("invalid");
    const result = shopifyStaffExportResponseSchema.safeParse(
      await post("/api/merchant/staff-export", parsed.data),
    );
    if (
      !result.success ||
      result.data.kind !== parsed.data.kind ||
      result.data.rows.length > parsed.data.limit ||
      (result.data.nextCursor !== null &&
        result.data.nextCursor === parsed.data.cursor) ||
      (parsed.data.cursor &&
        previous &&
        (result.data.createdBefore !== previous.createdBefore ||
          result.data.currentInstallationGeneration !==
            previous.currentInstallationGeneration))
    )
      throw new StaffAccessClientError("unavailable");
    return result.data;
  };
}
