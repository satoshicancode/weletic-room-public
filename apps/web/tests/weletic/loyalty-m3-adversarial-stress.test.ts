import { prisma } from "@/lib/prisma";
import {
  allocatePointsAcrossOrderLines,
  calculateEligibleOrderPoints,
  calculateRefundPointsReversal,
  processRefundPointsReversal,
} from "@/lib/weletic/loyalty/earn";
import { releaseHoldingPeriodGrant } from "@/lib/weletic/loyalty/holding-period";
import {
  appendPointsLedgerEntry,
  getAccountPointsBalance,
  reconcileAccountPoints,
} from "@/lib/weletic/loyalty/ledger";
import { Prisma, WeleticPointsLedgerEntryType } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/weletic/loyalty/points-communication-producer", () => ({
  enqueuePurchasePointsCommunication: vi.fn().mockResolvedValue(null),
}));

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
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn(),
      create: vi.fn(),
    },
    weleticLoyaltyEarnGrant: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    weleticLoyaltyOrderLineEarn: {
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(),
    },
    weleticCommerceRefund: {
      findUnique: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn(),
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

describe("M3 Adversarial Stress Harness: Holding Periods, Negative Balances & OCC Concurrency", () => {
  const STORE_ID = "wstore_adv_stress";
  const ACCOUNT_ID = "wlacc_adv_stress";
  const GRANT_ID = "wgrant_adv_stress";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // SUITE 1: HOLDING PERIODS & MATURITY LIFECYCLE ADVERSARIAL CHALLENGES
  // =========================================================================
  describe("1. Holding Periods: Rapid Refunds, Double Maturity & Outbox Retries", () => {
    it("Stress 1.1: Rapid full refund prior to availableAt voids pending bucket without touching available balance", async () => {
      // Order created with 14-day holding period: 100 pending points
      // Customer has 50 existing available points in wallet
      const mockGrant = {
        id: GRANT_ID,
        storeId: STORE_ID,
        orderId: "ord_pending_100",
        status: "pending",
        grossPoints: BigInt(100),
        pendingPoints: BigInt(100),
        settledPoints: BigInt(0),
        reversedPoints: BigInt(0),
        eligibleSubtotalAmount: BigInt(10000),
        orderTotalAmount: BigInt(10000),
        lineEarns: [
          {
            id: "le_line_1",
            storeId: STORE_ID,
            grantId: GRANT_ID,
            orderLineId: "line_1",
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(100),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };

      (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce({
        id: "ref_early_full",
        storeId: STORE_ID,
        externalId: "ext_ref_early",
        orderId: "ord_pending_100",
        shopAmount: BigInt(10000),
        shopCurrency: "USD",
        order: {
          id: "ord_pending_100",
          storeId: STORE_ID,
          externalId: "ext_ord_100",
          orderName: "#1001",
          shopper: {
            id: "shopper_1",
            storeId: STORE_ID,
            loyaltyAccount: {
              id: ACCOUNT_ID,
              storeId: STORE_ID,
              cachedPointsBalance: BigInt(50), // Pre-existing liquid balance
              cachedPendingPoints: BigInt(100),
              lifetimePointsEarned: BigInt(50),
              lifetimePointsRedeemed: BigInt(0),
              ledgerVersion: 1,
            },
          },
        },
        lines: [
          { id: "rl_1", orderLineId: "line_1", shopAmount: BigInt(10000) },
        ],
      });

      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce(
        mockGrant,
      );
      (prisma.weleticLoyaltyOrderLineEarn.updateMany as any).mockResolvedValue({
        count: 1,
      });
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValue({
        id: ACCOUNT_ID,
        storeId: STORE_ID,
        cachedPointsBalance: BigInt(50),
        cachedPendingPoints: BigInt(100),
        lifetimePointsEarned: BigInt(50),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1,
      });
      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValueOnce({
        count: 1,
      });
      (prisma.weleticLoyaltyEarnGrant.updateMany as any).mockResolvedValue({
        count: 1,
      });
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        ({ data }: any) => ({ ...data, id: "ledger_pending_void" }),
      );
      (prisma.weleticLoyaltyOutboxJob.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticLoyaltyOutboxJob.create as any).mockResolvedValue({});

      const result = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: "ref_early_full",
      });

      // Pending-only reversals still create one immutable idempotency marker.
      expect(result?.pointsDelta).toBe(BigInt(0));
      expect(result?.pendingDelta).toBe(BigInt(-100));

      // The account's pending bucket is changed through ledger OCC.
      expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pointsDelta: BigInt(0),
            pendingDelta: BigInt(-100),
            balanceAfter: BigInt(50),
            idempotencyKey: "refund_reversal:ref_early_full",
          }),
        }),
      );

      // The direct line reversal is claimed with the persisted source snapshot
      // so concurrent refund workers cannot reverse the same points twice.
      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: "le_line_1",
          grantId: GRANT_ID,
          storeId: STORE_ID,
          reversedPoints: BigInt(0),
        },
        data: { reversedPoints: BigInt(100) },
      });

      // Grant transitioned to voided
      expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: GRANT_ID, status: "pending" }),
          data: expect.objectContaining({
            pendingPoints: BigInt(0),
            reversedPoints: BigInt(100),
            status: "voided",
          }),
        }),
      );
    });

    it("Stress 1.2: Multi-step lifecycle: Partial refund while pending -> Maturity release -> Second partial refund on settled", async () => {
      // Grant originally earned 100 points ($100 order: Line 1 $60 = 60pts, Line 2 $40 = 40pts)
      // Step A: Partial refund of $30 on Line 1 while pending (voids 30 pending points, 70 remain pending)
      const mockGrantPending = {
        id: GRANT_ID,
        storeId: STORE_ID,
        orderId: "ord_multi_step",
        status: "pending",
        grossPoints: BigInt(100),
        pendingPoints: BigInt(100),
        settledPoints: BigInt(0),
        reversedPoints: BigInt(0),
        eligibleSubtotalAmount: BigInt(10000),
        lineEarns: [
          {
            id: "le_1",
            orderLineId: "line_1",
            lineNetAmount: BigInt(6000),
            awardedPoints: BigInt(60),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
          {
            id: "le_2",
            orderLineId: "line_2",
            lineNetAmount: BigInt(4000),
            awardedPoints: BigInt(40),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };

      const step1Reversal = calculateRefundPointsReversal({
        originalGrant: mockGrantPending,
        refundedLines: [
          {
            orderLineId: "line_1",
            cumulativeShopAmount: BigInt(3000),
          },
        ],
      });

      expect(step1Reversal.totalPointsToClawback).toBe(BigInt(30));
      expect(step1Reversal.voidPendingPoints).toBe(BigInt(30));
      expect(step1Reversal.debitSettledPoints).toBe(BigInt(0));

      // Step B: Maturity release executes for remaining 70 pending points
      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce({
        id: GRANT_ID,
        storeId: STORE_ID,
        accountId: ACCOUNT_ID,
        orderId: "ord_multi_step",
        status: "pending",
        pendingPoints: BigInt(70), // 70 points remaining after Step A
        grossPoints: BigInt(100),
        reversedPoints: BigInt(30),
        order: { externalId: "ord_ext", orderName: "#1001" },
      });

      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: ACCOUNT_ID,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(70),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1,
      });

      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValueOnce({
        count: 1,
      });
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementationOnce(
        ({ data }: any) => ({
          ...data,
          id: "wledger_mature_release",
        }),
      );
      (prisma.weleticLoyaltyEarnGrant.update as any).mockResolvedValue({});
      (prisma.weleticLoyaltyOutboxJob.create as any).mockResolvedValue({});

      const releaseResult = await releaseHoldingPeriodGrant({
        grantId: GRANT_ID,
      });

      expect(releaseResult.released).toBe(true);
      expect(releaseResult.points).toBe(BigInt(70));
      expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pointsDelta: BigInt(70),
            pendingDelta: BigInt(-70),
            balanceAfter: BigInt(70),
          }),
        }),
      );

      // Step C: Second partial refund ($40 full refund of Line 2) occurs after grant is settled
      const mockGrantSettled = {
        id: GRANT_ID,
        grossPoints: BigInt(100),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(70),
        reversedPoints: BigInt(30),
        eligibleSubtotalAmount: BigInt(10000),
        lineEarns: [
          {
            id: "le_1",
            orderLineId: "line_1",
            lineNetAmount: BigInt(6000),
            awardedPoints: BigInt(60),
            reversedPoints: BigInt(30), // already reversed in step A
            isExcluded: false,
          },
          {
            id: "le_2",
            orderLineId: "line_2",
            lineNetAmount: BigInt(4000),
            awardedPoints: BigInt(40),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };

      const step2Reversal = calculateRefundPointsReversal({
        originalGrant: mockGrantSettled,
        refundedLines: [
          {
            orderLineId: "line_2",
            cumulativeShopAmount: BigInt(4000),
          },
        ],
      });

      expect(step2Reversal.totalPointsToClawback).toBe(BigInt(40));
      expect(step2Reversal.voidPendingPoints).toBe(BigInt(0)); // 0 pending left
      expect(step2Reversal.debitSettledPoints).toBe(BigInt(40)); // Exactly 40 debited from settled
      expect(step2Reversal.isNegativeBalanceAllowed).toBe(true);
    });

    it("Stress 1.3: Double execution / Outbox Retries: Subsequent execution on settled grant safely skips with released: false", async () => {
      // First execution matures the grant
      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce({
        id: GRANT_ID,
        storeId: STORE_ID,
        accountId: ACCOUNT_ID,
        orderId: "ord_retry_1",
        status: "pending",
        pendingPoints: BigInt(120),
        grossPoints: BigInt(120),
        reversedPoints: BigInt(0),
        order: { externalId: "ext_1", orderName: "#2001" },
      });

      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: ACCOUNT_ID,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(120),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1,
      });

      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValueOnce({
        count: 1,
      });
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementationOnce(
        ({ data }: any) => ({
          ...data,
          id: "wledger_first_mature",
        }),
      );
      (prisma.weleticLoyaltyEarnGrant.updateMany as any).mockResolvedValueOnce({
        count: 1,
      });
      (prisma.weleticLoyaltyOutboxJob.create as any).mockResolvedValueOnce({});

      const firstRun = await releaseHoldingPeriodGrant({ grantId: GRANT_ID });
      expect(firstRun.released).toBe(true);
      expect(firstRun.points).toBe(BigInt(120));

      // Second execution (e.g. outbox job retry or duplicate worker delivery)
      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce({
        id: GRANT_ID,
        storeId: STORE_ID,
        accountId: ACCOUNT_ID,
        orderId: "ord_retry_1",
        status: "settled", // already settled!
        pendingPoints: BigInt(0),
        settledPoints: BigInt(120),
        grossPoints: BigInt(120),
        reversedPoints: BigInt(0),
        order: { externalId: "ext_1", orderName: "#2001" },
      });

      const retryRun = await releaseHoldingPeriodGrant({ grantId: GRANT_ID });
      expect(retryRun.released).toBe(false);
      expect(retryRun.reason).toBe("grant_already_settled");

      // Ledger entry was created only ONCE across both calls
      expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledTimes(1);
    });

    it("Stress 1.4: Zero pending points grant release safely terminates without modifying balances", async () => {
      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce({
        id: GRANT_ID,
        storeId: STORE_ID,
        accountId: ACCOUNT_ID,
        orderId: "ord_zero_pending",
        status: "pending",
        pendingPoints: BigInt(0), // All voided previously
        grossPoints: BigInt(100),
        reversedPoints: BigInt(100),
        order: { externalId: "ext_1", orderName: "#2002" },
      });

      (prisma.weleticLoyaltyEarnGrant.update as any).mockResolvedValueOnce({});

      const res = await releaseHoldingPeriodGrant({ grantId: GRANT_ID });
      expect(res.released).toBe(false);
      expect(res.reason).toBe("zero_pending_points");
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
    });

    it("Stress 1.5: Outbox release retry storm: 10 concurrent releases on same grant execute exactly 1 ledger append", async () => {
      let grantStatus = "pending";
      const createdLedgerEntries: any[] = [];

      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockImplementation(
        async () => ({
          id: GRANT_ID,
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          orderId: "ord_storm_1",
          status: grantStatus,
          pendingPoints: grantStatus === "pending" ? BigInt(250) : BigInt(0),
          settledPoints: grantStatus === "settled" ? BigInt(250) : BigInt(0),
          grossPoints: BigInt(250),
          reversedPoints: BigInt(0),
          order: { externalId: "ext_storm", orderName: "#3001" },
        }),
      );

      (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
        async () => ({
          id: ACCOUNT_ID,
          cachedPointsBalance: BigInt(0),
          cachedPendingPoints: BigInt(250),
          lifetimePointsEarned: BigInt(0),
          lifetimePointsRedeemed: BigInt(0),
          ledgerVersion: 1,
        }),
      );

      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValue({
        count: 1,
      });
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockImplementation(
        async ({ where }: any) => {
          const key = where?.storeId_idempotencyKey?.idempotencyKey;
          return (
            createdLedgerEntries.find((e) => e.idempotencyKey === key) || null
          );
        },
      );
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        ({ data }: any) => {
          if (
            createdLedgerEntries.some(
              (e) => e.idempotencyKey === data.idempotencyKey,
            )
          ) {
            throw new Prisma.PrismaClientKnownRequestError(
              "Unique constraint failed",
              {
                code: "P2002",
                clientVersion: "5.0.0",
              },
            );
          }
          const entry = {
            ...data,
            id: `wledger_storm_${createdLedgerEntries.length + 1}`,
          };
          createdLedgerEntries.push(entry);
          return entry;
        },
      );
      (prisma.weleticLoyaltyEarnGrant.updateMany as any).mockImplementation(
        async ({ where, data }: any) => {
          if (where.status !== grantStatus) {
            return { count: 0 };
          }
          grantStatus = data.status;
          return { count: 1 };
        },
      );
      (prisma.weleticLoyaltyOutboxJob.create as any).mockResolvedValue({});

      // Fire 10 releases concurrently
      const stormPromises = Array.from({ length: 10 }).map(() =>
        releaseHoldingPeriodGrant({ grantId: GRANT_ID }),
      );
      const results = await Promise.all(stormPromises);

      // Exactly 1 unique ledger entry created (zero double crediting)
      expect(createdLedgerEntries.length).toBe(1);
      expect(grantStatus).toBe("settled");
    });
  });

  // =========================================================================
  // SUITE 2: EXACT PROPORTIONAL REFUNDS & NEGATIVE BALANCE ACCUMULATION
  // =========================================================================
  describe("2. Exact Proportional Refunds & Uncapped Negative Debt (ADR 0004)", () => {
    it("Stress 2.1: Multi-partial refund sequence preventing over-clawback on repeated line refunds", () => {
      const originalGrant = {
        id: GRANT_ID,
        grossPoints: BigInt(100),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(100),
        reversedPoints: BigInt(0),
        eligibleSubtotalAmount: BigInt(10000),
        lineEarns: [
          {
            id: "le1",
            orderLineId: "l1",
            lineNetAmount: BigInt(5000),
            awardedPoints: BigInt(50),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
          {
            id: "le2",
            orderLineId: "l2",
            lineNetAmount: BigInt(5000),
            awardedPoints: BigInt(50),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };

      // Refund 1: $25 on L1 -> 25 clawback
      const r1 = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          { orderLineId: "l1", cumulativeShopAmount: BigInt(2500) },
        ],
      });
      expect(r1.totalPointsToClawback).toBe(BigInt(25));

      // Simulate DB update after Refund 1
      originalGrant.reversedPoints = BigInt(25);
      originalGrant.lineEarns[0].reversedPoints = BigInt(25);

      // Refund 2: remaining $25 on L1 ($50 cumulative) -> 25 clawback
      const r2 = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          { orderLineId: "l1", cumulativeShopAmount: BigInt(5000) },
        ],
      });
      expect(r2.totalPointsToClawback).toBe(BigInt(25));

      // Simulate DB update after Refund 2
      originalGrant.reversedPoints = BigInt(50);
      originalGrant.lineEarns[0].reversedPoints = BigInt(50);

      // Refund 3: Bogus extra refund makes $70 cumulative on an already reversed line
      const r3 = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          { orderLineId: "l1", cumulativeShopAmount: BigInt(7000) },
        ],
      });
      // MUST clawback 0 points!
      expect(r3.totalPointsToClawback).toBe(BigInt(0));
      expect(r3.lineClawbacks[0].lineClawback).toBe(BigInt(0));
    });

    it("Stress 2.2: Deep negative debt accumulation across sequential refunds without zero-clamping", async () => {
      // Initial state: Balance = 0, Lifetime Earned = 200, Lifetime Redeemed = 200
      let currentBalance = BigInt(0);
      let currentVersion = 1;

      const ledgerEntries: any[] = [];

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        ({ data }: any) => {
          const entry = { ...data, id: `wledger_${data.sequenceNumber}` };
          ledgerEntries.push(entry);
          return entry;
        },
      );

      (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
        async () => ({
          id: ACCOUNT_ID,
          storeId: STORE_ID,
          status: "active",
          cachedPointsBalance: currentBalance,
          cachedPendingPoints: BigInt(0),
          lifetimePointsEarned: BigInt(200),
          lifetimePointsRedeemed: BigInt(200),
          ledgerVersion: currentVersion,
        }),
      );

      (prisma.weleticLoyaltyAccount.updateMany as any).mockImplementation(
        async ({ data, where }: any) => {
          if (where.ledgerVersion === currentVersion) {
            currentBalance = data.cachedPointsBalance;
            currentVersion = data.ledgerVersion;
            return { count: 1 };
          }
          return { count: 0 };
        },
      );

      // Refund 1: -30 points -> balance should become -30
      const e1 = await appendPointsLedgerEntry({
        storeId: STORE_ID,
        accountId: ACCOUNT_ID,
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: BigInt(-30),
        idempotencyKey: "ref_rev_seq_1",
      });
      expect(e1.balanceAfter).toBe(BigInt(-30));
      expect(currentBalance).toBe(BigInt(-30));

      // Refund 2: -45 points -> balance should become -75
      const e2 = await appendPointsLedgerEntry({
        storeId: STORE_ID,
        accountId: ACCOUNT_ID,
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: BigInt(-45),
        idempotencyKey: "ref_rev_seq_2",
      });
      expect(e2.balanceAfter).toBe(BigInt(-75));
      expect(currentBalance).toBe(BigInt(-75));

      // Refund 3: -25 points -> balance should become -100
      const e3 = await appendPointsLedgerEntry({
        storeId: STORE_ID,
        accountId: ACCOUNT_ID,
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: BigInt(-25),
        idempotencyKey: "ref_rev_seq_3",
      });
      expect(e3.balanceAfter).toBe(BigInt(-100));
      expect(currentBalance).toBe(BigInt(-100));

      // Check account balance status helper
      const balanceCheck = await getAccountPointsBalance(ACCOUNT_ID);
      expect(balanceCheck?.isNegative).toBe(true);
      expect(balanceCheck?.canRedeem).toBe(false);
      expect(balanceCheck?.pointsBalance).toBe(BigInt(-100));

      // Subsequent order earn: +40 points -> balance should recover to -60 (still negative)
      const e4 = await appendPointsLedgerEntry({
        storeId: STORE_ID,
        accountId: ACCOUNT_ID,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(40),
        idempotencyKey: "earn_recovery_1",
      });
      expect(e4.balanceAfter).toBe(BigInt(-60));
      expect(currentBalance).toBe(BigInt(-60));
    });

    it("Stress 2.3: Rule / Tier changes after purchase do not corrupt original calculation snapshot reversal", () => {
      // Order placed during VIP Gold 3x promotion: $100 order earned 300 points (Line 1: $100 -> 300 pts)
      const originalGrant = {
        id: GRANT_ID,
        grossPoints: BigInt(300),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(300),
        reversedPoints: BigInt(0),
        eligibleSubtotalAmount: BigInt(10000),
        calculationSnapshot: {
          multiplier: 3.0,
          tier: "VIP_GOLD",
        },
        lineEarns: [
          {
            id: "le_vip",
            orderLineId: "line_vip",
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(300), // Snapshotted 3x rate
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };

      // 50% partial refund of the order ($50)
      const reversal = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          {
            orderLineId: "line_vip",
            cumulativeShopAmount: BigInt(5000),
          },
        ],
      });

      // Clawback MUST be 150 points (50% of 300 points), ignoring any current 1x rate
      expect(reversal.totalPointsToClawback).toBe(BigInt(150));
      expect(reversal.debitSettledPoints).toBe(BigInt(150));
      expect(reversal.lineClawbacks[0].lineClawback).toBe(BigInt(150));
    });

    it("Stress 2.4: Extreme 0-decimal multi-currency rational calculations without precision loss or overflow", () => {
      // 1 Billion VND Order @ 0.001 rate = 1,000,000 points
      const pointsVND = calculateEligibleOrderPoints({
        netAmountCents: BigInt(1000000000),
        currency: "VND",
        pointsPerCurrencyUnit: "0.001",
        multiplier: "1.25", // VIP Gold 1.25x
      });
      // 1,000,000,000 * 0.001 * 1.25 = 1,250,000 points
      expect(pointsVND).toBe(BigInt(1250000));

      // 50 Million JPY Order @ 0.01 rate (1 pt per 100 JPY) = 500,000 points
      const pointsJPY = calculateEligibleOrderPoints({
        netAmountCents: BigInt(50000000),
        currency: "JPY",
        pointsPerCurrencyUnit: "0.01",
        multiplier: "2.0",
      });
      expect(pointsJPY).toBe(BigInt(1000000));
    });

    it("Stress 2.5: Complex odd fraction penny conservation: 10-line prime net distribution allocates exactly 777 points", () => {
      const primeLines = [
        { orderLineId: "p1", lineNetAmount: BigInt(713) },
        { orderLineId: "p2", lineNetAmount: BigInt(1117) },
        { orderLineId: "p3", lineNetAmount: BigInt(1319) },
        { orderLineId: "p4", lineNetAmount: BigInt(1723) },
        { orderLineId: "p5", lineNetAmount: BigInt(1929) },
        { orderLineId: "p6", lineNetAmount: BigInt(2331) },
        { orderLineId: "p7", lineNetAmount: BigInt(2937) },
        { orderLineId: "p8", lineNetAmount: BigInt(3141) },
        { orderLineId: "p9", lineNetAmount: BigInt(3743) },
        { orderLineId: "p10", lineNetAmount: BigInt(4147) },
      ];

      const allocation = allocatePointsAcrossOrderLines({
        grossPoints: BigInt(777),
        lines: primeLines,
      });

      const totalAllocated = allocation.reduce(
        (sum, l) => sum + l.awardedPoints,
        BigInt(0),
      );
      expect(totalAllocated).toBe(BigInt(777));
    });

    it("Stress 2.6: Excluded lines (e.g. discounted items or shipping) result in 0 clawback upon refund", () => {
      const grantWithExclusions = {
        id: GRANT_ID,
        grossPoints: BigInt(50),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(50),
        reversedPoints: BigInt(0),
        eligibleSubtotalAmount: BigInt(5000),
        lineEarns: [
          {
            id: "le_regular",
            orderLineId: "line_regular",
            lineNetAmount: BigInt(5000),
            awardedPoints: BigInt(50),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
          {
            id: "le_excluded",
            orderLineId: "line_discounted",
            lineNetAmount: BigInt(5000),
            awardedPoints: BigInt(0),
            reversedPoints: BigInt(0),
            isExcluded: true,
          },
        ],
      };

      // Refund the excluded line ($50)
      const reversal = calculateRefundPointsReversal({
        originalGrant: grantWithExclusions,
        refundedLines: [
          {
            orderLineId: "line_discounted",
            cumulativeShopAmount: BigInt(5000),
          },
        ],
      });

      expect(reversal.totalPointsToClawback).toBe(BigInt(0));
      expect(reversal.debitSettledPoints).toBe(BigInt(0));
      expect(reversal.lineClawbacks[0].lineClawback).toBe(BigInt(0));
    });
  });

  // =========================================================================
  // SUITE 3: OCC LEDGER CONCURRENCY STRESS HARNESS (50+ SIMULTANEOUS TXS)
  // =========================================================================
  describe("3. Real OCC Concurrency Harness: 100 Simultaneous Transactions & Idempotency Storms", () => {
    it("Stress 3.1: 100 simultaneous concurrent ledger appends achieve exact mathematical convergence with 0 sequence collisions", async () => {
      // State simulator representing ACID MySQL table with transactional rollback
      let committedVersion = 0;
      let committedBalance = BigInt(0);
      let committedLifetimeEarned = BigInt(0);
      let committedLifetimeRedeemed = BigInt(0);

      const committedLedger: any[] = [];
      const CONCURRENT_TRANSACTIONS = 100;

      // Mock $transaction executing atomic block with snapshot isolation & rollback on OCC failure
      (prisma.$transaction as any).mockImplementation(async (callback: any) => {
        let uncommittedEntries: any[] = [];

        const txClient: any = {
          weleticPointsLedgerEntry: {
            findUnique: async ({ where }: any) => {
              const key = where?.storeId_idempotencyKey?.idempotencyKey;
              return (
                committedLedger.find((e) => e.idempotencyKey === key) || null
              );
            },
            create: async ({ data }: any) => {
              const entry = { ...data, id: `wledger_${data.sequenceNumber}` };
              uncommittedEntries.push(entry);
              return entry;
            },
          },
          weleticLoyaltyAccount: {
            findUnique: async () => ({
              id: ACCOUNT_ID,
              storeId: STORE_ID,
              status: "active",
              cachedPointsBalance: committedBalance,
              cachedPendingPoints: BigInt(0),
              lifetimePointsEarned: committedLifetimeEarned,
              lifetimePointsRedeemed: committedLifetimeRedeemed,
              ledgerVersion: committedVersion,
            }),
            updateMany: async ({ where, data }: any) => {
              // Atomic version check at commit phase
              if (where.ledgerVersion === committedVersion) {
                committedVersion = data.ledgerVersion;
                committedBalance = data.cachedPointsBalance;
                committedLifetimeEarned = data.lifetimePointsEarned;
                committedLifetimeRedeemed = data.lifetimePointsRedeemed;
                // Commit uncommitted entries
                committedLedger.push(...uncommittedEntries);
                uncommittedEntries = [];
                return { count: 1 };
              }
              // OCC Conflict: discard uncommitted entries (rollback)
              uncommittedEntries = [];
              return { count: 0 };
            },
          },
        };

        return await callback(txClient);
      });

      // Array of 100 deltas: alternating earns and redemptions
      const deltas: bigint[] = [];
      let expectedSumDelta = BigInt(0);
      for (let i = 0; i < CONCURRENT_TRANSACTIONS; i++) {
        const delta =
          i % 2 === 0 ? BigInt(10 + (i % 20)) : BigInt(-(5 + (i % 7)));
        deltas.push(delta);
        expectedSumDelta += delta;
      }

      const initialBalance = committedBalance;
      const expectedFinalBalance = initialBalance + expectedSumDelta;

      // Dispatch 100 simultaneous asynchronous append operations
      const promises = deltas.map((delta, index) =>
        appendPointsLedgerEntry({
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          entryType:
            delta > BigInt(0)
              ? WeleticPointsLedgerEntryType.EARN_ORDER
              : WeleticPointsLedgerEntryType.REDEEM_REWARD,
          pointsDelta: delta,
          idempotencyKey: `occ_stress_tx_100_${index}`,
          reason: `Concurrent stress transaction #${index}`,
        }),
      );

      const results = await Promise.all(promises);

      // Verification 1: All 100 transactions succeeded without unhandled errors
      expect(results.length).toBe(CONCURRENT_TRANSACTIONS);

      // Verification 2: Final state version reached exactly 100
      expect(committedVersion).toBe(CONCURRENT_TRANSACTIONS);

      // Verification 3: Final cached balance converged exactly to mathematical expectation
      expect(committedBalance).toBe(expectedFinalBalance);

      // Verification 4: Zero sequence collisions or gaps in ledger entries
      const sequenceNumbers = committedLedger
        .map((e) => e.sequenceNumber)
        .sort((a, b) => a - b);
      expect(sequenceNumbers.length).toBe(CONCURRENT_TRANSACTIONS);
      for (let i = 0; i < CONCURRENT_TRANSACTIONS; i++) {
        expect(sequenceNumbers[i]).toBe(i + 1);
      }

      // Verification 5: Audit reconciliation confirms zero corruption
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: ACCOUNT_ID,
        cachedPointsBalance: committedBalance,
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: committedLifetimeEarned,
        lifetimePointsRedeemed: committedLifetimeRedeemed,
        ledgerVersion: committedVersion,
      });
      (prisma.weleticPointsLedgerEntry.findMany as any).mockResolvedValueOnce(
        [...committedLedger].sort(
          (a, b) => a.sequenceNumber - b.sequenceNumber,
        ),
      );
      (prisma.weleticLoyaltyAccount.update as any).mockResolvedValueOnce({});

      // Set up $transaction for audit reconciliation
      (prisma.$transaction as any).mockImplementationOnce(async (cb: any) =>
        cb(prisma),
      );

      const audit = await reconcileAccountPoints(ACCOUNT_ID);
      expect(audit.repaired).toBe(false);
      expect(audit.entriesCount).toBe(CONCURRENT_TRANSACTIONS);
      expect(audit.calculatedBalance).toBe(expectedFinalBalance);
    });

    it("Stress 3.2: Sequence Gap Detection immediately aborts and flags corruption in audit reconciliation", async () => {
      (prisma.$transaction as any).mockImplementationOnce(async (cb: any) =>
        cb(prisma),
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: ACCOUNT_ID,
        cachedPointsBalance: BigInt(300),
        lifetimePointsEarned: BigInt(300),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 3,
      });

      // Intentionally missing sequence #2 (contains seq 1 and seq 3)
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
          pointsDelta: BigInt(200),
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        },
      ]);

      await expect(reconcileAccountPoints(ACCOUNT_ID)).rejects.toThrow(
        /Sequence gap detected for account/,
      );
    });

    it("Stress 3.3: Concurrent Idempotency Storm: 20 simultaneous requests with identical idempotencyKey write exactly 1 entry", async () => {
      let committedLedger: any[] = [];
      let accountVersion = 0;
      let accountBalance = BigInt(0);

      (prisma.$transaction as any).mockImplementation(async (callback: any) => {
        const txClient: any = {
          weleticPointsLedgerEntry: {
            findUnique: async ({ where }: any) => {
              const key = where?.storeId_idempotencyKey?.idempotencyKey;
              return (
                committedLedger.find((e) => e.idempotencyKey === key) || null
              );
            },
            create: async ({ data }: any) => {
              // Check uniqueness constraint simulation
              if (
                committedLedger.some(
                  (e) => e.idempotencyKey === data.idempotencyKey,
                )
              ) {
                const err = new Prisma.PrismaClientKnownRequestError(
                  "Unique constraint failed",
                  {
                    code: "P2002",
                    clientVersion: "5.0.0",
                  },
                );
                throw err;
              }
              const entry = {
                ...data,
                id: `wledger_idemp_${data.sequenceNumber}`,
              };
              committedLedger.push(entry);
              return entry;
            },
          },
          weleticLoyaltyAccount: {
            findUnique: async () => ({
              id: ACCOUNT_ID,
              storeId: STORE_ID,
              status: "active",
              cachedPointsBalance: accountBalance,
              cachedPendingPoints: BigInt(0),
              lifetimePointsEarned: BigInt(0),
              lifetimePointsRedeemed: BigInt(0),
              ledgerVersion: accountVersion,
            }),
            updateMany: async ({ where, data }: any) => {
              if (where.ledgerVersion === accountVersion) {
                accountVersion = data.ledgerVersion;
                accountBalance = data.cachedPointsBalance;
                return { count: 1 };
              }
              return { count: 0 };
            },
          },
        };

        return await callback(txClient);
      });

      const DUPLICATE_KEY = "storm_duplicate_idemp_key_123";
      const requests = Array.from({ length: 20 }).map(() =>
        appendPointsLedgerEntry({
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(50),
          idempotencyKey: DUPLICATE_KEY,
        }),
      );

      const results = await Promise.all(requests);

      // All 20 returned valid entry with identical ID
      expect(results.length).toBe(20);
      const firstId = results[0].id;
      for (const res of results) {
        expect(res.id).toBe(firstId);
      }

      // Exactly 1 entry in ledger
      expect(committedLedger.length).toBe(1);
      expect(accountVersion).toBe(1);
      expect(accountBalance).toBe(BigInt(50));
    });
  });
});
