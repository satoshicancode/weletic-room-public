import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import { describe, expect, it, test } from "vitest";

describe("Weletic Proportional Refund Reversal & Ceiling Engine (ADR 0004)", () => {
  describe("Core Proportional Calculations", () => {
    test("reverses earnings proportionally on 25% refund ($25 of $100 -> $5.00 reversal)", () => {
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(2_000), // $20.00
          originalCommissionableAmount: BigInt(10_000), // $100.00
          refundedAmount: BigInt(2_500), // $25.00
        }),
      ).toBe(BigInt(500)); // $5.00
    });

    test("reverses earnings proportionally on 50% refund ($50 of $100 -> $10.00 reversal)", () => {
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(2_000),
          originalCommissionableAmount: BigInt(10_000),
          refundedAmount: BigInt(5_000),
        }),
      ).toBe(BigInt(1_000));
    });

    test("reverses earnings proportionally on 100% full refund ($100 of $100 -> $20.00 reversal)", () => {
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(2_000),
          originalCommissionableAmount: BigInt(10_000),
          refundedAmount: BigInt(10_000),
        }),
      ).toBe(BigInt(2_000));
    });

    test("never reverses more than the original earning (ceiling capping)", () => {
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(2_000),
          originalCommissionableAmount: BigInt(10_000),
          refundedAmount: BigInt(5_000),
          alreadyReversed: BigInt(1_500),
        }),
      ).toBe(BigInt(500));
    });

    test("returns 0 when line item has already been 100% reversed", () => {
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(2_000),
          originalCommissionableAmount: BigInt(10_000),
          refundedAmount: BigInt(2_500),
          alreadyReversed: BigInt(2_000),
        }),
      ).toBe(BigInt(0));
    });
  });

  describe("Rounding & Fractional Math Precision", () => {
    it("applies half-up rounding on fractional division (e.g. 1/3 refund on 1000 minor units)", () => {
      // 1000 * 333 / 1000 = 333
      const rev1 = calculateRefundReversal({
        originalEarnings: BigInt(100),
        originalCommissionableAmount: BigInt(300),
        refundedAmount: BigInt(100), // exactly 1/3
      });
      // 100 * 100 / 300 = 33.333... -> 33
      expect(rev1).toBe(BigInt(33));

      const rev2 = calculateRefundReversal({
        originalEarnings: BigInt(100),
        originalCommissionableAmount: BigInt(300),
        refundedAmount: BigInt(200), // exactly 2/3
      });
      // 100 * 200 / 300 = 66.666... -> 67 (half-up)
      expect(rev2).toBe(BigInt(67));
    });

    it("ensures two complementary fractional refunds sum exactly to total original earnings", () => {
      const originalEarnings = BigInt(100);
      const originalAmount = BigInt(300);

      // First refund: 100 of 300 (1/3)
      const part1 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: BigInt(100),
        alreadyReversed: BigInt(0),
      });
      expect(part1).toBe(BigInt(33));

      // Second refund: remaining 200 of 300 (2/3)
      const part2 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: BigInt(200),
        alreadyReversed: part1,
      });
      expect(part2).toBe(BigInt(67));

      expect(part1 + part2).toBe(originalEarnings);
    });
  });

  describe("Zero-Decimal Currencies (JPY, VND)", () => {
    it("calculates JPY line refund without floating-point loss (¥1,800 comm on ¥12,000 line, ¥4,000 refund -> ¥600 clawback)", () => {
      const reversal = calculateRefundReversal({
        originalEarnings: BigInt(1800), // ¥1,800
        originalCommissionableAmount: BigInt(12000), // ¥12,000
        refundedAmount: BigInt(4000), // ¥4,000 (1/3)
        alreadyReversed: BigInt(0),
      });
      expect(reversal).toBe(BigInt(600)); // Exact ¥600
    });

    it("calculates VND line refund accurately (50,000₫ comm on 500,000₫ line, 250,000₫ refund -> 25,000₫ clawback)", () => {
      const reversal = calculateRefundReversal({
        originalEarnings: BigInt(50000),
        originalCommissionableAmount: BigInt(500000),
        refundedAmount: BigInt(250000),
        alreadyReversed: BigInt(0),
      });
      expect(reversal).toBe(BigInt(25000));
    });
  });

  describe("Zero and Boundary Edge Cases", () => {
    it("returns 0 for $0 refund amount", () => {
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(5000),
          originalCommissionableAmount: BigInt(25000),
          refundedAmount: BigInt(0),
        }),
      ).toBe(BigInt(0));
    });

    it("returns 0 when original earnings were 0 (e.g. 0% rule or free gift)", () => {
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(0),
          originalCommissionableAmount: BigInt(10000),
          refundedAmount: BigInt(5000),
        }),
      ).toBe(BigInt(0));
    });

    it("returns 0 when original commissionable amount was 0", () => {
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(0),
          originalCommissionableAmount: BigInt(0),
          refundedAmount: BigInt(5000),
        }),
      ).toBe(BigInt(0));
    });

    it("safely handles negative refunded amounts by returning 0", () => {
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(2000),
          originalCommissionableAmount: BigInt(10000),
          refundedAmount: BigInt(-2500),
        }),
      ).toBe(BigInt(0));
    });

    it("safely clamps negative alreadyReversed values", () => {
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(2000),
          originalCommissionableAmount: BigInt(10000),
          refundedAmount: BigInt(5000),
          alreadyReversed: BigInt(-500),
        }),
      ).toBe(BigInt(1000));
    });
  });
});
