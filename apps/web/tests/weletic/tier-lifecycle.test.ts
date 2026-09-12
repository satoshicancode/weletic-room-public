import { prisma } from "@/lib/prisma";
import { GENUINE_EARN_ENTRY_TYPES } from "@/lib/weletic/loyalty/ledger-entry-policy";
import {
  batchEvaluateTierMaintenanceCycle,
  calculateTierReviewWindow,
  evaluateTierMaintenanceCycle,
} from "@/lib/weletic/loyalty/tier-lifecycle";
import { enqueueVipAchievementCommunication } from "@/lib/weletic/loyalty/vip-achievement-communication-producer";
import {
  WeleticLoyaltyTierChangeReason,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/loyalty/vip-achievement-communication-producer", () => ({
  enqueueVipAchievementCommunication: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

// Mock prisma and ledger
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyTier: {
      findMany: vi.fn(),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(),
    },
    weleticOrder: {
      findMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    weleticLoyaltyTierHistory: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: vi.fn(async (params: any) => ({
    id: "wledger_bonus_1",
    balanceAfter: BigInt(1_000) + BigInt(params.pointsDelta),
    ...params,
  })),
}));

describe("VIP Tier Lifecycle Maintenance & Grace Period Engine (Milestone 2)", () => {
  const storeId = "store_yamax_vip";
  const standardTiers = [
    {
      id: "tier_bronze",
      name: "Bronze",
      slug: "bronze",
      tierOrder: 1,
      minSpendThreshold: BigInt(0),
      minPointsThreshold: BigInt(0),
      pointsMultiplier: 1.0,
      entryBonusPoints: BigInt(0),
    },
    {
      id: "tier_silver",
      name: "Silver",
      slug: "silver",
      tierOrder: 2,
      minSpendThreshold: BigInt(20000), // ¥20,000
      minPointsThreshold: BigInt(200),
      pointsMultiplier: 1.25,
      entryBonusPoints: BigInt(100),
    },
    {
      id: "tier_gold",
      name: "Gold",
      slug: "gold",
      tierOrder: 3,
      minSpendThreshold: BigInt(50000), // ¥50,000
      minPointsThreshold: BigInt(500),
      pointsMultiplier: 1.5,
      entryBonusPoints: BigInt(250),
    },
    {
      id: "tier_platinum",
      name: "Platinum",
      slug: "platinum",
      tierOrder: 4,
      minSpendThreshold: BigInt(100000), // ¥100,000
      minPointsThreshold: BigInt(1000),
      pointsMultiplier: 2.0,
      entryBonusPoints: BigInt(500),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enqueueVipAchievementCommunication).mockResolvedValue(null);
    vi.mocked(prisma.weleticLoyaltyTierHistory.create).mockImplementation(
      ({ data }: any) => data as any,
    );
    vi.mocked(prisma.weleticLoyaltyTierHistory.findFirst).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.weleticLoyaltyOutboxJob.findUnique).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.weleticLoyaltyOutboxJob.create).mockImplementation(
      ({ data }: any) => data as any,
    );
  });

  describe("1. Review Window Calculation (calculateTierReviewWindow)", () => {
    it("calculates rolling 12-month lookback window correctly (365 days)", () => {
      const now = new Date("2026-08-18T12:00:00.000Z");
      const { startDate, endDate } = calculateTierReviewWindow(
        "ROLLING_12M",
        now,
      );

      expect(endDate.toISOString()).toBe(now.toISOString());
      const diffDays =
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBe(365);
    });

    it("calculates calendar-year review window from Jan 1 00:00:00 to Dec 31 23:59:59.999", () => {
      const now = new Date("2026-06-15T00:00:00.000Z");
      const { startDate, endDate } = calculateTierReviewWindow(
        "CALENDAR_YEAR",
        now,
        2025,
      );

      expect(startDate.toISOString()).toBe("2025-01-01T00:00:00.000Z");
      expect(endDate.toISOString()).toBe("2025-12-31T23:59:59.999Z");
    });
  });

  describe("2. Qualification & Tier Retention (MAINTAINED)", () => {
    it("does not mutate tiers or award bonuses for a redacted account", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_redacted_tier",
        storeId,
        shopperId: "shopper_redacted_tier",
        status: "closed",
        metadata: {
          shopifyCustomerRedaction: {
            status: "redacted",
            redactedAt: "2026-08-29T00:00:00.000Z",
            source: "shopify_customers_redact",
          },
        },
        currentTierId: "tier_gold",
        currentTier: standardTiers[2],
        tierSpendRolling12Months: BigInt(55_000),
        tierPointsRolling12Months: BigInt(550),
        program: { tiers: standardTiers },
      } as any);

      await expect(
        evaluateTierMaintenanceCycle({
          storeId,
          accountId: "acc_redacted_tier",
        }),
      ).resolves.toMatchObject({
        status: "MAINTAINED",
        tierChanged: false,
        reason:
          "Tier evaluation skipped because the loyalty account is closed.",
      });
      expect(prisma.weleticCommerceOrder.findMany).not.toHaveBeenCalled();
      expect(prisma.weleticPointsLedgerEntry.findMany).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyTierHistory.create).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyOutboxJob.create).not.toHaveBeenCalled();
    });

    it("retains Gold tier when rolling 12m spend meets threshold (¥55,000 >= ¥50,000)", async () => {
      const accountId = "acc_gold_user";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_1",
        currentTierId: "tier_gold",
        currentTier: standardTiers[2], // Gold
        tierExpiresAt: null,
        program: {
          tiers: standardTiers,
        },
      } as any);

      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(30000) },
        { presentmentNet: BigInt(25000) },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(300) }, { pointsDelta: BigInt(250) }] as any,
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: new Date("2026-08-18T00:00:00.000Z"),
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.tierChanged).toBe(false);
      expect(result.previousTierId).toBe("tier_gold");
      expect(result.newTierId).toBe("tier_gold");
      expect(result.qualifyingSpend).toBe(BigInt(55000));
      expect(result.qualifyingPoints).toBe(BigInt(550));
      expect(result.previousTierName).toBe("Gold");
      expect(result.newTierName).toBe("Gold");
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            tierSpendRolling12Months: BigInt(55000),
          }),
        }),
      );
    });

    it("maintains entry Bronze tier even with 0 spend and 0 points", async () => {
      const accountId = "acc_bronze_user";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_bronze",
        currentTierId: "tier_bronze",
        currentTier: standardTiers[0],
        tierExpiresAt: null,
        program: {
          tiers: standardTiers,
        },
      } as any);

      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [],
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: new Date("2026-08-18T00:00:00.000Z"),
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("tier_bronze");
      expect(result.qualifyingSpend).toBe(BigInt(0));
    });

    it("uses only genuine earn types for points-based tier qualification", async () => {
      const accountId = "acc_points_earned_user";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_points_earned",
        currentTierId: "tier_bronze",
        currentTier: standardTiers[0],
        tierExpiresAt: null,
        program: {
          vipMilestoneMode: "points_earned",
          tiers: standardTiers,
        },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([]);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(250) }] as any,
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: new Date("2026-08-18T00:00:00.000Z"),
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("tier_silver");
      expect(result.qualifyingPoints).toBe(BigInt(250));
      expect(prisma.weleticPointsLedgerEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            entryType: { in: [...GENUINE_EARN_ENTRY_TYPES] },
          }),
        }),
      );
      expect(GENUINE_EARN_ENTRY_TYPES).not.toContain(
        WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
      );
    });
  });

  describe("3. Tier Promotion (PROMOTED)", () => {
    function setupNotificationPromotion() {
      const account = {
        id: "notification-account",
        storeId,
        programId: "notification-program",
        shopperId: "notification-shopper",
        currentTierId: "tier_silver",
        currentTier: standardTiers[1],
        tierExpiresAt: null,
        program: { tiers: standardTiers },
      };
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue(
        account as any,
      );
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValue([
        { presentmentNet: BigInt(65_000) },
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([]);
      return account;
    }
    it("passes the created promotion history and transaction to communications, never maintenance replay", async () => {
      const account = setupNotificationPromotion();
      const params = {
        storeId,
        accountId: account.id,
        now: new Date("2026-09-10T00:00:00Z"),
      };
      expect((await evaluateTierMaintenanceCycle(params)).status).toBe(
        "PROMOTED",
      );
      expect(enqueueVipAchievementCommunication).toHaveBeenCalledWith(
        expect.objectContaining({
          tx: prisma,
          storeId,
          programId: account.programId,
          accountId: account.id,
          receipt: {
            created: true,
            history: expect.objectContaining({
              accountId: account.id,
              sequenceNumber: 1,
              fromTierId: "tier_silver",
              toTierId: "tier_gold",
              changeReason: "threshold_reached",
              effectiveAt: params.now,
            }),
          },
        }),
      );
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        ...account,
        currentTierId: "tier_gold",
        currentTier: standardTiers[2],
      } as any);
      expect((await evaluateTierMaintenanceCycle(params)).status).toBe(
        "MAINTAINED",
      );
      expect(enqueueVipAchievementCommunication).toHaveBeenCalledTimes(1);
    });
    it("propagates notification enqueue failure instead of reporting successful promotion", async () => {
      const account = setupNotificationPromotion();
      vi.mocked(enqueueVipAchievementCommunication).mockRejectedValueOnce(
        new Error("synthetic VIP enqueue failure"),
      );
      await expect(
        evaluateTierMaintenanceCycle({ storeId, accountId: account.id }),
      ).rejects.toThrow("synthetic VIP enqueue failure");
      expect(prisma.weleticLoyaltyTierHistory.create).toHaveBeenCalledTimes(1);
      // This is propagation coverage; real transactional rollback needs SQL.
    });
    it("promotes member from Silver to Gold when rolling spend exceeds Gold threshold (¥65,000 >= ¥50,000)", async () => {
      const accountId = "acc_silver_upgrading";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_upgrading",
        currentTierId: "tier_silver",
        currentTier: standardTiers[1], // Silver
        tierExpiresAt: null,
        program: {
          tiers: standardTiers,
        },
      } as any);

      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(40000) },
        { presentmentNet: BigInt(25000) },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(650) }] as any,
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now: new Date("2026-08-18T00:00:00.000Z"),
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.tierChanged).toBe(true);
      expect(result.previousTierId).toBe("tier_silver");
      expect(result.newTierId).toBe("tier_gold");
      expect(result.previousTierName).toBe("Silver");
      expect(result.newTierName).toBe("Gold");
      expect(result.qualifyingSpend).toBe(BigInt(65000));

      // Verifies tier history logging
      expect(prisma.weleticLoyaltyTierHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            accountId,
            sequenceNumber: 1,
            fromTierId: "tier_silver",
            toTierId: "tier_gold",
            changeReason: WeleticLoyaltyTierChangeReason.threshold_reached,
          }),
        }),
      );

      // Verifies account updated to Gold and grace period cleared
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            currentTierId: "tier_gold",
            tierExpiresAt: null,
          }),
        }),
      );
    });

    it("allocates the next contiguous per-account history sequence", async () => {
      const accountId = "acc_silver_sequence";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_sequence",
        currentTierId: "tier_silver",
        currentTier: standardTiers[1],
        tierExpiresAt: null,
        program: { tiers: standardTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(65_000) },
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(650) }] as any,
      );
      vi.mocked(prisma.weleticLoyaltyTierHistory.findFirst)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "wtier_history_5",
          sequenceNumber: 5,
        } as any);

      await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        now: new Date("2026-08-18T00:00:00.000Z"),
      });

      expect(prisma.weleticLoyaltyTierHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ sequenceNumber: 6 }),
        }),
      );
    });

    it("refuses a tier transition while legacy history remains unsequenced", async () => {
      const accountId = "acc_silver_unsequenced";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_unsequenced",
        currentTierId: "tier_silver",
        currentTier: standardTiers[1],
        tierExpiresAt: null,
        program: { tiers: standardTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(65_000) },
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(650) }] as any,
      );
      vi.mocked(
        prisma.weleticLoyaltyTierHistory.findFirst,
      ).mockResolvedValueOnce({
        id: "wtier_history_legacy",
        sequenceNumber: null,
      } as any);

      await expect(
        evaluateTierMaintenanceCycle({
          storeId,
          accountId,
          now: new Date("2026-08-18T00:00:00.000Z"),
        }),
      ).rejects.toThrow(/unsequenced tier history/i);
      expect(prisma.weleticLoyaltyTierHistory.create).not.toHaveBeenCalled();
    });
  });

  describe("4. 30-Day Soft Downgrade Grace Period (IN_GRACE_PERIOD)", () => {
    it("enters 30-day grace period when Gold member falls short on annual review (¥10,000 < ¥50,000)", async () => {
      const accountId = "acc_gold_underperforming";
      const now = new Date("2026-08-18T00:00:00.000Z");

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_under",
        currentTierId: "tier_gold",
        currentTier: standardTiers[2], // Gold (Tier 3)
        tierExpiresAt: null, // Not yet in grace period
        program: {
          tiers: standardTiers,
        },
      } as any);

      // Customer only spent ¥10,000 (qualifies for Bronze, not Silver or Gold)
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(10000) },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(100) }] as any,
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now,
        gracePeriodDays: 30,
      });

      expect(result.status).toBe("IN_GRACE_PERIOD");
      expect(result.tierChanged).toBe(false);
      expect(result.previousTierId).toBe("tier_gold");
      expect(result.newTierId).toBe("tier_gold"); // Tier preserved during grace period!
      expect(result.previousTierName).toBe("Gold");
      expect(result.newTierName).toBe("Gold");
      expect(result.gracePeriodExpiresAt).toBeDefined();

      const expectedExpiration = new Date(
        now.getTime() + 30 * 24 * 60 * 60 * 1000,
      );
      expect(result.gracePeriodExpiresAt?.toISOString()).toBe(
        expectedExpiration.toISOString(),
      );

      // Account saved with expiration date but currentTierId untouched
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            tierExpiresAt: expectedExpiration,
          }),
        }),
      );
    });

    it("remains IN_GRACE_PERIOD when re-evaluated within active 30-day grace period", async () => {
      const accountId = "acc_gold_mid_grace";
      const now = new Date("2026-08-25T00:00:00.000Z"); // 7 days into 30d grace period
      const activeGraceEnd = new Date("2026-09-17T00:00:00.000Z");

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_mid_grace",
        currentTierId: "tier_gold",
        currentTier: standardTiers[2],
        tierExpiresAt: activeGraceEnd, // Active grace period
        program: {
          tiers: standardTiers,
        },
      } as any);

      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(12000) },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(120) }] as any,
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now,
      });

      expect(result.status).toBe("IN_GRACE_PERIOD");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("tier_gold");
      expect(result.gracePeriodExpiresAt?.toISOString()).toBe(
        activeGraceEnd.toISOString(),
      );
    });

    it("clears grace period when member recovers spend and qualifies during grace period", async () => {
      const accountId = "acc_gold_recovered";
      const now = new Date("2026-08-28T00:00:00.000Z");
      const activeGraceEnd = new Date("2026-09-17T00:00:00.000Z");

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_recovered",
        currentTierId: "tier_gold",
        currentTier: standardTiers[2],
        tierExpiresAt: activeGraceEnd,
        program: {
          tiers: standardTiers,
        },
      } as any);

      // Customer made new purchases totaling ¥52,000 (now satisfies Gold threshold)
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(52000) },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(520) }] as any,
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("tier_gold");

      // Verifies grace period expiration cleared
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            tierExpiresAt: null,
          }),
        }),
      );
    });
  });

  describe("5. Single-Tier Step-Down Demotion (DEMOTED)", () => {
    it("executes single-tier step-down demotion (Gold -> Silver) when 30-day grace period expires", async () => {
      const accountId = "acc_gold_expired_grace";
      const now = new Date("2026-09-18T00:00:00.000Z");
      const expiredGraceEnd = new Date("2026-09-17T00:00:00.000Z"); // Expired yesterday

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_expired",
        currentTierId: "tier_gold", // Gold (Tier 3)
        currentTier: standardTiers[2],
        tierExpiresAt: expiredGraceEnd, // Grace period has expired
        program: {
          tiers: standardTiers,
        },
      } as any);

      // Spend is only ¥5,000 (even below Silver)
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(5000) },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(50) }] as any,
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "ROLLING_12M",
        now,
      });

      expect(result.status).toBe("DEMOTED");
      expect(result.tierChanged).toBe(true);
      expect(result.previousTierId).toBe("tier_gold");
      // Single-tier step-down: Gold (3) steps down to Silver (2), NOT directly to Bronze (1)
      expect(result.newTierId).toBe("tier_silver");
      expect(result.previousTierName).toBe("Gold");
      expect(result.newTierName).toBe("Silver");

      // Verifies transition history recorded with annual_downgrade reason
      expect(prisma.weleticLoyaltyTierHistory.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            accountId,
            sequenceNumber: 1,
            fromTierId: "tier_gold",
            toTierId: "tier_silver",
            changeReason: WeleticLoyaltyTierChangeReason.annual_downgrade,
          }),
        }),
      );

      // Verifies account updated to Silver and grace period reset
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            currentTierId: "tier_silver",
            tierExpiresAt: null,
          }),
        }),
      );
    });
  });

  describe("6. Calendar Year Review Cycle (CALENDAR_YEAR)", () => {
    it("evaluates qualification against 2025 calendar year spend (Jan 1 to Dec 31)", async () => {
      const accountId = "acc_calendar_eval";
      const now = new Date("2026-01-05T00:00:00.000Z"); // Annual sweeper runs in early Jan 2026 for 2025

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        shopperId: "shopper_cal",
        currentTierId: "tier_silver",
        currentTier: standardTiers[1], // Silver (Tier 2)
        tierExpiresAt: null,
        program: {
          tiers: standardTiers,
        },
      } as any);

      // Paid orders totaling ¥55,000 in calendar year 2025
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(55000) },
      ] as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(550) }] as any,
      );

      const result = await evaluateTierMaintenanceCycle({
        storeId,
        accountId,
        reviewPeriod: "CALENDAR_YEAR",
        cycleYear: 2025,
        now,
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("tier_gold");
      expect(result.reviewPeriod).toBe("CALENDAR_YEAR");
      expect(result.qualifyingSpend).toBe(BigInt(55000));
    });
  });

  describe("7. Batch Sweeper (batchEvaluateTierMaintenanceCycle)", () => {
    it("evaluates all active store accounts and produces aggregate metrics", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        { id: "acc_1" },
        { id: "acc_2" },
      ] as any);

      // acc_1 (Maintained Gold)
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_1",
        storeId,
        shopperId: "shopper_1",
        currentTierId: "tier_gold",
        currentTier: standardTiers[2],
        tierExpiresAt: null,
        program: { tiers: standardTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(60000) },
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(600) }] as any,
      );

      // acc_2 (Enters Grace Period)
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "acc_2",
        storeId,
        shopperId: "shopper_2",
        currentTierId: "tier_platinum",
        currentTier: standardTiers[3],
        tierExpiresAt: null,
        program: { tiers: standardTiers },
      } as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        { presentmentNet: BigInt(10000) },
      ] as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [{ pointsDelta: BigInt(100) }] as any,
      );

      const batch = await batchEvaluateTierMaintenanceCycle({
        storeId,
        reviewPeriod: "ROLLING_12M",
        now: new Date("2026-08-18T00:00:00.000Z"),
      });

      expect(batch.totalEvaluated).toBe(2);
      expect(batch.maintained).toBe(1);
      expect(batch.inGracePeriod).toBe(1);
      expect(batch.promoted).toBe(0);
      expect(batch.demoted).toBe(0);
      expect(batch.results).toHaveLength(2);
    });
  });
});
