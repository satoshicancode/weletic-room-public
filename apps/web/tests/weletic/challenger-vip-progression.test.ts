import {
  buildCustomerMetafieldUpdates,
  normalizeShopifyCustomerGid,
  WELETIC_LOYALTY_NAMESPACE,
} from "@/lib/weletic/loyalty/metafield-sync";
import { evaluateTierMaintenanceCycle } from "@/lib/weletic/loyalty/tier-lifecycle";
import { enqueueTierReviewSweepJobs } from "@/lib/weletic/loyalty/tier-review-scheduling";
import {
  WeleticLoyaltyTierChangeReason,
  WeleticVipMilestoneMode,
  WeleticVipTimeframe,
} from "@prisma/client";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// PRISMA & DEPENDENCY MOCKS
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

// =============================================================================
// TEST CONSTANTS & 5-TIER FIXTURE
// =============================================================================

const STORE_ID = "wstore_challenger_vip";

const FIVE_TIERS = [
  {
    id: "wtier_bronze_1",
    programId: "wprog_challenger_1",
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
    programId: "wprog_challenger_1",
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
    programId: "wprog_challenger_1",
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
    programId: "wprog_challenger_1",
    name: "Platinum",
    slug: "platinum",
    tierOrder: 4,
    minSpendThreshold: BigInt(100_000), // $1,000.00 / ¥100,000
    minPointsThreshold: BigInt(1000),
    pointsMultiplier: 2.0,
    entryBonusPoints: BigInt(500),
  },
  {
    id: "wtier_diamond_5",
    programId: "wprog_challenger_1",
    name: "Diamond",
    slug: "diamond",
    tierOrder: 5,
    minSpendThreshold: BigInt(250_000), // $2,500.00 / ¥250,000
    minPointsThreshold: BigInt(2500),
    pointsMultiplier: 3.0,
    entryBonusPoints: BigInt(1000),
  },
];

let mockUnsequencedRow: any = null;
let mockLatestHistoryRow: any = { id: "wtier_hist_prev", sequenceNumber: 1 };

function buildMockAccount(overrides: Record<string, any> = {}) {
  const currentTier = overrides.currentTier ?? FIVE_TIERS[0];
  return {
    id: "wacc_adversarial_shopper",
    storeId: STORE_ID,
    shopperId: "wshopper_adversarial",
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
    referralCode: "VIPADV123",
    program: {
      id: "wprog_challenger_1",
      vipMilestoneMode: WeleticVipMilestoneMode.amount_spent,
      vipTimeframe: WeleticVipTimeframe.rolling_12m,
      vipDowngradeGraceDays: 30,
      vipAutoDowngradeEnabled: true,
      tiers: FIVE_TIERS,
    },
    ...overrides,
  };
}

// CLI Execution Helper
const webRoot = path.resolve(__dirname, "../../");

function runCliScript(scriptRelPath: string, args: string[]) {
  try {
    const stdout = execFileSync("npx", ["tsx", scriptRelPath, ...args], {
      cwd: webRoot,
      encoding: "utf8",
      timeout: 25000,
      env: { ...process.env, NODE_ENV: "test" },
    });
    return { exitCode: 0, stdout, error: null };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      error: err,
    };
  }
}

// =============================================================================
// MAIN TEST SUITE
// =============================================================================

describe("Challenger 2: Adversarial VIP Tier Progression & CLI Script Stress Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUnsequencedRow = null;
    mockLatestHistoryRow = { id: "wtier_hist_prev", sequenceNumber: 1 };

    mocks.accountUpdate.mockResolvedValue({});
    mocks.tierHistoryCreate.mockResolvedValue({ id: "wtier_hist_new" });
    mocks.outboxJobFindUnique.mockResolvedValue(null);
    mocks.outboxJobCreate.mockResolvedValue({ id: "woutbox_job_new" });
    mocks.enqueueOutboxJob.mockResolvedValue({
      job: { id: "woutbox_job_enqueued" },
      created: true,
    });
    mocks.enqueueOutboxJobFromProgramTransaction.mockResolvedValue({
      job: { id: "woutbox_tx_enqueued" },
      created: true,
    });
    mocks.appendPointsLedgerEntry.mockImplementation(async (input) => ({
      id: `wpledger_${input.referenceId}`,
      sequenceNumber: 1,
      balanceAfter: BigInt(1_000) + BigInt(input.pointsDelta),
      ...input,
    }));
    mocks.tierFindMany.mockResolvedValue(FIVE_TIERS);
    mocks.ledgerFindMany.mockResolvedValue([]);
    mocks.orderFindMany.mockResolvedValue([]);

    mocks.tierHistoryFindFirst.mockImplementation(async (args: any) => {
      if (args?.where?.sequenceNumber === null) {
        return mockUnsequencedRow;
      }
      if (args?.where?.sequenceNumber?.not === null) {
        return mockLatestHistoryRow;
      }
      return null;
    });
  });

  // ===========================================================================
  // 1. MULTI-TIER LEAPFROGGING STRESS (Crossing 2, 3, 4 tiers at once)
  // ===========================================================================
  describe("1. Multi-Tier Leapfrogging Stress & Idempotency Key Monotonicity", () => {
    const fixedNow = new Date("2026-09-04T00:00:00.000Z");

    it("crossing 2 tiers at once (Bronze -> Gold): grants intermediate Silver + Gold entry bonuses", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_bronze_1",
        currentTier: FIVE_TIERS[0],
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      // Single checkout of $600.00 (60,000 minor units) -> qualifies for Gold (threshold 50,000)
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(60_000), refunds: [] },
      ]);

      mockLatestHistoryRow = { id: "wtier_hist_10", sequenceNumber: 10 };

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: fixedNow,
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("wtier_gold_3");
      expect(result.tierChanged).toBe(true);

      // Tier history contiguous sequence allocation (10 + 1 = 11)
      expect(mocks.tierHistoryCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountId: account.id,
          sequenceNumber: 11,
          fromTierId: "wtier_bronze_1",
          toTierId: "wtier_gold_3",
          changeReason: WeleticLoyaltyTierChangeReason.threshold_reached,
          qualifyingSpendSnapshot: BigInt(60_000),
          effectiveAt: fixedNow,
        }),
      });

      // Intermediate crossed tiers: Silver (Tier 2: 100) + Gold (Tier 3: 250) = 2 entry bonus calls
      expect(mocks.appendPointsLedgerEntry).toHaveBeenCalledTimes(2);

      const bonus1 = mocks.appendPointsLedgerEntry.mock.calls[0][0];
      const bonus2 = mocks.appendPointsLedgerEntry.mock.calls[1][0];

      expect(bonus1.pointsDelta).toBe(BigInt(100));
      expect(bonus1.referenceId).toBe("wtier_silver_2");
      expect(bonus1.idempotencyKey).toMatch(
        new RegExp(
          `^tier_upgrade_bonus:${account.id}:wtier_.*:wtier_silver_2$`,
        ),
      );

      expect(bonus2.pointsDelta).toBe(BigInt(250));
      expect(bonus2.referenceId).toBe("wtier_gold_3");
      expect(bonus2.idempotencyKey).toMatch(
        new RegExp(`^tier_upgrade_bonus:${account.id}:wtier_.*:wtier_gold_3$`),
      );
    });

    it("crossing 3 tiers at once (Bronze -> Platinum): grants Silver, Gold, Platinum entry bonuses with monotonic sequence", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_bronze_1",
        currentTier: FIVE_TIERS[0],
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      // Single checkout of $1,500.00 (150,000 minor units) -> qualifies for Platinum (threshold 100,000)
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(150_000), refunds: [] },
      ]);

      mockLatestHistoryRow = { id: "wtier_hist_41", sequenceNumber: 41 };

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: fixedNow,
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("wtier_platinum_4");
      expect(result.tierChanged).toBe(true);

      // Monotonic sequence allocation 41 + 1 = 42
      expect(mocks.tierHistoryCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountId: account.id,
          sequenceNumber: 42,
          fromTierId: "wtier_bronze_1",
          toTierId: "wtier_platinum_4",
        }),
      });

      // 3 intermediate bonuses: Silver (100), Gold (250), Platinum (500)
      expect(mocks.appendPointsLedgerEntry).toHaveBeenCalledTimes(3);

      const bonuses = mocks.appendPointsLedgerEntry.mock.calls.map(
        ([c]: any) => ({
          points: c.pointsDelta,
          tierId: c.referenceId,
          key: c.idempotencyKey,
        }),
      );

      expect(bonuses).toEqual([
        {
          points: BigInt(100),
          tierId: "wtier_silver_2",
          key: expect.stringMatching(
            new RegExp(
              `^tier_upgrade_bonus:${account.id}:wtier_.*:wtier_silver_2$`,
            ),
          ),
        },
        {
          points: BigInt(250),
          tierId: "wtier_gold_3",
          key: expect.stringMatching(
            new RegExp(
              `^tier_upgrade_bonus:${account.id}:wtier_.*:wtier_gold_3$`,
            ),
          ),
        },
        {
          points: BigInt(500),
          tierId: "wtier_platinum_4",
          key: expect.stringMatching(
            new RegExp(
              `^tier_upgrade_bonus:${account.id}:wtier_.*:wtier_platinum_4$`,
            ),
          ),
        },
      ]);
    });

    it("crossing 4 tiers at once (Bronze -> Diamond): grants ALL intermediate crossed bonuses (Silver, Gold, Platinum, Diamond)", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_bronze_1",
        currentTier: FIVE_TIERS[0],
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      // Massive leap: $3,000.00 checkout (300,000 minor units) -> qualifies for Diamond (threshold 250,000)
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(300_000), refunds: [] },
      ]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: fixedNow,
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("wtier_diamond_5");
      expect(result.tierChanged).toBe(true);

      // Exactly 4 entry bonus grants: Tier 2 Silver (100), Tier 3 Gold (250), Tier 4 Platinum (500), Tier 5 Diamond (1000)
      expect(mocks.appendPointsLedgerEntry).toHaveBeenCalledTimes(4);

      const deltas = mocks.appendPointsLedgerEntry.mock.calls.map(
        ([c]: any) => c.pointsDelta,
      );
      expect(deltas).toEqual([
        BigInt(100),
        BigInt(250),
        BigInt(500),
        BigInt(1000),
      ]);

      // All keys must be distinct and contain the crossed tier id
      const keys = mocks.appendPointsLedgerEntry.mock.calls.map(
        ([c]: any) => c.idempotencyKey,
      );
      const uniqueKeys = new Set(keys);
      expect(uniqueKeys.size).toBe(4);
    });

    it("mega-checkout arithmetic stress ($1,000,000.00 / 100,000,000 minor units) preserves BigInt precision without overflow", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_bronze_1",
        currentTier: FIVE_TIERS[0],
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      // $1,000,000.00 order
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(100_000_000), refunds: [] },
      ]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: fixedNow,
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("wtier_diamond_5");
      expect(result.qualifyingSpend).toBe(BigInt(100_000_000));
      expect(mocks.accountUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tierSpendRolling12Months: BigInt(100_000_000),
          }),
        }),
      );
    });

    it("intermediate tiers with zero entry bonus points are skipped cleanly from ledger writes", async () => {
      const tiersWithZeroBonus = [
        FIVE_TIERS[0],
        { ...FIVE_TIERS[1], entryBonusPoints: BigInt(0) }, // Silver has 0
        { ...FIVE_TIERS[2], entryBonusPoints: BigInt(0) }, // Gold has 0
        FIVE_TIERS[3], // Platinum has 500
        FIVE_TIERS[4], // Diamond has 1000
      ];

      const account = buildMockAccount({
        currentTierId: "wtier_bronze_1",
        currentTier: tiersWithZeroBonus[0],
        program: {
          ...buildMockAccount().program,
          tiers: tiersWithZeroBonus,
        },
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(300_000), refunds: [] },
      ]);

      await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: fixedNow,
      });

      // Silver and Gold had 0 entry bonus -> only Platinum and Diamond must receive bonus ledger entries!
      expect(mocks.appendPointsLedgerEntry).toHaveBeenCalledTimes(2);
      expect(mocks.appendPointsLedgerEntry.mock.calls[0][0].pointsDelta).toBe(
        BigInt(500),
      );
      expect(mocks.appendPointsLedgerEntry.mock.calls[1][0].pointsDelta).toBe(
        BigInt(1000),
      );
    });

    it("fails fast with descriptive error if unsequenced tier history exists prior to promotion", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_bronze_1",
        currentTier: FIVE_TIERS[0],
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(60_000), refunds: [] },
      ]);

      // Simulate unsequenced tier history row anomaly
      mockUnsequencedRow = {
        id: "wtier_hist_corrupt_null",
        sequenceNumber: null,
      };

      await expect(
        evaluateTierMaintenanceCycle({
          storeId: STORE_ID,
          accountId: account.id,
          now: fixedNow,
        }),
      ).rejects.toThrow(/unsequenced tier history/i);

      expect(mocks.appendPointsLedgerEntry).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 2. REQUALIFICATION DURING GRACE PERIOD & BOUNDARY HORIZONS
  // ===========================================================================
  describe("2. Requalification During Grace Period & Edge Horizons", () => {
    const t0 = new Date("2026-08-01T00:00:00.000Z");
    const graceExpiresAt = new Date(t0.getTime() + 30 * 24 * 60 * 60 * 1000); // Day 30

    it("requalification at exact threshold boundary: tierExpiresAt is immediately cleared to null and tier is MAINTAINED", async () => {
      // Customer is at Gold (minSpendThreshold: 50,000), currently under active grace
      const account = buildMockAccount({
        currentTierId: "wtier_gold_3",
        currentTier: FIVE_TIERS[2],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      // Customer makes a checkout of EXACTLY 50,000
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(50_000), refunds: [] },
      ]);

      const midGraceDate = new Date(t0.getTime() + 15 * 24 * 60 * 60 * 1000);
      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: midGraceDate,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("wtier_gold_3");

      // tierExpiresAt cleared to null
      expect(mocks.accountUpdate).toHaveBeenCalledWith({
        where: { id: account.id },
        data: expect.objectContaining({
          tierExpiresAt: null,
          tierSpendRolling12Months: BigInt(50_000),
        }),
      });

      // No demotion or downgrade history record
      expect(mocks.tierHistoryCreate).not.toHaveBeenCalled();
    });

    it("requalification exceeding current tier: clears tierExpiresAt and PROMOTES account with delta bonus", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_gold_3",
        currentTier: FIVE_TIERS[2],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      // Spends $1,200 (120,000 minor units) -> exceeds Gold and qualifies for Platinum (100,000)
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(120_000), refunds: [] },
      ]);

      const midGraceDate = new Date(t0.getTime() + 10 * 24 * 60 * 60 * 1000);
      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: midGraceDate,
      });

      expect(result.status).toBe("PROMOTED");
      expect(result.newTierId).toBe("wtier_platinum_4");
      expect(result.tierChanged).toBe(true);

      expect(mocks.accountUpdate).toHaveBeenCalledWith({
        where: { id: account.id },
        data: expect.objectContaining({
          currentTierId: "wtier_platinum_4",
          tierExpiresAt: null, // Grace cleared!
        }),
      });

      // Entry bonus granted for Platinum (500 pts)
      expect(mocks.appendPointsLedgerEntry).toHaveBeenCalledTimes(1);
      expect(mocks.appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          pointsDelta: BigInt(500),
          referenceId: "wtier_platinum_4",
        }),
      );
    });

    it("under-threshold recovery spend (< 50,000) does NOT clear grace period and maintains IN_GRACE_PERIOD", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_gold_3",
        currentTier: FIVE_TIERS[2],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      // Spends 30,000 (< 50,000 required for Gold)
      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(30_000), refunds: [] },
      ]);

      const midGraceDate = new Date(t0.getTime() + 20 * 24 * 60 * 60 * 1000);
      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: midGraceDate,
      });

      expect(result.status).toBe("IN_GRACE_PERIOD");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("wtier_gold_3"); // Still Gold
      expect(result.gracePeriodExpiresAt?.toISOString()).toBe(
        graceExpiresAt.toISOString(),
      );

      // Account update must NOT clear tierExpiresAt
      expect(mocks.accountUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tierExpiresAt: null }),
        }),
      );
    });

    it("micro-spend 1 millisecond before grace expiration successfully requalifies member", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_gold_3",
        currentTier: FIVE_TIERS[2],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      mocks.orderFindMany.mockResolvedValueOnce([
        { shopTotal: BigInt(55_000), refunds: [] },
      ]);

      // Exactly 1ms before expiration: 2026-08-30T23:59:59.999Z
      const lastInstant = new Date(graceExpiresAt.getTime() - 1);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: lastInstant,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.newTierId).toBe("wtier_gold_3");
      expect(mocks.accountUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tierExpiresAt: null }),
        }),
      );
    });

    it("net refund deduction during grace does not result in negative spend or state corruption", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_gold_3",
        currentTier: FIVE_TIERS[2],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);

      // Refund exceeds gross total
      mocks.orderFindMany.mockResolvedValueOnce([
        {
          shopTotal: BigInt(10_000),
          refunds: [{ shopAmount: BigInt(25_000) }],
        },
      ]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: new Date(t0.getTime() + 15 * 24 * 60 * 60 * 1000),
      });

      expect(result.status).toBe("IN_GRACE_PERIOD");
      expect(result.qualifyingSpend).toBe(BigInt(0)); // Floored at zero!
    });
  });

  // ===========================================================================
  // 3. EXPIRED GRACE SINGLE-STEP DEMOTION & IMMUNITY INVARIANTS
  // ===========================================================================
  describe("3. Expired Grace Single-Step Demotion & Immunity Invariants", () => {
    const t0 = new Date("2026-08-01T00:00:00.000Z");
    const graceExpiresAt = new Date(t0.getTime() + 30 * 24 * 60 * 60 * 1000);
    const postExpiryNow = new Date(t0.getTime() + 31 * 24 * 60 * 60 * 1000);

    it("Tier 5 (Diamond) demotes by exactly one step to Tier 4 (Platinum), NOT to Tier 1 (Bronze)", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_diamond_5",
        currentTier: FIVE_TIERS[4],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([]); // 0 spend

      mockLatestHistoryRow = { id: "wtier_hist_8", sequenceNumber: 8 };

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: postExpiryNow,
      });

      expect(result.status).toBe("DEMOTED");
      expect(result.tierChanged).toBe(true);
      expect(result.previousTierId).toBe("wtier_diamond_5");
      expect(result.newTierId).toBe("wtier_platinum_4");

      // Verify tier history creation
      expect(mocks.tierHistoryCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountId: account.id,
          sequenceNumber: 9,
          fromTierId: "wtier_diamond_5",
          toTierId: "wtier_platinum_4",
          changeReason: WeleticLoyaltyTierChangeReason.annual_downgrade,
        }),
      });

      // Verify METAFIELD_SYNC enqueued for demotion
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

    it("Tier 4 (Platinum) demotes by exactly one step to Tier 3 (Gold)", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_platinum_4",
        currentTier: FIVE_TIERS[3],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: postExpiryNow,
      });

      expect(result.status).toBe("DEMOTED");
      expect(result.previousTierId).toBe("wtier_platinum_4");
      expect(result.newTierId).toBe("wtier_gold_3");
      expect(result.tierChanged).toBe(true);
    });

    it("Tier 3 (Gold) demotes by exactly one step to Tier 2 (Silver)", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_gold_3",
        currentTier: FIVE_TIERS[2],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: postExpiryNow,
      });

      expect(result.status).toBe("DEMOTED");
      expect(result.previousTierId).toBe("wtier_gold_3");
      expect(result.newTierId).toBe("wtier_silver_2");
    });

    it("Tier 2 (Silver) demotes to Tier 1 (Bronze)", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_silver_2",
        currentTier: FIVE_TIERS[1],
        tierExpiresAt: graceExpiresAt,
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: postExpiryNow,
      });

      expect(result.status).toBe("DEMOTED");
      expect(result.previousTierId).toBe("wtier_silver_2");
      expect(result.newTierId).toBe("wtier_bronze_1");
    });

    it("base tier (Tier 1 Bronze) is NEVER demoted even under $0 spend and expired timestamp", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_bronze_1",
        currentTier: FIVE_TIERS[0],
        tierExpiresAt: graceExpiresAt, // Stale expiry timestamp
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: postExpiryNow,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("wtier_bronze_1");
      expect(mocks.tierHistoryCreate).not.toHaveBeenCalled();

      // tierExpiresAt cleared
      expect(mocks.accountUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ tierExpiresAt: null }),
        }),
      );
    });

    it("lifetime timeframe programs guarantee demotion immunity regardless of spend", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_diamond_5",
        currentTier: FIVE_TIERS[4],
        program: {
          ...buildMockAccount().program,
          vipTimeframe: WeleticVipTimeframe.lifetime,
          vipAutoDowngradeEnabled: true,
        },
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: postExpiryNow,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("wtier_diamond_5");
      expect(mocks.tierHistoryCreate).not.toHaveBeenCalled();
    });

    it("merchant disabled auto-downgrade (vipAutoDowngradeEnabled: false) protects member from demotion", async () => {
      const account = buildMockAccount({
        currentTierId: "wtier_platinum_4",
        currentTier: FIVE_TIERS[3],
        program: {
          ...buildMockAccount().program,
          vipAutoDowngradeEnabled: false,
        },
      });
      mocks.accountFindUnique.mockResolvedValueOnce(account);
      mocks.orderFindMany.mockResolvedValueOnce([]);

      const result = await evaluateTierMaintenanceCycle({
        storeId: STORE_ID,
        accountId: account.id,
        now: postExpiryNow,
      });

      expect(result.status).toBe("MAINTAINED");
      expect(result.tierChanged).toBe(false);
      expect(result.newTierId).toBe("wtier_platinum_4");
      expect(mocks.tierHistoryCreate).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 4. CUSTOMER METAFIELD SANITIZATION UNDER ADVERSARIAL PAYLOADS
  // ===========================================================================
  describe("4. Customer Metafield Sanitization Under Adversarial Payloads", () => {
    it("handles adversarial injection payloads in ownerId, referralCode, and tierName without error", () => {
      const adversarialPayload = {
        ownerId: "gid://shopify/Customer/9876543210'; DROP TABLE Users; --",
        vipTierName: "<script>alert('XSS')</script>Platinum",
        vipTierOrder: 4,
        pointsBalance: "999999999999",
        pendingPoints: 0,
        lifetimePoints: 1000000000,
        referralCode: "SQL'OR'1'='1'--",
        referralLink: "https://shop.com?ref=SQL%27OR%271%27=%271",
        tierMultiplier: 2.0,
        memberStatus: "IN_GRACE_PERIOD",
        birthDate: "1990-01-01",
      };

      const updates = buildCustomerMetafieldUpdates(adversarialPayload);
      expect(updates).toHaveLength(10);

      // Namespace must strictly be WELETIC_LOYALTY_NAMESPACE
      for (const m of updates) {
        expect(m.namespace).toBe(WELETIC_LOYALTY_NAMESPACE);
      }

      const map = new Map(updates.map((u) => [u.key, u.value]));
      expect(map.get("vip_tier")).toBe("<script>alert('XSS')</script>Platinum");
      expect(map.get("referral_code")).toBe("SQL'OR'1'='1'--");
      expect(map.get("member_status")).toBe("in_grace_period"); // Lowercased
    });

    it("asserts strict exclusion of customer PII (email, phone, name) from all generated metafields", () => {
      const updates = buildCustomerMetafieldUpdates({
        ownerId: "gid://shopify/Customer/123456",
        vipTierName: "Gold",
        vipTierOrder: 3,
        pointsBalance: 500,
        pendingPoints: 50,
        lifetimePoints: 1200,
        referralCode: "GOLD123",
        referralLink: "https://yamax.myshopify.com?ref=GOLD123",
        tierMultiplier: 1.5,
        memberStatus: "active",
      });

      // Assert no sensitive PII keys are ever emitted
      const generatedKeys = updates.map((u) => u.key);
      const prohibitedKeys = [
        "email",
        "customer_email",
        "phone",
        "phone_number",
        "mobile",
        "firstName",
        "first_name",
        "lastName",
        "last_name",
        "password",
        "token",
      ];

      for (const forbidden of prohibitedKeys) {
        expect(generatedKeys).not.toContain(forbidden);
      }

      // Assert serialized payload has zero email or phone regex matches
      const serialized = JSON.stringify(updates);
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
      const phoneRegex = /\+?[0-9]{10,15}/;

      expect(emailRegex.test(serialized)).toBe(false);
      expect(phoneRegex.test(serialized)).toBe(false);
    });

    it("normalizes malformed and diverse Shopify Customer GID formats correctly", () => {
      // Clean numeric
      expect(normalizeShopifyCustomerGid("99887766")).toBe(
        "gid://shopify/Customer/99887766",
      );
      // Already formatted GID
      expect(
        normalizeShopifyCustomerGid("gid://shopify/Customer/99887766"),
      ).toBe("gid://shopify/Customer/99887766");
      // Customer/ prefix
      expect(normalizeShopifyCustomerGid("Customer/99887766")).toBe(
        "gid://shopify/Customer/99887766",
      );
      // Empty input
      expect(normalizeShopifyCustomerGid("")).toBe("");
      // String with trailing trash
      expect(normalizeShopifyCustomerGid("Customer/12345/trash?extra=1")).toBe(
        "gid://shopify/Customer/123451",
      );
    });

    it("sanitizes non-standard tierMultiplier inputs (NaN, strings, extreme floats) cleanly", () => {
      const updatesNaN = buildCustomerMetafieldUpdates({
        tierMultiplier: NaN,
      });
      const mapNaN = new Map(updatesNaN.map((u) => [u.key, u.value]));
      expect(mapNaN.get("tier_multiplier")).toBe("1.00");

      const updatesString = buildCustomerMetafieldUpdates({
        tierMultiplier: "not_a_number",
      });
      const mapString = new Map(updatesString.map((u) => [u.key, u.value]));
      expect(mapString.get("tier_multiplier")).toBe("1.00");

      const updatesFloat = buildCustomerMetafieldUpdates({
        tierMultiplier: 2.345678,
      });
      const mapFloat = new Map(updatesFloat.map((u) => [u.key, u.value]));
      expect(mapFloat.get("tier_multiplier")).toBe("2.35");
    });
  });

  // ===========================================================================
  // 5. HIGH-VOLUME CRON SWEEP DAEMON & DEDUPLICATION
  // ===========================================================================
  describe("5. High-Volume Cron Sweep Daemon & Deduplication Stress", () => {
    const sweepNow = new Date("2026-09-04T12:00:00.000Z");
    const expiredTimestamp = new Date("2026-09-04T08:00:00.000Z");

    it("enqueues sweep review jobs across 100 expired accounts with deterministic idempotency keys", async () => {
      mocks.programFindMany.mockResolvedValueOnce([
        {
          storeId: STORE_ID,
          vipTimeframe: WeleticVipTimeframe.rolling_12m,
          vipDowngradeGraceDays: 30,
        },
      ]);

      // Generate 100 mock expired accounts
      const candidateAccounts = Array.from({ length: 100 }, (_, i) => ({
        id: `wacc_expired_${i + 1}`,
        tierExpiresAt: expiredTimestamp,
      }));

      mocks.accountFindMany
        .mockResolvedValueOnce(candidateAccounts)
        .mockResolvedValueOnce([]);

      const sweepResult = await enqueueTierReviewSweepJobs({
        now: sweepNow,
        batchSize: 150,
      });

      expect(sweepResult).toEqual({
        programsScanned: 1,
        programsSkipped: 0,
        accountsEvaluated: 100,
        jobsEnqueued: 100,
        programFailures: [],
      });

      expect(
        mocks.enqueueOutboxJobFromProgramTransaction,
      ).toHaveBeenCalledTimes(100);

      // Verify idempotency key structure on first and last call
      const firstCall =
        mocks.enqueueOutboxJobFromProgramTransaction.mock.calls[0][0];
      const lastCall =
        mocks.enqueueOutboxJobFromProgramTransaction.mock.calls[99][0];

      expect(firstCall.idempotencyKey).toBe(
        `tier_review_sweep:wacc_expired_1:${expiredTimestamp.getTime()}`,
      );
      expect(lastCall.idempotencyKey).toBe(
        `tier_review_sweep:wacc_expired_100:${expiredTimestamp.getTime()}`,
      );
      expect(firstCall.priority).toBe(5);
    });

    it("deduplication guarantee: re-running sweep on identical state generates exact identical idempotency keys", async () => {
      mocks.programFindMany.mockResolvedValue([
        {
          storeId: STORE_ID,
          vipTimeframe: WeleticVipTimeframe.rolling_12m,
          vipDowngradeGraceDays: 30,
        },
      ]);

      const singleAccount = [
        { id: "wacc_dedup_test", tierExpiresAt: expiredTimestamp },
      ];
      mocks.accountFindMany.mockResolvedValue(singleAccount);

      // Run 1
      await enqueueTierReviewSweepJobs({ now: sweepNow });
      const key1 =
        mocks.enqueueOutboxJobFromProgramTransaction.mock.calls[0][0]
          .idempotencyKey;

      // Run 2
      await enqueueTierReviewSweepJobs({ now: sweepNow });
      const key2 =
        mocks.enqueueOutboxJobFromProgramTransaction.mock.calls[1][0]
          .idempotencyKey;

      expect(key1).toBe(key2);
      expect(key1).toBe(
        `tier_review_sweep:wacc_dedup_test:${expiredTimestamp.getTime()}`,
      );
    });

    it("strictly respects batchSize bounding across programs", async () => {
      mocks.programFindMany.mockResolvedValueOnce([
        {
          storeId: "store_1",
          vipTimeframe: WeleticVipTimeframe.rolling_12m,
          vipDowngradeGraceDays: 30,
        },
        {
          storeId: "store_2",
          vipTimeframe: WeleticVipTimeframe.rolling_12m,
          vipDowngradeGraceDays: 30,
        },
      ]);

      // Program 1 has 20 accounts, but batchSize is set to 5
      mocks.accountFindMany.mockResolvedValueOnce(
        Array.from({ length: 5 }, (_, i) => ({
          id: `wacc_store1_${i}`,
          tierExpiresAt: expiredTimestamp,
        })),
      );

      const sweepResult = await enqueueTierReviewSweepJobs({
        now: sweepNow,
        batchSize: 5,
      });

      expect(sweepResult.jobsEnqueued).toBe(5);
      // Program 2 should not even be scanned because remaining became 0
      expect(sweepResult.programsScanned).toBe(1);
    });

    it("isolates errors on one store without crashing sweep daemon for other stores", async () => {
      mocks.programFindMany.mockResolvedValueOnce([
        {
          storeId: "store_failing",
          vipTimeframe: WeleticVipTimeframe.rolling_12m,
          vipDowngradeGraceDays: 30,
        },
        {
          storeId: "store_healthy",
          vipTimeframe: WeleticVipTimeframe.rolling_12m,
          vipDowngradeGraceDays: 30,
        },
      ]);

      mocks.accountFindMany
        .mockRejectedValueOnce(new Error("Prisma Client Timeout"))
        .mockResolvedValueOnce([
          { id: "wacc_healthy_1", tierExpiresAt: expiredTimestamp },
        ]);

      const sweepResult = await enqueueTierReviewSweepJobs({
        now: sweepNow,
        batchSize: 50,
      });

      expect(sweepResult.programsScanned).toBe(2);
      expect(sweepResult.programsSkipped).toBe(1); // 1 skipped cleanly
      expect(sweepResult.jobsEnqueued).toBe(1); // Healthy store succeeded!
      expect(sweepResult.programFailures).toEqual([
        { storeId: "store_failing", error: "Prisma Client Timeout" },
      ]);
    });
  });

  // ===========================================================================
  // 6. CLI VALIDATION SCRIPTS STRESS TESTING (Exit Code 0 & JSON Assertions)
  // ===========================================================================
  describe("6. CLI Validation Scripts Stress Testing", () => {
    it("validate-vip-lifecycle.ts: exits with code 0 and valid JSON report in --mock mode", () => {
      const { exitCode, stdout } = runCliScript(
        "scripts/loyalty/validate-vip-lifecycle.ts",
        ["--mock", "--json"],
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.overallStatus).toBe("PASSED");
      expect(report.executionMode).toBe("mock");
      expect(report.provenance.source).toBe("simulated");
      expect(report.summary.totalChecks).toBeGreaterThan(0);
      expect(report.summary.failedChecks).toBe(0);
    }, 30000);

    it("validate-vip-lifecycle.ts: exits with code 0 and valid JSON report in --dry-run mode", () => {
      const { exitCode, stdout } = runCliScript(
        "scripts/loyalty/validate-vip-lifecycle.ts",
        ["--dry-run", "--json"],
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.overallStatus).toBe("PASSED");
      expect(report.executionMode).toBe("dry-run");
      expect(report.provenance.source).toBe("local-static");
      expect(report.summary.failedChecks).toBe(0);
    }, 30000);

    it("validate-points-expiry-lifecycle.ts: exits with code 0 and valid JSON report in --mock mode", () => {
      const { exitCode, stdout } = runCliScript(
        "scripts/loyalty/validate-points-expiry-lifecycle.ts",
        ["--mock", "--json"],
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.overallStatus).toBe("PASSED");
      expect(report.summary.totalChecks).toBeGreaterThan(0);
      expect(report.summary.failedChecks).toBe(0);
    }, 30000);

    it("validate-points-expiry-lifecycle.ts: exits with code 0 and valid JSON report in --dry-run mode", () => {
      const { exitCode, stdout } = runCliScript(
        "scripts/loyalty/validate-points-expiry-lifecycle.ts",
        ["--dry-run", "--json"],
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.overallStatus).toBe("PASSED");
      expect(report.provenance.source).toBe("local-static");
      expect(report.summary.failedChecks).toBe(0);
    }, 30000);

    it("validate-referrals-matrix.ts: exits with code 0 and valid JSON report in --mock mode", () => {
      const { exitCode, stdout } = runCliScript(
        "scripts/loyalty/validate-referrals-matrix.ts",
        ["--mock", "--json"],
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.overallStatus).toBe("PASSED");
      expect(report.summary.totalChecks).toBeGreaterThan(0);
      expect(report.summary.failedChecks).toBe(0);
    }, 30000);

    it("validate-referrals-matrix.ts: exits with code 0 and valid JSON report in --dry-run mode", () => {
      const { exitCode, stdout } = runCliScript(
        "scripts/loyalty/validate-referrals-matrix.ts",
        ["--dry-run", "--json"],
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.overallStatus).toBe("PASSED");
      expect(report.provenance.source).toBe("local-static");
      expect(report.summary.failedChecks).toBe(0);
    }, 30000);

    it("adversarial flag tolerance: scripts gracefully handle unrecognized flags alongside --mock --json", () => {
      const { exitCode, stdout } = runCliScript(
        "scripts/loyalty/validate-vip-lifecycle.ts",
        ["--bogus-flag-123", "--unknown-flag", "--mock", "--json"],
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(stdout);
      expect(report.overallStatus).toBe("PASSED");
    }, 30000);

    it("live safety guardrail: --live without --confirm-staging exits with code 1 and outputs structured failure JSON across all 3 scripts", () => {
      const scripts = [
        "scripts/loyalty/validate-vip-lifecycle.ts",
        "scripts/loyalty/validate-points-expiry-lifecycle.ts",
        "scripts/loyalty/validate-referrals-matrix.ts",
      ];

      for (const script of scripts) {
        const { exitCode, stdout } = runCliScript(script, ["--live", "--json"]);

        expect(exitCode).toBe(1);
        const report = JSON.parse(stdout);
        expect(report.overallStatus).toBe("FAILED");
        expect(report.error).toMatch(/--confirm-staging/i);
      }
    }, 45000);
  });
});
