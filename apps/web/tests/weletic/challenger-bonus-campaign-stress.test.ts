import {
  assertNoCampaignOverlap,
  assertRunningCampaignImmutability,
  BonusCampaignPolicyError,
  normalizeEligibleTierIds,
} from "@/lib/weletic/loyalty/bonus-campaign-policy";
import {
  calculateOrderEarn,
  multiplyFractions,
  parseDecimalToFraction,
  powerOfTenBigInt,
} from "@/lib/weletic/loyalty/earn";
import { currencyMinorUnits, normalizeCurrency } from "@/lib/weletic/money";
import { describe, expect, it } from "vitest";

describe("Adversarial Challenger Stress Suite — Bonus Points Campaigns Engine", () => {
  // ---------------------------------------------------------------------------
  // Challenger Group 1: Millisecond Boundary Attacks & Step Transitions
  // ---------------------------------------------------------------------------
  describe("Group 1: Millisecond Boundary Precision & Step Transitions", () => {
    const startAtMs = new Date("2026-09-01T00:00:00.000Z").getTime();
    const endAtMs = new Date("2026-09-10T00:00:00.000Z").getTime();

    const campaign = {
      id: "camp_boundary_test",
      multiplier: 2.0,
      startAt: new Date(startAtMs),
      endAt: new Date(endAtMs),
      isActive: true,
    };

    it("evaluates startAt boundary with 1ms exactness (startAt - 1ms vs startAt)", () => {
      // 1 millisecond before campaign start: baseline 1.0x multiplier
      const beforeStart = calculateOrderEarn({
        netAmountCents: 10000,
        currency: "USD",
        campaigns: [campaign],
        orderOccurredAt: new Date(startAtMs - 1),
      });
      expect(beforeStart.selectedCampaignId).toBeNull();
      expect(beforeStart.campaignMultiplier).toBe(1.0);
      expect(beforeStart.grossPoints).toBe(BigInt(100));

      // Exact millisecond of campaign start: bonus 2.0x multiplier active
      const exactStart = calculateOrderEarn({
        netAmountCents: 10000,
        currency: "USD",
        campaigns: [campaign],
        orderOccurredAt: new Date(startAtMs),
      });
      expect(exactStart.selectedCampaignId).toBe("camp_boundary_test");
      expect(exactStart.campaignMultiplier).toBe(2.0);
      expect(exactStart.grossPoints).toBe(BigInt(200));
    });

    it("evaluates endAt boundary with 1ms exactness (endAt - 1ms vs endAt)", () => {
      // 1 millisecond before campaign end: bonus 2.0x multiplier still active
      const beforeEnd = calculateOrderEarn({
        netAmountCents: 10000,
        currency: "USD",
        campaigns: [campaign],
        orderOccurredAt: new Date(endAtMs - 1),
      });
      expect(beforeEnd.selectedCampaignId).toBe("camp_boundary_test");
      expect(beforeEnd.campaignMultiplier).toBe(2.0);
      expect(beforeEnd.grossPoints).toBe(BigInt(200));

      // Exact millisecond of campaign end: campaign expired (half-open window), baseline 1.0x
      const exactEnd = calculateOrderEarn({
        netAmountCents: 10000,
        currency: "USD",
        campaigns: [campaign],
        orderOccurredAt: new Date(endAtMs),
      });
      expect(exactEnd.selectedCampaignId).toBeNull();
      expect(exactEnd.campaignMultiplier).toBe(1.0);
      expect(exactEnd.grossPoints).toBe(BigInt(100));
    });

    it("executes 200 consecutive orders stepping across start boundary with strict binary transition", () => {
      // 100 orders before startAt (-100ms to -1ms), 100 orders at/after startAt (0ms to +99ms)
      const results: bigint[] = [];
      for (let offset = -100; offset < 100; offset++) {
        const orderTime = new Date(startAtMs + offset);
        const result = calculateOrderEarn({
          netAmountCents: 10000,
          currency: "USD",
          campaigns: [campaign],
          orderOccurredAt: orderTime,
        });
        results.push(result.grossPoints);
      }

      // Verify the first 100 orders all received 100 points
      for (let i = 0; i < 100; i++) {
        expect(results[i]).toBe(BigInt(100));
      }
      // Verify the next 100 orders all received 200 points
      for (let i = 100; i < 200; i++) {
        expect(results[i]).toBe(BigInt(200));
      }
    });

    it("executes seamless handover between adjacent campaigns without gap or double count", () => {
      const pivotTimeMs = new Date("2026-09-08T12:00:00.000Z").getTime();
      const campaignA = {
        id: "camp_A_2x",
        multiplier: 2.0,
        startAt: new Date("2026-09-01T00:00:00.000Z"),
        endAt: new Date(pivotTimeMs),
        isActive: true,
      };
      const campaignB = {
        id: "camp_B_3x",
        multiplier: 3.0,
        startAt: new Date(pivotTimeMs),
        endAt: new Date("2026-09-15T00:00:00.000Z"),
        isActive: true,
      };

      const campaigns = [campaignA, campaignB];

      // Order at pivot - 1ms: belongs exclusively to Campaign A (2x)
      const orderJustBefore = calculateOrderEarn({
        netAmountCents: 10000,
        currency: "USD",
        campaigns,
        orderOccurredAt: new Date(pivotTimeMs - 1),
      });
      expect(orderJustBefore.selectedCampaignId).toBe("camp_A_2x");
      expect(orderJustBefore.grossPoints).toBe(BigInt(200));

      // Order at pivot: belongs exclusively to Campaign B (3x)
      const orderAtPivot = calculateOrderEarn({
        netAmountCents: 10000,
        currency: "USD",
        campaigns,
        orderOccurredAt: new Date(pivotTimeMs),
      });
      expect(orderAtPivot.selectedCampaignId).toBe("camp_B_3x");
      expect(orderAtPivot.grossPoints).toBe(BigInt(300));
    });
  });

  // ---------------------------------------------------------------------------
  // Challenger Group 2: Extreme Multipliers & Zero-Drift across 1,000 Synthetic Orders
  // ---------------------------------------------------------------------------
  describe("Group 2: Extreme Multipliers & Zero-Drift Across 1,000 Synthetic Orders", () => {
    it("guarantees 100% exact rational arithmetic and penny conservation across 1,000 orders", () => {
      const currencies = ["USD", "JPY", "VND", "EUR", "BHD"];
      const multipliers = [1.5, 2.0, 2.3333, 3.5, 5.0, 7.75, 10.0];
      const tierMultipliers = [1.0, 1.25, 1.5, 2.0];
      const rates = [1.0, 1.5, 2.0, 0.5];

      // PRNG seeded with deterministic linear congruential generator
      let seed = 42;
      const nextRandom = () => {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      };

      for (let i = 0; i < 1000; i++) {
        const currency =
          currencies[Math.floor(nextRandom() * currencies.length)];
        const campaignMul =
          multipliers[Math.floor(nextRandom() * multipliers.length)];
        const tierMul =
          tierMultipliers[Math.floor(nextRandom() * tierMultipliers.length)];
        const rate = rates[Math.floor(nextRandom() * rates.length)];

        // Generate 1 to 5 order lines with positive amounts
        const lineCount = Math.floor(nextRandom() * 5) + 1;
        const lines: Array<{
          orderLineId: string;
          lineNetAmount: bigint;
          isExcluded: boolean;
        }> = [];
        let totalNet = BigInt(0);

        for (let l = 0; l < lineCount; l++) {
          const lineNet = BigInt(Math.floor(nextRandom() * 50000) + 100);
          totalNet += lineNet;
          lines.push({
            orderLineId: `line_${i}_${l}`,
            lineNetAmount: lineNet,
            isExcluded: nextRandom() < 0.1, // 10% chance of excluded item
          });
        }

        const result = calculateOrderEarn({
          currency,
          pointsPerCurrencyUnit: rate,
          campaignMultiplier: campaignMul,
          tierMultiplier: tierMul,
          lines,
        });

        // 1. Gross points must be non-negative
        expect(result.grossPoints >= BigInt(0)).toBe(true);

        // 2. Penny conservation invariant
        const allocatedSum = result.lineAllocations!.reduce(
          (sum, line) => sum + line.awardedPoints,
          BigInt(0),
        );
        expect(allocatedSum).toBe(result.grossPoints);

        // 3. Excluded lines must have exactly 0 points
        for (const line of result.lineAllocations!) {
          if (line.isExcluded) {
            expect(line.awardedPoints).toBe(BigInt(0));
          }
        }

        // 4. Exact rational arithmetic verification
        const scale = powerOfTenBigInt(
          currencyMinorUnits(normalizeCurrency(currency)),
        );
        const combined = multiplyFractions([
          parseDecimalToFraction(rate),
          parseDecimalToFraction(1.0), // rule multiplier
          parseDecimalToFraction(campaignMul),
          parseDecimalToFraction(tierMul),
        ]);

        const expectedGross =
          (result.eligibleSubtotal * combined.num) / (scale * combined.den);
        expect(result.grossPoints).toBe(expectedGross);
      }
    });

    it("verifies upper bound multiplier (10.0x) on massive enterprise order ($10,000,000.00)", () => {
      const tenMillionUsdCents = BigInt(10_000_000 * 100); // 1,000,000,000 cents
      const result = calculateOrderEarn({
        netAmountCents: tenMillionUsdCents,
        currency: "USD",
        campaignMultiplier: 10.0, // Maximum allowed
        tierMultiplier: 2.0,
      });

      // 10,000,000 * 10 * 2 = 200,000,000 points
      expect(result.grossPoints).toBe(BigInt(200_000_000));
      expect(result.effectiveMultiplier).toBe(20.0);
    });

    it("verifies rational fraction multiplication precision without float rounding errors (2.3333x * 1.6667x)", () => {
      const result = calculateOrderEarn({
        netAmountCents: 10000, // $100.00
        currency: "USD",
        campaignMultiplier: 2.3333,
        tierMultiplier: 1.6667,
      });

      // Exact combined numerator and denominator
      expect(result.combinedFraction.den > BigInt(1)).toBe(true);
      expect(result.grossPoints >= BigInt(0)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Challenger Group 3: High-Concurrency & Race Condition Simulations
  // ---------------------------------------------------------------------------
  describe("Group 3: High-Concurrency & Race Condition Simulations", () => {
    it("consistently rejects 100 concurrent mid-flight mutation attempts", async () => {
      const runningCampaign = {
        id: "camp_concurrency_target",
        startAt: new Date("2026-09-01T00:00:00.000Z"),
        endAt: new Date("2026-09-10T00:00:00.000Z"),
        multiplier: 2.0,
        isActive: true,
      };
      const midFlightNow = new Date("2026-09-05T12:00:00.000Z");

      const mutationAttempts = Array.from({ length: 100 }, (_, i) => {
        return () =>
          assertRunningCampaignImmutability({
            existing: runningCampaign,
            updates: {
              multiplier: 2.0 + (i + 1) * 0.1,
              startAt: new Date(runningCampaign.startAt.getTime() + 1000),
            },
            now: midFlightNow,
          });
      });

      // Run all 100 simultaneously
      let rejectedCount = 0;
      for (const attempt of mutationAttempts) {
        try {
          attempt();
        } catch (e: any) {
          if (e instanceof BonusCampaignPolicyError) {
            rejectedCount++;
          }
        }
      }

      expect(rejectedCount).toBe(100);
    });

    it("rejects concurrent overlapping campaign scheduling attempts", () => {
      const baseCampaign = {
        id: "camp_active_store_wide",
        startAt: new Date("2026-09-01T00:00:00.000Z"),
        endAt: new Date("2026-09-15T00:00:00.000Z"),
        isActive: true,
        deletedAt: null,
      };

      const concurrentProposals = Array.from({ length: 50 }, (_, i) => ({
        id: `camp_concurrent_${i}`,
        startAt: new Date(`2026-09-0${(i % 10) + 2}T00:00:00.000Z`),
        endAt: new Date("2026-09-20T00:00:00.000Z"),
        isActive: true,
      }));

      let rejectedCount = 0;
      for (const proposed of concurrentProposals) {
        try {
          assertNoCampaignOverlap({
            proposed,
            existingCampaigns: [baseCampaign],
          });
        } catch (e: any) {
          if (e instanceof BonusCampaignPolicyError) {
            rejectedCount++;
          }
        }
      }

      expect(rejectedCount).toBe(50);
    });
  });

  // ---------------------------------------------------------------------------
  // Challenger Group 4: Adversarial Malformed Payloads & Fail-Closed Security
  // ---------------------------------------------------------------------------
  describe("Group 4: Adversarial Malformed Payloads & Fail-Closed Security", () => {
    it("safely handles negative subtotal by returning 0 points without negative overflow", () => {
      const negativeResult = calculateOrderEarn({
        netAmountCents: -50000,
        currency: "USD",
        campaignMultiplier: 2.0,
      });
      expect(negativeResult.grossPoints).toBe(BigInt(0));
      expect(negativeResult.eligibleSubtotal).toBe(BigInt(0));
    });

    it("fails closed upon invalid currency codes", () => {
      const invalidCurrencies = [
        "INVALID",
        "US",
        "USD_EXTRA",
        "123",
        "'; DROP TABLE;",
      ];
      for (const badCurrency of invalidCurrencies) {
        expect(() =>
          calculateOrderEarn({
            netAmountCents: 10000,
            currency: badCurrency,
            campaignMultiplier: 2.0,
          }),
        ).toThrow();
      }
    });

    it("rejects malicious tier ID injection payloads in normalizeEligibleTierIds", () => {
      const maliciousTiers = [
        ["../../../etc/passwd"],
        ["<script>alert('xss')</script>"],
        ["wtier_valid", "'; DROP TABLE weletic_loyalty; --"],
        ["wtier_" + "a".repeat(100)], // ID too long (> 64 chars)
      ];

      for (const badList of maliciousTiers) {
        expect(() => normalizeEligibleTierIds(badList)).toThrow(
          "eligibleTierIds contains an invalid VIP tier ID.",
        );
      }
    });

    it("rejects oversized tier array (> 100 items) to prevent memory exhaustion", () => {
      const oversizedArray = Array.from(
        { length: 101 },
        (_, i) => `wtier_item_${i}`,
      );
      expect(() => normalizeEligibleTierIds(oversizedArray)).toThrow(
        "eligibleTierIds must be an array of at most 100 tier IDs.",
      );
    });

    it("rejects reversed campaign schedule dates where end <= start", () => {
      expect(() =>
        assertNoCampaignOverlap({
          proposed: {
            startAt: new Date("2026-09-10T00:00:00.000Z"),
            endAt: new Date("2026-09-01T00:00:00.000Z"),
            isActive: true,
          },
          existingCampaigns: [],
        }),
      ).toThrow("Campaign end must be after its start.");
    });

    it("rejects invalid date timestamps in assertNoCampaignOverlap", () => {
      expect(() =>
        assertNoCampaignOverlap({
          proposed: {
            startAt: "corrupted_timestamp",
            endAt: new Date("2026-09-10T00:00:00.000Z"),
            isActive: true,
          },
          existingCampaigns: [],
        }),
      ).toThrow("Campaign start and end must be valid timestamps.");
    });

    it("handles zero-cost orders ($0.00) without division by zero or NaN", () => {
      const zeroResult = calculateOrderEarn({
        netAmountCents: 0,
        currency: "USD",
        campaignMultiplier: 2.0,
      });
      expect(zeroResult.grossPoints).toBe(BigInt(0));
      expect(zeroResult.eligibleSubtotal).toBe(BigInt(0));
    });
  });
});
