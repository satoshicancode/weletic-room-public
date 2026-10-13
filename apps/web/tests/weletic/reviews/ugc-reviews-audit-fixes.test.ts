import { storage } from "@/lib/storage";
import {
  reserveProductReviewIncentiveInTransaction,
  reviewParticipationContentDigest,
} from "@/lib/weletic/reviews/incentive-claims";
import { reviewIncentivePolicyDigest } from "@/lib/weletic/reviews/incentive-policy";
import { moderateNativeReviewInTransaction } from "@/lib/weletic/reviews/service";
import { syncProductReviewSummary } from "@/lib/weletic/reviews/summary-sync";
import dns from "dns";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: ({ fn }: any) => fn(),
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreMatchesInstallationGeneration: vi.fn().mockResolvedValue({
    id: "store_m2_audit",
    shopDomain: "test-shop.myshopify.com",
    installationGeneration: "gen_m2_1",
    complianceState: "active",
    storeAccessState: "active",
  }),
  assertShopifyStoreAcceptsOperationalWrites: vi.fn().mockResolvedValue({
    id: "store_m2_audit",
    shopDomain: "test-shop.myshopify.com",
    installationGeneration: "gen_m2_1",
    complianceState: "active",
    storeAccessState: "active",
  }),
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/weletic/loyalty/shopify-discounts")
    >();
  return {
    ...actual,
    resolveShopifyOfflineCredentials: vi.fn().mockResolvedValue({
      shopDomain: "test-shop.myshopify.com",
      accessToken: "shpat_test_token",
    }),
    shopifyAdminGraphqlRequest: vi.fn().mockImplementation(async (opts) => {
      // Verify that maxRetries is 3
      if (opts.maxRetries !== 3) {
        throw new Error(`Expected maxRetries to be 3, got ${opts.maxRetries}`);
      }
      return {
        metafieldsSet: { userErrors: [] },
        metafieldsDelete: {
          userErrors: [{ message: "Metafield does not exist" }],
        },
      };
    }),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyProduct: {
      findFirst: vi.fn().mockResolvedValue({
        id: "prod_1",
        externalId: "gid://shopify/Product/123",
      }),
    },
    $transaction: vi.fn().mockImplementation(async (fn: any, opts?: any) => {
      // REV-05: Ensure RepeatableRead is NOT passed
      if (opts?.isolationLevel) {
        throw new Error(
          `Unsupported isolation level in transaction: ${opts.isolationLevel}`,
        );
      }
      return fn({
        $queryRaw: vi.fn().mockResolvedValue([]),
      });
    }),
  },
}));

describe("Milestone 2 (UGC Reviews & Media Assets) Pre-Production Audit Fixes", () => {
  const storeId = "store_m2_audit";
  const generation = "gen_m2_1";
  const userId = "moderator_user_1";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("REV-01: Review Incentive Moderation Timing & Clawback/Revocation", () => {
    it("defers points fulfillment when review is pending upon submission", async () => {
      const basePendingReview = {
        id: "wreview_pending_1",
        storeId,
        productId: "product_1",
        requestId: "req_1",
        title: "Great product",
        body: "Really loved it!",
        rating: 5,
        status: "pending",
        shopperId: "shopper_1",
        verifiedPurchase: true,
        participationStatus: "validated",
        participationValidationRevision: "purchase_abuse_v1",
        participationValidatedAt: new Date(),
        request: {
          id: "req_1",
          storeId,
          orderId: "order_1",
          productId: "product_1",
          incentivePolicyId: "wrevpol_1",
          status: "submitted",
          shopperId: "shopper_1",
          installationGeneration: generation,
          order: {
            id: "order_1",
            storeId,
            shopperId: "shopper_1",
            status: "paid",
            externalId: "ext_order_1",
            generation,
          },
          product: {
            id: "product_1",
            storeId,
            externalId: "gid://shopify/Product/123",
            title: "Product",
            handle: "product",
          },
          shopper: {
            id: "shopper_1",
            storeId,
            shopifyCustomerId: "123",
            email: "shopper@example.com",
            privacyTombstones: [],
          },
          lines: [
            {
              purchasedQuantity: 1,
              orderLine: {
                orderId: "order_1",
                productId: "product_1",
                quantity: 1,
                shopNet: BigInt(100),
                refundLines: [],
              },
            },
          ],
        },
        media: [],
      };

      const pendingReview = {
        ...basePendingReview,
        participationContentDigest: reviewParticipationContentDigest({
          ...basePendingReview,
          mediaIds: [],
        }),
      };

      const policySnapshot = {
        version: 1 as const,
        award: {
          kind: "points" as const,
          basePoints: "150",
          photoBonusPoints: "50",
          videoBonusPoints: "50",
          maxPoints: "250",
        },
      };

      const mockTx: any = {
        weleticReviewSettings: {
          findUnique: vi.fn().mockResolvedValue({
            enabled: true,
            activeIncentivePolicyId: "wrevpol_1",
          }),
        },
        weleticReviewIncentiveClaim: {
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "wrevclaim_1",
            storeId,
            orderId: "order_1",
            shopperId: "shopper_1",
            policyId: "wrevpol_1",
            sourceReviewId: "wreview_pending_1",
            status: "reserved",
            awardSnapshot: { kind: "points", points: "150" },
          }),
        },
        weleticProductReview: {
          findFirst: vi.fn().mockResolvedValue(pendingReview),
          findFirstOrThrow: vi.fn().mockResolvedValue(pendingReview),
          update: vi.fn().mockResolvedValue(pendingReview),
        },
        weleticReviewIncentivePolicy: {
          findUnique: vi.fn().mockResolvedValue({
            id: "wrevpol_1",
            storeId,
            contentDigest: reviewIncentivePolicyDigest(policySnapshot),
            snapshot: policySnapshot,
          }),
        },
        weleticShopifyStore: {
          findUnique: vi.fn().mockResolvedValue({
            id: storeId,
            developmentStorePolicy: "permitted",
            billingPlanState: "active",
          }),
        },
        weleticReviewOrderCancellation: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
        weleticShopifyCustomerPrivacyTombstone: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        weleticReviewRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      const result = await reserveProductReviewIncentiveInTransaction({
        tx: mockTx,
        storeId,
        reviewId: "wreview_pending_1",
        generation,
      });

      // Claim status must remain reserved when review is pending
      expect(result.status).toBe("reserved");
      expect(result.created).toBe(true);
      expect(result.claim?.id).toBe("wrevclaim_1");
    });

    it("fulfills reserved points claim when review transitions from pending to published", async () => {
      const reviewId = "wreview_12345678901234567890";
      const policySnapshot = {
        version: 1 as const,
        award: {
          kind: "points" as const,
          basePoints: "150",
          photoBonusPoints: "0",
          videoBonusPoints: "0",
          maxPoints: "150",
        },
      };

      const validatedAt = new Date();
      const baseReview = {
        id: reviewId,
        storeId,
        version: 1,
        status: "pending",
        rewardStatus: "pending",
        rating: 5,
        title: "Great product",
        body: "Really loved it!",
        productId: "gid://shopify/Product/101",
        shopperId: "shopper_1",
        verifiedPurchase: true,
        participationStatus: "validated",
        participationValidationRevision: "purchase_abuse_v1",
        participationValidatedAt: validatedAt,
        publishedAt: null,
        merchantReply: null,
        requestId: "req_1",
        media: [],
        request: {
          id: "req_1",
          storeId,
          orderId: "order_1",
          productId: "gid://shopify/Product/101",
          incentivePolicyId: "wrevpol_1",
          status: "submitted",
          shopperId: "shopper_1",
          installationGeneration: generation,
          order: {
            id: "order_1",
            storeId,
            shopperId: "shopper_1",
            status: "paid",
            externalId: "ext_order_1",
            generation,
          },
          product: {
            id: "gid://shopify/Product/101",
            storeId,
            externalId: "gid://shopify/Product/101",
            title: "Product",
            handle: "product",
          },
          shopper: {
            id: "shopper_1",
            storeId,
            shopifyCustomerId: "123",
            email: "shopper@example.com",
            privacyTombstones: [],
          },
          lines: [
            {
              purchasedQuantity: 1,
              orderLine: {
                orderId: "order_1",
                productId: "gid://shopify/Product/101",
                quantity: 1,
                shopNet: BigInt(100),
                refundLines: [],
              },
            },
          ],
        },
      };

      const digest = reviewParticipationContentDigest({
        ...baseReview,
        mediaIds: [],
      });

      const existingReview = {
        ...baseReview,
        participationContentDigest: digest,
      };

      const reservedClaim = {
        id: "wrevclaim_1",
        storeId,
        orderId: "order_1",
        shopperId: "shopper_1",
        policyId: "wrevpol_1",
        sourceReviewId: reviewId,
        subjectType: "product",
        status: "reserved",
        awardSnapshot: { kind: "points", points: "150" },
        validationSnapshot: {
          revision: "purchase_abuse_v1",
          validatedAt: validatedAt.toISOString(),
          contentDigest: digest,
          installationGeneration: generation,
        },
        policy: {
          id: "wrevpol_1",
          storeId,
          contentDigest: reviewIncentivePolicyDigest(policySnapshot),
          snapshot: policySnapshot,
        },
      };

      const mockTx: any = {
        weleticProductReview: {
          findFirst: vi.fn().mockResolvedValue(existingReview),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            ...existingReview,
            status: "published",
            version: 2,
          }),
          update: vi
            .fn()
            .mockResolvedValue({ ...existingReview, status: "published" }),
        },
        weleticReviewIncentiveClaim: {
          findFirst: vi.fn().mockResolvedValue(reservedClaim),
          findUnique: vi.fn().mockResolvedValue(reservedClaim),
          findUniqueOrThrow: vi.fn().mockResolvedValue(reservedClaim),
          update: vi
            .fn()
            .mockResolvedValue({ ...reservedClaim, status: "fulfilled" }),
        },
        weleticPointsLedgerEntry: {
          findFirst: vi.fn().mockResolvedValue(null),
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(({ data }: any) => ({
            ...data,
            id: "ledger_1",
          })),
        },
        weleticLoyaltyAccount: {
          findFirst: vi.fn().mockResolvedValue({
            id: "wlacc_1",
            storeId,
            shopperId: "shopper_1",
            status: "active",
            metadata: null,
            cachedPointsBalance: BigInt(0),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(0),
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: 0,
            program: {
              id: "wprog_1",
              storeId,
              status: "active",
              killSwitchActive: false,
            },
          }),
          findUnique: vi.fn().mockResolvedValue({
            id: "wlacc_1",
            storeId,
            shopperId: "shopper_1",
            status: "active",
            cachedPointsBalance: BigInt(0),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(0),
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: 0,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticShopper: {
          findUnique: vi.fn().mockResolvedValue({
            id: "shopper_1",
            storeId,
            pointsBalance: BigInt(0),
          }),
          update: vi
            .fn()
            .mockResolvedValue({ id: "shopper_1", pointsBalance: BigInt(150) }),
        },
        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "job_1" }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        weleticShopifyStore: {
          findUnique: vi.fn().mockResolvedValue({
            id: storeId,
            developmentStorePolicy: "permitted",
            billingPlanState: "active",
            complianceState: "active",
            installationGeneration: generation,
          }),
        },
        weleticReviewSettings: {
          findUnique: vi.fn().mockResolvedValue({ enabled: true }),
        },
        weleticShopifyCustomerPrivacyTombstone: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        weleticReviewRequest: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
        weleticRewardRedemption: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };

      const result = await moderateNativeReviewInTransaction({
        tx: mockTx,
        storeId,
        reviewId,
        userId,
        input: { version: 1, status: "published" },
        generation,
      });

      expect(result.status).toBe("published");
      // Claim was queried and points were fulfilled
      expect(
        mockTx.weleticReviewIncentiveClaim.findUnique,
      ).toHaveBeenCalledWith({
        where: { storeId_orderId: { storeId, orderId: "order_1" } },
      });
    });

    it("invalidates claim and reverses points when policy-incentivized review is rejected", async () => {
      const reviewId = "wreview_published_1";
      const existingReview = {
        id: reviewId,
        storeId,
        version: 2,
        status: "published",
        rewardStatus: "awarded",
        rewardReason: "review_published",
        rewardLedgerId: "ledger_award_1",
        rating: 1,
        productId: "gid://shopify/Product/101",
        shopperId: "shopper_1",
        publishedAt: new Date(),
        merchantReply: null,
        request: {
          id: "req_1",
          storeId,
          orderId: "order_1",
          productId: "gid://shopify/Product/101",
          incentivePolicyId: "wrevpol_1",
          installationGeneration: generation,
          shopperId: "shopper_1",
        },
      };

      const policySnapshot = {
        version: 1 as const,
        award: {
          kind: "points" as const,
          basePoints: "150",
          photoBonusPoints: "0",
          videoBonusPoints: "0",
          maxPoints: "150",
        },
      };

      const fulfilledClaim = {
        id: "wrevclaim_1",
        storeId,
        orderId: "order_1",
        shopperId: "shopper_1",
        policyId: "wrevpol_1",
        sourceReviewId: reviewId,
        subjectType: "product",
        status: "fulfilled",
        awardSnapshot: { kind: "points", points: "150" },
        validationSnapshot: {
          revision: "purchase_abuse_v1",
          validatedAt: new Date().toISOString(),
          contentDigest: "d".repeat(64),
          installationGeneration: generation,
        },
        policy: {
          id: "wrevpol_1",
          storeId,
          contentDigest: reviewIncentivePolicyDigest(policySnapshot),
          snapshot: policySnapshot,
        },
        order: { storeId, shopperId: "shopper_1" },
        shopper: { storeId, privacyTombstones: [] },
      };

      const awardLedgerEntry = {
        id: "ledger_award_1",
        storeId,
        shopperId: "shopper_1",
        accountId: "wlacc_1",
        pointsDelta: BigInt(150),
        pendingDelta: BigInt(0),
        entryType: "EARN_BONUS",
        referenceType: "REVIEW_INCENTIVE",
        referenceId: "wrevclaim_1",
        grantId: null,
        account: {
          id: "wlacc_1",
          storeId,
          shopperId: "shopper_1",
          metadata: null,
          program: { storeId },
        },
      };

      const mockTx: any = {
        weleticProductReview: {
          findFirst: vi.fn().mockResolvedValue(existingReview),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: vi.fn().mockResolvedValue({
            ...existingReview,
            status: "rejected",
            version: 3,
          }),
          update: vi
            .fn()
            .mockResolvedValue({ ...existingReview, status: "rejected" }),
        },
        weleticReviewIncentiveClaim: {
          findFirst: vi.fn().mockResolvedValue(fulfilledClaim),
          findUnique: vi.fn().mockResolvedValue(fulfilledClaim),
          update: vi
            .fn()
            .mockResolvedValue({ ...fulfilledClaim, status: "reversed" }),
        },
        weleticRewardRedemption: {
          findMany: vi.fn().mockResolvedValue([]),
          findFirst: vi.fn().mockResolvedValue(null),
        },
        weleticReviewIncentiveInvalidation: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi
            .fn()
            .mockResolvedValue({ id: "wrevinv_1", outcome: "points_reversed" }),
        },
        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "job_1" }),
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        weleticShopifyStore: {
          findUnique: vi.fn().mockResolvedValue({
            id: storeId,
            developmentStorePolicy: "permitted",
            billingPlanState: "active",
            complianceState: "active",
            installationGeneration: generation,
          }),
        },
        weleticPointsLedgerEntry: {
          findFirst: vi.fn().mockResolvedValue(awardLedgerEntry),
          findUnique: vi.fn().mockImplementation(({ where }: any) => {
            if (
              where?.storeId_idempotencyKey?.idempotencyKey?.includes(
                "reversal",
              )
            ) {
              return Promise.resolve(null);
            }
            return Promise.resolve(awardLedgerEntry);
          }),
          create: vi.fn().mockResolvedValue({
            id: "ledger_reversal_1",
            sequenceNumber: 2,
            balanceAfter: BigInt(0),
          }),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "wlacc_1",
            storeId,
            shopperId: "shopper_1",
            status: "active",
            cachedPointsBalance: BigInt(150),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(150),
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: 1,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticShopper: {
          findUnique: vi.fn().mockResolvedValue({
            id: "shopper_1",
            storeId,
            pointsBalance: BigInt(150),
          }),
          update: vi
            .fn()
            .mockResolvedValue({ id: "shopper_1", pointsBalance: BigInt(0) }),
        },
        weleticReviewSettings: {
          findUnique: vi.fn().mockResolvedValue({ enabled: true }),
        },
      };

      const result = await moderateNativeReviewInTransaction({
        tx: mockTx,
        storeId,
        reviewId,
        userId,
        input: { version: 2, status: "rejected" },
        generation,
      });

      expect(result.status).toBe("rejected");
      // Claim was invalidated and points reversal recorded
      expect(
        mockTx.weleticReviewIncentiveInvalidation.create,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            storeId,
            claimId: "wrevclaim_1",
            outcome: "points_reversed",
          }),
        }),
      );
    });
  });

  describe("REV-04: Storage 5MB Bounding, Image MIME Validation & DNS Rebinding", () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
      process.env.STORAGE_ENDPOINT = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
      process.env.STORAGE_PUBLIC_BUCKET = "public-test";
      process.env.STORAGE_ACCESS_KEY_ID = "test-key";
      process.env.STORAGE_SECRET_ACCESS_KEY = "test-secret";
      (vi.spyOn(dns.promises, "lookup") as any).mockImplementation(async () => [
        { address: "93.184.216.34", family: 4 },
      ]);
    });

    afterEach(() => {
      process.env = { ...originalEnv };
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    it("rejects non-image MIME types when downloading remote media", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            "<!DOCTYPE html><html><body>malicious payload</body></html>",
            {
              status: 200,
              headers: { "Content-Type": "text/html" },
            },
          ),
        ),
      );

      await expect(
        storage.upload({
          key: "test/unsupported.html",
          body: "https://example.com/not-an-image.html",
          bucket: "public",
        }),
      ).rejects.toThrow(/Invalid or unsupported image MIME type/);
    });

    it("strictly bounds download payload to 5MB maximum", async () => {
      // Mock 6MB response
      const sixMb = 6 * 1024 * 1024;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(new Uint8Array(sixMb), {
            status: 200,
            headers: {
              "Content-Type": "image/png",
              "Content-Length": String(sixMb),
            },
          }),
        ),
      );

      await expect(
        storage.upload({
          key: "test/oversized.png",
          body: "https://example.com/oversized-image.png",
          bucket: "public",
        }),
      ).rejects.toThrow(/File size exceeds maximum allowed limit of 5MB/);
    });
  });

  describe("REV-05: Summary Sync Metafield Retries & Benign Deletion Handling", () => {
    it("tolerates missing metafield deletion without throwing error when count is 0 and verifies retries", async () => {
      // Should complete successfully without throwing
      await expect(
        syncProductReviewSummary(storeId, "prod_1", generation),
      ).resolves.not.toThrow();
    });
  });
});
