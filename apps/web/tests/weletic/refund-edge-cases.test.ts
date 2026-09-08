import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import { describe, expect, it } from "vitest";

describe("Weletic E-Commerce Refund Edge Cases & Financial Safety (ADR 0004)", () => {
  it("Scenario 1: Shipping-only or $0 refund produces exactly $0 commission reversal", () => {
    const reversal = calculateRefundReversal({
      originalEarnings: BigInt(150000), // 150k VND
      originalCommissionableAmount: BigInt(1000000), // 1M VND
      refundedAmount: BigInt(0), // Shipping only or $0
      alreadyReversed: BigInt(0),
    });

    expect(reversal).toBe(BigInt(0));
  });

  it("Scenario 2: Free gift ($0 line item) never crashes with division-by-zero and returns $0", () => {
    const reversal = calculateRefundReversal({
      originalEarnings: BigInt(0),
      originalCommissionableAmount: BigInt(0), // Free gift item
      refundedAmount: BigInt(0),
      alreadyReversed: BigInt(0),
    });

    expect(reversal).toBe(BigInt(0));
  });

  it("Scenario 3: Staggered multi-refunds across 3 consecutive batches sum exactly to original earnings", () => {
    const originalEarnings = BigInt(300000); // 300k VND
    const originalAmount = BigInt(1000000); // 1M VND

    // Batch 1: Refund 30% (300k VND)
    const rev1 = calculateRefundReversal({
      originalEarnings,
      originalCommissionableAmount: originalAmount,
      refundedAmount: BigInt(300000),
      alreadyReversed: BigInt(0),
    });
    expect(rev1).toBe(BigInt(90000)); // 90k VND

    // Batch 2: Refund another 50% (500k VND)
    const rev2 = calculateRefundReversal({
      originalEarnings,
      originalCommissionableAmount: originalAmount,
      refundedAmount: BigInt(500000),
      alreadyReversed: rev1,
    });
    expect(rev2).toBe(BigInt(150000)); // 150k VND

    // Batch 3: Refund remaining 20% (200k VND)
    const rev3 = calculateRefundReversal({
      originalEarnings,
      originalCommissionableAmount: originalAmount,
      refundedAmount: BigInt(200000),
      alreadyReversed: rev1 + rev2,
    });
    expect(rev3).toBe(BigInt(60000)); // 60k VND

    // Total reversed must equal 100% of original earnings
    expect(rev1 + rev2 + rev3).toBe(originalEarnings);
  });

  it("Scenario 4: Over-refund attempt cannot claw back more than remaining earnings", () => {
    const originalEarnings = BigInt(100000); // 100k VND
    const originalAmount = BigInt(500000); // 500k VND

    // First refund was 80k VND
    const alreadyReversed = BigInt(80000);

    // Merchant attempts to refund full 500k again
    const reversal = calculateRefundReversal({
      originalEarnings,
      originalCommissionableAmount: originalAmount,
      refundedAmount: BigInt(500000),
      alreadyReversed,
    });

    // Reversal must be capped at 20k VND (100k - 80k)
    expect(reversal).toBe(BigInt(20000));
    expect(alreadyReversed + reversal).toBe(originalEarnings);
  });

  it("Scenario 5: When already 100% reversed, subsequent refunds return $0", () => {
    const originalEarnings = BigInt(100000);
    const originalAmount = BigInt(500000);

    const reversal = calculateRefundReversal({
      originalEarnings,
      originalCommissionableAmount: originalAmount,
      refundedAmount: BigInt(100000),
      alreadyReversed: BigInt(100000), // Already 100% reversed
    });

    expect(reversal).toBe(BigInt(0));
  });

  it("Scenario 6: Partial refund on heterogeneous multi-item cart accurately reverses only target line", () => {
    // Line 1: Legging $80 @ 20% = $16.00 comm (1600 cents)
    // Line 2: Tank $40 @ 10% = $4.00 comm (400 cents)
    const line1OriginalEarnings = BigInt(1600);
    const line1OriginalAmount = BigInt(8000);

    const line2OriginalEarnings = BigInt(400);
    const line2OriginalAmount = BigInt(4000);

    // Customer refunds 50% of Leggings ($40) only. Tank is not refunded.
    const line1Clawback = calculateRefundReversal({
      originalEarnings: line1OriginalEarnings,
      originalCommissionableAmount: line1OriginalAmount,
      refundedAmount: BigInt(4000),
      alreadyReversed: BigInt(0),
    });

    const line2Clawback = calculateRefundReversal({
      originalEarnings: line2OriginalEarnings,
      originalCommissionableAmount: line2OriginalAmount,
      refundedAmount: BigInt(0),
      alreadyReversed: BigInt(0),
    });

    expect(line1Clawback).toBe(BigInt(800)); // $8.00
    expect(line2Clawback).toBe(BigInt(0)); // $0.00
    expect(line1OriginalEarnings - line1Clawback).toBe(BigInt(800)); // $8.00 left on line 1
    expect(line2OriginalEarnings - line2Clawback).toBe(BigInt(400)); // $4.00 untouched on line 2
  });

  it("Scenario 7: Extreme values near 32-bit integer boundaries without arithmetic overflow", () => {
    const largeEarnings = BigInt(2_000_000_000); // 20 million USD (near 2.14B safe int limit)
    const largeAmount = BigInt(10_000_000_000); // 100 million USD

    const reversal = calculateRefundReversal({
      originalEarnings: largeEarnings,
      originalCommissionableAmount: largeAmount,
      refundedAmount: BigInt(5_000_000_000), // 50%
      alreadyReversed: BigInt(0),
    });

    expect(reversal).toBe(BigInt(1_000_000_000)); // Exactly 10 million USD
  });
});
