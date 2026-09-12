import {
  listShopifyStaffGrantsSchema,
  replaceShopifyStaffGrantSchema,
  shopifyStaffGrantListResponseSchema,
  shopifyStaffGrantSaveResponseSchema,
} from "../../../apps/web/lib/weletic/shopify/staff-contract";

export class StaffAccessClientError extends Error {
  constructor(
    readonly code:
      | "denied"
      | "reauthenticate"
      | "reload"
      | "unavailable"
      | "invalid",
  ) {
    super(code);
    this.name = "StaffAccessClientError";
  }
}

/** No browser storage of tokens/grants, no inferred user/shop, and no automatic
 * mutation retry. An ambiguous save requires a fresh list/revision first.
 */
export function createMerchantJsonPost(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
  { timeoutMs = 30_000 }: { timeoutMs?: number } = {},
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new StaffAccessClientError("invalid");
  async function post(path: string, input: unknown): Promise<unknown> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new StaffAccessClientError("unavailable"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        deadline,
        (async () => {
          const token = await getToken();
          controller.signal.throwIfAborted();
          const response = await transport(path, {
            method: "POST",
            cache: "no-store",
            credentials: "omit",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(input),
            signal: controller.signal,
          });
          if (!response.ok)
            throw new StaffAccessClientError(
              response.status === 401
                ? "reauthenticate"
                : response.status === 403
                  ? "denied"
                  : response.status === 409
                    ? "reload"
                    : response.status === 400
                      ? "invalid"
                      : "unavailable",
            );
          return response.json();
        })(),
      ]);
    } catch (error) {
      if (error instanceof StaffAccessClientError) throw error;
      throw new StaffAccessClientError("unavailable");
    } finally {
      clearTimeout(timer);
    }
  }
  return post;
}

export function createStaffAccessClient(
  getToken: () => Promise<string>,
  transport: typeof fetch = fetch,
) {
  const post = createMerchantJsonPost(getToken, transport);
  return {
    async list(input: unknown = {}) {
      const data = listShopifyStaffGrantsSchema.safeParse(input);
      if (!data.success) throw new StaffAccessClientError("invalid");
      const result = shopifyStaffGrantListResponseSchema.safeParse(
        await post("/api/merchant/staff-grant-list", data.data),
      );
      if (!result.success) throw new StaffAccessClientError("unavailable");
      return result.data;
    },
    async save(input: unknown) {
      const data = replaceShopifyStaffGrantSchema.safeParse(input);
      if (!data.success) throw new StaffAccessClientError("invalid");
      const result = shopifyStaffGrantSaveResponseSchema.safeParse(
        await post("/api/merchant/staff-grants", data.data),
      );
      if (
        !result.success ||
        result.data.grant.userId !== data.data.userId ||
        JSON.stringify(result.data.grant.permissions) !==
          JSON.stringify(data.data.permissions) ||
        result.data.grant.revision !==
          Math.min(2_147_483_647, data.data.expectedRevision + 1)
      )
        throw new StaffAccessClientError("unavailable");
      return result.data.grant;
    },
  };
}
