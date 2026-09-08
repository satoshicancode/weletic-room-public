import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import { describe, expect, it } from "vitest";

describe("cumulative refund reversal rounding", () => {
  it("fully reverses a one-minor-unit commission across three one-third refunds", () => {
    let alreadyRefunded = BigInt(0);
    let alreadyReversed = BigInt(0);
    const reversals = Array.from({ length: 3 }, () => {
      const reversal = calculateRefundReversal({
        originalEarnings: BigInt(1),
        originalCommissionableAmount: BigInt(3),
        refundedAmount: BigInt(1),
        alreadyRefunded,
        alreadyReversed,
      });
      alreadyRefunded += BigInt(1);
      alreadyReversed += reversal;
      return reversal;
    });

    expect(reversals).toEqual([BigInt(0), BigInt(1), BigInt(0)]);
    expect(alreadyReversed).toBe(BigInt(1));
  });
});
