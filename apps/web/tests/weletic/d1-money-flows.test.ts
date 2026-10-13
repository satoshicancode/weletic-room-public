import { describe, expect, it, vi } from "vitest";

// Enforce D1 transaction-free semantics (no rollback, statement-level execution)
process.env.WELETIC_D1_TX_SEMANTICS = "1";

import {
  isD1TransactionSemanticsEnabled,
  withD1TransactionSemantics,
} from "@/lib/prisma/d1-semantics";
import {
  createManyIgnoringDuplicates,
  createOrGetByUnique,
  deterministicWeleticId,
  isUniqueViolation,
} from "@/lib/weletic/commerce/idempotent-writes";
import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import { healLedgerCache } from "@/lib/weletic/loyalty/ledger";
import { WeleticPointsLedgerEntryType } from "@prisma/client";

describe("D1 Money Flows & Concurrency Semantics", () => {
  it("enforces D1 transaction-free semantics via environment flag", () => {
    expect(isD1TransactionSemanticsEnabled()).toBe(true);
  });

  it("withD1TransactionSemantics strips rollback so earlier writes survive a downstream error", async () => {
    const executed: string[] = [];
    const mockClient = {
      user: {
        create: vi.fn(async (args) => {
          executed.push(`created:${args.data.name}`);
          return args.data;
        }),
      },
    };

    const d1Client = withD1TransactionSemantics(mockClient as any);

    await expect(
      d1Client.$transaction(async (tx: any) => {
        await tx.user.create({ data: { name: "alice" } });
        throw new Error("Downstream financial failure");
      }),
    ).rejects.toThrow("Downstream financial failure");

    // Under D1 semantics (statement-level execution), the first statement was executed
    expect(executed).toEqual(["created:alice"]);
  });

  describe("Idempotent Writes & Deterministic IDs", () => {
    it("generates stable, deterministic IDs for business keys", () => {
      const id1 = deterministicWeleticId("worder_", "store_123", "order_456");
      const id2 = deterministicWeleticId("worder_", "store_123", "order_456");
      const id3 = deterministicWeleticId("worder_", "store_123", "order_789");

      expect(id1).toBe(id2);
      expect(id1).not.toBe(id3);
      expect(id1.startsWith("worder_")).toBe(true);
      expect(id1.length).toBe(27); // prefix (7) + 20 chars
    });

    it("identifies unique constraint violations across SQLite and Prisma error shapes", () => {
      expect(isUniqueViolation({ code: "P2002" })).toBe(true);
      expect(
        isUniqueViolation(new Error("UNIQUE constraint failed: table.col")),
      ).toBe(true);
      expect(isUniqueViolation(new Error("Some other error"))).toBe(false);
      expect(isUniqueViolation(null)).toBe(false);
    });

    it("createManyIgnoringDuplicates inserts rows one-by-one upon batch unique collision", async () => {
      const inserted: string[] = [];
      const delegate = {
        createMany: vi.fn().mockRejectedValue({ code: "P2002" }),
        create: vi.fn(async (args) => {
          if (args.data.id === "duplicate") {
            throw { code: "P2002" };
          }
          inserted.push(args.data.id);
          return args.data;
        }),
      };

      const count = await createManyIgnoringDuplicates(delegate, [
        { id: "row1" },
        { id: "duplicate" },
        { id: "row2" },
      ]);

      expect(count).toBe(2);
      expect(inserted).toEqual(["row1", "row2"]);
    });

    it("createOrGetByUnique returns existing id if unique collision occurs", async () => {
      const result = await createOrGetByUnique({
        create: async () => {
          throw { code: "P2002" };
        },
        findExistingId: async () => "existing_order_123",
      });

      expect(result).toEqual({ id: "existing_order_123", created: false });
    });
  });

  describe("Ledger CAS Versioning & Cache Healing", () => {
    it("healLedgerCache applies pending entries sequentially using CAS on ledgerVersion", async () => {
      const updates: Array<{ where: any; data: any }> = [];
      let currentVersion = 1;

      const mockClient = {
        weleticPointsLedgerEntry: {
          findFirst: vi.fn().mockResolvedValue({
            sequenceNumber: 3,
          }),
          findMany: vi.fn().mockResolvedValue([
            {
              id: "entry_2",
              sequenceNumber: 2,
              pointsDelta: 100,
              balanceAfter: 200,
              entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
              referenceType: "order",
              createdAt: new Date(),
            },
            {
              id: "entry_3",
              sequenceNumber: 3,
              pointsDelta: -50,
              balanceAfter: 150,
              entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
              referenceType: "reward",
              createdAt: new Date(),
            },
          ]),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockImplementation(() =>
            Promise.resolve({
              id: "acct_1",
              storeId: "store_1",
              ledgerVersion: currentVersion,
              cachedPointsBalance: BigInt(100),
              lifetimePointsEarned: BigInt(100),
              lifetimePointsRedeemed: BigInt(0),
            }),
          ),
          updateMany: vi.fn().mockImplementation((args) => {
            updates.push(args);
            if (args.where.ledgerVersion === currentVersion) {
              currentVersion = args.data.ledgerVersion;
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve({ count: 0 });
          }),
        },
        weleticLoyaltyProgram: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      };

      const result = await healLedgerCache(
        mockClient as any,
        "acct_1",
        "store_1",
      );

      expect(updates.length).toBe(2);
      expect(updates[0].where).toMatchObject({
        id: "acct_1",
        storeId: "store_1",
        ledgerVersion: 1,
      });
      expect(updates[0].data).toMatchObject({
        ledgerVersion: 2,
        cachedPointsBalance: BigInt(200),
      });

      expect(updates[1].where).toMatchObject({
        id: "acct_1",
        storeId: "store_1",
        ledgerVersion: 2,
      });
      expect(updates[1].data).toMatchObject({
        ledgerVersion: 3,
        cachedPointsBalance: BigInt(150),
      });
    });

    it("healLedgerCache halts when sequence gap is detected", async () => {
      let currentVersion = 1;
      const updates: any[] = [];

      const mockClient = {
        weleticPointsLedgerEntry: {
          findFirst: vi.fn().mockResolvedValue({
            sequenceNumber: 3,
          }),
          findMany: vi.fn().mockResolvedValue([
            {
              id: "entry_3",
              sequenceNumber: 3, // Gap: expected 2
              pointsDelta: 100,
              balanceAfter: 200,
              entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
              referenceType: "order",
              createdAt: new Date(),
            },
          ]),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: "acct_1",
            storeId: "store_1",
            ledgerVersion: currentVersion,
            cachedPointsBalance: BigInt(100),
          }),
          updateMany: vi.fn().mockImplementation((args) => {
            updates.push(args);
            return Promise.resolve({ count: 1 });
          }),
        },
      };

      await healLedgerCache(mockClient as any, "acct_1", "store_1");

      // Gap: sequence 3 encountered when version was 1, no updates applied
      expect(updates.length).toBe(0);
    });
  });

  describe("Refund & Reversal Proportional Calculations", () => {
    it("calculates exact proportional commission reversal for partial refunds", () => {
      const reversedCommission = calculateRefundReversal({
        originalEarnings: BigInt(1000), // $10.00
        originalCommissionableAmount: BigInt(10000), // $100.00
        refundedAmount: BigInt(2500), // $25.00 (25%)
      });

      expect(reversedCommission).toBe(BigInt(250)); // $2.50 (25%)
      const remainingCommission = BigInt(1000) - reversedCommission;
      expect(remainingCommission).toBe(BigInt(750));
    });

    it("handles full refund by reversing 100% of commission without rounding drift", () => {
      const reversedCommission = calculateRefundReversal({
        originalEarnings: BigInt(500),
        originalCommissionableAmount: BigInt(3333),
        refundedAmount: BigInt(3333),
      });

      expect(reversedCommission).toBe(BigInt(500));
      const remainingCommission = BigInt(500) - reversedCommission;
      expect(remainingCommission).toBe(BigInt(0));
    });
  });
});
