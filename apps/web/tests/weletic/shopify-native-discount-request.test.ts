import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shopifyDiscountProvider } from "../../lib/discounts/discount-provider-shopify";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), sdk: vi.fn() }));
vi.mock("../../../../packages/shopify-app/app/shopify.server", () => ({
  unauthenticated: { admin: mocks.sdk },
}));
vi.mock("@/lib/weletic/shopify/credential-source", () => ({
  readShopifyCredentialSource: vi.fn(async () => ({
    source: "native",
    accessToken: "synthetic-token",
    scope: "write_discounts",
    installationGeneration: "generation",
  })),
}));
const store = {
  id: "store",
  projectId: "workspace",
  shopDomain: "company.myshopify.com",
  installationGeneration: "generation",
  complianceState: "active",
  storeAccessState: "active",
};
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: vi.fn(async () => store) },
    $transaction: async (callback: (tx: object) => unknown) =>
      callback({ $queryRaw: vi.fn(async () => [store]) }),
  },
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());
describe("native provider direct request boundary", () => {
  it.each(["unauthorized", "timeout"])(
    "never retries %s via SDK after a native create request",
    async (failure) => {
      if (failure === "unauthorized")
        mocks.fetch.mockResolvedValue(new Response(null, { status: 401 }));
      else
        mocks.fetch.mockRejectedValue(
          new DOMException("Synthetic timeout", "TimeoutError"),
        );
      await expect(
        shopifyDiscountProvider.createDiscountCode({
          workspace: { id: "workspace", shopifyStoreId: null },
          discount: {
            id: "synthetic-discount",
            amount: 20,
            type: "percentage",
            maxDuration: null,
          },
          code: "NATIVE20",
        }),
      ).rejects.toMatchObject({
        providerCode:
          failure === "unauthorized" ? "AUTH_EXPIRED" : "CREATE_FAILED",
      });
      expect(mocks.fetch).toHaveBeenCalledOnce();
      expect(mocks.sdk).not.toHaveBeenCalled();
    },
  );
});
