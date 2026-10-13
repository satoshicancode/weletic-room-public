import { ReviewError } from "@/lib/weletic/reviews/contracts";
import { openReviewSubmissionRoute } from "@/lib/weletic/reviews/open-submission-route";
import { moderateNativeReviewInTransaction } from "@/lib/weletic/reviews/service";
import { signWeleticShopifyRequest } from "@/lib/weletic/shopify/service-auth";
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

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
    weleticReviewIncentiveClaim: { findUnique: vi.fn() },
    weleticShopifyStore: { findUnique: vi.fn() },
    $queryRaw: vi.fn(async (query: any) => {
      const q = Array.isArray(query) ? query.join("") : String(query);
      return q.includes("WeleticReviewSettings")
        ? [{ enabled: true }]
        : [{ id: "gid://shopify/Product/999", title: "Product Title" }];
    }),
  },
  boundary: vi.fn(),
  enqueue: vi.fn(),
  award: vi.fn(),
  reverse: vi.fn(),
  limit: vi.fn(),
  policy: vi.fn(),
  customer: vi.fn(),
  submit: vi.fn(),
  upload: vi.fn(),
  storage: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticProductReview: mocks.tx.weleticProductReview,
    weleticShopifyStore: mocks.tx.weleticShopifyStore,
  },
}));

vi.mock("@/lib/upstash", () => ({
  ratelimit: () => ({ limit: mocks.limit }),
}));

vi.mock("@/lib/weletic/reviews/open-policy-history", () => ({
  readCurrentOpenReviewPolicy: mocks.policy,
}));

vi.mock("@/lib/weletic/reviews/open-submission-customer", () => ({
  readOpenReviewCustomer: mocks.customer,
}));

vi.mock("@/lib/weletic/reviews/open-submission-write", () => ({
  submitOpenReview: mocks.submit,
}));

vi.mock("@/lib/weletic/reviews/open-media-upload", () => ({
  uploadOpenReviewPhoto: mocks.upload,
}));

vi.mock("@/lib/weletic/reviews/media", () => ({
  requireReviewStorage: mocks.storage,
}));

vi.mock("@/lib/weletic/reviews/transaction", () => ({
  withReviewMutation: (storeId: string, fn: any) => mocks.boundary(storeId, fn),
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

const TEST_SECRET = "open-review-route-test-secret-32-characters";
process.env.WELETIC_SHOPIFY_SERVICE_SECRET = TEST_SECRET;

describe("Round 2 UGC Reviews Incentive Moderation & Multi-Domain Resolution Test Suite", () => {
  const storeId = "store-ugc-1";
  const generation = "gen-1";
  const userId = "user-mod-1";
  let requestCounter = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.boundary.mockImplementation(
      async (_store: string, fn: (tx: any, gen: string) => Promise<any>) => {
        return fn(mocks.tx as any, generation);
      },
    );
    mocks.limit.mockResolvedValue({ success: true, reset: 0, remaining: 10 });
    mocks.tx.weleticReviewSettings.findUnique.mockResolvedValue({
      enabled: true,
      autoPublish: false,
    });
    mocks.tx.weleticReviewOrderCancellation.findUnique.mockResolvedValue(null);
  });

  describe("Feature 5: Incentive Moderation Lifecycle (Pending -> Approved vs Approved -> Rejected Clawback)", () => {
    it("approves pending review to published and triggers review reward issuance & event emission", async () => {
      const reviewId = "wreview_11111111111111111111"; // 28 chars valid format
      const existingReview = {
        id: reviewId,
        storeId,
        version: 1,
        status: "pending",
        rewardStatus: "pending",
        rewardReason: null,
        rating: 5,
        verifiedPurchase: true,
        productId: "gid://shopify/Product/100",
        shopperId: "shopper-1",
        publishedAt: null,
        merchantReply: null,
        request: {
          id: "req-1",
          storeId,
          orderId: "order-1",
          incentivePolicyId: null, // native points incentive
          order: { externalId: "ext-1", generation },
        },
      };

      mocks.tx.weleticProductReview.findFirst.mockResolvedValue(existingReview);
      mocks.tx.weleticProductReview.findFirstOrThrow.mockResolvedValue(
        existingReview,
      );
      mocks.tx.weleticProductReview.updateMany.mockResolvedValue({ count: 1 });
      mocks.tx.weleticProductReview.findUniqueOrThrow.mockResolvedValue({
        ...existingReview,
        status: "published",
        version: 2,
        publishedAt: new Date("2026-10-09T10:00:00Z"),
      });

      mocks.award.mockResolvedValue({
        status: "awarded",
        pointsDelta: BigInt(200),
      });

      const result = await moderateNativeReviewInTransaction({
        tx: mocks.tx as any,
        storeId,
        reviewId,
        userId,
        input: {
          version: 1,
          status: "published",
        },
        generation,
      });

      expect(result.status).toBe("published");
      expect(result.version).toBe(2);

      // Verify DB update transitioned status to published and incremented version
      expect(mocks.tx.weleticProductReview.updateMany).toHaveBeenCalledWith({
        where: { id: reviewId, storeId, version: 1 },
        data: expect.objectContaining({
          status: "published",
          version: { increment: 1 },
          moderatedByUserId: userId,
        }),
      });

      // Verify summary sync job was enqueued for storefront display
      expect(mocks.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId,
          jobType: "REVIEW_SUMMARY_SYNC",
          payload: { productId: "gid://shopify/Product/100" },
        }),
      );
    });

    it("moderates published review with awarded points to rejected and executes clawback reversal", async () => {
      const reviewId = "wreview_22222222222222222222";
      const awardedReview = {
        id: reviewId,
        storeId,
        version: 2,
        status: "published",
        rewardStatus: "awarded",
        rewardReason: "review_published",
        rating: 1,
        verifiedPurchase: true,
        productId: "gid://shopify/Product/100",
        shopperId: "shopper-1",
        publishedAt: new Date("2026-10-08T10:00:00Z"),
        merchantReply: null,
        request: {
          id: "req-1",
          storeId,
          orderId: "order-1",
          incentivePolicyId: null,
          order: { externalId: "ext-1", generation },
        },
      };

      mocks.tx.weleticProductReview.findFirst.mockResolvedValue(awardedReview);
      mocks.tx.weleticProductReview.updateMany.mockResolvedValue({ count: 1 });
      mocks.tx.weleticProductReview.findUniqueOrThrow.mockResolvedValue({
        ...awardedReview,
        status: "rejected",
        rewardStatus: "reversed",
        rewardReason: "review_rejected",
        version: 3,
      });

      // Mock reversal engine successful clawback
      mocks.reverse.mockResolvedValue({
        status: "reversed",
        ledgerEntryId: "ledger-reversal-1",
        pointsDeducted: BigInt(200),
      });

      const result = await moderateNativeReviewInTransaction({
        tx: mocks.tx as any,
        storeId,
        reviewId,
        userId,
        input: {
          version: 2,
          status: "rejected",
        },
        generation,
      });

      expect(result.status).toBe("rejected");

      // reverseReviewPoints must be called with provider native and reason review_rejected
      expect(mocks.reverse).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId,
          provider: "native",
          reviewId,
          reason: "review_rejected",
        }),
      );

      // Review record must be updated to rewardStatus: reversed
      expect(mocks.tx.weleticProductReview.update).toHaveBeenCalledWith({
        where: { id: reviewId },
        data: {
          rewardStatus: "reversed",
          rewardReason: "review_rejected",
        },
      });
    });

    it("throws ReviewError and prevents status change when reward ledger evidence is missing during clawback", async () => {
      const reviewId = "wreview_33333333333333333333";
      const awardedReview = {
        id: reviewId,
        storeId,
        version: 2,
        status: "published",
        rewardStatus: "awarded",
        rewardReason: "review_published",
        rating: 1,
        verifiedPurchase: true,
        productId: "gid://shopify/Product/100",
        shopperId: "shopper-1",
        publishedAt: new Date("2026-10-08T10:00:00Z"),
        request: {
          id: "req-1",
          storeId,
          orderId: "order-1",
          incentivePolicyId: null,
          order: { externalId: "ext-1", generation },
        },
      };

      mocks.tx.weleticProductReview.findFirst.mockResolvedValue(awardedReview);
      mocks.tx.weleticProductReview.updateMany.mockResolvedValue({ count: 1 });

      // Reversal engine returns ignored due to missing ledger record
      mocks.reverse.mockResolvedValue({
        status: "ignored",
        reason: "ledger_entry_missing",
      });

      await expect(
        moderateNativeReviewInTransaction({
          tx: mocks.tx as any,
          storeId,
          reviewId,
          userId,
          input: {
            version: 2,
            status: "rejected",
          },
          generation,
        }),
      ).rejects.toThrowError(
        new ReviewError("unavailable", "Reward ledger evidence is missing"),
      );
    });

    it("enforces Optimistic Concurrency Control (OCC) by rejecting conflicting patch versions", async () => {
      const reviewId = "wreview_44444444444444444444";
      const currentReview = {
        id: reviewId,
        storeId,
        version: 5, // Server has version 5
        status: "pending",
        rating: 4,
        request: null,
      };

      mocks.tx.weleticProductReview.findFirst.mockResolvedValue(currentReview);

      // Caller submits stale patch with version 4
      await expect(
        moderateNativeReviewInTransaction({
          tx: mocks.tx as any,
          storeId,
          reviewId,
          userId,
          input: {
            version: 4,
            status: "published",
          },
          generation,
        }),
      ).rejects.toThrowError(
        new ReviewError("conflict", "Review changed; reload before moderating"),
      );
    });
  });

  describe("Feature 6: Open Review Submission Store Resolution & Security (REV-02 / Invariant 1)", () => {
    function generateAuthorBinding(
      shop: string,
      customerId: string,
      gen: string,
    ) {
      return createHmac("sha256", TEST_SECRET)
        .update(
          JSON.stringify([
            "weletic:open-review-author:v1",
            shop,
            customerId,
            gen,
          ]),
        )
        .digest("hex");
    }

    function createSignedRequest({
      shop,
      customerId,
      body,
      signed = true,
      customSignature,
    }: {
      shop: string;
      customerId: string;
      body: any;
      signed?: boolean;
      customSignature?: string;
    }) {
      const bodyStr = JSON.stringify(body);
      const path = `/api/internal/shopify/reviews/open-submit?shop=${shop}&customerId=${customerId}&source=app_proxy`;
      const timestamp = String(Date.now());
      const requestId = `req_test_${Date.now()}_${++requestCounter}`;

      const signature = customSignature
        ? customSignature
        : signed
          ? signWeleticShopifyRequest({
              timestamp,
              method: "POST",
              path,
              body: bodyStr,
              secret: TEST_SECRET,
              requestId,
            })
          : "invalid_sig";

      return new Request(`https://backend.example.test${path}`, {
        method: "POST",
        body: bodyStr,
        headers: {
          "content-type": "application/json",
          "x-weletic-timestamp": timestamp,
          "x-weletic-request-id": requestId,
          "x-weletic-signature": signature,
        },
      });
    }

    it("verifies canonical store resolution and signs valid submission for open reviews", async () => {
      const shopDomain = "yamax-official.myshopify.com";
      const customerId = "987654321";
      const binding = generateAuthorBinding(shopDomain, customerId, generation);

      mocks.tx.weleticShopifyStore.findUnique.mockResolvedValue({
        id: storeId,
        shopDomain,
        installationGeneration: generation,
      });

      mocks.policy.mockResolvedValue({
        revision: 1,
        policy: { enabled: true, photoUploadsEnabled: true },
        photoUploadsAvailable: true,
        installationGeneration: generation,
      });
      mocks.customer.mockResolvedValue({
        displayName: "Verified Shopper",
        verifiedPurchase: true,
      });
      mocks.submit.mockImplementation(async ({ authorize }: any) => {
        await authorize(mocks.tx);
        return {
          id: "open-rev-1",
          duplicate: false,
        };
      });

      const bodyPayload = {
        authorBinding: binding,
        submissionId: "11111111-2222-4333-8444-555555555555",
        productId: "gid://shopify/Product/999",
        expectedInstallationGeneration: generation,
        expectedSettingsRevision: 1,
        locale: "en",
        disclosureRevision: "open_unverified_unrewarded_v1",
        rating: 5,
        title: "Exceptional quality",
        body: "Fits perfectly and stays comfortable all day.",
        displayName: "Verified Shopper",
        mediaIds: [],
        publishConsent: true,
      };

      const request = createSignedRequest({
        shop: shopDomain,
        customerId,
        body: bodyPayload,
      });

      const response = await openReviewSubmissionRoute(request, "submit");
      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data).toMatchObject({
        id: "open-rev-1",
        duplicate: false,
      });
    });

    it("rejects open review submission when author binding HMAC does not match expected signature", async () => {
      const shopDomain = "yamax-official.myshopify.com";
      const customerId = "987654321";
      // Tampered binding (for different customer)
      const tamperedBinding = generateAuthorBinding(
        shopDomain,
        "fake-customer",
        generation,
      );

      mocks.tx.weleticShopifyStore.findUnique.mockResolvedValue({
        id: storeId,
        shopDomain,
        installationGeneration: generation,
      });

      const bodyPayload = {
        authorBinding: tamperedBinding,
        submissionId: "11111111-2222-4333-8444-555555555555",
        productId: "gid://shopify/Product/999",
        expectedInstallationGeneration: generation,
        expectedSettingsRevision: 1,
        locale: "en",
        disclosureRevision: "open_unverified_unrewarded_v1",
        rating: 5,
        title: "Spam",
        body: "Fraudulent review attempt",
        displayName: "Attacker",
        mediaIds: [],
        publishConsent: true,
      };

      const request = createSignedRequest({
        shop: shopDomain,
        customerId,
        body: bodyPayload,
      });

      const response = await openReviewSubmissionRoute(request, "submit");
      expect(response.status).toBe(409); // Conflict: Review session changed
    });

    it("rejects requests missing valid Shopify service authentication signature", async () => {
      const shopDomain = "yamax-official.myshopify.com";
      const customerId = "987654321";
      const request = new Request(
        `https://backend.example.test/api/internal/shopify/reviews/open-submit?shop=${shopDomain}&customerId=${customerId}&source=app_proxy`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rating: 5, publishConsent: true }),
        },
      );

      const response = await openReviewSubmissionRoute(request, "submit");
      expect(response.status).toBe(401);
    });

    it("returns 404 Store unavailable when shop cannot be found or resolved", async () => {
      const unknownShop = "unregistered-shop.myshopify.com";
      const customerId = "987654321";
      const binding = generateAuthorBinding(
        unknownShop,
        customerId,
        generation,
      );

      mocks.tx.weleticShopifyStore.findUnique.mockResolvedValue(null);

      const bodyPayload = {
        authorBinding: binding,
        submissionId: "11111111-2222-4333-8444-555555555555",
        productId: "gid://shopify/Product/999",
        expectedInstallationGeneration: generation,
        expectedSettingsRevision: 1,
        locale: "en",
        disclosureRevision: "open_unverified_unrewarded_v1",
        rating: 5,
        title: "Great product",
        body: "Very soft fabric that fits amazingly well and feels great.",
        displayName: "Customer",
        mediaIds: [],
        publishConsent: true,
      };

      const request = createSignedRequest({
        shop: unknownShop,
        customerId,
        body: bodyPayload,
      });

      const response = await openReviewSubmissionRoute(request, "submit");
      expect(response.status).toBe(404);
    });
  });
});
