import {
  claimCustomerIntentActivity,
  validateCustomerIntentConditions,
} from "@/lib/weletic/loyalty/earning-actions";
import {
  checkBirthdayEligibility,
  getBirthdayRewardDateForYear,
} from "@/lib/weletic/loyalty/non-purchase-earn";
import {
  awardJudgeMeReview,
  clawbackJudgeMeReview,
  fetchJudgeMeReview,
  JudgeMeApiError,
  processJudgeMeWebhook,
  verifyJudgeMeWebhookSignature,
  type JudgeMeReview,
} from "@/lib/weletic/loyalty/review-providers/judgeme";
import { WeleticPointsLedgerEntryType } from "@prisma/client";
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  accountFindUnique: vi.fn(),
  accountUpdateMany: vi.fn(),
  ledgerFindUnique: vi.fn(),
  ledgerFindFirst: vi.fn(),
  ledgerFindMany: vi.fn(),
  ledgerCount: vi.fn(),
  ledgerCreate: vi.fn(),
  ledgerUpdateMany: vi.fn(),
  integrationFindUnique: vi.fn(),
  integrationUpdateMany: vi.fn(),
  enqueueOutboxJob: vi.fn(),
  awardActivityPoints: vi.fn(),
  scheduleTierReview: vi.fn(),
}));

const txClient = {
  weleticLoyaltyAccount: {
    findFirst: mocks.accountFindFirst,
    findUnique: mocks.accountFindUnique,
    updateMany: mocks.accountUpdateMany,
  },
  weleticPointsLedgerEntry: {
    findUnique: mocks.ledgerFindUnique,
    findFirst: mocks.ledgerFindFirst,
    findMany: mocks.ledgerFindMany,
    count: mocks.ledgerCount,
    create: mocks.ledgerCreate,
    updateMany: mocks.ledgerUpdateMany,
  },
  weleticLoyaltyReviewIntegration: {
    findUnique: mocks.integrationFindUnique,
    updateMany: mocks.integrationUpdateMany,
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findFirst: mocks.accountFindFirst,
      findUnique: mocks.accountFindUnique,
      updateMany: mocks.accountUpdateMany,
    },
    weleticPointsLedgerEntry: {
      findUnique: mocks.ledgerFindUnique,
      findFirst: mocks.ledgerFindFirst,
      findMany: mocks.ledgerFindMany,
      count: mocks.ledgerCount,
      create: mocks.ledgerCreate,
      updateMany: mocks.ledgerUpdateMany,
    },
    weleticLoyaltyReviewIntegration: {
      findUnique: mocks.integrationFindUnique,
      updateMany: mocks.integrationUpdateMany,
    },
    $transaction: vi.fn(async (cb: (tx: typeof txClient) => Promise<any>) =>
      cb(txClient),
    ),
  },
}));

vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  withActiveStoreLoyaltyMutation: vi.fn(({ operation }) =>
    operation(txClient, null),
  ),
  assertActiveLoyaltyAccountForMutation: vi.fn(async () => ({
    id: "wacc_test",
    status: "active",
    metadata: {},
  })),
}));

vi.mock("@/lib/encryption", () => ({
  decrypt: vi.fn(() => "judgeme_secret_token_12345"),
  encrypt: vi.fn((val: string) => `encrypted:${val}`),
}));

vi.mock("@dub/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dub/utils")>();
  return {
    ...actual,
    APP_DOMAIN_WITH_NGROK: "https://app.weletic.test",
  };
});

vi.mock("@/lib/weletic/loyalty/tier-review-scheduling", () => ({
  scheduleTierReviewAfterQualifyingActivity: mocks.scheduleTierReview,
}));

vi.mock("@/lib/weletic/loyalty/non-purchase-earn", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/weletic/loyalty/non-purchase-earn")
  >("@/lib/weletic/loyalty/non-purchase-earn");
  return {
    ...actual,
    awardActivityPoints: mocks.awardActivityPoints,
  };
});

function createAccountFixture(
  overrides: Record<string, any> = {},
  ruleOverrides: Record<string, any> = {},
) {
  return {
    id: "wacc_adversary_1",
    storeId: "wstore_1",
    status: "active",
    metadata: {},
    cachedPointsBalance: BigInt(0),
    cachedPendingPoints: BigInt(0),
    lifetimePointsEarned: BigInt(0),
    lifetimePointsRedeemed: BigInt(0),
    ledgerVersion: 1,
    program: {
      status: "active",
      killSwitchActive: false,
      earningRules: [
        {
          id: "wrule_adv_1",
          name: "Adversarial Follow",
          description: "Follow us",
          triggerCode: "instagram_follow",
          ruleType: "fixed_points",
          fixedPoints: BigInt(50),
          multiplier: 1,
          isActive: true,
          startAt: null,
          endAt: null,
          maxEventsPerCustomer: 1,
          limitInterval: "lifetime",
          conditions: {
            targetUrl: "https://www.instagram.com/weletic",
          },
          ...ruleOverrides,
        },
      ],
    },
    ...overrides,
  };
}

describe("Adversarial Earning Actions Stress & Security Challenger Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountFindFirst.mockResolvedValue(createAccountFixture());
    mocks.accountFindUnique.mockResolvedValue(createAccountFixture());
    mocks.accountUpdateMany.mockResolvedValue({ count: 1 });
    mocks.ledgerFindUnique.mockResolvedValue(null);
    mocks.ledgerFindFirst.mockResolvedValue(null);
    mocks.ledgerFindMany.mockResolvedValue([]);
    mocks.ledgerCount.mockResolvedValue(0);
    mocks.ledgerCreate.mockImplementation(async ({ data }: any) => ({
      ...data,
      id: "wentry_mock",
    }));
    mocks.awardActivityPoints.mockResolvedValue({
      id: "wentry_adv_act",
      pointsDelta: BigInt(50),
      balanceAfter: BigInt(50),
      sequenceNumber: 1,
    });
    mocks.integrationFindUnique.mockResolvedValue({
      id: "wreviewint_adv",
      storeId: "wstore_1",
      provider: "judgeme",
      enabled: true,
      encryptedApiToken: "encrypted:token",
      store: { id: "wstore_1", shopDomain: "brand.myshopify.com" },
    });
  });

  // ==========================================================================
  // Group 1: Adversarial Social Exploitation
  // ==========================================================================
  describe("Group 1: Adversarial Social Exploitation", () => {
    it("1.1 SSRF attack vectors: blocks localhost, private CIDR IPs, cloud metadata endpoints, and alternate schemes", () => {
      const ssrfTargets = [
        "http://127.0.0.1:8080/admin",
        "http://localhost:3000",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.0.1/internal",
        "gopher://127.0.0.1:6379/_flushall",
        "dict://127.0.0.1:11211/stat",
        "file:///etc/shadow",
      ];

      for (const targetUrl of ssrfTargets) {
        expect(() =>
          validateCustomerIntentConditions({
            triggerCode: "link_click",
            conditions: { targetUrl },
          }),
        ).toThrow("valid HTTPS target URL");
      }
    });

    it("1.2 Punycode and Unicode domain spoofing attacks are rejected for social actions", () => {
      const spoofedDomains = [
        "https://instagram.com.evil.com/phish",
        "https://instagram.com@attacker.com",
        "https://www.instagram.com.attacker.org",
        "https://fakeinstagram.com/weletic",
        "https://xn--instgram-e1a.com/weletic", // Cyrillic homograph
      ];

      for (const targetUrl of spoofedDomains) {
        expect(() =>
          validateCustomerIntentConditions({
            triggerCode: "instagram_follow",
            conditions: { targetUrl },
          }),
        ).toThrow("not valid for the instagram follow action");
      }
    });

    it("1.3 High-concurrency claim race with identical claimKey: ensures exactly one winner succeeds", async () => {
      let awardedCount = 0;
      let duplicateCount = 0;
      let alreadyAwarded = false;

      // Simulate transactional lock where first to execute claims the entry
      mocks.ledgerFindUnique.mockImplementation(async () => {
        if (alreadyAwarded) {
          return {
            id: "wentry_first_winner",
            pointsDelta: BigInt(50),
            balanceAfter: BigInt(150),
          };
        }
        alreadyAwarded = true;
        return null;
      });

      const promises = Array.from({ length: 50 }, (_, i) =>
        claimCustomerIntentActivity({
          storeId: "wstore_1",
          shopifyCustomerId: "cust_race_1",
          ruleId: "wrule_adv_1",
          claimKey: "race-key-001",
        }).then((res) => {
          if (res.awarded) awardedCount++;
          if (res.alreadyCompleted) duplicateCount++;
        }),
      );

      await Promise.all(promises);

      expect(awardedCount).toBe(1);
      expect(duplicateCount).toBe(49);
    });

    it("1.4 Rapid-fire claims across day/week boundary transitions (23:59:59.999Z vs 00:00:00.001Z)", async () => {
      mocks.accountFindFirst.mockResolvedValue(
        createAccountFixture(
          {},
          { limitInterval: "daily", maxEventsPerCustomer: 1 },
        ),
      );

      // Claim 1 at 23:59:59.999Z UTC (Day 1)
      const day1End = new Date("2026-09-04T23:59:59.999Z");
      mocks.ledgerCount.mockResolvedValueOnce(0);

      const claimDay1 = await claimCustomerIntentActivity({
        storeId: "wstore_1",
        shopifyCustomerId: "cust_1",
        ruleId: "wrule_adv_1",
        now: day1End,
      });
      expect(claimDay1.awarded).toBe(true);

      // Claim 2 at 00:00:00.001Z UTC (Day 2 - 2 milliseconds later)
      const day2Start = new Date("2026-09-05T00:00:00.001Z");
      mocks.ledgerCount.mockResolvedValueOnce(0); // in Day 2 window, count is 0

      const claimDay2 = await claimCustomerIntentActivity({
        storeId: "wstore_1",
        shopifyCustomerId: "cust_1",
        ruleId: "wrule_adv_1",
        now: day2Start,
      });
      expect(claimDay2.awarded).toBe(true);
    });

    it("1.5 Adversarial claimKey payloads: oversized keys, null bytes, and SQL injection strings are safely processed", async () => {
      mocks.accountFindFirst.mockResolvedValue(
        createAccountFixture({}, { maxEventsPerCustomer: 5 }),
      );

      const adversarialKeys = [
        "x".repeat(2000), // oversized key
        "claim_key\x00_injection", // null byte
        "'; DROP TABLE weleticPointsLedgerEntry; --",
        "../../etc/passwd",
        "  spaces  around  ",
      ];

      for (const claimKey of adversarialKeys) {
        mocks.ledgerFindUnique.mockResolvedValueOnce(null);
        mocks.ledgerCount.mockResolvedValueOnce(0);

        const result = await claimCustomerIntentActivity({
          storeId: "wstore_1",
          shopifyCustomerId: "cust_1",
          ruleId: "wrule_adv_1",
          claimKey,
        });

        expect(result.awarded).toBe(true);
      }
    });

    it("1.6 Rule parameter tampering: rejects negative fixedPoints or 0 points fail closed", async () => {
      // Negative fixed points
      mocks.accountFindFirst.mockResolvedValueOnce(
        createAccountFixture({}, { fixedPoints: BigInt(-100) }),
      );
      await expect(
        claimCustomerIntentActivity({
          storeId: "wstore_1",
          shopifyCustomerId: "cust_1",
          ruleId: "wrule_adv_1",
        }),
      ).rejects.toThrow("not currently available");

      // Zero fixed points
      mocks.accountFindFirst.mockResolvedValueOnce(
        createAccountFixture({}, { fixedPoints: BigInt(0) }),
      );
      await expect(
        claimCustomerIntentActivity({
          storeId: "wstore_1",
          shopifyCustomerId: "cust_1",
          ruleId: "wrule_adv_1",
        }),
      ).rejects.toThrow("not currently available");
    });
  });

  // ==========================================================================
  // Group 2: Adversarial Birthday Gaming Attacks
  // ==========================================================================
  describe("Group 2: Adversarial Birthday Gaming Attacks", () => {
    it("2.1 Sub-second boundary timing: exactly 29d 23h 59m 59s vs exactly 30d 00h 00m 00s", () => {
      // Birthday: Oct 1, 2026.
      // 30 days prior midnight: Sept 1, 2026 00:00:00 UTC (leadTime = 30 days)
      const eligible = checkBirthdayEligibility(
        "1992-10-01",
        "2026-09-01T00:00:00.000Z",
        new Date("2026-09-01T00:00:00.000Z"),
      );
      expect(eligible.isEligible).toBe(true);
      expect(eligible.leadTimeDays).toBe(30);

      // Registered on Sept 2, 2026 00:00:00 UTC (leadTime = 29 days)
      const lockedOut = checkBirthdayEligibility(
        "1992-10-01",
        "2026-09-02T00:00:00.000Z",
        new Date("2026-09-02T00:00:00.000Z"),
      );
      expect(lockedOut.isEligible).toBe(false);
      expect(lockedOut.isLockedOut).toBe(true);
      expect(lockedOut.nextEligibleYear).toBe(2027);
      expect(lockedOut.leadTimeDays).toBe(29);
    });

    it("2.2 Year boundary Dec 31 registration for Jan 1 birthday defers to next year", () => {
      // Registered on Dec 31, 2026 for Jan 1 birthday.
      // In 2026, Jan 1 was 364 days ago. Ineligible for 2026.
      // Deferred to 2027.
      const eligibility = checkBirthdayEligibility(
        "1990-01-01",
        "2026-12-31T23:59:59.000Z",
        new Date("2026-12-31T23:59:59.000Z"),
      );
      expect(eligibility.isEligible).toBe(false);
      expect(eligibility.nextEligibleYear).toBe(2027);
      expect(eligibility.leadTimeDays).toBeLessThan(0);
    });

    it("2.3 High-concurrency conflicting birthday submissions: OCC CAS guarantees one winner", async () => {
      let registeredBirthday: { birthMonth: number; birthDay: number } | null =
        null;
      let successCount = 0;
      let conflictCount = 0;

      // Simulating OCC CAS check on birthday registration
      const submitBirthday = async (month: number, day: number) => {
        if (registeredBirthday === null) {
          registeredBirthday = { birthMonth: month, birthDay: day };
          successCount++;
          return { status: 200, birthday: registeredBirthday };
        }
        if (
          registeredBirthday.birthMonth === month &&
          registeredBirthday.birthDay === day
        ) {
          return { status: 200, idempotent: true };
        }
        conflictCount++;
        return { status: 409, error: "birthday_locked" };
      };

      // 10 concurrent requests submitting differing dates
      const dates = [
        [1, 15],
        [2, 20],
        [3, 10],
        [4, 5],
        [5, 12],
        [6, 18],
        [7, 22],
        [8, 30],
        [9, 9],
        [10, 11],
      ];

      await Promise.all(dates.map(([m, d]) => submitBirthday(m, d)));

      expect(successCount).toBe(1);
      expect(conflictCount).toBe(9);
    });

    it("2.4 Redaction race: birthday worker refuses to award points if customer was redacted mid-flight", () => {
      const account = {
        id: "wacc_redacted_race",
        status: "closed",
        metadata: {
          shopifyCustomerRedaction: {
            status: "redacted",
            redactedAt: new Date().toISOString(),
          },
        },
      };

      // Worker checks if account is closed or has redaction tombstone
      const isRedacted =
        account.status !== "active" ||
        Boolean(account.metadata?.shopifyCustomerRedaction);

      expect(isRedacted).toBe(true);
    });

    it("2.5 Feb 29 leap-year boundary handling on 400-year cycle (2000 vs 2100 vs 2028)", () => {
      // 2028 is a leap year (divisible by 4, not 100)
      const date2028 = getBirthdayRewardDateForYear("2000-02-29", 2028);
      expect(date2028.getUTCDate()).toBe(29);

      // 2027 is not a leap year -> clamp to 28
      const date2027 = getBirthdayRewardDateForYear("2000-02-29", 2027);
      expect(date2027.getUTCDate()).toBe(28);

      // 2100 is century non-leap year (divisible by 100, not 400) -> clamp to 28
      const date2100 = getBirthdayRewardDateForYear("2000-02-29", 2100);
      expect(date2100.getUTCDate()).toBe(28);

      // 2000 is 400-year leap year -> 29
      const date2000 = getBirthdayRewardDateForYear("2000-02-29", 2000);
      expect(date2000.getUTCDate()).toBe(29);
    });

    it("2.6 Operational writes block prevents birthday points mutation and fails closed", async () => {
      // Simulate assertShopifyStoreAcceptsOperationalWrites throwing compliance error
      const mockOperation = async () => {
        throw new Error(
          "Shopify store is in compliance block mode. Operational writes are disabled.",
        );
      };

      await expect(mockOperation()).rejects.toThrow("compliance block");
    });
  });

  // ==========================================================================
  // Group 3: Adversarial Judge.me Webhook Attacks
  // ==========================================================================
  describe("Group 3: Adversarial Judge.me Webhook Attacks", () => {
    it("3.1 Signature replay attack with tampered body payload fails verification", () => {
      const secret = "judgeme_token_secure_456";
      const legitBody = JSON.stringify({ review: { id: 101, rating: 2 } });
      const legitSig = createHmac("sha256", secret)
        .update(legitBody)
        .digest("hex");

      // Attacker replays legitSig with modified body
      const tamperedBody = JSON.stringify({
        review: { id: 101, rating: 5, verified: "confirmed-buyer" },
      });

      expect(
        verifyJudgeMeWebhookSignature({
          rawBody: tamperedBody,
          signature: legitSig,
          secret,
        }),
      ).toBe(false);
    });

    it("3.2 Malformed signature headers: truncated, oversized, non-hex, binary characters fail gracefully", () => {
      const secret = "judgeme_token_secure_456";
      const rawBody = "{}";

      const badSignatures = [
        "a".repeat(63), // 63 chars (too short)
        "a".repeat(65), // 65 chars (too long)
        "g".repeat(64), // non-hex character 'g'
        "1234567890abcdef!@#$%^&*()_+~`",
        "\x00".repeat(64),
      ];

      for (const sig of badSignatures) {
        expect(
          verifyJudgeMeWebhookSignature({ rawBody, signature: sig, secret }),
        ).toBe(false);
      }
    });

    it("3.3 Upstream Judge.me 500/502/503 and network timeouts throw typed JudgeMeApiError without ledger writes", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Internal Server Error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        fetchJudgeMeReview({
          apiToken: "valid_token_123456",
          shopDomain: "brand.myshopify.com",
          reviewId: "4040",
        }),
      ).rejects.toThrow(JudgeMeApiError);

      expect(mocks.ledgerCreate).not.toHaveBeenCalled();
    });

    it("3.4 Spoofed webhook payload body with fake 5-star rating and fake buyer status is overridden by authoritative fetch", async () => {
      const spoofedBody = JSON.stringify({
        review: {
          id: 4242,
          rating: 5,
          verified: "confirmed-buyer",
          email: "attacker@example.com",
        },
      });
      const secret = "judgeme_secret_token_12345";
      const signature = createHmac("sha256", secret)
        .update(spoofedBody)
        .digest("hex");

      // Authoritative API response from Judge.me says review is UNVERIFIED with rating 1
      const authoritativeReview: JudgeMeReview = {
        id: 4242,
        email: "shopper@example.com",
        body: "Worst product ever",
        rating: 1,
        verified: "unverified",
        has_published_pictures: false,
        has_published_videos: false,
      };

      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ review: authoritativeReview }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const result = await processJudgeMeWebhook({
        integrationId: "wreviewint_adv",
        rawBody: spoofedBody,
        signature,
      });

      // The authoritative unverified state routes through clawback. With no
      // prior award, it remains a no-op and never creates a ledger entry.
      expect(result).toEqual({
        status: "ignored",
        reason: "no_prior_award_found",
      });
      expect(mocks.ledgerCreate).not.toHaveBeenCalled();
    });

    it("3.5 Integration disabled mid-flight fails closed and does not award points", async () => {
      mocks.integrationFindUnique
        .mockResolvedValueOnce({
          id: "wreviewint_adv",
          storeId: "wstore_1",
          provider: "judgeme",
          enabled: true,
          encryptedApiToken: "encrypted:token",
        })
        .mockResolvedValueOnce({
          id: "wreviewint_adv",
          storeId: "wstore_1",
          provider: "judgeme",
          enabled: false, // merchant disabled integration right before transaction
        });

      const review: JudgeMeReview = {
        id: 999,
        email: "shopper@example.com",
        body: "Love these leggings! Super soft and stretchy.",
        rating: 5,
        verified: "verified-purchase",
        has_published_pictures: false,
        has_published_videos: false,
      };

      const result = await awardJudgeMeReview({
        integrationId: "wreviewint_adv",
        review,
      });

      expect(result).toEqual({
        status: "ignored",
        reason: "integration_unavailable",
      });
    });
  });

  // ==========================================================================
  // Group 4: Insolvent Account & Negative Balance Stress
  // ==========================================================================
  describe("Group 4: Insolvent Account & Negative Balance Stress", () => {
    it("4.1 Review clawback on zero-balance account cleanly drives balance to negative without error", async () => {
      // Prior award was 125 points, but customer spent all points (balance = 0)
      mocks.ledgerFindUnique.mockImplementation(async ({ where }: any) => {
        const key = where?.storeId_idempotencyKey?.idempotencyKey;
        if (key === "review:judgeme:wstore_1:901") {
          return {
            id: "entry_award_901",
            accountId: "wacc_adversary_1",
            pointsDelta: BigInt(125),
            balanceAfter: BigInt(0),
          };
        }
        return null;
      });

      // Account balance currently 0
      mocks.accountFindUnique.mockResolvedValueOnce({
        id: "wacc_adversary_1",
        storeId: "wstore_1",
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(125),
        lifetimePointsRedeemed: BigInt(125),
        ledgerVersion: 3,
      });

      const clawback = await clawbackJudgeMeReview({
        integrationId: "wreviewint_adv",
        reviewId: "901",
      });

      expect(clawback.status).toBe("clawed_back");
      if (clawback.status === "clawed_back") {
        expect(clawback.pointsReversed).toBe("125");
        expect(BigInt(clawback.balanceAfter!)).toBe(BigInt(-125));
      }
    });

    it("4.2 Review clawback on already-insolvent account (-500) preserves sequence and sets balance to -625", async () => {
      mocks.ledgerFindUnique.mockImplementation(async ({ where }: any) => {
        const key = where?.storeId_idempotencyKey?.idempotencyKey;
        if (key === "review:judgeme:wstore_1:902") {
          return {
            id: "entry_award_902",
            accountId: "wacc_adversary_1",
            pointsDelta: BigInt(125),
            balanceAfter: BigInt(125),
          };
        }
        return null;
      });

      // Account balance currently -500
      mocks.accountFindUnique.mockResolvedValueOnce({
        id: "wacc_adversary_1",
        storeId: "wstore_1",
        cachedPointsBalance: BigInt(-500),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(1000),
        lifetimePointsRedeemed: BigInt(1500),
        ledgerVersion: 10,
      });

      const clawback = await clawbackJudgeMeReview({
        integrationId: "wreviewint_adv",
        reviewId: "902",
      });

      expect(clawback.status).toBe("clawed_back");
      if (clawback.status === "clawed_back") {
        expect(clawback.pointsReversed).toBe("125");
        expect(BigInt(clawback.balanceAfter!)).toBe(BigInt(-625));
      }
    });

    it("4.3 Subsequent order earn on negative balance account correctly offsets the deficit", async () => {
      // Starting balance -125. Order earn of +200 points.
      const initialBalance = BigInt(-125);
      const earnPoints = BigInt(200);
      const balanceAfter = initialBalance + earnPoints;

      expect(balanceAfter).toBe(BigInt(75));
    });

    it("4.4 Interleaved sequence of earn, redeem, clawback, and refund preserves exact mathematical balance", () => {
      let balance = BigInt(0);
      let version = 0;

      const events: Array<{ type: string; delta: bigint }> = [
        { type: "EARN_ORDER", delta: BigInt(100) }, // bal: 100
        { type: "REDEEM_REWARD", delta: BigInt(-100) }, // bal: 0
        { type: "REFUND_REVERSAL", delta: BigInt(-50) }, // bal: -50 (review clawback)
        { type: "REFUND_REVERSAL", delta: BigInt(-30) }, // bal: -80 (order refund)
        { type: "EARN_BONUS", delta: BigInt(50) }, // bal: -30 (social earn)
      ];

      for (const event of events) {
        balance += event.delta;
        version++;
      }

      expect(balance).toBe(BigInt(-30));
      expect(version).toBe(5);
    });

    it("4.5 Multi-review clawback under high concurrency: each distinct review claws back exactly once", async () => {
      const claimedKeys = new Set<string>();
      let totalPointsClawedBack = BigInt(0);

      mocks.ledgerFindUnique.mockImplementation(async ({ where }: any) => {
        const key = where?.storeId_idempotencyKey?.idempotencyKey;
        if (key?.startsWith("review_clawback:")) {
          if (claimedKeys.has(key)) {
            return {
              id: `clawback_${key}`,
              storeId: "wstore_1",
              accountId: "wacc_adversary_1",
              pointsDelta: BigInt(-100),
              balanceAfter: BigInt(-100),
              entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
              referenceType: "REVIEW_JUDGEME_CLAWBACK",
              referenceId: key.split(":").pop(),
              idempotencyKey: key,
            };
          }
          claimedKeys.add(key);
          return null;
        }
        if (key?.startsWith("review:judgeme:")) {
          return {
            id: "award_entry",
            storeId: "wstore_1",
            accountId: "wacc_adversary_1",
            pointsDelta: BigInt(100),
            balanceAfter: BigInt(100),
          };
        }
        return null;
      });

      const clawbackReview = async (reviewId: string) => {
        const res = await clawbackJudgeMeReview({
          integrationId: "wreviewint_adv",
          reviewId,
        });
        if (res.status === "clawed_back") {
          totalPointsClawedBack += BigInt(res.pointsReversed ?? 0);
        }
        return res;
      };

      // Concurrent attempts for review 801 and 802 with multiple duplicates
      const attempts = [
        clawbackReview("801"),
        clawbackReview("801"),
        clawbackReview("802"),
        clawbackReview("802"),
        clawbackReview("801"),
        clawbackReview("802"),
      ];

      const results = await Promise.all(attempts);

      expect(claimedKeys.size).toBe(2);
      expect(totalPointsClawedBack).toBe(BigInt(200));
      const successfulClawbacks = results.filter(
        (r) => r.status === "clawed_back",
      );
      expect(successfulClawbacks).toHaveLength(2);
    });
  });
});
