import {
  allocatePointsAcrossOrderLines,
  calculateEligibleOrderPoints,
  calculateRefundPointsReversal,
  multiplyFractions,
  parseDecimalToFraction,
  powerOfTenBigInt,
} from "@/lib/weletic/loyalty/earn";
import { releaseHoldingPeriodGrant } from "@/lib/weletic/loyalty/holding-period";
import {
  appendPointsLedgerEntry,
  OptimisticConcurrencyError,
} from "@/lib/weletic/loyalty/ledger";
import { calculateExponentialBackoff } from "@/lib/weletic/loyalty/outbox-worker";
import { serializeLoyaltyData } from "@/lib/weletic/loyalty/serialization";
import {
  currencyMinorUnits,
  decimalToMinorUnits,
  minorUnitsToDecimal,
} from "@/lib/weletic/money";
import { Prisma, WeleticPointsLedgerEntryType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/weletic/loyalty/points-communication-producer", () => ({
  enqueuePurchasePointsCommunication: vi.fn().mockResolvedValue(null),
}));

describe("Challenger 1 Final Milestone: Financial Ledger, Arithmetic & Concurrency Adversarial Suite", () => {
  // ==========================================================================
  // SCOPE 1: BigInt Rational Arithmetic & Zero-Decimal Currencies
  // ==========================================================================
  describe("Scope 1: BigInt Rational Arithmetic & Multi-Currency Decimal Precision", () => {
    it("1.1 parses diverse decimal representations into exact BigInt fractions without float drift", () => {
      // Standard decimal
      const f1 = parseDecimalToFraction("12.345");
      expect(f1).toEqual({ num: BigInt(12345), den: BigInt(1000) });

      // Integer string
      const f2 = parseDecimalToFraction("500");
      expect(f2).toEqual({ num: BigInt(500), den: BigInt(1) });

      // Negative decimal
      const f3 = parseDecimalToFraction("-0.75");
      expect(f3).toEqual({ num: BigInt(-75), den: BigInt(100) });

      // BigInt input
      const f4 = parseDecimalToFraction(BigInt(999999));
      expect(f4).toEqual({ num: BigInt(999999), den: BigInt(1) });

      // Extreme precision (18 decimal places)
      const f5 = parseDecimalToFraction("0.000000000000000001");
      expect(f5.den).toEqual(powerOfTenBigInt(18));
      expect(f5.num).toEqual(BigInt(1));

      // Null / undefined fallback
      expect(parseDecimalToFraction(null)).toEqual({
        num: BigInt(1),
        den: BigInt(1),
      });
      expect(parseDecimalToFraction(undefined)).toEqual({
        num: BigInt(1),
        den: BigInt(1),
      });
    });

    it("1.2 multiplies multiple rational fractions with exact integer precision", () => {
      // 1.25 * 1.50 * 2.0 = 3.75
      const fractions = [
        parseDecimalToFraction("1.25"), // 125 / 100
        parseDecimalToFraction("1.50"), // 150 / 100
        parseDecimalToFraction("2.0"), // 20 / 10
      ];

      const combined = multiplyFractions(fractions);
      // 125 * 150 * 20 = 375,000
      // 100 * 100 * 10 = 100,000
      expect(combined.num).toEqual(BigInt(375000));
      expect(combined.den).toEqual(BigInt(100000));
      expect(Number(combined.num) / Number(combined.den)).toEqual(3.75);
    });

    it("1.3 handles zero-decimal currencies (JPY, VND) with minorUnit = 0", () => {
      expect(currencyMinorUnits("JPY")).toBe(0);
      expect(currencyMinorUnits("VND")).toBe(0);
      expect(currencyMinorUnits("jpy")).toBe(0);

      // Conversions for JPY (no cents)
      const jpyMinor = decimalToMinorUnits("5000", "JPY");
      expect(jpyMinor).toBe(BigInt(5000));
      expect(minorUnitsToDecimal(BigInt(5000), "JPY")).toBe("5000");

      // Points calculation: 10,000 JPY @ 1 pt/JPY = 10,000 points
      const pointsJPY = calculateEligibleOrderPoints({
        netAmountCents: BigInt(10000),
        currency: "JPY",
        pointsPerCurrencyUnit: 1.0,
        multiplier: 1.0,
      });
      expect(pointsJPY).toBe(BigInt(10000));

      // Points calculation with compound multipliers: 10,000 JPY * 1.25x * 1.5x = 18,750 points
      const combinedMultiplier =
        Number(
          multiplyFractions([
            parseDecimalToFraction("1.25"),
            parseDecimalToFraction("1.5"),
          ]).num,
        ) /
        Number(
          multiplyFractions([
            parseDecimalToFraction("1.25"),
            parseDecimalToFraction("1.5"),
          ]).den,
        );

      const pointsJPYMultiplied = calculateEligibleOrderPoints({
        netAmountCents: BigInt(10000),
        currency: "JPY",
        pointsPerCurrencyUnit: 1.0,
        multiplier: "1.875",
      });
      expect(pointsJPYMultiplied).toBe(BigInt(18750));
    });

    it("1.4 handles standard decimal currencies (USD, EUR, GBP) with minorUnit = 2", () => {
      expect(currencyMinorUnits("USD")).toBe(2);
      expect(currencyMinorUnits("EUR")).toBe(2);
      expect(currencyMinorUnits("GBP")).toBe(2);

      // $49.99 = 4999 cents
      const usdMinor = decimalToMinorUnits("49.99", "USD");
      expect(usdMinor).toBe(BigInt(4999));
      expect(minorUnitsToDecimal(BigInt(4999), "USD")).toBe("49.99");

      // Points calculation: $50.00 (5000 cents) @ 1 pt/$ = 50 points
      const pointsUSD = calculateEligibleOrderPoints({
        netAmountCents: BigInt(5000),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        multiplier: 1.0,
      });
      expect(pointsUSD).toBe(BigInt(50));

      // Fractional points floor: $49.99 (4999 cents) @ 1 pt/$ = 49 points
      const pointsUSDFloor = calculateEligibleOrderPoints({
        netAmountCents: BigInt(4999),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        multiplier: 1.0,
      });
      expect(pointsUSDFloor).toBe(BigInt(49));
    });

    it("1.5 handles extreme financial quantities (100 Trillion JPY / $1 Billion USD) without integer overflow", () => {
      // 100 Trillion JPY = 100,000,000,000,000
      const hundredTrillion = BigInt("100000000000000");
      const extremePoints = calculateEligibleOrderPoints({
        netAmountCents: hundredTrillion,
        currency: "JPY",
        pointsPerCurrencyUnit: "1.5",
        multiplier: "2.0",
      });
      // 100T * 1.5 * 2.0 = 300 Trillion points
      expect(extremePoints).toBe(BigInt("300000000000000"));

      // Minimum order threshold boundary
      const belowMin = calculateEligibleOrderPoints({
        netAmountCents: BigInt(4999),
        currency: "USD",
        minOrderSubtotalCents: BigInt(5000),
      });
      expect(belowMin).toBe(BigInt(0));

      const meetMin = calculateEligibleOrderPoints({
        netAmountCents: BigInt(5000),
        currency: "USD",
        minOrderSubtotalCents: BigInt(5000),
      });
      expect(meetMin).toBe(BigInt(50));
    });

    it("1.6 serializes BigInt, Decimals, Dates, and nested structures into clean JSON primitives", () => {
      const data = {
        accountId: "wacc_123",
        cachedBalance: BigInt(50000),
        pendingBalance: BigInt(0),
        rate: new Prisma.Decimal("1.25"),
        createdAt: new Date("2026-08-26T12:00:00Z"),
        items: [
          { lineId: "line_1", points: BigInt(250) },
          { lineId: "line_2", points: BigInt(750) },
        ],
      };

      const serialized = serializeLoyaltyData(data);
      expect(serialized.cachedBalance).toBe("50000");
      expect(serialized.pendingBalance).toBe("0");
      expect(serialized.rate).toBe("1.25");
      expect(serialized.createdAt).toBe("2026-08-26T12:00:00.000Z");
      expect(serialized.items[0].points).toBe("250");
      expect(serialized.items[1].points).toBe("750");
    });
  });

  // ==========================================================================
  // SCOPE 2: Deterministic Hare-Niemeyer Largest-Remainder Allocation
  // ==========================================================================
  describe("Scope 2: Deterministic Hare-Niemeyer Largest-Remainder Allocation", () => {
    it("2.1 guarantees exact penny-conservation: sum(awardedPoints) === grossPoints across odd divisions", () => {
      // 100 points across 3 lines with equal net amount ($33.33 each, total $99.99)
      const lines = [
        { orderLineId: "line_a", lineNetAmount: BigInt(3333) },
        { orderLineId: "line_b", lineNetAmount: BigInt(3333) },
        { orderLineId: "line_c", lineNetAmount: BigInt(3333) },
      ];

      const grossPoints = BigInt(100);
      const allocated = allocatePointsAcrossOrderLines({ grossPoints, lines });

      const sum = allocated.reduce(
        (acc, l) => acc + l.awardedPoints,
        BigInt(0),
      );
      expect(sum).toBe(grossPoints);

      // Base: 100 * 3333 / 9999 = 33 points each (sum = 99). 1 remainder point allocated to line_a (deterministic tie-break).
      expect(allocated[0].awardedPoints).toBe(BigInt(34));
      expect(allocated[1].awardedPoints).toBe(BigInt(33));
      expect(allocated[2].awardedPoints).toBe(BigInt(33));
    });

    it("2.2 verifies deterministic tie-breaking by orderLineId when remainders are identical", () => {
      // 10 points across 4 equal lines ($25 each)
      // Base: 10 * 25 / 100 = 2 each (sum 8). Remainder = 2 points left.
      // Lines "line_1" and "line_2" should receive +1 each by alphabetical tie-breaking.
      const lines = [
        { orderLineId: "line_4", lineNetAmount: BigInt(2500) },
        { orderLineId: "line_2", lineNetAmount: BigInt(2500) },
        { orderLineId: "line_3", lineNetAmount: BigInt(2500) },
        { orderLineId: "line_1", lineNetAmount: BigInt(2500) },
      ];

      const allocated = allocatePointsAcrossOrderLines({
        grossPoints: BigInt(10),
        lines,
      });

      const lineMap = new Map(
        allocated.map((l) => [l.orderLineId, l.awardedPoints]),
      );
      expect(lineMap.get("line_1")).toBe(BigInt(3));
      expect(lineMap.get("line_2")).toBe(BigInt(3));
      expect(lineMap.get("line_3")).toBe(BigInt(2));
      expect(lineMap.get("line_4")).toBe(BigInt(2));

      const total = allocated.reduce((s, l) => s + l.awardedPoints, BigInt(0));
      expect(total).toBe(BigInt(10));
    });

    it("2.3 allocates 0 points to excluded lines and preserves conservation among eligible lines", () => {
      const lines = [
        {
          orderLineId: "line_gift_card",
          lineNetAmount: BigInt(5000),
          isExcluded: true,
          exclusionReason: "gift_card",
        },
        {
          orderLineId: "line_hoodie",
          lineNetAmount: BigInt(6000),
          isExcluded: false,
        },
        {
          orderLineId: "line_socks",
          lineNetAmount: BigInt(4000),
          isExcluded: false,
        },
      ];

      const grossPoints = BigInt(100); // 100 points for $100 eligible ($60 hoodie + $40 socks)
      const allocated = allocatePointsAcrossOrderLines({ grossPoints, lines });

      const giftCard = allocated.find(
        (l) => l.orderLineId === "line_gift_card",
      );
      const hoodie = allocated.find((l) => l.orderLineId === "line_hoodie");
      const socks = allocated.find((l) => l.orderLineId === "line_socks");

      expect(giftCard?.awardedPoints).toBe(BigInt(0));
      expect(giftCard?.isExcluded).toBe(true);
      expect(hoodie?.awardedPoints).toBe(BigInt(60));
      expect(socks?.awardedPoints).toBe(BigInt(40));

      const sum = allocated.reduce((s, l) => s + l.awardedPoints, BigInt(0));
      expect(sum).toBe(grossPoints);
    });

    it("2.4 fuzzes 1,000 randomized heterogeneous multi-line orders with exact conservation", () => {
      for (let run = 0; run < 1000; run++) {
        const numLines = Math.floor(Math.random() * 20) + 1; // 1 to 20 lines
        const grossPoints = BigInt(Math.floor(Math.random() * 50000) + 1);

        const lines = Array.from({ length: numLines }, (_, i) => ({
          orderLineId: `fuzz_line_${i}`,
          lineNetAmount: BigInt(Math.floor(Math.random() * 10000) + 100),
          isExcluded: Math.random() < 0.15, // 15% chance excluded
        }));

        const allocated = allocatePointsAcrossOrderLines({
          grossPoints,
          lines,
        });
        const eligible = lines.filter(
          (l) => !l.isExcluded && l.lineNetAmount > BigInt(0),
        );

        const sumAwarded = allocated.reduce(
          (s, l) => s + l.awardedPoints,
          BigInt(0),
        );

        if (eligible.length === 0) {
          expect(sumAwarded).toBe(BigInt(0));
        } else {
          expect(sumAwarded).toBe(grossPoints);
        }

        // Verify excluded lines receive 0
        allocated.forEach((res) => {
          if (res.isExcluded) {
            expect(res.awardedPoints).toBe(BigInt(0));
          }
        });
      }
    });
  });

  // ==========================================================================
  // SCOPE 3: Dual-Bucket Holding Period Lifecycle & Maturation Outbox
  // ==========================================================================
  describe("Scope 3: Dual-Bucket Holding Period Lifecycle & Maturation Outbox Triggers", () => {
    it("3.1 releases mature pending grant into settled balance idempotently", async () => {
      const mockGrant = {
        id: "wgrant_001",
        storeId: "store_1",
        accountId: "wacc_1",
        orderId: "order_1",
        status: "pending",
        grossPoints: BigInt(500),
        pendingPoints: BigInt(500),
        settledPoints: BigInt(0),
        order: { orderName: "#1001", externalId: "gid://shopify/Order/1001" },
      };

      const mockAccount = {
        id: "wacc_1",
        storeId: "store_1",
        cachedPointsBalance: BigInt(100),
        cachedPendingPoints: BigInt(500),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 3,
      };

      const mockDb: any = {
        weleticLoyaltyEarnGrant: {
          findUnique: vi.fn().mockResolvedValue(mockGrant),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue(mockAccount),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi
            .fn()
            .mockImplementation(
              async ({ data }: { data: Record<string, unknown> }) => ({
                id: "wledger_release_1",
                ...data,
              }),
            ),
        },
        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "woutbox_1" }),
        },
      };

      // 1. Initial Release Execution
      const result = await releaseHoldingPeriodGrant({
        grantId: "wgrant_001",
        tx: mockDb,
      });

      expect(result.released).toBe(true);
      expect(result.points).toEqual(BigInt(500));
      expect(mockDb.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "wgrant_001",
            status: "pending",
            pendingPoints: BigInt(500),
          }),
          data: expect.objectContaining({
            status: "settled",
            pendingPoints: BigInt(0),
            settledPoints: BigInt(500),
          }),
        }),
      );

      // 2. Second Release Execution (Idempotency Guard)
      mockDb.weleticLoyaltyEarnGrant.findUnique.mockResolvedValueOnce({
        ...mockGrant,
        status: "settled",
        pendingPoints: BigInt(0),
        settledPoints: BigInt(500),
      });

      const replayResult = await releaseHoldingPeriodGrant({
        grantId: "wgrant_001",
        tx: mockDb,
      });

      expect(replayResult.released).toBe(false);
      expect(replayResult.reason).toBe("grant_already_settled");
    });

    it("3.2 calculates exponential backoff delay with full jitter for outbox retries", () => {
      const delay1 = calculateExponentialBackoff(1, 1000, 60000);
      expect(delay1).toBeGreaterThanOrEqual(1000);
      expect(delay1).toBeLessThanOrEqual(2000); // 1000 + up to 1000 jitter

      const delay3 = calculateExponentialBackoff(3, 1000, 60000);
      // 1000 * 2^2 = 4000 + jitter
      expect(delay3).toBeGreaterThanOrEqual(4000);
      expect(delay3).toBeLessThanOrEqual(5000);

      const delayExhausted = calculateExponentialBackoff(10, 1000, 10000);
      // Capped at maxDelayMs (10,000) + jitter
      expect(delayExhausted).toBeGreaterThanOrEqual(10000);
      expect(delayExhausted).toBeLessThanOrEqual(11000);
    });
  });

  // ==========================================================================
  // SCOPE 4: Source-Based Proportional Refund Reversals & Negative Debt
  // ==========================================================================
  describe("Scope 4: Source-Based Exact Proportional Refunds & Negative Points Debt", () => {
    it("4.1 reverses exact proportional points from original snapshot regardless of tier changes", () => {
      const originalGrant = {
        id: "wgrant_100",
        grossPoints: BigInt(150), // Awarded 150 points originally (1.5x VIP multiplier on $100)
        pendingPoints: BigInt(0),
        settledPoints: BigInt(150),
        reversedPoints: BigInt(0),
        eligibleSubtotalAmount: BigInt(10000), // $100.00
        lineEarns: [
          {
            id: "line_earn_1",
            orderLineId: "line_1",
            lineNetAmount: BigInt(6000), // $60.00 (earned 90 points)
            awardedPoints: BigInt(90),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
          {
            id: "line_earn_2",
            orderLineId: "line_2",
            lineNetAmount: BigInt(4000), // $40.00 (earned 60 points)
            awardedPoints: BigInt(60),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };

      // 50% partial refund on Line 1 ($30.00 of $60.00)
      const reversal = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          {
            orderLineId: "line_1",
            cumulativeShopAmount: BigInt(3000),
          },
        ],
      });

      expect(reversal.totalPointsToClawback).toBe(BigInt(45)); // 50% of 90 points = 45 points
      expect(reversal.voidPendingPoints).toBe(BigInt(0));
      expect(reversal.debitSettledPoints).toBe(BigInt(45));
      expect(reversal.isNegativeBalanceAllowed).toBe(true);
      expect(reversal.lineClawbacks[0].lineClawback).toBe(BigInt(45));
    });

    it("4.2 handles 3-stage multi-partial refund sequence summing to exact 100%", () => {
      const originalGrant = {
        id: "wgrant_200",
        grossPoints: BigInt(100),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(100),
        reversedPoints: BigInt(0),
        eligibleSubtotalAmount: BigInt(10000),
        lineEarns: [
          {
            id: "line_earn_single",
            orderLineId: "line_single",
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(100),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };

      // Stage 1: Refund $30.00 (30%)
      const stage1 = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          {
            orderLineId: "line_single",
            cumulativeShopAmount: BigInt(3000),
          },
        ],
      });
      expect(stage1.totalPointsToClawback).toBe(BigInt(30));

      // Update snapshot with stage 1 reversal
      originalGrant.reversedPoints += stage1.totalPointsToClawback;
      originalGrant.lineEarns[0].reversedPoints +=
        stage1.lineClawbacks[0].lineClawback;

      // Stage 2: Refund another $40.00; cumulative refund is now $70.00.
      const stage2 = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          {
            orderLineId: "line_single",
            cumulativeShopAmount: BigInt(7000),
          },
        ],
      });
      expect(stage2.totalPointsToClawback).toBe(BigInt(40));

      // Update snapshot with stage 2 reversal
      originalGrant.reversedPoints += stage2.totalPointsToClawback;
      originalGrant.lineEarns[0].reversedPoints +=
        stage2.lineClawbacks[0].lineClawback;

      // Stage 3: Refund the remaining $30.00; cumulative refund is $100.00.
      const stage3 = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          {
            orderLineId: "line_single",
            cumulativeShopAmount: BigInt(10000),
          },
        ],
      });
      expect(stage3.totalPointsToClawback).toBe(BigInt(30));

      // Total clawback across 3 stages equals exact 100 points
      const totalClawback =
        stage1.totalPointsToClawback +
        stage2.totalPointsToClawback +
        stage3.totalPointsToClawback;
      expect(totalClawback).toBe(BigInt(100));

      // Attempt Stage 4 (over-refund after 100% reversed): produces 0 clawback
      originalGrant.reversedPoints += stage3.totalPointsToClawback;
      originalGrant.lineEarns[0].reversedPoints +=
        stage3.lineClawbacks[0].lineClawback;

      const stage4 = calculateRefundPointsReversal({
        originalGrant,
        refundedLines: [
          {
            orderLineId: "line_single",
            cumulativeShopAmount: BigInt(11000),
          },
        ],
      });
      expect(stage4.totalPointsToClawback).toBe(BigInt(0));
    });

    it("4.3 permits negative points balance debt when customer already redeemed points", async () => {
      // Customer has 0 available points after redeeming 500 points for a discount voucher.
      // Order refund claws back 250 points -> account drops to -250 points debt.
      const mockAccount = {
        id: "wacc_debt_1",
        storeId: "store_1",
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(500),
        lifetimePointsRedeemed: BigInt(500),
        ledgerVersion: 10,
      };

      const mockDb: any = {
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue(mockAccount),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(({ data }) => ({
            id: "wledger_refund_debt",
            ...data,
          })),
        },
      };

      const ledgerEntry = await appendPointsLedgerEntry({
        storeId: "store_1",
        accountId: "wacc_debt_1",
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: -BigInt(250),
        idempotencyKey: "refund_void_order_123",
        reason: "Proportional refund clawback",
        tx: mockDb,
      });

      expect(ledgerEntry.balanceAfter).toEqual(BigInt(-250));
      expect(mockDb.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith({
        where: { id: "wacc_debt_1", storeId: "store_1", ledgerVersion: 10 },
        data: expect.objectContaining({
          cachedPointsBalance: BigInt(-250),
          ledgerVersion: 11,
        }),
      });
    });
  });

  // ==========================================================================
  // SCOPE 5: OCC ledgerVersion Monotonicity, Atomic CAS & Exponential Retry
  // ==========================================================================
  describe("Scope 5: Optimistic Concurrency Control (OCC) & Atomic CAS Writes", () => {
    it("5.1 enforces monotonic ledgerVersion increment on sequential ledger entries", async () => {
      let currentVersion = 5;
      let currentBalance = BigInt(1000);

      const mockDb: any = {
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockImplementation(() =>
            Promise.resolve({
              id: "wacc_mono",
              storeId: "store_1",
              cachedPointsBalance: currentBalance,
              cachedPendingPoints: BigInt(0),
              lifetimePointsEarned: currentBalance,
              lifetimePointsRedeemed: BigInt(0),
              ledgerVersion: currentVersion,
            }),
          ),
          updateMany: vi.fn().mockImplementation(({ where, data }) => {
            if (where.ledgerVersion === currentVersion) {
              currentVersion = data.ledgerVersion;
              currentBalance = data.cachedPointsBalance;
              return Promise.resolve({ count: 1 });
            }
            return Promise.resolve({ count: 0 });
          }),
        },
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(({ data }) => ({
            id: `wledger_${data.sequenceNumber}`,
            ...data,
          })),
        },
      };

      // Perform 5 sequential ledger appends
      for (let i = 1; i <= 5; i++) {
        const entry = await appendPointsLedgerEntry({
          storeId: "store_1",
          accountId: "wacc_mono",
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(100),
          idempotencyKey: `mono_key_${i}`,
          tx: mockDb,
        });

        expect(entry.sequenceNumber).toBe(5 + i);
        expect(entry.balanceAfter).toEqual(BigInt(1000 + i * 100));
      }

      expect(currentVersion).toBe(10);
      expect(currentBalance).toEqual(BigInt(1500));
    });

    it("5.2 detects OCC version conflict when concurrent writer increments version", async () => {
      const mockAccount = {
        id: "wacc_conflict",
        storeId: "store_1",
        cachedPointsBalance: BigInt(500),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(500),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 2,
      };

      const mockDb: any = {
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue(mockAccount),
          // Simulate collision: updateMany matches 0 rows because another transaction changed ledgerVersion
          updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "wledger_test" }),
        },
      };

      await expect(
        appendPointsLedgerEntry({
          storeId: "store_1",
          accountId: "wacc_conflict",
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(50),
          idempotencyKey: "conflict_key_1",
          tx: mockDb,
        }),
      ).rejects.toThrow(OptimisticConcurrencyError);
    });

    it("5.3 deduplicates duplicate idempotency key without duplicate ledger entries", async () => {
      const existingEntry = {
        id: "wledger_existing_1",
        storeId: "store_1",
        accountId: "wacc_dup",
        sequenceNumber: 4,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(200),
        pendingDelta: BigInt(0),
        balanceAfter: BigInt(800),
        grantId: null,
        referenceType: null,
        referenceId: null,
        idempotencyKey: "dup_idempotency_key",
      };

      const mockDb: any = {
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(existingEntry),
          create: vi.fn(),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn(),
          updateMany: vi.fn(),
        },
      };

      const result = await appendPointsLedgerEntry({
        storeId: "store_1",
        accountId: "wacc_dup",
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(200),
        idempotencyKey: "dup_idempotency_key",
        tx: mockDb,
      });

      expect(result.id).toBe("wledger_existing_1");
      expect(mockDb.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
      expect(mockDb.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
    });
  });
});
