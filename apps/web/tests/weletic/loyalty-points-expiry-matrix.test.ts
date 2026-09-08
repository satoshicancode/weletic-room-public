import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import {
  enqueueOutboxJob,
  enqueueOutboxJobFromProgramTransaction,
  type InactivityExpiryPayload,
} from "@/lib/weletic/loyalty/outbox";
import { handleInactivityExpiry } from "@/lib/weletic/loyalty/outbox-worker";
import { sendPointsExpiryNotification } from "@/lib/weletic/loyalty/points-expiry-notifications";
import {
  getPointsExpiryStageDate,
  type PointsExpiryPolicy,
} from "@/lib/weletic/loyalty/points-expiry-policy";
import { enqueuePointsExpiryLifecycleJobs } from "@/lib/weletic/loyalty/points-expiry-scheduler";
import { sendBatchEmail } from "@dub/email";
import { Prisma, WeleticPointsLedgerEntryType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
}));

vi.mock("@dub/email", () => ({
  sendBatchEmail: vi.fn(),
}));

const basePolicy: PointsExpiryPolicy = {
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

describe("Weletic Loyalty Points Expiry Lifecycle Matrix (Requirement R1 / Nhóm 1.3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.mocked(sendBatchEmail).mockResolvedValue({
      data: { data: [{ id: "email_expiry_test" }] },
      error: null,
    } as any);
  });

  // ==========================================================================
  // Stage 1: Warning Notification (30-day notice, consent, balance, participation)
  // ==========================================================================
  describe("Stage 1: Advance Warning Lifecycle & Consent Boundaries", () => {
    const expiryAtString = "2026-10-01T00:00:00.000Z";
    const expiryAt = new Date(expiryAtString);

    it("calculates exact 30-day advance notice threshold for 12-month policy", () => {
      const stageDate = getPointsExpiryStageDate({
        policy: basePolicy,
        expiryAt,
        stage: "warning",
      });
      // 30 days before 2026-10-01 is 2026-09-01
      expect(stageDate.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    });

    it("dispatches warning notification with urgency 'warning' when shopper consented and participated", async () => {
      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue({
        id: "wlacc_member_1",
        cachedPointsBalance: BigInt(1250),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        shopper: {
          email: "consented@example.com",
          firstName: "Haruto",
          locale: "ja",
          acceptsMarketing: true,
          ordersCount: 2,
        },
        program: {
          ...basePolicy,
          name: "Yamax Club",
          pointNamePlural: "Points",
        },
        store: { shopDomain: "yamaxdev.myshopify.com" },
      });

      const outcome = await sendPointsExpiryNotification({
        storeId: "wstore_1",
        payload: {
          accountId: "wlacc_member_1",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "warning",
          policyVersion: 1,
        },
        now: new Date("2026-09-01T12:00:00.000Z"),
      });

      expect(outcome).toBe("sent");
      expect(sendBatchEmail).toHaveBeenCalledOnce();
      const [batch, opts] = vi.mocked(sendBatchEmail).mock.calls[0];
      expect(batch[0]).toMatchObject({
        to: "consented@example.com",
        subject: "1250 Points expire on 2026年10月1日",
        variant: "marketing",
        unsubscribeUrl: "https://yamaxdev.myshopify.com/account/profile",
      });
      expect(opts).toEqual({
        idempotencyKey:
          "loyalty-expiry-warning-wlacc_member_1-2026-10-01T00:00:00.000Z",
      });
    });

    it("suppresses notification and returns 'ineligible' when marketing consent is false", async () => {
      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue({
        id: "wlacc_unconsented",
        cachedPointsBalance: BigInt(500),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        shopper: {
          email: "unconsented@example.com",
          firstName: "Shopper",
          locale: "en",
          acceptsMarketing: false, // Opted out
          ordersCount: 3,
        },
        program: {
          ...basePolicy,
          name: "Yamax Club",
          pointNamePlural: "Points",
        },
        store: { shopDomain: "yamaxdev.myshopify.com" },
      });

      const outcome = await sendPointsExpiryNotification({
        storeId: "wstore_1",
        payload: {
          accountId: "wlacc_unconsented",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "warning",
          policyVersion: 1,
        },
        now: new Date("2026-09-01T12:00:00.000Z"),
      });

      expect(outcome).toBe("ineligible");
      expect(sendBatchEmail).not.toHaveBeenCalled();
    });

    it("returns 'stale' and suppresses email when account balance is zero or negative", async () => {
      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue({
        id: "wlacc_zero_balance",
        cachedPointsBalance: BigInt(0),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        shopper: {
          email: "zero@example.com",
          firstName: "Zero",
          locale: "en",
          acceptsMarketing: true,
          ordersCount: 1,
        },
        program: {
          ...basePolicy,
          name: "Yamax Club",
          pointNamePlural: "Points",
        },
        store: { shopDomain: "yamaxdev.myshopify.com" },
      });

      const outcome = await sendPointsExpiryNotification({
        storeId: "wstore_1",
        payload: {
          accountId: "wlacc_zero_balance",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "warning",
          policyVersion: 1,
        },
        now: new Date("2026-09-01T12:00:00.000Z"),
      });

      expect(outcome).toBe("stale");
      expect(sendBatchEmail).not.toHaveBeenCalled();
    });

    it("enforces explicit participation gate: unparticipated imported shopper is ineligible", async () => {
      // ordersCount = 0 and no explicit participation ledger entries
      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue({
        id: "wlacc_imported",
        cachedPointsBalance: BigInt(300),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        shopper: {
          email: "imported@example.com",
          firstName: "Imported",
          locale: "en",
          acceptsMarketing: true,
          ordersCount: 0,
        },
        program: {
          ...basePolicy,
          name: "Yamax Club",
          pointNamePlural: "Points",
        },
        store: { shopDomain: "yamaxdev.myshopify.com" },
      });
      mockPrisma.weleticPointsLedgerEntry.findFirst.mockResolvedValue(null);

      const outcome = await sendPointsExpiryNotification({
        storeId: "wstore_1",
        payload: {
          accountId: "wlacc_imported",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "warning",
          policyVersion: 1,
        },
        now: new Date("2026-09-01T12:00:00.000Z"),
      });

      expect(outcome).toBe("ineligible");
      expect(sendBatchEmail).not.toHaveBeenCalled();
      expect(
        mockPrisma.weleticPointsLedgerEntry.findFirst,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            accountId: "wlacc_imported",
            entryType: {
              in: [
                WeleticPointsLedgerEntryType.EARN_ORDER,
                WeleticPointsLedgerEntryType.EARN_REFERRAL,
                WeleticPointsLedgerEntryType.EARN_BONUS,
                WeleticPointsLedgerEntryType.REDEEM_REWARD,
                WeleticPointsLedgerEntryType.TIER_BONUS,
              ],
            },
          }),
        }),
      );
    });

    it("allows non-purchasing participating shopper with qualifying bonus ledger entry", async () => {
      // ordersCount = 0 but customer performed an EARN_BONUS (e.g. signup or review)
      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue({
        id: "wlacc_bonus_member",
        cachedPointsBalance: BigInt(200),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        shopper: {
          email: "bonus@example.com",
          firstName: "Bonus",
          locale: "en",
          acceptsMarketing: true,
          ordersCount: 0,
        },
        program: {
          ...basePolicy,
          name: "Yamax Club",
          pointNamePlural: "Points",
        },
        store: { shopDomain: "yamaxdev.myshopify.com" },
      });
      mockPrisma.weleticPointsLedgerEntry.findFirst.mockResolvedValue({
        id: "wledger_bonus_1",
      });

      const outcome = await sendPointsExpiryNotification({
        storeId: "wstore_1",
        payload: {
          accountId: "wlacc_bonus_member",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "warning",
          policyVersion: 1,
        },
        now: new Date("2026-09-01T12:00:00.000Z"),
      });

      expect(outcome).toBe("sent");
      expect(sendBatchEmail).toHaveBeenCalledOnce();
    });

    it("throws error on premature execution attempt before warning threshold", async () => {
      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue({
        id: "wlacc_premature",
        cachedPointsBalance: BigInt(100),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        shopper: {
          email: "premature@example.com",
          acceptsMarketing: true,
          ordersCount: 1,
        },
        program: { ...basePolicy },
        store: { shopDomain: "yamaxdev.myshopify.com" },
      });

      // Attempting to run on 2026-08-15 (17 days before the 30-day warning date 2026-09-01)
      await expect(
        sendPointsExpiryNotification({
          storeId: "wstore_1",
          payload: {
            accountId: "wlacc_premature",
            lastActivityAt: "2025-10-01T00:00:00.000Z",
            expiryMonths: 12,
            expiryAt: expiryAtString,
            stage: "warning",
            policyVersion: 1,
          },
          now: new Date("2026-08-15T00:00:00.000Z"),
        }),
      ).rejects.toThrow(/ran before its configured threshold/);
    });

    it("returns 'stale' when pointsExpiryWarningEnabled is toggled to false", async () => {
      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue({
        id: "wlacc_disabled_warning",
        cachedPointsBalance: BigInt(500),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        shopper: {
          email: "member@example.com",
          acceptsMarketing: true,
          ordersCount: 1,
        },
        program: {
          ...basePolicy,
          pointsExpiryWarningEnabled: false, // Disabled by merchant
        },
        store: { shopDomain: "yamaxdev.myshopify.com" },
      });

      const outcome = await sendPointsExpiryNotification({
        storeId: "wstore_1",
        payload: {
          accountId: "wlacc_disabled_warning",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "warning",
          policyVersion: 1,
        },
        now: new Date("2026-09-01T12:00:00.000Z"),
      });

      expect(outcome).toBe("stale");
      expect(sendBatchEmail).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Stage 2: Last-Chance Notification (3/7-day urgent notification & short windows)
  // ==========================================================================
  describe("Stage 2: Last-Chance Urgent Notification & Short Windows", () => {
    const expiryAtString = "2026-10-01T00:00:00.000Z";
    const expiryAt = new Date(expiryAtString);

    it("calculates exact 3-day and 7-day last-chance thresholds", () => {
      const threeDayDate = getPointsExpiryStageDate({
        policy: { ...basePolicy, pointsExpiryLastChanceDays: 3 },
        expiryAt,
        stage: "last_chance",
      });
      // 3 days before 2026-10-01 is 2026-09-28
      expect(threeDayDate.toISOString()).toBe("2026-09-28T00:00:00.000Z");

      const sevenDayDate = getPointsExpiryStageDate({
        policy: { ...basePolicy, pointsExpiryLastChanceDays: 7 },
        expiryAt,
        stage: "last_chance",
      });
      // 7 days before 2026-10-01 is 2026-09-24
      expect(sevenDayDate.toISOString()).toBe("2026-09-24T00:00:00.000Z");
    });

    it("dispatches last-chance notification with urgency 'last_chance' and urgent subject prefix", async () => {
      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue({
        id: "wlacc_urgent_1",
        cachedPointsBalance: BigInt(800),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        shopper: {
          email: "urgent@example.com",
          firstName: "Ren",
          locale: "en",
          acceptsMarketing: true,
          ordersCount: 1,
        },
        program: {
          ...basePolicy,
          name: "Yamax Club",
          pointNamePlural: "Points",
        },
        store: { shopDomain: "yamaxdev.myshopify.com" },
      });

      const outcome = await sendPointsExpiryNotification({
        storeId: "wstore_1",
        payload: {
          accountId: "wlacc_urgent_1",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "last_chance",
          policyVersion: 1,
        },
        now: new Date("2026-09-28T12:00:00.000Z"),
      });

      expect(outcome).toBe("sent");
      expect(sendBatchEmail).toHaveBeenCalledOnce();
      const [batch, opts] = vi.mocked(sendBatchEmail).mock.calls[0];
      expect(batch[0].subject).toBe(
        "Last chance: 800 Points expire on October 1, 2026",
      );
      expect(opts).toEqual({
        idempotencyKey:
          "loyalty-expiry-last_chance-wlacc_urgent_1-2026-10-01T00:00:00.000Z",
      });
    });

    it("prunes warning and last-chance notifications for short windows (e.g. 3-day expiry)", async () => {
      const enabledAt = new Date("2026-09-01T00:00:00.000Z");
      const shortExpiryAt = new Date("2026-09-04T00:00:00.000Z");
      const tx = {
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({
            ...basePolicy,
            id: "wprog_3day",
            pointsExpiryDays: 3,
            pointsExpiryMonths: 0,
            pointsExpiryPolicyAnchorAt: enabledAt,
          }),
        },
        weleticLoyaltyAccount: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([]) // reconciliation
            .mockResolvedValueOnce([
              {
                id: "wlacc_3day",
                lastQualifyingActivityAt: null,
                nextExpiryDate: shortExpiryAt,
              },
            ]),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };

      mockPrisma.weleticLoyaltyProgram.findMany.mockResolvedValue([
        { storeId: "wstore_short" },
      ]);
      vi.mocked(withActiveStoreLoyaltyMutation).mockImplementation(
        async ({ operation }: any) => operation(tx),
      );

      const result = await enqueuePointsExpiryLifecycleJobs({
        now: enabledAt,
        batchSize: 10,
      });

      // For a 3-day policy from 2026-09-01 to 2026-09-04:
      // warning date: 2026-09-04 - 30d = 2026-08-05 <= baseDate (2026-09-01) -> pruned!
      // last_chance date: 2026-09-04 - 3d = 2026-09-01 <= baseDate (2026-09-01) -> pruned!
      // Only 'expire' job is queued!
      expect(result.jobsEnqueued).toBe(1);
      expect(enqueueOutboxJobFromProgramTransaction).toHaveBeenCalledTimes(1);
      expect(enqueueOutboxJobFromProgramTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: "INACTIVITY_EXPIRY",
          payload: expect.objectContaining({
            accountId: "wlacc_3day",
            stage: "expire",
          }),
          scheduledFor: shortExpiryAt,
        }),
      );
    });

    it("schedules last-chance but prunes warning for 7-day window with 3-day notice", async () => {
      const enabledAt = new Date("2026-09-01T00:00:00.000Z");
      const sevenDayExpiryAt = new Date("2026-09-08T00:00:00.000Z");
      const tx = {
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({
            ...basePolicy,
            id: "wprog_7day",
            pointsExpiryDays: 7,
            pointsExpiryMonths: 0,
            pointsExpiryWarningDays: 30,
            pointsExpiryLastChanceDays: 3,
            pointsExpiryPolicyAnchorAt: enabledAt,
          }),
        },
        weleticLoyaltyAccount: {
          findMany: vi
            .fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
              {
                id: "wlacc_7day",
                cachedPointsBalance: BigInt(500),
                lastQualifyingActivityAt: null,
                nextExpiryDate: sevenDayExpiryAt,
              },
            ]),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };

      mockPrisma.weleticLoyaltyProgram.findMany.mockResolvedValue([
        { storeId: "wstore_7day" },
      ]);
      vi.mocked(withActiveStoreLoyaltyMutation).mockImplementation(
        async ({ operation }: any) => operation(tx),
      );

      const result = await enqueuePointsExpiryLifecycleJobs({
        now: enabledAt,
        batchSize: 10,
      });

      // warning (t - 30d = 2026-08-09 <= baseDate) -> pruned!
      // last_chance (t - 3d = 2026-09-05 > baseDate) -> scheduled!
      // expire (t = 2026-09-08) -> scheduled!
      expect(result.jobsEnqueued).toBe(3);
      expect(enqueueOutboxJobFromProgramTransaction).toHaveBeenCalledTimes(3);
      const enqueuedStages = vi
        .mocked(enqueueOutboxJobFromProgramTransaction)
        .mock.calls.filter(([call]) => call.jobType === "INACTIVITY_EXPIRY")
        .map(([call]) => (call.payload as InactivityExpiryPayload).stage);
      expect(enqueuedStages).toEqual(["last_chance", "expire"]);
      expect(
        vi
          .mocked(enqueueOutboxJobFromProgramTransaction)
          .mock.calls.filter(([call]) => call.jobType === "FLOW_TRIGGER"),
      ).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Stage 3: Zero-Residue Debit at Cutoff (t = expiryAt)
  // ==========================================================================
  describe("Stage 3: Zero-Residue Debit at Expiry Cutoff & Ledger Immutability", () => {
    const expiryAt = new Date("2026-10-01T00:00:00.000Z");
    const executionTime = new Date("2026-10-01T00:00:01.000Z");

    it("appends immutable EXPIRATION ledger entry with delta = -balance, drives balance to zero, and clears expiry dates", async () => {
      const accountId = "wlacc_expire_target";
      const initialBalance = BigInt(4500);

      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
        id: accountId,
        storeId: "wstore_exp",
        cachedPointsBalance: initialBalance,
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(10000),
        lifetimePointsRedeemed: BigInt(5500),
        ledgerVersion: 12,
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        program: {
          ...basePolicy,
          storeId: "wstore_exp",
        },
      });

      mockPrisma.mockTx.weleticPointsLedgerEntry.findUnique.mockResolvedValue(
        null,
      );
      mockPrisma.mockTx.weleticPointsLedgerEntry.create.mockResolvedValue({
        id: "wledger_expiration_1",
      });
      mockPrisma.mockTx.weleticLoyaltyAccount.updateMany.mockResolvedValue({
        count: 1,
      });

      await handleInactivityExpiry(
        "wstore_exp",
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

      // 1. Immutable ledger entry verification
      expect(
        mockPrisma.mockTx.weleticPointsLedgerEntry.create,
      ).toHaveBeenCalledWith({
        data: expect.objectContaining({
          storeId: "wstore_exp",
          accountId,
          sequenceNumber: 13,
          entryType: WeleticPointsLedgerEntryType.EXPIRATION,
          pointsDelta: -initialBalance, // Exactly -4500
          balanceAfter: BigInt(0), // Strictly zero
          idempotencyKey: `expire:${accountId}:${expiryAt.toISOString()}`,
          referenceType: "LOYALTY_INACTIVITY_EXPIRY",
          referenceId: accountId,
          reason: "Points expired after 1 year of account inactivity",
        }),
      });

      // 2. Account balance updated to 0 and dates cleared
      expect(
        mockPrisma.mockTx.weleticLoyaltyAccount.updateMany,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: accountId,
            storeId: "wstore_exp",
            nextExpiryDate: expiryAt,
          },
          data: {
            nextExpiryDate: null,
            pointsExpiryJobsScheduledAt: null,
          },
        }),
      );

      // 3. Storefront Metafield sync enqueued
      expect(enqueueOutboxJob).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: "wstore_exp",
          jobType: "METAFIELD_SYNC",
          payload: {
            accountId,
            triggerReason: "points_expiration",
          },
          idempotencyKey: `metafield_sync:expire:${accountId}:${expiryAt.toISOString()}`,
        }),
      );
    });

    it("throws error on premature execution attempt before expiry cutoff", async () => {
      const accountId = "wlacc_premature_expiry";
      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
        id: accountId,
        storeId: "wstore_exp",
        cachedPointsBalance: BigInt(1000),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        program: { ...basePolicy },
      });

      // Attempting execution 1 second before expiry cutoff
      const prematureTime = new Date(expiryAt.getTime() - 1000);
      await expect(
        handleInactivityExpiry(
          "wstore_exp",
          {
            accountId,
            lastActivityAt: "2025-10-01T00:00:00.000Z",
            expiryMonths: 12,
            expiryAt: expiryAt.toISOString(),
            stage: "expire",
            policyVersion: 1,
          },
          null,
          prematureTime,
        ),
      ).rejects.toThrow(/ran before/);
    });

    it("enforces tenant boundary: rejects account belonging to different store", async () => {
      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
        id: "wlacc_cross_store",
        storeId: "wstore_attacker",
        cachedPointsBalance: BigInt(1000),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        program: { ...basePolicy },
      });

      await expect(
        handleInactivityExpiry(
          "wstore_victim",
          {
            accountId: "wlacc_cross_store",
            lastActivityAt: "2025-10-01T00:00:00.000Z",
            expiryMonths: 12,
            expiryAt: expiryAt.toISOString(),
            stage: "expire",
            policyVersion: 1,
          },
          null,
          executionTime,
        ),
      ).rejects.toThrow(/does not belong to/);
    });
  });

  // ==========================================================================
  // Insolvent / Negative Balance Accounts on Expiry
  // ==========================================================================
  describe("Insolvent & Negative Balance Account Protection on Expiry", () => {
    const expiryAt = new Date("2026-10-01T00:00:00.000Z");
    const executionTime = new Date("2026-10-01T00:00:01.000Z");

    it("clears nextExpiryDate on zero balance account without creating ledger debit", async () => {
      const accountId = "wlacc_zero_cutoff";
      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
        id: accountId,
        storeId: "wstore_exp",
        cachedPointsBalance: BigInt(0),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        program: { ...basePolicy },
      });
      mockPrisma.mockTx.weleticLoyaltyAccount.updateMany.mockResolvedValue({
        count: 1,
      });

      await handleInactivityExpiry(
        "wstore_exp",
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

      // Clears expiry dates
      expect(
        mockPrisma.mockTx.weleticLoyaltyAccount.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: accountId,
          storeId: "wstore_exp",
          nextExpiryDate: expiryAt,
        },
        data: {
          nextExpiryDate: null,
          pointsExpiryJobsScheduledAt: null,
        },
      });

      // Invariant: no ledger entry created, no metafield sync queued
      expect(
        mockPrisma.mockTx.weleticPointsLedgerEntry.create,
      ).not.toHaveBeenCalled();
      expect(enqueueOutboxJob).not.toHaveBeenCalled();
    });

    it("clears nextExpiryDate on negative balance account (-500) without underflowing or corrupting deficit", async () => {
      const accountId = "wlacc_deficit_cutoff";
      const negativeBalance = BigInt(-500); // From refund clawback exceeding balance

      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
        id: accountId,
        storeId: "wstore_exp",
        cachedPointsBalance: negativeBalance,
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 1,
        program: { ...basePolicy },
      });
      mockPrisma.mockTx.weleticLoyaltyAccount.updateMany.mockResolvedValue({
        count: 1,
      });

      await handleInactivityExpiry(
        "wstore_exp",
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

      // Resets expiry dates cleanly
      expect(
        mockPrisma.mockTx.weleticLoyaltyAccount.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: accountId,
          storeId: "wstore_exp",
          nextExpiryDate: expiryAt,
        },
        data: {
          nextExpiryDate: null,
          pointsExpiryJobsScheduledAt: null,
        },
      });

      // Deficit is preserved algebraically, no negative underflow
      expect(
        mockPrisma.mockTx.weleticPointsLedgerEntry.create,
      ).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Rolling Expiry Extension on Qualifying Shopper Activity
  // ==========================================================================
  describe("Rolling Expiry Extension on Qualifying Shopper Activity", () => {
    it("advances nextExpiryDate into the future and clears scheduled jobs on EARN_ORDER", async () => {
      vi.useFakeTimers();
      const activityTime = new Date("2026-06-15T12:00:00.000Z");
      vi.setSystemTime(activityTime);

      const tx = {
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "wledger_order_earn" }),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "wlacc_active",
            storeId: "wstore_1",
            cachedPointsBalance: BigInt(200),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(200),
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: 1,
            lastQualifyingActivityAt: new Date("2026-01-01T00:00:00.000Z"),
            nextExpiryDate: new Date("2027-01-01T00:00:00.000Z"),
            pointsExpiryJobsScheduledAt: new Date("2027-01-01T00:00:00.000Z"),
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({
            ...basePolicy,
            pointsExpiryMonths: 12,
          }),
        },
      };

      await appendPointsLedgerEntry({
        storeId: "wstore_1",
        accountId: "wlacc_active",
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: 150,
        idempotencyKey: "earn:order_1001",
        tx: tx as any,
      });

      // Rolling extension: 12 months from activityTime (2026-06-15) -> 2027-06-15
      expect(tx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cachedPointsBalance: BigInt(350),
            lastQualifyingActivityAt: activityTime,
            nextExpiryDate: new Date("2027-06-15T12:00:00.000Z"),
            pointsExpiryJobsScheduledAt: null, // Forces scheduler to reschedule
          }),
        }),
      );
    });

    it("advances nextExpiryDate on referral reward and bonus earn activities", async () => {
      vi.useFakeTimers();
      const referralTime = new Date("2026-07-20T10:00:00.000Z");
      vi.setSystemTime(referralTime);

      const tx = {
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "wledger_referral" }),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "wlacc_referral",
            storeId: "wstore_1",
            cachedPointsBalance: BigInt(100),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(100),
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: 3,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({
            ...basePolicy,
            pointsExpiryMonths: 12,
          }),
        },
      };

      await appendPointsLedgerEntry({
        storeId: "wstore_1",
        accountId: "wlacc_referral",
        entryType: WeleticPointsLedgerEntryType.EARN_REFERRAL,
        pointsDelta: 500,
        idempotencyKey: "referral:reward_2002",
        tx: tx as any,
      });

      expect(tx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastQualifyingActivityAt: referralTime,
            nextExpiryDate: new Date("2027-07-20T10:00:00.000Z"),
            pointsExpiryJobsScheduledAt: null,
          }),
        }),
      );
    });

    it("verifies EXPIRATION entry is non-qualifying and does not advance activity timestamp", async () => {
      vi.useFakeTimers();
      const expiryTime = new Date("2026-10-01T00:00:00.000Z");
      vi.setSystemTime(expiryTime);

      const originalActivityAt = new Date("2025-10-01T00:00:00.000Z");
      const tx = {
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "wledger_exp" }),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "wlacc_exp",
            storeId: "wstore_1",
            cachedPointsBalance: BigInt(500),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(500),
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: 5,
            lastQualifyingActivityAt: originalActivityAt,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({
            ...basePolicy,
          }),
        },
      };

      await appendPointsLedgerEntry({
        storeId: "wstore_1",
        accountId: "wlacc_exp",
        entryType: WeleticPointsLedgerEntryType.EXPIRATION,
        pointsDelta: -500,
        idempotencyKey: "expire:test",
        tx: tx as any,
      });

      // lastQualifyingActivityAt must NOT be updated for EXPIRATION!
      const updateData = tx.weleticLoyaltyAccount.updateMany.mock.calls[0][0]
        .data as Prisma.WeleticLoyaltyAccountUpdateManyMutationInput;
      expect(updateData.lastQualifyingActivityAt).toBeUndefined();
      expect(updateData.cachedPointsBalance).toBe(BigInt(0));
    });

    it("sets nextExpiryDate to null when redemption drains balance to zero", async () => {
      vi.useFakeTimers();
      const redeemTime = new Date("2026-05-01T00:00:00.000Z");
      vi.setSystemTime(redeemTime);

      const tx = {
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "wledger_redeem" }),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "wlacc_drain",
            storeId: "wstore_1",
            cachedPointsBalance: BigInt(1000),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(1000),
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: 2,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({
            ...basePolicy,
          }),
        },
      };

      // Redeem entire balance of 1000 points
      await appendPointsLedgerEntry({
        storeId: "wstore_1",
        accountId: "wlacc_drain",
        entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        pointsDelta: -1000,
        idempotencyKey: "redeem:all_points",
        tx: tx as any,
      });

      expect(tx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cachedPointsBalance: BigInt(0),
            nextExpiryDate: null, // Drain to 0 clears expiry date
            pointsExpiryJobsScheduledAt: null,
          }),
        }),
      );
    });
  });

  // ==========================================================================
  // Policy Version Fencing & Stale Outbox Job Invalidation
  // ==========================================================================
  describe("Policy Version Fencing & Stale Outbox Job Invalidation", () => {
    const expiryAtString = "2026-10-01T00:00:00.000Z";
    const expiryAt = new Date(expiryAtString);
    const executionTime = new Date("2026-10-01T00:00:01.000Z");

    it("drops outbox expire job when payload policyVersion does not match current program version", async () => {
      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
        id: "wlacc_fence_1",
        storeId: "wstore_fence",
        cachedPointsBalance: BigInt(1000),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 2, // Account updated to v2
        program: {
          ...basePolicy,
          pointsExpiryPolicyVersion: 2, // Merchant bumped policy to v2
        },
      });

      // Outbox job was queued under stale policy v1
      await handleInactivityExpiry(
        "wstore_fence",
        {
          accountId: "wlacc_fence_1",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "expire",
          policyVersion: 1, // Stale!
        },
        null,
        executionTime,
      );

      // Silently dropped: no ledger write, no account mutation
      expect(
        mockPrisma.mockTx.weleticPointsLedgerEntry.create,
      ).not.toHaveBeenCalled();
      expect(
        mockPrisma.mockTx.weleticLoyaltyAccount.updateMany,
      ).not.toHaveBeenCalled();
    });

    it("drops outbox expire job when account nextExpiryDate was extended past payload expiryAt", async () => {
      // Shopper earned points, rolling expiry was extended from Oct 1 to Dec 1
      const extendedExpiry = new Date("2026-12-01T00:00:00.000Z");

      mockPrisma.mockTx.weleticLoyaltyAccount.findUnique.mockResolvedValue({
        id: "wlacc_extended",
        storeId: "wstore_fence",
        cachedPointsBalance: BigInt(1500),
        nextExpiryDate: extendedExpiry, // Extended!
        pointsExpiryPolicyVersion: 1,
        program: {
          ...basePolicy,
          pointsExpiryPolicyVersion: 1,
        },
      });

      // Stale outbox job fires for the old Oct 1 date
      await handleInactivityExpiry(
        "wstore_fence",
        {
          accountId: "wlacc_extended",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString, // Old Oct 1 date
          stage: "expire",
          policyVersion: 1,
        },
        null,
        executionTime,
      );

      expect(
        mockPrisma.mockTx.weleticPointsLedgerEntry.create,
      ).not.toHaveBeenCalled();
      expect(
        mockPrisma.mockTx.weleticLoyaltyAccount.updateMany,
      ).not.toHaveBeenCalled();
    });

    it("returns 'stale' from notification worker when policy version has been bumped", async () => {
      mockPrisma.weleticLoyaltyAccount.findFirst.mockResolvedValue({
        id: "wlacc_notif_stale",
        cachedPointsBalance: BigInt(1000),
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 3, // Program is now v3
        shopper: {
          email: "member@example.com",
          acceptsMarketing: true,
          ordersCount: 1,
        },
        program: {
          ...basePolicy,
          pointsExpiryPolicyVersion: 3,
        },
        store: { shopDomain: "yamaxdev.myshopify.com" },
      });

      // Stale outbox notification job carries v2
      const outcome = await sendPointsExpiryNotification({
        storeId: "wstore_fence",
        payload: {
          accountId: "wlacc_notif_stale",
          lastActivityAt: "2025-10-01T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: expiryAtString,
          stage: "warning",
          policyVersion: 2, // Stale!
        },
        now: new Date("2026-09-01T12:00:00.000Z"),
      });

      expect(outcome).toBe("stale");
      expect(sendBatchEmail).not.toHaveBeenCalled();
    });

    it("scheduler sweep reconciles accounts with outdated policy version and re-schedules fresh jobs", async () => {
      const programVersion = 3;
      const tx = {
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue({
            ...basePolicy,
            id: "wprog_reconcile",
            pointsExpiryMonths: 6, // Changed from 12 to 6 months
            pointsExpiryPolicyVersion: programVersion,
            pointsExpiryPolicyAnchorAt: new Date("2026-01-01T00:00:00.000Z"),
          }),
        },
        weleticLoyaltyAccount: {
          findMany: vi
            .fn()
            // 1. Accounts to reconcile (policyVersion !== 3)
            .mockResolvedValueOnce([
              {
                id: "wlacc_reconcile_target",
                cachedPointsBalance: BigInt(750),
                lastQualifyingActivityAt: new Date("2026-04-01T00:00:00.000Z"),
                pointsExpiryPolicyVersion: 2, // Outdated v2
              },
            ])
            // 2. Accounts to schedule (pointsExpiryJobsScheduledAt === null)
            .mockResolvedValueOnce([
              {
                id: "wlacc_reconcile_target",
                cachedPointsBalance: BigInt(750),
                lastQualifyingActivityAt: new Date("2026-04-01T00:00:00.000Z"),
                nextExpiryDate: new Date("2026-10-01T00:00:00.000Z"),
              },
            ]),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
      };

      mockPrisma.weleticLoyaltyProgram.findMany.mockResolvedValue([
        { storeId: "wstore_sweep" },
      ]);
      vi.mocked(withActiveStoreLoyaltyMutation).mockImplementation(
        async ({ operation }: any) => operation(tx),
      );

      const sweepResult = await enqueuePointsExpiryLifecycleJobs({
        now: new Date("2026-09-01T00:00:00.000Z"),
        batchSize: 10,
      });

      // 1. Reconciled 1 account
      expect(sweepResult.accountsReconciled).toBe(1);
      expect(tx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith({
        where: {
          id: "wlacc_reconcile_target",
          storeId: "wstore_sweep",
          status: "active",
          pointsExpiryPolicyVersion: 2,
        },
        data: {
          nextExpiryDate: new Date("2026-10-01T00:00:00.000Z"), // 6 months from 2026-04-01
          pointsExpiryPolicyVersion: programVersion,
          pointsExpiryJobsScheduledAt: null,
        },
      });

      // 2. Fresh jobs enqueued carrying new version v3
      expect(sweepResult.jobsEnqueued).toBe(5);
      expect(
        vi
          .mocked(enqueueOutboxJobFromProgramTransaction)
          .mock.calls.filter(([call]) => call.jobType === "INACTIVITY_EXPIRY")
          .map(([call]) => call.idempotencyKey),
      ).toEqual([
        "inactivity_expiry:warning:wlacc_reconcile_target:2026-10-01T00:00:00.000Z:v3",
        "inactivity_expiry:last_chance:wlacc_reconcile_target:2026-10-01T00:00:00.000Z:v3",
        "inactivity_expiry:expire:wlacc_reconcile_target:2026-10-01T00:00:00.000Z:v3",
      ]);
      expect(
        vi
          .mocked(enqueueOutboxJobFromProgramTransaction)
          .mock.calls.filter(([call]) => call.jobType === "FLOW_TRIGGER"),
      ).toHaveLength(2);
    });
  });
});
