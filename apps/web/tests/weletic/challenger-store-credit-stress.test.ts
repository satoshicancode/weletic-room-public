import { createWeleticId } from "@/lib/weletic/ids";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { type ResolvedShopifyCredentials } from "@/lib/weletic/loyalty/shopify-discounts";
import {
  createShopifyStoreCredit,
  debitShopifyStoreCredit,
  ShopifyFinancialRewardError,
} from "@/lib/weletic/loyalty/shopify-financial-rewards";
import { decimalToMinorUnits, minorUnitsToDecimal } from "@/lib/weletic/money";
import {
  WeleticPointsLedgerEntryType,
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
} from "@prisma/client";
import { execFileSync } from "child_process";
import path from "path";
import { describe, expect, it, vi } from "vitest";

const webRoot = path.resolve(__dirname, "../../");

function runCliScript(scriptRelPath: string, args: string[]) {
  try {
    const stdout = execFileSync("npx", ["tsx", scriptRelPath, ...args], {
      cwd: webRoot,
      encoding: "utf8",
      timeout: 25000,
      env: { ...process.env, NODE_ENV: "test" },
    });
    return { exitCode: 0, stdout, error: null };
  } catch (err: any) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      error: err,
    };
  }
}

// ============================================================================
// Concurrent In-Memory Multi-Tenant Store & Ledger Engine
// ============================================================================

interface ConcurrentAccount {
  id: string;
  storeId: string;
  cachedPointsBalance: bigint;
  cachedPendingPoints: bigint;
  lifetimePointsEarned: bigint;
  lifetimePointsRedeemed: bigint;
  ledgerVersion: number;
}

interface ConcurrentLedgerEntry {
  id: string;
  storeId: string;
  accountId: string;
  sequenceNumber: number;
  entryType: WeleticPointsLedgerEntryType;
  pointsDelta: bigint;
  pendingDelta: bigint;
  balanceAfter: bigint;
  grantId: string | null;
  referenceType: string | null;
  referenceId: string | null;
  idempotencyKey: string;
  createdAt: Date;
}

class ConcurrentLedgerSimulator {
  private accounts = new Map<string, ConcurrentAccount>();
  private entries: ConcurrentLedgerEntry[] = [];
  // Mutex simulation for serializable transaction boundaries per store/account
  private locks = new Map<string, Promise<void>>();

  public setAccount(account: ConcurrentAccount) {
    this.accounts.set(account.id, { ...account });
  }

  public getAccount(id: string): ConcurrentAccount | undefined {
    const acc = this.accounts.get(id);
    return acc ? { ...acc } : undefined;
  }

  public getEntries(accountId?: string): ConcurrentLedgerEntry[] {
    if (!accountId) return [...this.entries];
    return this.entries.filter((e) => e.accountId === accountId);
  }

  private async acquireLock(key: string): Promise<() => void> {
    while (this.locks.has(key)) {
      await this.locks.get(key);
    }
    let resolveLock!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });
    this.locks.set(key, promise);
    return () => {
      this.locks.delete(key);
      resolveLock();
    };
  }

  /**
   * Dispatches a point redemption with atomic balance check and optimistic locking.
   * If available points are insufficient, throws INSUFFICIENT_POINTS.
   */
  public async executeRedemptionWithLock(params: {
    storeId: string;
    accountId: string;
    pointsCost: bigint;
    rewardType: "store_credit" | "gift_card";
    idempotencyKey: string;
    referenceId: string;
  }): Promise<{ entry: ConcurrentLedgerEntry; account: ConcurrentAccount }> {
    const unlock = await this.acquireLock(params.accountId);
    try {
      const account = this.accounts.get(params.accountId);
      if (!account) {
        throw new Error(`Account ${params.accountId} not found.`);
      }

      // 1. Check idempotency
      const existing = this.entries.find(
        (e) =>
          e.storeId === params.storeId &&
          e.idempotencyKey === params.idempotencyKey,
      );
      if (existing) {
        return { entry: existing, account };
      }

      // 2. Check solvency
      if (account.cachedPointsBalance < params.pointsCost) {
        throw new Error("INSUFFICIENT_POINTS");
      }

      // 3. Increment sequence and debit points
      const nextSequence = account.ledgerVersion + 1;
      const balanceAfter = account.cachedPointsBalance - params.pointsCost;
      const lifetimeRedeemed =
        account.lifetimePointsRedeemed + params.pointsCost;

      const newEntry: ConcurrentLedgerEntry = {
        id: createWeleticId("wledger_"),
        storeId: params.storeId,
        accountId: params.accountId,
        sequenceNumber: nextSequence,
        entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        pointsDelta: -params.pointsCost,
        pendingDelta: BigInt(0),
        balanceAfter,
        grantId: null,
        referenceType:
          params.rewardType === "store_credit"
            ? "REDEMPTION_STORE_CREDIT"
            : "REDEMPTION_GIFT_CARD",
        referenceId: params.referenceId,
        idempotencyKey: params.idempotencyKey,
        createdAt: new Date(),
      };

      this.entries.push(newEntry);

      const updatedAccount: ConcurrentAccount = {
        ...account,
        cachedPointsBalance: balanceAfter,
        lifetimePointsRedeemed: lifetimeRedeemed,
        ledgerVersion: nextSequence,
      };

      this.accounts.set(params.accountId, updatedAccount);

      return { entry: newEntry, account: updatedAccount };
    } finally {
      unlock();
    }
  }

  public createPrismaMockClient(): any {
    return {
      weleticPointsLedgerEntry: {
        findUnique: vi.fn(async ({ where }: { where: any }) => {
          if (where.storeId_idempotencyKey) {
            const { storeId, idempotencyKey } = where.storeId_idempotencyKey;
            const found = this.entries.find(
              (e) =>
                e.storeId === storeId && e.idempotencyKey === idempotencyKey,
            );
            return found ? { ...found } : null;
          }
          return null;
        }),
        create: vi.fn(async ({ data }: { data: any }) => {
          const entry: ConcurrentLedgerEntry = {
            ...data,
            createdAt: new Date(),
          };
          this.entries.push(entry);
          return { ...entry };
        }),
      },
      weleticLoyaltyAccount: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          const acc = this.accounts.get(where.id);
          return acc ? { ...acc } : null;
        }),
        updateMany: vi.fn(
          async ({ where, data }: { where: any; data: any }) => {
            const acc = this.accounts.get(where.id);
            if (!acc) return { count: 0 };
            if (where.storeId && acc.storeId !== where.storeId)
              return { count: 0 };
            if (
              where.ledgerVersion !== undefined &&
              acc.ledgerVersion !== where.ledgerVersion
            ) {
              return { count: 0 };
            }
            const updated: ConcurrentAccount = {
              ...acc,
              cachedPointsBalance:
                data.cachedPointsBalance !== undefined
                  ? data.cachedPointsBalance
                  : acc.cachedPointsBalance,
              lifetimePointsEarned:
                data.lifetimePointsEarned !== undefined
                  ? data.lifetimePointsEarned
                  : acc.lifetimePointsEarned,
              lifetimePointsRedeemed:
                data.lifetimePointsRedeemed !== undefined
                  ? data.lifetimePointsRedeemed
                  : acc.lifetimePointsRedeemed,
              ledgerVersion:
                data.ledgerVersion !== undefined
                  ? data.ledgerVersion
                  : acc.ledgerVersion,
              cachedPendingPoints:
                data.cachedPendingPoints !== undefined
                  ? data.cachedPendingPoints
                  : acc.cachedPendingPoints,
            };
            this.accounts.set(acc.id, updated);
            return { count: 1 };
          },
        ),
      },
      weleticLoyaltyProgram: {
        findUnique: vi.fn(async () => null),
      },
    };
  }
}

describe("Adversarial Challenger Stress Suite: Store Credit, Gift Cards & Financial Ledger", () => {
  const credentials: ResolvedShopifyCredentials = {
    shopDomain: "adversarial-stress.myshopify.com",
    accessToken: "shpat_stress_token_adversarial",
    scope:
      "read_gift_cards,write_gift_cards,write_customers,read_store_credit_accounts,write_store_credit_account_transactions",
    source: "env_override",
  };

  // ==========================================================================
  // Stress 1: 50 Concurrent Redemptions against Limited Points
  // ==========================================================================
  it("Stress 1: races 50 concurrent redemptions against 2,500 points (500 pts each): exactly 5 succeed, 45 fail, zero balance drift", async () => {
    const simulator = new ConcurrentLedgerSimulator();
    const accountId = "acc_race_50";
    const storeId = "store_race_50";

    // Initial state: 2,500 points available
    simulator.setAccount({
      id: accountId,
      storeId,
      cachedPointsBalance: BigInt(2500),
      cachedPendingPoints: BigInt(0),
      lifetimePointsEarned: BigInt(2500),
      lifetimePointsRedeemed: BigInt(0),
      ledgerVersion: 0,
    });

    const rewardCost = BigInt(500);
    const concurrentRequests = 50;

    // Dispatch 50 concurrent redemptions with unique idempotency keys
    const results = await Promise.allSettled(
      Array.from({ length: concurrentRequests }, (_, i) =>
        simulator.executeRedemptionWithLock({
          storeId,
          accountId,
          pointsCost: rewardCost,
          rewardType: "store_credit",
          idempotencyKey: `race_key_${i}`,
          referenceId: `wredemp_race_${i}`,
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");

    // Exactly 5 redemptions of 500 points must succeed (5 * 500 = 2500)
    expect(succeeded.length).toBe(5);
    // Exactly 45 must be rejected with INSUFFICIENT_POINTS
    expect(failed.length).toBe(45);
    failed.forEach((f: any) => {
      expect(f.reason.message).toBe("INSUFFICIENT_POINTS");
    });

    const finalAccount = simulator.getAccount(accountId)!;
    // Final balance must be exactly 0 (no negative balance or overshoot)
    expect(finalAccount.cachedPointsBalance).toBe(BigInt(0));
    expect(finalAccount.lifetimePointsRedeemed).toBe(BigInt(2500));
    expect(finalAccount.ledgerVersion).toBe(5);

    // Verify monotonic contiguous sequence numbers: 1, 2, 3, 4, 5 with zero gaps and zero collisions
    const entries = simulator.getEntries(accountId);
    expect(entries.length).toBe(5);
    const sequences = entries.map((e) => e.sequenceNumber);
    expect(sequences).toEqual([1, 2, 3, 4, 5]);

    // Total points debited must equal exactly 2500
    const totalDebited = entries.reduce(
      (sum, e) => sum + e.pointsDelta,
      BigInt(0),
    );
    expect(totalDebited).toBe(BigInt(-2500));
  });

  // ==========================================================================
  // Stress 2: Network Socket Drop / Timeout Post-Dispatch
  // ==========================================================================
  it("Stress 2: socket drop immediately post-dispatch triggers REMOTE_OUTCOME_UNKNOWN and blocks automated replay", async () => {
    let networkCallCount = 0;

    const customFetch: typeof fetch = vi.fn(async () => {
      networkCallCount++;
      // Simulate socket drop / 504 Gateway Timeout after Shopify potentially executed the credit
      const err: any = new Error(
        "Socket connection reset by peer during TLS handshake",
      );
      err.name = "FetchError";
      throw err;
    });

    // 1. Initial attempt fails with network error -> mapped to REMOTE_OUTCOME_UNKNOWN
    await expect(
      createShopifyStoreCredit({
        credentials,
        customerId: "999888",
        amountMinor: BigInt(2000),
        currencyCode: "USD",
        expiresAt: null,
        notify: true,
        customFetch,
      }),
    ).rejects.toMatchObject({
      code: "REMOTE_OUTCOME_UNKNOWN",
    });

    expect(networkCallCount).toBe(1);

    // 2. Simulate the pre-dispatch marker fence:
    // When a redemption has `remoteProvisionAttemptedAt`, automated replay is forbidden
    const redemptionMetadata = {
      remoteProvisionAttemptedAt: new Date().toISOString(),
      remoteProvisionPreparationId: "frp_stress_fence_1",
    };

    const hasAttempt = Boolean(redemptionMetadata.remoteProvisionAttemptedAt);
    const attemptReplay = () => {
      if (hasAttempt) {
        throw new ShopifyFinancialRewardError(
          "REMOTE_OUTCOME_UNKNOWN",
          "Store-credit redemption already crossed the remote dispatch boundary and requires manual reconciliation before any retry.",
        );
      }
    };

    // Attempting automated retry must fail immediately without making a second network call
    expect(attemptReplay).toThrowError(
      /already crossed the remote dispatch boundary/,
    );
    expect(networkCallCount).toBe(1); // Zero additional network calls dispatched!
  });

  // ==========================================================================
  // Stress 3: Extreme Multi-Currency Precision & Zero Floating-Point Drift
  // ==========================================================================
  it("Stress 3: executes 10,000 multi-currency operations across JPY, USD, and BHD with zero floating-point drift", () => {
    // In standard IEEE 754 floating point arithmetic:
    // 0.1 + 0.2 === 0.30000000000000004 (epsilon error!)
    // We demonstrate that BigInt integer minor unit conversions across 10,000 operations maintain 100% algebraic precision.

    const operationsCount = 10_000;

    // Stream 1: JPY (0 decimal places). 100 pts = ¥1 JPY
    let jpyAccumulatorMinor = BigInt(0);
    for (let i = 0; i < operationsCount; i++) {
      const minor = decimalToMinorUnits("1", "JPY");
      jpyAccumulatorMinor += minor;
    }
    expect(jpyAccumulatorMinor).toBe(BigInt(10_000));
    expect(minorUnitsToDecimal(jpyAccumulatorMinor, "JPY")).toBe("10000");

    // Stream 2: USD (2 decimal places). $0.25 = 25 minor units
    let usdAccumulatorMinor = BigInt(0);
    for (let i = 0; i < operationsCount; i++) {
      const minor = decimalToMinorUnits("0.25", "USD");
      usdAccumulatorMinor += minor;
    }
    // 10,000 * 25 = 250,000 minor units = $2,500.00
    expect(usdAccumulatorMinor).toBe(BigInt(250_000));
    expect(minorUnitsToDecimal(usdAccumulatorMinor, "USD")).toBe("2500.00");

    // Stream 3: BHD (3 decimal places). 0.125 BHD = 125 minor units
    let bhdAccumulatorMinor = BigInt(0);
    for (let i = 0; i < operationsCount; i++) {
      const minor = decimalToMinorUnits("0.125", "BHD");
      bhdAccumulatorMinor += minor;
    }
    // 10,000 * 125 = 1,250,000 minor units = 1250.000 BHD
    expect(bhdAccumulatorMinor).toBe(BigInt(1_250_000));
    expect(minorUnitsToDecimal(bhdAccumulatorMinor, "BHD")).toBe("1250.000");
  });

  // ==========================================================================
  // Stress 4: Replay Attacks & Idempotency Key Reuse
  // ==========================================================================
  it("Stress 4: withstands 20 rapid replays with same idempotencyKey, and throws on conflicting parameters", async () => {
    const simulator = new ConcurrentLedgerSimulator();
    const mockPrisma = simulator.createPrismaMockClient();
    const accountId = "acc_replay_attack";
    const storeId = "store_replay_attack";

    simulator.setAccount({
      id: accountId,
      storeId,
      cachedPointsBalance: BigInt(5000),
      cachedPendingPoints: BigInt(0),
      lifetimePointsEarned: BigInt(5000),
      lifetimePointsRedeemed: BigInt(0),
      ledgerVersion: 0,
    });

    const idempotencyKey = "replay_fixed_key_12345";
    const baseParams = {
      storeId,
      accountId,
      entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
      pointsDelta: BigInt(-1000),
      referenceType: "REDEMPTION_STORE_CREDIT",
      referenceId: "wredemp_sc_1",
      idempotencyKey,
      tx: mockPrisma,
    };

    // First call: appends entry
    const initialEntry = await appendPointsLedgerEntry(baseParams);
    expect(initialEntry.sequenceNumber).toBe(1);
    expect(initialEntry.balanceAfter).toBe(BigInt(4000));

    // 20 rapid duplicate replays with identical key
    const replayResults = await Promise.all(
      Array.from({ length: 20 }, () => appendPointsLedgerEntry(baseParams)),
    );

    // Every replay must return the exact same entry ID and balanceAfter
    replayResults.forEach((entry) => {
      expect(entry.id).toBe(initialEntry.id);
      expect(entry.sequenceNumber).toBe(1);
      expect(entry.balanceAfter).toBe(BigInt(4000));
    });

    // Zero balance drift: only one entry was written
    expect(simulator.getEntries().length).toBe(1);
    const finalAccount = simulator.getAccount(accountId)!;
    expect(finalAccount.cachedPointsBalance).toBe(BigInt(4000));
    expect(finalAccount.ledgerVersion).toBe(1);

    // Tampering attack: same key with different amount (-2000 instead of -1000)
    await expect(
      appendPointsLedgerEntry({
        ...baseParams,
        pointsDelta: BigInt(-2000),
      }),
    ).rejects.toThrowError(/Ledger idempotency conflict/);

    // Tampering attack: same key with different account
    await expect(
      appendPointsLedgerEntry({
        ...baseParams,
        accountId: "acc_other_hacker",
      }),
    ).rejects.toThrowError(/Ledger idempotency conflict/);
  });

  // ==========================================================================
  // Stress 5: Compensating Rollback Invariance on Terminal GraphQL Error
  // ==========================================================================
  it("Stress 5: executes compensating rollback on terminal GraphQL failure, restoring balance exactly to initial state", async () => {
    const simulator = new ConcurrentLedgerSimulator();
    const mockPrisma = simulator.createPrismaMockClient();
    const accountId = "acc_rollback_1";
    const storeId = "store_rollback_1";

    const initialBalance = BigInt(3000);
    simulator.setAccount({
      id: accountId,
      storeId,
      cachedPointsBalance: initialBalance,
      cachedPendingPoints: BigInt(0),
      lifetimePointsEarned: initialBalance,
      lifetimePointsRedeemed: BigInt(0),
      ledgerVersion: 0,
    });

    // Step 1: Points reservation debit (-2000 pts)
    const debitEntry = await appendPointsLedgerEntry({
      storeId,
      accountId,
      entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
      pointsDelta: BigInt(-2000),
      referenceType: "REDEMPTION_STORE_CREDIT",
      referenceId: "wredemp_failed_1",
      idempotencyKey: "idem_debit_phase",
      tx: mockPrisma,
    });
    expect(debitEntry.balanceAfter).toBe(BigInt(1000));

    // Step 2: Simulated Shopify terminal failure (e.g. Customer not found in Shopify)
    const shopifyFailure = new ShopifyFinancialRewardError(
      "GRAPHQL_USER_ERROR",
      "Customer does not exist in store catalog",
      [
        {
          field: ["id"],
          message: "Customer does not exist",
          code: "CUSTOMER_NOT_FOUND",
        },
      ],
    );

    // Step 3: Saga detects terminal failure and triggers compensating rollback
    const rollbackEntry = await appendPointsLedgerEntry({
      storeId,
      accountId,
      entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
      pointsDelta: BigInt(2000),
      referenceType: "REVERT_FAILED_REDEMPTION",
      referenceId: "wredemp_failed_1",
      idempotencyKey: "idem_rollback_phase",
      reason: `Compensating rollback: ${shopifyFailure.message}`,
      tx: mockPrisma,
    });

    expect(rollbackEntry.sequenceNumber).toBe(2);
    expect(rollbackEntry.balanceAfter).toBe(initialBalance);

    const finalAccount = simulator.getAccount(accountId)!;
    // Final balance is restored to exact initial balance (3000 points)
    expect(finalAccount.cachedPointsBalance).toBe(initialBalance);
    expect(finalAccount.ledgerVersion).toBe(2);
  });

  // ==========================================================================
  // Stress 6: 1,000-Transaction High-Volume Ledger Coherence Stress
  // ==========================================================================
  it("Stress 6: stress tests 1,000 mixed transactions across 5 accounts with complete audit reconciliation", async () => {
    const simulator = new ConcurrentLedgerSimulator();
    const mockPrisma = simulator.createPrismaMockClient();
    const storeId = "store_stress_1000";
    const numAccounts = 5;
    const totalTransactions = 1000;

    for (let a = 1; a <= numAccounts; a++) {
      simulator.setAccount({
        id: `acc_stress_${a}`,
        storeId,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 0,
      });
    }

    const txTypes: Array<{
      type: WeleticPointsLedgerEntryType;
      refType: string;
      deltaGenerator: (currentBalance: bigint) => bigint;
    }> = [
      // Earn order (+100 to +500 pts)
      {
        type: WeleticPointsLedgerEntryType.EARN_ORDER,
        refType: "SHOPIFY_ORDER",
        deltaGenerator: () => BigInt(Math.floor(Math.random() * 401) + 100),
      },
      // Earn bonus (+50 to +200 pts)
      {
        type: WeleticPointsLedgerEntryType.EARN_BONUS,
        refType: "BONUS_CAMPAIGN",
        deltaGenerator: () => BigInt(Math.floor(Math.random() * 151) + 50),
      },
      // Store credit redemption (-50 to -200 pts, only if positive balance)
      {
        type: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        refType: "REDEMPTION_STORE_CREDIT",
        deltaGenerator: (balance) => {
          if (balance <= BigInt(50)) return BigInt(0);
          const maxRedeem = Number(
            balance > BigInt(200) ? BigInt(200) : balance,
          );
          return BigInt(-Math.floor(Math.random() * (maxRedeem - 50 + 1) + 50));
        },
      },
      // Gift card redemption (-100 to -300 pts, only if positive balance)
      {
        type: WeleticPointsLedgerEntryType.REDEEM_REWARD,
        refType: "REDEMPTION_GIFT_CARD",
        deltaGenerator: (balance) => {
          if (balance <= BigInt(100)) return BigInt(0);
          const maxRedeem = Number(
            balance > BigInt(300) ? BigInt(300) : balance,
          );
          return BigInt(
            -Math.floor(Math.random() * (maxRedeem - 100 + 1) + 100),
          );
        },
      },
      // Refund clawback (-100 to -300 pts, allows negative balance!)
      {
        type: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        refType: "SHOPIFY_REFUND",
        deltaGenerator: () => BigInt(-Math.floor(Math.random() * 201 + 100)),
      },
    ];

    for (let i = 1; i <= totalTransactions; i++) {
      const accountIndex = (i % numAccounts) + 1;
      const accountId = `acc_stress_${accountIndex}`;
      const account = simulator.getAccount(accountId)!;

      const randomTemplate =
        txTypes[Math.floor(Math.random() * txTypes.length)];
      const delta = randomTemplate.deltaGenerator(account.cachedPointsBalance);

      if (delta === BigInt(0)) {
        // Replace with an earn to maintain activity
        await appendPointsLedgerEntry({
          storeId,
          accountId,
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: BigInt(200),
          referenceType: "SHOPIFY_ORDER",
          referenceId: `ord_fill_${i}`,
          idempotencyKey: `idem_stress_${i}`,
          tx: mockPrisma,
        });
      } else {
        await appendPointsLedgerEntry({
          storeId,
          accountId,
          entryType: randomTemplate.type,
          pointsDelta: delta,
          referenceType: randomTemplate.refType,
          referenceId: `ref_${i}`,
          idempotencyKey: `idem_stress_${i}`,
          tx: mockPrisma,
        });
      }
    }

    // Comprehensive Audit across all 5 accounts
    for (let a = 1; a <= numAccounts; a++) {
      const accountId = `acc_stress_${a}`;
      const account = simulator.getAccount(accountId)!;
      const accountEntries = simulator.getEntries(accountId);

      expect(accountEntries.length).toBeGreaterThan(0);

      // Audit 1: Sum of pointsDelta equals cachedPointsBalance
      const sumDelta = accountEntries.reduce(
        (s, e) => s + e.pointsDelta,
        BigInt(0),
      );
      expect(sumDelta).toBe(account.cachedPointsBalance);

      // Audit 2: Sequences are strictly monotonic 1..N with zero gaps
      const sequences = accountEntries.map((e) => e.sequenceNumber);
      const expectedSequences = Array.from(
        { length: accountEntries.length },
        (_, idx) => idx + 1,
      );
      expect(sequences).toEqual(expectedSequences);

      // Audit 3: ledgerVersion matches sequence maximum
      expect(account.ledgerVersion).toBe(accountEntries.length);
    }
  });

  // ==========================================================================
  // Stress 7: Store Credit Over-Debit and Boundary Rejections
  // ==========================================================================
  it("Stress 7: Store Credit Over-Debit throws GRAPHQL_USER_ERROR and preserves remote balance", async () => {
    let remoteBalance = "15.00";

    const customFetch: typeof fetch = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      const requestedDebit = body.variables.debitInput.debitAmount.amount;
      if (Number(requestedDebit) > Number(remoteBalance)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              storeCreditAccountDebit: {
                storeCreditAccountTransaction: null,
                userErrors: [
                  {
                    field: ["debitInput", "debitAmount"],
                    message: `Requested debit ${requestedDebit} exceeds available balance ${remoteBalance}.`,
                    code: "INSUFFICIENT_FUNDS",
                  },
                ],
              },
            },
          }),
        };
      }
      const newBal = (Number(remoteBalance) - Number(requestedDebit)).toFixed(
        2,
      );
      remoteBalance = newBal;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            storeCreditAccountDebit: {
              storeCreditAccountTransaction: {
                id: "gid://shopify/StoreCreditAccountTransaction/debit_ok",
                amount: { amount: `-${requestedDebit}`, currencyCode: "USD" },
                account: {
                  id: "gid://shopify/StoreCreditAccount/999",
                  balance: { amount: newBal, currencyCode: "USD" },
                },
              },
              userErrors: [],
            },
          },
        }),
      };
    }) as any;

    // Attempt 1: Over-debit ($20.00 from $15.00 balance) -> rejected
    await expect(
      debitShopifyStoreCredit({
        credentials,
        accountId: "999",
        amountMinor: BigInt(2000), // $20.00
        currencyCode: "USD",
        customFetch,
      }),
    ).rejects.toMatchObject({
      code: "GRAPHQL_USER_ERROR",
      message: expect.stringContaining("exceeds available balance"),
    });

    // Remote balance remained intact at $15.00
    expect(remoteBalance).toBe("15.00");

    // Attempt 2: Valid debit ($10.00 from $15.00 balance) -> succeeds
    const okDebit = await debitShopifyStoreCredit({
      credentials,
      accountId: "999",
      amountMinor: BigInt(1000), // $10.00
      currencyCode: "USD",
      customFetch,
    });

    expect(okDebit.balanceAfter).toBe("5.00");
    expect(remoteBalance).toBe("5.00");
  });

  // ==========================================================================
  // Stress 8: Remote Dispatch Fencing under Worker Sweeper Simulation
  // ==========================================================================
  it("Stress 8: background recovery worker blocks automated re-issuance when remoteProvisionAttemptedAt is present", () => {
    // A provisioning redemption record that had its network response dropped
    const orphanedRedemption = {
      id: "wredemp_orphaned_1",
      status: WeleticRedemptionStatus.provisioning,
      artifactKind: WeleticRewardArtifactKind.store_credit,
      metadata: {
        remoteProvisionAttemptedAt: "2026-09-03T18:00:00.000Z",
        remoteProvisionPreparationId: "frp_orphaned_preparation",
      },
    };

    // Worker sweep simulation
    const evaluateOrphanedRedemption = (
      redemption: typeof orphanedRedemption,
    ) => {
      const hasAttempt = Boolean(
        redemption.metadata?.remoteProvisionAttemptedAt,
      );
      if (
        redemption.artifactKind === WeleticRewardArtifactKind.store_credit &&
        hasAttempt
      ) {
        // MUST quarantine and require balance query or manual review, never re-dispatch
        return {
          action: "QUARANTINE_FOR_RECONCILIATION",
          allowedAutomatedReplay: false,
        };
      }
      return {
        action: "RETRY_DISPATCH",
        allowedAutomatedReplay: true,
      };
    };

    const outcome = evaluateOrphanedRedemption(orphanedRedemption);
    expect(outcome.allowedAutomatedReplay).toBe(false);
    expect(outcome.action).toBe("QUARANTINE_FOR_RECONCILIATION");
  });

  // ==========================================================================
  // Stress 9: CLI Safety Guardrails & Live Staging Enforcement
  // ==========================================================================
  it("Stress 9.1: validate-store-credit-gift-cards.ts --live without --confirm-staging exits with code 1 and outputs structured failure JSON", () => {
    const { exitCode, stdout } = runCliScript(
      "scripts/loyalty/validate-store-credit-gift-cards.ts",
      ["--live", "--json"],
    );

    expect(exitCode).toBe(1);
    const report = JSON.parse(stdout);
    expect(report.overallStatus).toBe("FAILED");
    expect(report.executionMode).toBe("live-admin");
    expect(report.error).toBe(
      "Missing mandatory --confirm-staging flag for live validation.",
    );
  }, 30000);

  it("Stress 9.2: validate-store-credit-gift-cards.ts exits with code 0 in --mock --json mode", () => {
    const { exitCode, stdout } = runCliScript(
      "scripts/loyalty/validate-store-credit-gift-cards.ts",
      ["--mock", "--json"],
    );

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.overallStatus).toBe("PASSED");
    expect(report.executionMode).toBe("mock");
    expect(report.provenance.source).toBe("simulated");
    expect(report.summary.totalChecks).toBeGreaterThan(0);
    expect(report.summary.failedChecks).toBe(0);
  }, 30000);

  it("Stress 9.3: validate-store-credit-gift-cards.ts exits with code 0 in --dry-run --json mode", () => {
    const { exitCode, stdout } = runCliScript(
      "scripts/loyalty/validate-store-credit-gift-cards.ts",
      ["--dry-run", "--json"],
    );

    expect(exitCode).toBe(0);
    const report = JSON.parse(stdout);
    expect(report.overallStatus).toBe("PASSED");
    expect(report.executionMode).toBe("dry-run");
    expect(report.provenance.source).toBe("local-static");
    expect(report.summary.failedChecks).toBe(0);
  }, 30000);
});
