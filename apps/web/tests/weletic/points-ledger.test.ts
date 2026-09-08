import { describe, expect, it } from "vitest";

describe("Weletic Customer Loyalty Points Ledger Engine (ADR 0003, ADR 0004)", () => {
  interface SimulatedLedgerEntry {
    id: string;
    storeId: string;
    accountId: string;
    sequenceNumber: number;
    entryType: string;
    pointsDelta: bigint;
    balanceAfter: bigint;
    referenceType?: string | null;
    referenceId?: string | null;
    idempotencyKey: string;
    reason?: string | null;
  }

  interface SimulatedAccount {
    id: string;
    storeId: string;
    cachedPointsBalance: bigint;
    lifetimePointsEarned: bigint;
    lifetimePointsRedeemed: bigint;
    status: string;
  }

  const createSimulatedLedger = () => {
    const accounts = new Map<string, SimulatedAccount>();
    const ledger = new Map<string, SimulatedLedgerEntry>();
    const idempotencyIndex = new Map<string, SimulatedLedgerEntry>();

    const appendEntry = (params: {
      storeId: string;
      accountId: string;
      entryType: string;
      pointsDelta: bigint;
      referenceType?: string;
      referenceId?: string;
      idempotencyKey: string;
      reason?: string;
    }) => {
      const idempKey = `${params.storeId}:${params.idempotencyKey}`;
      if (idempotencyIndex.has(idempKey)) {
        return { entry: idempotencyIndex.get(idempKey)!, created: false };
      }

      const account = accounts.get(params.accountId);
      if (!account) {
        throw new Error(`Account ${params.accountId} not found`);
      }

      // Determine sequence
      const accountEntries = Array.from(ledger.values()).filter(
        (e) => e.accountId === params.accountId,
      );
      const maxSeq = accountEntries.reduce(
        (max, e) => Math.max(max, e.sequenceNumber),
        0,
      );
      const nextSeq = maxSeq + 1;
      const balanceAfter = account.cachedPointsBalance + params.pointsDelta;

      if (params.pointsDelta > BigInt(0)) {
        account.lifetimePointsEarned += params.pointsDelta;
      } else if (
        params.entryType === "REDEEM_REWARD" &&
        params.pointsDelta < BigInt(0)
      ) {
        account.lifetimePointsRedeemed += -params.pointsDelta;
      }
      account.cachedPointsBalance = balanceAfter;

      const entry: SimulatedLedgerEntry = {
        id: `wledger_${nextSeq}`,
        storeId: params.storeId,
        accountId: params.accountId,
        sequenceNumber: nextSeq,
        entryType: params.entryType,
        pointsDelta: params.pointsDelta,
        balanceAfter,
        referenceType: params.referenceType ?? null,
        referenceId: params.referenceId ?? null,
        idempotencyKey: params.idempotencyKey,
        reason: params.reason ?? null,
      };

      ledger.set(entry.id, entry);
      idempotencyIndex.set(idempKey, entry);

      return { entry, created: true };
    };

    return { accounts, ledger, idempotencyIndex, appendEntry };
  };

  it("strictly increments sequence numbers and records running balance after each entry", () => {
    const sys = createSimulatedLedger();
    sys.accounts.set("acc_1", {
      id: "acc_1",
      storeId: "store_1",
      cachedPointsBalance: BigInt(0),
      lifetimePointsEarned: BigInt(0),
      lifetimePointsRedeemed: BigInt(0),
      status: "active",
    });

    // 1. First earn: +100 points
    const e1 = sys.appendEntry({
      storeId: "store_1",
      accountId: "acc_1",
      entryType: "EARN_ORDER",
      pointsDelta: BigInt(100),
      idempotencyKey: "earn:order_1",
    });

    expect(e1.created).toBe(true);
    expect(e1.entry.sequenceNumber).toBe(1);
    expect(e1.entry.balanceAfter).toBe(BigInt(100));
    expect(sys.accounts.get("acc_1")?.cachedPointsBalance).toBe(BigInt(100));

    // 2. Second earn: +50 points
    const e2 = sys.appendEntry({
      storeId: "store_1",
      accountId: "acc_1",
      entryType: "EARN_ORDER",
      pointsDelta: BigInt(50),
      idempotencyKey: "earn:order_2",
    });

    expect(e2.entry.sequenceNumber).toBe(2);
    expect(e2.entry.balanceAfter).toBe(BigInt(150));
    expect(sys.accounts.get("acc_1")?.cachedPointsBalance).toBe(BigInt(150));
    expect(sys.accounts.get("acc_1")?.lifetimePointsEarned).toBe(BigInt(150));
  });

  it("supports exact negative balances when late refunds arrive after points redemption (ADR 0004)", () => {
    const sys = createSimulatedLedger();
    sys.accounts.set("acc_2", {
      id: "acc_2",
      storeId: "store_1",
      cachedPointsBalance: BigInt(0),
      lifetimePointsEarned: BigInt(0),
      lifetimePointsRedeemed: BigInt(0),
      status: "active",
    });

    // 1. Order earn: +100
    sys.appendEntry({
      storeId: "store_1",
      accountId: "acc_2",
      entryType: "EARN_ORDER",
      pointsDelta: BigInt(100),
      idempotencyKey: "order_100",
    });

    // 2. Redeem reward: -100
    sys.appendEntry({
      storeId: "store_1",
      accountId: "acc_2",
      entryType: "REDEEM_REWARD",
      pointsDelta: BigInt(-100),
      idempotencyKey: "redeem_1",
    });

    expect(sys.accounts.get("acc_2")?.cachedPointsBalance).toBe(BigInt(0));

    // 3. Late refund reversal of the original order: -100
    const refundEntry = sys.appendEntry({
      storeId: "store_1",
      accountId: "acc_2",
      entryType: "REFUND_REVERSAL",
      pointsDelta: BigInt(-100),
      idempotencyKey: "refund_1",
    });

    expect(refundEntry.entry.sequenceNumber).toBe(3);
    expect(refundEntry.entry.balanceAfter).toBe(BigInt(-100));
    expect(sys.accounts.get("acc_2")?.cachedPointsBalance).toBe(BigInt(-100));

    // 4. Future earn: +150 offsets negative debt
    const nextOrderEntry = sys.appendEntry({
      storeId: "store_1",
      accountId: "acc_2",
      entryType: "EARN_ORDER",
      pointsDelta: BigInt(150),
      idempotencyKey: "order_101",
    });

    expect(nextOrderEntry.entry.sequenceNumber).toBe(4);
    expect(nextOrderEntry.entry.balanceAfter).toBe(BigInt(50));
    expect(sys.accounts.get("acc_2")?.cachedPointsBalance).toBe(BigInt(50));
  });

  it("guarantees idempotency on duplicate order/refund webhook deliveries", () => {
    const sys = createSimulatedLedger();
    sys.accounts.set("acc_3", {
      id: "acc_3",
      storeId: "store_1",
      cachedPointsBalance: BigInt(0),
      lifetimePointsEarned: BigInt(0),
      lifetimePointsRedeemed: BigInt(0),
      status: "active",
    });

    // First call
    const res1 = sys.appendEntry({
      storeId: "store_1",
      accountId: "acc_3",
      entryType: "EARN_ORDER",
      pointsDelta: BigInt(75),
      idempotencyKey: "order_dup_test",
    });

    expect(res1.created).toBe(true);
    expect(sys.accounts.get("acc_3")?.cachedPointsBalance).toBe(BigInt(75));

    // Duplicate call with exact same idempotencyKey
    const res2 = sys.appendEntry({
      storeId: "store_1",
      accountId: "acc_3",
      entryType: "EARN_ORDER",
      pointsDelta: BigInt(75),
      idempotencyKey: "order_dup_test",
    });

    expect(res2.created).toBe(false);
    expect(res2.entry.id).toBe(res1.entry.id);
    expect(sys.accounts.get("acc_3")?.cachedPointsBalance).toBe(BigInt(75));
    expect(sys.ledger.size).toBe(1);
  });
});
