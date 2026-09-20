import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GET } from "../../app/api/internal/shopify/reviews/[action]/route";
import { signWeleticShopifyRequest } from "../../lib/weletic/shopify/service-auth";
const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  resolve: vi.fn(),
  store: vi.fn(),
}));
vi.mock("../../lib/prisma", () => ({
  prisma: { weleticShopifyStore: { findFirst: mocks.store } },
}));
vi.mock("../../lib/upstash", () => ({ ratelimit: vi.fn() }));
vi.mock("../../lib/weletic/reviews/media", () => ({
  getPublicReviewPhoto: vi.fn(),
  uploadReviewPhoto: vi.fn(),
}));
vi.mock("../../lib/weletic/reviews/requests", () => ({
  getReviewRequestPreview: vi.fn(),
}));
vi.mock("../../lib/weletic/reviews/service", () => ({
  submitNativeReview: vi.fn(),
}));
vi.mock("../../lib/weletic/reviews/public", () => ({
  getPublicProductReviews: mocks.list,
}));
vi.mock("../../lib/weletic/shopify/store-resolver", () => ({
  resolveShopifyStoreByDomain: mocks.resolve,
}));
const secret = "public-locale-route-synthetic-secret-000000";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
  mocks.resolve.mockResolvedValue({ storeId: "verified-store" });
  mocks.store.mockResolvedValue({ id: "verified-store" });
  mocks.list.mockResolvedValue({ items: [] });
});
afterEach(() => vi.unstubAllEnvs());
it.each(["en", "ja", "vi"])(
  "keeps %s in the authenticated internal list allowlist",
  async (locale) => {
    const path =
      "/api/internal/shopify/reviews/list?shop=verified.myshopify.com&productId=123&locale=" +
      locale +
      "&storeId=attacker";
    const timestamp = String(Date.now());
    const request = new Request("https://backend.example" + path, {
      headers: {
        "x-weletic-timestamp": timestamp,
        "x-weletic-signature": signWeleticShopifyRequest({
          timestamp,
          method: "GET",
          path,
          body: "",
          secret,
        }),
      },
    });
    const response = await GET(request, {
      params: Promise.resolve({ action: "list" }),
    });
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith("verified-store", {
      productId: "123",
      locale,
    });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  },
);
