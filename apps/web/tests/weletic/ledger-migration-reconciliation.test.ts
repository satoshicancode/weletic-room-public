import { prisma } from "@/lib/prisma";
import {
  auditAccountLedger,
  auditStoreLedgers,
} from "@/lib/weletic/loyalty/reconciliation";
import {
  WeleticLoyaltyAccountStatus,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateLedgerVersions } from "../../scripts/loyalty/migrate-ledger-version";
import { runReconciliationCLI } from "../../scripts/loyalty/reconcile-ledger";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      count: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      groupBy: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    weleticShopifyStore: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    $transaction: vi.fn((fns) =>
      Array.isArray(fns) ? Promise.all(fns) : fns(prisma),
    ),
  },
}));

describe("Milestone 2: Ledger Migration & Non-Crashing Reconciliation Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. ledgerVersion Migration Tests
  // =========================================================================
  describe("1. ledgerVersion Initialization Migration", () => {
    it("1.1: Initializes ledgerVersion = 0 for accounts with zero ledger entries", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.count).mockResolvedValue(1);
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        { id: "acc_zero", storeId: "store_1", ledgerVersion: 0 } as any,
      ]);
      vi.mocked(prisma.weleticPointsLedgerEntry.groupBy).mockResolvedValue([]);

      const result = await migrateLedgerVersions({ dryRun: false });

      expect(result.totalAccounts).toBe(1);
      expect(result.zeroEntryAccounts).toBe(1);
      expect(result.updatedAccounts).toBe(0);
      expect(result.alreadySyncedAccounts).toBe(1);
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
    });

    it("1.2: Populates ledgerVersion = MAX(sequenceNumber) for accounts with existing entries", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.count).mockResolvedValue(1);
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        { id: "acc_existing", storeId: "store_1", ledgerVersion: 0 } as any,
      ]);
      vi.mocked(prisma.weleticPointsLedgerEntry.groupBy).mockResolvedValue([
        { accountId: "acc_existing", _max: { sequenceNumber: 42 } } as any,
      ]);
      vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValue(
        {} as any,
      );

      const result = await migrateLedgerVersions({ dryRun: false });

      expect(result.totalAccounts).toBe(1);
      expect(result.updatedAccounts).toBe(1);
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
        where: { id: "acc_existing" },
        data: { ledgerVersion: 42 },
      });
    });

    it("1.3: Leaves accounts untouched when ledgerVersion already matches MAX(sequenceNumber)", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.count).mockResolvedValue(1);
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        { id: "acc_synced", storeId: "store_1", ledgerVersion: 10 } as any,
      ]);
      vi.mocked(prisma.weleticPointsLedgerEntry.groupBy).mockResolvedValue([
        { accountId: "acc_synced", _max: { sequenceNumber: 10 } } as any,
      ]);

      const result = await migrateLedgerVersions({ dryRun: false });

      expect(result.totalAccounts).toBe(1);
      expect(result.updatedAccounts).toBe(0);
      expect(result.alreadySyncedAccounts).toBe(1);
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
    });

    it("1.4: Respects dry-run mode without mutating database records", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.count).mockResolvedValue(1);
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        { id: "acc_dry", storeId: "store_1", ledgerVersion: 0 } as any,
      ]);
      vi.mocked(prisma.weleticPointsLedgerEntry.groupBy).mockResolvedValue([
        { accountId: "acc_dry", _max: { sequenceNumber: 15 } } as any,
      ]);

      const result = await migrateLedgerVersions({ dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.updatedAccounts).toBe(1);
      expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
    });

    it("1.5: Handles multi-batch cursor pagination seamlessly", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.count).mockResolvedValue(3);
      vi.mocked(prisma.weleticLoyaltyAccount.findMany)
        .mockResolvedValueOnce([
          { id: "acc_b1_1", storeId: "store_1", ledgerVersion: 0 } as any,
          { id: "acc_b1_2", storeId: "store_1", ledgerVersion: 0 } as any,
        ])
        .mockResolvedValueOnce([
          { id: "acc_b2_1", storeId: "store_1", ledgerVersion: 0 } as any,
        ]);

      vi.mocked(prisma.weleticPointsLedgerEntry.groupBy)
        .mockResolvedValueOnce([
          { accountId: "acc_b1_1", _max: { sequenceNumber: 5 } } as any,
          { accountId: "acc_b1_2", _max: { sequenceNumber: 8 } } as any,
        ])
        .mockResolvedValueOnce([
          { accountId: "acc_b2_1", _max: { sequenceNumber: 12 } } as any,
        ]);

      vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValue(
        {} as any,
      );

      const result = await migrateLedgerVersions({
        batchSize: 2,
        dryRun: false,
      });

      expect(result.totalAccounts).toBe(3);
      expect(result.updatedAccounts).toBe(3);
      expect(prisma.weleticLoyaltyAccount.findMany).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // 2. Non-Crashing Ledger Audit & Quarantine Engine Tests
  // =========================================================================
  describe("2. Non-Crashing Ledger Audit & Quarantine Engine", () => {
    it("2.1: Reports clean status when sequence numbers and balances match perfectly", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_clean",
        storeId: "store_1",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(250),
        lifetimePointsEarned: BigInt(250),
        lifetimePointsRedeemed: BigInt(0),
        metadata: null,
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
          pointsDelta: BigInt(150),
          balanceAfter: BigInt(250),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_clean");

      expect(audit.isClean).toBe(true);
      expect(audit.anomalies.length).toBe(0);
      expect(audit.quarantined).toBe(false);
      expect(audit.repaired).toBe(false);
      expect(audit.calculatedBalance).toBe(BigInt(250));
    });

    it("2.2: Auto-repairs cached balance drift when ledger entries are valid", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_drift",
        storeId: "store_1",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(100), // Drifted (should be 250)
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(0),
        metadata: null,
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
          pointsDelta: BigInt(150),
          balanceAfter: BigInt(250),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_drift", { autoRepair: true });

      expect(audit.isClean).toBe(false);
      expect(audit.repaired).toBe(true);
      expect(audit.quarantined).toBe(false);
      expect(audit.anomalies[0].type).toBe("CACHE_BALANCE_DRIFT");
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
        where: { id: "acc_drift" },
        data: {
          cachedPointsBalance: BigInt(250),
          lifetimePointsEarned: BigInt(250),
          lifetimePointsRedeemed: BigInt(0),
        },
      });
    });

    it("2.3: Quarantines account into suspended status upon detecting sequence gap without crashing", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_gap",
        storeId: "store_1",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(200),
        lifetimePointsEarned: BigInt(200),
        lifetimePointsRedeemed: BigInt(0),
        metadata: {},
      } as any);

      // Sequence gap: 1, then 3 (missing 2)
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "e1",
          sequenceNumber: 1,
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(100),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
        {
          id: "e3",
          sequenceNumber: 3,
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(200),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_gap", {
        quarantineFatal: true,
      });

      expect(audit.isClean).toBe(false);
      expect(audit.quarantined).toBe(true);
      expect(audit.anomalies.some((a) => a.type === "SEQUENCE_GAP")).toBe(true);
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "acc_gap" },
          data: expect.objectContaining({
            status: WeleticLoyaltyAccountStatus.suspended,
          }),
        }),
      );
    });

    it("2.4: Detects sequence collision and balance discontinuity, quarantining safely", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_collision",
        storeId: "store_1",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(300),
        lifetimePointsEarned: BigInt(300),
        lifetimePointsRedeemed: BigInt(0),
        metadata: {},
      } as any);

      // Sequence collision: duplicate sequenceNumber = 1
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "e1_a",
          sequenceNumber: 1,
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(100),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
        {
          id: "e1_b",
          sequenceNumber: 1, // collision
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(999), // discontinuity (expected 200)
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_collision", {
        quarantineFatal: true,
      });

      expect(audit.isClean).toBe(false);
      expect(audit.quarantined).toBe(true);
      expect(audit.anomalies.some((a) => a.type === "SEQUENCE_COLLISION")).toBe(
        true,
      );
      expect(
        audit.anomalies.some((a) => a.type === "BALANCE_CHAIN_DISCONTINUITY"),
      ).toBe(true);
    });

    it("2.5: Aggregates store-wide summary correctly across multiple accounts", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        { id: "acc_1" } as any,
        { id: "acc_2" } as any,
      ]);

      // acc_1 is clean
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique)
        .mockResolvedValueOnce({
          id: "acc_1",
          storeId: "store_agg",
          status: WeleticLoyaltyAccountStatus.active,
          cachedPointsBalance: BigInt(50),
          lifetimePointsEarned: BigInt(50),
          lifetimePointsRedeemed: BigInt(0),
          metadata: {},
        } as any)
        // acc_2 has drift
        .mockResolvedValueOnce({
          id: "acc_2",
          storeId: "store_agg",
          status: WeleticLoyaltyAccountStatus.active,
          cachedPointsBalance: BigInt(0),
          lifetimePointsEarned: BigInt(0),
          lifetimePointsRedeemed: BigInt(0),
          metadata: {},
        } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany)
        .mockResolvedValueOnce([
          {
            id: "e1",
            sequenceNumber: 1,
            pointsDelta: BigInt(50),
            balanceAfter: BigInt(50),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
        ] as any)
        .mockResolvedValueOnce([
          {
            id: "e2",
            sequenceNumber: 1,
            pointsDelta: BigInt(100),
            balanceAfter: BigInt(100),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
        ] as any);

      const summary = await auditStoreLedgers("store_agg", {
        autoRepair: true,
      });

      expect(summary.totalAccounts).toBe(2);
      expect(summary.cleanAccounts).toBe(1);
      expect(summary.repairedAccounts).toBe(1);
      expect(summary.quarantinedAccounts).toBe(0);
      expect(summary.totalLedgerEntries).toBe(2);
    });

    it("2.6: CLI runner executes and produces summary reports", async () => {
      vi.mocked(prisma.weleticShopifyStore.findMany).mockResolvedValue([
        { id: "store_cli_1" } as any,
      ]);
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([]);

      const reports = await runReconciliationCLI([
        "--no-repair",
        "--store=store_cli_1",
      ]);

      expect(reports.length).toBe(1);
      expect(reports[0].storeId).toBe("store_cli_1");
    });

    it("2.7: Repairs an inflated lifetime total without treating restored redemption points as earned", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: "acc_restored_redemption",
        storeId: "store_1",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(100),
        lifetimePointsEarned: BigInt(200),
        lifetimePointsRedeemed: BigInt(100),
        metadata: null,
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "earn_1",
          sequenceNumber: 1,
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(100),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
        {
          id: "redeem_1",
          sequenceNumber: 2,
          pointsDelta: BigInt(-100),
          balanceAfter: BigInt(0),
          entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        },
        {
          id: "restore_1",
          sequenceNumber: 3,
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(100),
          entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
        },
      ] as any);

      const audit = await auditAccountLedger("acc_restored_redemption", {
        autoRepair: true,
      });

      expect(audit.repaired).toBe(true);
      expect(audit.anomalies).toEqual([
        expect.objectContaining({ type: "LIFETIME_METRICS_DRIFT" }),
      ]);
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
        where: { id: "acc_restored_redemption" },
        data: {
          cachedPointsBalance: BigInt(100),
          lifetimePointsEarned: BigInt(100),
          lifetimePointsRedeemed: BigInt(100),
        },
      });
    });
  });
});
