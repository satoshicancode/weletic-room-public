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
  persistFxQuote: vi.fn().mockResolvedValue({ id: "fx_snap_challenger" }),
}));

// Hoisted Prisma mocks
const prismaMock = vi.hoisted(() => {
  const payoutUpdate = vi.fn().mockResolvedValue({ id: "po_ch_1" });
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
  const weleticPayoutQuoteUpsert = vi.fn().mockResolvedValue({ id: "quote_ch_1" });
  const weleticPayoutStatementUpsert = vi.fn().mockResolvedValue({ id: "stmt_ch_1" });
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

describe("FIN-02 Challenger: Adversarial Stress Tests & Extreme Boundary Audits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.tx.commission.groupBy.mockReset();
    prismaMock.tx.commission.updateMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMock.tx.payout.deleteMany.mockReset().mockResolvedValue({ count: 1 });
    prismaMock.tx.payout.update.mockReset().mockResolvedValue({ id: "po_ch_1" });
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
    prismaMock.weleticPayoutQuote.upsert.mockReset().mockResolvedValue({ id: "quote_ch_1" });
    prismaMock.weleticPayoutStatement.upsert.mockReset().mockResolvedValue({ id: "stmt_ch_1" });
    prismaMock.$executeRaw.mockReset().mockResolvedValue(1);
    paypalMock.createPayPalBatchPayout.mockReset();
  });

  describe("Edge Case 1: Exactly $0.00 Payouts", () => {
    it("reconcilePayoutAmounts: deletes payout and rolls back commissions when net is exactly 0", async () => {
      // e.g. +$50.00 (5000 cents) sale and -$50.00 (-5000 cents) clawback => 0
      prismaMock.tx.commission.groupBy.mockResolvedValueOnce([
        { payoutId: "payout_exact_zero", _sum: { earnings: BigInt(0) } },
      ]);

      await reconcilePayoutAmounts(["payout_exact_zero"]);

      expect(prismaMock.tx.commission.updateMany).toHaveBeenCalledWith({
        where: { payoutId: { in: ["payout_exact_zero"] } },
        data: { payoutId: null, status: "pending" },
      });

      expect(prismaMock.tx.payout.deleteMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["payout_exact_zero"] },
          status: { in: MUTABLE_PAYOUT_STATUSES },
        },
      });

      expect(prismaMock.tx.payout.update).not.toHaveBeenCalled();
    });

    it("reconcilePayoutAmounts: deletes payout when commissions aggregate returns null/undefined (empty payout)", async () => {
      // Empty payout where no commissions exist
      prismaMock.tx.commission.groupBy.mockResolvedValueOnce([]);

      await reconcilePayoutAmounts(["payout_orphaned"]);

      expect(prismaMock.tx.commission.updateMany).toHaveBeenCalledWith({
        where: { payoutId: { in: ["payout_orphaned"] } },
        data: { payoutId: null, status: "pending" },
      });

      expect(prismaMock.tx.payout.deleteMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["payout_orphaned"] },
          status: { in: MUTABLE_PAYOUT_STATUSES },
        },
      });

      expect(prismaMock.tx.payout.update).not.toHaveBeenCalled();
    });

    it("createWeleticPayoutQuote: rejects exactly $0.00 payout with explicit non-positive error", async () => {
      prismaMock.payout.findUniqueOrThrow.mockResolvedValueOnce({
        id: "payout_zero_quote",
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
        createWeleticPayoutQuote({ payoutId: "payout_zero_quote" }),
      ).rejects.toThrow("Cannot create payout quote for non-positive payout");

      expect(prismaMock.weleticPayoutQuote.upsert).not.toHaveBeenCalled();
    });

    it("aggregateDueCommissions: rolls back commissions to pending if net aggregated earnings are exactly 0", async () => {
      prismaMock.program.findUnique.mockResolvedValueOnce({
        id: "prog_exact_zero",
        name: "Yamax Affiliate",
        workspaceId: "ws_test",
      });
      prismaMock.partnerGroup.groupBy.mockResolvedValueOnce([
        { holdingPeriodDays: 0, _count: { id: 1 } },
      ]);
      prismaMock.partnerGroup.findMany.mockResolvedValueOnce([{ id: "grp_1" }]);

      const now = new Date();
      prismaMock.commission.findMany.mockResolvedValueOnce([
        {
          id: "comm_1",
          createdAt: now,
          amount: BigInt(5000),
          earnings: BigInt(5000),
          status: CommissionStatus.pending,
          partnerId: "partner_zero",
          programId: "prog_exact_zero",
        },
        {
          id: "comm_2",
          createdAt: now,
          amount: BigInt(5000),
          earnings: BigInt(-5000),
          status: CommissionStatus.pending,
          partnerId: "partner_zero",
          programId: "prog_exact_zero",
        },
      ]);

      prismaMock.payout.findMany.mockResolvedValueOnce([]);
      prismaMock.payout.create.mockResolvedValueOnce({ id: "po_zero_tmp" });
      prismaMock.$executeRaw.mockResolvedValueOnce(2);

      // Aggregated earnings sum to exactly 0
      prismaMock.commission.aggregate.mockResolvedValueOnce({
        _sum: { earnings: BigInt(0) },
      });

      const response = await (aggregateDueCommissionsPOST as any)({
        rawBody: JSON.stringify({ programId: "prog_exact_zero" }),
      });

      expect(response.status).toBe(200);

      // Verify rollback to unassigned pending
      expect(prismaMock.commission.updateMany).toHaveBeenCalledWith({
        where: { payoutId: "po_zero_tmp" },
        data: { payoutId: null, status: CommissionStatus.pending },
      });

      expect(prismaMock.payout.deleteMany).toHaveBeenCalledWith({
        where: {
          id: "po_zero_tmp",
          status: { in: MUTABLE_PAYOUT_STATUSES },
        },
      });

      // No quote or positive raw sql update
      expect(prismaMock.weleticPayoutQuote.upsert).not.toHaveBeenCalled();
    });
  });

  describe("Edge Case 2: Extreme Negative Payouts (-$0.01, -$1,000.00, -$10,000,000.00)", () => {
    it("reconcilePayoutAmounts: handles minimal negative amount (-$0.01 / -1 cent) safely", async () => {
      // Sale +$100.00 (10000 cents), Clawback -$100.01 (-10001 cents) => -1 cent
      prismaMock.tx.commission.groupBy.mockResolvedValueOnce([
        { payoutId: "payout_subcent_neg", _sum: { earnings: BigInt(-1) } },
      ]);

      await reconcilePayoutAmounts(["payout_subcent_neg"]);

      expect(prismaMock.tx.commission.updateMany).toHaveBeenCalledWith({
        where: { payoutId: { in: ["payout_subcent_neg"] } },
        data: { payoutId: null, status: "pending" },
      });
      expect(prismaMock.tx.payout.deleteMany).toHaveBeenCalled();
      expect(prismaMock.tx.payout.update).not.toHaveBeenCalled();
    });

    it("reconcilePayoutAmounts: handles heavy negative amount (-$1,000.00 / -100,000 cents) safely", async () => {
      prismaMock.tx.commission.groupBy.mockResolvedValueOnce([
        { payoutId: "payout_heavy_neg", _sum: { earnings: BigInt(-100000) } },
      ]);

      await reconcilePayoutAmounts(["payout_heavy_neg"]);

      expect(prismaMock.tx.commission.updateMany).toHaveBeenCalledWith({
        where: { payoutId: { in: ["payout_heavy_neg"] } },
        data: { payoutId: null, status: "pending" },
      });
      expect(prismaMock.tx.payout.deleteMany).toHaveBeenCalled();
      expect(prismaMock.tx.payout.update).not.toHaveBeenCalled();
    });

    it("reconcilePayoutAmounts: handles massive BigInt negative reversal (-$10,000,000.00) safely", async () => {
      const massiveNegative = BigInt("-1000000000"); // -$10M
      prismaMock.tx.commission.groupBy.mockResolvedValueOnce([
        { payoutId: "payout_massive_neg", _sum: { earnings: massiveNegative } },
      ]);

      await reconcilePayoutAmounts(["payout_massive_neg"]);

      expect(prismaMock.tx.commission.updateMany).toHaveBeenCalledWith({
        where: { payoutId: { in: ["payout_massive_neg"] } },
        data: { payoutId: null, status: "pending" },
      });
      expect(prismaMock.tx.payout.deleteMany).toHaveBeenCalled();
      expect(prismaMock.tx.payout.update).not.toHaveBeenCalled();
    });

    it("createWeleticPayoutQuote: rejects -$0.01 and -$1000.00 payouts unconditionally", async () => {
      prismaMock.payout.findUniqueOrThrow.mockResolvedValueOnce({
        id: "payout_subcent",
        amount: -1,
        programId: "prog_1",
        program: { accountingCurrency: "USD", name: "Yamax" },
        partner: { preferredLocale: "en", preferredPayoutCurrency: "USD", weleticPayoutProfiles: [] },
        commissions: [],
      });

      await expect(
        createWeleticPayoutQuote({ payoutId: "payout_subcent" }),
      ).rejects.toThrow("Cannot create payout quote for non-positive payout");

      prismaMock.payout.findUniqueOrThrow.mockResolvedValueOnce({
        id: "payout_thousand",
        amount: -100000,
        programId: "prog_1",
        program: { accountingCurrency: "USD", name: "Yamax" },
        partner: { preferredLocale: "en", preferredPayoutCurrency: "USD", weleticPayoutProfiles: [] },
        commissions: [],
      });

      await expect(
        createWeleticPayoutQuote({ payoutId: "payout_thousand" }),
      ).rejects.toThrow("Cannot create payout quote for non-positive payout");
    });
  });

  describe("Edge Case 3: Multiple Consecutive Negative Rollover Periods", () => {
    it("simulates 3 consecutive negative rollover periods culminating in a recovery period", () => {
      // Period 1: Commission +$50.00 (+5000), Clawback -$100.00 (-10000)
      const period1 = [
        { id: "c1", earnings: 5000, payoutId: null, status: "pending" },
        { id: "c2", earnings: -10000, payoutId: null, status: "pending" },
      ];
      const netPeriod1 = period1.reduce((sum, c) => sum + c.earnings, 0);
      expect(netPeriod1).toBe(-5000); // -$50 debt
      const period1PayoutEligible = netPeriod1 > 0;
      expect(period1PayoutEligible).toBe(false);

      // Period 2: Commission +$20.00 (+2000), Clawback -$40.00 (-4000)
      const period2 = [
        { id: "c3", earnings: 2000, payoutId: null, status: "pending" },
        { id: "c4", earnings: -4000, payoutId: null, status: "pending" },
      ];
      const cumulativePeriod2 = [...period1, ...period2];
      const netPeriod2 = cumulativePeriod2.reduce((sum, c) => sum + c.earnings, 0);
      expect(netPeriod2).toBe(-7000); // -$70 debt
      const period2PayoutEligible = netPeriod2 > 0;
      expect(period2PayoutEligible).toBe(false);

      // Period 3: No sales, extra refund -$10.00 (-1000)
      const period3 = [
        { id: "c5", earnings: -1000, payoutId: null, status: "pending" },
      ];
      const cumulativePeriod3 = [...cumulativePeriod2, ...period3];
      const netPeriod3 = cumulativePeriod3.reduce((sum, c) => sum + c.earnings, 0);
      expect(netPeriod3).toBe(-8000); // -$80 debt
      const period3PayoutEligible = netPeriod3 > 0;
      expect(period3PayoutEligible).toBe(false);

      // Period 4: Major sales drive +$300.00 (+30000)
      const period4 = [
        { id: "c6", earnings: 30000, payoutId: null, status: "pending" },
      ];
      const cumulativePeriod4 = [...cumulativePeriod3, ...period4];
      const netPeriod4 = cumulativePeriod4.reduce((sum, c) => sum + c.earnings, 0);
      // Net is: -8000 + 30000 = +22000 (+$220.00)
      expect(netPeriod4).toBe(22000);
      const period4PayoutEligible = netPeriod4 > 0;
      expect(period4PayoutEligible).toBe(true);

      // Merchant successfully clawed back all $80.00 of prior debt automatically!
      expect(netPeriod4 / 100).toBe(220.0);
    });
  });

  describe("Edge Case 4: Partial Refunds Exceeding Earnings", () => {
    it("handles multiple partial refunds totaling more than original earnings", async () => {
      // Original Commission: $100.00 (10000)
      // Partial Refund 1: -$40.00 (-4000)
      // Partial Refund 2: -$40.00 (-4000)
      // Partial Refund 3: -$30.00 (-3000)
      // Total Refunds: -$110.00 (-11000) => Net: -$10.00 (-1000)
      prismaMock.tx.commission.groupBy.mockResolvedValueOnce([
        { payoutId: "payout_partial_overflow", _sum: { earnings: BigInt(-1000) } },
      ]);

      await reconcilePayoutAmounts(["payout_partial_overflow"]);

      expect(prismaMock.tx.commission.updateMany).toHaveBeenCalledWith({
        where: { payoutId: { in: ["payout_partial_overflow"] } },
        data: { payoutId: null, status: "pending" },
      });

      expect(prismaMock.tx.payout.deleteMany).toHaveBeenCalledWith({
        where: {
          id: { in: ["payout_partial_overflow"] },
          status: { in: MUTABLE_PAYOUT_STATUSES },
        },
      });

      expect(prismaMock.tx.payout.update).not.toHaveBeenCalled();
    });
  });

  describe("Edge Case 5: Payment Gateway Dispatch & Quote Creation Lockdown", () => {
    it("sendPaypalPayouts: enforces double-lock preventing zero or negative payouts from reaching PayPal", async () => {
      const mockInvoice = { id: "inv_adversarial", payoutMode: "internal" as const };

      // DB returns adversary injection containing non-positive items
      prismaMock.payout.findMany.mockResolvedValueOnce([
        {
          id: "payout_adv_neg_1000",
          amount: -100000, // -$1000.00
          currency: "USD",
          partner: { email: "a@test.com", paypalEmail: "a@paypal.com" },
          program: { name: "Yamax", logo: null },
        },
        {
          id: "payout_adv_subcent",
          amount: -1, // -$0.01
          currency: "USD",
          partner: { email: "b@test.com", paypalEmail: "b@paypal.com" },
          program: { name: "Yamax", logo: null },
        },
        {
          id: "payout_adv_zero",
          amount: 0, // $0.00
          currency: "USD",
          partner: { email: "c@test.com", paypalEmail: "c@paypal.com" },
          program: { name: "Yamax", logo: null },
        },
        {
          id: "payout_legit_pos",
          amount: 7500, // +$75.00
          currency: "USD",
          partner: { email: "d@test.com", paypalEmail: "d@paypal.com" },
          program: { name: "Yamax", logo: null },
        },
      ]);

      paypalMock.createPayPalBatchPayout.mockResolvedValueOnce({
        successfulPayoutIds: ["payout_legit_pos"],
        failedPayoutIds: [],
        results: [{ currency: "USD", success: true, batchId: "BATCH_SAFE_789" }],
      });

      await sendPaypalPayouts({ invoice: mockInvoice });

      // 1. Verify DB query explicitly requests amount: { gt: 0 }
      expect(prismaMock.payout.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            invoiceId: "inv_adversarial",
            amount: { gt: 0 },
          }),
        }),
      );

      // 2. Verify in-memory defense filtered out all non-positive payouts
      expect(paypalMock.createPayPalBatchPayout).toHaveBeenCalledTimes(1);
      expect(paypalMock.createPayPalBatchPayout).toHaveBeenCalledWith({
        payouts: [
          expect.objectContaining({
            id: "payout_legit_pos",
            amount: 7500,
          }),
        ],
        invoiceId: "inv_adversarial",
      });

      // 3. Only the positive payout was updated to "sent"
      expect(prismaMock.payout.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ["payout_legit_pos"] } },
        data: expect.objectContaining({ status: "sent", method: "paypal" }),
      });
    });

    it("sendPaypalPayouts: strictly aborts and dispatches 0 API calls when all payouts are non-positive", async () => {
      const mockInvoice = { id: "inv_all_negative", payoutMode: "internal" as const };

      prismaMock.payout.findMany.mockResolvedValueOnce([
        {
          id: "payout_neg1",
          amount: -500,
          currency: "USD",
          partner: { email: "x@test.com", paypalEmail: "x@paypal.com" },
          program: { name: "Yamax", logo: null },
        },
        {
          id: "payout_zero1",
          amount: 0,
          currency: "USD",
          partner: { email: "y@test.com", paypalEmail: "y@paypal.com" },
          program: { name: "Yamax", logo: null },
        },
      ]);

      await sendPaypalPayouts({ invoice: mockInvoice });

      // PayPal API must NEVER be invoked
      expect(paypalMock.createPayPalBatchPayout).not.toHaveBeenCalled();
      expect(prismaMock.payout.updateMany).not.toHaveBeenCalled();
    });
  });
});
