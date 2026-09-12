import { prisma } from "@/lib/prisma";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import {
  awardActivityPoints,
  awardBirthdayReward,
  awardSignupWelcomeBonus,
  checkBirthdayEligibility,
  getBirthdayRewardDateForYear,
  getNextBirthdayRewardSchedule,
} from "@/lib/weletic/loyalty/non-purchase-earn";
import { enqueueSignupPointsCommunication } from "@/lib/weletic/loyalty/points-communication-producer";
import { WeleticPointsLedgerEntryType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([
      {
        id: "store_operational",
        complianceState: "active",
      },
    ]),
    $transaction: vi.fn((fn) => (typeof fn === "function" ? fn(prisma) : fn)),
  },
}));

vi.mock("@/lib/weletic/loyalty/tier-review-scheduling", () => ({
  scheduleTierReviewAfterQualifyingActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));
// This suite mocks communication persistence; SQL acceptance remains separate.
vi.mock("@/lib/weletic/loyalty/birthday-communication-producer", () => ({
  enqueueBirthdayCommunication: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/weletic/loyalty/points-communication-producer", () => ({
  enqueueSignupPointsCommunication: vi.fn().mockResolvedValue(null),
}));

describe("Non-Purchase Earning Engine & Anti-Gaming Rules (M1 / Smile.io Parity)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Birthday 30-Day Anti-Gaming Lockout & Calendar Rules (checkBirthdayEligibility)", () => {
    it("locks out accounts registered less than 30 days before their birthday in the current year", () => {
      // Evaluation date: 2026-08-15
      // Birthday: August 25 (1998-08-25) -> 2026-08-25
      // Registration: 2026-08-10 (only 15 days before birthday)
      const res = checkBirthdayEligibility(
        "1998-08-25",
        "2026-08-10T10:00:00Z",
        new Date("2026-08-15T00:00:00Z"),
      );

      expect(res.isLockedOut).toBe(true);
      expect(res.isEligible).toBe(false);
      expect(res.leadTimeDays).toBe(15);
      expect(res.calendarYear).toBe(2026);
      expect(res.nextEligibleYear).toBe(2027);
      expect(res.reason).toContain("locked out for 2026");
    });

    it("locks out accounts registered on their birthday in the current year (0 days lead time)", () => {
      // Evaluation date: 2026-05-20
      // Birthday: May 20 (1995-05-20)
      // Registration: 2026-05-20
      const res = checkBirthdayEligibility(
        "1995-05-20",
        "2026-05-20T08:30:00Z",
        new Date("2026-05-20T12:00:00Z"),
      );

      expect(res.isLockedOut).toBe(true);
      expect(res.leadTimeDays).toBe(0);
      expect(res.nextEligibleYear).toBe(2027);
    });

    it("locks out accounts registered after their birthday in the current year (negative lead time)", () => {
      // Evaluation date: 2026-10-01
      // Birthday: March 15
      // Registration: 2026-09-01 (registered months after 2026 birthday)
      const res = checkBirthdayEligibility(
        "1990-03-15",
        "2026-09-01T00:00:00Z",
        new Date("2026-10-01T00:00:00Z"),
      );

      expect(res.isLockedOut).toBe(true);
      expect(res.leadTimeDays).toBeLessThan(0);
      expect(res.nextEligibleYear).toBe(2027);
    });

    it("qualifies accounts registered exactly 30 days before birthday", () => {
      // Birthday: 2026-09-30
      // Registration: 2026-08-31 (30 days prior)
      const res = checkBirthdayEligibility(
        "2000-09-30",
        "2026-08-31T00:00:00Z",
        new Date("2026-09-30T00:00:00Z"),
      );

      expect(res.isEligible).toBe(true);
      expect(res.isLockedOut).toBe(false);
      expect(res.leadTimeDays).toBe(30);
      expect(res.calendarYear).toBe(2026);
      expect(res.nextEligibleYear).toBe(2026);
      expect(res.reason).toContain("Eligible for 2026 birthday reward");
    });

    it("qualifies accounts registered well in advance (>30 days, prior year)", () => {
      // Birthday: 2026-04-10
      // Registration: 2025-11-15 (registered in prior year)
      const res = checkBirthdayEligibility(
        "1992-04-10",
        "2025-11-15T00:00:00Z",
        new Date("2026-04-10T00:00:00Z"),
      );

      expect(res.isEligible).toBe(true);
      expect(res.isLockedOut).toBe(false);
      expect(res.leadTimeDays).toBeGreaterThan(100);
      expect(res.nextEligibleYear).toBe(2026);
    });

    it("handles leap year February 29 birthdays cleanly in non-leap and leap years", () => {
      // Non-leap year 2026 (Feb 29 clamps to Feb 28)
      const resNonLeap = checkBirthdayEligibility(
        "2000-02-29",
        "2025-01-01T00:00:00Z",
        new Date("2026-02-28T00:00:00Z"),
      );
      expect(resNonLeap.isEligible).toBe(true);
      expect(resNonLeap.birthdayThisYear.getUTCMonth()).toBe(1); // February
      expect(resNonLeap.birthdayThisYear.getUTCDate()).toBe(28);

      // Leap year 2028
      const resLeap = checkBirthdayEligibility(
        "2000-02-29",
        "2027-01-01T00:00:00Z",
        new Date("2028-02-29T00:00:00Z"),
      );
      expect(resLeap.isEligible).toBe(true);
      expect(resLeap.birthdayThisYear.getUTCDate()).toBe(29);
    });

    it("throws clear error on invalid date inputs", () => {
      expect(() =>
        checkBirthdayEligibility("invalid-date", "2026-01-01"),
      ).toThrow("Invalid birthDate");

      expect(() =>
        checkBirthdayEligibility("1995-05-15", "not-a-date"),
      ).toThrow("Invalid registrationDate");
    });
  });

  describe("annual birthday scheduling", () => {
    it("resolves the payload calendar year instead of the worker execution year", () => {
      expect(
        getBirthdayRewardDateForYear("2000-06-15", 2027).toISOString(),
      ).toBe("2027-06-15T00:00:00.000Z");
      expect(
        getBirthdayRewardDateForYear("2000-02-29", 2027).toISOString(),
      ).toBe("2027-02-28T00:00:00.000Z");
    });

    it("schedules the current-year birthday when the 30-day lead time is satisfied", () => {
      const schedule = getNextBirthdayRewardSchedule({
        birthDate: "2000-12-15",
        registeredAt: "2026-01-01T00:00:00.000Z",
        now: new Date("2026-08-29T00:00:00.000Z"),
      });

      expect(schedule.calendarYear).toBe(2026);
      expect(schedule.scheduledFor.toISOString()).toBe(
        "2026-12-15T00:00:00.000Z",
      );
    });

    it("defers a birthday registered inside the 30-day lockout to next year", () => {
      const schedule = getNextBirthdayRewardSchedule({
        birthDate: "2000-09-10",
        registeredAt: "2026-08-29T00:00:00.000Z",
        now: new Date("2026-08-29T00:00:00.000Z"),
      });

      expect(schedule.calendarYear).toBe(2027);
      expect(schedule.scheduledFor.toISOString()).toBe(
        "2027-09-10T00:00:00.000Z",
      );
    });

    it("clamps leap-day birthdays to February 28 in non-leap years", () => {
      const schedule = getNextBirthdayRewardSchedule({
        birthDate: "2000-02-29",
        registeredAt: "2025-01-01T00:00:00.000Z",
        now: new Date("2026-01-01T00:00:00.000Z"),
      });

      expect(schedule.scheduledFor.toISOString()).toBe(
        "2026-02-28T00:00:00.000Z",
      );
    });
  });

  describe("awardSignupWelcomeBonus", () => {
    it("successfully creates welcome bonus points ledger entry with correct metadata and sequence", async () => {
      const storeId = "store_test_1";
      const accountId = "wacc_user_1";

      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        status: "active",
      } as any);
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findFirst,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValueOnce({
        id: "wledger_1",
        storeId,
        accountId,
        sequenceNumber: 1,
        entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
        pointsDelta: BigInt(100),
        balanceAfter: BigInt(100),
        idempotencyKey: `signup:${accountId}`,
        referenceType: "SIGNUP_BONUS",
        referenceId: accountId,
        reason: "Welcome bonus points for account signup",
        metadata: { bonusType: "WELCOME_SIGNUP" },
        createdAt: new Date(),
      } as any);

      const entry = await awardSignupWelcomeBonus({
        storeId,
        accountId,
        bonusPoints: 100,
      });

      expect(entry).toBeDefined();
      expect(entry?.pointsDelta).toBe(BigInt(100));
      expect(entry?.entryType).toBe(WeleticPointsLedgerEntryType.EARN_BONUS);
      expect(entry?.idempotencyKey).toBe(`signup:${accountId}`);
      expect(enqueueSignupPointsCommunication).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId,
          tx: prisma,
          receipt: { created: true, entry },
        }),
      );
      expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            idempotencyKey: `signup:${accountId}`,
            entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
            pointsDelta: BigInt(100),
          }),
        }),
      );
      expect(enqueueFlowTriggerJob).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId,
          eventId: "wledger_1",
          payload: expect.objectContaining({
            accountId,
            handle: "weletic-points-earned",
            pointsDelta: "100",
            pointsBalance: "100",
          }),
        }),
      );
    });

    it("locks the Shopify compliance row in the same transaction as the signup ledger append", async () => {
      const existingEntry = {
        id: "wledger_signup_locked",
        storeId: "store_signup_locked",
        accountId: "wacc_signup_locked",
        idempotencyKey: "signup:wacc_signup_locked",
        balanceAfter: BigInt(100),
      } as any;
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(existingEntry);

      await expect(
        awardSignupWelcomeBonus({
          storeId: "store_signup_locked",
          accountId: "wacc_signup_locked",
          bonusPoints: 100,
        }),
      ).resolves.toBe(existingEntry);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      // The operational fence owns both rows in canonical store -> program
      // order before the ledger lookup can observe or mutate account state.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(
        vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(prisma.weleticPointsLedgerEntry.findUnique).mock
          .invocationCallOrder[0]!,
      );
      expect(
        vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[1],
      ).toBeLessThan(
        vi.mocked(prisma.weleticPointsLedgerEntry.findUnique).mock
          .invocationCallOrder[0]!,
      );
    });

    it("returns null when bonus points is zero or negative", async () => {
      const entryZero = await awardSignupWelcomeBonus({
        storeId: "store_1",
        accountId: "wacc_1",
        bonusPoints: 0,
      });
      expect(entryZero).toBeNull();

      const entryNegative = await awardSignupWelcomeBonus({
        storeId: "store_1",
        accountId: "wacc_1",
        bonusPoints: -50,
      });
      expect(entryNegative).toBeNull();
    });

    it("is idempotent: duplicate signup bonus invocation returns existing ledger entry without balance inflation", async () => {
      const storeId = "store_test_1";
      const accountId = "wacc_dup_test";

      const existingEntry = {
        id: "wledger_signup_exist",
        storeId,
        accountId,
        sequenceNumber: 1,
        entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
        pointsDelta: BigInt(150),
        balanceAfter: BigInt(150),
        idempotencyKey: `signup:${accountId}`,
        referenceType: "SIGNUP_BONUS",
        referenceId: accountId,
      } as any;

      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(existingEntry);

      const res = await awardSignupWelcomeBonus({
        storeId,
        accountId,
        bonusPoints: 150,
      });

      expect(res?.id).toBe("wledger_signup_exist");
      expect(enqueueSignupPointsCommunication).toHaveBeenCalledWith(
        expect.objectContaining({
          receipt: { created: false, entry: existingEntry },
        }),
      );
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
    });
  });

  describe("awardBirthdayReward", () => {
    it("does not award when customer redaction closed the account before the award transaction", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValueOnce({
        count: 0,
      });

      const result = await awardBirthdayReward({
        storeId: "store_bday_1",
        accountId: "wacc_bday_redacted",
        birthDate: "1994-08-25",
        rewardPoints: 200,
        now: new Date("2026-08-25T00:00:00Z"),
        enrollmentDate: "2025-01-01T00:00:00Z",
      });

      expect(result).toEqual({
        awarded: false,
        isLockedOut: false,
        calendarYear: 2026,
        reason: "Loyalty account is not active.",
      });
      expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith({
        where: {
          id: "wacc_bday_redacted",
          storeId: "store_bday_1",
          status: "active",
        },
        data: { updatedAt: expect.any(Date) },
      });
      expect(prisma.weleticPointsLedgerEntry.findUnique).not.toHaveBeenCalled();
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
    });

    it("locks out birthday rewards when member enrolled < 30 days prior to birthday", async () => {
      const storeId = "store_bday_1";
      const accountId = "wacc_bday_locked";
      const birthDate = "1994-08-25";
      const enrollmentDate = "2026-08-10"; // 15 days before
      const now = new Date("2026-08-25T00:00:00Z");

      const res = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate,
        rewardPoints: 200,
        now,
        enrollmentDate,
      });

      expect(res.awarded).toBe(false);
      expect(res.isLockedOut).toBe(true);
      expect(res.calendarYear).toBe(2026);
      expect(res.nextEligibleYear).toBe(2027);
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
    });

    it("successfully awards birthday bonus when member enrolled >= 30 days prior to birthday", async () => {
      const storeId = "store_bday_1";
      const accountId = "wacc_bday_eligible";
      const birthDate = "1994-08-25";
      const enrollmentDate = "2026-06-01"; // 85 days before
      const now = new Date("2026-08-25T00:00:00Z");

      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(
        null, // Idempotency check in awardBirthdayReward
      );
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(
        null, // Idempotency check inside appendPointsLedgerEntry
      );
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(100),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(0),
        status: "active",
      } as any);
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findFirst,
      ).mockResolvedValueOnce({
        sequenceNumber: 1,
        balanceAfter: BigInt(100),
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValueOnce({
        id: "wledger_bday_1",
        storeId,
        accountId,
        sequenceNumber: 2,
        entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
        pointsDelta: BigInt(200),
        balanceAfter: BigInt(300),
        idempotencyKey: `birthday:${accountId}:2026`,
        referenceType: "BIRTHDAY_REWARD",
        referenceId: "2026",
      } as any);

      const res = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate,
        rewardPoints: 200,
        now,
        enrollmentDate,
        metadata: {
          birthDate: "must-not-enter-immutable-ledger",
          earningRuleId: "birthday_rule",
        },
      });

      expect(res.awarded).toBe(true);
      expect(res.isLockedOut).toBe(false);
      expect(res.isDuplicate).toBe(false);
      expect(res.calendarYear).toBe(2026);
      expect(res.ledgerEntry?.id).toBe("wledger_bday_1");
      expect(
        vi.mocked(prisma.weleticPointsLedgerEntry.create).mock.calls[0]?.[0]
          .data.metadata,
      ).toEqual({
        bonusType: "BIRTHDAY_REWARD",
        calendarYear: 2026,
        leadTimeDays: 85,
        earningRuleId: "birthday_rule",
      });
    });

    it("enforces calendar-year idempotency: returns duplicate when already awarded for current year", async () => {
      const storeId = "store_bday_1";
      const accountId = "wacc_bday_dup";
      const birthDate = "1990-03-10";
      const enrollmentDate = "2025-01-01";
      const now = new Date("2026-03-10T00:00:00Z");

      const existingEntry = {
        id: "wledger_bday_existing",
        storeId,
        accountId,
        sequenceNumber: 5,
        entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
        pointsDelta: BigInt(300),
        balanceAfter: BigInt(1500),
        idempotencyKey: `birthday:${accountId}:2026`,
        referenceType: "BIRTHDAY_REWARD",
        referenceId: "2026",
      } as any;

      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(existingEntry);

      const res = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate,
        rewardPoints: 300,
        now,
        enrollmentDate,
      });

      expect(res.awarded).toBe(true);
      expect(res.isDuplicate).toBe(true);
      expect(res.calendarYear).toBe(2026);
      expect(res.ledgerEntry?.id).toBe("wledger_bday_existing");
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
    });

    it("fetches account enrollment date from database if not explicitly passed", async () => {
      const storeId = "store_bday_1";
      const accountId = "wacc_auto_fetch";
      const birthDate = "1996-12-05";
      const now = new Date("2026-12-05T00:00:00Z");

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        enrolledAt: new Date("2026-01-10T00:00:00Z"),
        createdAt: new Date("2026-01-10T00:00:00Z"),
      } as any);

      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(null);
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(50),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(50),
        lifetimePointsRedeemed: BigInt(0),
        status: "active",
      } as any);
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findFirst,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValueOnce({
        id: "wledger_bday_auto",
        storeId,
        accountId,
        sequenceNumber: 1,
        entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
        pointsDelta: BigInt(250),
        balanceAfter: BigInt(300),
        idempotencyKey: `birthday:${accountId}:2026`,
      } as any);

      const res = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate,
        rewardPoints: 250,
        now,
      });

      expect(res.awarded).toBe(true);
      expect(res.isLockedOut).toBe(false);
      expect(res.leadTimeDays).toBeGreaterThan(300);
    });
  });

  describe("awardActivityPoints", () => {
    it("locks the Shopify compliance row in the same transaction as the activity ledger append", async () => {
      const existingEntry = {
        id: "wledger_activity_locked",
        storeId: "store_activity_locked",
        accountId: "wacc_activity_locked",
        idempotencyKey:
          "activity:product_review:wacc_activity_locked:review_locked",
        balanceAfter: BigInt(50),
      } as any;
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(existingEntry);

      await expect(
        awardActivityPoints({
          storeId: "store_activity_locked",
          accountId: "wacc_activity_locked",
          activityType: "product_review",
          externalId: "review_locked",
          points: 50,
        }),
      ).resolves.toBe(existingEntry);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(
        vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(prisma.weleticPointsLedgerEntry.findUnique).mock
          .invocationCallOrder[0]!,
      );
      expect(
        vi.mocked(prisma.$queryRaw).mock.invocationCallOrder[1],
      ).toBeLessThan(
        vi.mocked(prisma.weleticPointsLedgerEntry.findUnique).mock
          .invocationCallOrder[0]!,
      );
    });

    it("awards points for social follow actions (Instagram, TikTok, Facebook)", async () => {
      const storeId = "store_act_1";
      const accountId = "wacc_social_1";

      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        status: "active",
      } as any);
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findFirst,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValueOnce({
        id: "wledger_ig_1",
        storeId,
        accountId,
        sequenceNumber: 1,
        entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
        pointsDelta: BigInt(50),
        balanceAfter: BigInt(50),
        idempotencyKey: `activity:instagram_follow:${accountId}:default`,
        referenceType: "ACTIVITY_INSTAGRAM_FOLLOW",
      } as any);

      const entry = await awardActivityPoints({
        storeId,
        accountId,
        activityType: "instagram_follow",
        points: 50,
      });

      expect(entry).toBeDefined();
      expect(entry?.pointsDelta).toBe(BigInt(50));
      expect(entry?.idempotencyKey).toBe(
        `activity:instagram_follow:${accountId}:default`,
      );
    });

    it("awards points for verified product reviews with unique external review IDs", async () => {
      const storeId = "store_act_1";
      const accountId = "wacc_review_1";
      const reviewId = "judgeme_review_98765";

      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(100),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(0),
        status: "active",
      } as any);
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findFirst,
      ).mockResolvedValueOnce({
        sequenceNumber: 1,
        balanceAfter: BigInt(100),
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValueOnce({
        id: "wledger_rev_1",
        storeId,
        accountId,
        sequenceNumber: 2,
        entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
        pointsDelta: BigInt(100),
        balanceAfter: BigInt(200),
        idempotencyKey: `activity:product_review:${accountId}:${reviewId}`,
        referenceType: "ACTIVITY_PRODUCT_REVIEW",
        referenceId: reviewId,
      } as any);

      const entry = await awardActivityPoints({
        storeId,
        accountId,
        activityType: "product_review",
        points: 100,
        externalId: reviewId,
        reason: "Points awarded for verified product review",
      });

      expect(entry?.id).toBe("wledger_rev_1");
      expect(entry?.pointsDelta).toBe(BigInt(100));
      expect(entry?.referenceType).toBe("ACTIVITY_PRODUCT_REVIEW");
      expect(entry?.idempotencyKey).toBe(
        `activity:product_review:${accountId}:${reviewId}`,
      );
    });

    it("returns null when activity points is zero or negative", async () => {
      const entry = await awardActivityPoints({
        storeId: "store_1",
        accountId: "wacc_1",
        activityType: "instagram_follow",
        points: 0,
      });
      expect(entry).toBeNull();
    });
  });

  describe("Simulated Full Non-Purchase Lifecycle & Ledger Monotonicity", () => {
    interface SimulatedAccount {
      id: string;
      storeId: string;
      cachedPointsBalance: bigint;
      lifetimePointsEarned: bigint;
      lifetimePointsRedeemed: bigint;
      enrolledAt: Date;
    }

    interface SimulatedEntry {
      id: string;
      sequenceNumber: number;
      entryType: string;
      pointsDelta: bigint;
      balanceAfter: bigint;
      idempotencyKey: string;
    }

    it("simulates complete lifecycle: signup -> social follow -> review -> birthday -> duplicate attempt", () => {
      const account: SimulatedAccount = {
        id: "acc_lifecycle",
        storeId: "store_lifecycle",
        cachedPointsBalance: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        enrolledAt: new Date("2026-01-01T00:00:00Z"),
      };

      const ledger: SimulatedEntry[] = [];
      const idempotency = new Set<string>();

      const applyBonus = (
        type: string,
        delta: bigint,
        idempKey: string,
      ): { entry: SimulatedEntry; created: boolean } => {
        if (idempotency.has(idempKey)) {
          const found = ledger.find((e) => e.idempotencyKey === idempKey)!;
          return { entry: found, created: false };
        }

        const seq = ledger.length + 1;
        const balAfter = account.cachedPointsBalance + delta;
        account.cachedPointsBalance = balAfter;
        account.lifetimePointsEarned += delta;

        const entry: SimulatedEntry = {
          id: `wledger_${seq}`,
          sequenceNumber: seq,
          entryType: type,
          pointsDelta: delta,
          balanceAfter: balAfter,
          idempotencyKey: idempKey,
        };

        ledger.push(entry);
        idempotency.add(idempKey);
        return { entry, created: true };
      };

      // 1. Signup Welcome Bonus (+100)
      const e1 = applyBonus("EARN_BONUS", BigInt(100), `signup:${account.id}`);
      expect(e1.created).toBe(true);
      expect(e1.entry.sequenceNumber).toBe(1);
      expect(account.cachedPointsBalance).toBe(BigInt(100));

      // 2. Instagram Follow (+50)
      const e2 = applyBonus(
        "EARN_BONUS",
        BigInt(50),
        `activity:instagram_follow:${account.id}:default`,
      );
      expect(e2.created).toBe(true);
      expect(e2.entry.sequenceNumber).toBe(2);
      expect(account.cachedPointsBalance).toBe(BigInt(150));

      // 3. Product Review (+100)
      const e3 = applyBonus(
        "EARN_BONUS",
        BigInt(100),
        `activity:product_review:${account.id}:rev_001`,
      );
      expect(e3.created).toBe(true);
      expect(e3.entry.sequenceNumber).toBe(3);
      expect(account.cachedPointsBalance).toBe(BigInt(250));

      // 4. Birthday Reward 2026 (+200)
      const bdayCheck = checkBirthdayEligibility(
        "1995-07-15",
        account.enrolledAt,
        new Date("2026-07-15T00:00:00Z"),
      );
      expect(bdayCheck.isEligible).toBe(true);

      const e4 = applyBonus(
        "EARN_BONUS",
        BigInt(200),
        `birthday:${account.id}:2026`,
      );
      expect(e4.created).toBe(true);
      expect(e4.entry.sequenceNumber).toBe(4);
      expect(account.cachedPointsBalance).toBe(BigInt(450));
      expect(account.lifetimePointsEarned).toBe(BigInt(450));

      // 5. Duplicate Birthday in 2026 -> Rejected / Idempotent
      const e5 = applyBonus(
        "EARN_BONUS",
        BigInt(200),
        `birthday:${account.id}:2026`,
      );
      expect(e5.created).toBe(false);
      expect(e5.entry.id).toBe(e4.entry.id);
      expect(account.cachedPointsBalance).toBe(BigInt(450));
      expect(ledger.length).toBe(4);

      // 6. Next Calendar Year (2027) Birthday Reward (+200)
      const e6 = applyBonus(
        "EARN_BONUS",
        BigInt(200),
        `birthday:${account.id}:2027`,
      );
      expect(e6.created).toBe(true);
      expect(e6.entry.sequenceNumber).toBe(5);
      expect(account.cachedPointsBalance).toBe(BigInt(650));
    });
  });
});
