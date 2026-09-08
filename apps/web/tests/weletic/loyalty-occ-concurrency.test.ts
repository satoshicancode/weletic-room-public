import { prisma } from "@/lib/prisma";
import {
  appendPointsLedgerEntry,
  getAccountPointsBalance,
  reconcileAccountPoints,
} from "@/lib/weletic/loyalty/ledger";
import { WeleticPointsLedgerEntryType } from "@prisma/client";
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

describe("Milestone 3: Serializable OCC Ledger Concurrency & Balance Invariants Test Suite", () => {
  const TEST_STORE_ID = "wstore_occ_test";
  const TEST_ACCOUNT_ID = "wlacc_occ_test";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. Monotonic Versioning & Sequential OCC Appends
  // =========================================================================
  describe("1. Monotonic Sequence Numbering & Version Increments", () => {
    it("increments ledgerVersion and sequenceNumber monotonically on every append", async () => {
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
        null,
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        cachedPointsBalance: BigInt(100),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1,
      });

      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValueOnce({
        count: 1,
      });
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementationOnce(
        ({ data }: any) => ({
          ...data,
          id: "wledger_occ_1",
        }),
      );

      const entry = await appendPointsLedgerEntry({
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(50),
        idempotencyKey: "order_earn_tx_1",
      });

      expect(entry.sequenceNumber).toBe(2);
      expect(entry.balanceAfter).toBe(BigInt(150));
      expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: TEST_ACCOUNT_ID,
            storeId: TEST_STORE_ID,
            ledgerVersion: 1,
          },
          data: expect.objectContaining({
            ledgerVersion: 2,
            cachedPointsBalance: BigInt(150),
            lifetimePointsEarned: BigInt(150),
          }),
        }),
      );
    });
  });

  // =========================================================================
  // 2. OCC Conflict Handling & Retry Loop
  // =========================================================================
  describe("2. OCC Conflict Handling & Exponential Backoff Retry Loop", () => {
    it("retries on OCC version mismatch (updateMany count === 0) and succeeds on next attempt", async () => {
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(
        null,
      );

      // First attempt: version 1 in DB, but concurrent write bumps to version 2 (updateMany returns count: 0)
      // Second attempt: fresh read returns version 2, updateMany with version 2 succeeds (count: 1)
      (prisma.weleticLoyaltyAccount.findUnique as any)
        .mockResolvedValueOnce({
          id: TEST_ACCOUNT_ID,
          cachedPointsBalance: BigInt(100),
          cachedPendingPoints: BigInt(0),
          lifetimePointsEarned: BigInt(100),
          lifetimePointsRedeemed: BigInt(0),
          ledgerVersion: 1,
        })
        .mockResolvedValueOnce({
          id: TEST_ACCOUNT_ID,
          cachedPointsBalance: BigInt(150), // Already updated by concurrent transaction
          cachedPendingPoints: BigInt(0),
          lifetimePointsEarned: BigInt(150),
          lifetimePointsRedeemed: BigInt(0),
          ledgerVersion: 2,
        });

      (prisma.weleticLoyaltyAccount.updateMany as any)
        .mockResolvedValueOnce({ count: 0 }) // Conflict!
        .mockResolvedValueOnce({ count: 1 }); // Success!

      (prisma.weleticPointsLedgerEntry.create as any)
        .mockResolvedValueOnce({
          id: "wledger_failed_attempt",
        })
        .mockImplementationOnce(({ data }: any) => ({
          ...data,
          id: "wledger_success_attempt",
        }));

      const entry = await appendPointsLedgerEntry({
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(50),
        idempotencyKey: "order_earn_retry_tx",
      });

      expect(entry.id).toBe("wledger_success_attempt");
      expect(entry.sequenceNumber).toBe(3);
      expect(entry.balanceAfter).toBe(BigInt(200));
      expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // 3. Idempotency Protection
  // =========================================================================
  describe("3. Idempotency Protection", () => {
    it("returns existing ledger entry on duplicate idempotency key without re-applying deltas", async () => {
      const existingEntry = {
        id: "wledger_existing_1",
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        sequenceNumber: 1,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(100),
        pendingDelta: BigInt(0),
        balanceAfter: BigInt(100),
        grantId: null,
        referenceType: null,
        referenceId: null,
        idempotencyKey: "idemp_duplicate_key",
      };

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
        existingEntry,
      );

      const result = await appendPointsLedgerEntry({
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(100),
        idempotencyKey: "idemp_duplicate_key",
      });

      expect(result.id).toBe("wledger_existing_1");
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
    });

    it("rejects an idempotency key reused for a different financial payload", async () => {
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
        {
          id: "wledger_existing_conflict",
          storeId: TEST_STORE_ID,
          accountId: TEST_ACCOUNT_ID,
          sequenceNumber: 1,
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(100),
          pendingDelta: BigInt(0),
          balanceAfter: BigInt(100),
          grantId: "grant_original",
          referenceType: "COMMERCE_ORDER",
          referenceId: "order_original",
          idempotencyKey: "idemp_conflict_key",
        },
      );

      await expect(
        appendPointsLedgerEntry({
          storeId: TEST_STORE_ID,
          accountId: TEST_ACCOUNT_ID,
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(101),
          pendingDelta: BigInt(0),
          grantId: "grant_changed",
          referenceType: "COMMERCE_ORDER",
          referenceId: "order_original",
          idempotencyKey: "idemp_conflict_key",
        }),
      ).rejects.toThrow("Ledger idempotency conflict");

      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
    });

    it("rejects a cross-store account before creating a ledger entry", async () => {
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
        null,
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        storeId: "wstore_other",
        cachedPointsBalance: BigInt(100),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1,
      });

      await expect(
        appendPointsLedgerEntry({
          storeId: TEST_STORE_ID,
          accountId: TEST_ACCOUNT_ID,
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(50),
          idempotencyKey: "cross_store_attempt",
        }),
      ).rejects.toThrow("does not belong to Shopify store");

      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Audit & Reconciliation
  // =========================================================================
  describe("4. Audit & Sequence Gap Reconciliation (reconcileAccountPoints)", () => {
    it("detects and repairs balance mismatch against immutable ledger entries", async () => {
      // Corrupted account cached balance shows 50, but sum of ledger entries is 150
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        cachedPointsBalance: BigInt(50), // Desynced!
        lifetimePointsEarned: BigInt(50),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1,
      });

      (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValueOnce([
        {
          id: "e1",
          sequenceNumber: 1,
          pointsDelta: BigInt(100),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
        {
          id: "e2",
          sequenceNumber: 2,
          pointsDelta: BigInt(50),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ]);

      (prisma.weleticLoyaltyAccount.update as any).mockResolvedValueOnce({});

      const audit = await reconcileAccountPoints(TEST_ACCOUNT_ID);

      expect(audit.repaired).toBe(true);
      expect(audit.calculatedBalance).toBe(BigInt(150));
      expect(audit.previousCachedBalance).toBe(BigInt(50));

      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TEST_ACCOUNT_ID },
          data: expect.objectContaining({
            cachedPointsBalance: BigInt(150),
            lifetimePointsEarned: BigInt(150),
            ledgerVersion: 2,
          }),
        }),
      );
    });

    it("throws error when gap in sequence numbers is detected", async () => {
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        cachedPointsBalance: BigInt(200),
        lifetimePointsEarned: BigInt(200),
        lifetimePointsRedeemed: BigInt(0),
      });

      // Entry sequence jumps from 1 to 3 (missing sequence 2!)
      (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValueOnce([
        {
          id: "e1",
          sequenceNumber: 1,
          pointsDelta: BigInt(100),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
        {
          id: "e3",
          sequenceNumber: 3, // GAP!
          pointsDelta: BigInt(100),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ]);

      await expect(reconcileAccountPoints(TEST_ACCOUNT_ID)).rejects.toThrow(
        /Sequence gap detected/,
      );
    });
  });

  // =========================================================================
  // 5. Account Points Balance State Retrieval
  // =========================================================================
  describe("5. Account Points Balance State Retrieval", () => {
    it("reports negative balance and disallows redemption when balance is negative", async () => {
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        status: "active",
        cachedPointsBalance: BigInt(-50),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(150),
      });

      const balanceState = await getAccountPointsBalance(TEST_ACCOUNT_ID);

      expect(balanceState?.isNegative).toBe(true);
      expect(balanceState?.canRedeem).toBe(false);
      expect(balanceState?.pointsBalance).toBe(BigInt(-50));
    });
  });
});
