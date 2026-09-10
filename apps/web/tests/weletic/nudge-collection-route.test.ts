import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET } from "../../app/api/internal/shopify/loyalty/customer/nudge-collections/route";
import { signWeleticShopifyRequest } from "../../lib/weletic/shopify/service-auth";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  resolve: vi.fn(),
  limit: vi.fn(),
}));
vi.mock("../../lib/upstash", () => ({
  ratelimit: () => ({ limit: mocks.limit }),
}));
vi.mock("../../lib/weletic/shopify/privacy-identity", () => ({
  createShopifyDerivedPrivacyDigest: () => "opaque-test-digest",
}));
vi.mock("../../lib/weletic/loyalty/nudge-collection-reader", () => ({
  readCustomerNudgeCollectionMembership: mocks.read,
}));
vi.mock("../../lib/prisma", () => ({
  prisma: { weleticShopifyStore: { findMany: mocks.resolve } },
}));
const secret = "synthetic-membership-service-secret-only";
function request(
  query = "shop=fixture.myshopify.com&customerId=123&productIds=1,2",
  signed = true,
) {
  const url = new URL(
    `https://backend.example/api/internal/shopify/loyalty/customer/nudge-collections?${query}`,
  );
  const timestamp = String(Date.now());
  return new Request(url, {
    headers: signed
      ? {
          "x-weletic-timestamp": timestamp,
          "x-weletic-signature": signWeleticShopifyRequest({
            timestamp,
            method: "GET",
            path: url.pathname + url.search,
            body: "",
            secret,
          }),
        }
      : {},
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
  mocks.resolve.mockResolvedValue([{ id: "canonical-store" }]);
  mocks.limit.mockResolvedValue({ success: true });
  mocks.read.mockResolvedValue({ "gid://shopify/Product/1": [] });
});
afterEach(() => vi.unstubAllEnvs());
it("forwards only resolved identity and bounded product GIDs", async () => {
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.read).toHaveBeenCalledExactlyOnceWith({
    storeId: "canonical-store",
    shopifyCustomerId: "123",
    productIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
  });
});
it("rejects unsigned requests before resolving a store", async () => {
  expect((await GET(request(undefined, false))).status).toBe(401);
  expect(mocks.resolve).not.toHaveBeenCalled();
});
it.each([
  "customerId=0&productIds=1",
  "customerId=123&productIds=",
  "customerId=123&productIds=1&productIds=2",
  "customerId=123&productIds=1&collectionIds=2",
  "customerId=123&productIds=" + Array(51).fill("1").join(","),
])("rejects invalid query %s", async (query) => {
  expect(
    (await GET(request("shop=fixture.myshopify.com&" + query))).status,
  ).toBe(400);
  expect(mocks.read).not.toHaveBeenCalled();
});
it("preserves unavailable membership as unknown", async () => {
  mocks.read.mockResolvedValue(null);
  expect(await (await GET(request())).json()).toEqual({
    data: { membership: null },
  });
});
it.each([{ success: false }, { success: true, reason: "timeout" }])(
  "fails closed on rate-limit denial or timeout",
  async (result) => {
    mocks.limit.mockResolvedValue(result);
    expect((await GET(request())).status).toBe(result.reason ? 503 : 429);
    expect(mocks.read).not.toHaveBeenCalled();
  },
);
it("rejects ambiguous stored aliases", async () => {
  mocks.resolve.mockResolvedValue([{ id: "one" }, { id: "two" }]);
  expect((await GET(request())).status).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled();
});
it("sanitizes unexpected failures", async () => {
  mocks.resolve.mockRejectedValue(new Error("private details"));
  const response = await GET(request());
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private details");
});
