import { prisma } from "@/lib/prisma";
import {
  enqueueOutboxJob,
  processOutboxJobsBatch,
} from "@/lib/weletic/loyalty/outbox";
import {
  auditAccountLedger,
  auditAllStores,
  auditStoreLedgers,
} from "@/lib/weletic/loyalty/reconciliation";
import {
  WeleticLoyaltyAccountStatus,
  WeleticLoyaltyOutboxJobStatus,
  WeleticLoyaltyOutboxJobType,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateLedgerVersions } from "../../scripts/loyalty/migrate-ledger-version";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    weleticShopifyStore: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(),
    },
    weleticRewardRedemption: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn((fns) =>
      Array.isArray(fns) ? Promise.all(fns) : fns(prisma),
    ),
  },
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

describe("Milestone 2 (M2) Adversarial Stress & Quarantine Verification Suite (Challenger 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$transaction).mockImplementation((fns: any) =>
      Array.isArray(fns) ? Promise.all(fns) : fns(prisma),
    );
  });

  // =========================================================================
  // Scope 1: Massive Sequence Gaps & Discontinuities Stress Testing
  // =========================================================================
  describe("Scope 1: Massive Sequence Gaps & Discontinuities Stress Testing", () => {
    it("1.1: Detects sequence gap starting from non-1 initial sequence (e.g. seq=100) and quarantines safely", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_gap_start",
        storeId: "store_m2_adv",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(500),
        lifetimePointsEarned: BigInt(500),
        lifetimePointsRedeemed: BigInt(0),
        metadata: {},
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "entry_jump_start",
          sequenceNumber: 100, // expected 1
          pointsDelta: BigInt(500),
          balanceAfter: BigInt(500),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_gap_start", {
        quarantineFatal: true,
      });

      expect(audit.isClean).toBe(false);
      expect(audit.quarantined).toBe(true);
      expect(audit.repaired).toBe(false);
      expect(audit.anomalies.length).toBeGreaterThanOrEqual(1);

      const gapAnomaly = audit.anomalies.find((a) => a.type === "SEQUENCE_GAP");
      expect(gapAnomaly).toBeDefined();
      expect(gapAnomaly?.severity).toBe("CRITICAL");
      expect(gapAnomaly?.actionTaken).toBe("QUARANTINED");
      expect(gapAnomaly?.details).toEqual(
        expect.objectContaining({
          expectedSequence: 1,
          actualSequence: 100,
        }),
      );

      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
        where: { id: "acc_gap_start" },
        data: {
          status: WeleticLoyaltyAccountStatus.suspended,
          metadata: expect.objectContaining({
            quarantine: expect.objectContaining({
              isQuarantined: true,
              anomalyCount: expect.any(Number),
            }),
          }),
        },
      });
    });

    it("1.2: Detects astronomical sequence gap jump (e.g. seq=1 to seq=1,000,000) without integer overflow or crash", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_mega_gap",
        storeId: "store_m2_adv",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(2000),
        lifetimePointsEarned: BigInt(2000),
        lifetimePointsRedeemed: BigInt(0),
        metadata: {},
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "entry_1",
          sequenceNumber: 1,
          pointsDelta: BigInt(1000),
          balanceAfter: BigInt(1000),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
        {
          id: "entry_2",
          sequenceNumber: 1000000, // astronomical gap: expected 2
          pointsDelta: BigInt(1000),
          balanceAfter: BigInt(2000),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_mega_gap", {
        quarantineFatal: true,
      });

      expect(audit.isClean).toBe(false);
      expect(audit.quarantined).toBe(true);
      expect(audit.anomalies.some((a) => a.type === "SEQUENCE_GAP")).toBe(true);
      expect(audit.calculatedBalance).toBe(BigInt(2000));
    });

    it("1.3: Quarantines safely when multiple interleaved sequence gaps exist across 50 ledger entries", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_multi_gap",
        storeId: "store_m2_adv",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(500),
        lifetimePointsEarned: BigInt(500),
        lifetimePointsRedeemed: BigInt(0),
        metadata: {},
      } as any);

      // Generate 50 entries with several gaps (e.g. odd sequences 1, 3, 5, 7...)
      const entries = Array.from({ length: 50 }, (_, i) => ({
        id: `entry_${i}`,
        sequenceNumber: i * 2 + 1, // 1, 3, 5, 7...
        pointsDelta: BigInt(10),
        balanceAfter: BigInt((i + 1) * 10),
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
      }));

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue(
        entries as any,
      );

      const audit = await auditAccountLedger("acc_multi_gap", {
        quarantineFatal: true,
      });

      expect(audit.isClean).toBe(false);
      expect(audit.quarantined).toBe(true);
      // Gaps detected starting from i=1 (expected 2, found 3)
      const gapAnomalies = audit.anomalies.filter(
        (a) => a.type === "SEQUENCE_GAP",
      );
      expect(gapAnomalies.length).toBe(49);
    });
  });

  // =========================================================================
  // Scope 2: Sequence Collisions & Multi-Entry Duplication Stress Testing
  // =========================================================================
  describe("Scope 2: Sequence Collisions & Multi-Entry Duplication Stress Testing", () => {
    it("2.1: Detects dense collision cluster (5 duplicate entries on sequence=1) and marks CRITICAL", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_dense_collision",
        storeId: "store_m2_adv",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(500),
        lifetimePointsEarned: BigInt(500),
        lifetimePointsRedeemed: BigInt(0),
        metadata: {},
      } as any);

      const entries = Array.from({ length: 5 }, (_, i) => ({
        id: `e_dup_${i}`,
        sequenceNumber: 1, // duplicate sequence = 1 for all entries
        pointsDelta: BigInt(100),
        balanceAfter: BigInt((i + 1) * 100),
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
      }));

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue(
        entries as any,
      );

      const audit = await auditAccountLedger("acc_dense_collision", {
        quarantineFatal: true,
      });

      expect(audit.isClean).toBe(false);
      expect(audit.quarantined).toBe(true);

      const collisionAnomalies = audit.anomalies.filter(
        (a) => a.type === "SEQUENCE_COLLISION",
      );
      expect(collisionAnomalies.length).toBe(4); // 4 duplicate occurrences
      expect(collisionAnomalies.every((a) => a.severity === "CRITICAL")).toBe(
        true,
      );
    });

    it("2.2: Detects simultaneous sequence collision, sequence gap, and running balance discontinuity", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_triple_fatal",
        storeId: "store_m2_adv",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(999),
        lifetimePointsEarned: BigInt(999),
        lifetimePointsRedeemed: BigInt(0),
        metadata: { tier: "gold" },
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "e1",
          sequenceNumber: 1,
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(100),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
        {
          id: "e2_collision",
          sequenceNumber: 1, // collision (seq 1 repeated) & gap (expected 2)
          pointsDelta: BigInt(50),
          balanceAfter: BigInt(888), // balance discontinuity (expected 150)
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_triple_fatal", {
        quarantineFatal: true,
      });

      expect(audit.isClean).toBe(false);
      expect(audit.quarantined).toBe(true);

      const types = audit.anomalies.map((a) => a.type);
      expect(types).toContain("SEQUENCE_COLLISION");
      expect(types).toContain("SEQUENCE_GAP");
      expect(types).toContain("BALANCE_CHAIN_DISCONTINUITY");

      // Verify existing metadata (e.g. tier: gold) is preserved when adding quarantine metadata
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "acc_triple_fatal" },
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              tier: "gold",
              quarantine: expect.objectContaining({
                isQuarantined: true,
              }),
            }),
          }),
        }),
      );
    });
  });

  // =========================================================================
  // Scope 3: Double-Entry Negative Running Balances & Refund Clawbacks
  // =========================================================================
  describe("Scope 3: Double-Entry Negative Running Balances & Refund Clawbacks", () => {
    it("3.1: Validates legitimate negative running balance as clean (no false-positive quarantine)", async () => {
      // Scenario: Earn 1000 pts -> Redeem 1000 pts -> Return/Refund claws back 300 pts -> balance = -300
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_negative_clean",
        storeId: "store_m2_adv",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(-300),
        lifetimePointsEarned: BigInt(1000),
        lifetimePointsRedeemed: BigInt(1000),
        metadata: null,
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "e1_earn",
          sequenceNumber: 1,
          pointsDelta: BigInt(1000),
          balanceAfter: BigInt(1000),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
        {
          id: "e2_redeem",
          sequenceNumber: 2,
          pointsDelta: BigInt(-1000),
          balanceAfter: BigInt(0),
          entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        },
        {
          id: "e3_refund_clawback",
          sequenceNumber: 3,
          pointsDelta: BigInt(-300),
          balanceAfter: BigInt(-300),
          entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_negative_clean");

      expect(audit.isClean).toBe(true);
      expect(audit.quarantined).toBe(false);
      expect(audit.repaired).toBe(false);
      expect(audit.anomalies.length).toBe(0);
      expect(audit.calculatedBalance).toBe(BigInt(-300));
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
    });

    it("3.2: Auto-repairs cached balance drift on an account with legitimate negative running balance", async () => {
      // Authoritative ledger is -450, but cached balance was drifted to 0
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_negative_drift",
        storeId: "store_m2_adv",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(0), // Drifted!
        lifetimePointsEarned: BigInt(500),
        lifetimePointsRedeemed: BigInt(500),
        metadata: null,
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "e1",
          sequenceNumber: 1,
          pointsDelta: BigInt(500),
          balanceAfter: BigInt(500),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
        {
          id: "e2",
          sequenceNumber: 2,
          pointsDelta: BigInt(-500),
          balanceAfter: BigInt(0),
          entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        },
        {
          id: "e3",
          sequenceNumber: 3,
          pointsDelta: BigInt(-450),
          balanceAfter: BigInt(-450),
          entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_negative_drift", {
        autoRepair: true,
      });

      expect(audit.isClean).toBe(false);
      expect(audit.repaired).toBe(true);
      expect(audit.quarantined).toBe(false);
      expect(audit.calculatedBalance).toBe(BigInt(-450));
      expect(
        audit.anomalies.some((a) => a.type === "CACHE_BALANCE_DRIFT"),
      ).toBe(true);

      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
        where: { id: "acc_negative_drift" },
        data: {
          cachedPointsBalance: BigInt(-450),
          lifetimePointsEarned: BigInt(500),
          lifetimePointsRedeemed: BigInt(500),
        },
      });
    });

    it("3.3: Quarantines when negative balance calculation has chain discontinuity", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_negative_broken",
        storeId: "store_m2_adv",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(-100),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(200),
        metadata: {},
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "e1",
          sequenceNumber: 1,
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(100),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
        {
          id: "e2",
          sequenceNumber: 2,
          pointsDelta: BigInt(-200),
          balanceAfter: BigInt(-50), // Discontinuity! 100 - 200 = -100, but recorded -50
          entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_negative_broken", {
        quarantineFatal: true,
      });

      expect(audit.isClean).toBe(false);
      expect(audit.quarantined).toBe(true);
      expect(
        audit.anomalies.some((a) => a.type === "BALANCE_CHAIN_DISCONTINUITY"),
      ).toBe(true);
    });
  });

  // =========================================================================
  // Scope 4: Cache Balance & Lifetime Metric Drift Auto-Repair Matrix
  // =========================================================================
  describe("Scope 4: Cache Balance & Lifetime Metric Drift Auto-Repair Matrix", () => {
    it("4.1: Auto-repairs zero-entry account with non-zero ghost cached points", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_ghost_balance",
        storeId: "store_m2_adv",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(1500), // Ghost points with 0 ledger entries
        lifetimePointsEarned: BigInt(1500),
        lifetimePointsRedeemed: BigInt(0),
        metadata: null,
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([]);

      const audit = await auditAccountLedger("acc_ghost_balance", {
        autoRepair: true,
      });

      expect(audit.isClean).toBe(false);
      expect(audit.repaired).toBe(true);
      expect(audit.quarantined).toBe(false);
      expect(audit.calculatedBalance).toBe(BigInt(0));

      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
        where: { id: "acc_ghost_balance" },
        data: {
          cachedPointsBalance: BigInt(0),
          lifetimePointsEarned: BigInt(0),
          lifetimePointsRedeemed: BigInt(0),
        },
      });
    });

    it("4.2: Suppresses auto-repair when autoRepair=false (Audit/Dry-run mode)", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_drift_dry",
        storeId: "store_m2_adv",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(99),
        lifetimePointsEarned: BigInt(99),
        lifetimePointsRedeemed: BigInt(0),
        metadata: null,
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "e1",
          sequenceNumber: 1,
          pointsDelta: BigInt(200),
          balanceAfter: BigInt(200),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_drift_dry", {
        autoRepair: false,
      });

      expect(audit.isClean).toBe(false);
      expect(audit.repaired).toBe(false);
      expect(audit.quarantined).toBe(false);
      expect(
        audit.anomalies.every((a) => a.actionTaken === "LOGGED_ONLY"),
      ).toBe(true);
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
    });

    it("4.3: Suppresses auto-repair if ANY fatal anomaly (sequence gap) is present, quarantining instead", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_drift_and_fatal",
        storeId: "store_m2_adv",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(50), // Drifted
        lifetimePointsEarned: BigInt(50),
        lifetimePointsRedeemed: BigInt(0),
        metadata: {},
      } as any);

      // Sequence gap: sequence 1, then sequence 4
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "e1",
          sequenceNumber: 1,
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(100),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
        {
          id: "e4",
          sequenceNumber: 4, // Fatal sequence gap!
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(200),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_drift_and_fatal", {
        autoRepair: true,
        quarantineFatal: true,
      });

      // Must be quarantined, NOT repaired!
      expect(audit.quarantined).toBe(true);
      expect(audit.repaired).toBe(false);
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
        where: { id: "acc_drift_and_fatal" },
        data: expect.objectContaining({
          status: WeleticLoyaltyAccountStatus.suspended,
        }),
      });
      // Ensure cachedPointsBalance was NOT blindly updated:
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            cachedPointsBalance: BigInt(200),
          }),
        }),
      );
    });
  });

  // =========================================================================
  // Scope 5: OCC ledgerVersion Migration Large Dataset & Dry-Run Safety
  // =========================================================================
  describe("Scope 5: OCC ledgerVersion Migration Large Dataset & Dry-Run Safety", () => {
    it("5.1: Evaluates 100 heterogeneous accounts in dry-run mode without modifying DB records", async () => {
      const totalCount = 100;
      vi.mocked(prisma.weleticLoyaltyAccount.count).mockResolvedValue(
        totalCount,
      );

      // 50 accounts already in sync (ledgerVersion matches maxSeq), 50 accounts need update
      const mockAccounts = Array.from({ length: totalCount }, (_, i) => ({
        id: `acc_mig_${i}`,
        storeId: "store_mig_test",
        ledgerVersion: i < 50 ? i + 1 : 0, // First 50 already in sync
      }));

      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue(
        mockAccounts as any,
      );

      const mockGroupBys = Array.from({ length: totalCount }, (_, i) => ({
        accountId: `acc_mig_${i}`,
        _max: { sequenceNumber: i + 1 },
      }));

      vi.mocked(prisma.weleticPointsLedgerEntry.groupBy).mockResolvedValue(
        mockGroupBys as any,
      );

      const result = await migrateLedgerVersions({
        batchSize: 100,
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.totalAccounts).toBe(100);
      expect(result.alreadySyncedAccounts).toBe(50);
      expect(result.updatedAccounts).toBe(50);
      expect(result.zeroEntryAccounts).toBe(0);
      expect(result.errors.length).toBe(0);
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
    });

    it("5.2: Filters migration strictly by storeId when provided", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.count).mockResolvedValue(2);
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        { id: "acc_s1_1", storeId: "target_store", ledgerVersion: 0 } as any,
        { id: "acc_s1_2", storeId: "target_store", ledgerVersion: 0 } as any,
      ]);

      vi.mocked(prisma.weleticPointsLedgerEntry.groupBy).mockResolvedValue([
        { accountId: "acc_s1_1", _max: { sequenceNumber: 10 } } as any,
        { accountId: "acc_s1_2", _max: { sequenceNumber: 20 } } as any,
      ]);

      vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValue(
        {} as any,
      );

      const result = await migrateLedgerVersions({
        storeId: "target_store",
        dryRun: false,
      });

      expect(prisma.weleticLoyaltyAccount.count).toHaveBeenCalledWith({
        where: { storeId: "target_store" },
      });
      expect(prisma.weleticLoyaltyAccount.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { storeId: "target_store" },
        }),
      );
      expect(result.updatedAccounts).toBe(2);
    });

    it("5.3: Handles database transaction failures gracefully, logging errors per account without unhandled crash", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.count).mockResolvedValue(1);
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        { id: "acc_fail_tx", storeId: "store_fail", ledgerVersion: 0 } as any,
      ]);

      vi.mocked(prisma.weleticPointsLedgerEntry.groupBy).mockResolvedValue([
        { accountId: "acc_fail_tx", _max: { sequenceNumber: 5 } } as any,
      ]);

      // Mock $transaction to reject with dead-lock error
      vi.mocked(prisma.$transaction).mockRejectedValue(
        new Error(
          "Deadlock found when trying to get lock; try restarting transaction",
        ),
      );

      const result = await migrateLedgerVersions({ dryRun: false });

      expect(result.errors.length).toBe(1);
      expect(result.errors[0].accountId).toBe("acc_fail_tx");
      expect(result.errors[0].error).toContain("Deadlock");
    });
  });

  // =========================================================================
  // Scope 6: Non-Crashing Store & Multi-Store Reconciliation Audit Harness
  // =========================================================================
  describe("Scope 6: Non-Crashing Store & Multi-Store Reconciliation Audit Harness", () => {
    it("6.1: Multi-account store audit isolates corrupted accounts without terminating audit of remaining accounts", async () => {
      // 3 Accounts in store:
      // acc_1: Clean
      // acc_2: Fatal sequence gap (quarantined)
      // acc_3: Cache drift (auto-repaired)
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        { id: "acc_1" } as any,
        { id: "acc_2" } as any,
        { id: "acc_3" } as any,
      ]);

      // Acc 1: Clean
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique)
        .mockResolvedValueOnce({
          id: "acc_1",
          storeId: "store_multi",
          status: WeleticLoyaltyAccountStatus.active,
          cachedPointsBalance: BigInt(100),
          lifetimePointsEarned: BigInt(100),
          lifetimePointsRedeemed: BigInt(0),
          metadata: {},
        } as any)
        // Acc 2: Fatal Gap
        .mockResolvedValueOnce({
          id: "acc_2",
          storeId: "store_multi",
          status: WeleticLoyaltyAccountStatus.active,
          cachedPointsBalance: BigInt(200),
          lifetimePointsEarned: BigInt(200),
          lifetimePointsRedeemed: BigInt(0),
          metadata: {},
        } as any)
        // Acc 3: Drift
        .mockResolvedValueOnce({
          id: "acc_3",
          storeId: "store_multi",
          status: WeleticLoyaltyAccountStatus.active,
          cachedPointsBalance: BigInt(0), // Drifted
          lifetimePointsEarned: BigInt(0),
          lifetimePointsRedeemed: BigInt(0),
          metadata: {},
        } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany)
        .mockResolvedValueOnce([
          {
            id: "e1",
            sequenceNumber: 1,
            pointsDelta: BigInt(100),
            balanceAfter: BigInt(100),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
        ] as any)
        .mockResolvedValueOnce([
          {
            id: "e2_gap",
            sequenceNumber: 99, // Fatal Gap!
            pointsDelta: BigInt(200),
            balanceAfter: BigInt(200),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
        ] as any)
        .mockResolvedValueOnce([
          {
            id: "e3",
            sequenceNumber: 1,
            pointsDelta: BigInt(300),
            balanceAfter: BigInt(300),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
        ] as any);

      const summary = await auditStoreLedgers("store_multi", {
        autoRepair: true,
        quarantineFatal: true,
      });

      expect(summary.totalAccounts).toBe(3);
      expect(summary.cleanAccounts).toBe(1);
      expect(summary.quarantinedAccounts).toBe(1);
      expect(summary.repairedAccounts).toBe(1);
      expect(summary.totalLedgerEntries).toBe(3);
      expect(summary.anomalies.length).toBeGreaterThanOrEqual(2);
    });

    it("6.2: auditAllStores processes multiple stores seamlessly", async () => {
      vi.mocked(prisma.weleticShopifyStore.findMany).mockResolvedValue([
        { id: "store_alpha" } as any,
        { id: "store_beta" } as any,
      ]);

      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([]);

      const summaries = await auditAllStores();

      expect(summaries.length).toBe(2);
      expect(summaries[0].storeId).toBe("store_alpha");
      expect(summaries[1].storeId).toBe("store_beta");
    });
  });

  // =========================================================================
  // Scope 7: Outbox Concurrency, Leases, and Poison Payload Adversarial Hardening
  // =========================================================================
  describe("Scope 7: Outbox Concurrency, Leases, and Poison Payload Adversarial Hardening", () => {
    it("7.1: Rejects payload with invalid types during transactional enqueueing without polluting outbox", async () => {
      await expect(
        enqueueOutboxJob({
          storeId: "store_adv",
          jobType: "INACTIVITY_EXPIRY",
          payload: {
            accountId: "acc_1",
            lastActivityAt: "2026-01-01",
            expiryMonths: -5, // Negative expiryMonths invalid!
          },
        }),
      ).rejects.toThrow();

      expect(prisma.weleticLoyaltyOutboxJob.create).not.toHaveBeenCalled();
    });

    it("7.2: Handles concurrent lease lock contention gracefully (worker skips already-locked job)", async () => {
      const candidateJob = {
        id: "woutbox_locked_by_other",
        storeId: "store_adv",
        jobType: "METAFIELD_SYNC" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        attempts: 0,
        maxAttempts: 5,
        scheduledFor: new Date(Date.now() - 5000),
        lockedAt: null,
      };

      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        candidateJob as any,
      ]);

      // updateMany returns count: 0 -> another worker grabbed the lock
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 }) // reapStaleLocks
        .mockResolvedValueOnce({ count: 0 }); // lock acquisition failed

      const summary = await processOutboxJobsBatch({ batchSize: 10 });

      expect(summary.processed).toBe(0);
      expect(summary.skipped).toBe(1);
      expect(summary.succeeded).toBe(0);
      expect(summary.failed).toBe(0);
    });

    it("7.3: Outbox worker handles unhandled handler rejection without crashing entire batch execution", async () => {
      const candidateJob = {
        id: "woutbox_poison",
        storeId: "store_adv",
        jobType: "REDEMPTION_RECOVERY" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          redemptionId: "redemp_missing",
          accountId: "acc_test",
          rewardDefinitionId: "rew_1",
          pointsCost: "100",
          shopifyDiscountCode: "CODE",
        },
        attempts: 0,
        maxAttempts: 3,
        scheduledFor: new Date(Date.now() - 5000),
        lockedAt: null,
        errorLog: [],
      };

      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        candidateJob as any,
      ]);

      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 }) // reap
        .mockResolvedValueOnce({ count: 1 }) // acquire
        .mockResolvedValueOnce({ count: 1 }); // persist failed retry state

      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
        status: "active",
        shopper: { shopifyCustomerId: "gid://shopify/Customer/poison" },
        store: { projectId: "workspace_poison" },
      } as any);

      // Mock prisma.weleticRewardRedemption.findUnique to reject with uncaught DB error
      vi.mocked(
        prisma.weleticRewardRedemption.findUnique,
      ).mockRejectedValueOnce(new Error("Connection reset by peer"));

      const summary = await processOutboxJobsBatch({ batchSize: 10 });

      expect(summary.processed).toBe(1);
      expect(summary.failed).toBe(1);
      expect(summary.succeeded).toBe(0);
      expect(prisma.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "woutbox_poison" }),
          data: expect.objectContaining({
            status: WeleticLoyaltyOutboxJobStatus.failed,
            lastError: "Connection reset by peer",
          }),
        }),
      );
    });
  });
});
