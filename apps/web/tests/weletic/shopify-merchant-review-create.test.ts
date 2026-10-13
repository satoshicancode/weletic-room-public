import { createShopifyMerchantReview } from "@/lib/weletic/shopify/merchant-review-create";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: (_storeId: string, operation: (tx: object) => unknown) =>
    operation({}),
}));
vi.mock("@/lib/weletic/shopify/staff-authorization", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/weletic/shopify/staff-authorization")
  >("@/lib/weletic/shopify/staff-authorization");
  return { ...actual, authorizeShopifyMerchantInTransaction: mocks.authorize };
});
vi.mock("@/lib/weletic/reviews/service", () => ({
  createMerchantReviewInTransaction: mocks.create,
}));

const input = {
  productId: "gid://shopify/Product/123",
  rating: 5,
  title: "Store demonstration",
  body: "A merchant-authored product demonstration review.",
  displayName: "Store owner",
  status: "published" as const,
};
const envelope = {
  version: 1 as const,
  appId: "app-1",
  shop: "example.myshopify.com",
  storeId: "store-1",
  installationGeneration: "generation-1",
  userId: "123",
  sessionId: "example.myshopify.com_123",
  sessionDigest: "a".repeat(64),
  authenticatedAt: Date.now(),
  requestId: "b".repeat(64),
};

describe("Shopify merchant review creation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authorize.mockResolvedValue({
      storeId: "store-1",
      shopifyUserId: "123",
      owner: true,
    });
    mocks.create.mockResolvedValue({ id: "wreview_1", status: "published" });
  });

  it("requires the exact moderation permission and binds the authorized owner", async () => {
    await expect(
      createShopifyMerchantReview({ envelope, input }),
    ).resolves.toEqual({
      id: "wreview_1",
      status: "published",
    });
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx: {},
      envelope,
      permission: "reviews.moderate",
    });
    expect(mocks.create).toHaveBeenCalledWith({
      tx: {},
      storeId: "store-1",
      userId: "123",
      input,
    });
  });

  it("does not permit delegated staff to author merchant reviews", async () => {
    mocks.authorize.mockResolvedValue({
      storeId: "store-1",
      shopifyUserId: "456",
      owner: false,
    });
    await expect(
      createShopifyMerchantReview({ envelope, input }),
    ).rejects.toMatchObject({ code: "access_denied" });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
