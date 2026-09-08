import { generateReviewToken } from "@/lib/weletic/reviews/contracts";
import {
  moderateNativeReview,
  moderateNativeReviewInTransaction,
  submitNativeReview,
  updateReviewSettings,
} from "@/lib/weletic/reviews/service";
import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: {
    weleticReviewSettings: { findUnique: vi.fn(), upsert: vi.fn() },
    weleticReviewRequest: { findFirst: vi.fn(), updateMany: vi.fn() },
    weleticReviewMedia: { findMany: vi.fn(), updateMany: vi.fn() },
    weleticProductReview: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticReviewOrderCancellation: { findUnique: vi.fn() },
    weleticLoyaltyReviewIntegration: { updateMany: vi.fn() },
    weleticPointsLedgerEntry: { findUniqueOrThrow: vi.fn() },
    weleticShopifyCustomerPrivacyTombstone: { findFirst: vi.fn() },
  },
  boundary: vi.fn(),
  enqueue: vi.fn(),
  award: vi.fn(),
  reverse: vi.fn(),
}));
vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: (...args: unknown[]) => mocks.boundary(...args),
}));
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJobFromProgramTransaction: (...args: unknown[]) =>
    mocks.enqueue(...args),
}));
vi.mock("@/lib/weletic/loyalty/review-rewards", async () => ({
  reviewAwardKey: (store: string, provider: string, id: string) =>
    `review:${provider}:${store}:${id}`,
  awardVerifiedReviewPoints: (...args: unknown[]) => mocks.award(...args),
  reverseReviewPoints: (...args: unknown[]) => mocks.reverse(...args),
}));

const settings = {
  enabled: true,
  requestEmailEnabled: true,
  autoPublish: false,
  photoUploadsEnabled: true,
  sendAfterDays: 7,
  expiresAfterDays: 30,
};
function requestFixture() {
  return {
    id: "request-1",
    storeId: "store-1",
    orderId: "order-1",
    productId: "product-1",
    shopperId: "shopper-1",
    installationGeneration: "g1",
    incentivePolicyId: null,
    status: "sent",
    tokenHash: "digest",
    expiresAt: new Date(Date.now() + 3600000),
    order: {
      id: "order-1",
      externalId: "123",
      storeId: "store-1",
      shopperId: "shopper-1",
      status: "partially_refunded",
    },
    product: {
      id: "product-1",
      storeId: "store-1",
      externalId: "gid://shopify/Product/123",
      title: "Product",
      handle: "product",
    },
    shopper: {
      id: "shopper-1",
      storeId: "store-1",
      shopifyCustomerId: "123",
      email: "synthetic@example.invalid",
      privacyTombstones: [],
    },
    lines: [
      {
        purchasedQuantity: 2,
        orderLine: {
          orderId: "order-1",
          productId: "product-1",
          quantity: 2,
          shopNet: BigInt(100),
          refundLines: [{ quantity: 1, shopAmount: BigInt(50) }],
        },
      },
    ],
  };
}
function submission() {
  return {
    token: generateReviewToken(),
    rating: 1,
    title: "Honest opinion",
    body: "This product did not meet my expectations.",
    displayName: "Buyer",
    publishConsent: true,
  };
}
function reviewFixture() {
  return {
    id: "review-1",
    storeId: "store-1",
    productId: "product-1",
    shopperId: "shopper-1",
    status: "published",
    version: 1,
    publishedAt: new Date(),
    rewardStatus: "awarded",
    rating: 1,
    body: submission().body,
    request: requestFixture(),
    media: [],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.boundary.mockImplementation(
    async (
      _store: string,
      operation: (
        tx: Prisma.TransactionClient,
        generation: string,
      ) => Promise<unknown>,
    ) => operation(mocks.tx as unknown as Prisma.TransactionClient, "g1"),
  );
  mocks.tx.weleticReviewSettings.findUnique.mockResolvedValue(settings);
  mocks.tx.weleticReviewSettings.upsert.mockResolvedValue(settings);
  mocks.tx.weleticReviewRequest.findFirst.mockResolvedValue(requestFixture());
  mocks.tx.weleticReviewRequest.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.weleticReviewMedia.findMany.mockResolvedValue([]);
  mocks.tx.weleticProductReview.create.mockImplementation(async ({ data }) => ({
    ...data,
    version: 1,
  }));
  mocks.tx.weleticProductReview.findFirst.mockResolvedValue(reviewFixture());
  mocks.tx.weleticProductReview.findFirstOrThrow.mockResolvedValue(
    reviewFixture(),
  );
  mocks.tx.weleticProductReview.findUniqueOrThrow.mockResolvedValue(
    reviewFixture(),
  );
  mocks.tx.weleticProductReview.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.weleticReviewOrderCancellation.findUnique.mockResolvedValue(null);
  mocks.reverse.mockResolvedValue({ status: "clawed_back" });
});

describe("native review production services (mocked database boundary)", () => {
  it("keeps the supplied transaction for review, legacy reversal and summary writes", async () => {
    const tx = mocks.tx as unknown as Prisma.TransactionClient;
    await moderateNativeReviewInTransaction({
      tx,
      storeId: "store-1",
      reviewId: "review-1",
      userId: "owner-1",
      input: { version: 1, status: "hidden" },
      generation: "g1",
    });
    expect(mocks.boundary).not.toHaveBeenCalled();
    expect(mocks.tx.weleticProductReview.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { storeId: "store-1", id: "review-1", version: 1 },
        data: expect.objectContaining({
          moderatedByUserId: "owner-1",
          status: "hidden",
        }),
      }),
    );
    expect(mocks.reverse).toHaveBeenCalledWith(
      expect.objectContaining({ tx, storeId: "store-1" }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ tx, storeId: "store-1" }),
    );
  });
  it("propagates a summary failure without opening a recovery transaction", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("synthetic summary failure"));
    await expect(
      moderateNativeReviewInTransaction({
        tx: mocks.tx as unknown as Prisma.TransactionClient,
        storeId: "store-1",
        reviewId: "review-1",
        userId: "owner-1",
        input: { version: 1, status: "hidden" },
        generation: "g1",
      }),
    ).rejects.toThrow("synthetic summary failure");
    expect(mocks.boundary).not.toHaveBeenCalled();
    expect(mocks.reverse).toHaveBeenCalledTimes(1);
  });
  it("validates primitive input before reading or changing a review", async () => {
    await expect(
      moderateNativeReviewInTransaction({
        tx: mocks.tx as unknown as Prisma.TransactionClient,
        storeId: "store-1",
        reviewId: "review-1",
        userId: "owner-1",
        input: { version: 1, rating: 5 },
        generation: "g1",
      }),
    ).rejects.toThrow();
    expect(mocks.tx.weleticProductReview.findFirst).not.toHaveBeenCalled();
    expect(mocks.boundary).not.toHaveBeenCalled();
  });
  it("never awards a pinned new-policy review through the legacy publication writer", async () => {
    mocks.tx.weleticProductReview.findFirstOrThrow.mockResolvedValue({
      ...reviewFixture(),
      status: "published",
      rewardStatus: "pending",
      request: { ...requestFixture(), incentivePolicyId: "policy-1" },
    });
    await moderateNativeReview("store-1", "review-1", "owner-1", {
      version: 1,
      status: "published",
    });
    expect(mocks.award).not.toHaveBeenCalled();
  });
  it("does not claw back a new-policy participation reward merely for hiding the review", async () => {
    mocks.tx.weleticProductReview.findFirst.mockResolvedValue({
      ...reviewFixture(),
      request: { ...requestFixture(), incentivePolicyId: "policy-1" },
    });
    await moderateNativeReview("store-1", "review-1", "owner-1", {
      version: 1,
      status: "hidden",
    });
    expect(mocks.reverse).not.toHaveBeenCalled();
  });
  it("consumes a valid partially-refunded purchase token conditionally and creates a pending one-star review", async () => {
    const result = await submitNativeReview("store-1", submission());
    expect(result.status).toBe("pending");
    expect(mocks.tx.weleticReviewRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "request-1",
          storeId: "store-1",
          status: "sent",
          tokenHash: "digest",
        }),
      }),
    );
    expect(mocks.tx.weleticProductReview.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeId: "store-1",
          shopperId: "shopper-1",
          rating: 1,
        }),
      }),
    );
    expect(mocks.award).not.toHaveBeenCalled();
  });
  it("does not create a second review when conditional token consumption loses", async () => {
    mocks.tx.weleticReviewRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(submitNativeReview("store-1", submission())).rejects.toThrow(
      "already been used",
    );
    expect(mocks.tx.weleticProductReview.create).not.toHaveBeenCalled();
  });
  it("rejects wrong-tenant, old-installation and privacy-tombstoned purchase evidence", async () => {
    for (const request of [
      { ...requestFixture(), installationGeneration: "old" },
      {
        ...requestFixture(),
        shopper: { storeId: "other", privacyTombstones: [] },
      },
      {
        ...requestFixture(),
        shopper: {
          storeId: "store-1",
          privacyTombstones: [{ id: "tombstone" }],
        },
      },
    ]) {
      mocks.tx.weleticReviewRequest.findFirst.mockResolvedValue(request);
      await expect(submitNativeReview("store-1", submission())).rejects.toThrow(
        "unavailable",
      );
    }
    expect(mocks.tx.weleticReviewRequest.updateMany).not.toHaveBeenCalled();
  });
  it("fails closed when attached media does not belong to this request", async () => {
    await expect(
      submitNativeReview("store-1", {
        ...submission(),
        mediaIds: ["wrevmedia_other"],
      }),
    ).rejects.toThrow("another request");
    expect(mocks.tx.weleticReviewRequest.updateMany).not.toHaveBeenCalled();
  });
  it("reverses the exact original reward through the shared service when hiding", async () => {
    await moderateNativeReview("store-1", "review-1", "owner-1", {
      version: 1,
      status: "hidden",
    });
    expect(mocks.reverse).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store-1",
        provider: "native",
        reviewId: "review-1",
        reason: "review_hidden",
      }),
    );
    expect(mocks.tx.weleticProductReview.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { rewardStatus: "reversed", rewardReason: "review_hidden" },
      }),
    );
    expect(mocks.enqueue).toHaveBeenCalled();
  });
  it("does not mutate a concurrently changed moderation revision", async () => {
    await expect(
      moderateNativeReview("store-1", "review-1", "owner-1", {
        version: 2,
        status: "hidden",
      }),
    ).rejects.toThrow("reload");
    expect(mocks.tx.weleticProductReview.updateMany).not.toHaveBeenCalled();
    expect(mocks.reverse).not.toHaveBeenCalled();
  });
  it("does not award again when a reversed review is republished", async () => {
    const review = { ...reviewFixture(), rewardStatus: "reversed" };
    mocks.tx.weleticProductReview.findFirstOrThrow.mockResolvedValue(review);
    await moderateNativeReview("store-1", "review-1", "owner-1", {
      version: 1,
      status: "published",
    });
    expect(mocks.award).not.toHaveBeenCalled();
  });
  it("disables Judge.me on native activation without deleting any legacy rows", async () => {
    await updateReviewSettings("store-1", settings);
    expect(
      mocks.tx.weleticLoyaltyReviewIntegration.updateMany,
    ).toHaveBeenCalledWith({
      where: { storeId: "store-1", provider: "judgeme" },
      data: { enabled: false },
    });
  });
  it("does not issue a new reward while native reviews are disabled", async () => {
    mocks.tx.weleticReviewSettings.findUnique.mockResolvedValue({
      enabled: false,
    });
    mocks.tx.weleticProductReview.findFirstOrThrow.mockResolvedValue({
      ...reviewFixture(),
      rewardStatus: "pending",
    });
    await moderateNativeReview("store-1", "review-1", "owner-1", {
      version: 1,
      status: "published",
      retryReward: true,
    });
    expect(mocks.award).not.toHaveBeenCalled();
    expect(mocks.tx.weleticProductReview.update).toHaveBeenCalledWith({
      where: { id: "review-1" },
      data: {
        rewardStatus: "pending",
        rewardReason: "native_reviews_disabled",
      },
    });
  });
});
