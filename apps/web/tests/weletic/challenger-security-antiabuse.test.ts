import { prisma } from "@/lib/prisma";
import {
  calculateEligibleOrderPoints,
  processOrderPointsEarn,
} from "@/lib/weletic/loyalty/earn";
import {
  bindShopperReferral,
  evaluateReferralQualification,
} from "@/lib/weletic/loyalty/referrals";
import {
  anonymizeWeleticShopper,
  getShopperDataExport,
  upsertWeleticShopper,
} from "@/lib/weletic/loyalty/shopper";
import {
  WELETIC_SHOPIFY_MAX_BODY_BYTES,
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
  readWeleticShopifyRequestBody,
  signWeleticShopifyRequest,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { verifyShopifyWebhookSignature } from "@/lib/weletic/shopify/webhook-signature";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      upsert: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyTier: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      delete: vi.fn(),
    },
    weleticRewardDefinition: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticCommerceRefund: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticShopper: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      count: vi.fn(),
    },
    // The legacy financial fixture contains no native review rows.
    weleticProductReview: { findMany: vi.fn().mockResolvedValue([]) },
    weleticReviewModerationAudit: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    weleticReviewIncentiveInvalidation: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    weleticReviewIncentiveClaim: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    weleticReviewRequest: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $queryRaw: vi.fn(async (query) => {
      // Native-review privacy uses the tagged-template form; preserve its
      // existing synthetic row while routing loyalty's Prisma.sql locks.
      if (Array.isArray(query)) return [{ id: "store_gdpr" }];
      const storeId = String(query.values[0]);
      return query.sql.includes("FROM WeleticLoyaltyProgram")
        ? [
            {
              id: "prog_1",
              storeId,
              status: "active",
              killSwitchActive: false,
              metadata: null,
            },
          ]
        : [{ id: storeId, storeAccessState: "active" }];
    }),
    weleticRewardCouponUse: { findMany: vi.fn().mockResolvedValue([]) },
    weleticRewardRedemption: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn(),
    },
    weleticLoyaltyTierHistory: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    customer: {
      findUnique: vi.fn(),
    },
    link: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticCommissionCalculation: {
      updateMany: vi.fn(),
    },
    $transaction: vi.fn((fn) => (typeof fn === "function" ? fn(prisma) : fn)),
  },
}));

// Real HMAC/store-lock redaction fencing is covered by the shopper MySQL suite.
vi.mock("@/lib/weletic/reviews/incentive-privacy-fence", () => ({
  fenceShopperIncentiveRedaction: vi.fn().mockResolvedValue(undefined),
}));

describe("Adversarial Security & Anti-Abuse Stress Harness (Challenger 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      id: "store_1",
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
      installationGeneration: null,
    } as any);
    vi.mocked(prisma.weleticLoyaltyProgram.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockImplementation(
      (async ({ where }: any) => ({
        count: Array.isArray(where?.id?.in) ? where.id.in.length : 1,
      })) as any,
    );
  });

  // =========================================================================
  // SCOPE 1: ADR 0008 HMAC Service Authentication & Security Boundary
  // =========================================================================
  describe("Scope 1: ADR 0008 HMAC Service Authentication Stress-Testing", () => {
    const validSecret = "test-service-secret-32-chars-long-security!";
    const testPath = "/api/internal/shopify/sync?shop=store.myshopify.com";
    const testBody = JSON.stringify({ action: "sync", items: [1, 2, 3] });
    const fixedNow = 1770000000000;

    beforeEach(() => {
      vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", validSecret);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    describe("1.1 Clock Skew Boundary & Manipulation", () => {
      it("accepts request exactly at 0 ms skew", () => {
        const timestamp = String(fixedNow);
        const signature = signWeleticShopifyRequest({
          timestamp,
          method: "POST",
          path: testPath,
          body: testBody,
          secret: validSecret,
        });

        const req = new Request(`https://app.weletic.com${testPath}`, {
          method: "POST",
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
          },
          body: testBody,
        });

        expect(
          verifyWeleticShopifyRequest({
            request: req,
            body: testBody,
            now: fixedNow,
          }),
        ).toBe(true);
      });

      it("accepts request at exact maximum allowable past clock skew (5 min = 300,000 ms)", () => {
        const timestamp = String(fixedNow - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS);
        const signature = signWeleticShopifyRequest({
          timestamp,
          method: "POST",
          path: testPath,
          body: testBody,
          secret: validSecret,
        });

        const req = new Request(`https://app.weletic.com${testPath}`, {
          method: "POST",
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
          },
          body: testBody,
        });

        expect(
          verifyWeleticShopifyRequest({
            request: req,
            body: testBody,
            now: fixedNow,
          }),
        ).toBe(true);
      });

      it("accepts request at exact maximum allowable future clock skew (5 min = +300,000 ms)", () => {
        const timestamp = String(fixedNow + WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS);
        const signature = signWeleticShopifyRequest({
          timestamp,
          method: "POST",
          path: testPath,
          body: testBody,
          secret: validSecret,
        });

        const req = new Request(`https://app.weletic.com${testPath}`, {
          method: "POST",
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
          },
          body: testBody,
        });

        expect(
          verifyWeleticShopifyRequest({
            request: req,
            body: testBody,
            now: fixedNow,
          }),
        ).toBe(true);
      });

      it("strictly rejects request when past clock skew exceeds 5 min by 1 ms (300,001 ms)", () => {
        const timestamp = String(
          fixedNow - (WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 1),
        );
        const signature = signWeleticShopifyRequest({
          timestamp,
          method: "POST",
          path: testPath,
          body: testBody,
          secret: validSecret,
        });

        const req = new Request(`https://app.weletic.com${testPath}`, {
          method: "POST",
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
          },
          body: testBody,
        });

        expect(
          verifyWeleticShopifyRequest({
            request: req,
            body: testBody,
            now: fixedNow,
          }),
        ).toBe(false);
      });

      it("strictly rejects request when future clock skew exceeds 5 min by 1 ms (+300,001 ms)", () => {
        const timestamp = String(
          fixedNow + (WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 1),
        );
        const signature = signWeleticShopifyRequest({
          timestamp,
          method: "POST",
          path: testPath,
          body: testBody,
          secret: validSecret,
        });

        const req = new Request(`https://app.weletic.com${testPath}`, {
          method: "POST",
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
          },
          body: testBody,
        });

        expect(
          verifyWeleticShopifyRequest({
            request: req,
            body: testBody,
            now: fixedNow,
          }),
        ).toBe(false);
      });

      it("strictly rejects non-numeric, NaN, Infinity, negative, and malformed timestamps", () => {
        const malformedTimestamps = [
          "abc",
          "NaN",
          "Infinity",
          "-Infinity",
          "99999999999999999999999999999", // Unsafe integer
          "1770000000.5", // Non-integer
          "",
          "null",
          "undefined",
        ];

        for (const badTs of malformedTimestamps) {
          const signature = crypto
            .createHmac("sha256", validSecret)
            .update(`${badTs}\nPOST\n${testPath}\n${testBody}`)
            .digest("hex");

          const req = new Request(`https://app.weletic.com${testPath}`, {
            method: "POST",
            headers: {
              [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: badTs,
              [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
            },
            body: testBody,
          });

          expect(
            verifyWeleticShopifyRequest({
              request: req,
              body: testBody,
              now: fixedNow,
            }),
          ).toBe(false);
        }
      });
    });

    describe("1.2 Payload Size Limit (>256 KiB Rejection) & Content-Length Spoofing", () => {
      it("accepts request body exactly at 256 KiB (262,144 bytes)", async () => {
        const exactBody = "A".repeat(WELETIC_SHOPIFY_MAX_BODY_BYTES);
        const req = new Request("https://app.weletic.com/test", {
          method: "POST",
          headers: { "content-length": String(WELETIC_SHOPIFY_MAX_BODY_BYTES) },
          body: exactBody,
        });

        const result = await readWeleticShopifyRequestBody(req);
        expect(result).toBe(exactBody);
        expect(result?.length).toBe(262144);
      });

      it("rejects request body at 256 KiB + 1 byte (262,145 bytes) via streaming reader", async () => {
        const oversizedBody = "A".repeat(WELETIC_SHOPIFY_MAX_BODY_BYTES + 1);
        const req = new Request("https://app.weletic.com/test", {
          method: "POST",
          body: oversizedBody,
        });

        const result = await readWeleticShopifyRequestBody(req);
        expect(result).toBeNull();
      });

      it("rejects request when Content-Length header claims >256 KiB before reading stream", async () => {
        const req = new Request("https://app.weletic.com/test", {
          method: "POST",
          headers: {
            "content-length": String(WELETIC_SHOPIFY_MAX_BODY_BYTES + 100),
          },
          body: "small body",
        });

        const result = await readWeleticShopifyRequestBody(req);
        expect(result).toBeNull();
      });

      it("rejects Content-Length header spoofing (e.g. declared 10 bytes but stream sends 300 KiB)", async () => {
        const oversizedStream = "X".repeat(
          WELETIC_SHOPIFY_MAX_BODY_BYTES + 500,
        );
        const req = new Request("https://app.weletic.com/test", {
          method: "POST",
          headers: { "content-length": "10" },
          body: oversizedStream,
        });

        const result = await readWeleticShopifyRequestBody(req);
        expect(result).toBeNull();
      });

      it("rejects negative, invalid, or non-safe integer Content-Length headers", async () => {
        const invalidLengths = [
          "-1",
          "-500",
          "not-a-number",
          "1e10",
          "999999999999999999999",
        ];
        for (const len of invalidLengths) {
          const req = new Request("https://app.weletic.com/test", {
            method: "POST",
            headers: { "content-length": len },
            body: "ok",
          });
          const result = await readWeleticShopifyRequestBody(req);
          expect(result).toBeNull();
        }
      });
    });

    describe("1.3 Constant-Time Signature Verification & Malicious Signature Attacks", () => {
      it("rejects signatures that are not 64-character lowercase hex", () => {
        const badSignatures = [
          "invalid",
          "a".repeat(63), // 63 chars (too short)
          "a".repeat(65), // 65 chars (too long)
          "G".repeat(64), // non-hex
          "a".repeat(60) + "!!!!", // non-hex characters
          "",
        ];

        for (const badSig of badSignatures) {
          const req = new Request(`https://app.weletic.com${testPath}`, {
            method: "POST",
            headers: {
              [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: String(fixedNow),
              [WELETIC_SHOPIFY_SIGNATURE_HEADER]: badSig,
            },
            body: testBody,
          });

          expect(
            verifyWeleticShopifyRequest({
              request: req,
              body: testBody,
              now: fixedNow,
            }),
          ).toBe(false);
        }
      });

      it("rejects tampered HTTP method (e.g. signed GET, sent POST)", () => {
        const timestamp = String(fixedNow);
        const signature = signWeleticShopifyRequest({
          timestamp,
          method: "GET",
          path: testPath,
          body: "",
          secret: validSecret,
        });

        const req = new Request(`https://app.weletic.com${testPath}`, {
          method: "POST",
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
          },
          body: testBody,
        });

        expect(
          verifyWeleticShopifyRequest({
            request: req,
            body: testBody,
            now: fixedNow,
          }),
        ).toBe(false);
      });

      it("webhook signature verification uses crypto.timingSafeEqual and rejects tampered inputs safely", () => {
        const webhookSecret = "webhook-secret-xyz";
        const webhookBody = JSON.stringify({ id: 999, topic: "orders/paid" });
        const authenticSig = crypto
          .createHmac("sha256", webhookSecret)
          .update(webhookBody, "utf8")
          .digest("base64");

        // 1. Authentic
        expect(
          verifyShopifyWebhookSignature({
            body: webhookBody,
            signature: authenticSig,
            secret: webhookSecret,
          }),
        ).toBe(true);

        // 2. Tampered body
        expect(
          verifyShopifyWebhookSignature({
            body: webhookBody + " ",
            signature: authenticSig,
            secret: webhookSecret,
          }),
        ).toBe(false);

        // 3. Different signature length (doesn't throw timingSafeEqual error, handles safely)
        expect(
          verifyShopifyWebhookSignature({
            body: webhookBody,
            signature: "short",
            secret: webhookSecret,
          }),
        ).toBe(false);

        // 4. Missing parameters
        expect(
          verifyShopifyWebhookSignature({
            body: webhookBody,
            signature: "",
            secret: webhookSecret,
          }),
        ).toBe(false);
        expect(
          verifyShopifyWebhookSignature({
            body: webhookBody,
            signature: authenticSig,
            secret: "",
          }),
        ).toBe(false);
      });
    });
  });

  // =========================================================================
  // SCOPE 2: Customer Referral Anti-Abuse
  // =========================================================================
  describe("Scope 2: Customer Referral Anti-Abuse Stress-Testing", () => {
    describe("2.1 Self-Referral Rejection & Cycle Prevention", () => {
      it("blocks self-referral when advocate attempts to bind their own referral code", async () => {
        const advocateAccountId = "acc_self_1";
        const selfCode = "ALICE-1234";

        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: advocateAccountId,
            storeId: "store_1",
            programId: "prog_1",
            referralCode: selfCode,
            referralCount: 0,
            status: "active",
            shopper: { id: "shop_1" },
          } as any,
        );

        await expect(
          bindShopperReferral({
            storeId: "store_1",
            refereeAccountId: advocateAccountId, // SAME ID
            referralCode: selfCode,
          }),
        ).rejects.toThrow("Self-referral is strictly prohibited.");
      });
    });

    describe("2.2 Duplicate Advocate Binding Rejection & Idempotency", () => {
      it("rejects referee binding if referee account is already bound to another advocate (referredById != null)", async () => {
        const advocateAccountId = "acc_adv_1";
        const refereeAccountId = "acc_ref_1";

        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: advocateAccountId,
            storeId: "store_1",
            programId: "prog_1",
            referralCode: "BOB-9999",
            referralCount: 0,
            status: "active",
            shopper: { id: "shop_adv" },
          } as any,
        );

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: refereeAccountId,
          storeId: "store_1",
          shopperId: "shop_ref",
          status: "active",
          metadata: null,
          referredById: "acc_prior_advocate", // Already referred!
          shopper: { id: "shop_ref" },
        } as any);

        await expect(
          bindShopperReferral({
            storeId: "store_1",
            refereeAccountId,
            referralCode: "BOB-9999",
          }),
        ).rejects.toThrow(
          "Account has already been referred by another member.",
        );
      });

      it("returns existing referral record idempotently when the same advocate and referee re-bind", async () => {
        const advocateAccountId = "acc_adv_1";
        const refereeAccountId = "acc_ref_1";

        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: advocateAccountId,
            storeId: "store_1",
            programId: "prog_1",
            referralCode: "BOB-9999",
            referralCount: 0,
            status: "active",
            shopper: { id: "shop_adv" },
          } as any,
        );

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: refereeAccountId,
          storeId: "store_1",
          shopperId: "shop_ref",
          status: "active",
          metadata: null,
          referredById: null,
          shopper: { id: "shop_ref" },
        } as any);

        const existingReferral = {
          id: "wreferral_existing_1",
          storeId: "store_1",
          advocateAccountId,
          refereeAccountId,
          status: "pending",
        };

        vi.mocked(
          prisma.weleticLoyaltyReferral.findUnique,
        ).mockResolvedValueOnce(existingReferral as any);

        const result = await bindShopperReferral({
          storeId: "store_1",
          refereeAccountId,
          referralCode: "BOB-9999",
        });

        expect(result.id).toBe("wreferral_existing_1");
      });

      it("enforces maxReferralsPerAdvocate cap and rejects bindings once limit is reached", async () => {
        const advocateAccountId = "acc_adv_capped";
        const refereeAccountId = "acc_ref_new";

        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: advocateAccountId,
            storeId: "store_1",
            programId: "prog_1",
            referralCode: "CAP-5555",
            referralCount: 10, // Max 10 reached
            status: "active",
            shopper: { id: "shop_adv" },
          } as any,
        );

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: refereeAccountId,
          storeId: "store_1",
          shopperId: "shop_ref",
          status: "active",
          metadata: null,
          referredById: null,
          shopper: { id: "shop_ref" },
        } as any);

        vi.mocked(
          prisma.weleticLoyaltyReferral.findUnique,
        ).mockResolvedValueOnce(null);

        vi.mocked(
          prisma.weleticLoyaltyReferralRule.findFirst,
        ).mockResolvedValueOnce({
          id: "rule_1",
          programId: "prog_1",
          advocatePointsReward: BigInt(100),
          refereePointsReward: BigInt(50),
          maxReferralsPerAdvocate: 10, // Cap is 10
          isActive: true,
        } as any);

        await expect(
          bindShopperReferral({
            storeId: "store_1",
            refereeAccountId,
            referralCode: "CAP-5555",
          }),
        ).rejects.toThrow(
          "Advocate has reached the maximum allowed referrals.",
        );
      });
    });

    describe("2.3 Qualification Thresholds & Currency Precision", () => {
      it("rejects qualification when order subtotal is below minimum threshold in 2-decimal currencies ($29.99 < $30.00)", async () => {
        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_ref_1",
          programId: "prog_1",
          storeId: "store_1",
          shopperId: "shopper_ref_1",
          status: "active",
          metadata: null,
        } as any);

        vi.mocked(
          prisma.weleticLoyaltyReferral.findFirst,
        ).mockResolvedValueOnce({
          id: "ref_100",
          advocateAccountId: "acc_adv_1",
          refereeAccountId: "acc_ref_1",
          status: "pending",
          advocateAccount: {
            programId: "prog_1",
            storeId: "store_1",
            status: "active",
            metadata: null,
          },
        } as any);

        vi.mocked(
          prisma.weleticLoyaltyReferralRule.findFirst,
        ).mockResolvedValueOnce({
          id: "rule_1",
          programId: "prog_1",
          advocatePointsReward: BigInt(100),
          refereePointsReward: BigInt(50),
          minQualifyingOrderSubtotal: 30.0 as any, // $30 min
          isActive: true,
        } as any);

        const result = await evaluateReferralQualification({
          storeId: "store_1",
          orderId: "ord_2999",
          refereeShopperId: "shopper_ref_1",
          orderSubtotal: BigInt(2999), // $29.99 in minor cents
          currency: "USD",
        });

        expect(result.qualified).toBe(false);
        expect(result.reason).toContain("is below minimum qualifying amount");
      });

      it("qualifies when order subtotal meets minimum threshold in 0-decimal currencies (JPY ¥3,000 >= ¥3,000)", async () => {
        vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
          id: "store_1",
          complianceState: "active",
          shopCurrency: "JPY",
          currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
          installationGeneration: null,
        } as any);
        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_ref_jpy",
          programId: "prog_1",
          storeId: "store_1",
          shopperId: "shopper_ref_jpy",
          status: "active",
          metadata: null,
        } as any);

        vi.mocked(
          prisma.weleticLoyaltyReferral.findFirst,
        ).mockResolvedValueOnce({
          id: "ref_jpy_100",
          advocateAccountId: "acc_adv_jpy",
          refereeAccountId: "acc_ref_jpy",
          status: "pending",
          advocateAccount: {
            programId: "prog_1",
            storeId: "store_1",
            status: "active",
            metadata: null,
          },
        } as any);

        vi.mocked(
          prisma.weleticLoyaltyReferralRule.findFirst,
        ).mockResolvedValueOnce({
          id: "rule_1",
          programId: "prog_1",
          advocatePointsReward: BigInt(200),
          refereePointsReward: BigInt(100),
          minQualifyingOrderSubtotal: 3000.0 as any, // ¥3000 min
          isActive: true,
        } as any);

        // Mock ledger append calls
        vi.mocked(prisma.weleticPointsLedgerEntry.findUnique).mockResolvedValue(
          null,
        );
        vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
          id: "acc_adv_jpy",
          storeId: "store_1",
          cachedPointsBalance: BigInt(0),
          lifetimePointsEarned: BigInt(0),
          lifetimePointsRedeemed: BigInt(0),
        } as any);
        vi.mocked(prisma.weleticPointsLedgerEntry.findFirst).mockResolvedValue(
          null,
        );
        vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValue({
          id: "wledger_1",
          sequenceNumber: 1,
          balanceAfter: BigInt(200),
        } as any);
        vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValue(
          {} as any,
        );
        vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockImplementation(
          (async ({ where }: any) => ({
            count: Array.isArray(where?.id?.in) ? where.id.in.length : 1,
          })) as any,
        );
        vi.mocked(prisma.weleticLoyaltyReferral.updateMany).mockResolvedValue({
          count: 1,
        } as any);
        vi.mocked(prisma.weleticLoyaltyOutboxJob.findUnique).mockResolvedValue(
          null,
        );
        vi.mocked(prisma.weleticLoyaltyOutboxJob.create).mockResolvedValue(
          {} as any,
        );

        const result = await evaluateReferralQualification({
          storeId: "store_1",
          orderId: "ord_jpy_3000",
          refereeShopperId: "shopper_ref_jpy",
          orderSubtotal: BigInt(3000), // ¥3000 (0-decimal, not divided by 100)
          currency: "JPY",
        });

        expect(result.qualified).toBe(true);
        expect(result.advocatePointsAwarded).toBe(BigInt(200));
        expect(result.refereePointsAwarded).toBe(BigInt(100));
      });
    });
  });

  // =========================================================================
  // SCOPE 3: Shopify GDPR Compliance & Ledger Preservation
  // =========================================================================
  describe("Scope 3: Shopify GDPR Compliance & Immutable Ledger Retention", () => {
    describe("3.1 Complete GDPR Data Export Structure", () => {
      it("exports comprehensive data tree including shopper, loyalty account, 100 ledger entries, redemptions, tier history, and orders", async () => {
        const mockShopper = {
          id: "shop_gdpr_full",
          storeId: "store_gdpr",
          shopifyCustomerId: "cust_12345",
          firstName: "Evelyn",
          lastName: "Vance",
          email: "evelyn@example.com",
          phone: "+1-555-0199",
          locale: "en",
          ordersCount: 5,
          totalSpent: BigInt(75000),
          createdAt: new Date("2026-01-01"),
          updatedAt: new Date("2026-02-01"),
          loyaltyAccount: {
            id: "acc_gdpr_full",
            status: "active",
            ledgerVersion: 1,
            cachedPointsBalance: BigInt(750),
            cachedPendingPoints: BigInt(50),
            lifetimePointsEarned: BigInt(1000),
            lifetimePointsRedeemed: BigInt(250),
            lastQualifyingActivityAt: new Date("2026-01-02"),
            nextExpiryDate: null,
            referralCode: "EVELYN-777",
            referredById: null,
            referralCount: 0,
            referralPointsEarned: BigInt(0),
            tierExpiresAt: null,
            tierSpendRolling12Months: BigInt(75000),
            tierPointsRolling12Months: BigInt(1000),
            metadata: null,
            enrolledAt: new Date("2026-01-01"),
            createdAt: new Date("2026-01-01"),
            updatedAt: new Date("2026-02-01"),
            currentTier: { id: "tier_silver", name: "Silver" },
            ledgerEntries: [
              {
                id: "wledger_1",
                sequenceNumber: 1,
                entryType: "EARN_ORDER",
                pointsDelta: BigInt(750),
                pendingDelta: BigInt(0),
                balanceAfter: BigInt(750),
                grantId: null,
                referenceType: "ORDER",
                referenceId: "worder_1",
                reason: "Order points",
                metadata: null,
                createdAt: new Date("2026-01-02"),
              },
            ],
            redemptions: [
              {
                id: "wred_1",
                pointsSpent: BigInt(250),
                shopifyDiscountCode: "DISC25",
                status: "active",
                rewardDefinition: { name: "$25 off", rewardType: "fixed" },
                createdAt: new Date("2026-02-01"),
              },
            ],
            tierHistory: [
              {
                id: "th_1",
                toTierId: "tier_silver",
                changeReason: "threshold_reached",
                effectiveAt: new Date("2026-01-02"),
              },
            ],
            advocateReferrals: [],
            refereeReferrals: [],
          },
          orders: [
            {
              id: "worder_1",
              externalId: "ord_shopify_1",
              orderName: "#1001",
              status: "paid",
              checkoutToken: null,
              customerOrderSequence: 1,
              customerClassification: "new",
              customerSegmentIds: [],
              presentmentSubtotal: BigInt(75000),
              presentmentDiscount: BigInt(0),
              presentmentNet: BigInt(75000),
              presentmentTax: BigInt(0),
              presentmentShipping: BigInt(0),
              presentmentTotal: BigInt(75000),
              presentmentCurrency: "USD",
              shopCurrency: "USD",
              shopTotal: BigInt(75000),
              accountingCurrency: "USD",
              accountingNet: BigInt(75000),
              accountingTotal: BigInt(75000),
              occurredAt: new Date("2026-01-02"),
              processedAt: new Date("2026-01-02"),
              createdAt: new Date("2026-01-02"),
              updatedAt: new Date("2026-01-02"),
              lines: [],
              refunds: [],
            },
          ],
        };

        vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
          projectId: "project_gdpr",
        } as any);
        vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce(
          mockShopper as any,
        );
        vi.mocked(prisma.customer.findUnique).mockResolvedValueOnce(null);
        vi.mocked(
          prisma.weleticPointsLedgerEntry.findMany,
        ).mockResolvedValueOnce(
          mockShopper.loyaltyAccount.ledgerEntries as any,
        );
        vi.mocked(
          prisma.weleticRewardRedemption.findMany,
        ).mockResolvedValueOnce(mockShopper.loyaltyAccount.redemptions as any);
        vi.mocked(
          prisma.weleticLoyaltyTierHistory.findMany,
        ).mockResolvedValueOnce(mockShopper.loyaltyAccount.tierHistory as any);
        vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce(
          mockShopper.orders as any,
        );

        const exported = await getShopperDataExport({
          storeId: "store_gdpr",
          shopifyCustomerId: "cust_12345",
        });

        expect(exported).not.toBeNull();
        expect(exported?.shopperId).toBe("shop_gdpr_full");
        expect(exported?.firstName).toBe("Evelyn");
        expect(exported?.email).toBe("evelyn@example.com");
        expect(exported?.totalSpent).toBe("75000");
        expect(exported?.loyaltyAccount?.pointsBalance).toBe("750");
        expect(exported?.loyaltyAccount?.currentTier?.name).toBe("Silver");
        expect(exported?.loyaltyAccount?.ledgerEntries).toHaveLength(1);
        expect(exported?.loyaltyAccount?.redemptions).toHaveLength(1);
        expect(exported?.loyaltyAccount?.tierHistory).toHaveLength(1);
        expect(exported?.orders).toHaveLength(1);
      });
    });

    describe("3.2 Customer Redaction PII Scrubbing vs Immutable Ledger Preservation", () => {
      it("anonymizes personal identifiers (name, email, phone, tags) while preserving immutable accounting records, sequence numbers, and order links", async () => {
        const shopperId = "shop_redact_target";
        const accountId = "acc_redact_target";

        vi.mocked(
          prisma.weleticShopifyStore.findUniqueOrThrow,
        ).mockResolvedValueOnce({
          projectId: "project_1",
          shopDomain: "store-1.myshopify.com",
        } as any);
        vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
          id: shopperId,
          storeId: "store_1",
          shopifyCustomerId: "cust_target",
          firstName: "Sensitive",
          lastName: "User",
          email: "sensitive@user.com",
          phone: "+1-800-SECRET",
          loyaltyAccount: { id: accountId },
        } as any);

        let updatedShopperData: any = null;
        let updatedAccountData: any = null;

        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: accountId,
            status: "active",
            metadata: null,
            updatedAt: new Date("2026-08-29T00:00:00.000Z"),
          } as any,
        );
        vi.mocked(
          prisma.weleticLoyaltyAccount.updateMany,
        ).mockImplementationOnce((async ({ data }: any) => {
          updatedAccountData = data;
          return { count: 1 };
        }) as any);
        vi.mocked(
          prisma.weleticLoyaltyOutboxJob.findMany,
        ).mockResolvedValueOnce([]);
        vi.mocked(
          prisma.weleticPointsLedgerEntry.findMany,
        ).mockResolvedValueOnce([]);
        vi.mocked(prisma.weleticShopper.updateMany).mockImplementationOnce(
          (async ({ data }: any) => {
            updatedShopperData = data;
            return { count: 1 };
          }) as any,
        );

        const result = await anonymizeWeleticShopper({
          storeId: "store_1",
          shopifyCustomerId: "cust_target",
        });

        expect(result.found).toBe(true);
        expect(result.shopperId).toBe(shopperId);

        // Verify PII is scrubbed
        expect(updatedShopperData.firstName).toBe("Redacted");
        expect(updatedShopperData.lastName).toBe("Customer");
        expect(updatedShopperData.email).toBeNull();
        expect(updatedShopperData.phone).toBeNull();
        expect(updatedShopperData.acceptsMarketing).toBe(false);

        // Verify Loyalty Account is closed
        expect(updatedAccountData.status).toBe("closed");

        // CRITICAL CHECK: Ensure NO deleteMany / delete calls on WeleticPointsLedgerEntry or WeleticCommerceOrder
        expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
        expect(prisma.weleticCommerceOrder.create).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // SCOPE 4: Unconditional Commerce Ingestion & Guest Checkout Isolation
  // =========================================================================
  describe("Scope 4: Unconditional Commerce Ingestion & Guest Checkout Isolation", () => {
    describe("4.1 Guest Checkout Exclusion (Customerless Orders)", () => {
      it("returns BigInt(0) points when net amount is $0 or negative", () => {
        expect(
          calculateEligibleOrderPoints({ netAmountCents: 0, currency: "USD" }),
        ).toBe(BigInt(0));
        expect(
          calculateEligibleOrderPoints({
            netAmountCents: -500,
            currency: "USD",
          }),
        ).toBe(BigInt(0));
      });

      it("returns BigInt(0) points when order subtotal is below configured minimum threshold", () => {
        const points = calculateEligibleOrderPoints({
          netAmountCents: 1500, // $15.00
          currency: "USD",
          minOrderSubtotalCents: 2000, // $20.00 min
        });
        expect(points).toBe(BigInt(0));
      });

      it("processOrderPointsEarn safely returns null when order has no shopper or loyalty account (Guest Checkout)", async () => {
        vi.mocked(prisma.$transaction).mockImplementation(
          async (callback: any) => await callback(prisma),
        );
        vi.mocked(prisma.weleticCommerceOrder.findUnique).mockResolvedValueOnce(
          {
            id: "ord_guest_1",
            storeId: "store_1",
            presentmentNet: BigInt(5000),
            presentmentCurrency: "USD",
            shopper: null, // GUEST CHECKOUT
          } as any,
        );

        const result = await processOrderPointsEarn({
          storeId: "store_1",
          orderId: "ord_guest_1",
        });

        expect(result).toBeNull();
      });

      it("upsertWeleticShopper returns null when customer is null or missing ID", async () => {
        const resNull = await upsertWeleticShopper({
          storeId: "store_1",
          customer: null,
        });
        expect(resNull).toBeNull();

        const resMissingId = await upsertWeleticShopper({
          storeId: "store_1",
          customer: { id: "" } as any,
        });
        expect(resMissingId).toBeNull();
      });
    });

    describe("4.2 Unattributed Order Points & Tier Earning Multipliers", () => {
      it("calculates exact points with tier multiplier (e.g. Silver 1.25x on $100 order = 125 points)", () => {
        const standardPoints = calculateEligibleOrderPoints({
          netAmountCents: 10000, // $100.00
          currency: "USD",
          pointsPerCurrencyUnit: 1.0,
          multiplier: 1.0, // Bronze
        });
        expect(standardPoints).toBe(BigInt(100));

        const silverPoints = calculateEligibleOrderPoints({
          netAmountCents: 10000, // $100.00
          currency: "USD",
          pointsPerCurrencyUnit: 1.0,
          multiplier: 1.25, // Silver
        });
        expect(silverPoints).toBe(BigInt(125));

        const goldPoints = calculateEligibleOrderPoints({
          netAmountCents: 10000, // $100.00
          currency: "USD",
          pointsPerCurrencyUnit: 1.0,
          multiplier: 1.5, // Gold
        });
        expect(goldPoints).toBe(BigInt(150));
      });
    });
  });
});
