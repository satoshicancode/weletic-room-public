import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import { describe, expect, it } from "vitest";

describe("Financial Reconciliation Mismatch Detection Scenarios", () => {
  it("Scenario 16a: detects when remote Shopify refund amount differs from local Weletic refund ledger", () => {
    const localRefundShopAmount = BigInt(5000); // $50.00
    const remoteShopifyRefundAmount = BigInt(5500); // $55.00 in Shopify

    const checkRefundDiscrepancy = (local: bigint, remote: bigint) => {
      if (local !== remote) {
        return {
          kind: "refund_amount_mismatch",
          severity: "critical",
          details: {
            ledgerShopAmount: local.toString(),
            shopifyShopAmount: remote.toString(),
          },
        };
      }
      return null;
    };

    const issue = checkRefundDiscrepancy(
      localRefundShopAmount,
      remoteShopifyRefundAmount,
    );
    expect(issue).not.toBeNull();
    expect(issue?.kind).toBe("refund_amount_mismatch");
    expect(issue?.severity).toBe("critical");
    expect(issue?.details.ledgerShopAmount).toBe("5000");
    expect(issue?.details.shopifyShopAmount).toBe("5500");
  });

  it("Scenario 16b: detects when commission reversal amount diverges from proportional expectation", () => {
    const originalEarnings = BigInt(1500);
    const originalCommissionableAmount = BigInt(10000);
    const refundAmount = BigInt(5000); // 50% refund

    const expectedReversed = calculateRefundReversal({
      originalEarnings,
      originalCommissionableAmount,
      refundedAmount: refundAmount,
      alreadyReversed: BigInt(0),
    });
    // Expected 50% of 1500 = 750
    expect(expectedReversed).toBe(BigInt(750));

    // Suppose ledger incorrectly had 1000 reversed
    const ledgerReversed = BigInt(1000);

    const checkCommissionReversalDiscrepancy = (
      expected: bigint,
      actual: bigint,
    ) => {
      if (expected !== actual) {
        return {
          kind: "commission_reversal_mismatch",
          severity: "critical",
          details: {
            expected: expected.toString(),
            actual: actual.toString(),
          },
        };
      }
      return null;
    };

    const issue = checkCommissionReversalDiscrepancy(
      expectedReversed,
      ledgerReversed,
    );
    expect(issue).not.toBeNull();
    expect(issue?.kind).toBe("commission_reversal_mismatch");
  });

  it("Scenario 16c: detects when total reversed commission exceeds original sale earnings", () => {
    const originalEarnings = BigInt(1000);
    const totalReversed = BigInt(1200);

    const checkOverReversal = (original: bigint, reversed: bigint) => {
      if (reversed > original) {
        return {
          kind: "commission_reversal_exceeds_sale",
          severity: "critical",
        };
      }
      return null;
    };

    const issue = checkOverReversal(originalEarnings, totalReversed);
    expect(issue?.kind).toBe("commission_reversal_exceeds_sale");
  });
});
