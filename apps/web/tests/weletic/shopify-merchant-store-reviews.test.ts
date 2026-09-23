import { listShopifyMerchantStoreReviewsInTransaction } from "@/lib/weletic/shopify/merchant-store-reviews";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: mocks.authorize,
}));
vi.mock("@/lib/weletic/reviews/privacy-public-sql", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    buildStoreReviewMerchantPrivacySql: vi.fn(() => ({
      from: Prisma.sql`WeleticStoreReview r`,
      unknown: Prisma.sql`1 = 0`,
      eligible: Prisma.sql`1 = 1`,
    })),
  };
});

const tx = {
  weleticReviewSettings: { findUnique: vi.fn(async () => ({ enabled: true })) },
  weleticStoreReviewSettings: {
    findUnique: vi.fn(async () => ({ enabled: true })),
  },
  $queryRaw: mocks.query,
} as unknown as Parameters<
  typeof listShopifyMerchantStoreReviewsInTransaction
>[0]["tx"];
const identity = {
  storeId: "store-a",
  appId: "app-a",
  installationGeneration: "generation-a",
};
const row = {
  id: "review-a",
  version: 1,
  status: "pending",
  rating: 4,
  title: "Experience",
  body: "Helpful staff",
  displayName: "Buyer",
  merchantReply: null,
  source: "invitation",
  requestId: "private-request",
  verifiedPurchase: 1,
  incentivized: 0,
  createdAt: new Date("2026-09-23T00:00:00.000Z"),
  shopperId: "private-shopper",
  orderId: "private-order",
};
const list = (input: unknown) =>
  listShopifyMerchantStoreReviewsInTransaction({ tx, envelope: {}, input });

describe("merchant store review inbox", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authorize.mockResolvedValue(identity);
    mocks.query.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
  });

  it("authorizes before reading, projects no private identity, and scopes pagination", async () => {
    mocks.query
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row, { ...row, id: "review-b" }]);
    const page = await list({ limit: 1, status: "pending" });
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope: {},
      permission: "reviews.read",
    });
    expect(page.items[0]).toMatchObject({
      id: "review-a",
      canModerate: true,
      verifiedPurchase: true,
    });
    expect(JSON.stringify(page)).not.toMatch(
      /private-request|private-shopper|private-order/,
    );
    expect(page.nextCursor).toBeTruthy();
    mocks.authorize.mockResolvedValue({
      ...identity,
      installationGeneration: "generation-b",
    });
    await expect(
      list({ limit: 1, status: "pending", cursor: page.nextCursor }),
    ).rejects.toThrow("Invalid store review cursor");
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });

  it("fails closed when owner coverage is unknown", async () => {
    mocks.query.mockReset().mockResolvedValueOnce([{ id: "unknown" }]);
    await expect(list({})).rejects.toThrow("Store reviews unavailable");
    expect(mocks.query).toHaveBeenCalledTimes(1);
  });

  it("does not query records after staff denial", async () => {
    mocks.authorize.mockRejectedValue(new Error("denied"));
    await expect(list({})).rejects.toThrow("denied");
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
