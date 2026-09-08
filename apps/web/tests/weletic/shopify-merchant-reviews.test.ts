import { merchantReviewListInputSchema } from "@/lib/weletic/reviews/merchant-contract";
import { listShopifyMerchantReviewsInTransaction } from "@/lib/weletic/shopify/merchant-reviews";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMerchantReviewsClient } from "../../../../packages/shopify-app/app/merchant-reviews-client";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  reviews: vi.fn(),
  requests: vi.fn(),
  claims: vi.fn(),
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/weletic/shopify/staff-authorization", () => ({
  authorizeShopifyMerchantInTransaction: mocks.authorize,
}));
const tx = {
  weleticProductReview: { findMany: mocks.reviews },
  weleticReviewRequest: { findMany: mocks.requests },
  weleticReviewIncentiveClaim: { findMany: mocks.claims },
} as unknown as Parameters<
  typeof listShopifyMerchantReviewsInTransaction
>[0]["tx"];
const now = new Date("2026-09-07T00:00:00.000Z");
const row = {
  id: "review-2",
  version: 1,
  createdAt: now,
  status: "hidden",
  rating: 1,
  title: "Honest criticism",
  body: "A genuine low-rating review",
  displayName: "Buyer",
  merchantReply: null,
  verifiedPurchase: true,
  incentivized: true,
  rewardStatus: "awarded",
  rewardReason: "private internal reason",
  shopperId: "private-shopper",
  request: { orderId: "private-order", incentivePolicyId: null },
  product: { title: "Product", externalId: "product-1" },
  media: [{ id: "private-media-id" }],
};
const identity = {
  storeId: "store-a",
  appId: "app-a",
  installationGeneration: "generation-a",
};
const read = (input: unknown) =>
  listShopifyMerchantReviewsInTransaction({ tx, envelope: {}, input });

describe("merchant review inbox production projection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.authorize.mockResolvedValue(identity);
    mocks.reviews.mockResolvedValue([row]);
    mocks.requests.mockResolvedValue([]);
    mocks.claims.mockResolvedValue([]);
  });
  it("uses the authorized transaction and exact reviews.read permission", async () => {
    const result = await read({ view: "reviews", rating: 1, status: "hidden" });
    expect(mocks.authorize).toHaveBeenCalledWith({
      tx,
      envelope: {},
      permission: "reviews.read",
    });
    expect(mocks.reviews).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          storeId: "store-a",
          product: { storeId: "store-a" },
          status: "hidden",
          rating: 1,
        },
        select: expect.objectContaining({
          media: {
            where: { storeId: "store-a", status: "uploaded" },
            select: { id: true },
          },
        }),
      }),
    );
    expect(result.items[0]).toMatchObject({
      rating: 1,
      status: "hidden",
      incentivized: true,
      rewardStatus: "awarded",
      photoCount: 1,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private-media-id|private internal reason/,
    );
  });
  it("keeps participation claim enrichment inside the authorized transaction", async () => {
    mocks.reviews.mockResolvedValue([
      {
        ...row,
        rewardStatus: "pending",
        participationStatus: "validated",
        request: {
          orderId: "private-order",
          incentivePolicyId: "private-policy",
        },
      },
    ]);
    mocks.claims.mockResolvedValue([
      {
        orderId: "private-order",
        sourceReviewId: row.id,
        shopperId: row.shopperId,
        policyId: "private-policy",
        status: "reserved",
        awardSnapshot: { kind: "points", points: "100" },
      },
    ]);
    const result = await read({ view: "reviews" });
    expect(mocks.claims).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: "store-a", orderId: { in: ["private-order"] } },
      }),
    );
    expect(result.items[0]).toMatchObject({ rewardStatus: "pending" });
    expect(JSON.stringify(result)).not.toMatch(
      /private-order|private-policy|private-shopper|canRetryReward|rewardPolicy/,
    );
  });
  it("does not query records after an authority denial", async () => {
    mocks.authorize.mockRejectedValue(new Error("denied"));
    await expect(read({ view: "reviews" })).rejects.toThrow("denied");
    expect(mocks.reviews).not.toHaveBeenCalled();
    expect(mocks.requests).not.toHaveBeenCalled();
    expect(mocks.claims).not.toHaveBeenCalled();
  });
  it("scopes opaque pagination to installation, store, app and filters", async () => {
    mocks.reviews.mockResolvedValue([row, { ...row, id: "review-1" }]);
    const first = await read({ view: "reviews", limit: 1, rating: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    await read({
      view: "reviews",
      limit: 1,
      rating: 1,
      cursor: first.nextCursor,
    });
    expect(mocks.reviews).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { createdAt: { lt: now }, id: undefined },
            { createdAt: now, id: { lt: row.id } },
          ],
        }),
      }),
    );
    for (const change of [
      { storeId: "other" },
      { appId: "other" },
      { installationGeneration: "other" },
    ]) {
      mocks.authorize.mockResolvedValue({ ...identity, ...change });
      await expect(
        read({ view: "reviews", rating: 1, cursor: first.nextCursor }),
      ).rejects.toThrow("Invalid review cursor");
    }
    mocks.authorize.mockResolvedValue(identity);
    for (const query of [
      { view: "reviews", rating: 2 },
      { view: "reviews", rating: 1, status: "published" },
      { view: "requests" },
    ])
      await expect(
        read({ ...query, cursor: first.nextCursor }),
      ).rejects.toThrow("Invalid review cursor");
    await expect(
      read({ view: "reviews", rating: 1, cursor: `${first.nextCursor}=` }),
    ).rejects.toThrow("Invalid review cursor");
  });
  it("exposes delivery state but not provider errors or tokens", async () => {
    mocks.requests.mockResolvedValue([
      {
        id: "request-1",
        createdAt: now,
        status: "failed",
        sendAt: now,
        expiresAt: now,
        sentAt: null,
        submittedAt: null,
        deliveryAttempts: 3,
        lastError: "secret provider payload",
        cancellationReason: "private reason",
        product: row.product,
      },
    ]);
    const result = await read({ view: "requests" });
    expect(result.items[0]).toMatchObject({
      hasDeliveryError: true,
      deliveryAttempts: 3,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /secret|private|lastError|cancellationReason/,
    );
    expect(mocks.reviews).not.toHaveBeenCalled();
  });
  it.each([
    { view: "requests", rating: 1 },
    { view: "reviews", status: "sent" },
    { view: "requests", status: "published" },
    { view: "reviews", storeId: "other" },
    { view: "reviews", limit: 101 },
    { view: "reviews", cursor: "x".repeat(4097) },
  ])("rejects invalid input before authorization: %j", async (input) => {
    expect(merchantReviewListInputSchema.safeParse(input).success).toBe(false);
    await expect(read(input)).rejects.toThrow();
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});

describe("merchant review inbox browser client", () => {
  it("obtains a fresh bearer token for each page without cookies", async () => {
    const token = vi
      .fn()
      .mockResolvedValueOnce("first")
      .mockResolvedValueOnce("second");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        Response.json({ view: "reviews", items: [], nextCursor: null }),
      );
    const client = createMerchantReviewsClient(token, fetcher);
    await client({ view: "reviews" });
    await client({ view: "reviews" });
    expect(token).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]).toEqual([
      "/api/merchant/reviews",
      expect.objectContaining({
        credentials: "omit",
        cache: "no-store",
        headers: expect.objectContaining({ Authorization: "Bearer second" }),
      }),
    ]);
  });
  it.each([401, 403, 409, 503])("does not retry status %s", async (status) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private error", { status }));
    await expect(
      createMerchantReviewsClient(
        async () => "token",
        fetcher,
      )({ view: "reviews" }),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    { view: "requests", items: [], nextCursor: null },
    { view: "reviews", items: [], nextCursor: "same" },
    { view: "reviews", items: [], nextCursor: null, accessToken: "private" },
  ])("rejects wrong-view, stalled or expanded responses", async (page) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(page));
    await expect(
      createMerchantReviewsClient(
        async () => "token",
        fetcher,
      )({ view: "reviews", cursor: "same" }),
    ).rejects.toThrow();
  });
});
