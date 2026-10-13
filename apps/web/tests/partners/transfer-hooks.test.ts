import {
  TransferPreProcessingContext,
  executeTransferPreProcessingHook,
  registerTransferPreProcessingHook,
  transferHookRegistry,
} from "@/lib/partners/transfer-hooks";
import { prisma } from "@/lib/prisma";
import { weleticSettlementHook } from "@/lib/weletic/payouts/settlement-hook";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => {
  const quoteUpdate = vi.fn().mockResolvedValue({ id: "quote_1" });
  const statementUpdate = vi.fn().mockResolvedValue({ id: "stmt_1" });
  const statementFindUnique = vi.fn().mockResolvedValue({
    snapshot: { payoutAmount: "1000", feeAmount: "0" },
  });
  const mock: any = {
    weleticPayoutQuote: { update: quoteUpdate },
    weleticPayoutStatement: {
      findUnique: statementFindUnique,
      update: statementUpdate,
    },
  };
  mock.$transaction = vi.fn(async (cb) => cb(mock));
  return mock;
});

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/lib/weletic/payouts/get-settlement", () => ({
  getWeleticPayoutSettlement: vi.fn(async ({ payoutId }) => ({
    payoutId,
    amount: BigInt(5000), // 5000 cents = $50.00
    currency: "USD",
    quoteId: `quote_${payoutId}`,
  })),
}));

describe("ARCH-02.3 Extensible Stripe Transfer Settlement Hook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const mockPartner = {
    id: "part_1",
    email: "partner@example.com",
    stripeConnectId: "acct_connect_1",
  };

  const createMockPayout = (id: string, amount: number, currency = "USD") =>
    ({
      id,
      amount,
      currency,
      program: {
        id: "prog_1",
        name: "Test Program",
        logo: null,
        workspaceId: "ws_1",
      },
    }) as any;

  describe("transferHookRegistry", () => {
    it("returns null when no hook produces a result", async () => {
      transferHookRegistry.clear();
      const context: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [createMockPayout("po_1", 5000)],
        totalTransferableAmount: 5000,
        withdrawalFee: 0,
        forceWithdrawal: false,
      };

      const result = await executeTransferPreProcessingHook(context);
      expect(result).toBeNull();
    });

    it("executes registered hook and returns result", async () => {
      transferHookRegistry.clear();
      registerTransferPreProcessingHook(async (ctx) => ({
        finalTransferableAmount: ctx.totalTransferableAmount - 100,
        settlementCurrency: "usd",
      }));

      const context: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [createMockPayout("po_1", 5000)],
        totalTransferableAmount: 5000,
        withdrawalFee: 0,
        forceWithdrawal: false,
      };

      const result = await executeTransferPreProcessingHook(context);
      expect(result).toEqual({
        finalTransferableAmount: 4900,
        settlementCurrency: "usd",
      });
    });

    it("allows deregistration via the returned cleanup function", async () => {
      transferHookRegistry.clear();
      const unregister = registerTransferPreProcessingHook(async () => ({
        finalTransferableAmount: 1234,
        settlementCurrency: "usd",
      }));

      unregister();

      const result = await executeTransferPreProcessingHook({
        partner: mockPartner,
        allPayouts: [createMockPayout("po_1", 5000)],
        totalTransferableAmount: 5000,
        withdrawalFee: 0,
        forceWithdrawal: false,
      });

      expect(result).toBeNull();
    });
  });

  describe("weleticSettlementHook", () => {
    it("rejects non-USD accounting payout currencies", async () => {
      const context: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [createMockPayout("po_1", 5000, "EUR")],
        totalTransferableAmount: 5000,
        withdrawalFee: 0,
        forceWithdrawal: false,
      };

      await expect(weleticSettlementHook(context)).rejects.toThrow(
        "Automatic Stripe settlement currently requires USD accounting payouts.",
      );
    });

    it("calculates settled transferable amount for USD payouts", async () => {
      const context: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [
          createMockPayout("po_1", 5000, "USD"),
          createMockPayout("po_2", 5000, "USD"),
        ],
        totalTransferableAmount: 10000,
        withdrawalFee: 0,
        forceWithdrawal: false,
      };

      const result = await weleticSettlementHook(context);
      expect(result).toEqual({
        finalTransferableAmount: 10000,
        settlementCurrency: "usd",
      });
    });

    it("deducts withdrawal fee and updates quote + statement when fee > 0", async () => {
      const context: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [createMockPayout("po_1", 5000, "USD")],
        totalTransferableAmount: 5000,
        withdrawalFee: 500, // $5.00 fee
        forceWithdrawal: true,
      };

      const result = await weleticSettlementHook(context);
      expect(result.finalTransferableAmount).toBe(4500);
      expect(result.settlementCurrency).toBe("usd");

      expect(prisma.weleticPayoutQuote.update).toHaveBeenCalledWith({
        where: { id: "quote_po_1" },
        data: {
          payoutAmount: BigInt(4500),
          feeAmount: { increment: BigInt(500) },
        },
      });

      expect(prisma.weleticPayoutStatement.update).toHaveBeenCalledWith({
        where: { payoutId: "po_1" },
        data: {
          snapshot: {
            payoutAmount: "4500",
            feeAmount: "500",
          },
        },
      });
    });

    it("throws when withdrawal fee exceeds payout settlement amount", async () => {
      const context: TransferPreProcessingContext = {
        partner: mockPartner,
        allPayouts: [createMockPayout("po_1", 5000, "USD")],
        totalTransferableAmount: 5000,
        withdrawalFee: 6000, // exceeds 5000
        forceWithdrawal: true,
      };

      await expect(weleticSettlementHook(context)).rejects.toThrow(
        "The Stripe withdrawal fee exceeds the payout amount.",
      );
    });
  });
});
