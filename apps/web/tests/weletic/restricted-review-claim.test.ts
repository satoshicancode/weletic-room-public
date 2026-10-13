import {
  reserveProductReviewIncentiveInTransaction,
  reviewParticipationContentDigest,
} from "@/lib/weletic/reviews/incentive-claims";
import { reviewIncentivePolicyDigest } from "@/lib/weletic/reviews/incentive-policy";
import type { Prisma } from "@prisma/client";
import { expect, it, vi } from "vitest";

const gate = vi.hoisted(() => vi.fn());
vi.mock("@/lib/weletic/shopify/app-pricing-service", () => ({
  assertReviewAwardTestingAuthority: gate,
}));
vi.mock("@/lib/weletic/reviews/purchase", () => ({
  assertReviewPurchase: vi.fn(),
  assertReviewPurchaseNotSuppressed: vi.fn(),
  reviewRequestInclude: {},
}));

it("checks testing authority before a first participation claim while retaining existing claim recovery", async () => {
  const snapshot = {
    version: 1,
    award: {
      kind: "points",
      basePoints: "100",
      photoBonusPoints: "0",
      videoBonusPoints: "0",
      maxPoints: "100",
    },
  };
  const review = {
    id: "review",
    storeId: "store",
    shopperId: "shopper",
    productId: "product",
    requestId: "request",
    title: "Honest criticism",
    body: "This product disappointed me.",
    rating: 1,
    status: "pending",
    verifiedPurchase: true,
    participationStatus: "validated",
    participationValidatedAt: new Date(),
    participationValidationRevision: "purchase_abuse_v1",
    request: {
      storeId: "store",
      shopperId: "shopper",
      productId: "product",
      status: "submitted",
      orderId: "order",
      order: { externalId: "external" },
      incentivePolicyId: "policy",
    },
    media: [],
  };
  const claim = vi.fn().mockResolvedValue(null);
  const create = vi.fn();
  const tx = {
    weleticReviewSettings: {
      findUnique: vi.fn().mockResolvedValue({ enabled: true }),
    },
    weleticProductReview: {
      findFirst: vi.fn().mockResolvedValue({
        ...review,
        participationContentDigest: reviewParticipationContentDigest({
          ...review,
          mediaIds: [],
        }),
      }),
    },
    weleticReviewOrderCancellation: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    weleticReviewRequest: { findFirst: vi.fn().mockResolvedValue(null) },
    weleticReviewIncentivePolicy: {
      findUnique: vi.fn().mockResolvedValue({
        id: "policy",
        snapshot,
        contentDigest: reviewIncentivePolicyDigest(snapshot),
      }),
    },
    weleticReviewIncentiveClaim: { findUnique: claim, create },
  } as unknown as Prisma.TransactionClient;
  const run = () =>
    reserveProductReviewIncentiveInTransaction({
      tx,
      storeId: "store",
      reviewId: "review",
      generation: "generation",
    });
  gate.mockRejectedValue(new Error("Testing authority expired"));
  await expect(run()).rejects.toThrow("Testing authority expired");
  expect(gate).toHaveBeenCalledWith(tx, "store");
  expect(create).not.toHaveBeenCalled();
  gate.mockClear();
  claim.mockResolvedValue({ id: "existing-claim", shopperId: "shopper" });
  await expect(run()).resolves.toMatchObject({
    status: "already_claimed",
    created: false,
  });
  expect(gate).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});
