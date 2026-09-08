import { syncProductReviewSummary } from "@/lib/weletic/reviews/summary-sync";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fence: vi.fn(),
  product: vi.fn(),
  aggregate: vi.fn(),
  graphql: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyProduct: { findFirst: mocks.product },
    weleticProductReview: { aggregate: mocks.aggregate },
  },
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({ enqueueOutboxJob: vi.fn() }));
vi.mock("@/lib/weletic/loyalty/shopify-discounts", () => ({
  resolveShopifyOfflineCredentials: vi.fn().mockResolvedValue({
    shopDomain: "fixture.myshopify.com",
    accessToken: "fixture-only",
  }),
  shopifyAdminGraphqlRequest: mocks.graphql,
}));
vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreMatchesInstallationGeneration: mocks.fence,
}));
vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: mocks.lock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lock.mockImplementation(({ fn }: { fn: () => Promise<unknown> }) =>
    fn(),
  );
  mocks.fence.mockResolvedValue({ complianceState: "active" });
  mocks.product.mockResolvedValue({ externalId: "gid://shopify/Product/123" });
  mocks.aggregate.mockResolvedValue({
    _count: { rating: 2 },
    _sum: { rating: 6 },
  });
  mocks.graphql.mockResolvedValue({
    metafieldsSet: { userErrors: [] },
    metafieldsDelete: { userErrors: [] },
  });
});
describe("native review production Shopify summary projection", () => {
  it("reads current eligible rows and writes standard review fields", async () => {
    await syncProductReviewSummary("store-1", "product-1", "g1");
    expect(mocks.fence).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store-1",
        expectedInstallationGeneration: "g1",
      }),
    );
    expect(mocks.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: "store-1",
          productId: "product-1",
          status: "published",
          shopper: { privacyTombstones: { none: {} } },
          store: { reviewSettings: { enabled: true } },
        },
      }),
    );
    expect(mocks.graphql).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: {
          metafields: [
            {
              ownerId: "gid://shopify/Product/123",
              namespace: "reviews",
              key: "rating_count",
              type: "number_integer",
              value: "2",
            },
            {
              ownerId: "gid://shopify/Product/123",
              namespace: "reviews",
              key: "rating",
              type: "rating",
              value: JSON.stringify({
                value: "3.00",
                scale_min: "1.0",
                scale_max: "5.0",
              }),
            },
          ],
        },
      }),
    );
  });
  it("removes stale rating when no published eligible reviews remain", async () => {
    mocks.aggregate.mockResolvedValue({
      _count: { rating: 0 },
      _sum: { rating: null },
    });
    await syncProductReviewSummary("store-1", "product-1", "g1");
    expect(mocks.graphql).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: expect.objectContaining({
          delete: [
            {
              ownerId: "gid://shopify/Product/123",
              namespace: "reviews",
              key: "rating",
            },
          ],
          metafields: [
            expect.objectContaining({ key: "rating_count", value: "0" }),
          ],
        }),
      }),
    );
  });
  it.each([null, { userErrors: [{ message: "Invalid owner" }] }])(
    "retries missing or rejected mutation results",
    async (result) => {
      mocks.graphql.mockResolvedValue({ metafieldsSet: result });
      await expect(
        syncProductReviewSummary("store-1", "product-1", "g1"),
      ).rejects.toThrow("metafields update failed");
    },
  );
  it("does not publish for a frozen store", async () => {
    mocks.fence.mockResolvedValue({ complianceState: "redacting" });
    await syncProductReviewSummary("store-1", "product-1", "g1");
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
});
