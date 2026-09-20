import { syncProductReviewSummary } from "@/lib/weletic/reviews/summary-sync";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fence: vi.fn(),
  product: vi.fn(),
  raw: vi.fn(),
  graphql: vi.fn(),
  lock: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyProduct: { findFirst: mocks.product },
    $transaction: (fn: (tx: unknown) => unknown) =>
      fn({ $queryRaw: mocks.raw }),
  },
}));
vi.mock("@/lib/weletic/shopify/privacy-identity", () => ({
  loadShopifyPrivacyHmacKeyring: () => {
    const key = { identityKeyId: "fixture", secret: Buffer.alloc(32, 1) };
    return { current: key, all: [key] };
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
  mocks.raw.mockReset();
  mocks.lock.mockImplementation(({ fn }: { fn: () => Promise<unknown> }) =>
    fn(),
  );
  mocks.fence.mockResolvedValue({
    complianceState: "active",
    storeAccessState: "active",
    installationGeneration: "g1",
  });
  mocks.product.mockResolvedValue({ externalId: "gid://shopify/Product/123" });
  mocks.raw
    .mockResolvedValueOnce([])
    .mockResolvedValue([{ rating: 3, count: BigInt(2) }]);
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
    expect(mocks.raw).toHaveBeenCalledTimes(2);
    expect(mocks.raw.mock.calls[1][0].sql).toContain(
      "WeleticReviewOwnerPrivacyIdentity",
    );
    expect(mocks.raw.mock.calls[1][0].sql).toContain("GROUP BY r.rating");
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
    mocks.raw.mockReset().mockResolvedValue([]);
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
  it("does not turn unknown privacy coverage into zero ratings", async () => {
    mocks.raw.mockReset().mockResolvedValue([{ id: "unknown-review" }]);
    await expect(
      syncProductReviewSummary("store-1", "product-1", "g1"),
    ).rejects.toThrow("privacy coverage unavailable");
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
  it("does not read or publish for an unapproved store", async () => {
    mocks.fence.mockResolvedValue({
      complianceState: "active",
      storeAccessState: "pending_approval",
      installationGeneration: "g1",
    });
    await syncProductReviewSummary("store-1", "product-1", "g1");
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
  it("does not fabricate an installation generation for legacy metadata", async () => {
    mocks.fence.mockResolvedValue({
      complianceState: "active",
      storeAccessState: "active",
      installationGeneration: null,
    });
    await expect(
      syncProductReviewSummary("store-1", "product-1", null),
    ).rejects.toThrow("generation unavailable");
    expect(mocks.raw).not.toHaveBeenCalled();
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
  it("rejects invalid aggregate values before publishing", async () => {
    mocks.raw
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ rating: 6, count: BigInt(1) }]);
    await expect(
      syncProductReviewSummary("store-1", "product-1", "g1"),
    ).rejects.toThrow("totals unavailable");
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
  it("does not publish after admission is suspended during credential resolution", async () => {
    mocks.fence
      .mockResolvedValueOnce({
        complianceState: "active",
        storeAccessState: "active",
        installationGeneration: "g1",
      })
      .mockResolvedValueOnce({
        complianceState: "active",
        storeAccessState: "active",
        installationGeneration: "g1",
      })
      .mockResolvedValueOnce({
        complianceState: "active",
        storeAccessState: "suspended",
        installationGeneration: "g1",
      });
    await syncProductReviewSummary("store-1", "product-1", "g1");
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
});
