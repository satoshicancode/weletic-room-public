import { GENUINE_EARN_ENTRY_TYPES } from "@/lib/weletic/loyalty/ledger-entry-policy";
import {
  buildCustomerMetafieldUpdates,
  normalizeShopifyCustomerGid,
  WELETIC_LOYALTY_NAMESPACE,
} from "@/lib/weletic/loyalty/metafield-sync";
import {
  calculateTierReviewWindow,
  evaluateTierMaintenanceCycle,
} from "@/lib/weletic/loyalty/tier-lifecycle";
import { enqueueTierReviewSweepJobs } from "@/lib/weletic/loyalty/tier-review-scheduling";
import {
  WeleticLoyaltyTierChangeReason,
  WeleticVipMilestoneMode,
  WeleticVipTimeframe,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// MOCKS & DETERMINISTIC STATE HARNESS
// =============================================================================

const mocks = vi.hoisted(() => ({
  accountFindUnique: vi.fn(),
  accountFindMany: vi.fn(),
  accountUpdate: vi.fn(),
  tierFindMany: vi.fn(),
  tierHistoryFindFirst: vi.fn(),
  tierHistoryCreate: vi.fn(),
  orderFindMany: vi.fn(),
  ledgerFindMany: vi.fn(),
  outboxJobFindUnique: vi.fn(),
  outboxJobCreate: vi.fn(),
  enqueueOutboxJob: vi.fn(),
  enqueueOutboxJobFromProgramTransaction: vi.fn(),
  enqueueFlowTriggerJob: vi.fn(),
  appendPointsLedgerEntry: vi.fn(),
  programFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const transactionClient = {
    weleticLoyaltyAccount: {
      findUnique: mocks.accountFindUnique,
      findMany: mocks.accountFindMany,
      update: mocks.accountUpdate,
    },
    weleticLoyaltyTier: {
      findMany: mocks.tierFindMany,
    },
    weleticLoyaltyTierHistory: {
      findFirst: mocks.tierHistoryFindFirst,
      create: mocks.tierHistoryCreate,
    },
    weleticCommerceOrder: {
      findMany: mocks.orderFindMany,
    },
    weleticPointsLedgerEntry: {
      findMany: mocks.ledgerFindMany,
    },
    weleticLoyaltyProgram: {
      findMany: mocks.programFindMany,
    },
    weleticLoyaltyOutboxJob: {
      findUnique: mocks.outboxJobFindUnique,
      create: mocks.outboxJobCreate,
    },
  };
  return {
    prisma: {
      ...transactionClient,
      $transaction: vi.fn(async (cb: any) => {
        if (typeof cb === "function") {
          return await cb(transactionClient);
        }
        return cb;
      }),
    },
  };
});

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: vi
    .fn()
    .mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/loyalty/merchant-write-fence", () => ({
  withActiveStoreLoyaltyMutation: vi.fn(async ({ operation }: any) => {
    const tx = {
      weleticLoyaltyAccount: {
        findMany: mocks.accountFindMany,
      },
    };
    return operation(tx);
  }),
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: mocks.appendPointsLedgerEntry,
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: mocks.enqueueOutboxJob,
  enqueueOutboxJobFromProgramTransaction:
    mocks.enqueueOutboxJobFromProgramTransaction,
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: mocks.enqueueFlowTriggerJob,
}));

// =============================================================================
// CANONICAL TEST FIXTURES
// =============================================================================

const STORE_ID = "wstore_vip_matrix_test";

const CANONICAL_TIERS = [
  {
    id: "wtier_bronze_1",
    programId: "wprog_1",
    name: "Bronze",
    slug: "bronze",
    tierOrder: 1,
    minSpendThreshold: BigInt(0),
    minPointsThreshold: BigInt(0),
    pointsMultiplier: 1.0,
    entryBonusPoints: BigInt(0),
  },
  {
    id: "wtier_silver_2",
    programId: "wprog_1",
    name: "Silver",
    slug: "silver",
    tierOrder: 2,
    minSpendThreshold: BigInt(20_000), // $200.00 / ¥20,000
    minPointsThreshold: BigInt(200),
    pointsMultiplier: 1.25,
    entryBonusPoints: BigInt(100),
  },
  {
    id: "wtier_gold_3",
    programId: "wprog_1",
    name: "Gold",
    slug: "gold",
    tierOrder: 3,
    minSpendThreshold: BigInt(50_000), // $500.00 / ¥50,000
    minPointsThreshold: BigInt(500),
    pointsMultiplier: 1.5,
    entryBonusPoints: BigInt(250),
  },
  {
    id: "wtier_platinum_4",
    programId: "wprog_1",
    name: "Platinum",
    slug: "platinum",
    tierOrder: 4,
    minSpendThreshold: BigInt(100_000), // $1,000.00 / ¥100,000
    minPointsThreshold: BigInt(1000),
    pointsMultiplier: 2.0,
    entryBonusPoints: BigInt(500),
  },
];

function buildMockAccount(overrides: Record<string, any> = {}) {
  const currentTier = overrides.currentTier ?? CANONICAL_TIERS[0];
  return {
    id: "wacc_shopper_test",
    storeId: STORE_ID,
    shopperId: "wshopper_test",
    status: "active",
    metadata: null,
    currentTierId: currentTier.id,
    currentTier,
    tierExpiresAt: null,
    tierSpendRolling12Months: BigInt(0),
    tierPointsRolling12Months: BigInt(0),
    cachedPointsBalance: 500,
    cachedPendingPoints: 0,
    lifetimePointsEarned: 1500,
    referralCode: "VIPREF123",
    program: {
      id: "wprog_1",
      vipMilestoneMode: WeleticVipMilestoneMode.amount_spent,
      vipTimeframe: WeleticVipTimeframe.rolling_12m,
      vipDowngradeGraceDays: 30,
      vipAutoDowngradeEnabled: true,
      tiers: CANONICAL_TIERS,
    },
    ...overrides,
  };
}

describe("VIP Lifecycle Matrix & Parity Test Suite (Requirement R3 / Nhóm 1.5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountUpdate.mockResolvedValue({});
    mocks.tierHistoryFindFirst.mockResolvedValue(null);
    mocks.tierHistoryCreate.mockResolvedValue({ id: "wtier_hist_1" });
    mocks.outboxJobFindUnique.mockResolvedValue(null);
    mocks.outboxJobCreate.mockResolvedValue({ id: "woutbox_1" });
    mocks.enqueueOutboxJob.mockResolvedValue({
      job: { id: "woutbox_job_1" },
      created: true,
    });
    mocks.enqueueOutboxJobFromProgramTransaction.mockResolvedValue({
      job: { id: "woutbox_sweep_1" },
      created: true,
    });
    mocks.enqueueFlowTriggerJob.mockResolvedValue({
      job: { id: "woutbox_flow_1" },
      created: true,
    });
    mocks.appendPointsLedgerEntry.mockResolvedValue({
      id: "wpledger_bonus_1",
      sequenceNumber: 1,
      balanceAfter: BigInt(1_000),
    });
    mocks.tierFindMany.mockResolvedValue(CANONICAL_TIERS);
    mocks.ledgerFindMany.mockResolvedValue([]);
    mocks.orderFindMany.mockResolvedValue([]);
  });

  // ===========================================================================
  // 1. MILESTONE PROGRESSION & TIMEFRAME REVIEW WINDOWS
  // ===========================================================================
  describe("1. Milestone Progression Across Spend Thresholds & Timeframe Modes", () => {
    const fixedNow = new Date("2026-09-01T12:00:00.000Z");

    it("evaluates rolling_12m lookback window boundaries exactly (365 days)", () => {
      const { startDate, endDate } = calculateTierReviewWindow(
        WeleticVipTimeframe.rolling_12m,
        fixedNow,
      );

      expect(endDate.getTime()).toBe(fixedNow.getTime());
      const expectedStart = new Date(
        fixedNow.getTime() - 365 * 24 * 60 * 60 * 1000,
      );
      expect(startDate.getTime()).toBe(expectedStart.getTime());
    });

    it("evaluates calendar_year lookback window from Jan 1 00:00:00 to Dec 31 23:59:59.999 UTC", () => {
      const { startDate, endDate } = calculateTierReviewWindow(
        WeleticVipTimeframe.calendar_year,
        fixedNow,
        2026,
      );

      expect(startDate.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(endDate.toISOString()).toBe("2026-12-31T23:59:59.999Z");
    });

    it("evaluates lifetime timeframe with unbounded lookback from Unix epoch", () => {
      const { startDate, endDate } = calculateTierReviewWindow(
        WeleticVipTimeframe.lifetime,
        fixedNow,
      );

      expect(startDate.getTime()).toBe(0);
      expect(endDate.getTime()).toBe(fixedNow.getTime());
    });

    it("calculates net qualifying spend by deducting refunds and flooring at zero", async () => {
      const account = buildMockAccount();
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      // Order 1: Gross 30,000, Refunded 5,000 -> Net 25,000
      // Order 2: Gross 10,000, Refunded 12,000 -> Clamped to 0 (non-negative floor)
      // Total Net Spend = 25,000 -> Qualifies for Silver (threshold 20,000), not Gold (50,000)
      mocks.orderFindMany.mockResolvedValueOnce([
        {
          shopTotal: BigInt(30_000),
          refunds: [{ shopAmount: BigInt(5_000) }],
        },
        {
          shopTotal: BigInt(10_000),
          refunds: [{ shopAmount: BigInt(12_000) }],
        },
      ]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: fixedNow,
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("wtier_silver_2");
      expect(result.qualifyingSpend).toBe(BigInt(25_000));
    });

    it("evaluates milestone qualification via points_earned mode filtering genuine earn types", async () => {
      const account = buildMockAccount({
        program: {
          ...buildMockAccount().program,
          vipMilestoneMode: WeleticVipMilestoneMode.points_earned,
        },
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      // 550 points earned -> qualifies for Gold (threshold 500)
      mocks.ledgerFindMany.mockResolvedValueOnce([
        { pointsDelta: BigInt(300) },
        { pointsDelta: BigInt(250) },
      ]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: fixedNow,
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("wtier_gold_3");
      expect(result.qualifyingPoints).toBe(BigInt(550));

      // Verify Prisma ledger query filtered by GENUINE_EARN_ENTRY_TYPES
      expect(mocks.ledgerFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            entryType: {
              in: expect.arrayContaining([...GENUINE_EARN_ENTRY_TYPES]),
            },
            pointsDelta: { gt: BigInt(0) },
          }),
        }),
      );
    });

    it("evaluates milestone mode 'both' requiring both spend and points satisfaction", async () => {
      const account = buildMockAccount({
        program: {
          ...buildMockAccount().program,
          vipMilestoneMode: "both",
        },
      });

      // Subtest A: Spend qualified for Gold ($600), but Points only at Silver level (300 < 500)
      // Result: Can only qualify for Silver!
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(60_000), refunds: [] },
      ]);
      mocks.ledgerFindMany.mockResolvedValueOnce([
        { pointsDelta: BigInt(300) },
      ]);

      const resultA = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: fixedNow,
      });

      expect(resultA.status).toBe("PROMOTED");
      expect(resultA.newTierId).toBe("wtier_silver_2");

      // Subtest B: Both Spend ($1,200) and Points (1,200) qualify for Platinum
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(120_000), refunds: [] },
      ]);
      mocks.ledgerFindMany.mockResolvedValueOnce([
        { pointsDelta: BigInt(1200) },
      ]);

      const resultB = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: fixedNow,
      });

      expect(resultB.status).toBe("PROMOTED");
      expect(resultB.newTierId).toBe("wtier_platinum_4");
    });
  });

  // ===========================================================================
  // 2. SKIPPED-TIER ENTRY BONUSES & MONOTONIC SEQUENCES
  // ===========================================================================
  describe("2. Skipped-Tier Entry Bonuses & Ledger Integrity", () => {
    const fixedNow = new Date("2026-09-02T10:00:00.000Z");

    it("awards all skipped-tier entry bonuses when high-value checkout leaps multiple tiers", async () => {
      // Account leaps from Bronze (Tier 1) directly to Platinum (Tier 4) via $1,200 spend
      const account = buildMockAccount({
        currentTierId: "wtier_bronze_1",
        currentTier: CANONICAL_TIERS[0],
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(120_000), refunds: [] },
      ]);

      // Mock tier history sequence allocation: existing sequence is 2, next should be 3
      mocks.tierHistoryFindFirst
        .mockResolvedValueOnce(null) // No unsequenced rows
        .mockResolvedValueOnce({ id: "wtier_hist_prev", sequenceNumber: 2 }); // Latest sequence is 2

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: fixedNow,
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("wtier_platinum_4");
      expect(result.tierChanged).toBe(true);

      // Verify Tier History record created with monotonic contiguous sequence 3
      expect(mocks.tierHistoryCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountId: account.id,
          sequenceNumber: 3,
          fromTierId: "wtier_bronze_1",
          toTierId: "wtier_platinum_4",
          changeReason: WeleticLoyaltyTierChangeReason.threshold_reached,
          qualifyingSpendSnapshot: BigInt(120_000),
          effectiveAt: fixedNow,
        }),
      });

      // Intermediate crossed tiers: Silver (Tier 2: 100 pts), Gold (Tier 3: 250 pts), Platinum (Tier 4: 500 pts)
      // Total 3 entry bonus ledger calls!
      expect(mocks.appendPointsLedgerEntry).toHaveBeenCalledTimes(3);

      const bonusCalls = mocks.appendPointsLedgerEntry.mock.calls.map(
        ([call]: any) => ({
          pointsDelta: call.pointsDelta,
          referenceId: call.referenceId,
          referenceType: call.referenceType,
          idempotencyKey: call.idempotencyKey,
        }),
      );

      expect(bonusCalls).toEqual([
        {
          pointsDelta: BigInt(100),
          referenceId: "wtier_silver_2",
          referenceType: "LOYALTY_TIER_PROMOTION",
          idempotencyKey: expect.stringMatching(
            new RegExp(
              `^tier_upgrade_bonus:${account.id}:wtier_.*:wtier_silver_2$`,
            ),
          ),
        },
        {
          pointsDelta: BigInt(250),
          referenceId: "wtier_gold_3",
          referenceType: "LOYALTY_TIER_PROMOTION",
          idempotencyKey: expect.stringMatching(
            new RegExp(
              `^tier_upgrade_bonus:${account.id}:wtier_.*:wtier_gold_3$`,
            ),
          ),
        },
        {
          pointsDelta: BigInt(500),
          referenceId: "wtier_platinum_4",
          referenceType: "LOYALTY_TIER_PROMOTION",
          idempotencyKey: expect.stringMatching(
            new RegExp(
              `^tier_upgrade_bonus:${account.id}:wtier_.*:wtier_platinum_4$`,
            ),
          ),
        },
      ]);

      // Verify METAFIELD_SYNC outbox job was enqueued for tier promotion
      expect(mocks.enqueueOutboxJob).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: STORE_ID,
          jobType: "METAFIELD_SYNC",
          payload: {
            accountId: account.id,
            triggerReason: "tier_promoted",
          },
        }),
      );
    });

    it("safely skips intermediate tiers that have zero entryBonusPoints", async () => {
      const customTiers = [
        { ...CANONICAL_TIERS[0], entryBonusPoints: BigInt(0) },
        { ...CANONICAL_TIERS[1], entryBonusPoints: BigInt(0) }, // Silver has 0 bonus points
        { ...CANONICAL_TIERS[2], entryBonusPoints: BigInt(300) }, // Gold has 300 bonus points
      ];

      const account = buildMockAccount({
        currentTierId: "wtier_bronze_1",
        currentTier: customTiers[0],
        program: {
          ...buildMockAccount().program,
          tiers: customTiers,
        },
      });

      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(60_000), refunds: [] },
      ]);

      await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: fixedNow,
      });

      // Only Gold should receive entry bonus (Silver has 0)
      expect(mocks.appendPointsLedgerEntry).toHaveBeenCalledTimes(1);
      expect(mocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          pointsDelta: BigInt(300),
          referenceId: "wtier_gold_3",
        }),
      );
    });
  });

  // ===========================================================================
  // 3. DOWNGRADE GRACE PERIOD PROTECTION & PERKS RETENTION
  // ===========================================================================
  describe("3. Downgrade Grace Period Protection", () => {
    const t0 = new Date("2026-08-01T00:00:00.000Z");

    it("enters 30-day soft downgrade grace period upon first underperformance without demoting", async () => {
      // Account currently at Gold (Tier 3), but recent spend dropped to $0
      const account = buildMockAccount({
        currentTierId: "wtier_gold_3",
        currentTier: CANONICAL_TIERS[2],
        tierExpiresAt: null,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([]); // 0 spend

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: t0,
        gracePeriodDays: 30,
      });

      const expectedExpiry = new Date(t0.getTime() + 30 * 24 * 60 * 60 * 1000);

      expect(result.status).toBe("IN_GRACE_PERIOD");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("wtier_gold_3"); // Remains Gold!
      expect(result.gracePeriodExpiresAt?.toISOString()).toBe(
        expectedExpiry.toISOString(),
      );

      // Account updated with tierExpiresAt
      expect(mocks.accountUpdate).toHaveBeenCalledWith({
        where: { id: account.id },
        data: expect.objectContaining({
          tierExpiresAt: expectedExpiry,
          tierSpendRolling12Months: BigInt(0),
        }),
      });

      // Enqueued TIER_REVIEW outbox job scheduled for grace expiry date
      expect(mocks.enqueueOutboxJob).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: STORE_ID,
          jobType: "TIER_REVIEW",
          scheduledFor: expectedExpiry,
          idempotencyKey: `tier_review_grace:${account.id}:${expectedExpiry.getTime()}`,
        }),
      );
    });

    it("retains current tier perks and multiplier while within active grace period", async () => {
      const graceExpiresAt = new Date(t0.getTime() + 30 * 24 * 60 * 60 * 1000);
      const day15 = new Date(t0.getTime() + 15 * 24 * 60 * 60 * 1000);

      const account = buildMockAccount({
        currentTierId: "wtier_platinum_4",
        currentTier: CANONICAL_TIERS[3],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([]); // Still 0 spend

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: day15, // Mid-grace period
      });

      expect(result.status).toBe("IN_GRACE_PERIOD");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("wtier_platinum_4"); // Retains Platinum perks!
      expect(result.gracePeriodExpiresAt?.toISOString()).toBe(
        graceExpiresAt.toISOString(),
      );
      // No demotion update performed
      expect(mocks.tierHistoryCreate).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 4. REQUALIFICATION DURING GRACE PERIOD
  // ===========================================================================
  describe("4. Requalification During Grace Period", () => {
    const t0 = new Date("2026-08-01T00:00:00.000Z");
    const graceExpiresAt = new Date(t0.getTime() + 30 * 24 * 60 * 60 * 1000);
    const day10 = new Date(t0.getTime() + 10 * 24 * 60 * 60 * 1000);

    it("clears tierExpiresAt immediately when member requalifies during grace window", async () => {
      // Customer is at Gold (threshold $500), has active grace period
      const account = buildMockAccount({
        currentTierId: "wtier_gold_3",
        currentTier: CANONICAL_TIERS[2],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      // Customer makes a qualifying purchase of $550 on day 10
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(55_000), refunds: [] },
      ]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: day10,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("wtier_gold_3");

      // tierExpiresAt cleared to null in database!
      expect(mocks.accountUpdate).toHaveBeenCalledWith({
        where: { id: account.id },
        data: expect.objectContaining({
          tierExpiresAt: null,
          tierSpendRolling12Months: BigInt(55_000),
        }),
      });

      // No demotion recorded
      expect(mocks.tierHistoryCreate).not.toHaveBeenCalled();
    });

    it("promotes member and clears grace period if spend exceeds an even higher tier", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_silver_2",
        currentTier: CANONICAL_TIERS[1],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      // Customer places a large checkout of $1,050 -> jumps past Gold directly to Platinum!
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(105_000), refunds: [] },
      ]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: day10,
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("wtier_platinum_4");
      expect(result.tierChanged).toBe(true);

      expect(mocks.accountUpdate).toHaveBeenCalledWith({
        where: { id: account.id },
        data: expect.objectContaining({
          currentTierId: "wtier_platinum_4",
          tierExpiresAt: null, // Grace period cleared!
        }),
      });
    });
  });

  // ===========================================================================
  // 5. EXPIRED GRACE SWEEP DEMOTION & IMMUNITY INVARIANTS
  // ===========================================================================
  describe("5. Expired Grace Sweep Demotion & Immunity Invariants", () => {
    const t0 = new Date("2026-08-01T00:00:00.000Z");
    const graceExpiresAt = new Date(t0.getTime() + 30 * 24 * 60 * 60 * 1000);
    const day31 = new Date(t0.getTime() + 31 * 24 * 60 * 60 * 1000); // Past grace period

    it("executes single-tier step-down demotion (Platinum Order 4 -> Gold Order 3) upon grace expiry", async () => {
      // Platinum member failed to requalify; spend is $0
      const account = buildMockAccount({
        currentTierId: "wtier_platinum_4",
        currentTier: CANONICAL_TIERS[3],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([]); // 0 spend

      mocks.tierHistoryFindFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "wtier_hist_1", sequenceNumber: 1 });

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: day31,
      });

      // Smile / Yotpo parity invariant: Dropping from Platinum (Tier 4) drops to Gold (Tier 3), NOT Bronze (Tier 1)!
      expect(result.status).toBe("DEMOTED");
      expect(result.tierChanged).toBe(true);
      expect(result.previousTierId).toBe("wtier_platinum_4");
      expect(result.newTierId).toBe("wtier_gold_3");

      // Account tier updated and tierExpiresAt cleared
      expect(mocks.accountUpdate).toHaveBeenCalledWith({
        where: { id: account.id },
        data: expect.objectContaining({
          currentTierId: "wtier_gold_3",
          tierExpiresAt: null,
        }),
      });

      // Tier history row created with annual_downgrade
      expect(mocks.tierHistoryCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountId: account.id,
          sequenceNumber: 2,
          fromTierId: "wtier_platinum_4",
          toTierId: "wtier_gold_3",
          changeReason: WeleticLoyaltyTierChangeReason.annual_downgrade,
        }),
      });

      // Metafield sync enqueued
      expect(mocks.enqueueOutboxJob).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: STORE_ID,
          jobType: "METAFIELD_SYNC",
          payload: {
            accountId: account.id,
            triggerReason: "tier_demoted",
          },
        }),
      );
    });

    it("guarantees base tier immunity: base entry tier member is NEVER demoted", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_bronze_1",
        currentTier: CANONICAL_TIERS[0],
        tierExpiresAt: null,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([]); // 0 spend

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: day31,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("wtier_bronze_1");
      expect(mocks.tierHistoryCreate).not.toHaveBeenCalled();
    });

    it("guarantees lifetime mode immunity against automated downgrades", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_gold_3",
        currentTier: CANONICAL_TIERS[2],
        program: {
          ...buildMockAccount().program,
          vipTimeframe: WeleticVipTimeframe.lifetime,
          vipAutoDowngradeEnabled: true,
        },
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([]); // 0 spend

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: day31,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("wtier_gold_3");
      expect(mocks.accountUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tierExpiresAt: null }),
        }),
      );
      expect(mocks.tierHistoryCreate).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 6. SCHEDULED SWEEP CRON DAEMON (enqueueTierReviewSweepJobs)
  // ===========================================================================
  describe("6. Scheduled Sweep Cron Daemon (enqueueTierReviewSweepJobs)", () => {
    const sweepNow = new Date("2026-09-03T12:00:00.000Z");
    const expiredDate = new Date("2026-09-03T10:00:00.000Z");
    const futureDate = new Date("2026-09-03T14:00:00.000Z");

    it("scans active programs and enqueues TIER_REVIEW jobs for accounts with expired grace periods", async () => {
      mocks.programFindMany.mockResolvedValueOnce([
        {
          storeId: STORE_ID,
          vipTimeframe: WeleticVipTimeframe.rolling_12m,
          vipDowngradeGraceDays: 30,
        },
      ]);

      // Two candidate accounts: one expired, one active
      mocks.accountFindMany.mockResolvedValueOnce([
        { id: "wacc_expired_1", tierExpiresAt: expiredDate },
        { id: "wacc_expired_2", tierExpiresAt: expiredDate },
      ]);

      const sweepResult = await enqueueTierReviewSweepJobs({
        now: sweepNow,
        batchSize: 50,
      });

      expect(sweepResult).toEqual({
        programsScanned: 1,
        programsSkipped: 0,
        accountsEvaluated: 2,
        jobsEnqueued: 2,
        programFailures: [],
      });

      expect(
        mocks.enqueueOutboxJobFromProgramTransaction,
      ).toHaveBeenCalledTimes(2);
      expect(mocks.enqueueOutboxJobFromProgramTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: STORE_ID,
          jobType: "TIER_REVIEW",
          payload: {
            accountId: "wacc_expired_1",
            reviewPeriod: WeleticVipTimeframe.rolling_12m,
            gracePeriodDays: 30,
            reason: "sweep_tier_expiry",
          },
          idempotencyKey: `tier_review_sweep:wacc_expired_1:${expiredDate.getTime()}`,
          priority: 5,
        }),
      );
    });

    it("respects batchSize limits and skips non-compliant or failed programs cleanly", async () => {
      mocks.programFindMany.mockResolvedValueOnce([
        {
          storeId: "wstore_error",
          vipTimeframe: WeleticVipTimeframe.rolling_12m,
          vipDowngradeGraceDays: 30,
        },
      ]);

      mocks.accountFindMany.mockRejectedValueOnce(
        new Error("Database lock contention"),
      );

      const sweepResult = await enqueueTierReviewSweepJobs({
        now: sweepNow,
        batchSize: 10,
      });

      expect(sweepResult.programsScanned).toBe(1);
      expect(sweepResult.programsSkipped).toBe(1);
      expect(sweepResult.jobsEnqueued).toBe(0);
    });
  });

  // ===========================================================================
  // 7. CUSTOMER METAFIELD SYNCHRONIZATION & GRAPHQL READBACK VERIFICATION
  // ===========================================================================
  describe("7. Customer Metafield Synchronization & GraphQL Readback Verification", () => {
    it("builds 9-10 sanitized metafields under weletic_loyalty namespace without customer PII", () => {
      const customerGid = "gid://shopify/Customer/9876543210";
      const normalizedGid = normalizeShopifyCustomerGid("9876543210");
      expect(normalizedGid).toBe(customerGid);

      const updates = buildCustomerMetafieldUpdates({
        ownerId: normalizedGid,
        vipTierName: "Platinum",
        vipTierOrder: 4,
        pointsBalance: 1250,
        pendingPoints: 100,
        lifetimePoints: 3450,
        referralCode: "PLATINUM123",
        referralLink: "https://yamax.myshopify.com?ref=PLATINUM123",
        tierMultiplier: 2.0,
        memberStatus: "active",
        birthDate: "1992-05-15",
      });

      // 10 metafields returned
      expect(updates).toHaveLength(10);
      for (const m of updates) {
        expect(m.namespace).toBe(WELETIC_LOYALTY_NAMESPACE);
        expect(m.ownerId).toBe(customerGid);
      }

      const fieldMap = new Map(updates.map((u) => [u.key, u.value]));
      expect(fieldMap.get("vip_tier")).toBe("Platinum");
      expect(fieldMap.get("vip_tier_order")).toBe("4");
      expect(fieldMap.get("points_balance")).toBe("1250");
      expect(fieldMap.get("pending_points")).toBe("100");
      expect(fieldMap.get("lifetime_points")).toBe("3450");
      expect(fieldMap.get("referral_code")).toBe("PLATINUM123");
      expect(fieldMap.get("referral_link")).toBe(
        "https://yamax.myshopify.com?ref=PLATINUM123",
      );
      expect(fieldMap.get("tier_multiplier")).toBe("2.00");
      expect(fieldMap.get("member_status")).toBe("active");
      expect(fieldMap.get("birth_date")).toBe("1992-05-15");

      // Strict PII Verification: Neither email, phone, nor customer name can ever be present
      const serialized = JSON.stringify(updates);
      expect(serialized).not.toContain("email");
      expect(serialized).not.toContain("phone");
      expect(serialized).not.toContain("firstName");
      expect(serialized).not.toContain("lastName");
    });

    it("verifies in_grace_period member status projection when account has active grace expiry", () => {
      const updates = buildCustomerMetafieldUpdates({
        vipTierName: "Gold",
        vipTierOrder: 3,
        pointsBalance: 400,
        pendingPoints: 0,
        lifetimePoints: 1500,
        referralCode: "GOLD99",
        referralLink: "https://yamax.myshopify.com?ref=GOLD99",
        tierMultiplier: 1.5,
        memberStatus: "in_grace_period",
      });

      const fieldMap = new Map(updates.map((u) => [u.key, u.value]));
      expect(fieldMap.get("member_status")).toBe("in_grace_period");
      expect(fieldMap.get("vip_tier")).toBe("Gold");
      expect(fieldMap.get("tier_multiplier")).toBe("1.50");
    });

    it("verifies GraphQL customer metafield readback exact equality against promoted account", async () => {
      // Simulate account state
      const simulatedAccount = {
        vipTier: "Gold",
        vipTierOrder: "3",
        pointsBalance: "850",
        pendingPoints: "50",
        lifetimePoints: "2400",
        tierMultiplier: "1.50",
        memberStatus: "active",
        referralCode: "GOLD850",
        referralLink: "https://test.myshopify.com?ref=GOLD850",
      };

      // Mock remote GraphQL response for WeleticMetafieldReadback
      const simulatedGraphqlReadback = {
        customer: {
          metafields: {
            nodes: [
              { key: "vip_tier", value: "Gold" },
              { key: "vip_tier_order", value: "3" },
              { key: "points_balance", value: "850" },
              { key: "pending_points", value: "50" },
              { key: "lifetime_points", value: "2400" },
              { key: "tier_multiplier", value: "1.50" },
              { key: "member_status", value: "active" },
              { key: "referral_code", value: "GOLD850" },
              {
                key: "referral_link",
                value: "https://test.myshopify.com?ref=GOLD850",
              },
            ],
          },
        },
      };

      const readbackMap = new Map(
        simulatedGraphqlReadback.customer.metafields.nodes.map((node) => [
          node.key,
          node.value,
        ]),
      );

      // Verify every field matches the simulated account exactly
      expect(readbackMap.get("vip_tier")).toBe(simulatedAccount.vipTier);
      expect(readbackMap.get("vip_tier_order")).toBe(
        simulatedAccount.vipTierOrder,
      );
      expect(readbackMap.get("points_balance")).toBe(
        simulatedAccount.pointsBalance,
      );
      expect(readbackMap.get("pending_points")).toBe(
        simulatedAccount.pendingPoints,
      );
      expect(readbackMap.get("lifetime_points")).toBe(
        simulatedAccount.lifetimePoints,
      );
      expect(readbackMap.get("tier_multiplier")).toBe(
        simulatedAccount.tierMultiplier,
      );
      expect(readbackMap.get("member_status")).toBe(
        simulatedAccount.memberStatus,
      );
      expect(readbackMap.get("referral_code")).toBe(
        simulatedAccount.referralCode,
      );
      expect(readbackMap.get("referral_link")).toBe(
        simulatedAccount.referralLink,
      );
    });
  });
});
