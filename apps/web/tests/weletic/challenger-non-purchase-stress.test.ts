import { prisma } from "@/lib/prisma";
import {
  awardActivityPoints,
  awardBirthdayReward,
  awardSignupWelcomeBonus,
  checkBirthdayEligibility,
} from "@/lib/weletic/loyalty/non-purchase-earn";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(async (fn) => {
      if (typeof fn === "function") {
        return await fn(prisma);
      }
      return fn;
    }),
  },
}));

vi.mock("@/lib/weletic/loyalty/tier-review-scheduling", () => ({
  scheduleTierReviewAfterQualifyingActivity: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

describe("Empirical Challenger 1: Non-Purchase Earning & Birthday Anti-Fraud Stress Harness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValue({
      count: 1,
    });
  });

  // =========================================================================
  // SCOPE 1: Adversarial Birthday Anti-Gaming Lockout & Lead-Time Boundary Matrix
  // =========================================================================
  describe("Scope 1: Birthday Anti-Gaming Lockout & Lead-Time Boundary Matrix", () => {
    it("exhaustively sweeps lead times from -60 days to +60 days around the 30-day threshold", () => {
      const birthday = "1992-06-15"; // June 15
      const evalYear = 2026;
      const bdayThisYear = new Date(Date.UTC(evalYear, 5, 15, 0, 0, 0, 0)); // June 15, 2026 UTC

      for (let daysDelta = -60; daysDelta <= 60; daysDelta++) {
        // Construct registration date: bdayThisYear minus daysDelta days
        const regDate = new Date(
          bdayThisYear.getTime() - daysDelta * 24 * 60 * 60 * 1000,
        );
        const evalDate = new Date(Date.UTC(evalYear, 5, 15, 12, 0, 0, 0));

        const res = checkBirthdayEligibility(birthday, regDate, evalDate);

        expect(res.calendarYear).toBe(evalYear);
        expect(res.leadTimeDays).toBe(daysDelta);

        if (daysDelta >= 30) {
          expect(res.isEligible).toBe(true);
          expect(res.isLockedOut).toBe(false);
          expect(res.nextEligibleYear).toBe(evalYear);
          expect(res.reason).toContain("Eligible for 2026 birthday reward");
        } else {
          expect(res.isEligible).toBe(false);
          expect(res.isLockedOut).toBe(true);
          expect(res.nextEligibleYear).toBe(evalYear + 1);
          expect(res.reason).toContain("Birthday locked out for 2026");
        }
      }
    });

    it("verifies sharp boundaries at exact thresholds: 29 days (locked) vs 30 days (eligible) vs 31 days (eligible)", () => {
      const birthday = "1995-10-10"; // October 10
      const evalDate = new Date("2026-10-10T12:00:00Z");

      // 29 Days: Registration on September 11, 2026
      // (Sept has 30 days: Sept 11 -> Sept 30 is 19 days + 10 days in Oct = 29 days)
      const res29 = checkBirthdayEligibility(
        birthday,
        "2026-09-11T00:00:00Z",
        evalDate,
      );
      expect(res29.leadTimeDays).toBe(29);
      expect(res29.isEligible).toBe(false);
      expect(res29.isLockedOut).toBe(true);
      expect(res29.nextEligibleYear).toBe(2027);

      // 30 Days: Registration on September 10, 2026 (exact threshold)
      // (Sept 10 -> Sept 30 is 20 days + 10 days in Oct = 30 days)
      const res30 = checkBirthdayEligibility(
        birthday,
        "2026-09-10T00:00:00Z",
        evalDate,
      );
      expect(res30.leadTimeDays).toBe(30);
      expect(res30.isEligible).toBe(true);
      expect(res30.isLockedOut).toBe(false);
      expect(res30.nextEligibleYear).toBe(2026);

      // 31 Days: Registration on September 9, 2026
      const res31 = checkBirthdayEligibility(
        birthday,
        "2026-09-09T00:00:00Z",
        evalDate,
      );
      expect(res31.leadTimeDays).toBe(31);
      expect(res31.isEligible).toBe(true);
      expect(res31.isLockedOut).toBe(false);
      expect(res31.nextEligibleYear).toBe(2026);

      // 0 Days: Registration on birthday itself (October 10, 2026)
      const res0 = checkBirthdayEligibility(
        birthday,
        "2026-10-10T08:00:00Z",
        evalDate,
      );
      expect(res0.leadTimeDays).toBe(0);
      expect(res0.isEligible).toBe(false);
      expect(res0.isLockedOut).toBe(true);

      // -1 Day: Registration the day after birthday (October 11, 2026)
      const resNeg1 = checkBirthdayEligibility(
        birthday,
        "2026-10-11T00:00:00Z",
        evalDate,
      );
      expect(resNeg1.leadTimeDays).toBe(-1);
      expect(resNeg1.isEligible).toBe(false);
      expect(resNeg1.isLockedOut).toBe(true);
      expect(resNeg1.reason).toContain("registered 1 days after birthday");
    });

    it("evaluates leap year Feb 29 across leap, non-leap, century, and 400-year century cycles", () => {
      const feb29BirthDate = "2000-02-29";

      // Non-leap standard years (2021, 2022, 2023, 2025, 2026, 2027) -> Clamped to Feb 28
      const nonLeapYears = [2021, 2022, 2023, 2025, 2026, 2027, 2029, 2030];
      for (const year of nonLeapYears) {
        const evalDate = new Date(Date.UTC(year, 1, 28, 12, 0, 0, 0));
        const res = checkBirthdayEligibility(
          feb29BirthDate,
          new Date(Date.UTC(year - 1, 0, 1, 0, 0, 0, 0)),
          evalDate,
        );
        expect(res.birthdayThisYear.getUTCFullYear()).toBe(year);
        expect(res.birthdayThisYear.getUTCMonth()).toBe(1); // February
        expect(res.birthdayThisYear.getUTCDate()).toBe(28);
        expect(res.isEligible).toBe(true);
      }

      // Leap standard years (2020, 2024, 2028, 2032, 2036) -> Exactly Feb 29
      const leapYears = [2020, 2024, 2028, 2032, 2036];
      for (const year of leapYears) {
        const evalDate = new Date(Date.UTC(year, 1, 29, 12, 0, 0, 0));
        const res = checkBirthdayEligibility(
          feb29BirthDate,
          new Date(Date.UTC(year - 1, 0, 1, 0, 0, 0, 0)),
          evalDate,
        );
        expect(res.birthdayThisYear.getUTCFullYear()).toBe(year);
        expect(res.birthdayThisYear.getUTCMonth()).toBe(1); // February
        expect(res.birthdayThisYear.getUTCDate()).toBe(29);
        expect(res.isEligible).toBe(true);
      }

      // Century non-leap rule (2100, 2200, 2300 divisible by 100 but not 400) -> Clamped to Feb 28
      const centuryNonLeapYears = [2100, 2200, 2300];
      for (const year of centuryNonLeapYears) {
        const evalDate = new Date(Date.UTC(year, 1, 28, 0, 0, 0, 0));
        const res = checkBirthdayEligibility(
          feb29BirthDate,
          new Date(Date.UTC(year - 1, 0, 1, 0, 0, 0, 0)),
          evalDate,
        );
        expect(res.birthdayThisYear.getUTCDate()).toBe(28);
      }

      // 400-year century leap rule (2000, 2400 divisible by 400) -> Exactly Feb 29
      const quadCenturyLeapYears = [2000, 2400];
      for (const year of quadCenturyLeapYears) {
        const evalDate = new Date(Date.UTC(year, 1, 29, 0, 0, 0, 0));
        const res = checkBirthdayEligibility(
          feb29BirthDate,
          new Date(Date.UTC(year - 1, 0, 1, 0, 0, 0, 0)),
          evalDate,
        );
        expect(res.birthdayThisYear.getUTCDate()).toBe(29);
      }
    });

    it("verifies exact 30-day lockout boundary for Feb 29 birthday in leap vs non-leap years", () => {
      const feb29Birth = "2000-02-29";

      // Non-leap year 2026: Birthday clamped to Feb 28.
      // Jan 29, 2026 -> Feb 28, 2026 = 30 days (Jan has 31 days: 2 days in Jan + 28 days in Feb = 30 days) -> ELIGIBLE
      const res2026Eligible = checkBirthdayEligibility(
        feb29Birth,
        "2026-01-29T00:00:00Z",
        new Date("2026-02-28T00:00:00Z"),
      );
      expect(res2026Eligible.leadTimeDays).toBe(30);
      expect(res2026Eligible.isEligible).toBe(true);

      // Jan 30, 2026 -> Feb 28, 2026 = 29 days -> LOCKED OUT
      const res2026Locked = checkBirthdayEligibility(
        feb29Birth,
        "2026-01-30T00:00:00Z",
        new Date("2026-02-28T00:00:00Z"),
      );
      expect(res2026Locked.leadTimeDays).toBe(29);
      expect(res2026Locked.isEligible).toBe(false);
      expect(res2026Locked.isLockedOut).toBe(true);

      // Leap year 2028: Birthday is Feb 29.
      // Jan 30, 2028 -> Feb 29, 2028 = 30 days (1 day in Jan + 29 days in Feb = 30 days) -> ELIGIBLE
      const res2028Eligible = checkBirthdayEligibility(
        feb29Birth,
        "2028-01-30T00:00:00Z",
        new Date("2028-02-29T00:00:00Z"),
      );
      expect(res2028Eligible.leadTimeDays).toBe(30);
      expect(res2028Eligible.isEligible).toBe(true);

      // Jan 31, 2028 -> Feb 29, 2028 = 29 days -> LOCKED OUT
      const res2028Locked = checkBirthdayEligibility(
        feb29Birth,
        "2028-01-31T00:00:00Z",
        new Date("2028-02-29T00:00:00Z"),
      );
      expect(res2028Locked.leadTimeDays).toBe(29);
      expect(res2028Locked.isEligible).toBe(false);
      expect(res2028Locked.isLockedOut).toBe(true);
    });

    it("verifies resilience against extreme timezone offsets and UTC midnight day-boundary alignment", () => {
      const birthDate = "1990-07-04"; // July 4

      // Various ISO timezone strings for registration
      const testOffsets = [
        "2026-06-04T23:59:59.999+14:00", // Kiritimati (UTC+14) -> UTC is 2026-06-04 09:59:59
        "2026-06-04T00:00:00.001-12:00", // Baker Island (UTC-12) -> UTC is 2026-06-04 12:00:00
        "2026-06-04T18:30:00.000+05:30", // India (UTC+5:30) -> UTC is 2026-06-04 13:00:00
        "2026-06-04T23:59:59.000Z", // UTC 23:59:59
        "2026-06-04T00:00:01.000Z", // UTC 00:00:01
      ];

      for (const regIso of testOffsets) {
        // June 4 to July 4 is 30 days (June has 30 days)
        const res = checkBirthdayEligibility(
          birthDate,
          regIso,
          new Date("2026-07-04T12:00:00Z"),
        );
        expect(res.leadTimeDays).toBe(30);
        expect(res.isEligible).toBe(true);
      }
    });

    it("verifies year-end and year-start calendar boundary transitions (Dec 31 to Jan 1)", () => {
      // Birthday on January 1
      const jan1Birth = "1994-01-01";

      // Evaluation at Dec 31, 2026 23:59:59Z (current year is 2026)
      const evalDec31 = new Date("2026-12-31T23:59:59.999Z");
      // Reg on Dec 1, 2025 (well in advance)
      const resDec31 = checkBirthdayEligibility(
        jan1Birth,
        "2025-12-01T00:00:00Z",
        evalDec31,
      );
      expect(resDec31.calendarYear).toBe(2026);
      expect(resDec31.birthdayThisYear.toISOString()).toBe(
        "2026-01-01T00:00:00.000Z",
      );

      // Evaluation at Jan 1, 2027 00:00:00Z (current year is 2027)
      const evalJan1 = new Date("2027-01-01T00:00:00.000Z");
      const resJan1 = checkBirthdayEligibility(
        jan1Birth,
        "2025-12-01T00:00:00Z",
        evalJan1,
      );
      expect(resJan1.calendarYear).toBe(2027);
      expect(resJan1.birthdayThisYear.toISOString()).toBe(
        "2027-01-01T00:00:00.000Z",
      );
      expect(resJan1.isEligible).toBe(true);
    });
  });

  // =========================================================================
  // SCOPE 2: Rapid Concurrent Welcome Bonus Claims & Sequence Monotonicity
  // =========================================================================
  describe("Scope 2: Rapid Concurrent Welcome Bonus Claims & Sequence Monotonicity", () => {
    it("empirically verifies concurrency safety: 50 concurrent welcome bonus requests result in exactly 1 write", async () => {
      const storeId = "store_concurrent_test";
      const accountId = "wacc_concurrent_user";
      const idempotencyKey = `signup:${accountId}`;

      // In-memory simulated database state for concurrency harness
      let accountBalance = BigInt(0);
      let accountLifetimeEarned = BigInt(0);
      const ledgerEntries: any[] = [];
      const writtenKeys = new Set<string>();

      // Mock findUnique for idempotency
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockImplementation(
        async ({ where }: any) => {
          const key = where.storeId_idempotencyKey?.idempotencyKey;
          return ledgerEntries.find((e) => e.idempotencyKey === key) ?? null;
        },
      );

      // Mock account lookup
      (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
        async () => {
          return {
            id: accountId,
            storeId,
            cachedPointsBalance: accountBalance,
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: accountLifetimeEarned,
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: ledgerEntries.length,
            status: "active",
          };
        },
      );

      // Mock findFirst for sequence
      (prisma.weleticPointsLedgerEntry.findFirst as any).mockImplementation(
        async () => {
          if (ledgerEntries.length === 0) return null;
          const last = ledgerEntries[ledgerEntries.length - 1];
          return {
            sequenceNumber: last.sequenceNumber,
            balanceAfter: last.balanceAfter,
          };
        },
      );

      // Mock create with atomic idempotency enforcement
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        async ({ data }: any) => {
          if (writtenKeys.has(data.idempotencyKey)) {
            throw new Error(
              `Unique constraint violation on storeId_idempotencyKey: ${data.idempotencyKey}`,
            );
          }
          writtenKeys.add(data.idempotencyKey);

          const newSeq = ledgerEntries.length + 1;
          const balAfter = accountBalance + data.pointsDelta;
          accountBalance = balAfter;
          accountLifetimeEarned += data.pointsDelta;

          const entry = {
            id: `wledger_${newSeq}`,
            ...data,
            sequenceNumber: newSeq,
            balanceAfter: balAfter,
            createdAt: new Date(),
          };
          ledgerEntries.push(entry);
          return entry;
        },
      );

      // Mock the OCC account projection update used by the production ledger.
      (prisma.weleticLoyaltyAccount.updateMany as any).mockImplementation(
        async ({ data }: any) => {
          accountBalance = data.cachedPointsBalance;
          accountLifetimeEarned = data.lifetimePointsEarned;
          return { count: 1 };
        },
      );

      // Execute 50 concurrent welcome bonus requests
      const concurrencyCount = 50;
      const promises = Array.from({ length: concurrencyCount }, () =>
        awardSignupWelcomeBonus({
          storeId,
          accountId,
          bonusPoints: 100,
        }),
      );

      const results = await Promise.allSettled(promises);

      // Verify that out of 50 concurrent requests, exactly 1 succeeded in writing,
      // and all other 49 concurrent race collisions were safely rejected by the atomic unique constraint.
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(fulfilled.length + rejected.length).toBe(concurrencyCount);

      // Exactly 1 physical ledger entry was created in the database (zero duplicate writes)
      expect(ledgerEntries.length).toBe(1);
      expect(ledgerEntries[0].idempotencyKey).toBe(idempotencyKey);
      expect(ledgerEntries[0].pointsDelta).toBe(BigInt(100));
      expect(ledgerEntries[0].balanceAfter).toBe(BigInt(100));
      expect(ledgerEntries[0].sequenceNumber).toBe(1);

      // Account balance is exactly 100 points (zero balance inflation from 50 concurrent attempts)
      expect(accountBalance).toBe(BigInt(100));
      expect(accountLifetimeEarned).toBe(BigInt(100));

      // Subsequent re-invocations (e.g. queue retry or user re-click) now find the existing entry idempotently
      const retryResult = await awardSignupWelcomeBonus({
        storeId,
        accountId,
        bonusPoints: 100,
      });
      expect(retryResult?.id).toBe(ledgerEntries[0].id);
      expect(ledgerEntries.length).toBe(1);
      expect(accountBalance).toBe(BigInt(100));
    });

    it("verifies strict ledger sequence monotonicity under interleaved concurrent bonus actions", async () => {
      const storeId = "store_interleave_test";
      const accountId = "wacc_interleave_user";

      let accountBalance = BigInt(0);
      let accountLifetimeEarned = BigInt(0);
      const ledgerEntries: any[] = [];
      const writtenKeys = new Set<string>();

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockImplementation(
        async ({ where }: any) => {
          const key = where.storeId_idempotencyKey?.idempotencyKey;
          return ledgerEntries.find((e) => e.idempotencyKey === key) ?? null;
        },
      );

      (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
        async () => {
          return {
            id: accountId,
            storeId,
            cachedPointsBalance: accountBalance,
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: accountLifetimeEarned,
            lifetimePointsRedeemed: BigInt(0),
            status: "active",
          };
        },
      );

      (prisma.weleticPointsLedgerEntry.findFirst as any).mockImplementation(
        async () => {
          if (ledgerEntries.length === 0) return null;
          const last = ledgerEntries[ledgerEntries.length - 1];
          return {
            sequenceNumber: last.sequenceNumber,
            balanceAfter: last.balanceAfter,
          };
        },
      );

      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        async ({ data }: any) => {
          if (writtenKeys.has(data.idempotencyKey)) {
            throw new Error(
              `Unique constraint violation: ${data.idempotencyKey}`,
            );
          }
          writtenKeys.add(data.idempotencyKey);

          const newSeq = ledgerEntries.length + 1;
          const balAfter = accountBalance + data.pointsDelta;
          accountBalance = balAfter;
          accountLifetimeEarned += data.pointsDelta;

          const entry = {
            id: `wledger_${newSeq}`,
            ...data,
            sequenceNumber: newSeq,
            balanceAfter: balAfter,
            createdAt: new Date(),
          };
          ledgerEntries.push(entry);
          return entry;
        },
      );

      (prisma.weleticLoyaltyAccount.update as any).mockImplementation(
        async ({ data }: any) => {
          accountBalance = data.cachedPointsBalance;
          accountLifetimeEarned = data.lifetimePointsEarned;
          return {};
        },
      );

      // Interleave actions sequentially:
      // 1. Welcome bonus (+100)
      const e1 = await awardSignupWelcomeBonus({
        storeId,
        accountId,
        bonusPoints: 100,
      });
      expect(e1?.sequenceNumber).toBe(1);
      expect(e1?.balanceAfter).toBe(BigInt(100));

      // 2. Activity: Instagram Follow (+50)
      const e2 = await awardActivityPoints({
        storeId,
        accountId,
        activityType: "instagram_follow",
        points: 50,
      });
      expect(e2?.sequenceNumber).toBe(2);
      expect(e2?.balanceAfter).toBe(BigInt(150));

      // 3. Activity: TikTok Follow (+50)
      const e3 = await awardActivityPoints({
        storeId,
        accountId,
        activityType: "tiktok_follow",
        points: 50,
      });
      expect(e3?.sequenceNumber).toBe(3);
      expect(e3?.balanceAfter).toBe(BigInt(200));

      // 4. Activity: Product Review 1 (+100)
      const e4 = await awardActivityPoints({
        storeId,
        accountId,
        activityType: "product_review",
        points: 100,
        externalId: "rev_001",
      });
      expect(e4?.sequenceNumber).toBe(4);
      expect(e4?.balanceAfter).toBe(BigInt(300));

      // 5. Birthday Reward 2026 (+250)
      const e5 = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate: "1993-08-20",
        rewardPoints: 250,
        now: new Date("2026-08-20T00:00:00Z"),
        enrollmentDate: "2026-01-01T00:00:00Z",
      });
      expect(e5.awarded).toBe(true);
      expect(e5.ledgerEntry?.sequenceNumber).toBe(5);
      expect(e5.ledgerEntry?.balanceAfter).toBe(BigInt(550));

      // Verify overall ledger monotonicity
      expect(ledgerEntries.length).toBe(5);
      for (let i = 0; i < ledgerEntries.length; i++) {
        expect(ledgerEntries[i].sequenceNumber).toBe(i + 1);
        if (i > 0) {
          expect(ledgerEntries[i].balanceAfter).toBe(
            ledgerEntries[i - 1].balanceAfter + ledgerEntries[i].pointsDelta,
          );
        }
      }
      expect(accountBalance).toBe(BigInt(550));
      expect(accountLifetimeEarned).toBe(BigInt(550));
    });
  });

  // =========================================================================
  // SCOPE 3: Cross-Calendar-Year Transitions & Duplicate Claim Attempts
  // =========================================================================
  describe("Scope 3: Cross-Calendar-Year Transitions & Duplicate Claim Attempts", () => {
    it("simulates a multi-year customer lifecycle with lockout in year 1, successful awards in years 2-5, and duplicate rejections", async () => {
      const storeId = "store_multiyear";
      const accountId = "wacc_multiyear_shopper";
      const birthDate = "1996-03-15"; // March 15
      const enrollmentDate = "2025-03-01"; // Registered March 1, 2025 (only 14 days before 2025 birthday -> LOCKED OUT)

      let currentBalance = BigInt(0);
      let lifetimeEarned = BigInt(0);
      const ledgerEntries: any[] = [];
      const writtenKeys = new Set<string>();

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockImplementation(
        async ({ where }: any) => {
          const key = where.storeId_idempotencyKey?.idempotencyKey;
          return ledgerEntries.find((e) => e.idempotencyKey === key) ?? null;
        },
      );

      (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
        async () => {
          return {
            id: accountId,
            storeId,
            cachedPointsBalance: currentBalance,
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: lifetimeEarned,
            lifetimePointsRedeemed: BigInt(0),
            status: "active",
          };
        },
      );

      (prisma.weleticPointsLedgerEntry.findFirst as any).mockImplementation(
        async () => {
          if (ledgerEntries.length === 0) return null;
          const last = ledgerEntries[ledgerEntries.length - 1];
          return {
            sequenceNumber: last.sequenceNumber,
            balanceAfter: last.balanceAfter,
          };
        },
      );

      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        async ({ data }: any) => {
          if (writtenKeys.has(data.idempotencyKey)) {
            throw new Error(`Duplicate key: ${data.idempotencyKey}`);
          }
          writtenKeys.add(data.idempotencyKey);

          const newSeq = ledgerEntries.length + 1;
          const balAfter = currentBalance + data.pointsDelta;
          currentBalance = balAfter;
          lifetimeEarned += data.pointsDelta;

          const entry = {
            id: `wledger_${newSeq}`,
            ...data,
            sequenceNumber: newSeq,
            balanceAfter: balAfter,
            createdAt: new Date(),
          };
          ledgerEntries.push(entry);
          return entry;
        },
      );

      (prisma.weleticLoyaltyAccount.update as any).mockImplementation(
        async ({ data }: any) => {
          currentBalance = data.cachedPointsBalance;
          lifetimeEarned = data.lifetimePointsEarned;
          return {};
        },
      );

      // --- Year 1: 2025 (Locked out due to registration 14 days before birthday) ---
      const res2025 = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate,
        rewardPoints: 200,
        now: new Date("2025-03-15T00:00:00Z"),
        enrollmentDate,
      });
      expect(res2025.awarded).toBe(false);
      expect(res2025.isLockedOut).toBe(true);
      expect(res2025.calendarYear).toBe(2025);
      expect(res2025.nextEligibleYear).toBe(2026);
      expect(ledgerEntries.length).toBe(0);

      // --- Year 2: 2026 (Eligible: registered in 2025, lead time ~379 days) ---
      const res2026 = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate,
        rewardPoints: 200,
        now: new Date("2026-03-15T00:00:00Z"),
        enrollmentDate,
      });
      expect(res2026.awarded).toBe(true);
      expect(res2026.isLockedOut).toBe(false);
      expect(res2026.isDuplicate).toBe(false);
      expect(res2026.calendarYear).toBe(2026);
      expect(ledgerEntries.length).toBe(1);
      expect(currentBalance).toBe(BigInt(200));

      // --- Year 2 Duplicate: Second claim attempt in 2026 ---
      const res2026Dup = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate,
        rewardPoints: 200,
        now: new Date("2026-03-20T00:00:00Z"),
        enrollmentDate,
      });
      expect(res2026Dup.awarded).toBe(true);
      expect(res2026Dup.isDuplicate).toBe(true);
      expect(res2026Dup.ledgerEntry?.id).toBe(ledgerEntries[0].id);
      expect(ledgerEntries.length).toBe(1);
      expect(currentBalance).toBe(BigInt(200));

      // --- Year 3: 2027 (Eligible) ---
      const res2027 = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate,
        rewardPoints: 200,
        now: new Date("2027-03-15T00:00:00Z"),
        enrollmentDate,
      });
      expect(res2027.awarded).toBe(true);
      expect(res2027.calendarYear).toBe(2027);
      expect(ledgerEntries.length).toBe(2);
      expect(currentBalance).toBe(BigInt(400));

      // --- Year 4: 2028 (Leap Year) ---
      const res2028 = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate,
        rewardPoints: 200,
        now: new Date("2028-03-15T00:00:00Z"),
        enrollmentDate,
      });
      expect(res2028.awarded).toBe(true);
      expect(res2028.calendarYear).toBe(2028);
      expect(ledgerEntries.length).toBe(3);
      expect(currentBalance).toBe(BigInt(600));

      // --- Year 5: 2029 (Eligible) ---
      const res2029 = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate,
        rewardPoints: 200,
        now: new Date("2029-03-15T00:00:00Z"),
        enrollmentDate,
      });
      expect(res2029.awarded).toBe(true);
      expect(res2029.calendarYear).toBe(2029);
      expect(ledgerEntries.length).toBe(4);
      expect(currentBalance).toBe(BigInt(800));
      expect(lifetimeEarned).toBe(BigInt(800));
    });
  });

  // =========================================================================
  // SCOPE 4: Activity Points Parameter Fuzzing & Uniqueness
  // =========================================================================
  describe("Scope 4: Activity Points Parameter Fuzzing & Uniqueness", () => {
    it("normalizes activity types with varied casing and whitespace", async () => {
      const storeId = "store_fuzz";
      const accountId = "wacc_fuzz_user";

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValue({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        status: "active",
      });
      (prisma.weleticPointsLedgerEntry.findFirst as any).mockResolvedValue(
        null,
      );
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        async ({ data }: any) => {
          return {
            id: "wledger_fuzz_1",
            ...data,
            sequenceNumber: 1,
            balanceAfter: data.pointsDelta,
          };
        },
      );

      // Pass noisy casing and whitespace
      const entry = await awardActivityPoints({
        storeId,
        accountId,
        activityType: "   TIKTOK_FOLLOW   ",
        points: 50,
      });

      expect(entry).toBeDefined();
      expect(entry?.idempotencyKey).toBe(
        `activity:tiktok_follow:${accountId}:default`,
      );
      expect(entry?.referenceType).toBe("ACTIVITY_TIKTOK_FOLLOW");
      expect(entry?.pointsDelta).toBe(BigInt(50));
    });

    it("handles complex review external IDs and prevents cross-review collisions", async () => {
      const storeId = "store_fuzz";
      const accountId = "wacc_fuzz_user";
      const reviewA = "loox_review_uuid-1234-5678";
      const reviewB = "loox_review_uuid-9999-0000";

      const createdEntries: any[] = [];
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockImplementation(
        async ({ where }: any) => {
          const key = where.storeId_idempotencyKey?.idempotencyKey;
          return createdEntries.find((e) => e.idempotencyKey === key) ?? null;
        },
      );

      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValue({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        status: "active",
      });

      (prisma.weleticPointsLedgerEntry.findFirst as any).mockImplementation(
        async () => {
          if (createdEntries.length === 0) return null;
          return createdEntries[createdEntries.length - 1];
        },
      );

      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        async ({ data }: any) => {
          const entry = {
            id: `wledger_${createdEntries.length + 1}`,
            ...data,
            sequenceNumber: createdEntries.length + 1,
            balanceAfter: BigInt(100 * (createdEntries.length + 1)),
          };
          createdEntries.push(entry);
          return entry;
        },
      );

      // Award for Review A
      const eA = await awardActivityPoints({
        storeId,
        accountId,
        activityType: "product_review",
        points: 100,
        externalId: reviewA,
      });

      // Award for Review B
      const eB = await awardActivityPoints({
        storeId,
        accountId,
        activityType: "product_review",
        points: 100,
        externalId: reviewB,
      });

      // Re-award for Review A (duplicate)
      const eADup = await awardActivityPoints({
        storeId,
        accountId,
        activityType: "product_review",
        points: 100,
        externalId: reviewA,
      });

      expect(eA?.idempotencyKey).toBe(
        `activity:product_review:${accountId}:${reviewA}`,
      );
      expect(eB?.idempotencyKey).toBe(
        `activity:product_review:${accountId}:${reviewB}`,
      );
      expect(eADup?.id).toBe(eA?.id); // Reuses existing entry
      expect(createdEntries.length).toBe(2); // Only 2 distinct entries created
    });

    it("rejects zero and negative points inputs safely across all non-purchase methods", async () => {
      const storeId = "store_fuzz";
      const accountId = "wacc_fuzz_user";

      // Signup bonus
      expect(
        await awardSignupWelcomeBonus({ storeId, accountId, bonusPoints: 0 }),
      ).toBeNull();
      expect(
        await awardSignupWelcomeBonus({
          storeId,
          accountId,
          bonusPoints: -100,
        }),
      ).toBeNull();

      // Activity bonus
      expect(
        await awardActivityPoints({
          storeId,
          accountId,
          activityType: "share",
          points: 0,
        }),
      ).toBeNull();
      expect(
        await awardActivityPoints({
          storeId,
          accountId,
          activityType: "share",
          points: -50,
        }),
      ).toBeNull();

      // Birthday reward
      const bdayResZero = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate: "1990-01-01",
        rewardPoints: 0,
      });
      expect(bdayResZero.awarded).toBe(false);
      expect(bdayResZero.reason).toContain("greater than zero");

      const bdayResNeg = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate: "1990-01-01",
        rewardPoints: -200,
      });
      expect(bdayResNeg.awarded).toBe(false);
      expect(bdayResNeg.reason).toContain("greater than zero");
    });

    it("verifies multi-tenant store isolation: bonuses for same account across different stores do not collide", async () => {
      const storeA = "store_yamax_us";
      const storeB = "store_yamax_jp";
      const accountId = "wacc_cross_store";

      const storeEntries: Record<string, any[]> = {
        [storeA]: [],
        [storeB]: [],
      };

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockImplementation(
        async ({ where }: any) => {
          const { storeId, idempotencyKey } = where.storeId_idempotencyKey;
          return (
            storeEntries[storeId]?.find(
              (e) => e.idempotencyKey === idempotencyKey,
            ) ?? null
          );
        },
      );

      (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
        async ({ where }: any) => {
          return {
            id: where.id,
            cachedPointsBalance: BigInt(0),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(0),
            lifetimePointsRedeemed: BigInt(0),
            status: "active",
          };
        },
      );

      (prisma.weleticPointsLedgerEntry.findFirst as any).mockResolvedValue(
        null,
      );

      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        async ({ data }: any) => {
          const entry = {
            id: `wledger_${data.storeId}_${storeEntries[data.storeId].length + 1}`,
            ...data,
            sequenceNumber: 1,
            balanceAfter: data.pointsDelta,
          };
          storeEntries[data.storeId].push(entry);
          return entry;
        },
      );

      // Award welcome bonus on Store A
      const entryStoreA = await awardSignupWelcomeBonus({
        storeId: storeA,
        accountId,
        bonusPoints: 100,
      });

      // Award welcome bonus on Store B
      const entryStoreB = await awardSignupWelcomeBonus({
        storeId: storeB,
        accountId,
        bonusPoints: 150,
      });

      expect(entryStoreA?.storeId).toBe(storeA);
      expect(entryStoreA?.pointsDelta).toBe(BigInt(100));
      expect(entryStoreB?.storeId).toBe(storeB);
      expect(entryStoreB?.pointsDelta).toBe(BigInt(150));

      expect(storeEntries[storeA].length).toBe(1);
      expect(storeEntries[storeB].length).toBe(1);
    });

    it("verifies rapid concurrent birthday claims: 20 concurrent claims produce exactly 1 award and 0 duplicate balance inflations", async () => {
      const storeId = "store_bday_concurrent";
      const accountId = "wacc_bday_race";
      const birthDate = "1991-11-20";
      const enrollmentDate = "2026-01-01T00:00:00Z";
      const now = new Date("2026-11-20T00:00:00Z");

      let accountBalance = BigInt(0);
      let accountLifetimeEarned = BigInt(0);
      const ledgerEntries: any[] = [];
      const writtenKeys = new Set<string>();

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockImplementation(
        async ({ where }: any) => {
          const key = where.storeId_idempotencyKey?.idempotencyKey;
          return ledgerEntries.find((e) => e.idempotencyKey === key) ?? null;
        },
      );

      (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
        async () => {
          return {
            id: accountId,
            storeId,
            cachedPointsBalance: accountBalance,
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: accountLifetimeEarned,
            lifetimePointsRedeemed: BigInt(0),
            status: "active",
          };
        },
      );

      (prisma.weleticPointsLedgerEntry.findFirst as any).mockImplementation(
        async () => {
          if (ledgerEntries.length === 0) return null;
          const last = ledgerEntries[ledgerEntries.length - 1];
          return {
            sequenceNumber: last.sequenceNumber,
            balanceAfter: last.balanceAfter,
          };
        },
      );

      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        async ({ data }: any) => {
          if (writtenKeys.has(data.idempotencyKey)) {
            throw new Error(
              `Unique constraint violation on storeId_idempotencyKey: ${data.idempotencyKey}`,
            );
          }
          writtenKeys.add(data.idempotencyKey);

          const newSeq = ledgerEntries.length + 1;
          const balAfter = accountBalance + data.pointsDelta;
          accountBalance = balAfter;
          accountLifetimeEarned += data.pointsDelta;

          const entry = {
            id: `wledger_${newSeq}`,
            ...data,
            sequenceNumber: newSeq,
            balanceAfter: balAfter,
            createdAt: new Date(),
          };
          ledgerEntries.push(entry);
          return entry;
        },
      );

      (prisma.weleticLoyaltyAccount.update as any).mockImplementation(
        async ({ data }: any) => {
          accountBalance = data.cachedPointsBalance;
          accountLifetimeEarned = data.lifetimePointsEarned;
          return {};
        },
      );

      // Launch 20 concurrent birthday claims
      const promises = Array.from({ length: 20 }, () =>
        awardBirthdayReward({
          storeId,
          accountId,
          birthDate,
          rewardPoints: 300,
          now,
          enrollmentDate,
        }),
      );

      const results = await Promise.allSettled(promises);

      // Exactly 1 physical write in database
      expect(ledgerEntries.length).toBe(1);
      expect(ledgerEntries[0].idempotencyKey).toBe(
        `birthday:${accountId}:2026`,
      );
      expect(ledgerEntries[0].pointsDelta).toBe(BigInt(300));
      expect(accountBalance).toBe(BigInt(300));

      // Subsequent sequential call is handled cleanly as duplicate
      const followup = await awardBirthdayReward({
        storeId,
        accountId,
        birthDate,
        rewardPoints: 300,
        now,
        enrollmentDate,
      });
      expect(followup.awarded).toBe(true);
      expect(followup.isDuplicate).toBe(true);
      expect(followup.ledgerEntry?.id).toBe(ledgerEntries[0].id);
      expect(ledgerEntries.length).toBe(1);
      expect(accountBalance).toBe(BigInt(300));
    });

    it("verifies BigInt precision with large point values without numeric truncation", async () => {
      const storeId = "store_bigint";
      const accountId = "wacc_whale";
      const largePoints = BigInt("1000000000000"); // 1 Trillion points

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValue({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        status: "active",
      });
      (prisma.weleticPointsLedgerEntry.findFirst as any).mockResolvedValue(
        null,
      );
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        async ({ data }: any) => {
          return {
            id: "wledger_large",
            ...data,
            sequenceNumber: 1,
            balanceAfter: data.pointsDelta,
          };
        },
      );

      const entry = await awardActivityPoints({
        storeId,
        accountId,
        activityType: "vip_custom_bounty",
        points: largePoints,
        externalId: "bounty_999",
      });

      expect(entry?.pointsDelta).toBe(largePoints);
      expect(entry?.balanceAfter).toBe(largePoints);
    });
  });
});
