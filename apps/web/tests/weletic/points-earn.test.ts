import { calculateEligibleOrderPoints } from "@/lib/weletic/loyalty/earn";
import { describe, expect, it } from "vitest";

describe("Weletic Customer Loyalty Earning & Proportional Refund Engine (ADR 0004, ADR 0005)", () => {
  it("calculates points accurately for standard 2-decimal currencies (USD/EUR)", () => {
    // $100.00 net merchandise spend (10000 cents) at 1 point per $1 -> 100 points
    const points = calculateEligibleOrderPoints({
      netAmountCents: BigInt(10000),
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.0,
    });
    expect(points).toBe(BigInt(100));

    // $49.99 net spend with 2x multiplier -> Math.floor(49.99 * 2) = 99 points
    const points2x = calculateEligibleOrderPoints({
      netAmountCents: BigInt(4999),
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 2.0,
    });
    expect(points2x).toBe(BigInt(99));
  });

  it("calculates points accurately for 0-decimal currencies (JPY/VND)", () => {
    // ¥10,000 JPY net spend at 1 point per ¥100 (0.01 per unit)
    const pointsJPY = calculateEligibleOrderPoints({
      netAmountCents: BigInt(10000),
      currency: "JPY",
      pointsPerCurrencyUnit: 0.01,
      multiplier: 1.0,
    });
    expect(pointsJPY).toBe(BigInt(100));

    // 500,000 VND net spend at 1 point per 1,000 VND (0.001 per unit)
    const pointsVND = calculateEligibleOrderPoints({
      netAmountCents: BigInt(500000),
      currency: "VND",
      pointsPerCurrencyUnit: 0.001,
      multiplier: 1.0,
    });
    expect(pointsVND).toBe(BigInt(500));
  });

  it("enforces minimum order subtotal before awarding points", () => {
    // Min subtotal $50.00 (5000 cents), order net is $30.00 (3000 cents) -> 0 points
    const belowMin = calculateEligibleOrderPoints({
      netAmountCents: BigInt(3000),
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.0,
      minOrderSubtotalCents: BigInt(5000),
    });
    expect(belowMin).toBe(BigInt(0));

    // Order net is $60.00 (6000 cents) >= min -> 60 points
    const aboveMin = calculateEligibleOrderPoints({
      netAmountCents: BigInt(6000),
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.0,
      minOrderSubtotalCents: BigInt(5000),
    });
    expect(aboveMin).toBe(BigInt(60));
  });

  it("calculates proportional points reversal on partial order refunds", () => {
    const originalOrderNetCents = BigInt(12000); // $120.00
    const partialRefundCents = BigInt(4000); // $40.00 refunded (1/3 of order)

    const originalEarned = calculateEligibleOrderPoints({
      netAmountCents: originalOrderNetCents,
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.0,
    });
    expect(originalEarned).toBe(BigInt(120));

    const pointsReversed = calculateEligibleOrderPoints({
      netAmountCents: partialRefundCents,
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.0,
    });
    expect(pointsReversed).toBe(BigInt(40));
  });
});
