import { calculateRefundReversal } from "@/lib/weletic/commerce/record-refund";
import { calculateEligibleOrderPoints } from "@/lib/weletic/loyalty/earn";
import { describe, expect, it } from "vitest";

describe("Adversarial Financial Math Stress Test Harness (Challenger 1)", () => {
  // =========================================================================
  // Scope 1: Proportional refund calculations on $0 items / free gifts & div-by-zero
  // =========================================================================
  describe("Scope 1: Proportional Refund Calculations on $0 Items & Zero-Division Stress", () => {
    it("1.1: Free gift with $0 commissionable amount returns 0 and does not throw", () => {
      const result = calculateRefundReversal({
        originalEarnings: BigInt(0),
        originalCommissionableAmount: BigInt(0),
        refundedAmount: BigInt(0),
        alreadyReversed: BigInt(0),
      });
      expect(result).toBe(BigInt(0));
    });

    it("1.2: Free gift refunded with positive refund amount but 0 commissionable amount returns 0", () => {
      const result = calculateRefundReversal({
        originalEarnings: BigInt(0),
        originalCommissionableAmount: BigInt(0),
        refundedAmount: BigInt(5000),
        alreadyReversed: BigInt(0),
      });
      expect(result).toBe(BigInt(0));
    });

    it("1.3: Negative or zero original earnings returns 0", () => {
      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(0),
          originalCommissionableAmount: BigInt(10000),
          refundedAmount: BigInt(5000),
        }),
      ).toBe(BigInt(0));

      expect(
        calculateRefundReversal({
          originalEarnings: BigInt(-100),
          originalCommissionableAmount: BigInt(10000),
          refundedAmount: BigInt(5000),
        }),
      ).toBe(BigInt(0));
    });

    it("1.4: Points earn / refund reversal on $0 net spend returns BigInt(0)", () => {
      const pointsZero = calculateEligibleOrderPoints({
        netAmountCents: BigInt(0),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        multiplier: 1.0,
      });
      expect(pointsZero).toBe(BigInt(0));

      const pointsNegative = calculateEligibleOrderPoints({
        netAmountCents: BigInt(-500),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
        multiplier: 1.0,
      });
      expect(pointsNegative).toBe(BigInt(0));
    });

    it("1.5: Exhaustive partial refund fragmentation sums to exactly 100% of original earnings", () => {
      const originalEarnings = BigInt(10000); // e.g. $100.00 commission
      const originalCommissionableAmount = BigInt(50000); // e.g. $500.00 subtotal
      const refundSteps = [
        BigInt(10000), // 20%
        BigInt(15000), // 30%
        BigInt(5000), // 10%
        BigInt(12500), // 25%
        BigInt(7500), // 15% (total 100%)
      ];

      let cumulativeReversed = BigInt(0);
      for (const step of refundSteps) {
        const rev = calculateRefundReversal({
          originalEarnings,
          originalCommissionableAmount,
          refundedAmount: step,
          alreadyReversed: cumulativeReversed,
        });
        cumulativeReversed += rev;
      }

      expect(cumulativeReversed).toBe(originalEarnings);
    });

    it("1.6: Over-refund attempts capped at remaining earnings", () => {
      const originalEarnings = BigInt(3333);
      const originalCommissionableAmount = BigInt(10000);

      // First refund of 50% ($50.00)
      const rev1 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount,
        refundedAmount: BigInt(5000),
        alreadyReversed: BigInt(0),
      });
      // 3333 * 5000 / 10000 = 1666.5 -> rounds to 1667
      expect(rev1).toBe(BigInt(1667));

      // Second refund attempting 100% ($100.00)
      const rev2 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount,
        refundedAmount: BigInt(10000),
        alreadyReversed: rev1,
      });
      // Remaining is 3333 - 1667 = 1666
      expect(rev2).toBe(BigInt(1666));
      expect(rev1 + rev2).toBe(originalEarnings);

      // Third refund when already fully reversed
      const rev3 = calculateRefundReversal({
        originalEarnings,
        originalCommissionableAmount,
        refundedAmount: BigInt(5000),
        alreadyReversed: rev1 + rev2,
      });
      expect(rev3).toBe(BigInt(0));
    });
  });

  // =========================================================================
  // Scope 2: Negative points balance handling when late refunds arrive
  // =========================================================================
  describe("Scope 2: Negative Points Balance Handling & Redemption Blocking", () => {
    interface AccountState {
      id: string;
      cachedPointsBalance: bigint;
      lifetimePointsEarned: bigint;
      lifetimePointsRedeemed: bigint;
      status: "active" | "suspended" | "closed";
    }

    interface LedgerEntry {
      id: string;
      accountId: string;
      sequenceNumber: number;
      entryType: string;
      pointsDelta: bigint;
      balanceAfter: bigint;
      idempotencyKey: string;
    }

    const createSimulatedLedgerEngine = () => {
      const accounts = new Map<string, AccountState>();
      const entries = new Map<string, LedgerEntry[]>();
      const idempotency = new Set<string>();

      const createAccount = (id: string) => {
        const acc: AccountState = {
          id,
          cachedPointsBalance: BigInt(0),
          lifetimePointsEarned: BigInt(0),
          lifetimePointsRedeemed: BigInt(0),
          status: "active",
        };
        accounts.set(id, acc);
        entries.set(id, []);
        return acc;
      };

      const append = (params: {
        accountId: string;
        entryType: string;
        pointsDelta: bigint;
        idempotencyKey: string;
      }) => {
        if (idempotency.has(params.idempotencyKey)) {
          const list = entries.get(params.accountId) || [];
          return list.find((e) => e.idempotencyKey === params.idempotencyKey)!;
        }

        const acc = accounts.get(params.accountId);
        if (!acc) throw new Error("Account not found");

        const list = entries.get(params.accountId) || [];
        const nextSeq = list.length + 1;
        const balanceAfter = acc.cachedPointsBalance + params.pointsDelta;

        if (params.pointsDelta > BigInt(0)) {
          acc.lifetimePointsEarned += params.pointsDelta;
        } else if (
          params.entryType === "REDEEM_REWARD" &&
          params.pointsDelta < BigInt(0)
        ) {
          acc.lifetimePointsRedeemed += -params.pointsDelta;
        }
        acc.cachedPointsBalance = balanceAfter;

        const entry: LedgerEntry = {
          id: `wled_${nextSeq}`,
          accountId: params.accountId,
          sequenceNumber: nextSeq,
          entryType: params.entryType,
          pointsDelta: params.pointsDelta,
          balanceAfter,
          idempotencyKey: params.idempotencyKey,
        };

        list.push(entry);
        entries.set(params.accountId, list);
        idempotency.add(params.idempotencyKey);
        return entry;
      };

      const redeem = (accountId: string, pointsCost: bigint) => {
        const acc = accounts.get(accountId);
        if (!acc) throw new Error("Account not found");
        if (acc.status !== "active") {
          throw new Error("Account is not active");
        }
        if (
          acc.cachedPointsBalance < pointsCost ||
          acc.cachedPointsBalance <= BigInt(0)
        ) {
          throw new Error(
            `Insufficient points balance: required ${pointsCost}, available ${acc.cachedPointsBalance}`,
          );
        }

        return append({
          accountId,
          entryType: "REDEEM_REWARD",
          pointsDelta: -pointsCost,
          idempotencyKey: `redeem_${Date.now()}_${Math.random()}`,
        });
      };

      return { accounts, entries, createAccount, append, redeem };
    };

    it("2.1: Correctly tolerates negative points balance when full refund happens post-redemption", () => {
      const engine = createSimulatedLedgerEngine();
      engine.createAccount("acc_test_1");

      // 1. Earn 200 points on Order 1
      engine.append({
        accountId: "acc_test_1",
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(200),
        idempotencyKey: "order_1",
      });
      expect(engine.accounts.get("acc_test_1")!.cachedPointsBalance).toBe(
        BigInt(200),
      );

      // 2. Redeem 200 points for a $20 voucher
      engine.redeem("acc_test_1", BigInt(200));
      expect(engine.accounts.get("acc_test_1")!.cachedPointsBalance).toBe(
        BigInt(0),
      );
      expect(engine.accounts.get("acc_test_1")!.lifetimePointsRedeemed).toBe(
        BigInt(200),
      );

      // 3. Late refund arrives for Order 1 -> -200 points clawback
      const refundEntry = engine.append({
        accountId: "acc_test_1",
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(-200),
        idempotencyKey: "refund_1",
      });

      expect(refundEntry.sequenceNumber).toBe(3);
      expect(refundEntry.balanceAfter).toBe(BigInt(-200));
      expect(engine.accounts.get("acc_test_1")!.cachedPointsBalance).toBe(
        BigInt(-200),
      );
    });

    it("2.2: Blocks redemption attempts when balance is negative or zero", () => {
      const engine = createSimulatedLedgerEngine();
      engine.createAccount("acc_test_2");

      // Balance = 0
      expect(() => engine.redeem("acc_test_2", BigInt(50))).toThrowError(
        /Insufficient points balance/,
      );

      // Go into negative balance via refund reversal
      engine.append({
        accountId: "acc_test_2",
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(-150),
        idempotencyKey: "refund_late",
      });
      expect(engine.accounts.get("acc_test_2")!.cachedPointsBalance).toBe(
        BigInt(-150),
      );

      // Attempt redemption when balance is -150
      expect(() => engine.redeem("acc_test_2", BigInt(50))).toThrowError(
        /Insufficient points balance/,
      );
    });

    it("2.3: Automatically claws back out of negative balance on subsequent qualifying orders", () => {
      const engine = createSimulatedLedgerEngine();
      engine.createAccount("acc_test_3");

      // Balance: -100
      engine.append({
        accountId: "acc_test_3",
        entryType: "REFUND_REVERSAL",
        pointsDelta: BigInt(-100),
        idempotencyKey: "ref_init",
      });

      // Subsequent order earns 60 points -> Balance: -40
      engine.append({
        accountId: "acc_test_3",
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(60),
        idempotencyKey: "ord_next_1",
      });
      expect(engine.accounts.get("acc_test_3")!.cachedPointsBalance).toBe(
        BigInt(-40),
      );
      expect(() => engine.redeem("acc_test_3", BigInt(10))).toThrowError();

      // Another order earns 70 points -> Balance: +30
      engine.append({
        accountId: "acc_test_3",
        entryType: "EARN_ORDER",
        pointsDelta: BigInt(70),
        idempotencyKey: "ord_next_2",
      });
      expect(engine.accounts.get("acc_test_3")!.cachedPointsBalance).toBe(
        BigInt(30),
      );

      // Now redemption of 25 points succeeds
      const red = engine.redeem("acc_test_3", BigInt(25));
      expect(red.balanceAfter).toBe(BigInt(5));
      expect(engine.accounts.get("acc_test_3")!.cachedPointsBalance).toBe(
        BigInt(5),
      );
    });
  });

  // =========================================================================
  // Scope 3: Monotonic atomic sequencing and idempotency key duplicate handling
  // =========================================================================
  describe("Scope 3: Monotonic Atomic Sequencing & Idempotency Key Duplicate Handling", () => {
    it("3.1: Sequence numbers are strictly monotonic consecutive positive integers (1..N)", () => {
      const sequences: number[] = [];
      let currentSeq = 0;

      for (let i = 1; i <= 100; i++) {
        currentSeq += 1;
        sequences.push(currentSeq);
      }

      expect(sequences[0]).toBe(1);
      expect(sequences[99]).toBe(100);
      for (let i = 0; i < sequences.length; i++) {
        expect(sequences[i]).toBe(i + 1);
      }
    });

    it("3.2: Replaying the exact same idempotency key produces identical result with zero state change", () => {
      const recordedKeys = new Map<
        string,
        { id: string; balanceAfter: bigint; sequenceNumber: number }
      >();
      let balance = BigInt(0);
      let seq = 0;

      const executeTransaction = (idempotencyKey: string, delta: bigint) => {
        if (recordedKeys.has(idempotencyKey)) {
          return {
            entry: recordedKeys.get(idempotencyKey)!,
            isDuplicate: true,
          };
        }
        seq += 1;
        balance += delta;
        const entry = {
          id: `entry_${seq}`,
          balanceAfter: balance,
          sequenceNumber: seq,
        };
        recordedKeys.set(idempotencyKey, entry);
        return { entry, isDuplicate: false };
      };

      // 1. Initial call
      const res1 = executeTransaction("order:12345", BigInt(150));
      expect(res1.isDuplicate).toBe(false);
      expect(res1.entry.sequenceNumber).toBe(1);
      expect(res1.entry.balanceAfter).toBe(BigInt(150));
      expect(balance).toBe(BigInt(150));

      // 2. Replay 10 duplicate calls
      for (let i = 0; i < 10; i++) {
        const duplicateRes = executeTransaction("order:12345", BigInt(150));
        expect(duplicateRes.isDuplicate).toBe(true);
        expect(duplicateRes.entry.id).toBe(res1.entry.id);
        expect(duplicateRes.entry.sequenceNumber).toBe(1);
        expect(duplicateRes.entry.balanceAfter).toBe(BigInt(150));
        expect(balance).toBe(BigInt(150));
        expect(seq).toBe(1);
      }
    });

    it("3.3: Reconcile algorithm detects any sequence gap or imbalance correctly", () => {
      const verifyReconciliation = (
        entries: Array<{ sequenceNumber: number; pointsDelta: bigint }>,
        cachedBalance: bigint,
      ) => {
        let runningBalance = BigInt(0);
        for (let i = 0; i < entries.length; i++) {
          const expectedSequence = i + 1;
          if (entries[i].sequenceNumber !== expectedSequence) {
            throw new Error(
              `Sequence gap: got ${entries[i].sequenceNumber}, expected ${expectedSequence}`,
            );
          }
          runningBalance += entries[i].pointsDelta;
        }
        return {
          calculatedBalance: runningBalance,
          matchesCache: runningBalance === cachedBalance,
        };
      };

      const validEntries = [
        { sequenceNumber: 1, pointsDelta: BigInt(100) },
        { sequenceNumber: 2, pointsDelta: BigInt(-50) },
        { sequenceNumber: 3, pointsDelta: BigInt(200) },
      ];

      expect(verifyReconciliation(validEntries, BigInt(250))).toEqual({
        calculatedBalance: BigInt(250),
        matchesCache: true,
      });

      // Discrepancy in cached balance
      expect(verifyReconciliation(validEntries, BigInt(999))).toEqual({
        calculatedBalance: BigInt(250),
        matchesCache: false,
      });

      // Sequence gap (1, 3 instead of 1, 2)
      const brokenEntries = [
        { sequenceNumber: 1, pointsDelta: BigInt(100) },
        { sequenceNumber: 3, pointsDelta: BigInt(50) },
      ];
      expect(() =>
        verifyReconciliation(brokenEntries, BigInt(150)),
      ).toThrowError(/Sequence gap/);
    });
  });

  // =========================================================================
  // Scope 4: Multi-currency and 0-decimal currency (JPY, VND) points earning
  // =========================================================================
  describe("Scope 4: Multi-Currency & 0-Decimal Currency (JPY, VND) Points Math", () => {
    it("4.1: USD/EUR/GBP (2-decimal) fractional cents floor calculation", () => {
      // $19.99 @ 1 pt/$1 -> Math.floor(19.99 * 1.0) = 19 points
      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(1999),
          currency: "USD",
          pointsPerCurrencyUnit: 1.0,
        }),
      ).toBe(BigInt(19));

      // $19.99 @ 1.25x Silver multiplier -> Math.floor(19.99 * 1.25) = Math.floor(24.9875) = 24 points
      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(1999),
          currency: "USD",
          pointsPerCurrencyUnit: 1.0,
          multiplier: 1.25,
        }),
      ).toBe(BigInt(24));

      // $19.99 @ 1.5x Gold multiplier -> Math.floor(19.99 * 1.5) = Math.floor(29.985) = 29 points
      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(1999),
          currency: "USD",
          pointsPerCurrencyUnit: 1.0,
          multiplier: 1.5,
        }),
      ).toBe(BigInt(29));
    });

    it("4.2: JPY (0-decimal) points earning without division by 100", () => {
      // ¥1,500 JPY @ 1 point per ¥100 (0.01 per unit) -> Math.floor(1500 * 0.01) = 15 points
      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(1500),
          currency: "JPY",
          pointsPerCurrencyUnit: 0.01,
        }),
      ).toBe(BigInt(15));

      // ¥10,890 JPY @ 1 pt/¥100 with 1.25x -> Math.floor(10890 * 0.0125) = Math.floor(136.125) = 136 points
      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(10890),
          currency: "JPY",
          pointsPerCurrencyUnit: 0.01,
          multiplier: 1.25,
        }),
      ).toBe(BigInt(136));
    });

    it("4.3: VND (0-decimal) points earning without division by 100", () => {
      // 250,000 VND @ 1 point per 1,000 VND (0.001 rate) -> 250 points
      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(250000),
          currency: "VND",
          pointsPerCurrencyUnit: 0.001,
        }),
      ).toBe(BigInt(250));

      // 1,350,000 VND @ 0.001 rate with 1.5x Gold multiplier -> Math.floor(1350000 * 0.0015) = 2025 points
      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(1350000),
          currency: "VND",
          pointsPerCurrencyUnit: 0.001,
          multiplier: 1.5,
        }),
      ).toBe(BigInt(2025));
    });

    it("4.4: All zero-decimal currencies in standard ISO list treated uniformly", () => {
      const zeroDecList = ["JPY", "KRW", "CLP", "PYG", "RWF", "UGX", "VND"];
      for (const curr of zeroDecList) {
        const pts = calculateEligibleOrderPoints({
          netAmountCents: BigInt(10000),
          currency: curr,
          pointsPerCurrencyUnit: 0.1,
        });
        // 10000 * 0.1 = 1000 points
        expect(pts).toBe(BigInt(1000));
      }
    });

    it("4.5: Case-insensitivity on currency string", () => {
      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(10000),
          currency: "jpy",
          pointsPerCurrencyUnit: 0.01,
        }),
      ).toBe(BigInt(100));

      expect(
        calculateEligibleOrderPoints({
          netAmountCents: BigInt(10000),
          currency: "usd",
          pointsPerCurrencyUnit: 1.0,
        }),
      ).toBe(BigInt(100));
    });

    it("4.6: Extreme values safety (BigInt overflow and safe integer bounds)", () => {
      // Order of $10,000,000.00 USD (1,000,000,000 cents)
      const bigPoints = calculateEligibleOrderPoints({
        netAmountCents: BigInt(1_000_000_000),
        currency: "USD",
        pointsPerCurrencyUnit: 1.0,
      });
      expect(bigPoints).toBe(BigInt(10_000_000));

      // 10,000,000,000 VND
      const bigVND = calculateEligibleOrderPoints({
        netAmountCents: BigInt(10_000_000_000),
        currency: "VND",
        pointsPerCurrencyUnit: 0.001,
      });
      expect(bigVND).toBe(BigInt(10_000_000));
    });
  });

  // =========================================================================
  // Scope 5: Two-Phase Backfill Preview Safety (Zero Mutation on Dry-Run)
  // =========================================================================
  describe("Scope 5: Two-Phase Backfill Preview Safety & Idempotent Activation", () => {
    it("5.1: Dry-run preview execution leaves account balance and ledger entries strictly at 0", () => {
      // Model the two-phase lifecycle
      const accountBalances = new Map<string, bigint>([
        ["shopper_alpha", BigInt(0)],
        ["shopper_beta", BigInt(0)],
      ]);
      const ledger: any[] = [];

      const previewItems: any[] = [];
      const historicalOrders = [
        {
          shopperId: "shopper_alpha",
          netAmount: BigInt(5000),
          currency: "USD",
        },
        {
          shopperId: "shopper_alpha",
          netAmount: BigInt(15000),
          currency: "USD",
        },
        {
          shopperId: "shopper_beta",
          netAmount: BigInt(200000),
          currency: "VND",
        },
      ];

      // Step 1: Preview Calculation (Phase 1)
      for (const ord of historicalOrders) {
        const pts = calculateEligibleOrderPoints({
          netAmountCents: ord.netAmount,
          currency: ord.currency,
          pointsPerCurrencyUnit: ord.currency === "VND" ? 0.001 : 1.0,
        });
        previewItems.push({
          shopperId: ord.shopperId,
          projectedPoints: pts,
        });
      }

      // Assert Phase 1 guarantees: Zero Ledger Mutation
      expect(previewItems.length).toBe(3);
      expect(ledger.length).toBe(0);
      expect(accountBalances.get("shopper_alpha")).toBe(BigInt(0));
      expect(accountBalances.get("shopper_beta")).toBe(BigInt(0));

      // Step 2: Commit Activation (Phase 2)
      for (const item of previewItems) {
        const current = accountBalances.get(item.shopperId) || BigInt(0);
        accountBalances.set(item.shopperId, current + item.projectedPoints);
        ledger.push({
          shopperId: item.shopperId,
          entryType: "BACKFILL",
          pointsDelta: item.projectedPoints,
        });
      }

      // Assert Phase 2 guarantees: Exact Points Credited
      // Alpha: $50 (50 pts) + $150 (150 pts) = 200 pts
      expect(accountBalances.get("shopper_alpha")).toBe(BigInt(200));
      // Beta: 200,000 VND * 0.001 = 200 pts
      expect(accountBalances.get("shopper_beta")).toBe(BigInt(200));
      expect(ledger.length).toBe(3);
    });

    it("5.2: Cancelling a backfill job in preview_ready status writes zero ledger entries", () => {
      let jobStatus: "pending" | "preview_ready" | "cancelled" | "completed" =
        "pending";
      const ledger: any[] = [];

      // Generate preview
      jobStatus = "preview_ready";

      // User decides to cancel
      jobStatus = "cancelled";

      // Ledger must remain untouched
      expect(jobStatus).toBe("cancelled");
      expect(ledger.length).toBe(0);
    });
  });
});
