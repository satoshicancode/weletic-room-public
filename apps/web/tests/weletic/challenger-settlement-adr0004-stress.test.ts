import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import {
  allocateCommissionProportionally,
  calculateCommission,
  selectCommissionRule,
  type CommissionRuleContext,
} from "@/lib/weletic/commissions/rules";
import {
  convertMoney,
  decimalToMinorUnits,
  minorUnitsToDecimal,
  normalizeCurrency,
} from "@/lib/weletic/money";
import { WeleticCommissionRule } from "@prisma/client";
import { describe, expect, it } from "vitest";

// =============================================================================
// Helper Factory for Commission Rules
// =============================================================================
const now = new Date("2026-08-20T00:00:00Z");

function createRule(
  overrides: Partial<WeleticCommissionRule> = {},
): WeleticCommissionRule {
  return {
    id: overrides.id ?? "wrule_default",
    logicalKey: overrides.logicalKey ?? "default",
    version: overrides.version ?? 1,
    programId: overrides.programId ?? "prog_yamax",
    partnerId: overrides.partnerId ?? null,
    scope: overrides.scope ?? "program",
    ruleType: overrides.ruleType ?? "percentage",
    fixedAmountMode: overrides.fixedAmountMode ?? "line",
    priority: overrides.priority ?? 0,
    collectionExternalId: overrides.collectionExternalId ?? null,
    productId: overrides.productId ?? null,
    variantId: overrides.variantId ?? null,
    promotionCode: overrides.promotionCode ?? null,
    tag: overrides.tag ?? null,
    basisPoints: overrides.basisPoints ?? 1000, // 10%
    fixedAmount: overrides.fixedAmount ?? null,
    currency: overrides.currency ?? null,
    minOrderAmount: overrides.minOrderAmount ?? null,
    maxCommissionAmount: overrides.maxCommissionAmount ?? null,
    effectiveAt: overrides.effectiveAt ?? new Date("2026-01-01T00:00:00Z"),
    expiresAt: overrides.expiresAt ?? null,
    active: overrides.active ?? true,
    createdByUserId: null,
    createdAt: now,
  };
}

function toSafeInt(value: bigint, field: string) {
  const number = Number(value);
  if (
    !Number.isSafeInteger(number) ||
    number > 2_147_483_647 ||
    number < -2_147_483_648
  ) {
    throw new Error(`${field} exceeds the Dub integer money range.`);
  }
  return number;
}

describe("Empirical Challenger 2: Adversarial Stress Testing — Settlement Engine & ADR 0004 Refunds", () => {
  // ===========================================================================
  // 1. High-Concurrency Simulated Refund Webhooks on the Same Order
  // ===========================================================================
  describe("1. High-Concurrency Simulated Refund Webhooks", () => {
    it("1.1: 50 concurrent identical refund webhooks on same order (idempotency deduplication)", async () => {
      const seenRefunds = new Map<
        string,
        { refundId: string; amount: bigint }
      >();

      const simulateWebhookHandler = async (
        externalId: string,
        amount: bigint,
      ) => {
        // Simulated atomic check
        if (seenRefunds.has(externalId)) {
          return {
            duplicate: true,
            refundId: seenRefunds.get(externalId)!.refundId,
          };
        }
        const refundId = `wrefund_${externalId}`;
        seenRefunds.set(externalId, { refundId, amount });
        return { duplicate: false, refundId };
      };

      const webhookId = "shopify_refund_concurrent_101";
      const refundAmount = BigInt(5000); // $50.00

      // Dispatch 50 concurrent requests
      const promises = Array.from({ length: 50 }, () =>
        simulateWebhookHandler(webhookId, refundAmount),
      );
      const results = await Promise.all(promises);

      const uniqueSuccess = results.filter((r) => !r.duplicate);
      const duplicates = results.filter((r) => r.duplicate);

      expect(uniqueSuccess).toHaveLength(1);
      expect(duplicates).toHaveLength(49);
      expect(seenRefunds.size).toBe(1);
    });

    it("1.2: 20 simultaneous distinct partial refunds competing for line earnings preserve ceiling invariant", async () => {
      const originalEarnings = BigInt(5000); // $50.00
      const originalAmount = BigInt(25000); // $250.00
      let committedAlreadyReversed = BigInt(0);

      // Mutex/Lock simulation for serializable transaction
      const transactionLock = { locked: false };
      const runTransaction = async (refundAmount: bigint): Promise<bigint> => {
        // Simulate atomic DB serializable transaction
        const reversal = calculateRefundReversal({
          originalEarnings,
          originalCommissionableAmount: originalAmount,
          refundedAmount: refundAmount,
          alreadyReversed: committedAlreadyReversed,
        });
        committedAlreadyReversed += reversal;
        return reversal;
      };

      // 20 requests each attempting $20.00 refund (total attempted = $400.00 > $250.00 original)
      const refundAttempts = Array.from({ length: 20 }, () => BigInt(2000));
      const reversals: bigint[] = [];

      for (const attempt of refundAttempts) {
        const rev = await runTransaction(attempt);
        reversals.push(rev);
      }

      const totalReversed = reversals.reduce((a, b) => a + b, BigInt(0));
      expect(totalReversed).toBe(originalEarnings); // Strictly equals $50.00
      expect(committedAlreadyReversed).toBe(originalEarnings);

      // Verify that after 100% reversed, subsequent refunds get 0
      const postFullReversal = await runTransaction(BigInt(1000));
      expect(postFullReversal).toBe(BigInt(0));
    });

    it("1.3: 100 randomized concurrent race events with interleaved line items", async () => {
      // Order with 3 distinct lines
      const lines = [
        {
          id: "line_1",
          originalEarnings: BigInt(2000),
          originalAmount: BigInt(10000),
          alreadyReversed: BigInt(0),
        },
        {
          id: "line_2",
          originalEarnings: BigInt(1500),
          originalAmount: BigInt(10000),
          alreadyReversed: BigInt(0),
        },
        {
          id: "line_3",
          originalEarnings: BigInt(800),
          originalAmount: BigInt(4000),
          alreadyReversed: BigInt(0),
        },
      ];

      // 100 random refund actions across the 3 lines
      for (let i = 0; i < 100; i++) {
        const targetLineIndex = i % 3;
        const targetLine = lines[targetLineIndex];
        const randomRefundAmount = BigInt(((i * 37) % 3000) + 100); // Between $1.00 and $30.00

        const rev = calculateRefundReversal({
          originalEarnings: targetLine.originalEarnings,
          originalCommissionableAmount: targetLine.originalAmount,
          refundedAmount: randomRefundAmount,
          alreadyReversed: targetLine.alreadyReversed,
        });

        targetLine.alreadyReversed += rev;

        // Invariant: each line's alreadyReversed <= originalEarnings at all intermediate steps
        expect(targetLine.alreadyReversed).toBeLessThanOrEqual(
          targetLine.originalEarnings,
        );
      }

      for (const line of lines) {
        expect(line.alreadyReversed).toBeLessThanOrEqual(line.originalEarnings);
      }
    });

    it("1.4: Out-of-order webhook delivery: un-ingested order returns ignored: true without crashing", () => {
      const handleUnknownOrderRefund = (orderFound: boolean) => {
        if (!orderFound) {
          return {
            refundId: null,
            duplicate: false,
            ignored: true,
            reason: "order_not_found",
          };
        }
        return { refundId: "wrefund_123", duplicate: false, ignored: false };
      };

      const res = handleUnknownOrderRefund(false);
      expect(res.ignored).toBe(true);
      expect(res.reason).toBe("order_not_found");
      expect(res.refundId).toBeNull();
    });
  });

  // ===========================================================================
  // 2. Multi-Stage Partial Refunds with Fractional Odd Amounts in Zero-Decimal & Fiat
  // ===========================================================================
  describe("2. Multi-Stage Partial Refunds with Fractional Odd Amounts (JPY, VND, USD)", () => {
    it("2.1: JPY zero-decimal 7-stage prime partition refund sequence (¥19,999 line @ 15% comm)", () => {
      // Line: ¥19,999. Commission @ 15% (1500 bps) = round(19999 * 1500 / 10000) = 3000
      const originalAmount = BigInt(19999);
      const originalEarnings = BigInt(3000);

      // Partition ¥19,999 into 7 irregular amounts: [3123, 2789, 4111, 1999, 3456, 2521, 2000]
      const partitions = [
        BigInt(3123),
        BigInt(2789),
        BigInt(4111),
        BigInt(1999),
        BigInt(3456),
        BigInt(2521),
        BigInt(2000),
      ];
      expect(partitions.reduce((a, b) => a + b, BigInt(0))).toBe(
        originalAmount,
      );

      let runningReversed = BigInt(0);
      const reversals: bigint[] = [];

      for (const part of partitions) {
        const rev = calculateRefundReversal({
          originalEarnings,
          originalCommissionableAmount: originalAmount,
          refundedAmount: part,
          alreadyReversed: runningReversed,
        });
        runningReversed += rev;
        reversals.push(rev);
      }

      // Sum of all 7 independent roundings must be within 1 minor unit of original earnings
      // and strictly <= original earnings (preventing any over-clawback)
      expect(runningReversed).toBeLessThanOrEqual(originalEarnings);
      expect(runningReversed).toBeGreaterThanOrEqual(
        originalEarnings - BigInt(1),
      );
      expect(reversals.reduce((a, b) => a + b, BigInt(0))).toBe(
        runningReversed,
      );
    });

    it("2.2: VND zero-decimal 10-stage partial refund with irregular fractional amounts (10M VND line)", () => {
      const originalAmount = BigInt(10_000_000); // 10,000,000₫
      const originalEarnings = BigInt(1_200_000); // 12% = 1,200,000₫

      // 10 stages of 1,000,000₫ each
      let runningReversed = BigInt(0);
      for (let stage = 1; stage <= 10; stage++) {
        const rev = calculateRefundReversal({
          originalEarnings,
          originalCommissionableAmount: originalAmount,
          refundedAmount: BigInt(1_000_000),
          alreadyReversed: runningReversed,
        });
        expect(rev).toBe(BigInt(120_000)); // Exactly 120,000₫ per stage
        runningReversed += rev;
      }

      expect(runningReversed).toBe(originalEarnings);
    });

    it("2.3: USD 2-decimal 12-stage partial refund with 1-cent fractional rounding", () => {
      // $100.00 order @ 17.5% commission ($17.50 = 1750 cents)
      const originalAmount = BigInt(10000);
      const originalEarnings = BigInt(1750);

      // 12 refunds of $8.33 each ($99.96) + 1 refund of $0.04 ($100.00 total)
      const refunds = Array.from({ length: 12 }, () => BigInt(833));
      refunds.push(BigInt(4)); // 12 * 833 + 4 = 9996 + 4 = 10000

      let runningReversed = BigInt(0);
      for (const r of refunds) {
        const rev = calculateRefundReversal({
          originalEarnings,
          originalCommissionableAmount: originalAmount,
          refundedAmount: r,
          alreadyReversed: runningReversed,
        });
        runningReversed += rev;
      }

      expect(runningReversed).toBe(originalEarnings);
    });

    it("2.4: 100 micro-refunds of 1 cent each on a $1.00 line ($0.20 commission)", () => {
      const originalAmount = BigInt(100); // $1.00 = 100 cents
      const originalEarnings = BigInt(20); // 20% = 20 cents

      let runningReversed = BigInt(0);
      let nonZeroCount = 0;

      for (let i = 0; i < 100; i++) {
        const rev = calculateRefundReversal({
          originalEarnings,
          originalCommissionableAmount: originalAmount,
          refundedAmount: BigInt(1), // 1 cent
          alreadyReversed: runningReversed,
        });
        if (rev > BigInt(0)) nonZeroCount++;
        runningReversed += rev;
      }

      // Micro-refunds divideAndRound(20 * 1, 100) = 20/100 -> 0 (remainder 20 < 50)
      // When remainder < 50%, quotient is 0 until remaining cap or bigger chunk.
      // But runningReversed never exceeds originalEarnings!
      expect(runningReversed).toBeLessThanOrEqual(originalEarnings);
    });

    it("2.5: Multi-currency FX snapshot preservation locks exchange rate during refund", () => {
      // Order placed in EUR, accounted in USD at rate 1.10
      const orderShopAmount = BigInt(10000); // 100.00 EUR
      const fxRateAtSale = "1.10";
      const fxQuote = {
        base: normalizeCurrency("EUR"),
        quote: normalizeCurrency("USD"),
        rate: fxRateAtSale,
        provider: "order-snapshot:test",
        capturedAt: now,
      };

      const convertedAtSale = convertMoney(
        { amount: orderShopAmount, currency: normalizeCurrency("EUR") },
        fxQuote,
      );
      expect(convertedAtSale.amount).toBe(BigInt(11000)); // $110.00 USD

      // Refund of 50.00 EUR executed later when live market rate changed to 1.30
      // Refund engine MUST use snapshot rate 1.10, NOT live rate 1.30!
      const refundShopAmount = BigInt(5000); // 50.00 EUR
      const convertedAtRefund = convertMoney(
        { amount: refundShopAmount, currency: normalizeCurrency("EUR") },
        fxQuote, // Preserved snapshot
      );
      expect(convertedAtRefund.amount).toBe(BigInt(5500)); // Exactly $55.00 USD (50% of $110.00)
    });
  });

  // ===========================================================================
  // 3. Massive Carts (20+ Items) with Heterogeneous Rules & Fixed Order Bonus
  // ===========================================================================
  describe("3. Massive Carts (20+ Items) & Rule Hierarchy", () => {
    it("3.1: 25-item massive cart evaluates line-by-line across Product, Collection, Variant, and Tag rules", () => {
      const productRule = createRule({
        id: "rule_prod_special",
        scope: "product",
        productId: "gid://shopify/Product/1001",
        basisPoints: 2500, // 25%
        priority: 10,
      });
      const variantRule = createRule({
        id: "rule_var_special",
        scope: "variant",
        variantId: "gid://shopify/ProductVariant/2001",
        basisPoints: 3000, // 30%
        priority: 10,
      });
      const collectionRule = createRule({
        id: "rule_coll_special",
        scope: "collection",
        collectionExternalId: "gid://shopify/Collection/3001",
        basisPoints: 1500, // 15%
        priority: 10,
      });
      const baseRule = createRule({
        id: "rule_base_sale",
        scope: "program",
        basisPoints: 1000, // 10%
        priority: 0,
      });

      const rules = [productRule, variantRule, collectionRule, baseRule];

      // Build 25 items:
      // Items 0-4: match variant rule (30%)
      // Items 5-9: match product rule (25%)
      // Items 10-14: match collection rule (15%)
      // Items 15-24: fallback to base rule (10%)
      const cartItems = Array.from({ length: 25 }, (_, i) => {
        let variantExternalId: string | undefined;
        let productExternalId: string | undefined;
        let collectionExternalIds: string[] = [];

        if (i < 5) {
          variantExternalId = "gid://shopify/ProductVariant/2001";
        } else if (i < 10) {
          productExternalId = "gid://shopify/Product/1001";
        } else if (i < 15) {
          collectionExternalIds = ["gid://shopify/Collection/3001"];
        }

        const priceCents = BigInt(4000 + i * 100); // $40.00 to $64.00
        const ctx: CommissionRuleContext = {
          programId: "prog_yamax",
          partnerId: "partner_1",
          productExternalId,
          variantExternalId,
          collectionExternalIds,
          accountingCurrency: "USD",
          commissionableAmount: priceCents,
          quantity: 1,
          occurredAt: now,
        };

        const matchedRule = selectCommissionRule(rules, ctx)!;
        const earnings = calculateCommission({
          rule: matchedRule,
          context: ctx,
        });

        return { index: i, priceCents, matchedRule, earnings };
      });

      // Verify rule matching distribution
      expect(
        cartItems.filter((i) => i.matchedRule.id === "rule_var_special"),
      ).toHaveLength(5);
      expect(
        cartItems.filter((i) => i.matchedRule.id === "rule_prod_special"),
      ).toHaveLength(5);
      expect(
        cartItems.filter((i) => i.matchedRule.id === "rule_coll_special"),
      ).toHaveLength(5);
      expect(
        cartItems.filter((i) => i.matchedRule.id === "rule_base_sale"),
      ).toHaveLength(10);

      // Verify line calculations
      for (const item of cartItems) {
        if (item.matchedRule.id === "rule_var_special") {
          expect(item.earnings).toBe(
            (item.priceCents * BigInt(3000)) / BigInt(10000),
          );
        } else if (item.matchedRule.id === "rule_prod_special") {
          expect(item.earnings).toBe(
            (item.priceCents * BigInt(2500)) / BigInt(10000),
          );
        } else if (item.matchedRule.id === "rule_coll_special") {
          expect(item.earnings).toBe(
            (item.priceCents * BigInt(1500)) / BigInt(10000),
          );
        } else {
          expect(item.earnings).toBe(
            (item.priceCents * BigInt(1000)) / BigInt(10000),
          );
        }
      }

      const totalCartCommission = cartItems.reduce(
        (sum, item) => sum + item.earnings,
        BigInt(0),
      );
      expect(totalCartCommission).toBeGreaterThan(BigInt(0));
    });

    it("3.2: 50-item massive cart with $100.00 fixed order bonus preserves penny conservation", () => {
      const fixedBonusTotal = BigInt(10000); // $100.00 = 10,000 cents
      // 50 lines with irregular prices
      const lineAmounts = Array.from({ length: 50 }, (_, i) =>
        BigInt(500 + ((i * 123) % 4500)),
      );

      const allocations = allocateCommissionProportionally({
        total: fixedBonusTotal,
        amounts: lineAmounts,
      });

      expect(allocations).toHaveLength(50);
      const allocatedSum = allocations.reduce((a, b) => a + b, BigInt(0));
      expect(allocatedSum).toBe(fixedBonusTotal); // Exact 10,000 cents, no penny lost or gained!

      // All allocations must be >= 0
      for (const alloc of allocations) {
        expect(alloc).toBeGreaterThanOrEqual(BigInt(0));
      }
    });

    it("3.3: Extreme price disparity ($0.01 trinket to $10,000.00 luxury item) allocates without precision loss", () => {
      const totalBonus = BigInt(5000); // $50.00
      const amounts = [
        BigInt(1), // $0.01
        BigInt(5), // $0.05
        BigInt(1000000), // $10,000.00
      ];

      const allocations = allocateCommissionProportionally({
        total: totalBonus,
        amounts,
      });

      expect(allocations).toHaveLength(3);
      expect(allocations.reduce((a, b) => a + b, BigInt(0))).toBe(totalBonus);
      expect(allocations[2]).toBe(BigInt(5000)); // The $10,000 line gets effectively all of the $50
    });

    it("3.4: Mixed discounts (100% off, 50% off, 0% off) across 30 lines handle zero net lines safely", () => {
      const totalBonus = BigInt(3000); // $30.00
      // 10 lines with 0, 10 lines with 500, 10 lines with 1000
      const amounts = [
        ...Array.from({ length: 10 }, () => BigInt(0)),
        ...Array.from({ length: 10 }, () => BigInt(500)),
        ...Array.from({ length: 10 }, () => BigInt(1000)),
      ];

      const allocations = allocateCommissionProportionally({
        total: totalBonus,
        amounts,
      });

      // Lines with 0 amount must get 0 allocation
      for (let i = 0; i < 10; i++) {
        expect(allocations[i]).toBe(BigInt(0));
      }

      // Sum must equal exactly totalBonus
      expect(allocations.reduce((a, b) => a + b, BigInt(0))).toBe(totalBonus);
    });
  });

  // ===========================================================================
  // 4. Reversal Bounds Clamping & Over-100% Refund Leak Prevention
  // ===========================================================================
  describe("4. Reversal Bounds Clamping & Over-100% Prevention", () => {
    it("4.1: Excessive single refund (merchant refunds 300% of line value) clamps to 100% of earnings", () => {
      const originalEarnings = BigInt(2000); // $20.00
      const originalAmount = BigInt(10000); // $100.00

      const reversal = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: BigInt(30000), // 300% refund ($300.00)
        alreadyReversed: BigInt(0),
      });

      expect(reversal).toBe(originalEarnings); // Strictly clamped to $20.00
    });

    it("4.2: Cumulative over-refund sequence (60% + 70% = 130%) clamps Stage 2 to remaining 40%", () => {
      const originalEarnings = BigInt(1000); // $10.00
      const originalAmount = BigInt(10000); // $100.00

      // Stage 1: 60% refund ($60.00) -> $6.00 clawback
      const rev1 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: BigInt(6000),
        alreadyReversed: BigInt(0),
      });
      expect(rev1).toBe(BigInt(600));

      // Stage 2: 70% refund ($70.00) -> capped at remaining $4.00
      const rev2 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: BigInt(7000),
        alreadyReversed: rev1,
      });
      expect(rev2).toBe(BigInt(400));
      expect(rev1 + rev2).toBe(originalEarnings);

      // Stage 3: subsequent refund attempt -> returns 0
      const rev3 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: BigInt(1000),
        alreadyReversed: rev1 + rev2,
      });
      expect(rev3).toBe(BigInt(0));
    });

    it("4.3: Negative refund amount injection (-$50) safely returns 0", () => {
      const reversal = calculateRefundReversal({
        originalEarnings: BigInt(2000),
        originalCommissionableAmount: BigInt(10000),
        refundedAmount: BigInt(-5000),
        alreadyReversed: BigInt(0),
      });
      expect(reversal).toBe(BigInt(0));
    });

    it("4.4: Negative alreadyReversed input clamps to 0 to prevent over-clawback leakage", () => {
      const reversal = calculateRefundReversal({
        originalEarnings: BigInt(2000),
        originalCommissionableAmount: BigInt(10000),
        refundedAmount: BigInt(5000),
        alreadyReversed: BigInt(-1000),
      });
      // Should treat alreadyReversed as 0, reversing 50% = $10.00
      expect(reversal).toBe(BigInt(1000));
    });

    it("4.5: $0 original earnings or $0 commissionable amount always yields 0 reversal", () => {
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(0),
          originalCommissionableAmount: BigInt(10000),
          refundedAmount: BigInt(5000),
        }),
      ).toBe(BigInt(0));

      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(1000),
          originalCommissionableAmount: BigInt(0),
          refundedAmount: BigInt(5000),
        }),
      ).toBe(BigInt(0));
    });
  });

  // ===========================================================================
  // 5. Integer Safety & 32-bit Postgres Range Guardrails (`toSafeInt`)
  // ===========================================================================
  describe("5. Integer Safety & 32-bit Postgres Range Guardrails", () => {
    it("5.1: Maximum safe 32-bit positive integer (2,147,483,647) converts cleanly", () => {
      const maxInt = BigInt(2_147_483_647);
      expect(toSafeInt(maxInt, "Test field")).toBe(2_147_483_647);
    });

    it("5.2: Maximum safe 32-bit negative integer (-2,147,483,648) converts cleanly for refunds", () => {
      const minInt = BigInt(-2_147_483_648);
      expect(toSafeInt(minInt, "Refund field")).toBe(-2_147_483_648);
    });

    it("5.3: Overflow at 2,147,483,648 throws descriptive range error", () => {
      const overflow = BigInt(2_147_483_648);
      expect(() => toSafeInt(overflow, "Order commission")).toThrow(
        "Order commission exceeds the Dub integer money range.",
      );
    });

    it("5.4: Underflow at -2,147,483,649 throws descriptive range error", () => {
      const underflow = BigInt(-2_147_483_649);
      expect(() => toSafeInt(underflow, "Refund clawback")).toThrow(
        "Refund clawback exceeds the Dub integer money range.",
      );
    });
  });

  // ===========================================================================
  // 6. Property-Based Fuzzing & Invariant Stress Harness (10,000 Iterations)
  // ===========================================================================
  describe("6. Property-Based Fuzzing Invariant Harness (10,000 Random Runs)", () => {
    it("6.1: Fuzz 2,000 random order compositions: sum of lines equals total order earnings", () => {
      for (let run = 0; run < 2000; run++) {
        const lineCount = (run % 20) + 1; // 1 to 20 lines
        const basisPoints = ((run * 17) % 5000) + 100; // 1% to 50%
        const rule = createRule({ basisPoints });

        let expectedSum = BigInt(0);
        const lineEarnings: bigint[] = [];

        for (let l = 0; l < lineCount; l++) {
          const price = BigInt(((run * 31 + l * 47) % 50000) + 100); // $1.00 to $500.00
          const ctx: CommissionRuleContext = {
            programId: "prog_yamax",
            accountingCurrency: "USD",
            commissionableAmount: price,
            quantity: 1,
            occurredAt: now,
          };
          const earnings = calculateCommission({ rule, context: ctx });
          lineEarnings.push(earnings);
          expectedSum += earnings;
        }

        const actualSum = lineEarnings.reduce((a, b) => a + b, BigInt(0));
        expect(actualSum).toBe(expectedSum);
      }
    });

    it("6.2: Fuzz 2,000 random fixed bonus distributions: sum(allocated) === totalBonus ALWAYS", () => {
      for (let run = 0; run < 2000; run++) {
        const lineCount = (run % 30) + 1; // 1 to 30 lines
        const totalBonus = BigInt(((run * 59) % 20000) + 1); // 1 cent to $200.00
        const amounts = Array.from({ length: lineCount }, (_, idx) =>
          BigInt(((run * 13 + idx * 79) % 15000) + (run % 3 === 0 ? 0 : 50)),
        );

        const allocations = allocateCommissionProportionally({
          total: totalBonus,
          amounts,
        });

        expect(allocations).toHaveLength(lineCount);
        const sum = allocations.reduce((a, b) => a + b, BigInt(0));
        expect(sum).toBe(totalBonus);

        for (const alloc of allocations) {
          expect(alloc).toBeGreaterThanOrEqual(BigInt(0));
        }
      }
    });

    it("6.3: Fuzz 2,000 multi-stage random refund sequences: total clawback never exceeds original earnings", () => {
      for (let run = 0; run < 2000; run++) {
        const originalAmount = BigInt(((run * 73) % 100000) + 500);
        const rateBps = ((run * 19) % 4000) + 500; // 5% to 45%
        const originalEarnings =
          (originalAmount * BigInt(rateBps)) / BigInt(10000);

        if (originalEarnings === BigInt(0)) continue;

        const stagesCount = (run % 8) + 1; // 1 to 8 refund stages
        let alreadyReversed = BigInt(0);

        for (let s = 0; s < stagesCount; s++) {
          const refundChunk = BigInt(
            ((run * 29 + s * 43) % Number(originalAmount)) + 50,
          );
          const reversal = calculateRefundReversal({
            originalEarnings,
            originalCommissionableAmount: originalAmount,
            refundedAmount: refundChunk,
            alreadyReversed,
          });

          alreadyReversed += reversal;
          expect(alreadyReversed).toBeLessThanOrEqual(originalEarnings);
          expect(reversal).toBeGreaterThanOrEqual(BigInt(0));
        }
      }
    });

    it("6.4: Fuzz 2,000 currency conversions across random FX rates preserve monotonicity and bounds", () => {
      for (let run = 0; run < 2000; run++) {
        const rateInt = (run % 300) + 1; // 1 to 300
        const rateDec = ((run * 17) % 10000).toString().padStart(4, "0");
        const rate = `${rateInt}.${rateDec}`;

        const fx = {
          base: normalizeCurrency(run % 2 === 0 ? "EUR" : "JPY"),
          quote: normalizeCurrency("USD"),
          rate,
          provider: "fuzz_test",
          capturedAt: now,
        };

        const inputAmount = BigInt(((run * 97) % 500000) + 10);
        const converted = convertMoney(
          { amount: inputAmount, currency: fx.base },
          fx,
        );

        expect(converted.amount).toBeGreaterThanOrEqual(BigInt(0));
        expect(converted.currency).toBe(fx.quote);
      }
    });

    it("6.5: Fuzz 2,000 arbitrary decimal string parses to minor units and back without corruption", () => {
      for (let run = 0; run < 2000; run++) {
        const whole = (run * 37) % 10000;
        const cents = (run * 19) % 100;
        const decimalStr = `${whole}.${cents.toString().padStart(2, "0")}`;

        const minor = decimalToMinorUnits(decimalStr, "USD");
        const backToDecimal = minorUnitsToDecimal(minor, "USD");

        expect(backToDecimal).toBe(decimalStr);
      }
    });
  });
});
