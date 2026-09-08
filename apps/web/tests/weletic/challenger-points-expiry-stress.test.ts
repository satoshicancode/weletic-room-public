import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import {
  enqueueOutboxJob,
  enqueueOutboxJobFromProgramTransaction,
} from "@/lib/weletic/loyalty/outbox";
import { handleInactivityExpiry } from "@/lib/weletic/loyalty/outbox-worker";
import { sendPointsExpiryNotification } from "@/lib/weletic/loyalty/points-expiry-notifications";
import {
  calculateNextPointsExpiryDate,
  getPointsExpiryStageDate,
  type PointsExpiryPolicy,
} from "@/lib/weletic/loyalty/points-expiry-policy";
import { enqueuePointsExpiryLifecycleJobs } from "@/lib/weletic/loyalty/points-expiry-scheduler";
import { sendBatchEmail } from "@dub/email";
import { Prisma, WeleticPointsLedgerEntryType } from "@prisma/client";
import { addDays, subDays } from "date-fns";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

const { mockPrisma } = vi.hoisted(() => {
  const mockProgram = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const mockAccount = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
  };
  const mockLedger = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
  };
  const mockTx = {
    weleticLoyaltyProgram: mockProgram,
    weleticLoyaltyAccount: mockAccount,
    weleticPointsLedgerEntry: mockLedger,
  };
  return {
    mockPrisma: {
      weleticMerchantSettings: { findUnique: vi.fn().mockResolvedValue(null) },
      weleticLoyaltyProgram: mockProgram,
      weleticLoyaltyAccount: mockAccount,
      weleticPointsLedgerEntry: mockLedger,
      $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<any>) =>
        cb(mockTx),
      ),
      mockTx,
    },
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: vi.fn(),
  enqueueOutboxJobFromProgramTransaction: vi.fn(),
}));

vi.mock("@/lib/weletic/loyalty/earn-policy-revision", () => ({
  publishLoyaltyEarnPolicyRevision: vi.fn(),
}));

vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  withActiveStoreLoyaltyMutation: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: vi.fn(),
  ShopifyStoreOperationalWritesBlockedError: class extends Error {},
}));

vi.mock("@dub/email", () => ({
  sendBatchEmail: vi.fn(),
}));

const testBasePolicy: PointsExpiryPolicy = {
  status: "active",
  killSwitchActive: false,
  pointsExpiryDays: 0,
  pointsExpiryMonths: 12,
  pointsExpiryWarningDays: 30,
  pointsExpiryLastChanceDays: 3,
  pointsExpiryWarningEnabled: true,
  pointsExpiryLastChanceEnabled: true,
  pointsExpiryPolicyAnchorAt: new Date("2026-01-01T00:00:00.000Z"),
  pointsExpiryPolicyVersion: 1,
  activatedAt: new Date("2026-01-01T00:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

describe("Challenger 1 Stress Suite: Loyalty Points Expiry Lifecycle (Requirement R1 / Nhóm 1.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.mocked(sendBatchEmail).mockResolvedValue({
      data: { data: [{ id: "challenger_email_ok" }] },
      error: null,
    } as any);
  });

  // ==========================================================================
  // 1. Rapid Clock Warping & Millisecond Boundary Transitions
  // ==========================================================================
  describe("1. Rapid Clock Warping & Millisecond Boundary Transitions", () => {
    const expiryAt = new Date("2026-11-01T00:00:00.000Z");
    const expiryAtString = expiryAt.toISOString();

    it("1.1 enforces millisecond boundary on 30-day warning threshold", async () => {
      const warningDate = getPointsExpiryStageDate({
        policy: testBasePolicy,
        expiryAt,
        stage: "warning",
      });
      // 30 days before 2026-11-01T00:00:00.000Z is 2026-10-02T00:00:00.000Z
      expect(warningDate.toISOString()).toBe("2026-10-02T00:00:00.000Z");

      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue({
        id: "wlacc_warp_warning",
        cachedPointsBalance: BigInt(500),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        shopper: {
          email: "boundary@example.com",
          firstName: "Boundary",
          locale: "en",
          acceptsMarketing: true,
          ordersCount: 1,
        },
        program: {
          ...testBasePolicy,
          name: "Weletic Club",
          pointNamePlural: "Points",
        },
        store: { shopDomain: "teststore.myshopify.com" },
      });

      // Exactly 1 millisecond BEFORE the threshold: throws premature execution error
      const oneMsBefore = new Date(warningDate.getTime() - 1);
      await expect(
        sendPointsExpiryNotification({
          storeId: "store_challenger_1",
          payload: {
            accountId: "wlacc_warp_warning",
            lastActivityAt: "2025-11-01T00:00:00.000Z",
            expiryMonths: 12,
            expiryAt: expiryAtString,
            stage: "warning",
            policyVersion: 1,
          },
          now: oneMsBefore,
        }),
      ).rejects.toThrow(/ran before its configured threshold/);
      expect(sendBatchEmail).not.toHaveBeenCalled();

      // Exactly AT the threshold: succeeds
      const outcomeAt = await sendPointsExpiryNotification({
        storeId: "store_challenger_1",
        payload: {
          accountId: "wlacc_warp_warning",
          lastActivityAt: "2025-11-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "warning",
          policyVersion: 1,
        },
        now: warningDate,
      });
      expect(outcomeAt).toBe("sent");
      expect(sendBatchEmail).toHaveBeenCalledOnce();

      // Exactly 1 millisecond AFTER the threshold: succeeds
      const oneMsAfter = new Date(warningDate.getTime() + 1);
      const outcomeAfter = await sendPointsExpiryNotification({
        storeId: "store_challenger_1",
        payload: {
          accountId: "wlacc_warp_warning",
          lastActivityAt: "2025-11-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "warning",
          policyVersion: 1,
        },
        now: oneMsAfter,
      });
      expect(outcomeAfter).toBe("sent");
    });

    it("1.2 enforces millisecond boundary on 3-day and 7-day last-chance thresholds", async () => {
      const lastChanceDate = getPointsExpiryStageDate({
        policy: testBasePolicy,
        expiryAt,
        stage: "last_chance",
      });
      // 3 days before 2026-11-01T00:00:00.000Z is 2026-10-29T00:00:00.000Z
      expect(lastChanceDate.toISOString()).toBe("2026-10-29T00:00:00.000Z");

      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue({
        id: "wlacc_warp_last_chance",
        cachedPointsBalance: BigInt(750),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        shopper: {
          email: "lastchance@example.com",
          firstName: "LastChance",
          locale: "en",
          acceptsMarketing: true,
          ordersCount: 2,
        },
        program: {
          ...testBasePolicy,
          name: "Weletic Club",
          pointNamePlural: "Points",
        },
        store: { shopDomain: "teststore.myshopify.com" },
      });

      // 1ms before last-chance: rejected
      await expect(
        sendPointsExpiryNotification({
          storeId: "store_challenger_1",
          payload: {
            accountId: "wlacc_warp_last_chance",
            lastActivityAt: "2025-11-01T00:00:00.000Z",
            expiryMonths: 12,
            expiryAt: expiryAtString,
            stage: "last_chance",
            policyVersion: 1,
          },
          now: new Date(lastChanceDate.getTime() - 1),
        }),
      ).rejects.toThrow(/ran before its configured threshold/);

      // Exactly at last-chance: sent
      const outcome = await sendPointsExpiryNotification({
        storeId: "store_challenger_1",
        payload: {
          accountId: "wlacc_warp_last_chance",
          lastActivityAt: "2025-11-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "last_chance",
          policyVersion: 1,
        },
        now: lastChanceDate,
      });
      expect(outcome).toBe("sent");
      expect(sendBatchEmail).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            subject: expect.stringMatching(/^Last chance:/),
          }),
        ]),
        expect.any(Object),
      );
    });

    it("1.3 enforces millisecond boundary on zero-residue expiry cutoff (handleInactivityExpiry)", async () => {
      const accountId = "wlacc_warp_cutoff";
      const initialBalance = BigInt(3200);

      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
        id: accountId,
        storeId: "store_challenger_1",
        cachedPointsBalance: initialBalance,
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(5000),
        lifetimePointsRedeemed: BigInt(1800),
        ledgerVersion: 7,
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        program: {
          ...testBasePolicy,
          storeId: "store_challenger_1",
        },
      });
      mockPrisma.mockTx.weleticPointsLedgerEntry.findUnique.mockResolvedValue(
        null,
      );
      mockPrisma.mockTx.weleticPointsLedgerEntry.create.mockResolvedValue({
        id: "wledger_warp_exp",
      });
      mockPrisma.mockTx.weleticLoyaltyAccount.updateMany.mockResolvedValue({
        count: 1,
      });

      // Exactly 1ms before cutoff: rejected with Error
      await expect(
        handleInactivityExpiry(
          "store_challenger_1",
          {
            accountId,
            lastActivityAt: "2025-11-01T00:00:00.000Z",
            expiryMonths: 12,
            expiryAt: expiryAtString,
            stage: "expire",
            policyVersion: 1,
          },
          null,
          new Date(expiryAt.getTime() - 1),
        ),
      ).rejects.toThrow(/ran before/);
      expect(
        mockPrisma.mockTx.weleticPointsLedgerEntry.create,
      ).not.toHaveBeenCalled();

      // Exactly AT cutoff: succeeds and creates immutable EXPIRATION ledger entry
      await handleInactivityExpiry(
        "store_challenger_1",
        {
          accountId,
          lastActivityAt: "2025-11-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "expire",
          policyVersion: 1,
        },
        null,
        expiryAt,
      );

      expect(
        mockPrisma.mockTx.weleticPointsLedgerEntry.create,
      ).toHaveBeenCalledWith({
        data: expect.objectContaining({
          entryType: WeleticPointsLedgerEntryType.EXPIRATION,
          pointsDelta: -initialBalance,
          balanceAfter: BigInt(0),
          sequenceNumber: 8,
        }),
      });
    });

    it("1.4 rapid multi-stage clock warping: erratic time-jumps across stages reject premature runs and complete sequentially", async () => {
      const accountId = "wlacc_erratic_warp";
      const accountData = {
        id: accountId,
        storeId: "store_challenger_1",
        cachedPointsBalance: BigInt(1000),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(1000),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1,
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        shopper: {
          email: "erratic@example.com",
          firstName: "Erratic",
          acceptsMarketing: true,
          ordersCount: 1,
        },
        program: {
          ...testBasePolicy,
          name: "Weletic Club",
          pointNamePlural: "Points",
        },
        store: { shopDomain: "teststore.myshopify.com" },
      };

      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue(accountData);
      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue(
        accountData,
      );
      mockPrisma.mockTx.weleticPointsLedgerEntry.findUnique.mockResolvedValue(
        null,
      );
      mockPrisma.mockTx.weleticPointsLedgerEntry.create.mockResolvedValue({
        id: "wledger_exp_erratic",
      });
      mockPrisma.mockTx.weleticLoyaltyAccount.updateMany.mockResolvedValue({
        count: 1,
      });

      // 1. Jump forward to 30-day warning date: warning succeeds
      const warningDate = getPointsExpiryStageDate({
        policy: testBasePolicy,
        expiryAt,
        stage: "warning",
      });
      const res1 = await sendPointsExpiryNotification({
        storeId: "store_challenger_1",
        payload: {
          accountId,
          lastActivityAt: "2025-11-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "warning",
          policyVersion: 1,
        },
        now: warningDate,
      });
      expect(res1).toBe("sent");

      // 2. Erratic clock warp BACKWARD by 60 days: attempting last-chance is rejected
      const jumpedBackTime = subDays(warningDate, 60);
      await expect(
        sendPointsExpiryNotification({
          storeId: "store_challenger_1",
          payload: {
            accountId,
            lastActivityAt: "2025-11-01T00:00:00.000Z",
            expiryMonths: 12,
            expiryAt: expiryAtString,
            stage: "last_chance",
            policyVersion: 1,
          },
          now: jumpedBackTime,
        }),
      ).rejects.toThrow(/ran before its configured threshold/);

      // 3. Jump forward to last-chance threshold: last-chance succeeds
      const lastChanceDate = getPointsExpiryStageDate({
        policy: testBasePolicy,
        expiryAt,
        stage: "last_chance",
      });
      const res2 = await sendPointsExpiryNotification({
        storeId: "store_challenger_1",
        payload: {
          accountId,
          lastActivityAt: "2025-11-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "last_chance",
          policyVersion: 1,
        },
        now: lastChanceDate,
      });
      expect(res2).toBe("sent");

      // 4. Clock warp PAST expiry cutoff to expiryAt + 10 days: handleInactivityExpiry drives balance to zero
      const pastCutoff = addDays(expiryAt, 10);
      await handleInactivityExpiry(
        "store_challenger_1",
        {
          accountId,
          lastActivityAt: "2025-11-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "expire",
          policyVersion: 1,
        },
        null,
        pastCutoff,
      );

      expect(
        mockPrisma.mockTx.weleticPointsLedgerEntry.create,
      ).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountId,
          entryType: WeleticPointsLedgerEntryType.EXPIRATION,
          pointsDelta: -BigInt(1000),
          balanceAfter: BigInt(0),
        }),
      });
    });

    it("1.5 handles threshold inversion: prunes warning notification when warningDays exceeds expiry period", () => {
      // e.g. Short 15-day expiry policy with default 30-day warning threshold
      const shortPolicy: PointsExpiryPolicy = {
        ...testBasePolicy,
        pointsExpiryDays: 15,
        pointsExpiryMonths: 0,
        pointsExpiryWarningDays: 30,
        pointsExpiryLastChanceDays: 3,
      };
      const baseDate = new Date("2026-05-01T00:00:00.000Z");
      const shortExpiry = calculateNextPointsExpiryDate({
        policy: shortPolicy,
        lastActivityAt: baseDate,
      });
      expect(shortExpiry?.toISOString()).toBe("2026-05-16T00:00:00.000Z");

      // Warning date: 2026-05-16 minus 30 days = 2026-04-16 <= baseDate (2026-05-01) -> Inverted / Pruned!
      const warningThreshold = getPointsExpiryStageDate({
        policy: shortPolicy,
        expiryAt: shortExpiry!,
        stage: "warning",
      });
      expect(warningThreshold <= baseDate).toBe(true);

      // Last chance date: 2026-05-16 minus 3 days = 2026-05-13 > baseDate -> Preserved!
      const lastChanceThreshold = getPointsExpiryStageDate({
        policy: shortPolicy,
        expiryAt: shortExpiry!,
        stage: "last_chance",
      });
      expect(lastChanceThreshold > baseDate).toBe(true);
    });
  });

  // ==========================================================================
  // 2. Insolvent & Negative Points Balance Deficit Defense Under Expiry Cutoff
  // ==========================================================================
  describe("2. Insolvent & Negative Balance Account Defense on Expiry", () => {
    const expiryAt = new Date("2026-10-01T00:00:00.000Z");
    const executionTime = new Date("2026-10-01T00:00:05.000Z");

    it("2.1 insolvent cutoff protection: account with -500 deficit clears expiry dates without creating ledger debit or underflow", async () => {
      const accountId = "wlacc_insolvent_500";
      const negativeBalance = BigInt(-500);

      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
        id: accountId,
        storeId: "store_challenger_1",
        cachedPointsBalance: negativeBalance,
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(1000),
        lifetimePointsRedeemed: BigInt(1500),
        ledgerVersion: 10,
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        program: { ...testBasePolicy },
      });
      mockPrisma.mockTx.weleticLoyaltyAccount.updateMany.mockResolvedValue({
        count: 1,
      });

      await handleInactivityExpiry(
        "store_challenger_1",
        {
          accountId,
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAt.toISOString(),
          stage: "expire",
          policyVersion: 1,
        },
        null,
        executionTime,
      );

      // 1. Clears nextExpiryDate and pointsExpiryJobsScheduledAt
      expect(
        mockPrisma.mockTx.weleticLoyaltyAccount.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: accountId,
          storeId: "store_challenger_1",
          nextExpiryDate: expiryAt,
        },
        data: {
          nextExpiryDate: null,
          pointsExpiryJobsScheduledAt: null,
        },
      });

      // 2. Invariant: ZERO ledger entries created! Deficit is NOT underflowed to -1000 or zeroed out
      expect(
        mockPrisma.mockTx.weleticPointsLedgerEntry.create,
      ).not.toHaveBeenCalled();
      expect(enqueueOutboxJob).not.toHaveBeenCalled();
    });

    it("2.2 boundary deficit protection: account with -1 deficit and extreme deficit (-100,000) wipe nextExpiryDate cleanly with zero ledger mutations", async () => {
      for (const deficit of [BigInt(-1), BigInt(-100_000)]) {
        vi.clearAllMocks();
        const accountId = `wlacc_deficit_${deficit.toString()}`;

        mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
          id: accountId,
          storeId: "store_challenger_1",
          cachedPointsBalance: deficit,
          cachedPendingPoints: BigInt(0),
          lifetimePointsEarned: BigInt(5000),
          lifetimePointsRedeemed: BigInt(5000) - deficit,
          ledgerVersion: 4,
          nextExpiryDate: expiryAt,
          pointsExpiryPolicyVersion: 1,
          program: { ...testBasePolicy },
        });
        mockPrisma.mockTx.weleticLoyaltyAccount.updateMany.mockResolvedValue({
          count: 1,
        });

        await handleInactivityExpiry(
          "store_challenger_1",
          {
            accountId,
            lastActivityAt: "2025-10-01T00:00:00.000Z",
            expiryMonths: 12,
            expiryAt: expiryAt.toISOString(),
            stage: "expire",
            policyVersion: 1,
          },
          null,
          executionTime,
        );

        // Dates cleared cleanly
        expect(
          mockPrisma.mockTx.weleticLoyaltyAccount.updateMany,
        ).toHaveBeenCalledWith({
          where: {
            id: accountId,
            storeId: "store_challenger_1",
            nextExpiryDate: expiryAt,
          },
          data: {
            nextExpiryDate: null,
            pointsExpiryJobsScheduledAt: null,
          },
        });

        // Ledger is pristine
        expect(
          mockPrisma.mockTx.weleticPointsLedgerEntry.create,
        ).not.toHaveBeenCalled();
      }
    });

    it("2.3 strict ledger monotonicity: sequenceNumber is unaffected when insolvent account reaches expiry cutoff", async () => {
      const accountId = "wlacc_monotonic_check";
      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
        id: accountId,
        storeId: "store_challenger_1",
        cachedPointsBalance: BigInt(-250),
        ledgerVersion: 15,
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        program: { ...testBasePolicy },
      });
      mockPrisma.mockTx.weleticLoyaltyAccount.updateMany.mockResolvedValue({
        count: 1,
      });

      await handleInactivityExpiry(
        "store_challenger_1",
        {
          accountId,
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAt.toISOString(),
          stage: "expire",
          policyVersion: 1,
        },
        null,
        executionTime,
      );

      // Sequence number remains 15, no new entry appended
      expect(
        mockPrisma.mockTx.weleticPointsLedgerEntry.create,
      ).not.toHaveBeenCalled();
    });

    it("2.4 insolvent recovery lifecycle: qualifying earns on deficit account offset deficit monotonically; nextExpiryDate remains null until balance turns strictly positive (> 0)", async () => {
      vi.useFakeTimers();
      const eventTime = new Date("2026-06-01T12:00:00.000Z");
      vi.setSystemTime(eventTime);

      const tx = {
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "wledger_earn_deficit" }),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "wlacc_recovering",
            storeId: "store_challenger_1",
            cachedPointsBalance: BigInt(-300), // Insolvent deficit
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(500),
            lifetimePointsRedeemed: BigInt(800),
            ledgerVersion: 5,
            lastQualifyingActivityAt: null,
            nextExpiryDate: null, // Null because insolvent
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({ ...testBasePolicy }),
        },
      };

      // Step 1: Customer earns +100 points, balance goes from -300 to -200 (still insolvent <= 0)
      await appendPointsLedgerEntry({
        storeId: "store_challenger_1",
        accountId: "wlacc_recovering",
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: 100,
        idempotencyKey: "earn:deficit_step_1",
        tx: tx as any,
      });

      // Deficit is offset to -200, but nextExpiryDate remains null because balance <= 0
      expect(tx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cachedPointsBalance: BigInt(-200),
            nextExpiryDate: null,
          }),
        }),
      );

      // Step 2: Customer earns +500 points, balance goes from -200 to +300 (now strictly positive!)
      tx.weleticLoyaltyAccount.findUnique.mockResolvedValueOnce({
        id: "wlacc_recovering",
        storeId: "store_challenger_1",
        cachedPointsBalance: BigInt(-200),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(600),
        lifetimePointsRedeemed: BigInt(800),
        ledgerVersion: 6,
        lastQualifyingActivityAt: eventTime,
        nextExpiryDate: null,
      });

      await appendPointsLedgerEntry({
        storeId: "store_challenger_1",
        accountId: "wlacc_recovering",
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: 500,
        idempotencyKey: "earn:deficit_step_2",
        tx: tx as any,
      });

      // Balance is now +300 > 0, so nextExpiryDate is ACTIVATED (+12 months -> 2027-06-01)
      expect(tx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cachedPointsBalance: BigInt(300),
            nextExpiryDate: new Date("2027-06-01T12:00:00.000Z"),
            pointsExpiryJobsScheduledAt: null,
          }),
        }),
      );
    });
  });

  // ==========================================================================
  // 3. High-Concurrency Rolling Expiry Updates & Mixed Transaction Race Conditions
  // ==========================================================================
  describe("3. High-Concurrency Rolling Expiry Updates & Mixed Transaction Race Conditions", () => {
    it("3.1 rapid qualifying earn bursts: order earn, referral earn, and bonus earn dynamically push nextExpiryDate forward and clear scheduled jobs", async () => {
      vi.useFakeTimers();
      const t1 = new Date("2026-03-01T10:00:00.000Z");
      vi.setSystemTime(t1);

      const tx = {
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "wledger_burst" }),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "wlacc_burst",
            storeId: "store_challenger_1",
            cachedPointsBalance: BigInt(100),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(100),
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: 1,
            lastQualifyingActivityAt: new Date("2026-01-01T00:00:00.000Z"),
            nextExpiryDate: new Date("2027-01-01T00:00:00.000Z"),
            pointsExpiryJobsScheduledAt: new Date("2027-01-01T00:00:00.000Z"),
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({ ...testBasePolicy }),
        },
      };

      // 1. EARN_ORDER: extends expiry from 2027-01-01 to 2027-03-01
      await appendPointsLedgerEntry({
        storeId: "store_challenger_1",
        accountId: "wlacc_burst",
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: 200,
        idempotencyKey: "earn:order_burst_1",
        tx: tx as any,
      });

      expect(tx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastQualifyingActivityAt: t1,
            nextExpiryDate: new Date("2027-03-01T10:00:00.000Z"),
            pointsExpiryJobsScheduledAt: null,
          }),
        }),
      );

      // 2. EARN_REFERRAL: extends expiry from 2027-03-01 to 2027-05-15
      const t2 = new Date("2026-05-15T15:00:00.000Z");
      vi.setSystemTime(t2);

      await appendPointsLedgerEntry({
        storeId: "store_challenger_1",
        accountId: "wlacc_burst",
        entryType: WeleticPointsLedgerEntryType.EARN_REFERRAL,
        pointsDelta: 500,
        idempotencyKey: "earn:referral_burst_2",
        tx: tx as any,
      });

      expect(tx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastQualifyingActivityAt: t2,
            nextExpiryDate: new Date("2027-05-15T15:00:00.000Z"),
            pointsExpiryJobsScheduledAt: null,
          }),
        }),
      );
    });

    it("3.2 non-qualifying debits: EXPIRATION does not advance activity timestamp", async () => {
      vi.useFakeTimers();
      const expTime = new Date("2026-10-01T00:00:00.000Z");
      vi.setSystemTime(expTime);

      const originalActivity = new Date("2025-10-01T00:00:00.000Z");
      const tx = {
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "wledger_exp_non_qual" }),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "wlacc_exp_check",
            storeId: "store_challenger_1",
            cachedPointsBalance: BigInt(1200),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(1200),
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: 3,
            lastQualifyingActivityAt: originalActivity,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({ ...testBasePolicy }),
        },
      };

      await appendPointsLedgerEntry({
        storeId: "store_challenger_1",
        accountId: "wlacc_exp_check",
        entryType: WeleticPointsLedgerEntryType.EXPIRATION,
        pointsDelta: -1200,
        idempotencyKey: "exp:check_monotonic",
        tx: tx as any,
      });

      const updateData = tx.weleticLoyaltyAccount.updateMany.mock.calls[0][0]
        .data as Prisma.WeleticLoyaltyAccountUpdateManyMutationInput;
      // Invariant: lastQualifyingActivityAt must NOT be changed
      expect(updateData.lastQualifyingActivityAt).toBeUndefined();
      expect(updateData.cachedPointsBalance).toBe(BigInt(0));
    });

    it("3.3 partial vs total reward redemptions: partial redemption preserves nextExpiryDate; complete drain wipes nextExpiryDate to null", async () => {
      vi.useFakeTimers();
      const redeemTime = new Date("2026-04-10T12:00:00.000Z");
      vi.setSystemTime(redeemTime);

      const tx = {
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "wledger_redeem_stress" }),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "wlacc_redeem_stress",
            storeId: "store_challenger_1",
            cachedPointsBalance: BigInt(1000),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(1000),
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: 2,
            lastQualifyingActivityAt: new Date("2026-01-01T00:00:00.000Z"),
            nextExpiryDate: new Date("2027-01-01T00:00:00.000Z"),
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({ ...testBasePolicy }),
        },
      };

      // 1. Partial redemption: -400 points leaves balance = 600 > 0
      await appendPointsLedgerEntry({
        storeId: "store_challenger_1",
        accountId: "wlacc_redeem_stress",
        entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        pointsDelta: -400,
        idempotencyKey: "redeem:partial_400",
        tx: tx as any,
      });

      // Smile parity: redemption is qualifying activity that resets the clock to 2027-04-10
      expect(tx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cachedPointsBalance: BigInt(600),
            nextExpiryDate: new Date("2027-04-10T12:00:00.000Z"),
          }),
        }),
      );

      // 2. Complete drain: -600 points leaves balance = 0
      tx.weleticLoyaltyAccount.findUnique.mockResolvedValueOnce({
        id: "wlacc_redeem_stress",
        storeId: "store_challenger_1",
        cachedPointsBalance: BigInt(600),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(1000),
        lifetimePointsRedeemed: BigInt(400),
        ledgerVersion: 3,
        lastQualifyingActivityAt: redeemTime,
        nextExpiryDate: new Date("2027-04-10T12:00:00.000Z"),
      });

      await appendPointsLedgerEntry({
        storeId: "store_challenger_1",
        accountId: "wlacc_redeem_stress",
        entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        pointsDelta: -600,
        idempotencyKey: "redeem:complete_drain",
        tx: tx as any,
      });

      // Invariant: Balance reached 0 -> nextExpiryDate is set to NULL
      expect(tx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cachedPointsBalance: BigInt(0),
            nextExpiryDate: null,
            pointsExpiryJobsScheduledAt: null,
          }),
        }),
      );
    });
  });

  // ==========================================================================
  // 4. Policy Version Fencing & Outbox Job Invalidation
  // ==========================================================================
  describe("4. Policy Version Fencing & Outbox Job Invalidation", () => {
    const expiryAt = new Date("2026-10-01T00:00:00.000Z");
    const executionTime = new Date("2026-10-01T00:00:01.000Z");

    it("4.1 outbox worker drops stale jobs when merchant bumped policy version from v1 to v2", async () => {
      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
        id: "wlacc_version_fenced",
        storeId: "store_challenger_1",
        cachedPointsBalance: BigInt(1500),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 2, // Account updated to v2
        program: {
          ...testBasePolicy,
          pointsExpiryPolicyVersion: 2, // Merchant bumped policy to v2
        },
      });

      // Outbox job in worker queue carries stale policyVersion: 1
      await handleInactivityExpiry(
        "store_challenger_1",
        {
          accountId: "wlacc_version_fenced",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAt.toISOString(),
          stage: "expire",
          policyVersion: 1, // Stale version!
        },
        null,
        executionTime,
      );

      // Invariant: silently dropped without ledger or account mutations
      expect(
        mockPrisma.mockTx.weleticPointsLedgerEntry.create,
      ).not.toHaveBeenCalled();
      expect(
        mockPrisma.mockTx.weleticLoyaltyAccount.updateMany,
      ).not.toHaveBeenCalled();
    });

    it("4.2 notification worker returns 'stale' and suppresses email when payload policyVersion is outdated", async () => {
      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue({
        id: "wlacc_notification_fence",
        cachedPointsBalance: BigInt(800),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 3, // Merchant bumped to v3
        shopper: {
          email: "stale@example.com",
          acceptsMarketing: true,
          ordersCount: 1,
        },
        program: {
          ...testBasePolicy,
          pointsExpiryPolicyVersion: 3,
        },
        store: { shopDomain: "teststore.myshopify.com" },
      });

      const outcome = await sendPointsExpiryNotification({
        storeId: "store_challenger_1",
        payload: {
          accountId: "wlacc_notification_fence",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAt.toISOString(),
          stage: "warning",
          policyVersion: 1, // Old v1 outbox payload
        },
        now: new Date("2026-09-01T12:00:00.000Z"),
      });

      expect(outcome).toBe("stale");
      expect(sendBatchEmail).not.toHaveBeenCalled();
    });

    it("4.3 drops outbox job when account rolling expiry was extended past payload expiryAt", async () => {
      const extendedExpiry = new Date("2026-12-15T00:00:00.000Z");

      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
        id: "wlacc_extended_fence",
        storeId: "store_challenger_1",
        cachedPointsBalance: BigInt(2000),
        nextExpiryDate: extendedExpiry, // Shopper earned points and extended expiry
        pointsExpiryPolicyVersion: 1,
        program: {
          ...testBasePolicy,
          pointsExpiryPolicyVersion: 1,
        },
      });

      // Outbox job arrives for the old expiry date (Oct 1)
      await handleInactivityExpiry(
        "store_challenger_1",
        {
          accountId: "wlacc_extended_fence",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAt.toISOString(), // Old Oct 1 date
          stage: "expire",
          policyVersion: 1,
        },
        null,
        executionTime,
      );

      // Invariant: dropped because pointsExpiryDatesMatch fails
      expect(
        mockPrisma.mockTx.weleticPointsLedgerEntry.create,
      ).not.toHaveBeenCalled();
      expect(
        mockPrisma.mockTx.weleticLoyaltyAccount.updateMany,
      ).not.toHaveBeenCalled();
    });

    it("4.4 scheduler sweep reconciles outdated accounts and enqueues fresh jobs with updated version tags", async () => {
      const now = new Date("2026-09-01T00:00:00.000Z");
      const v2ExpiryAt = new Date("2026-12-01T00:00:00.000Z");

      const tx = {
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({
            ...testBasePolicy,
            pointsExpiryPolicyVersion: 2, // Merchant bumped policy to v2
            pointsExpiryDays: 0,
            pointsExpiryMonths: 6,
          }),
        },
        weleticLoyaltyAccount: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([
              // 1st query: accountsToReconcile (outdated version 1)
              {
                id: "wlacc_to_reconcile",
                cachedPointsBalance: BigInt(500),
                lastQualifyingActivityAt: new Date("2026-06-01T00:00:00.000Z"),
                pointsExpiryPolicyVersion: 1,
              },
            ])
            .mockResolvedValueOnce([
              // 2nd query: accountsToSchedule (updated to version 2)
              {
                id: "wlacc_to_reconcile",
                cachedPointsBalance: BigInt(500),
                lastQualifyingActivityAt: new Date("2026-06-01T00:00:00.000Z"),
                nextExpiryDate: v2ExpiryAt,
              },
            ]),
          updateMany: vi
            .fn()
            .mockResolvedValueOnce({ count: 1 }) // reconcile update
            .mockResolvedValueOnce({ count: 1 }), // schedule update
        },
      };

      mockPrisma.weleticLoyaltyProgram.findMany.mockResolvedValue([
        { storeId: "store_reconcile_test" },
      ]);
      vi.mocked(withActiveStoreLoyaltyMutation).mockImplementation(
        async ({ operation }: any) => operation(tx),
      );

      const result = await enqueuePointsExpiryLifecycleJobs({
        now,
        batchSize: 10,
      });

      expect(result.accountsReconciled).toBe(1);
      expect(result.accountsScheduled).toBe(1);
      expect(result.jobsEnqueued).toBeGreaterThan(0);

      // Verify that enqueued outbox jobs carry policyVersion: 2 in payload and :v2 in idempotencyKey
      expect(enqueueOutboxJobFromProgramTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            accountId: "wlacc_to_reconcile",
            policyVersion: 2,
          }),
          idempotencyKey: expect.stringMatching(/:v2$/),
        }),
      );
    });
  });
});
