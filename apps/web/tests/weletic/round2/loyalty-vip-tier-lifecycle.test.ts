import { prisma } from "@/lib/prisma";
import {
  calculateTierReviewWindow,
  evaluateTierMaintenanceCycle,
} from "@/lib/weletic/loyalty/tier-lifecycle";
import {
  enqueueTierReviewSweepJobs,
  scheduleTierReviewAfterQualifyingActivity,
} from "@/lib/weletic/loyalty/tier-review-scheduling";
import {
  WeleticLoyaltyTierChangeReason,
  WeleticPointsLedgerEntryType,
  WeleticVipMilestoneMode,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/weletic/loyalty/vip-achievement-communication-producer", () => ({
  enqueueVipAchievementCommunication: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

const mockOutboxJobs: any[] = [];
vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: vi.fn(async (params: any) => {
    mockOutboxJobs.push(params);
    return { id: `woutbox_${mockOutboxJobs.length}`, created: true };
  }),
  enqueueOutboxJobFromProgramTransaction: vi.fn(async (params: any) => {
    mockOutboxJobs.push(params);
    return { id: `woutbox_${mockOutboxJobs.length}`, created: true };
  }),
}));

vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  withActiveStoreLoyaltyMutation: vi.fn(
    async ({ operation }: { operation: (tx: any) => Promise<any> }) => {
      return operation(prisma);
    },
  ),
}));

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: vi.fn().mockResolvedValue({
    storeId: "store-test-1",
    installationGeneration: "gen-1",
  }),
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: vi.fn(async (params: any) => ({
    id: "wledger_bonus_1",
    balanceAfter: BigInt(1_000) + BigInt(params.pointsDelta ?? 0),
  })),
}));

vi.mock("@/lib/weletic/loyalty/qualifying-review-points", () => ({
  sumValidQualifyingPoints: vi.fn(async ({ entries }: { entries: any[] }) => {
    return entries.reduce(
      (sum, e) => sum + BigInt(e.pointsDelta ?? 0),
      BigInt(0),
    );
  }),
}));

vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: vi.fn().mockReturnValue(false),
}));

// In-memory Prisma mock store
interface AccountStore {
  id: string;
  storeId: string;
  status: string;
  currentTierId: string | null;
  tierExpiresAt: Date | null;
  tierSpendRolling12Months?: bigint;
  tierPointsRolling12Months?: bigint;
  programId: string;
  cachedPointsBalance?: bigint;
  shopper?: any;
}

let mockPrograms: any[] = [];
let mockAccounts: AccountStore[] = [];
let mockTiers: any[] = [];
let mockTierHistory: any[] = [];

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (callback: any) => {
      return callback(prisma);
    }),
    weleticLoyaltyProgram: {
      findMany: vi.fn(async ({ where }: any) => {
        return mockPrograms.filter((p) => {
          if (where.status && p.status !== where.status) return false;
          if (
            where.killSwitchActive !== undefined &&
            p.killSwitchActive !== where.killSwitchActive
          )
            return false;
          if (
            where.vipAutoDowngradeEnabled !== undefined &&
            p.vipAutoDowngradeEnabled !== where.vipAutoDowngradeEnabled
          )
            return false;
          if (
            where.store?.complianceState &&
            p.storeComplianceState !== where.store.complianceState
          )
            return false;
          return true;
        });
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        return (
          mockPrograms.find(
            (p) => p.storeId === where.storeId || p.id === where.id,
          ) || null
        );
      }),
    },
    weleticLoyaltyAccount: {
      findMany: vi.fn(async ({ where, take, orderBy }: any) => {
        let results = mockAccounts.filter((a) => {
          if (where.storeId && a.storeId !== where.storeId) return false;
          if (where.status && a.status !== where.status) return false;
          if (where.currentTierId?.not === null && a.currentTierId === null)
            return false;
          if (where.tierExpiresAt) {
            if (a.tierExpiresAt === null) return false;
            if (
              where.tierExpiresAt.lte &&
              a.tierExpiresAt > where.tierExpiresAt.lte
            )
              return false;
          }
          if (where.OR) {
            // Cursor check
            const match = where.OR.some((cond: any) => {
              if (
                cond.tierExpiresAt?.gt &&
                a.tierExpiresAt! > cond.tierExpiresAt.gt
              )
                return true;
              if (
                cond.tierExpiresAt &&
                a.tierExpiresAt?.getTime() ===
                  cond.tierExpiresAt.getTime() &&
                cond.id?.gt &&
                a.id > cond.id.gt
              )
                return true;
              return false;
            });
            if (!match) return false;
          }
          return true;
        });

        results.sort((a, b) => {
          const tA = a.tierExpiresAt?.getTime() ?? 0;
          const tB = b.tierExpiresAt?.getTime() ?? 0;
          if (tA !== tB) return tA - tB;
          return a.id.localeCompare(b.id);
        });

        if (take) {
          results = results.slice(0, take);
        }
        return results;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const found = mockAccounts.find((a) => a.id === where.id);
        if (!found) return null;
        return {
          ...found,
          shopper: { shopifyCustomerId: "sh_123" },
          program: mockPrograms.find((p) => p.storeId === found.storeId),
          currentTier: mockTiers.find((t) => t.id === found.currentTierId),
        };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const idx = mockAccounts.findIndex((a) => a.id === where.id);
        if (idx !== -1) {
          mockAccounts[idx] = { ...mockAccounts[idx], ...data };
          return mockAccounts[idx];
        }
        return null;
      }),
    },
    weleticLoyaltyTier: {
      findMany: vi.fn(async ({ where }: any) => {
        return mockTiers.filter((t) => t.programId === where.programId);
      }),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(async () => []),
    },
    weleticPointsLedgerEntry: {
      findMany: vi.fn(async () => []),
    },
    weleticLoyaltyTierHistory: {
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        const matching = mockTierHistory.filter(
          (h) => h.accountId === where.accountId,
        );
        if (matching.length === 0) return null;
        return matching[matching.length - 1];
      }),
      create: vi.fn(async ({ data }: any) => {
        mockTierHistory.push(data);
        return data;
      }),
    },
  },
}));

describe("Round 2 VIP Tier Review Scheduling & Dormant VIP Expiration Test Suite", () => {
  const storeA = "store-alpha";
  const storeB = "store-beta";
  const programA = "prog-alpha";
  const programB = "prog-beta";

  const tierBronze = {
    id: "tier-bronze",
    programId: programA,
    name: "Bronze",
    tierOrder: 1,
    minSpendThreshold: BigInt(0),
    minPointsThreshold: BigInt(0),
    pointsMultiplier: 1.0,
    entryBonusPoints: BigInt(0),
  };

  const tierSilver = {
    id: "tier-silver",
    programId: programA,
    name: "Silver",
    tierOrder: 2,
    minSpendThreshold: BigInt(5000), // ¥5,000 or $50
    minPointsThreshold: BigInt(500),
    pointsMultiplier: 1.25,
    entryBonusPoints: BigInt(100),
  };

  const tierGold = {
    id: "tier-gold",
    programId: programA,
    name: "Gold",
    tierOrder: 3,
    minSpendThreshold: BigInt(15000), // ¥15,000 or $150
    minPointsThreshold: BigInt(1500),
    pointsMultiplier: 1.5,
    entryBonusPoints: BigInt(300),
  };

  beforeEach(() => {
    mockOutboxJobs.length = 0;
    mockAccounts.length = 0;
    mockTierHistory.length = 0;
    mockPrograms = [
      {
        id: programA,
        storeId: storeA,
        status: "active",
        killSwitchActive: false,
        vipAutoDowngradeEnabled: true,
        vipTimeframe: "ROLLING_12M",
        vipMilestoneMode: WeleticVipMilestoneMode.amount_spent,
        storeComplianceState: "active",
      },
      {
        id: programB,
        storeId: storeB,
        status: "active",
        killSwitchActive: false,
        vipAutoDowngradeEnabled: true,
        vipTimeframe: "CALENDAR_YEAR",
        vipMilestoneMode: WeleticVipMilestoneMode.points_earned,
        storeComplianceState: "active",
      },
    ];
    mockTiers = [tierBronze, tierSilver, tierGold];
  });

  describe("Feature 1 & Feature 4: enqueueTierReviewSweepJobs Multi-Store Fair Batching", () => {
    it("sweeps accounts with expired tier review/grace period (tierExpiresAt <= now) and enqueues outbox jobs", async () => {
      const now = new Date("2026-10-09T12:00:00Z");
      const pastExpiry1 = new Date("2026-10-08T10:00:00Z");
      const pastExpiry2 = new Date("2026-10-09T11:59:00Z");
      const futureExpiry = new Date("2026-10-15T12:00:00Z");

      mockAccounts = [
        {
          id: "acc-1",
          storeId: storeA,
          status: "active",
          currentTierId: "tier-gold",
          tierExpiresAt: pastExpiry1,
          programId: programA,
        },
        {
          id: "acc-2",
          storeId: storeA,
          status: "active",
          currentTierId: "tier-silver",
          tierExpiresAt: pastExpiry2,
          programId: programA,
        },
        {
          id: "acc-3",
          storeId: storeA,
          status: "active",
          currentTierId: "tier-gold",
          tierExpiresAt: futureExpiry, // Active grace period, must NOT be swept
          programId: programA,
        },
      ];

      const result = await enqueueTierReviewSweepJobs({ now, batchSize: 50 });

      expect(result.programsScanned).toBe(2);
      expect(result.accountsEvaluated).toBe(2);
      expect(result.jobsEnqueued).toBe(2);
      expect(mockOutboxJobs).toHaveLength(2);

      expect(mockOutboxJobs[0]).toMatchObject({
        storeId: storeA,
        jobType: "TIER_REVIEW",
        payload: {
          accountId: "acc-1",
          reviewPeriod: "ROLLING_12M",
          reason: "sweep_tier_expiry",
        },
        idempotencyKey: `tier_review_sweep:acc-1:${pastExpiry1.getTime()}`,
        priority: 5,
      });

      expect(mockOutboxJobs[1]).toMatchObject({
        storeId: storeA,
        jobType: "TIER_REVIEW",
        payload: {
          accountId: "acc-2",
          reviewPeriod: "ROLLING_12M",
          reason: "sweep_tier_expiry",
        },
        idempotencyKey: `tier_review_sweep:acc-2:${pastExpiry2.getTime()}`,
        priority: 5,
      });
    });

    it("enforces batch quota and distributes fairly across stores without starving subsequent programs", async () => {
      const now = new Date("2026-10-09T12:00:00Z");
      const pastExpiry = new Date("2026-10-08T00:00:00Z");

      // Store A has 10 accounts, Store B has 10 accounts
      for (let i = 1; i <= 10; i++) {
        mockAccounts.push({
          id: `acc-A-${i}`,
          storeId: storeA,
          status: "active",
          currentTierId: "tier-silver",
          tierExpiresAt: pastExpiry,
          programId: programA,
        });
        mockAccounts.push({
          id: `acc-B-${i}`,
          storeId: storeB,
          status: "active",
          currentTierId: "tier-silver",
          tierExpiresAt: pastExpiry,
          programId: programB,
        });
      }

      // Small batch size limit = 3
      const result = await enqueueTierReviewSweepJobs({ now, batchSize: 3 });

      expect(result.jobsEnqueued).toBe(3);
      expect(mockOutboxJobs).toHaveLength(3);
      // Stops cleanly once quota is met
      expect(result.jobsEnqueued).toBeLessThanOrEqual(3);
    });

    it("skips programs when kill switch is active or store is non-active compliance", async () => {
      const now = new Date("2026-10-09T12:00:00Z");
      mockPrograms[0].killSwitchActive = true;
      mockPrograms[1].storeComplianceState = "uninstalled";

      const result = await enqueueTierReviewSweepJobs({ now, batchSize: 50 });

      expect(result.programsScanned).toBe(0);
      expect(result.jobsEnqueued).toBe(0);
      expect(mockOutboxJobs).toHaveLength(0);
    });
  });

  describe("Feature 2: Inactive VIP Downgrade & Dormant VIP Expiration Lifecycle", () => {
    it("initiates 30-day soft-downgrade grace period on first failure to meet tier threshold", async () => {
      const now = new Date("2026-10-09T00:00:00Z");
      mockAccounts = [
        {
          id: "acc-gold-dormant",
          storeId: storeA,
          status: "active",
          currentTierId: "tier-gold",
          tierExpiresAt: null, // First evaluation of underperforming account
          programId: programA,
        },
      ];

      const outcome = await evaluateTierMaintenanceCycle({
        storeId: storeA,
        accountId: "acc-gold-dormant",
        now,
        reviewPeriod: "ROLLING_12M",
        milestoneMode: "amount_spent",
      });

      expect(outcome.status).toBe("IN_GRACE_PERIOD");
      expect(outcome.tierChanged).toBe(false);
      expect(outcome.newTierId).toBe("tier-gold"); // Tier preserved during grace period
      expect(outcome.previousTierId).toBe("tier-gold");

      const expectedGraceExpiry = new Date(
        now.getTime() + 30 * 24 * 60 * 60 * 1000,
      );
      expect(outcome.gracePeriodExpiresAt?.toISOString()).toBe(
        expectedGraceExpiry.toISOString(),
      );

      // Account record in DB must have tierExpiresAt updated to grace expiration
      const updatedAccount = mockAccounts.find(
        (a) => a.id === "acc-gold-dormant",
      );
      expect(updatedAccount?.tierExpiresAt?.toISOString()).toBe(
        expectedGraceExpiry.toISOString(),
      );

      // Must schedule outbox job to re-evaluate at expiration of grace period
      expect(mockOutboxJobs).toContainEqual(
        expect.objectContaining({
          storeId: storeA,
          jobType: "TIER_REVIEW",
          scheduledFor: expectedGraceExpiry,
        }),
      );
    });

    it("retains grace period when re-evaluated before grace period expires (now < tierExpiresAt)", async () => {
      const graceEnd = new Date("2026-11-08T00:00:00Z");
      const midway = new Date("2026-10-20T00:00:00Z");

      mockAccounts = [
        {
          id: "acc-gold-mid-grace",
          storeId: storeA,
          status: "active",
          currentTierId: "tier-gold",
          tierExpiresAt: graceEnd,
          programId: programA,
        },
      ];

      const outcome = await evaluateTierMaintenanceCycle({
        storeId: storeA,
        accountId: "acc-gold-mid-grace",
        now: midway,
        reviewPeriod: "ROLLING_12M",
        milestoneMode: "amount_spent",
      });

      expect(outcome.status).toBe("IN_GRACE_PERIOD");
      expect(outcome.tierChanged).toBe(false);
      expect(outcome.newTierId).toBe("tier-gold");
      expect(mockTierHistory).toHaveLength(0); // No demotion history logged yet
    });

    it("triggers single-tier step-down demotion when grace period has expired (now >= tierExpiresAt)", async () => {
      const graceEnd = new Date("2026-10-08T00:00:00Z");
      const evaluationTime = new Date("2026-10-09T00:00:00Z"); // Grace period expired 1 day ago

      mockAccounts = [
        {
          id: "acc-gold-expired",
          storeId: storeA,
          status: "active",
          currentTierId: "tier-gold",
          tierExpiresAt: graceEnd,
          programId: programA,
        },
      ];

      const outcome = await evaluateTierMaintenanceCycle({
        storeId: storeA,
        accountId: "acc-gold-expired",
        now: evaluationTime,
        reviewPeriod: "ROLLING_12M",
        milestoneMode: "amount_spent",
      });

      expect(outcome.status).toBe("DEMOTED");
      expect(outcome.tierChanged).toBe(true);
      expect(outcome.previousTierId).toBe("tier-gold");
      // Step-down: Gold (order 3) step down to Silver (order 2), not directly to Bronze
      expect(outcome.newTierId).toBe("tier-silver");

      // DB account record must be updated with cleared expiration and new tier
      const updatedAccount = mockAccounts.find(
        (a) => a.id === "acc-gold-expired",
      );
      expect(updatedAccount?.currentTierId).toBe("tier-silver");
      expect(updatedAccount?.tierExpiresAt).toBeNull();

      // Tier history audit entry must be recorded with annual_downgrade reason
      expect(mockTierHistory).toContainEqual(
        expect.objectContaining({
          accountId: "acc-gold-expired",
          fromTierId: "tier-gold",
          toTierId: "tier-silver",
          changeReason: WeleticLoyaltyTierChangeReason.annual_downgrade,
        }),
      );
    });

    it("preserves base tier without demotion when customer is at lowest tier", async () => {
      const now = new Date("2026-10-09T00:00:00Z");
      mockAccounts = [
        {
          id: "acc-bronze-base",
          storeId: storeA,
          status: "active",
          currentTierId: "tier-bronze",
          tierExpiresAt: null,
          programId: programA,
        },
      ];

      const outcome = await evaluateTierMaintenanceCycle({
        storeId: storeA,
        accountId: "acc-bronze-base",
        now,
        reviewPeriod: "ROLLING_12M",
        milestoneMode: "amount_spent",
      });

      expect(outcome.status).toBe("MAINTAINED");
      expect(outcome.tierChanged).toBe(false);
      expect(outcome.newTierId).toBe("tier-bronze");
      expect(mockTierHistory).toHaveLength(0);
    });

    it("retains VIP status indefinitely when vipAutoDowngradeEnabled is false", async () => {
      const now = new Date("2026-10-09T00:00:00Z");
      mockPrograms[0].vipAutoDowngradeEnabled = false;

      mockAccounts = [
        {
          id: "acc-gold-no-downgrade",
          storeId: storeA,
          status: "active",
          currentTierId: "tier-gold",
          tierExpiresAt: null,
          programId: programA,
        },
      ];

      const outcome = await evaluateTierMaintenanceCycle({
        storeId: storeA,
        accountId: "acc-gold-no-downgrade",
        now,
        reviewPeriod: "ROLLING_12M",
        milestoneMode: "amount_spent",
      });

      expect(outcome.status).toBe("MAINTAINED");
      expect(outcome.tierChanged).toBe(false);
      expect(outcome.newTierId).toBe("tier-gold");
      expect(outcome.reason).toContain("Lifetime or no-downgrade policy");
    });
  });

  describe("Tier Review Window Calculation Edge Cases", () => {
    it("calculates ROLLING_12M precisely as past 365 days window", () => {
      const now = new Date("2026-10-09T15:30:00Z");
      const { startDate, endDate } = calculateTierReviewWindow("ROLLING_12M", now);

      expect(endDate.getTime()).toBe(now.getTime());
      expect(startDate.getTime()).toBe(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    });

    it("calculates CALENDAR_YEAR precisely as Jan 1 00:00:00.000 to Dec 31 23:59:59.999 UTC", () => {
      const now = new Date("2026-06-15T08:00:00Z");
      const { startDate, endDate } = calculateTierReviewWindow("CALENDAR_YEAR", now);

      expect(startDate.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(endDate.toISOString()).toBe("2026-12-31T23:59:59.999Z");
    });

    it("calculates LIFETIME from epoch 0 to now", () => {
      const now = new Date("2026-10-09T15:30:00Z");
      const { startDate, endDate } = calculateTierReviewWindow("LIFETIME", now);

      expect(startDate.getTime()).toBe(0);
      expect(endDate.getTime()).toBe(now.getTime());
    });
  });
});
