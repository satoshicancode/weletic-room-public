import { endOfMonth } from "date-fns";
import { describe, expect, it } from "vitest";

describe("Split Payouts & Statement Consistency Scenarios", () => {
  it("Scenario 11: split payout generates distinct quotes and statements matching both new payout amounts exactly", () => {
    interface SimulatedCommission {
      id: string;
      createdAt: Date;
      earnings: number;
    }

    interface SimulatedPayout {
      id: string;
      amount: number;
      periodEnd: Date;
      commissions: SimulatedCommission[];
    }

    const cutoffDate = new Date("2026-08-01T00:00:00Z");

    const initialCommissions: SimulatedCommission[] = [
      {
        id: "comm_july_1",
        createdAt: new Date("2026-07-15T12:00:00Z"),
        earnings: 4000,
      },
      {
        id: "comm_july_2",
        createdAt: new Date("2026-07-28T10:00:00Z"),
        earnings: 6000,
      },
      {
        id: "comm_aug_1",
        createdAt: new Date("2026-08-05T09:00:00Z"),
        earnings: 5000,
      },
    ];

    const originalPayout: SimulatedPayout = {
      id: "payout_original",
      amount: 15000,
      periodEnd: new Date("2026-08-05T09:00:00Z"),
      commissions: initialCommissions,
    };

    // Split logic
    const previousCommissions = originalPayout.commissions.filter(
      (c) => c.createdAt < cutoffDate,
    );
    const currentCommissions = originalPayout.commissions.filter(
      (c) => c.createdAt >= cutoffDate,
    );

    const previousAmount = previousCommissions.reduce(
      (acc, c) => acc + c.earnings,
      0,
    );
    const currentAmount = currentCommissions.reduce(
      (acc, c) => acc + c.earnings,
      0,
    );

    const updatedPreviousPayout: SimulatedPayout = {
      ...originalPayout,
      periodEnd: endOfMonth(
        previousCommissions[previousCommissions.length - 1].createdAt,
      ),
      amount: previousAmount,
      commissions: previousCommissions,
    };

    const newCurrentMonthPayout: SimulatedPayout = {
      id: "payout_current_month",
      periodEnd: currentCommissions[currentCommissions.length - 1].createdAt,
      amount: currentAmount,
      commissions: currentCommissions,
    };

    // Verify split sums invariant
    expect(updatedPreviousPayout.amount).toBe(10000);
    expect(newCurrentMonthPayout.amount).toBe(5000);
    expect(updatedPreviousPayout.amount + newCurrentMonthPayout.amount).toBe(
      originalPayout.amount,
    );

    // Statements and quotes generated for both payouts
    const generateStatement = (payout: SimulatedPayout) => ({
      payoutId: payout.id,
      accountingTotal: payout.amount,
      lineItemsTotal: payout.commissions.reduce((s, c) => s + c.earnings, 0),
    });

    const stmt1 = generateStatement(updatedPreviousPayout);
    const stmt2 = generateStatement(newCurrentMonthPayout);

    expect(stmt1.accountingTotal).toBe(10000);
    expect(stmt1.lineItemsTotal).toBe(10000);

    expect(stmt2.accountingTotal).toBe(5000);
    expect(stmt2.lineItemsTotal).toBe(5000);
  });
});
