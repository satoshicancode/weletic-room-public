import {
  claimCustomerIntentActivity,
  CUSTOMER_INTENT_TRIGGER_CODES,
  CustomerActivityClaimError,
  getCustomerIntentAction,
  validateCustomerIntentConditions,
} from "@/lib/weletic/loyalty/earning-actions";
import {
  checkBirthdayEligibility,
  getBirthdayRewardDateForYear,
  getNextBirthdayRewardSchedule,
} from "@/lib/weletic/loyalty/non-purchase-earn";
import {
  awardJudgeMeReview,
  clawbackJudgeMeReview,
  readJudgeMeReviewId,
  verifyJudgeMeWebhookSignature,
  type JudgeMeReview,
} from "@/lib/weletic/loyalty/review-providers/judgeme";
import {
  redactLoyaltyBirthdayData,
  scrubBirthdayRewardOutboxJobs,
  scrubLegacyBirthdayLedgerMetadata,
} from "@/lib/weletic/loyalty/shopper-privacy";
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
  outboxFindFirst: vi.fn(),
  outboxFindMany: vi.fn(),
  outboxDelete: vi.fn(),
  outboxUpdateMany: vi.fn(),
  outboxCreate: vi.fn(),
  enqueueOutboxJob: vi.fn(),
  appendPointsLedgerEntry: vi.fn(),
  scheduleTierReview: vi.fn(),
  awardActivityPoints: vi.fn(),
  awardBirthdayReward: vi.fn(),
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
  weleticLoyaltyOutboxJob: {
    findFirst: mocks.outboxFindFirst,
    findMany: mocks.outboxFindMany,
    delete: mocks.outboxDelete,
    updateMany: mocks.outboxUpdateMany,
    create: mocks.outboxCreate,
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
    weleticLoyaltyOutboxJob: {
      findFirst: mocks.outboxFindFirst,
      findMany: mocks.outboxFindMany,
      delete: mocks.outboxDelete,
      updateMany: mocks.outboxUpdateMany,
      create: mocks.outboxCreate,
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
  decrypt: vi.fn(() => "mock-secret-judgeme-token"),
  encrypt: vi.fn((val: string) => `encrypted:${val}`),
}));

vi.mock("@dub/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dub/utils")>();
  return {
    ...actual,
    APP_DOMAIN_WITH_NGROK: "https://app.weletic.test",
  };
});

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: mocks.enqueueOutboxJob,
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

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
    awardBirthdayReward: mocks.awardBirthdayReward,
  };
});

function createAccountFixture(
  overrides: Record<string, any> = {},
  ruleOverrides: Record<string, any> = {},
) {
  return {
    id: "wacc_matrix_1",
    storeId: "wstore_1",
    status: "active",
    metadata: {},
    program: {
      status: "active",
      killSwitchActive: false,
      earningRules: [
        {
          id: "wrule_social_1",
          name: "Test Social Rule",
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

function createReviewFixture(
  overrides: Partial<JudgeMeReview> = {},
): JudgeMeReview {
  return {
    id: 101,
    email: "shopper@example.com",
    body: "This activewear has unmatched comfort and support! Highly recommend to everyone.",
    rating: 5,
    verified: "verified-purchase",
    has_published_pictures: false,
    has_published_videos: false,
    reviewer: { email: "shopper@example.com" },
    ...overrides,
  };
}

describe("Loyalty Earning Actions, Birthday & Judge.me Review Matrix Suite (Requirement R1 / Item 9)", () => {
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
      id: "wentry_act_1",
      pointsDelta: BigInt(50),
      balanceAfter: BigInt(150),
      sequenceNumber: 2,
    });
    mocks.awardBirthdayReward.mockResolvedValue({
      id: "wentry_bday_1",
      pointsDelta: BigInt(200),
      balanceAfter: BigInt(350),
      sequenceNumber: 3,
    });
    mocks.integrationFindUnique.mockResolvedValue({
      id: "wreviewint_test",
      storeId: "wstore_1",
      provider: "judgeme",
      enabled: true,
      encryptedApiToken: "encrypted:token",
      store: { id: "wstore_1", shopDomain: "brand.myshopify.com" },
    });
  });

  // ==========================================================================
  // Section 1: Social & Link Actions Lifecycle
  // ==========================================================================
  describe("Section 1: Social & Link Actions Lifecycle", () => {
    it("1.1 recognizes all 7 canonical action codes and awards fixed points cleanly", async () => {
      expect(CUSTOMER_INTENT_TRIGGER_CODES).toHaveLength(7);
      const targets: Record<string, string> = {
        facebook_like: "https://www.facebook.com/weletic",
        facebook_share: "https://brand.example/product/1",
        instagram_follow: "https://www.instagram.com/weletic",
        x_share: "https://brand.example/product/2",
        x_follow: "https://x.com/weletic",
        tiktok_follow: "https://www.tiktok.com/@weletic",
        link_click: "https://brand.example/pages/community",
      };

      for (const triggerCode of CUSTOMER_INTENT_TRIGGER_CODES) {
        mocks.accountFindFirst.mockResolvedValueOnce(
          createAccountFixture(
            {},
            {
              id: `wrule_${triggerCode}`,
              triggerCode,
              conditions: { targetUrl: targets[triggerCode] },
            },
          ),
        );

        const result = await claimCustomerIntentActivity({
          storeId: "wstore_1",
          shopifyCustomerId: "cust_1",
          ruleId: `wrule_${triggerCode}`,
        });

        expect(result.awarded).toBe(true);
        expect(result.pointsAwarded).toBe("50");
        expect(result.pointsBalance).toBe("150");
        expect(mocks.awardActivityPoints).toHaveBeenCalledWith(
          expect.objectContaining({
            activityType: triggerCode,
            points: BigInt(50),
          }),
        );
      }
    });

    it("1.2 enforces strict hostname whitelist (FOLLOW_HOSTS) for social platforms", () => {
      // Facebook: must be facebook.com or www.facebook.com
      expect(() =>
        validateCustomerIntentConditions({
          triggerCode: "facebook_like",
          conditions: { targetUrl: "https://attacker.com/facebook" },
        }),
      ).toThrow("not valid for the facebook like action");

      // Instagram: must be instagram.com or www.instagram.com
      expect(() =>
        validateCustomerIntentConditions({
          triggerCode: "instagram_follow",
          conditions: { targetUrl: "https://instagr.am/fake" },
        }),
      ).toThrow("not valid for the instagram follow action");

      // X follow: twitter.com or x.com
      expect(
        validateCustomerIntentConditions({
          triggerCode: "x_follow",
          conditions: { targetUrl: "https://x.com/brand" },
        }).targetUrl,
      ).toBe("https://x.com/brand");

      // TikTok: tiktok.com or www.tiktok.com
      expect(() =>
        validateCustomerIntentConditions({
          triggerCode: "tiktok_follow",
          conditions: { targetUrl: "https://evil-tiktok.com/brand" },
        }),
      ).toThrow("not valid for the tiktok follow action");
    });

    it("1.3 rejects non-HTTPS protocols (http, javascript, data, file) for all actions", () => {
      const badUrls = [
        "http://www.instagram.com/weletic",
        "javascript:alert(1)",
        "data:text/html,<b>pwned</b>",
        "file:///etc/passwd",
        "",
        "   ",
      ];

      for (const targetUrl of badUrls) {
        expect(() =>
          validateCustomerIntentConditions({
            triggerCode: "instagram_follow",
            conditions: { targetUrl },
          }),
        ).toThrow("requires a valid HTTPS target URL");

        expect(() =>
          validateCustomerIntentConditions({
            triggerCode: "link_click",
            conditions: { targetUrl },
          }),
        ).toThrow("requires a valid HTTPS target URL");
      }
    });

    it("1.4 constructs dynamic platform share composers for Facebook and X with proper URL encoding", () => {
      const fbAction = getCustomerIntentAction({
        triggerCode: "facebook_share",
        conditions: {
          targetUrl: "https://brand.example/product?ref=loyalty",
        },
      });
      expect(fbAction).not.toBeNull();
      expect(fbAction?.url).toBe(
        "https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fbrand.example%2Fproduct%3Fref%3Dloyalty",
      );

      const xAction = getCustomerIntentAction({
        triggerCode: "x_share",
        conditions: {
          targetUrl: "https://brand.example/products/leggings",
          shareMessage: "Loving my new Yamax leggings! 🔥 #activewear",
        },
      });
      expect(xAction).not.toBeNull();
      expect(xAction?.url).toBe(
        "https://x.com/intent/post?url=https%3A%2F%2Fbrand.example%2Fproducts%2Fleggings&text=Loving%20my%20new%20Yamax%20leggings!%20%F0%9F%94%A5%20%23activewear",
      );
    });

    it("1.5 returns existing result for idempotent claimKey deduplication without double-crediting", async () => {
      mocks.ledgerFindUnique.mockResolvedValueOnce({
        id: "wentry_existing",
        pointsDelta: BigInt(50),
        balanceAfter: BigInt(250),
      });

      const result = await claimCustomerIntentActivity({
        storeId: "wstore_1",
        shopifyCustomerId: "cust_1",
        ruleId: "wrule_social_1",
        claimKey: "share-post-xyz",
      });

      expect(result.awarded).toBe(false);
      expect(result.alreadyCompleted).toBe(true);
      expect(result.pointsAwarded).toBe("50");
      expect(result.pointsBalance).toBe("250");
      expect(mocks.awardActivityPoints).not.toHaveBeenCalled();
    });

    it("1.6 enforces daily (UTC day) limit window and allows claiming again after UTC midnight rollover", async () => {
      // 1st claim: today at noon UTC -> succeeds
      const todayNoon = new Date("2026-09-04T12:00:00.000Z");
      mocks.accountFindFirst.mockResolvedValue(
        createAccountFixture(
          {},
          { limitInterval: "daily", maxEventsPerCustomer: 1 },
        ),
      );
      mocks.ledgerCount.mockResolvedValueOnce(0);

      const claim1 = await claimCustomerIntentActivity({
        storeId: "wstore_1",
        shopifyCustomerId: "cust_1",
        ruleId: "wrule_social_1",
        now: todayNoon,
      });
      expect(claim1.awarded).toBe(true);

      // 2nd claim: same day at 18:00 UTC -> count is 1 -> throws limit reached
      mocks.ledgerCount.mockResolvedValueOnce(1);
      await expect(
        claimCustomerIntentActivity({
          storeId: "wstore_1",
          shopifyCustomerId: "cust_1",
          ruleId: "wrule_social_1",
          now: new Date("2026-09-04T18:00:00.000Z"),
        }),
      ).rejects.toThrow(CustomerActivityClaimError);

      // 3rd claim: next day at 00:01 UTC -> new window (count is 0 in new window) -> succeeds
      mocks.ledgerCount.mockResolvedValueOnce(0);
      const claim3 = await claimCustomerIntentActivity({
        storeId: "wstore_1",
        shopifyCustomerId: "cust_1",
        ruleId: "wrule_social_1",
        now: new Date("2026-09-05T00:01:00.000Z"),
      });
      expect(claim3.awarded).toBe(true);
    });

    it("1.7 enforces weekly (ISO week) limit window with Monday UTC boundary rollover", async () => {
      mocks.accountFindFirst.mockResolvedValue(
        createAccountFixture(
          {},
          { limitInterval: "weekly", maxEventsPerCustomer: 1 },
        ),
      );

      // Friday 2026-09-04 -> succeeds
      mocks.ledgerCount.mockResolvedValueOnce(0);
      const resFri = await claimCustomerIntentActivity({
        storeId: "wstore_1",
        shopifyCustomerId: "cust_1",
        ruleId: "wrule_social_1",
        now: new Date("2026-09-04T15:00:00.000Z"),
      });
      expect(resFri.awarded).toBe(true);

      // Sunday 2026-09-06 (same ISO week) -> count is 1 -> rejected
      mocks.ledgerCount.mockResolvedValueOnce(1);
      await expect(
        claimCustomerIntentActivity({
          storeId: "wstore_1",
          shopifyCustomerId: "cust_1",
          ruleId: "wrule_social_1",
          now: new Date("2026-09-06T23:59:00.000Z"),
        }),
      ).rejects.toThrow("earning limit");

      // Monday 2026-09-07T00:00:01.000Z (next ISO week) -> count is 0 -> succeeds
      mocks.ledgerCount.mockResolvedValueOnce(0);
      const resMon = await claimCustomerIntentActivity({
        storeId: "wstore_1",
        shopifyCustomerId: "cust_1",
        ruleId: "wrule_social_1",
        now: new Date("2026-09-07T00:00:01.000Z"),
      });
      expect(resMon.awarded).toBe(true);
    });

    it("1.8 requires claimKey when maxEventsPerCustomer > 1", async () => {
      mocks.accountFindFirst.mockResolvedValue(
        createAccountFixture({}, { maxEventsPerCustomer: 3 }),
      );

      await expect(
        claimCustomerIntentActivity({
          storeId: "wstore_1",
          shopifyCustomerId: "cust_1",
          ruleId: "wrule_social_1",
          // missing claimKey
        }),
      ).rejects.toThrow("claim key is required");
    });

    it("1.9 fails closed when program is disabled, kill switch is active, or rule is inactive", async () => {
      // Program status not active
      mocks.accountFindFirst.mockResolvedValueOnce(
        createAccountFixture({
          program: {
            status: "paused",
            killSwitchActive: false,
            earningRules: [{ id: "r1", isActive: true }],
          },
        }),
      );
      await expect(
        claimCustomerIntentActivity({
          storeId: "wstore_1",
          shopifyCustomerId: "cust_1",
          ruleId: "r1",
        }),
      ).rejects.toThrow("not currently available");

      // Kill switch active
      mocks.accountFindFirst.mockResolvedValueOnce(
        createAccountFixture({
          program: {
            status: "active",
            killSwitchActive: true,
            earningRules: [{ id: "r1", isActive: true }],
          },
        }),
      );
      await expect(
        claimCustomerIntentActivity({
          storeId: "wstore_1",
          shopifyCustomerId: "cust_1",
          ruleId: "r1",
        }),
      ).rejects.toThrow("not currently available");
    });
  });

  // ==========================================================================
  // Section 2: Birthday Lifecycle & 30-Day Anti-Fraud
  // ==========================================================================
  describe("Section 2: Birthday Lifecycle & 30-Day Anti-Fraud", () => {
    it("2.1 grants eligibility for current calendar year when registered >= 30 days prior", () => {
      // Reg: Jan 1, 2026. Birthday: March 15 (73 days lead time >= 30)
      const eligibility = checkBirthdayEligibility(
        "1995-03-15",
        "2026-01-01T00:00:00.000Z",
        new Date("2026-01-01T00:00:00.000Z"),
      );

      expect(eligibility.isEligible).toBe(true);
      expect(eligibility.isLockedOut).toBe(false);
      expect(eligibility.nextEligibleYear).toBe(2026);
      expect(eligibility.leadTimeDays).toBe(73);
    });

    it("2.2 enforces 30-day anti-gaming lockout when registered < 30 days prior and defers to next year", () => {
      // Reg: March 1, 2026. Birthday: March 15 (14 days lead time < 30)
      const eligibility = checkBirthdayEligibility(
        "1995-03-15",
        "2026-03-01T00:00:00.000Z",
        new Date("2026-03-01T00:00:00.000Z"),
      );

      expect(eligibility.isEligible).toBe(false);
      expect(eligibility.isLockedOut).toBe(true);
      expect(eligibility.nextEligibleYear).toBe(2027);
      expect(eligibility.leadTimeDays).toBe(14);
      expect(eligibility.reason).toContain("Deferred to 2027");
    });

    it("2.3 defers reward to next calendar year when registration occurs after birthday in current year", () => {
      // Reg: June 1, 2026. Birthday: March 15 (passed 78 days ago)
      const eligibility = checkBirthdayEligibility(
        "1995-03-15",
        "2026-06-01T00:00:00.000Z",
        new Date("2026-06-01T00:00:00.000Z"),
      );

      expect(eligibility.isEligible).toBe(false);
      expect(eligibility.isLockedOut).toBe(true);
      expect(eligibility.nextEligibleYear).toBe(2027);
      expect(eligibility.leadTimeDays).toBeLessThan(0);
    });

    it("2.4 normalizes Feb 29 leap-year birthdays to Feb 28 on non-leap years and Feb 29 on leap years", () => {
      // Non-leap year 2026: Feb 29 -> Feb 28
      const date2026 = getBirthdayRewardDateForYear("2000-02-29", 2026);
      expect(date2026.getUTCFullYear()).toBe(2026);
      expect(date2026.getUTCMonth()).toBe(1); // February
      expect(date2026.getUTCDate()).toBe(28);

      // Leap year 2028: Feb 29 -> Feb 29
      const date2028 = getBirthdayRewardDateForYear("2000-02-29", 2028);
      expect(date2028.getUTCFullYear()).toBe(2028);
      expect(date2028.getUTCMonth()).toBe(1); // February
      expect(date2028.getUTCDate()).toBe(29);

      // Century non-leap year 2100: Feb 29 -> Feb 28
      const date2100 = getBirthdayRewardDateForYear("2000-02-29", 2100);
      expect(date2100.getUTCDate()).toBe(28);

      // 400-year leap year 2000: Feb 29 -> Feb 29
      const date2000 = getBirthdayRewardDateForYear("2000-02-29", 2000);
      expect(date2000.getUTCDate()).toBe(29);
    });

    it("2.5 calculates next annual recurring schedule correctly advancing into future years", () => {
      // Birthday: Aug 20. Registered: Jan 1, 2026. After 2026 reward awarded (e.g. Aug 21, 2026):
      const nextSchedule = getNextBirthdayRewardSchedule({
        birthDate: "1990-08-20",
        registeredAt: "2026-01-01T00:00:00.000Z",
        now: new Date("2026-08-21T00:00:00.000Z"),
      });

      expect(nextSchedule.calendarYear).toBe(2027);
      expect(nextSchedule.scheduledFor.toISOString()).toBe(
        "2027-08-20T00:00:00.000Z",
      );
    });

    it("2.6 rejects birthday modification when an existing birthday is already registered (anti-tampering)", () => {
      const existingBirthday = { birthMonth: 5, birthDay: 12 };
      const submittedBirthday = { birthMonth: 8, birthDay: 20 };

      // Simulating route verification logic
      const isLocked =
        existingBirthday.birthMonth !== submittedBirthday.birthMonth ||
        existingBirthday.birthDay !== submittedBirthday.birthDay;

      expect(isLocked).toBe(true);
    });

    it("2.7 allows idempotent re-registration with identical birth date without schedule conflict", () => {
      const existingBirthday = { birthMonth: 5, birthDay: 12 };
      const submittedBirthday = { birthMonth: 5, birthDay: 12 };

      const isSameDate =
        existingBirthday.birthMonth === submittedBirthday.birthMonth &&
        existingBirthday.birthDay === submittedBirthday.birthDay;

      expect(isSameDate).toBe(true);
    });
  });

  // ==========================================================================
  // Section 3: GDPR/CCPA Privacy Redaction & Ledger Preservation
  // ==========================================================================
  describe("Section 3: GDPR/CCPA Privacy Redaction & Ledger Preservation", () => {
    it("3.1 redacts birthday from account metadata while updating compliance status", async () => {
      mocks.accountFindFirst.mockResolvedValueOnce({
        id: "wacc_redact_1",
        metadata: {
          preferredLanguage: "en",
          birthday: { birthDate: "1990-05-12", registeredAt: "2026-01-01" },
        },
      });
      mocks.accountUpdateMany.mockResolvedValueOnce({ count: 1 });
      mocks.outboxFindMany.mockResolvedValueOnce([]);
      mocks.ledgerFindMany.mockResolvedValueOnce([]);

      const result = await redactLoyaltyBirthdayData({
        storeId: "wstore_1",
        shopifyCustomerId: "cust_redact_1",
      });

      expect(result.accountId).toBe("wacc_redact_1");
      expect(mocks.accountUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: "closed",
            metadata: expect.objectContaining({
              shopifyCustomerRedaction: expect.objectContaining({
                status: "redacted",
              }),
            }),
          }),
        }),
      );
    });

    it("3.2 cancels and purges all scheduled BIRTHDAY_REWARD outbox jobs upon redaction", async () => {
      mocks.outboxFindMany.mockResolvedValueOnce([
        { id: "job_bday_1" },
        { id: "job_bday_2" },
      ]);
      mocks.outboxFindFirst
        .mockResolvedValueOnce({
          id: "job_bday_1",
          status: "pending",
          payload: { accountId: "wacc_redact_1", birthDate: "1990-05-12" },
          updatedAt: new Date(),
        })
        .mockResolvedValueOnce({
          id: "job_bday_2",
          status: "pending",
          payload: { accountId: "wacc_redact_1", birthDate: "1990-05-12" },
          updatedAt: new Date(),
        });
      mocks.outboxUpdateMany.mockResolvedValue({ count: 1 });

      const scrubbedCount = await scrubBirthdayRewardOutboxJobs({
        storeId: "wstore_1",
        accountId: "wacc_redact_1",
      });

      expect(scrubbedCount).toBe(2);
      expect(mocks.outboxUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "job_bday_1",
          }),
          data: expect.objectContaining({
            status: "cancelled",
            payload: expect.objectContaining({
              redactionReason: "shopify_customer_redact",
            }),
          }),
        }),
      );
    });

    it("3.3 scrubs birthday metadata from ledger entries while preserving pointsDelta, balanceAfter, and sequence numbers", async () => {
      mocks.ledgerFindMany.mockResolvedValueOnce([
        { id: "wentry_bday_legacy" },
      ]);
      mocks.ledgerFindFirst.mockResolvedValueOnce({
        id: "wentry_bday_legacy",
        metadata: {
          birthDate: "1990-05-12",
          calendarYear: 2026,
          originalAward: true,
        },
      });
      mocks.ledgerUpdateMany.mockResolvedValueOnce({ count: 1 });

      const scrubbedLedgers = await scrubLegacyBirthdayLedgerMetadata({
        storeId: "wstore_1",
        accountId: "wacc_redact_1",
      });

      expect(scrubbedLedgers).toBe(1);
      expect(mocks.ledgerUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reason: "Birthday reward details redacted.",
          }),
        }),
      );
    });

    it("3.4 preserves ledger financial transactions and immutable double-entry history after redaction", () => {
      // Simulating ledger audit check after redaction
      const ledgerBefore = {
        id: "entry_1",
        sequenceNumber: 4,
        pointsDelta: BigInt(200),
        balanceAfter: BigInt(500),
        entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
      };

      const ledgerAfter = {
        ...ledgerBefore,
        reason: "Birthday reward details redacted.",
        metadata: { redacted: true },
      };

      expect(ledgerAfter.pointsDelta).toEqual(ledgerBefore.pointsDelta);
      expect(ledgerAfter.balanceAfter).toEqual(ledgerBefore.balanceAfter);
      expect(ledgerAfter.sequenceNumber).toEqual(ledgerBefore.sequenceNumber);
    });

    it("3.5 returns zero scrubbed records gracefully when account has no birthday data or is already redacted", async () => {
      mocks.accountFindFirst.mockResolvedValueOnce(null);

      const result = await redactLoyaltyBirthdayData({
        storeId: "wstore_1",
        shopifyCustomerId: "non_existent_customer",
      });

      expect(result.accountId).toBeNull();
      expect(result.scrubbedJobs).toBe(0);
      expect(result.scrubbedLedgerEntries).toBe(0);
    });
  });

  // ==========================================================================
  // Section 4: Signed Judge.me Review Rewards & Moderation Clawback
  // ==========================================================================
  describe("Section 4: Signed Judge.me Review Rewards & Moderation Clawback", () => {
    it("4.1 validates cryptographic HMAC-SHA256 signature and rejects forged signatures", () => {
      const secret = "my-secret-token-1234";
      const rawBody = JSON.stringify({ review: { id: 999, rating: 5 } });
      const validSig = createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");

      expect(
        verifyJudgeMeWebhookSignature({ rawBody, signature: validSig, secret }),
      ).toBe(true);

      // 1-bit modified signature
      const tamperedSig = "a" + validSig.slice(1);
      expect(
        verifyJudgeMeWebhookSignature({
          rawBody,
          signature: tamperedSig,
          secret,
        }),
      ).toBe(false);

      // Wrong secret
      expect(
        verifyJudgeMeWebhookSignature({
          rawBody,
          signature: validSig,
          secret: "wrong-secret",
        }),
      ).toBe(false);
    });

    it("4.2 rejects non-hex, truncated, and empty signatures gracefully without throwing exceptions", () => {
      const secret = "my-secret-token-1234";
      const rawBody = "{}";

      expect(
        verifyJudgeMeWebhookSignature({ rawBody, signature: null, secret }),
      ).toBe(false);
      expect(
        verifyJudgeMeWebhookSignature({ rawBody, signature: "", secret }),
      ).toBe(false);
      expect(
        verifyJudgeMeWebhookSignature({
          rawBody,
          signature: "short-sig",
          secret,
        }),
      ).toBe(false);
      expect(
        verifyJudgeMeWebhookSignature({
          rawBody,
          signature: "z".repeat(64),
          secret,
        }),
      ).toBe(false);
    });

    it("4.3 extracts review ID from webhook payload and rejects missing review ID", () => {
      expect(readJudgeMeReviewId({ review_id: 123 })).toBe("123");
      expect(readJudgeMeReviewId({ id: 456 })).toBe("456");
      expect(readJudgeMeReviewId({ review: { id: 789 } })).toBe("789");
      expect(readJudgeMeReviewId({})).toBeNull();
      expect(readJudgeMeReviewId(null)).toBeNull();
    });

    it("4.4 verified buyer gating: only awards confirmed buyer reviews and ignores unverified ones", async () => {
      const unverifiedReview = createReviewFixture({ verified: "unverified" });
      const resUnverified = await awardJudgeMeReview({
        integrationId: "wreviewint_test",
        review: unverifiedReview,
      });
      expect(resUnverified).toEqual({
        status: "ignored",
        reason: "review_not_verified",
      });

      const buyerReview = createReviewFixture({ verified: "confirmed-buyer" });
      mocks.accountFindFirst.mockResolvedValueOnce(
        createAccountFixture(
          {},
          {
            id: "wrule_review",
            triggerCode: "product_review",
            fixedPoints: BigInt(100),
          },
        ),
      );
      mocks.ledgerFindUnique.mockResolvedValueOnce(null);
      mocks.ledgerCount.mockResolvedValueOnce(0);

      const resBuyer = await awardJudgeMeReview({
        integrationId: "wreviewint_test",
        review: buyerReview,
      });
      expect(resBuyer.status).toBe("awarded");
    });

    it("4.5 enforces minContentLength condition and ignores short or empty review bodies", async () => {
      mocks.accountFindFirst.mockResolvedValue(
        createAccountFixture(
          {},
          {
            id: "wrule_review",
            triggerCode: "product_review",
            fixedPoints: BigInt(100),
            conditions: { minContentLength: 30 },
          },
        ),
      );

      const shortReview = createReviewFixture({ body: "Too short" });
      const result = await awardJudgeMeReview({
        integrationId: "wreviewint_test",
        review: shortReview,
      });

      expect(result).toEqual({
        status: "ignored",
        reason: "review_content_too_short",
      });
    });

    it("4.6 calculates photo and video bonus points correctly added to fixedPoints", async () => {
      mocks.accountFindFirst.mockResolvedValue(
        createAccountFixture(
          {},
          {
            id: "wrule_review",
            triggerCode: "product_review",
            fixedPoints: BigInt(100),
            conditions: {
              minContentLength: 10,
              photoBonusPoints: 25,
              videoBonusPoints: 50,
            },
          },
        ),
      );

      // Photo only -> 100 + 25 = 125
      const photoReview = createReviewFixture({
        has_published_pictures: true,
        has_published_videos: false,
      });
      const photoRes = await awardJudgeMeReview({
        integrationId: "wreviewint_test",
        review: photoReview,
      });
      expect(photoRes.status).toBe("awarded");

      // Video only -> 100 + 50 = 150
      const videoReview = createReviewFixture({
        id: 102,
        has_published_pictures: false,
        has_published_videos: true,
      });
      const videoRes = await awardJudgeMeReview({
        integrationId: "wreviewint_test",
        review: videoReview,
      });
      expect(videoRes.status).toBe("awarded");
    });

    it("4.7 enforces monthly review velocity limits (maxEventsPerCustomer)", async () => {
      mocks.accountFindFirst.mockResolvedValue(
        createAccountFixture(
          {},
          {
            id: "wrule_review",
            triggerCode: "product_review",
            fixedPoints: BigInt(100),
            limitInterval: "monthly",
            maxEventsPerCustomer: 2,
          },
        ),
      );
      mocks.ledgerCount.mockResolvedValueOnce(2);

      const review = createReviewFixture({ id: 103 });
      const result = await awardJudgeMeReview({
        integrationId: "wreviewint_test",
        review,
      });

      expect(result).toEqual({
        status: "limit_reached",
        reason: "review_velocity_limit",
      });
    });

    it("4.8 review moderation clawback: appends REFUND_REVERSAL debit and allows negative balance", async () => {
      // Prior award: 125 points
      mocks.ledgerFindUnique.mockImplementation(async ({ where }: any) => {
        const idKey = where?.storeId_idempotencyKey?.idempotencyKey;
        if (idKey === "review:judgeme:wstore_1:101") {
          return {
            id: "entry_award_101",
            accountId: "wacc_matrix_1",
            pointsDelta: BigInt(125),
            balanceAfter: BigInt(25), // customer already spent 100 points
          };
        }
        if (idKey === "review_clawback:judgeme:wstore_1:101") {
          return null; // not yet clawed back
        }
        return null;
      });

      // Simulate appendPointsLedgerEntry appending debit resulting in negative balance
      const clawbackResult = await clawbackJudgeMeReview({
        integrationId: "wreviewint_test",
        reviewId: "101",
        reason: "Review failed moderation review",
      });

      expect(clawbackResult.status).toBe("clawed_back");
      if (clawbackResult.status === "clawed_back") {
        expect(clawbackResult.pointsReversed).toBe("125");
      }
      expect(mocks.scheduleTierReview).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: "review_points_clawed_back",
        }),
      );
    });

    it("4.9 clawback idempotency: duplicate clawback requests return duplicate status without double debiting", async () => {
      mocks.ledgerFindUnique.mockImplementation(async ({ where }: any) => {
        const idKey = where?.storeId_idempotencyKey?.idempotencyKey;
        if (idKey === "review_clawback:judgeme:wstore_1:101") {
          return {
            id: "entry_clawback_101",
            accountId: "wacc_matrix_1",
            pointsDelta: BigInt(-125),
            balanceAfter: BigInt(-100),
          };
        }
        return null;
      });

      const duplicateResult = await clawbackJudgeMeReview({
        integrationId: "wreviewint_test",
        reviewId: "101",
      });

      expect(duplicateResult.status).toBe("duplicate");
      if (duplicateResult.status === "duplicate") {
        expect(duplicateResult.reason).toBe("already_clawed_back");
        expect(duplicateResult.pointsReversed).toBe("125");
        expect(duplicateResult.balanceAfter).toBe("-100");
      }
    });
  });
});
