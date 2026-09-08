import {
  allocatePointsAcrossOrderLines,
  allocatePointsProportionally,
  calculateEligibleOrderPoints,
  calculateNextExpiryDate,
  calculateOrderPointsAllocation,
  multiplyFractions,
  parseDecimalToFraction,
  powerOfTenBigInt,
} from "@/lib/weletic/loyalty/earn";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

describe("Milestone 3: Pure BigInt Financial Math & Order Allocation Test Suite", () => {
  // =========================================================================
  // 1. Pure BigInt Rational Arithmetic Tests
  // =========================================================================
  describe("1. Pure Rational Fraction Arithmetic", () => {
    it("parses integers, decimals, Prisma.Decimal, and nulls with zero floating point drift", () => {
      expect(parseDecimalToFraction(null)).toEqual({
        num: BigInt(1),
        den: BigInt(1),
      });
      expect(parseDecimalToFraction(undefined)).toEqual({
        num: BigInt(1),
        den: BigInt(1),
      });
      expect(parseDecimalToFraction(BigInt(50))).toEqual({
        num: BigInt(50),
        den: BigInt(1),
      });
      expect(parseDecimalToFraction(100)).toEqual({
        num: BigInt(100),
        den: BigInt(1),
      });
      expect(parseDecimalToFraction("1.5")).toEqual({
        num: BigInt(15),
        den: BigInt(10),
      });
      expect(parseDecimalToFraction("0.05")).toEqual({
        num: BigInt(5),
        den: BigInt(100),
      });
      expect(parseDecimalToFraction(new Prisma.Decimal("1.25"))).toEqual({
        num: BigInt(125),
        den: BigInt(100),
      });
      expect(parseDecimalToFraction("-2.5")).toEqual({
        num: BigInt(-25),
        den: BigInt(10),
      });
    });

    it("multiplies multiple rational fractions without loss of precision", () => {
      const f1 = parseDecimalToFraction("1.5"); // 15/10
      const f2 = parseDecimalToFraction("2.0"); // 20/10
      const f3 = parseDecimalToFraction("1.2"); // 12/10

      const product = multiplyFractions([f1, f2, f3]);
      // 15 * 20 * 12 = 3600, 10 * 10 * 10 = 1000 => 3.6
      expect(product.num).toBe(BigInt(3600));
      expect(product.den).toBe(BigInt(1000));
      expect(Number(product.num) / Number(product.den)).toBeCloseTo(3.6);
    });

    it("correctly computes powers of 10 for BigInt currency minor units", () => {
      expect(powerOfTenBigInt(0)).toBe(BigInt(1));
      expect(powerOfTenBigInt(2)).toBe(BigInt(100));
      expect(powerOfTenBigInt(3)).toBe(BigInt(1000));
    });
  });

  // =========================================================================
  // 2. Multi-Currency Points Calculation (0-Decimal vs 2-Decimal)
  // =========================================================================
  describe("2. Multi-Currency Calculation Logic (USD, JPY, VND, EUR)", () => {
    it("calculates 2-decimal USD orders correctly ($100.00 = 10000 cents @ 1 point/$1 -> 100 points)", () => {
      const points = calculateEligibleOrderPoints({
        netAmountCents: BigInt(10000),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        multiplier: 1.0,
      });
      expect(points).toBe(BigInt(100));
    });

    it("calculates 0-decimal JPY orders correctly (¥10,000 = 10000 minor @ 1 point/¥100 -> 100 points)", () => {
      const points = calculateEligibleOrderPoints({
        netAmountCents: BigInt(10000),
        currency: "JPY",
        pointsPerCurrencyUnit: "0.01", // 1 point per 100 JPY
        multiplier: 1.0,
      });
      expect(points).toBe(BigInt(100));
    });

    it("calculates 0-decimal VND orders correctly (200,000 VND @ 0.001 rate -> 200 points)", () => {
      const points = calculateEligibleOrderPoints({
        netAmountCents: BigInt(200000),
        currency: "VND",
        pointsPerCurrencyUnit: "0.001",
        multiplier: 1.0,
      });
      expect(points).toBe(BigInt(200));
    });

    it("handles compound fractional multipliers accurately (USD $150.75 with 1.5x campaign * 1.25x VIP)", () => {
      // 15075 cents * 1 pt/$ * 1.5 * 1.25 = 15075 * 1.875 = 28265.625 / 100 = 282 points
      const points = calculateEligibleOrderPoints({
        netAmountCents: BigInt(15075),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        multiplier: "1.875",
      });
      expect(points).toBe(BigInt(282));
    });

    it("enforces minimum order subtotal requirement", () => {
      const pointsBelowMin = calculateEligibleOrderPoints({
        netAmountCents: BigInt(4999), // $49.99
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        minOrderSubtotalCents: BigInt(5000), // $50.00 min
      });
      expect(pointsBelowMin).toBe(BigInt(0));

      const pointsAtMin = calculateEligibleOrderPoints({
        netAmountCents: BigInt(5000),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        minOrderSubtotalCents: BigInt(5000),
      });
      expect(pointsAtMin).toBe(BigInt(50));
    });

    it("returns 0 points for zero or negative net amounts", () => {
      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(0),
          currency: "USD",
        }),
      ).toBe(BigInt(0));
      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(-500),
          currency: "USD",
        }),
      ).toBe(BigInt(0));
    });
  });

  // =========================================================================
  // 3. Largest Remainder (Hamilton-Hare) Proportional Line Allocation
  // =========================================================================
  describe("3. Largest Remainder Proportional Line Allocation", () => {
    it("guarantees exact penny conservation across odd 3-way split (100 points divided among 3 equal $33.33 lines)", () => {
      const lines = [
        { orderLineId: "line_1", lineNetAmount: BigInt(3333) },
        { orderLineId: "line_2", lineNetAmount: BigInt(3333) },
        { orderLineId: "line_3", lineNetAmount: BigInt(3334) },
      ];

      const result = allocatePointsAcrossOrderLines({
        grossPoints: BigInt(100),
        lines,
      });

      const totalAwarded = result.reduce(
        (sum, l) => sum + l.awardedPoints,
        BigInt(0),
      );
      expect(totalAwarded).toBe(BigInt(100));

      // Line 3 with 3334n had the largest remainder and gets the extra point
      expect(
        result.find((l) => l.orderLineId === "line_3")?.awardedPoints,
      ).toBe(BigInt(34));
      expect(
        result.find((l) => l.orderLineId === "line_1")?.awardedPoints,
      ).toBe(BigInt(33));
      expect(
        result.find((l) => l.orderLineId === "line_2")?.awardedPoints,
      ).toBe(BigInt(33));
    });

    it("excludes discounted or flagged lines from point allocation", () => {
      const lines = [
        {
          orderLineId: "line_eligible",
          lineNetAmount: BigInt(5000),
          isExcluded: false,
        },
        {
          orderLineId: "line_excluded",
          lineNetAmount: BigInt(5000),
          isExcluded: true,
          exclusionReason: "discounted_item",
        },
      ];

      const result = allocatePointsAcrossOrderLines({
        grossPoints: BigInt(50),
        lines,
      });

      const eligibleLine = result.find(
        (l) => l.orderLineId === "line_eligible",
      );
      const excludedLine = result.find(
        (l) => l.orderLineId === "line_excluded",
      );

      expect(eligibleLine?.awardedPoints).toBe(BigInt(50));
      expect(excludedLine?.awardedPoints).toBe(BigInt(0));
      expect(excludedLine?.isExcluded).toBe(true);
      expect(excludedLine?.exclusionReason).toBe("discounted_item");
    });

    it("array helper allocatePointsProportionally produces identical sum", () => {
      const allocated = allocatePointsProportionally({
        totalPoints: BigInt(100),
        lineAmounts: [BigInt(1000), BigInt(2000), BigInt(3000), BigInt(4000)],
      });

      expect(allocated).toEqual([
        BigInt(10),
        BigInt(20),
        BigInt(30),
        BigInt(40),
      ]);
      expect(allocated.reduce((a, b) => a + b, BigInt(0))).toBe(BigInt(100));
    });

    it("handles order allocation params helper with compound tier, campaign, and rule multipliers", () => {
      const allocation = calculateOrderPointsAllocation({
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        ruleMultiplier: "1.0",
        campaignMultiplier: "1.5",
        tierMultiplier: "1.2",
        lines: [
          {
            id: "l1",
            externalId: "ext_1",
            title: "Item A",
            quantity: 1,
            shopNet: BigInt(5000),
          },
          {
            id: "l2",
            externalId: "ext_2",
            title: "Item B",
            quantity: 1,
            shopNet: BigInt(5000),
          },
        ],
      });

      // Total Net: $100.00. Multiplier: 1.5 * 1.2 = 1.8. Gross Points: 180.
      expect(allocation.grossPoints).toBe(BigInt(180));
      expect(allocation.eligibleSubtotal).toBe(BigInt(10000));
      expect(allocation.lineAllocations.length).toBe(2);
      expect(allocation.lineAllocations[0].awardedPoints).toBe(BigInt(90));
      expect(allocation.lineAllocations[1].awardedPoints).toBe(BigInt(90));
    });
  });

  // =========================================================================
  // 4. Inactivity Expiration Math
  // =========================================================================
  describe("4. Inactivity Expiration Date Calculation", () => {
    it("calculates next expiry date correctly across calendar year boundaries", () => {
      const activity = new Date("2026-06-15T12:00:00Z");
      const expiry = calculateNextExpiryDate(activity, 12);

      expect(expiry).not.toBeNull();
      expect(expiry?.toISOString().startsWith("2027-06-15")).toBe(true);
    });

    it("returns null if expiry months is set to 0 (unlimited)", () => {
      const activity = new Date("2026-06-15T12:00:00Z");
      expect(calculateNextExpiryDate(activity, 0)).toBeNull();
      expect(calculateNextExpiryDate(activity, -1)).toBeNull();
    });
  });
});
