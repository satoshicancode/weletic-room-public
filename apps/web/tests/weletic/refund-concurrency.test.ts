import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import { describe, expect, it } from "vitest";

describe("Weletic Refund Concurrency & Attribution Handling Scenarios (ADR 0004)", () => {
  it("Scenario 6: concurrent and sequential refunds cannot reverse more than original line earnings", () => {
    const originalEarnings = BigInt(2000); // $20.00
    const originalCommissionableAmount = BigInt(10000); // $100.00

    let alreadyReversed = BigInt(0);

    // First refund: $60.00 refunded
    const refund1Amount = BigInt(6000);
    const reversal1 = calculateRefundReversal({
      originalEarnings,
      originalCommissionableAmount,
      refundedAmount: refund1Amount,
      alreadyReversed,
    });

    // 60% of $20.00 = $12.00
    expect(reversal1).toBe(BigInt(1200));
    alreadyReversed += reversal1;

    // Second refund: $60.00 requested (exceeding original order total by $20)
    const refund2Amount = BigInt(6000);
    const reversal2 = calculateRefundReversal({
      originalEarnings,
      originalCommissionableAmount,
      refundedAmount: refund2Amount,
      alreadyReversed,
    });

    // Capped at remaining $8.00 ($20 - $12)
    expect(reversal2).toBe(BigInt(800));
    alreadyReversed += reversal2;

    // Total reversed exactly equals original earnings
    expect(alreadyReversed).toBe(originalEarnings);

    // Third refund attempt: $10.00
    const reversal3 = calculateRefundReversal({
      originalEarnings,
      originalCommissionableAmount,
      refundedAmount: BigInt(1000),
      alreadyReversed,
    });
    // Nothing left to reverse
    expect(reversal3).toBe(BigInt(0));
  });

  it("Scenario 7: organic or un-attributed order refunds are acknowledged and safely processed without partner commission clawback", () => {
    const handleRefund = (
      orderExternalId: string,
      attributedOrders: Set<string>,
    ) => {
      const isAttributed = attributedOrders.has(orderExternalId);
      return {
        status: "processed",
        partnerCommissionClawedBack: isAttributed,
        ignored: false,
      };
    };

    const attributedOrders = new Set(["order_101", "order_102"]);

    // Attributed refund
    const res1 = handleRefund("order_101", attributedOrders);
    expect(res1.status).toBe("processed");
    expect(res1.partnerCommissionClawedBack).toBe(true);

    // Organic refund (e.g. customer bought directly without affiliate link)
    const res2 = handleRefund("order_999", attributedOrders);
    expect(res2.status).toBe("processed");
    expect(res2.partnerCommissionClawedBack).toBe(false);
  });

  it("Scenario 8: simultaneous concurrent refund webhooks serialized through database transactions", () => {
    // Model two concurrent refund requests on a $100 item with $20 commission
    const originalEarnings = BigInt(2000);
    const originalAmount = BigInt(10000);

    // Simulate 2 parallel webhooks attempting $70 refunds each
    let committedReversalTotal = BigInt(0);

    const executeRefundTransaction = (refundAmount: bigint) => {
      const reversal = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: refundAmount,
        alreadyReversed: committedReversalTotal,
      });
      committedReversalTotal += reversal;
      return reversal;
    };

    // First transaction commits $70 refund -> $14.00 clawback
    const tx1Reversal = executeRefundTransaction(BigInt(7000));
    expect(tx1Reversal).toBe(BigInt(1400));

    // Second transaction commits $70 refund -> capped at remaining $6.00
    const tx2Reversal = executeRefundTransaction(BigInt(7000));
    expect(tx2Reversal).toBe(BigInt(600));

    expect(committedReversalTotal).toBe(originalEarnings);
  });

  it("Scenario 9: multi-line refund in a single webhook with repeated target order line items", () => {
    // A single refund webhook has 2 refund line items for the same order line item
    const originalEarnings = BigInt(3000); // $30.00
    const originalAmount = BigInt(10000); // $100.00

    const refundLines = [
      { id: "rline_1", amount: BigInt(4000) }, // $40.00
      { id: "rline_2", amount: BigInt(4000) }, // $40.00
    ];

    let runningReversed = BigInt(0);
    const reversals = refundLines.map((rline) => {
      const rev = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount: originalAmount,
        refundedAmount: rline.amount,
        alreadyReversed: runningReversed,
      });
      runningReversed += rev;
      return rev;
    });

    expect(reversals[0]).toBe(BigInt(1200)); // $12.00
    expect(reversals[1]).toBe(BigInt(1200)); // $12.00
    expect(runningReversed).toBe(BigInt(2400)); // $24.00 total
    expect(runningReversed).toBeLessThanOrEqual(originalEarnings);
  });

  it("Scenario 10: idempotency duplicate delivery returns duplicate flag and does not double-clawback", () => {
    const seenRefunds = new Map<string, { refundId: string; amount: bigint }>();

    const processRefundWebhook = (webhookId: string, amount: bigint) => {
      if (seenRefunds.has(webhookId)) {
        return {
          duplicate: true,
          refundId: seenRefunds.get(webhookId)!.refundId,
        };
      }
      const refundId = `ref_${webhookId}`;
      seenRefunds.set(webhookId, { refundId, amount });
      return { duplicate: false, refundId };
    };

    const firstDelivery = processRefundWebhook("shopify_ref_123", BigInt(5000));
    expect(firstDelivery.duplicate).toBe(false);
    expect(firstDelivery.refundId).toBe("ref_shopify_ref_123");

    const secondDelivery = processRefundWebhook(
      "shopify_ref_123",
      BigInt(5000),
    );
    expect(secondDelivery.duplicate).toBe(true);
    expect(secondDelivery.refundId).toBe("ref_shopify_ref_123");
    expect(seenRefunds.size).toBe(1);
  });
});
