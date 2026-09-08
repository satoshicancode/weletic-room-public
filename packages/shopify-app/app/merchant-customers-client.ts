import {
  merchantShopperListInputSchema,
  merchantShopperProfileInputSchema,
  type MerchantShopperListInput,
  type MerchantShopperProfileInput,
} from "../../../apps/web/lib/weletic/shoppers/merchant-contract";
import {
  merchantShopperDirectoryResponseSchema,
  merchantShopperProfileResponseSchema,
} from "../../../apps/web/lib/weletic/shoppers/merchant-response";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

function validPage(
  page: {
    items: { id: string }[];
    pagination: { limit: number; nextCursor: string | null };
  },
  query: { limit: number; cursor?: string },
) {
  return (
    page.pagination.limit === query.limit &&
    page.items.length <= query.limit &&
    new Set(page.items.map((row) => row.id)).size === page.items.length &&
    (!page.pagination.nextCursor || page.pagination.nextCursor !== query.cursor)
  );
}

export function createMerchantCustomersClient(
  getToken: () => Promise<string>,
  fetcher: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, fetcher);
  return {
    async list(input: MerchantShopperListInput) {
      const query = merchantShopperListInputSchema.safeParse({
        ...input,
        cursor: input.cursor || undefined,
      });
      if (!query.success) throw new StaffAccessClientError("invalid");
      const result = merchantShopperDirectoryResponseSchema.safeParse(
        await post("/api/merchant/customers", query.data),
      );
      if (!result.success || !validPage(result.data, query.data))
        throw new StaffAccessClientError("unavailable");
      return result.data;
    },
    async profile(input: MerchantShopperProfileInput) {
      const query = merchantShopperProfileInputSchema.safeParse({
        ...input,
        cursor: input.cursor || undefined,
      });
      if (!query.success) throw new StaffAccessClientError("invalid");
      const result = merchantShopperProfileResponseSchema.safeParse(
        await post("/api/merchant/customers/profile", query.data),
      );
      if (!result.success || result.data.section !== query.data.section)
        throw new StaffAccessClientError("unavailable");
      if (
        result.data.section === "overview"
          ? result.data.shopper.id !== query.data.shopperId
          : !validPage(result.data, query.data)
      )
        throw new StaffAccessClientError("unavailable");
      return result.data;
    },
  };
}
