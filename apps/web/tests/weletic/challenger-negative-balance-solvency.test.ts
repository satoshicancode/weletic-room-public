import { describe, expect, it } from "vitest";
import {
  InMemoLoyaltySimulator,
  calculateLineCumulativeQuantityFloorClawback,
  parseCliArgs,
  runCheckoutRefundMatrixValidation,
} from "../../scripts/loyalty/validate-checkout-refund-matrix";

describe("Challenger 2 Empirical Stress Suite: CLI Runner & Insolvent Lifecycle State Transitions", () => {
  describe("1. CLI Flags, Provenance & Robustness", () => {
    it("parses CLI flags correctly and defaults gracefully", () => {
      const parsed1 = parseCliArgs([
        "--dry-run",
        "--json",
        "--store=mystore.myshopify.com",
      ]);
      expect(parsed1.dryRun).toBe(true);
      expect(parsed1.json).toBe(true);
      expect(parsed1.storeDomain).toBe("mystore.myshopify.com");

      const parsed2 = parseCliArgs(["--mock", "--report=/tmp/my-report.json"]);
      expect(parsed2.mock).toBe(true);
      expect(parsed2.outputReportPath).toBe("/tmp/my-report.json");

      // Unknown flags do not break parsing
      const parsed3 = parseCliArgs([
        "--unknown-flag",
        "--another-unknown=true",
      ]);
      expect(parsed3.dryRun).toBeUndefined();
      expect(parsed3.mock).toBeUndefined();
    });

    it("runs validation in --dry-run mode and outputs structured report with local-static provenance", async () => {
      const report = await runCheckoutRefundMatrixValidation({ dryRun: true });
      expect(report.version).toBe(1);
      expect(report.executionMode).toBe("dry-run");
      expect(report.overallStatus).toBe("PASSED");
      expect(report.provenance.source).toBe("local-static");
      expect(report.provenance.live).toBe(false);
      expect(report.summary.totalChecks).toBeGreaterThanOrEqual(12);
      expect(report.summary.failedChecks).toBe(0);
    });

    it("runs validation in --mock mode and outputs structured report with simulated provenance", async () => {
      const report = await runCheckoutRefundMatrixValidation({ mock: true });
      expect(report.version).toBe(1);
      expect(report.executionMode).toBe("mock");
      expect(report.overallStatus).toBe("PASSED");
      expect(report.provenance.source).toBe("simulated");
      expect(report.provenance.live).toBe(false);
      expect(report.summary.totalChecks).toBeGreaterThanOrEqual(12);
      expect(report.summary.failedChecks).toBe(0);
    });

    it("enforces safety gates in live mode: rejects missing --confirm-staging", async () => {
      await expect(
        runCheckoutRefundMatrixValidation({
          live: true,
          storeDomain: "n0pvef-cs.myshopify.com",
        }),
      ).rejects.toThrow(
        "Missing mandatory --confirm-staging flag for live validation.",
      );
    });

    it("enforces safety gates in live mode: rejects non-myshopify domain", async () => {
      await expect(
        runCheckoutRefundMatrixValidation({
          live: true,
          confirmStaging: true,
          storeDomain: "invalid-domain.com",
        }),
      ).rejects.toThrow(
        "A canonical myshopify.com test-store domain is required for live validation.",
      );
    });
  });

  describe("2. Negative Points Balance & Account Solvency Stress Harness", () => {
    it("stress-tests extreme deficit (-1,000,000 points) across 500 micro-earns (+100 pts) with exact CAS monotonicity & redemption blocking", () => {
      const sim = new InMemoLoyaltySimulator("store_stress_deficit");
      const customer = sim.createAccount("cust_extreme_deficit", BigInt(0));

      // 1. Force account into extreme deficit (-1,000,000 points) via massive refund reversal
      const deficitEntry = sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(-1000000),
        idempotencyKey: "massive_refund_1m",
      });

      expect(deficitEntry.balanceAfter).toBe(BigInt(-1000000));
      expect(customer.cachedPointsBalance).toBe(BigInt(-1000000));
      expect(customer.ledgerVersion).toBe(1);
      expect(customer.nextExpiryDate).toBeNull(); // No expiry while in deficit

      // 2. Perform 500 micro-earns (+100 points each)
      const numMicroEarns = 500;
      let expectedBalance = BigInt(-1000000);
      let expectedVersion = 1;

      for (let i = 1; i <= numMicroEarns; i++) {
        const delta = BigInt(100);
        expectedBalance += delta;
        expectedVersion += 1;

        const earnEntry = sim.appendLedgerEntry({
          accountId: customer.id,
          entryType: "EARN_ORDER",
          pointsDelta: delta,
          idempotencyKey: `micro_earn_${i}`,
        });

        // Exact arithmetic check
        expect(earnEntry.pointsDelta).toBe(delta);
        expect(earnEntry.balanceAfter).toBe(expectedBalance);
        expect(customer.cachedPointsBalance).toBe(expectedBalance);

        // Strict OCC CAS monotonicity check
        expect(earnEntry.sequenceNumber).toBe(expectedVersion);
        expect(customer.ledgerVersion).toBe(expectedVersion);

        // Redemption blocking invariant check:
        // Must reject redemption while in deficit, without corrupting state or incrementing version
        expect(() => {
          sim.provisionRedemption({
            accountId: customer.id,
            rewardType: "amount_off",
            discountCode: `ATTEMPT_REDEEM_${i}`,
            pointsCost: BigInt(50),
            idempotencyKey: `blocked_attempt_${i}`,
          });
        }).toThrow(/Insufficient points balance/);

        expect(customer.cachedPointsBalance).toBe(expectedBalance);
        expect(customer.ledgerVersion).toBe(expectedVersion);
        expect(customer.nextExpiryDate).toBeNull();
      }

      // Final state after 500 micro-earns: -1,000,000 + 50,000 = -950,000
      expect(customer.cachedPointsBalance).toBe(BigInt(-950000));
      expect(customer.ledgerVersion).toBe(501);
      expect(sim.ledgerEntries.length).toBe(501);
    });

    it("verifies solvency boundary transition: debt cleared exactly to 0 blocks redemption, positive balance enables redemption", () => {
      const sim = new InMemoLoyaltySimulator("store_solvency_boundary");
      const customer = sim.createAccount("cust_boundary", BigInt(0));

      // Plunge into deficit of -200 points
      sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(-200),
        idempotencyKey: "init_deficit_200",
      });
      expect(customer.cachedPointsBalance).toBe(BigInt(-200));

      // Earn +200 points: balance reaches EXACTLY 0
      const earnZero = sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(200),
        idempotencyKey: "earn_to_zero",
      });
      expect(earnZero.balanceAfter).toBe(BigInt(0));
      expect(customer.cachedPointsBalance).toBe(BigInt(0));
      expect(customer.nextExpiryDate).toBeNull();

      // At exactly 0 points balance: redemption of even 1 point MUST fail
      expect(() => {
        sim.provisionRedemption({
          accountId: customer.id,
          rewardType: "amount_off",
          discountCode: "ZERO_BAL_REDEEM",
          pointsCost: BigInt(1),
          idempotencyKey: "redeem_at_zero",
        });
      }).toThrow(/Insufficient points balance/);
      expect(customer.cachedPointsBalance).toBe(BigInt(0));

      // Earn +150 points: balance becomes positive (+150)
      const earnPositive = sim.appendLedgerEntry({
        accountId: customer.id,
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(150),
        idempotencyKey: "earn_positive_150",
      });
      expect(earnPositive.balanceAfter).toBe(BigInt(150));
      expect(customer.cachedPointsBalance).toBe(BigInt(150));
      expect(customer.nextExpiryDate).not.toBeNull(); // Expiry scheduled!

      // Now redemption is allowed for 100 points
      const redemption = sim.provisionRedemption({
        accountId: customer.id,
        rewardType: "amount_off",
        discountCode: "SOLVENT_REDEEM_100",
        pointsCost: BigInt(100),
        idempotencyKey: "redeem_when_solvent",
      });
      expect(redemption.status).toBe("issued");
      expect(customer.cachedPointsBalance).toBe(BigInt(50));
      expect(customer.ledgerVersion).toBe(4);

      // Subsequent redemption exceeding available balance (+50 available, request 100) must fail
      expect(() => {
        sim.provisionRedemption({
          accountId: customer.id,
          rewardType: "amount_off",
          discountCode: "EXCEED_AVAIL",
          pointsCost: BigInt(100),
          idempotencyKey: "redeem_exceed_available",
        });
      }).toThrow(/Insufficient points balance/);
      expect(customer.cachedPointsBalance).toBe(BigInt(50));
      expect(customer.ledgerVersion).toBe(4);
    });
  });

  describe("3. Coupon Non-Recrediting Invariant Under Refund Webhooks", () => {
    const rewardTypes = [
      {
        type: "percentage_off" as const,
        code: "COUPON_PCT_20",
        cost: BigInt(300),
      },
      {
        type: "free_shipping" as const,
        code: "COUPON_SHIP_FREE",
        cost: BigInt(150),
      },
      {
        type: "free_product" as const,
        code: "COUPON_BXGY_FREE",
        cost: BigInt(500),
      },
      {
        type: "amount_off" as const,
        code: "COUPON_FLAT_50",
        cost: BigInt(250),
      },
    ];

    for (const reward of rewardTypes) {
      it(`enforces non-recrediting invariant for ${reward.type}: coupon remains used and wallet is not re-credited after partial & full refunds`, () => {
        const sim = new InMemoLoyaltySimulator(
          `store_non_recredit_${reward.type}`,
        );
        const customer = sim.createAccount(`cust_${reward.type}`, BigInt(1000));

        // 1. Provision coupon
        const redemption = sim.provisionRedemption({
          accountId: customer.id,
          rewardType: reward.type,
          discountCode: reward.code,
          pointsCost: reward.cost,
          idempotencyKey: `redemp_${reward.code}`,
        });
        expect(customer.cachedPointsBalance).toBe(BigInt(1000) - reward.cost);
        expect(redemption.status).toBe("issued");

        // 2. Orders/Paid webhook arrives: settles coupon to used and binds orderId
        const orderId = `order_${reward.type}_999`;
        const usedAt = new Date("2026-09-02T12:00:00Z");
        const settlement = sim.settleRedemptionsUsedByOrder({
          discountCodes: [reward.code],
          shopifyCustomerId: customer.shopifyCustomerId,
          orderId,
          usedAt,
        });
        expect(settlement.settled).toHaveLength(1);
        expect(redemption.status).toBe("used");
        expect(redemption.orderId).toBe(orderId);
        expect(redemption.usedAt).toEqual(usedAt);

        // 3. Order earns points
        const earnedPoints = BigInt(200);
        sim.appendLedgerEntry({
          accountId: customer.id,
          entryType: "EARN_ORDER",
          pointsDelta: earnedPoints,
          idempotencyKey: `earn_${orderId}`,
          orderId,
        });
        const balanceBeforeRefund = customer.cachedPointsBalance;

        // 4. Simulate Partial Refund webhook (50% return: clawback 100 points)
        const partialRefundId = `refund_partial_${orderId}`;
        sim.appendLedgerEntry({
          accountId: customer.id,
          entryType: "REFUND_REVERSAL",
          pointsDelta: BigInt(-100),
          idempotencyKey: `refund_${partialRefundId}`,
          refundId: partialRefundId,
        });

        // Assert coupon state remains untouched after partial refund
        const couponAfterPartial = sim.redemptions.get(redemption.id)!;
        expect(couponAfterPartial.status).toBe("used");
        expect(couponAfterPartial.orderId).toBe(orderId);
        expect(customer.cachedPointsBalance).toBe(
          balanceBeforeRefund - BigInt(100),
        );

        // 5. Simulate Full Refund remainder webhook (remaining 100 points clawback)
        const fullRefundId = `refund_full_${orderId}`;
        sim.appendLedgerEntry({
          accountId: customer.id,
          entryType: "REFUND_REVERSAL",
          pointsDelta: BigInt(-100),
          idempotencyKey: `refund_${fullRefundId}`,
          refundId: fullRefundId,
        });

        // NON-RECREDITING INVARIANT:
        // Coupon status MUST remain used
        const couponAfterFull = sim.redemptions.get(redemption.id)!;
        expect(couponAfterFull.status).toBe("used");
        expect(couponAfterFull.orderId).toBe(orderId);
        expect(couponAfterFull.usedAt).toEqual(usedAt);

        // Customer wallet balance must NOT contain any refund of pointsCost
        // Balance = 1000 - cost + 200 - 100 - 100 = 1000 - cost
        expect(customer.cachedPointsBalance).toBe(BigInt(1000) - reward.cost);

        // 6. Simulate duplicate webhook replay
        const duplicateEntry = sim.appendLedgerEntry({
          accountId: customer.id,
          entryType: "REFUND_REVERSAL",
          pointsDelta: BigInt(-100),
          idempotencyKey: `refund_${fullRefundId}`,
          refundId: fullRefundId,
        });
        expect(duplicateEntry.idempotencyKey).toBe(`refund_${fullRefundId}`);
        expect(customer.cachedPointsBalance).toBe(BigInt(1000) - reward.cost);
        expect(couponAfterFull.status).toBe("used");
      });
    }
  });

  describe("4. Cumulative Quantity Floor Boundary Cases", () => {
    it("handles zero quantity or zero amount lines safely without NaN or division by zero", () => {
      const line = {
        id: "zero_line",
        orderLineId: "shopify_zero_line",
        lineQuantity: BigInt(0),
        lineGrossAmount: BigInt(0),
        lineDiscountAmount: BigInt(0),
        lineNetAmount: BigInt(0),
        awardedPoints: BigInt(0),
        reversedPoints: BigInt(0),
        isExcluded: false,
      };

      const result = calculateLineCumulativeQuantityFloorClawback({
        line,
        cumulativeRefundAmount: BigInt(0),
        cumulativeRefundQuantity: BigInt(0),
      });

      expect(result.lineClawback).toBe(BigInt(0));
      expect(result.amountTarget).toBe(BigInt(0));
      expect(result.quantityTarget).toBe(BigInt(0));
    });

    it("clamps clawback strictly to line remaining capacity when cumulative target exceeds awarded", () => {
      const line = {
        id: "over_target_line",
        orderLineId: "shopify_over_line",
        lineQuantity: BigInt(2),
        lineGrossAmount: BigInt(10000),
        lineDiscountAmount: BigInt(0),
        lineNetAmount: BigInt(10000),
        awardedPoints: BigInt(100),
        reversedPoints: BigInt(70), // already reversed 70
        isExcluded: false,
      };

      // Refund claims 2 units (100% quantity target = 100)
      const result = calculateLineCumulativeQuantityFloorClawback({
        line,
        cumulativeRefundAmount: BigInt(10000),
        cumulativeRefundQuantity: BigInt(2),
      });

      // Remaining capacity is 100 - 70 = 30
      expect(result.boundedTarget).toBe(BigInt(100));
      expect(result.lineClawback).toBe(BigInt(30));
    });
  });
});
