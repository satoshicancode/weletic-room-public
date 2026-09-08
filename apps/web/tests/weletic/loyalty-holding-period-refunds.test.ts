import { prisma } from "@/lib/prisma";
import {
  calculateRefundPointsReversal,
  processRefundPointsReversal,
} from "@/lib/weletic/loyalty/earn";
import { releaseHoldingPeriodGrant } from "@/lib/weletic/loyalty/holding-period";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyEarnGrant: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn(),
    },
    weleticLoyaltyOrderLineEarn: {
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
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

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

describe("Milestone 3: Holding Period Lifecycle & Exact Proportional Refunds Test Suite", () => {
  const TEST_STORE_ID = "wstore_m3_test";
  const TEST_ACCOUNT_ID = "wlacc_m3_test";
  const TEST_GRANT_ID = "wgrant_m3_test";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. Pure Calculation Snapshot Refund Reversal Math
  // =========================================================================
  describe("1. Pure Calculation: calculateRefundPointsReversal", () => {
    it("calculates exact proportional clawback for partial refund on multi-line order", () => {
      const originalGrant = {
        id: TEST_GRANT_ID,
        grossPoints: BigInt(100),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(100),
        reversedPoints: BigInt(0),
        eligibleSubtotalAmount: BigInt(10000), // $100.00
        lineEarns: [
          {
            id: "line_earn_1",
            orderLineId: "line_1",
            lineNetAmount: BigInt(6000), // $60.00
            awardedPoints: BigInt(60),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
          {
            id: "line_earn_2",
            orderLineId: "line_2",
            lineNetAmount: BigInt(4000), // $40.00
            awardedPoints: BigInt(40),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };

      // Refund $30.00 on Line 1 (50% of line 1)
      const reversal = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          {
            orderLineId: "line_1",
            cumulativeShopAmount: BigInt(3000),
          },
        ],
      });

      expect(reversal.totalPointsToClawback).toBe(BigInt(30));
      expect(reversal.voidPendingPoints).toBe(BigInt(0));
      expect(reversal.debitSettledPoints).toBe(BigInt(30));
      expect(reversal.isNegativeBalanceAllowed).toBe(true);
      expect(reversal.lineClawbacks).toEqual([
        {
          orderLineId: "line_1",
          lineClawback: BigInt(30),
        },
      ]);
    });

    it("prioritizes voiding pending points when grant is still in pending holding period", () => {
      const originalGrant = {
        id: TEST_GRANT_ID,
        grossPoints: BigInt(100),
        pendingPoints: BigInt(100), // Still pending
        settledPoints: BigInt(0),
        reversedPoints: BigInt(0),
        eligibleSubtotalAmount: BigInt(10000),
        lineEarns: [
          {
            id: "le1",
            orderLineId: "line_1",
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(100),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };

      // 100% refund of pending order
      const reversal = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          {
            orderLineId: "line_1",
            cumulativeShopAmount: BigInt(10000),
          },
        ],
      });

      expect(reversal.totalPointsToClawback).toBe(BigInt(100));
      expect(reversal.voidPendingPoints).toBe(BigInt(100));
      expect(reversal.debitSettledPoints).toBe(BigInt(0)); // Zero debit from available balance!
    });

    it("derives each incremental reversal from the cumulative rounded target", () => {
      const originalGrant = {
        id: TEST_GRANT_ID,
        grossPoints: BigInt(1),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(1),
        reversedPoints: BigInt(0),
        eligibleSubtotalAmount: BigInt(10000),
        lineEarns: [
          {
            id: "le_rounding",
            orderLineId: "line_rounding",
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(1),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };

      const belowThreshold = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          {
            orderLineId: "line_rounding",
            cumulativeShopAmount: BigInt(2000),
          },
        ],
      });
      expect(belowThreshold.totalPointsToClawback).toBe(BigInt(0));

      const cumulativeFullRefund = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          {
            orderLineId: "line_rounding",
            cumulativeShopAmount: BigInt(10000),
          },
        ],
      });
      expect(cumulativeFullRefund.totalPointsToClawback).toBe(BigInt(1));

      originalGrant.reversedPoints = BigInt(1);
      originalGrant.lineEarns[0].reversedPoints = BigInt(1);
      const replay = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          {
            orderLineId: "line_rounding",
            cumulativeShopAmount: BigInt(10000),
          },
          {
            orderLineId: "line_rounding",
            cumulativeShopAmount: BigInt(10000),
          },
        ],
      });
      expect(replay.totalPointsToClawback).toBe(BigInt(0));
      expect(replay.lineClawbacks).toEqual([
        { orderLineId: "line_rounding", lineClawback: BigInt(0) },
      ]);
    });
  });

  // =========================================================================
  // 2. Holding Period Maturity Release
  // =========================================================================
  describe("2. Holding Period Maturity & releaseHoldingPeriodGrant", () => {
    it("releases pending grant to settled, decrements pending bucket, credits balance, and enqueues METAFIELD_SYNC", async () => {
      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce({
        id: TEST_GRANT_ID,
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        orderId: "ord_100",
        status: "pending",
        pendingPoints: BigInt(150),
        grossPoints: BigInt(150),
        reversedPoints: BigInt(0),
        order: {
          externalId: "ext_ord_100",
          orderName: "#1001",
        },
      });

      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        cachedPointsBalance: BigInt(50),
        cachedPendingPoints: BigInt(150),
        lifetimePointsEarned: BigInt(50),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1,
      });

      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValue({
        count: 1,
      });
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        ({ data }: any) => ({
          ...data,
          id: "wledger_new",
        }),
      );
      (prisma.weleticLoyaltyEarnGrant.update as any).mockResolvedValue({});
      (prisma.weleticLoyaltyOutboxJob.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticLoyaltyOutboxJob.create as any).mockResolvedValue({});

      const result = await releaseHoldingPeriodGrant({
        grantId: TEST_GRANT_ID,
      });

      expect(result.released).toBe(true);
      expect(result.points).toBe(BigInt(150));

      // Verify grant update to settled
      expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: TEST_GRANT_ID,
            status: "pending",
            pendingPoints: BigInt(150),
          }),
          data: expect.objectContaining({
            status: "settled",
            settledPoints: BigInt(150),
            pendingPoints: BigInt(0),
          }),
        }),
      );

      // Verify METAFIELD_SYNC job was enqueued
      expect(prisma.weleticLoyaltyOutboxJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            jobType: "METAFIELD_SYNC",
          }),
        }),
      );
    });

    it("voids a refunded grant across line snapshots with deterministic CAS and exact conservation", async () => {
      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce({
        id: TEST_GRANT_ID,
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        orderId: "ord_refunded_before_release",
        status: "partially_reversed",
        grossPoints: BigInt(100),
        pendingPoints: BigInt(70),
        settledPoints: BigInt(0),
        reversedPoints: BigInt(30),
        order: {
          status: "refunded",
          externalId: "ext_ord_refunded_before_release",
          orderName: "#REFUNDED-BEFORE-RELEASE",
        },
        // Intentionally unsorted to prove update lock order is deterministic.
        lineEarns: [
          {
            id: "line_earn_b",
            orderLineId: "line_b",
            storeId: TEST_STORE_ID,
            awardedPoints: BigInt(40),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
          {
            id: "line_earn_a",
            orderLineId: "line_a",
            storeId: TEST_STORE_ID,
            awardedPoints: BigInt(60),
            reversedPoints: BigInt(30),
            isExcluded: false,
          },
        ],
      });
      (prisma.weleticLoyaltyOrderLineEarn.updateMany as any).mockResolvedValue({
        count: 1,
      });
      (prisma.weleticLoyaltyEarnGrant.updateMany as any).mockResolvedValue({
        count: 1,
      });
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValue({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(70),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 0,
      });
      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValue({
        count: 1,
      });
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        ({ data }: any) => ({ ...data, id: "ledger_holding_void" }),
      );
      (prisma.weleticLoyaltyOutboxJob.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticLoyaltyOutboxJob.create as any).mockResolvedValue({});

      const result = await releaseHoldingPeriodGrant({
        grantId: TEST_GRANT_ID,
        storeId: TEST_STORE_ID,
      });

      expect(result).toEqual({
        released: false,
        reason: "order_refunded",
        grantId: TEST_GRANT_ID,
      });
      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).toHaveBeenNthCalledWith(1, {
        where: {
          id: "line_earn_a",
          grantId: TEST_GRANT_ID,
          storeId: TEST_STORE_ID,
          reversedPoints: BigInt(30),
        },
        data: { reversedPoints: BigInt(60) },
      });
      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).toHaveBeenNthCalledWith(2, {
        where: {
          id: "line_earn_b",
          grantId: TEST_GRANT_ID,
          storeId: TEST_STORE_ID,
          reversedPoints: BigInt(0),
        },
        data: { reversedPoints: BigInt(40) },
      });
      expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pendingPoints: BigInt(0),
            reversedPoints: BigInt(100),
            status: "voided",
          }),
        }),
      );
      expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pointsDelta: BigInt(0),
            pendingDelta: BigInt(-70),
          }),
        }),
      );
    });

    it("is strictly idempotent: already settled grants return released: false without double crediting", async () => {
      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce({
        id: TEST_GRANT_ID,
        status: "settled",
        pendingPoints: BigInt(0),
        settledPoints: BigInt(150),
      });

      const result = await releaseHoldingPeriodGrant({
        grantId: TEST_GRANT_ID,
      });

      expect(result.released).toBe(false);
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 3. Refund Idempotency Across Pending and Settled Buckets
  // =========================================================================
  describe("3. Pending Refund Idempotency", () => {
    function mockPendingRefundPersistence({
      refund,
      grant,
      cachedPendingPoints,
    }: {
      refund: Record<string, any>;
      grant: Record<string, any>;
      cachedPendingPoints: bigint;
    }) {
      (prisma.weleticCommerceRefund.findUnique as any)
        .mockReset()
        .mockResolvedValue(refund);
      (prisma.weleticLoyaltyEarnGrant.findUnique as any)
        .mockReset()
        .mockResolvedValue({
          ...grant,
          lineEarns: (grant.lineEarns || []).map((lineEarn: any) => ({
            storeId: TEST_STORE_ID,
            grantId: grant.id,
            ...lineEarn,
          })),
        });
      (prisma.weleticPointsLedgerEntry.findUnique as any)
        .mockReset()
        .mockResolvedValue(null);
      (prisma.weleticPointsLedgerEntry.create as any)
        .mockReset()
        .mockImplementation(async ({ data }: any) => ({
          ...data,
          id: `ledger_${refund.id}`,
        }));
      (prisma.weleticLoyaltyAccount.findUnique as any)
        .mockReset()
        .mockResolvedValue({
          id: TEST_ACCOUNT_ID,
          storeId: TEST_STORE_ID,
          cachedPointsBalance: BigInt(0),
          cachedPendingPoints,
          lifetimePointsEarned: BigInt(0),
          lifetimePointsRedeemed: BigInt(0),
          ledgerVersion: 0,
        });
      (prisma.weleticLoyaltyAccount.updateMany as any)
        .mockReset()
        .mockResolvedValue({ count: 1 });
      (prisma.weleticLoyaltyEarnGrant.updateMany as any)
        .mockReset()
        .mockResolvedValue({ count: 1 });
      (prisma.weleticLoyaltyOrderLineEarn.update as any)
        .mockReset()
        .mockResolvedValue({});
      (prisma.weleticLoyaltyOrderLineEarn.updateMany as any)
        .mockReset()
        .mockResolvedValue({ count: 1 });
      (prisma.weleticLoyaltyOutboxJob.findUnique as any)
        .mockReset()
        .mockResolvedValue(null);
      (prisma.weleticLoyaltyOutboxJob.create as any)
        .mockReset()
        .mockResolvedValue({});
    }

    it("fully reverses a discounted line when Shopify refunds its complete quantity", async () => {
      const orderLineId = "order_line_discounted_full_return";
      const refund = {
        id: "ref_discounted_full_return",
        storeId: TEST_STORE_ID,
        externalId: "ext_ref_discounted_full_return",
        orderId: "ord_discounted_full_return",
        shopAmount: BigInt(5000),
        shopCurrency: "JPY",
        presentmentAmount: BigInt(5000),
        presentmentCurrency: "JPY",
        order: {
          id: "ord_discounted_full_return",
          storeId: TEST_STORE_ID,
          externalId: "ext_ord_discounted_full_return",
          orderName: "#DISCOUNTED-FULL-RETURN",
          refunds: [
            {
              shopAmount: BigInt(5000),
              lines: [
                {
                  orderLineId,
                  shopAmount: BigInt(5000),
                  quantity: 2,
                },
              ],
            },
          ],
          shopper: {
            id: "shop_discounted_full_return",
            storeId: TEST_STORE_ID,
            loyaltyAccount: {
              id: TEST_ACCOUNT_ID,
              storeId: TEST_STORE_ID,
            },
          },
        },
        lines: [
          {
            id: "refund_line_discounted_full_return",
            orderLineId,
            shopAmount: BigInt(5000),
            quantity: 2,
          },
        ],
      };
      const grant = {
        id: TEST_GRANT_ID,
        storeId: TEST_STORE_ID,
        grossPoints: BigInt(10000),
        pendingPoints: BigInt(10000),
        settledPoints: BigInt(0),
        reversedPoints: BigInt(0),
        status: "pending",
        eligibleSubtotalAmount: BigInt(10000),
        orderTotalAmount: BigInt(5870),
        voidedAt: null,
        lineEarns: [
          {
            id: "line_earn_discounted_full_return",
            orderLineId,
            quantity: 2,
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(10000),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };
      mockPendingRefundPersistence({
        refund,
        grant,
        cachedPendingPoints: BigInt(10000),
      });

      const result = await processRefundPointsReversal({
        storeId: TEST_STORE_ID,
        refundId: refund.id,
      });

      expect(result?.pendingDelta).toBe(BigInt(-10000));
      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: "line_earn_discounted_full_return",
          grantId: TEST_GRANT_ID,
          storeId: TEST_STORE_ID,
          reversedPoints: BigInt(0),
        },
        data: { reversedPoints: BigInt(10000) },
      });
      expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pendingPoints: BigInt(0),
            reversedPoints: BigInt(10000),
            status: "voided",
          }),
        }),
      );
    });

    it("applies one maintenance correction for a historical discounted under-clawback", async () => {
      const orderLineId = "order_line_discounted_correction";
      const refundId = "ref_discounted_correction";
      const refund = {
        id: refundId,
        storeId: TEST_STORE_ID,
        externalId: "ext_ref_discounted_correction",
        orderId: "ord_discounted_correction",
        shopAmount: BigInt(5000),
        shopCurrency: "JPY",
        presentmentAmount: BigInt(5000),
        presentmentCurrency: "JPY",
        order: {
          id: "ord_discounted_correction",
          storeId: TEST_STORE_ID,
          externalId: "ext_ord_discounted_correction",
          orderName: "#DISCOUNTED-CORRECTION",
          refunds: [
            {
              shopAmount: BigInt(5000),
              lines: [
                {
                  orderLineId,
                  shopAmount: BigInt(5000),
                  quantity: 2,
                },
              ],
            },
          ],
          shopper: {
            id: "shop_discounted_correction",
            storeId: TEST_STORE_ID,
            loyaltyAccount: {
              id: TEST_ACCOUNT_ID,
              storeId: TEST_STORE_ID,
            },
          },
        },
        lines: [
          {
            id: "refund_line_discounted_correction",
            orderLineId,
            shopAmount: BigInt(5000),
            quantity: 2,
          },
        ],
      };
      const grant = {
        id: TEST_GRANT_ID,
        storeId: TEST_STORE_ID,
        grossPoints: BigInt(10000),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(5000),
        reversedPoints: BigInt(5000),
        status: "partially_reversed",
        eligibleSubtotalAmount: BigInt(10000),
        orderTotalAmount: BigInt(5870),
        voidedAt: null,
        lineEarns: [
          {
            id: "line_earn_discounted_correction",
            orderLineId,
            quantity: 2,
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(10000),
            reversedPoints: BigInt(5000),
            isExcluded: false,
          },
        ],
      };
      mockPendingRefundPersistence({
        refund,
        grant,
        cachedPendingPoints: BigInt(0),
      });
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValue({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        cachedPointsBalance: BigInt(5000),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(10000),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 2,
      });
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockImplementation(
        async ({ where }: any) =>
          where.storeId_idempotencyKey.idempotencyKey ===
          `refund_reversal:${refundId}`
            ? { id: "ledger_original_under_clawback" }
            : null,
      );

      const result = await processRefundPointsReversal({
        storeId: TEST_STORE_ID,
        refundId,
        allowSupplementalCorrection: true,
      });

      expect(result?.pointsDelta).toBe(BigInt(-5000));
      expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            idempotencyKey: `refund_reversal:${refundId}:correction:10000`,
            pointsDelta: BigInt(-5000),
          }),
        }),
      );
      expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            settledPoints: BigInt(0),
            reversedPoints: BigInt(10000),
            status: "reversed",
          }),
        }),
      );
      expect(prisma.weleticLoyaltyOutboxJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            idempotencyKey: `metafield_sync:refund:${refundId}:correction:10000`,
          }),
        }),
      );
    });

    it("uses the cumulative refunded amount so split sub-point refunds reach the exact target", async () => {
      const orderLineId = "order_line_split_rounding";
      const persistedRefunds = [20, 20, 20, 40].map((percentage) => ({
        shopAmount: BigInt(percentage * 100),
        lines: [
          {
            orderLineId,
            shopAmount: BigInt(percentage * 100),
          },
        ],
      }));
      const refund = {
        id: "ref_split_rounding_final",
        storeId: TEST_STORE_ID,
        externalId: "ext_ref_split_rounding_final",
        orderId: "ord_split_rounding",
        shopAmount: BigInt(4000),
        order: {
          id: "ord_split_rounding",
          storeId: TEST_STORE_ID,
          externalId: "ext_ord_split_rounding",
          orderName: "#SPLIT-ROUNDING",
          refunds: persistedRefunds,
          shopper: {
            id: "shop_split_rounding",
            storeId: TEST_STORE_ID,
            loyaltyAccount: {
              id: TEST_ACCOUNT_ID,
              storeId: TEST_STORE_ID,
            },
          },
        },
        lines: [
          {
            id: "refund_line_split_rounding_final",
            orderLineId,
            shopAmount: BigInt(4000),
          },
        ],
      };
      const grant = {
        id: TEST_GRANT_ID,
        storeId: TEST_STORE_ID,
        grossPoints: BigInt(1),
        pendingPoints: BigInt(1),
        settledPoints: BigInt(0),
        reversedPoints: BigInt(0),
        status: "pending",
        eligibleSubtotalAmount: BigInt(10000),
        orderTotalAmount: BigInt(10000),
        voidedAt: null,
        lineEarns: [
          {
            id: "line_earn_split_rounding",
            orderLineId,
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(1),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };
      mockPendingRefundPersistence({
        refund,
        grant,
        cachedPendingPoints: BigInt(1),
      });

      const result = await processRefundPointsReversal({
        storeId: TEST_STORE_ID,
        refundId: refund.id,
      });

      expect(prisma.weleticCommerceRefund.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: refund.id },
          include: expect.objectContaining({
            order: expect.objectContaining({
              include: expect.objectContaining({
                refunds: expect.objectContaining({
                  where: { storeId: TEST_STORE_ID },
                }),
              }),
            }),
          }),
        }),
      );
      expect(result?.pendingDelta).toBe(BigInt(-1));
      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: "line_earn_split_rounding",
          grantId: TEST_GRANT_ID,
          storeId: TEST_STORE_ID,
          reversedPoints: BigInt(0),
        },
        data: { reversedPoints: BigInt(1) },
      });
      expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pendingPoints: BigInt(0),
            reversedPoints: BigInt(1),
            status: "voided",
          }),
        }),
      );
    });

    it("attributes an order-level adjustment before a later holding void without source divergence", async () => {
      const refund = {
        id: "ref_order_adjustment",
        storeId: TEST_STORE_ID,
        externalId: "ext_ref_order_adjustment",
        orderId: "ord_order_adjustment",
        shopAmount: BigInt(3000),
        order: {
          id: "ord_order_adjustment",
          storeId: TEST_STORE_ID,
          externalId: "ext_ord_order_adjustment",
          orderName: "#ORDER-ADJUSTMENT",
          status: "refunded",
          refunds: [{ shopAmount: BigInt(3000), lines: [] }],
          shopper: {
            id: "shop_order_adjustment",
            storeId: TEST_STORE_ID,
            loyaltyAccount: {
              id: TEST_ACCOUNT_ID,
              storeId: TEST_STORE_ID,
            },
          },
        },
        lines: [],
      };
      const lineEarns = [
        {
          id: "line_earn_adjustment_a",
          orderLineId: "line_adjustment_a",
          storeId: TEST_STORE_ID,
          lineNetAmount: BigInt(6000),
          awardedPoints: BigInt(60),
          reversedPoints: BigInt(0),
          isExcluded: false,
        },
        {
          id: "line_earn_adjustment_b",
          orderLineId: "line_adjustment_b",
          storeId: TEST_STORE_ID,
          lineNetAmount: BigInt(4000),
          awardedPoints: BigInt(40),
          reversedPoints: BigInt(0),
          isExcluded: false,
        },
      ];
      const grant = {
        id: TEST_GRANT_ID,
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        orderId: refund.orderId,
        grossPoints: BigInt(100),
        pendingPoints: BigInt(100),
        settledPoints: BigInt(0),
        reversedPoints: BigInt(0),
        status: "pending",
        eligibleSubtotalAmount: BigInt(10000),
        orderTotalAmount: BigInt(10000),
        voidedAt: null,
        lineEarns,
      };
      mockPendingRefundPersistence({
        refund,
        grant,
        cachedPendingPoints: BigInt(100),
      });

      const adjustmentResult = await processRefundPointsReversal({
        storeId: TEST_STORE_ID,
        refundId: refund.id,
      });

      expect(adjustmentResult?.pendingDelta).toBe(BigInt(-30));
      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).toHaveBeenNthCalledWith(1, {
        where: {
          id: "line_earn_adjustment_a",
          grantId: TEST_GRANT_ID,
          storeId: TEST_STORE_ID,
          reversedPoints: BigInt(0),
        },
        data: { reversedPoints: BigInt(18) },
      });
      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).toHaveBeenNthCalledWith(2, {
        where: {
          id: "line_earn_adjustment_b",
          grantId: TEST_GRANT_ID,
          storeId: TEST_STORE_ID,
          reversedPoints: BigInt(0),
        },
        data: { reversedPoints: BigInt(12) },
      });

      (prisma.weleticLoyaltyEarnGrant.findUnique as any)
        .mockReset()
        .mockResolvedValue({
          ...grant,
          status: "partially_reversed",
          pendingPoints: BigInt(70),
          reversedPoints: BigInt(30),
          lineEarns: [
            { ...lineEarns[0], reversedPoints: BigInt(18) },
            { ...lineEarns[1], reversedPoints: BigInt(12) },
          ],
          order: refund.order,
        });
      (prisma.weleticLoyaltyOrderLineEarn.updateMany as any)
        .mockReset()
        .mockResolvedValue({ count: 1 });
      (prisma.weleticLoyaltyEarnGrant.updateMany as any)
        .mockReset()
        .mockResolvedValue({ count: 1 });
      (prisma.weleticPointsLedgerEntry.findUnique as any)
        .mockReset()
        .mockResolvedValue(null);
      (prisma.weleticPointsLedgerEntry.create as any)
        .mockReset()
        .mockImplementation(({ data }: any) => ({
          ...data,
          id: "ledger_holding_void_after_adjustment",
        }));
      (prisma.weleticLoyaltyAccount.findUnique as any)
        .mockReset()
        .mockResolvedValue({
          id: TEST_ACCOUNT_ID,
          storeId: TEST_STORE_ID,
          cachedPointsBalance: BigInt(0),
          cachedPendingPoints: BigInt(70),
          lifetimePointsEarned: BigInt(0),
          lifetimePointsRedeemed: BigInt(0),
          ledgerVersion: 1,
        });
      (prisma.weleticLoyaltyAccount.updateMany as any)
        .mockReset()
        .mockResolvedValue({ count: 1 });

      await expect(
        releaseHoldingPeriodGrant({
          grantId: TEST_GRANT_ID,
          storeId: TEST_STORE_ID,
        }),
      ).resolves.toEqual({
        released: false,
        reason: "order_refunded",
        grantId: TEST_GRANT_ID,
      });

      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).toHaveBeenNthCalledWith(1, {
        where: {
          id: "line_earn_adjustment_a",
          grantId: TEST_GRANT_ID,
          storeId: TEST_STORE_ID,
          reversedPoints: BigInt(18),
        },
        data: { reversedPoints: BigInt(60) },
      });
      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).toHaveBeenNthCalledWith(2, {
        where: {
          id: "line_earn_adjustment_b",
          grantId: TEST_GRANT_ID,
          storeId: TEST_STORE_ID,
          reversedPoints: BigInt(12),
        },
        data: { reversedPoints: BigInt(40) },
      });
      expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pendingPoints: BigInt(0),
            reversedPoints: BigInt(100),
            status: "voided",
          }),
        }),
      );
    });

    it("does not double-claw a pre-ledger pending refund replay", async () => {
      const orderLineId = "order_line_pre_ledger_replay";
      const refund = {
        id: "ref_pre_ledger_replay",
        storeId: TEST_STORE_ID,
        externalId: "ext_ref_pre_ledger_replay",
        orderId: "ord_pre_ledger_replay",
        shopAmount: BigInt(3000),
        order: {
          id: "ord_pre_ledger_replay",
          storeId: TEST_STORE_ID,
          externalId: "ext_ord_pre_ledger_replay",
          orderName: "#PRE-LEDGER",
          refunds: [
            {
              shopAmount: BigInt(3000),
              lines: [{ orderLineId, shopAmount: BigInt(3000) }],
            },
          ],
          shopper: {
            id: "shop_pre_ledger_replay",
            storeId: TEST_STORE_ID,
            loyaltyAccount: {
              id: TEST_ACCOUNT_ID,
              storeId: TEST_STORE_ID,
            },
          },
        },
        lines: [
          {
            id: "refund_line_pre_ledger_replay",
            orderLineId,
            shopAmount: BigInt(3000),
          },
        ],
      };
      const grant = {
        id: TEST_GRANT_ID,
        storeId: TEST_STORE_ID,
        grossPoints: BigInt(100),
        pendingPoints: BigInt(70),
        settledPoints: BigInt(0),
        reversedPoints: BigInt(30),
        status: "partially_reversed",
        eligibleSubtotalAmount: BigInt(10000),
        orderTotalAmount: BigInt(10000),
        voidedAt: null,
        lineEarns: [
          {
            id: "line_earn_pre_ledger_replay",
            orderLineId,
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(100),
            reversedPoints: BigInt(30),
            isExcluded: false,
          },
        ],
      };
      mockPendingRefundPersistence({
        refund,
        grant,
        cachedPendingPoints: BigInt(70),
      });

      await expect(
        processRefundPointsReversal({
          storeId: TEST_STORE_ID,
          refundId: refund.id,
        }),
      ).resolves.toBeNull();

      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyEarnGrant.updateMany).not.toHaveBeenCalled();
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
    });

    it("groups duplicate refund rows before mutating a line allocation", async () => {
      const orderLineId = "order_line_duplicate_rows";
      const duplicateRows = ["a", "b"].map((suffix) => ({
        id: `refund_line_duplicate_${suffix}`,
        orderLineId,
        shopAmount: BigInt(10000),
      }));
      const refund = {
        id: "ref_duplicate_rows",
        storeId: TEST_STORE_ID,
        externalId: "ext_ref_duplicate_rows",
        orderId: "ord_duplicate_rows",
        shopAmount: BigInt(20000),
        order: {
          id: "ord_duplicate_rows",
          storeId: TEST_STORE_ID,
          externalId: "ext_ord_duplicate_rows",
          orderName: "#DUPLICATE-ROWS",
          refunds: [
            {
              shopAmount: BigInt(20000),
              lines: duplicateRows,
            },
          ],
          shopper: {
            id: "shop_duplicate_rows",
            storeId: TEST_STORE_ID,
            loyaltyAccount: {
              id: TEST_ACCOUNT_ID,
              storeId: TEST_STORE_ID,
            },
          },
        },
        lines: duplicateRows,
      };
      const grant = {
        id: TEST_GRANT_ID,
        storeId: TEST_STORE_ID,
        grossPoints: BigInt(100),
        pendingPoints: BigInt(100),
        settledPoints: BigInt(0),
        reversedPoints: BigInt(0),
        status: "pending",
        eligibleSubtotalAmount: BigInt(20000),
        orderTotalAmount: BigInt(20000),
        voidedAt: null,
        lineEarns: [
          {
            id: "line_earn_duplicate_rows",
            orderLineId,
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(50),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
          {
            id: "line_earn_unrelated",
            orderLineId: "order_line_unrelated",
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(50),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };
      mockPendingRefundPersistence({
        refund,
        grant,
        cachedPendingPoints: BigInt(100),
      });

      const result = await processRefundPointsReversal({
        storeId: TEST_STORE_ID,
        refundId: refund.id,
      });

      expect(result?.pendingDelta).toBe(BigInt(-50));
      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).toHaveBeenCalledTimes(1);
      expect(
        prisma.weleticLoyaltyOrderLineEarn.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: "line_earn_duplicate_rows",
          grantId: TEST_GRANT_ID,
          storeId: TEST_STORE_ID,
          reversedPoints: BigInt(0),
        },
        data: { reversedPoints: BigInt(50) },
      });
    });

    it.each([
      {
        refundAmount: BigInt(3000),
        expectedVoided: BigInt(30),
        status: "partially_reversed",
      },
      {
        refundAmount: BigInt(10000),
        expectedVoided: BigInt(100),
        status: "voided",
      },
    ])(
      "applies a duplicate pending-only refund exactly once ($status)",
      async ({ refundAmount, expectedVoided, status }) => {
        const refundId = `ref_pending_${expectedVoided}`;
        const refund = {
          id: refundId,
          storeId: TEST_STORE_ID,
          externalId: `ext_${refundId}`,
          orderId: "ord_pending_1",
          shopAmount: refundAmount,
          shopCurrency: "USD",
          presentmentAmount: refundAmount,
          presentmentCurrency: "USD",
          order: {
            id: "ord_pending_1",
            storeId: TEST_STORE_ID,
            externalId: "ext_ord_pending_1",
            orderName: "#PENDING-1",
            shopper: {
              id: "shop_pending_1",
              storeId: TEST_STORE_ID,
              loyaltyAccount: {
                id: TEST_ACCOUNT_ID,
                storeId: TEST_STORE_ID,
              },
            },
          },
          lines: [
            {
              id: `line_${refundId}`,
              orderLineId: "order_line_pending_1",
              shopAmount: refundAmount,
            },
          ],
        };
        const grant = {
          id: TEST_GRANT_ID,
          storeId: TEST_STORE_ID,
          grossPoints: BigInt(100),
          pendingPoints: BigInt(100),
          settledPoints: BigInt(0),
          reversedPoints: BigInt(0),
          status: "pending",
          eligibleSubtotalAmount: BigInt(10000),
          orderTotalAmount: BigInt(10000),
          voidedAt: null,
          lineEarns: [
            {
              id: "line_earn_pending_1",
              grantId: TEST_GRANT_ID,
              storeId: TEST_STORE_ID,
              orderLineId: "order_line_pending_1",
              lineNetAmount: BigInt(10000),
              awardedPoints: BigInt(100),
              reversedPoints: BigInt(0),
              isExcluded: false,
            },
          ],
        };

        let createdLedger: any = null;
        (prisma.weleticCommerceRefund.findUnique as any)
          .mockReset()
          .mockResolvedValue(refund);
        (prisma.weleticLoyaltyEarnGrant.findUnique as any)
          .mockReset()
          .mockResolvedValue(grant);
        (prisma.weleticPointsLedgerEntry.findUnique as any)
          .mockReset()
          .mockImplementation(async () => createdLedger);
        (prisma.weleticPointsLedgerEntry.create as any)
          .mockReset()
          .mockImplementation(async ({ data }: any) => {
            createdLedger = { ...data, id: `ledger_${refundId}` };
            return createdLedger;
          });
        (prisma.weleticLoyaltyAccount.findUnique as any)
          .mockReset()
          .mockResolvedValue({
            id: TEST_ACCOUNT_ID,
            storeId: TEST_STORE_ID,
            cachedPointsBalance: BigInt(0),
            cachedPendingPoints: BigInt(100),
            lifetimePointsEarned: BigInt(0),
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: 0,
          });
        (prisma.weleticLoyaltyAccount.updateMany as any)
          .mockReset()
          .mockResolvedValue({ count: 1 });
        (prisma.weleticLoyaltyEarnGrant.updateMany as any)
          .mockReset()
          .mockResolvedValue({ count: 1 });
        (prisma.weleticLoyaltyOrderLineEarn.updateMany as any)
          .mockReset()
          .mockResolvedValue({ count: 1 });
        (prisma.weleticLoyaltyOutboxJob.findUnique as any)
          .mockReset()
          .mockResolvedValue(null);
        (prisma.weleticLoyaltyOutboxJob.create as any)
          .mockReset()
          .mockResolvedValue({});

        const first = await processRefundPointsReversal({
          storeId: TEST_STORE_ID,
          refundId,
        });
        const replay = await processRefundPointsReversal({
          storeId: TEST_STORE_ID,
          refundId,
        });

        expect(first?.id).toBe(`ledger_${refundId}`);
        expect(replay?.id).toBe(first?.id);
        expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledTimes(1);
        expect(
          prisma.weleticLoyaltyOrderLineEarn.updateMany,
        ).toHaveBeenCalledTimes(1);
        expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledTimes(
          1,
        );
        expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledTimes(
          1,
        );
        expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              pointsDelta: BigInt(0),
              pendingDelta: -expectedVoided,
              idempotencyKey: `refund_reversal:${refundId}`,
            }),
          }),
        );
        expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              pendingPoints: BigInt(100) - expectedVoided,
              reversedPoints: expectedVoided,
              status,
            }),
          }),
        );
      },
    );
  });

  // =========================================================================
  // 4. Late Refund Clawbacks & Uncapped Negative Balances
  // =========================================================================
  describe("4. Late Refund Clawbacks & Uncapped Negative Debt (ADR 0004)", () => {
    it("permits available points balance to go negative when customer already redeemed points", async () => {
      // Customer earned 100 points, settled. Redeemed 100 points for voucher (balance = 0).
      // Order is now refunded $100.00. Clawback = 100 points. Resulting balance = -100 points.
      (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce({
        id: "ref_late_1",
        storeId: TEST_STORE_ID,
        externalId: "ext_ref_late_1",
        orderId: "ord_100",
        shopAmount: BigInt(10000),
        shopCurrency: "USD",
        presentmentAmount: BigInt(10000),
        presentmentCurrency: "USD",
        order: {
          id: "ord_100",
          storeId: TEST_STORE_ID,
          externalId: "ext_ord_100",
          orderName: "#1001",
          shopper: {
            id: "shop_1",
            storeId: TEST_STORE_ID,
            loyaltyAccount: {
              id: TEST_ACCOUNT_ID,
              storeId: TEST_STORE_ID,
              cachedPointsBalance: BigInt(0), // Zero available balance
              cachedPendingPoints: BigInt(0),
              lifetimePointsEarned: BigInt(100),
              lifetimePointsRedeemed: BigInt(100),
              ledgerVersion: 3,
            },
          },
        },
        lines: [
          {
            id: "ref_line_1",
            orderLineId: "order_line_1",
            shopAmount: BigInt(10000),
          },
        ],
      });

      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce({
        id: TEST_GRANT_ID,
        grossPoints: BigInt(100),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(100),
        reversedPoints: BigInt(0),
        status: "settled",
        eligibleSubtotalAmount: BigInt(10000),
        orderTotalAmount: BigInt(10000),
        lineEarns: [
          {
            id: "le_1",
            grantId: TEST_GRANT_ID,
            storeId: TEST_STORE_ID,
            orderLineId: "order_line_1",
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(100),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      });

      (prisma.weleticLoyaltyOrderLineEarn.updateMany as any).mockResolvedValue({
        count: 1,
      });
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValue({
        id: TEST_ACCOUNT_ID,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(100),
        ledgerVersion: 3,
      });
      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValue({
        count: 1,
      });
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        ({ data }: any) => ({
          ...data,
          id: "wledger_refund_rev",
        }),
      );
      (prisma.weleticLoyaltyEarnGrant.update as any).mockResolvedValue({});
      (prisma.weleticLoyaltyOutboxJob.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticLoyaltyOutboxJob.create as any).mockResolvedValue({});

      const reversalEntry = await processRefundPointsReversal({
        storeId: TEST_STORE_ID,
        refundId: "ref_late_1",
      });

      expect(reversalEntry).not.toBeNull();
      expect(reversalEntry?.pointsDelta).toBe(BigInt(-100));
      expect(reversalEntry?.balanceAfter).toBe(BigInt(-100)); // Negative balance debt permitted per ADR 0004!

      // Verify grant status transition to reversed
      expect(prisma.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: TEST_GRANT_ID }),
          data: expect.objectContaining({
            status: "reversed",
            reversedPoints: BigInt(100),
            settledPoints: BigInt(0),
          }),
        }),
      );
    });

    it("records a privacy-safe refund adjustment after customer redaction", async () => {
      const refundId = "ref_after_customer_redaction";
      const tombstone = {
        shopifyCustomerRedaction: {
          status: "redacted",
          redactedAt: "2026-08-29T00:00:00.000Z",
          source: "shopify_customers_redact",
        },
      };

      (prisma.weleticCommerceRefund.findUnique as any).mockResolvedValueOnce({
        id: refundId,
        storeId: TEST_STORE_ID,
        externalId: "gid://shopify/Refund/private-refund",
        orderId: "ord_private_redacted",
        shopAmount: BigInt(10000),
        shopCurrency: "USD",
        presentmentAmount: BigInt(10000),
        presentmentCurrency: "USD",
        order: {
          id: "ord_private_redacted",
          storeId: TEST_STORE_ID,
          externalId: "gid://shopify/Order/private-order",
          orderName: "#PRIVATE",
          shopper: {
            id: "shopper_redacted",
            storeId: TEST_STORE_ID,
            loyaltyAccount: {
              id: TEST_ACCOUNT_ID,
              storeId: TEST_STORE_ID,
              metadata: tombstone,
              cachedPointsBalance: BigInt(100),
              cachedPendingPoints: BigInt(0),
              lifetimePointsEarned: BigInt(100),
              lifetimePointsRedeemed: BigInt(0),
              ledgerVersion: 4,
            },
          },
        },
        lines: [
          {
            id: "refund_line_private",
            orderLineId: "order_line_private",
            shopAmount: BigInt(10000),
          },
        ],
      });
      (prisma.weleticLoyaltyEarnGrant.findUnique as any).mockResolvedValueOnce({
        id: TEST_GRANT_ID,
        grossPoints: BigInt(100),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(100),
        reversedPoints: BigInt(0),
        status: "settled",
        eligibleSubtotalAmount: BigInt(10000),
        orderTotalAmount: BigInt(10000),
        lineEarns: [
          {
            id: "line_earn_private",
            grantId: TEST_GRANT_ID,
            storeId: TEST_STORE_ID,
            orderLineId: "order_line_private",
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(100),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      });
      (prisma.weleticLoyaltyOrderLineEarn.updateMany as any).mockResolvedValue({
        count: 1,
      });
      (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValue({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        metadata: tombstone,
        cachedPointsBalance: BigInt(100),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 4,
      });
      (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValue({
        count: 1,
      });
      (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue(
        null,
      );
      (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
        ({ data }: any) => ({ ...data, id: "wledger_private_refund" }),
      );
      (prisma.weleticLoyaltyEarnGrant.updateMany as any).mockResolvedValue({
        count: 1,
      });

      await processRefundPointsReversal({
        storeId: TEST_STORE_ID,
        refundId,
      });

      expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          reason: "Refund points adjustment after customer redaction.",
          metadata: {
            privacyRedacted: true,
            totalClawback: "100",
            settledClawback: "100",
            pendingVoided: "0",
          },
        }),
      });
      const ledgerData = (prisma.weleticPointsLedgerEntry.create as any).mock
        .calls[0]?.[0]?.data;
      expect(ledgerData.metadata).not.toHaveProperty("refundId");
      expect(ledgerData.metadata).not.toHaveProperty("orderId");
      expect(ledgerData.metadata).not.toHaveProperty("grantId");
      expect(prisma.weleticLoyaltyOutboxJob.create).not.toHaveBeenCalled();
    });
  });
});
