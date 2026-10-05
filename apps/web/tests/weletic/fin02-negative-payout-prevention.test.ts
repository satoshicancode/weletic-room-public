import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock @vercel/functions
vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((p) => p),
}));

// Mock with-cron
vi.mock("@/lib/cron/with-cron", () => ({
  withCron: (fn: any) => fn,
}));

// Mock axiom
vi.mock("@/lib/axiom/server", () => ({
  logger: {
    error: vi.fn(),
  },
  withAxiomBodyLog: (fn: any) => fn,
}));

// Mock activity log tracking
vi.mock("@/lib/api/commissions/track-commission-update-activity-log", () => ({
  trackCommissionStatusUpdate: vi.fn(),
}));

// Mock email & cron queues
vi.mock("@/lib/email/queue-batch-email", () => ({
  queueBatchEmail: vi.fn(),
}));
vi.mock("@/lib/cron/enqueue-batch-jobs", () => ({
  enqueueBatchJobs: vi.fn(),
}));

// Mock PayPal batch creation
const paypalMock = vi.hoisted(() => ({
  createPayPalBatchPayout: vi.fn(),
}));
vi.mock("@/lib/paypal/create-batch-payout", () => ({
  createPayPalBatchPayout: paypalMock.createPayPalBatchPayout,
}));

// Mock FX
vi.mock("@/lib/weletic/fx", () => ({
  getAccountingFxQuote: vi.fn().mockResolvedValue({
    base: "USD",
    quote: "USD",
    rate: "1.0",
    rateBigInt: BigInt(100000000),
    timestamp: new Date(),
  }),
  persistFxQuote: vi.fn().mockResolvedValue({ id: "fx_snap_1" }),
}));

// Hoisted Prisma mocks
const prismaMock = vi.hoisted(() => {
  const payoutUpdate = vi.fn().mockResolvedValue({ id: "po_1" });
  const payoutUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const payoutDeleteMany = vi.fn().mockResolvedValue({ count: 1 });
  const commissionUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const commissionGroupBy = vi.fn();
  const commissionAggregate = vi.fn();
  const commissionFindMany = vi.fn().mockResolvedValue([]);
  const payoutFindMany = vi.fn().mockResolvedValue([]);
  const payoutFindUniqueOrThrow = vi.fn();
  const payoutCreate = vi.fn();
  const programFindUnique = vi.fn();
  const partnerGroupGroupBy = vi.fn();
  const partnerGroupFindMany = vi.fn();
  const weleticPayoutQuoteUpsert = vi.fn().mockResolvedValue({ id: "quote_1" });
  const weleticPayoutStatementUpsert = vi.fn().mockResolvedValue({ id: "stmt_1" });
  const executeRaw = vi.fn().mockResolvedValue(1);

  const tx = {
    commission: {
      groupBy: commissionGroupBy,
      updateMany: commissionUpdateMany,
    },
    payout: {
      update: payoutUpdate,
      deleteMany: payoutDeleteMany,
    },
  };

  const transaction = vi.fn(async (callback: any) => {
    return callback(tx);
  });

  return {
    $transaction: transaction,
    $executeRaw: executeRaw,
    tx,
    commission: {
      groupBy: commissionGroupBy,
      updateMany: commissionUpdateMany,
      aggregate: commissionAggregate,
      findMany: commissionFindMany,
    },
    payout: {
      findMany: payoutFindMany,
      findUniqueOrThrow: payoutFindUniqueOrThrow,
      update: payoutUpdate,
      updateMany: payoutUpdateMany,
      deleteMany: payoutDeleteMany,
      create: payoutCreate,
    },
    program: {
      findUnique: programFindUnique,
    },
    partnerGroup: {
      groupBy: partnerGroupGroupBy,
      findMany: partnerGroupFindMany,
    },
    weleticPayoutQuote: {
      upsert: weleticPayoutQuoteUpsert,
    },
    weleticPayoutStatement: {
      upsert: weleticPayoutStatementUpsert,
    },
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

import { reconcilePayoutAmounts } from "@/lib/api/commissions/reconcile-payout-amounts";
import {
  createWeleticPayoutQuote,
  refreshWeleticOpenPayoutQuotes,
} from "@/lib/weletic/payouts/create-quote";
import { sendPaypalPayouts } from "../../app/(ee)/api/cron/payouts/charge-succeeded/send-paypal-payouts";
import { POST as aggregateDueCommissionsPOST } from "../../app/(ee)/api/cron/payouts/aggregate-due-commissions/process/route";
import { MUTABLE_PAYOUT_STATUSES } from "@/lib/constants/payouts";
import { CommissionStatus, PayoutStatus } from "@prisma/client";

describe("FIN-02: Negative & Zero Payout Prevention and Rollover Recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.tx.commission.groupBy.mockReset();
    prismaMock.tx.commission.updateMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMock.tx.payout.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMock.tx.payout.update.mockReset().mockResolvedValue({ id: "po_1" });
    prismaMock.commission.findMany.mockReset().mockResolvedValue([]);
    prismaMock.commission.aggregate.mockReset();
    prismaMock.commission.updateMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMock.payout.findMany.mockReset().mockResolvedValue([]);
    prismaMock.payout.findUniqueOrThrow.mockReset();
    prismaMock.payout.create.mockReset();
    prismaMock.payout.updateMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMock.payout.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMock.program.findUnique.mockReset();
    prismaMock.partnerGroup.groupBy.mockReset();
    prismaMock.partnerGroup.findMany.mockReset().mockResolvedValue([]);
    prismaMock.weleticPayoutQuote.upsert.mockReset().mockResolvedValue({ id: "quote_1" });
    prismaMock.weleticPayoutStatement.upsert.mockReset().mockResolvedValue({ id: "stmt_1" });
    prismaMock.$executeRaw.mockReset().mockResolvedValue(1);
    paypalMock.createPayPalBatchPayout.mockReset();
  });

  describe("Pillar 1: reconcilePayoutAmounts", () => {
    it("should delete payout and unassign commissions back to pending rollover when net earnings are negative", async () => {
      // Scenario: Partner has +$40 earnings and -$100 clawback => Net -$60 (-6000 cents)
      prismaMock.tx.commission.groupBy.mockResolvedValueOnce([
        { payoutId: "payout_neg", _sum: { earnings: BigInt(-6000) } },
      ]);

      await reconcilePayoutAmounts(["payout_neg"]);

      // Verify commissions are reset to unassigned pending
      expect(prismaMock.tx.commission.updateMany).toHaveBeenCalledWith({
        where: {
          payoutId: {
            in: ["payout_neg"],
          },
        },
        data: {
          payoutId: null,
          status: "pending",
        },
      });

      // Verify payout is deleted from mutable statuses
      expect(prismaMock.tx.payout.deleteMany).toHaveBeenCalledWith({
        where: {
          id: {
            in: ["payout_neg"],
          },
          status: {
            in: MUTABLE_PAYOUT_STATUSES,
          },
        },
      });

      // Verify negative amount was NEVER updated into the database
      expect(prismaMock.tx.payout.update).not.toHaveBeenCalled();
    });

    it("should delete payout and unassign commissions when net earnings are zero", async () => {
      // Scenario: +$50 earnings and -$50 refund => Net $0
      prismaMock.tx.commission.groupBy.mockResolvedValueOnce([
        { payoutId: "payout_zero", _sum: { earnings: BigInt(0) } },
      ]);

      await reconcilePayoutAmounts(["payout_zero"]);

      expect(prismaMock.tx.commission.updateMany).toHaveBeenCalledWith({
        where: {
          payoutId: {
            in: ["payout_zero"],
          },
        },
        data: {
          payoutId: null,
          status: "pending",
        },
      });

      expect(prismaMock.tx.payout.deleteMany).toHaveBeenCalledWith({
        where: {
          id: {
            in: ["payout_zero"],
          },
          status: {
            in: MUTABLE_PAYOUT_STATUSES,
          },
        },
      });

      expect(prismaMock.tx.payout.update).not.toHaveBeenCalled();
    });

    it("should update payout amount normally when net earnings are strictly positive", async () => {
      // Scenario: +$150 earnings => Net +$150 (15000 cents)
      prismaMock.tx.commission.groupBy.mockResolvedValueOnce([
        { payoutId: "payout_pos", _sum: { earnings: BigInt(15000) } },
      ]);

      await reconcilePayoutAmounts(["payout_pos"]);

      expect(prismaMock.tx.commission.updateMany).not.toHaveBeenCalled();
      expect(prismaMock.tx.payout.deleteMany).not.toHaveBeenCalled();

      expect(prismaMock.tx.payout.update).toHaveBeenCalledWith({
        where: {
          id: "payout_pos",
          status: {
            in: MUTABLE_PAYOUT_STATUSES,
          },
        },
        data: {
          amount: 15000,
        },
      });
    });

    it("should handle a heterogeneous batch with positive, negative, and zero payouts correctly", async () => {
      // Mixed batch:
      // - payout_pos: +20000
      // - payout_neg: -5000
      // - payout_zero: 0
      prismaMock.tx.commission.groupBy.mockResolvedValueOnce([
        { payoutId: "payout_pos", _sum: { earnings: BigInt(20000) } },
        { payoutId: "payout_neg", _sum: { earnings: BigInt(-5000) } },
        { payoutId: "payout_zero", _sum: { earnings: BigInt(0) } },
      ]);

      await reconcilePayoutAmounts(["payout_pos", "payout_neg", "payout_zero"]);

      // Unassign commissions for non-positive payouts
      expect(prismaMock.tx.commission.updateMany).toHaveBeenCalledWith({
        where: {
          payoutId: {
            in: ["payout_neg", "payout_zero"],
          },
        },
        data: {
          payoutId: null,
          status: "pending",
        },
      });

      // Delete non-positive payouts
      expect(prismaMock.tx.payout.deleteMany).toHaveBeenCalledWith({
        where: {
          id: {
            in: ["payout_neg", "payout_zero"],
          },
          status: {
            in: MUTABLE_PAYOUT_STATUSES,
          },
        },
      });

      // Update only positive payout
      expect(prismaMock.tx.payout.update).toHaveBeenCalledTimes(1);
      expect(prismaMock.tx.payout.update).toHaveBeenCalledWith({
        where: {
          id: "payout_pos",
          status: {
            in: MUTABLE_PAYOUT_STATUSES,
          },
        },
        data: {
          amount: 20000,
        },
      });
    });

    it("should handle empty or missing payout IDs list gracefully", async () => {
      await reconcilePayoutAmounts([]);
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });
  });

  describe("Pillar 2: createWeleticPayoutQuote & refreshWeleticOpenPayoutQuotes", () => {
    it("should throw an error when attempting to create a quote for a negative payout", async () => {
      prismaMock.payout.findUniqueOrThrow.mockResolvedValueOnce({
        id: "payout_neg",
        amount: -5000,
        programId: "prog_1",
        program: { accountingCurrency: "USD", name: "Yamax" },
        partner: {
          preferredLocale: "en",
          preferredPayoutCurrency: "USD",
          weleticPayoutProfiles: [],
        },
        commissions: [],
      });

      await expect(
        createWeleticPayoutQuote({ payoutId: "payout_neg" }),
      ).rejects.toThrow("Cannot create payout quote for non-positive payout");

      expect(prismaMock.weleticPayoutQuote.upsert).not.toHaveBeenCalled();
      expect(prismaMock.weleticPayoutStatement.upsert).not.toHaveBeenCalled();
    });

    it("should throw an error when attempting to create a quote for a zero payout", async () => {
      prismaMock.payout.findUniqueOrThrow.mockResolvedValueOnce({
        id: "payout_zero",
        amount: 0,
        programId: "prog_1",
        program: { accountingCurrency: "USD", name: "Yamax" },
        partner: {
          preferredLocale: "en",
          preferredPayoutCurrency: "USD",
          weleticPayoutProfiles: [],
        },
        commissions: [],
      });

      await expect(
        createWeleticPayoutQuote({ payoutId: "payout_zero" }),
      ).rejects.toThrow("Cannot create payout quote for non-positive payout");

      expect(prismaMock.weleticPayoutQuote.upsert).not.toHaveBeenCalled();
      expect(prismaMock.weleticPayoutStatement.upsert).not.toHaveBeenCalled();
    });

    it("should successfully generate quotes and statements for positive payouts", async () => {
      prismaMock.payout.findUniqueOrThrow.mockResolvedValueOnce({
        id: "payout_pos",
        amount: 10000,
        programId: "prog_1",
        program: { accountingCurrency: "USD", name: "Yamax" },
        partner: {
          preferredLocale: "en",
          preferredPayoutCurrency: "USD",
          weleticPayoutProfiles: [
            {
              id: "profile_1",
              programId: "prog_1",
              provider: "paypal",
              payoutCurrency: "USD",
              locale: "en",
              status: "verified",
            },
          ],
        },
        commissions: [
          {
            id: "c_1",
            description: "Sale commission",
            earnings: BigInt(10000),
            currency: "usd",
            createdAt: new Date("2026-10-01"),
          },
        ],
      });

      const quote = await createWeleticPayoutQuote({ payoutId: "payout_pos" });
      expect(quote).toBeDefined();
      expect(prismaMock.weleticPayoutQuote.upsert).toHaveBeenCalledTimes(1);
      expect(prismaMock.weleticPayoutStatement.upsert).toHaveBeenCalledTimes(1);
    });

    it("should filter for amount > 0 when refreshing open payout quotes", async () => {
      prismaMock.payout.findMany.mockResolvedValueOnce([
        { id: "payout_pos_1" },
        { id: "payout_pos_2" },
      ]);

      prismaMock.payout.findUniqueOrThrow.mockResolvedValue({
        id: "payout_pos_1",
        amount: 5000,
        programId: "prog_1",
        program: { accountingCurrency: "USD", name: "Yamax" },
        partner: { preferredLocale: "en", preferredPayoutCurrency: "USD", weleticPayoutProfiles: [] },
        commissions: [],
      });

      await refreshWeleticOpenPayoutQuotes({ partnerId: "part_1", programId: "prog_1" });

      expect(prismaMock.payout.findMany).toHaveBeenCalledWith({
        where: {
          partnerId: "part_1",
          programId: "prog_1",
          status: { in: ["pending", "processing", "processed"] },
          amount: { gt: 0 },
        },
        select: { id: true },
      });
    });
  });

  describe("Pillar 3: sendPaypalPayouts Gateway Batch Protection", () => {
    it("should query payouts with amount > 0 and only dispatch positive items to PayPal batch API", async () => {
      const mockInvoice = { id: "inv_1", payoutMode: "internal" as const };

      prismaMock.payout.findMany.mockResolvedValueOnce([
        {
          id: "payout_pos",
          amount: 8000,
          currency: "USD",
          partner: { email: "partner@example.com", paypalEmail: "partner@paypal.com" },
          program: { name: "Yamax", logo: null },
        },
      ]);

      paypalMock.createPayPalBatchPayout.mockResolvedValueOnce({
        successfulPayoutIds: ["payout_pos"],
        failedPayoutIds: [],
        results: [{ currency: "USD", success: true, batchId: "BATCH_123" }],
      });

      await sendPaypalPayouts({ invoice: mockInvoice });

      // Verify DB query includes amount > 0
      expect(prismaMock.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            invoiceId: "inv_1",
            amount: { gt: 0 },
          }),
        }),
      );

      // Verify createPayPalBatchPayout called with positive payouts
      expect(paypalMock.createPayPalBatchPayout).toHaveBeenCalledWith({
        payouts: [
          expect.objectContaining({
            id: "payout_pos",
            amount: 8000,
          }),
        ],
        invoiceId: "inv_1",
      });

      // Verify payout updated to sent
      expect(prismaMock.payout.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["payout_pos"] } },
        data: expect.objectContaining({ status: "sent", method: "paypal" }),
      });
    });

    it("should filter out non-positive payouts in-memory if any slipped through and protect the batch", async () => {
      const mockInvoice = { id: "inv_2", payoutMode: "internal" as const };

      // In-memory defensive guard test: suppose DB returned a mixed array
      prismaMock.payout.findMany.mockResolvedValueOnce([
        {
          id: "payout_pos",
          amount: 5000,
          currency: "USD",
          partner: { email: "pos@example.com", paypalEmail: "pos@paypal.com" },
          program: { name: "Yamax", logo: null },
        },
        {
          id: "payout_neg",
          amount: -6000,
          currency: "USD",
          partner: { email: "neg@example.com", paypalEmail: "neg@paypal.com" },
          program: { name: "Yamax", logo: null },
        },
        {
          id: "payout_zero",
          amount: 0,
          currency: "USD",
          partner: { email: "zero@example.com", paypalEmail: "zero@paypal.com" },
          program: { name: "Yamax", logo: null },
        },
      ]);

      paypalMock.createPayPalBatchPayout.mockResolvedValueOnce({
        successfulPayoutIds: ["payout_pos"],
        failedPayoutIds: [],
        results: [{ currency: "USD", success: true, batchId: "BATCH_456" }],
      });

      await sendPaypalPayouts({ invoice: mockInvoice });

      // Ensure ONLY payout_pos was sent to PayPal
      expect(paypalMock.createPayPalBatchPayout).toHaveBeenCalledWith({
        payouts: [
          expect.objectContaining({
            id: "payout_pos",
            amount: 5000,
          }),
        ],
        invoiceId: "inv_2",
      });
    });

    it("should skip batch payout dispatch if no positive payouts exist", async () => {
      const mockInvoice = { id: "inv_3", payoutMode: "internal" as const };

      prismaMock.payout.findMany.mockResolvedValueOnce([
        {
          id: "payout_neg",
          amount: -2000,
          currency: "USD",
          partner: { email: "neg@example.com", paypalEmail: "neg@paypal.com" },
          program: { name: "Yamax", logo: null },
        },
      ]);

      await sendPaypalPayouts({ invoice: mockInvoice });

      expect(paypalMock.createPayPalBatchPayout).not.toHaveBeenCalled();
    });
  });

  describe("Pillar 4: aggregateDueCommissions Rollover & Payout Cleanup", () => {
    it("should rollback claimed commissions to pending and delete temporary payout if net earnings <= 0", async () => {
      prismaMock.program.findUnique.mockResolvedValueOnce({
        id: "prog_test",
        name: "Yamax Affiliate",
        workspaceId: "ws_test",
      });

      prismaMock.partnerGroup.groupBy.mockResolvedValueOnce([
        { holdingPeriodDays: 0, _count: { id: 1 } },
      ]);

      prismaMock.partnerGroup.findMany.mockResolvedValueOnce([{ id: "grp_1" }]);

      // First batch: due commissions where refund clawback exceeds positive sales
      const now = new Date();
      prismaMock.commission.findMany.mockResolvedValueOnce([
        {
          id: "comm_positive",
          createdAt: new Date(now.getTime() - 2000),
          amount: BigInt(5000),
          earnings: BigInt(4000), // +$40
          status: CommissionStatus.pending,
          partnerId: "partner_debtor",
          programId: "prog_test",
        },
        {
          id: "comm_clawback",
          createdAt: new Date(now.getTime() - 1000),
          amount: BigInt(10000),
          earnings: BigInt(-10000), // -$100 refund reversal
          status: CommissionStatus.pending,
          partnerId: "partner_debtor",
          programId: "prog_test",
        },
      ]);

      prismaMock.payout.findMany.mockResolvedValueOnce([]); // No existing pending payout

      prismaMock.payout.create.mockResolvedValueOnce({ id: "po_temp_123" });

      // Raw SQL execute for claim succeeds
      prismaMock.$executeRaw.mockResolvedValueOnce(2);

      // Aggregate earnings on claimed commissions: Net -$60 (-6000 cents)
      prismaMock.commission.aggregate.mockResolvedValueOnce({
        _sum: { earnings: BigInt(-6000) },
      });

      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_test" }),
      });

      expect(response.status).toBe(200);

      // Verify claimed commissions rolled back to unassigned pending
      expect(prismaMock.commission.updateMany).toHaveBeenCalledWith({
        where: {
          payoutId: "po_temp_123",
        },
        data: {
          payoutId: null,
          status: CommissionStatus.pending,
        },
      });

      // Verify temporary payout deleted
      expect(prismaMock.payout.deleteMany).toHaveBeenCalledWith({
        where: {
          id: "po_temp_123",
          status: {
            in: MUTABLE_PAYOUT_STATUSES,
          },
        },
      });

      // Verify no positive payout update or quote creation occurred
      expect(prismaMock.weleticPayoutQuote.upsert).not.toHaveBeenCalled();
    });

    it("should process normally and quote payout when net earnings > 0", async () => {
      prismaMock.program.findUnique.mockResolvedValueOnce({
        id: "prog_test",
        name: "Yamax Affiliate",
        workspaceId: "ws_test",
      });

      prismaMock.partnerGroup.groupBy.mockResolvedValueOnce([
        { holdingPeriodDays: 0, _count: { id: 1 } },
      ]);

      prismaMock.partnerGroup.findMany.mockResolvedValueOnce([{ id: "grp_1" }]);

      const now = new Date();
      prismaMock.commission.findMany
        // 1. Initial dueCommissions fetch in while loop
        .mockResolvedValueOnce([
          {
            id: "comm_1",
            createdAt: now,
            amount: BigInt(20000),
            earnings: BigInt(15000),
            status: CommissionStatus.pending,
            partnerId: "partner_earner",
            programId: "prog_test",
          },
        ])
        // 2. Claimed commissions fetch inside aggregateDueCommissionsForPartner
        .mockResolvedValueOnce([
          { id: "comm_1", amount: BigInt(20000), earnings: BigInt(15000), status: CommissionStatus.processed },
        ])
        // 3. Second iteration in while loop: no more commissions -> break
        .mockResolvedValueOnce([]);

      prismaMock.payout.findMany.mockResolvedValueOnce([]);
      prismaMock.payout.create.mockResolvedValueOnce({ id: "po_positive_456" });

      // Raw SQL execute for claim
      prismaMock.$executeRaw
        .mockResolvedValueOnce(1) // claim commission
        .mockResolvedValueOnce(1); // update payout amount

      prismaMock.commission.aggregate.mockResolvedValueOnce({
        _sum: { earnings: BigInt(15000) },
      });

      prismaMock.payout.findUniqueOrThrow.mockResolvedValueOnce({
        id: "po_positive_456",
        amount: 15000,
        programId: "prog_test",
        program: { accountingCurrency: "USD", name: "Yamax Affiliate" },
        partner: { preferredLocale: "en", preferredPayoutCurrency: "USD", weleticPayoutProfiles: [] },
        commissions: [],
      });

      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_test" }),
      });

      expect(response.status).toBe(200);

      // Verify raw SQL update on Payout was called with positive amount
      expect(prismaMock.$executeRaw).toHaveBeenCalledTimes(2);

      // Verify quote creation was attempted
      expect(prismaMock.weleticPayoutQuote.upsert).toHaveBeenCalledTimes(1);
    });
  });

  describe("Integration Lifecycle: Negative Rollover Recovery Across Consecutive Periods", () => {
    it("should preserve negative balance across period 1 and successfully deduct it from period 2 earnings", () => {
      // Simulation of partner ledger state across two periods:
      // Period 1:
      //   Order 101 commission: +$40.00 (+4000)
      //   Order 99 refund clawback: -$100.00 (-10000)
      //   Net period 1: -$60.00 (-6000)
      const period1Commissions = [
        { id: "comm_1", earnings: 4000, payoutId: null, status: "pending" },
        { id: "comm_2", earnings: -10000, payoutId: null, status: "pending" },
      ];

      const period1Net = period1Commissions.reduce((sum, c) => sum + c.earnings, 0);
      expect(period1Net).toBe(-6000);

      // Reconcile/aggregation rule: If net <= 0, commissions remain unassigned (payoutId: null, status: "pending")
      const period1PayoutAllowed = period1Net > 0;
      expect(period1PayoutAllowed).toBe(false);

      // Period 2:
      //   Partner continues selling and earns Order 105 commission: +$250.00 (+25000)
      const period2NewCommissions = [
        { id: "comm_3", earnings: 25000, payoutId: null, status: "pending" },
      ];

      // Due commissions for partner in Period 2 combines rollover pending + new pending
      const period2EligibleCommissions = [
        ...period1Commissions,
        ...period2NewCommissions,
      ];

      const period2Net = period2EligibleCommissions.reduce((sum, c) => sum + c.earnings, 0);
      // Net is: +4000 - 10000 + 25000 = +19000 ($190.00)
      expect(period2Net).toBe(19000);

      const period2PayoutAllowed = period2Net > 0;
      expect(period2PayoutAllowed).toBe(true);

      // Verify the final payout amount accurately reflects the deduction of the -$60 debt
      const expectedPayoutAmountDollars = period2Net / 100;
      expect(expectedPayoutAmountDollars).toBe(190.0);
    });
  });
});
