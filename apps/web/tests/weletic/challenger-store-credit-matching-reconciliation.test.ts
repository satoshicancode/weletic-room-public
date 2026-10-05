import {
  createLoyaltyRedemptionProvisioningSnapshot,
  getShopifyCustomerSelectionDigest,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import {
  sameMoney,
  type ShopifyCustomerStoreCreditTransaction,
} from "@/lib/weletic/loyalty/shopify-financial-rewards";
import {
  DEFAULT_STORE_CREDIT_RECONCILIATION_HORIZON_MS,
  reconcilePendingStoreCreditRedemption,
  reconcilePendingStoreCreditRedemptionsSweep,
} from "@/lib/weletic/loyalty/store-credit-reconciliation";
import {
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ============================================================================
// State & Mocks
// ============================================================================

const mockState = {
  redemptions: new Map<string, any>(),
  accounts: new Map<string, any>(),
  outboxJobs: [] as any[],
  flowTriggers: [] as any[],
  compensations: [] as any[],
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticRewardRedemption: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = mockState.redemptions.get(where.id);
        if (!row) return null;
        return {
          ...row,
          account: mockState.accounts.get(row.accountId) ?? null,
        };
      }),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            storeId: string;
            shopifyStoreCreditTransactionId: string;
            id?: { not: string };
          };
        }) => {
          for (const row of mockState.redemptions.values()) {
            if (
              row.storeId === where.storeId &&
              row.shopifyStoreCreditTransactionId ===
                where.shopifyStoreCreditTransactionId &&
              (!where.id?.not || row.id !== where.id.not)
            ) {
              return { id: row.id };
            }
          }
          return null;
        },
      ),
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: {
            artifactKind: string;
            status: string;
            createdAt?: { lte: Date };
          };
          take?: number;
        }) => {
          const list: any[] = [];
          for (const row of mockState.redemptions.values()) {
            if (
              row.artifactKind === where.artifactKind &&
              row.status === where.status &&
              (!where.createdAt?.lte || row.createdAt <= where.createdAt.lte)
            ) {
              list.push({ id: row.id, storeId: row.storeId });
            }
          }
          return take ? list.slice(0, take) : list;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; storeId: string; status: string };
          data: any;
        }) => {
          const row = mockState.redemptions.get(where.id);
          if (
            row &&
            row.storeId === where.storeId &&
            row.status === where.status
          ) {
            Object.assign(row, data);
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return mockState.accounts.get(where.id) ?? null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: any }) => {
          const acc = mockState.accounts.get(where.id);
          if (acc) {
            if (data.cachedPointsBalance?.increment) {
              acc.cachedPointsBalance += BigInt(
                data.cachedPointsBalance.increment,
              );
            }
            return { ...acc };
          }
          return null;
        },
      ),
    },
  },
}));

vi.mock("@/lib/weletic/loyalty/program-write-fence", () => ({
  withLoyaltyProgramRowLock: vi.fn(
    async ({
      operation,
    }: {
      operation: (tx: any) => Promise<any>;
    }) => {
      const { prisma } = await import("@/lib/prisma");
      return operation(prisma);
    },
  ),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn(async (params: any) => {
    mockState.flowTriggers.push(params);
  }),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: vi.fn(async (job: any) => {
    mockState.outboxJobs.push(job);
  }),
  enqueueOutboxJobFromProgramTransaction: vi.fn(async (job: any) => {
    mockState.outboxJobs.push(job);
  }),
}));

vi.mock("@/lib/weletic/loyalty/saga", () => ({
  compensateDiscountSaga: vi.fn(
    async ({
      redemptionId,
      reason,
      targetStatus,
    }: {
      redemptionId: string;
      reason: string;
      targetStatus?: string;
    }) => {
      mockState.compensations.push({ redemptionId, reason, targetStatus });
      const row = mockState.redemptions.get(redemptionId);
      if (row) {
        row.status = targetStatus ?? WeleticRedemptionStatus.failed;
        row.compensationReason = reason;
        const acc = mockState.accounts.get(row.accountId);
        if (acc) {
          acc.cachedPointsBalance += row.pointsSpent;
        }
      }
    },
  ),
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/weletic/loyalty/shopify-discounts")
  >();
  return {
    ...actual,
    resolveShopifyOfflineCredentials: vi.fn(
      async ({ storeId }: { storeId: string }) => ({
        shopDomain: `${storeId}.myshopify.com`,
        accessToken: `shpat_${storeId}_offline_token`,
        scope:
          "read_gift_cards,write_gift_cards,write_customers,read_store_credit_accounts,write_store_credit_account_transactions",
        source: "app_session",
      }),
    ),
  };
});

describe("Adversarial Challenge: Store Credit Reconciliation Matching & Edge Cases", () => {
  const storeId = "store_adversarial_rewards";
  const customerId = "9876543210";
  const customerGid = `gid://shopify/Customer/${customerId}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.redemptions.clear();
    mockState.accounts.clear();
    mockState.outboxJobs = [];
    mockState.flowTriggers = [];
    mockState.compensations = [];
  });

  function createFixture({
    redemptionId = "redemp_adv_1",
    targetStoreId = storeId,
    amountMinor = "500", // $5.00
    pointsSpent = BigInt(500),
    currency = "USD",
    createdAt = new Date("2026-10-05T10:00:00.000Z"),
    remoteAttemptedAt = "2026-10-05T10:00:05.000Z",
    initialBalance = BigInt(2000),
    status = WeleticRedemptionStatus.provisioning as WeleticRedemptionStatus,
    shopifyStoreCreditTransactionId = null as string | null,
  }: {
    redemptionId?: string;
    targetStoreId?: string;
    amountMinor?: string;
    pointsSpent?: bigint;
    currency?: string;
    createdAt?: Date;
    remoteAttemptedAt?: string | null;
    initialBalance?: bigint;
    status?: WeleticRedemptionStatus;
    shopifyStoreCreditTransactionId?: string | null;
  } = {}) {
    const accountId = `acc_${targetStoreId}`;
    mockState.accounts.set(accountId, {
      id: accountId,
      storeId: targetStoreId,
      cachedPointsBalance: initialBalance,
      shopper: {
        id: `shopper_${targetStoreId}`,
        shopifyCustomerId: customerId,
      },
    });

    const provisioningSnapshot = createLoyaltyRedemptionProvisioningSnapshot({
      reward: {
        id: "rew_sc_adv",
        name: "Store Credit Reward",
        description: null,
        rewardType: "store_credit",
        salesChannel: "both",
        exchangeType: "fixed",
        purchasePolicy: null,
        discountValue: amountMinor,
        maxDiscountValue: null,
        minOrderAmount: null,
        appliesToResource: null,
        entitledCollectionIds: [],
        entitledProductIds: [],
        entitledVariantIds: [],
        combinesWithProductDiscounts: false,
        combinesWithOrderDiscounts: false,
        combinesWithShippingDiscounts: false,
        usageLimit: null,
        usageLimitPerCustomer: null,
      },
      pointsCost: pointsSpent,
      discountValue: amountMinor,
      expiresInDays: null,
      shopCurrency: currency,
      currencyVerifiedAt: new Date("2026-10-01T00:00:00.000Z"),
      customerSelectionDigest: getShopifyCustomerSelectionDigest({
        storeId: targetStoreId,
        shopifyCustomerId: customerId,
      }),
      startsAt: new Date("2026-10-01T00:00:00.000Z"),
      expiresAt: null,
    });

    mockState.redemptions.set(redemptionId, {
      id: redemptionId,
      storeId: targetStoreId,
      accountId,
      pointsSpent,
      shopifyDiscountCode: "WLSC_ADV_TEST",
      shopifyDiscountCodeCanonical: "WLSC_ADV_TEST",
      artifactKind: WeleticRewardArtifactKind.store_credit,
      status,
      shopifyStoreCreditTransactionId,
      issuanceConfirmedAt: null,
      createdAt,
      metadata: {
        remoteProvisionAttemptedAt: remoteAttemptedAt,
        provisioningSnapshot,
      },
    });

    return { redemptionId };
  }

  function createShopifyMockFetch(transactions: Array<{
    id: string;
    amount: string;
    currencyCode: string;
    createdAt: string;
    expiresAt?: string | null;
  }>) {
    return vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        data: {
          customer: {
            id: customerGid,
            storeCreditAccounts: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/StoreCreditAccount/acc_adv",
                    balance: { amount: "100.00", currencyCode: "USD" },
                    transactions: {
                      edges: transactions.map((tx) => ({
                        node: {
                          id: tx.id,
                          amount: {
                            amount: tx.amount,
                            currencyCode: tx.currencyCode,
                          },
                          createdAt: tx.createdAt,
                          expiresAt: tx.expiresAt ?? null,
                        },
                      })),
                    },
                  },
                },
              ],
            },
          },
        },
      }),
    })) as any;
  }

  // ==========================================================================
  // CHALLENGE 1: Amount String Formatting Variations
  // ==========================================================================
  describe("Challenge 1: Amount String Formatting Variations", () => {
    it("Empirically verifies sameMoney decimal canonicalization across diverse string representations", () => {
      // Equivalent positive representations of 5
      expect(sameMoney("5.00", "5.00")).toBe(true);
      expect(sameMoney("5.0", "5.00")).toBe(true);
      expect(sameMoney("5", "5.00")).toBe(true);
      expect(sameMoney("05.00", "5.00")).toBe(true);
      expect(sameMoney("5.000", "5.00")).toBe(true);
      expect(sameMoney("5.00", "5")).toBe(true);

      // Fractional equivalence
      expect(sameMoney("5.50", "5.5")).toBe(true);
      expect(sameMoney("5.500", "5.50")).toBe(true);
      expect(sameMoney("0.50", "0.5")).toBe(true);

      // Zero decimal equivalence
      expect(sameMoney("500", "500")).toBe(true);
      expect(sameMoney("500.00", "500")).toBe(true);
      expect(sameMoney("500", "500.00")).toBe(true);

      // Non-equivalent amounts
      expect(sameMoney("5.01", "5.00")).toBe(false);
      expect(sameMoney("5.05", "5.00")).toBe(false);
      expect(sameMoney("50.00", "5.00")).toBe(false);
      expect(sameMoney("0.05", "5.00")).toBe(false);

      // Negative amounts (debits must NEVER match credits)
      expect(sameMoney("-5.00", "5.00")).toBe(false);
      expect(sameMoney("-5", "5")).toBe(false);

      // Malformed / non-numeric strings
      expect(sameMoney("5.00 USD", "5.00")).toBe(false);
      expect(sameMoney("$5.00", "5.00")).toBe(false);
      expect(sameMoney("abc", "5.00")).toBe(false);
      expect(sameMoney("", "5.00")).toBe(false);
    });

    it("Matches when Shopify returns '5.0' for expected $5.00 (minor: 500 USD)", async () => {
      const { redemptionId } = createFixture({ amountMinor: "500", currency: "USD" });
      const customFetch = createShopifyMockFetch([
        {
          id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_fmt_5_0",
          amount: "5.0",
          currencyCode: "USD",
          createdAt: "2026-10-05T10:00:06.000Z",
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });

      expect(result).toEqual({
        outcome: "confirmed",
        transactionId: "gid://shopify/StoreCreditAccountCreditTransaction/tx_fmt_5_0",
      });
      expect(mockState.redemptions.get(redemptionId).status).toBe(WeleticRedemptionStatus.issued);
    });

    it("Matches when Shopify returns integer '5' without decimal point for expected $5.00", async () => {
      const { redemptionId } = createFixture({ amountMinor: "500", currency: "USD" });
      const customFetch = createShopifyMockFetch([
        {
          id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_fmt_5_int",
          amount: "5",
          currencyCode: "USD",
          createdAt: "2026-10-05T10:00:06.000Z",
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });

      expect(result).toEqual({
        outcome: "confirmed",
        transactionId: "gid://shopify/StoreCreditAccountCreditTransaction/tx_fmt_5_int",
      });
      expect(mockState.redemptions.get(redemptionId).status).toBe(WeleticRedemptionStatus.issued);
    });

    it("Matches zero-decimal JPY currency when Shopify returns '500.00' for expected ¥500", async () => {
      const { redemptionId } = createFixture({
        amountMinor: "500",
        currency: "JPY",
      });
      const customFetch = createShopifyMockFetch([
        {
          id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_jpy_500_dot_00",
          amount: "500.00",
          currencyCode: "JPY",
          createdAt: "2026-10-05T10:00:06.000Z",
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });

      expect(result).toEqual({
        outcome: "confirmed",
        transactionId: "gid://shopify/StoreCreditAccountCreditTransaction/tx_jpy_500_dot_00",
      });
      expect(mockState.redemptions.get(redemptionId).status).toBe(WeleticRedemptionStatus.issued);
    });

    it("Strictly rejects debit (negative amount) transactions even if absolute value matches", async () => {
      const { redemptionId } = createFixture({
        amountMinor: "500",
        currency: "USD",
        createdAt: new Date("2026-10-05T10:00:00.000Z"),
        remoteAttemptedAt: "2026-10-05T10:00:05.000Z",
      });
      // Shopify has a debit of -5.00 USD at the same time
      const customFetch = createShopifyMockFetch([
        {
          id: "gid://shopify/StoreCreditAccountDebitTransaction/tx_debit_5",
          amount: "-5.00",
          currencyCode: "USD",
          createdAt: "2026-10-05T10:00:06.000Z",
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"), // within active horizon
        customFetch,
      });

      // Negative amount does not match -> outcome deferred
      expect(result).toEqual({ outcome: "deferred" });
      expect(mockState.redemptions.get(redemptionId).status).toBe(WeleticRedemptionStatus.provisioning);
    });
  });

  // ==========================================================================
  // CHALLENGE 2: Multiple Transactions Discrimination & Filtering
  // ==========================================================================
  describe("Challenge 2: Multiple Transactions Discrimination", () => {
    it("Accurately identifies matching transaction among multiple customer transactions (old, future, different amount)", async () => {
      const attemptTime = new Date("2026-10-05T10:00:05.000Z");
      const { redemptionId } = createFixture({
        amountMinor: "500",
        currency: "USD",
        createdAt: new Date("2026-10-05T10:00:00.000Z"),
        remoteAttemptedAt: attemptTime.toISOString(),
      });

      const targetTxId = "gid://shopify/StoreCreditAccountCreditTransaction/tx_target_correct";

      // 5 transactions in history:
      const customFetch = createShopifyMockFetch([
        // 1. Old transaction from yesterday (outside proximity window)
        {
          id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_yesterday",
          amount: "5.00",
          currencyCode: "USD",
          createdAt: "2026-10-04T10:00:00.000Z",
        },
        // 2. Transaction 3 minutes before attempt (outside 120s proximity)
        {
          id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_too_early",
          amount: "5.00",
          currencyCode: "USD",
          createdAt: new Date(attemptTime.getTime() - 180_000).toISOString(),
        },
        // 3. Different amount at the exact attempt time
        {
          id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_diff_amount",
          amount: "25.00",
          currencyCode: "USD",
          createdAt: "2026-10-05T10:00:06.000Z",
        },
        // 4. Exact match: 5.00 USD created 2s after attempt
        {
          id: targetTxId,
          amount: "5.00",
          currencyCode: "USD",
          createdAt: "2026-10-05T10:00:07.000Z",
        },
        // 5. Far future transaction
        {
          id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_future",
          amount: "5.00",
          currencyCode: "USD",
          createdAt: "2026-10-05T12:00:00.000Z",
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });

      expect(result).toEqual({
        outcome: "confirmed",
        transactionId: targetTxId,
      });

      const redemption = mockState.redemptions.get(redemptionId);
      expect(redemption.status).toBe(WeleticRedemptionStatus.issued);
      expect(redemption.shopifyStoreCreditTransactionId).toBe(targetTxId);
    });

    it("Discriminates correctly when the matching transaction is located at the very end of a 10-item transaction list", async () => {
      const attemptTime = new Date("2026-10-05T10:00:05.000Z");
      const { redemptionId } = createFixture({
        amountMinor: "500",
        currency: "USD",
        createdAt: new Date("2026-10-05T10:00:00.000Z"),
        remoteAttemptedAt: attemptTime.toISOString(),
      });

      const lastTxId = "gid://shopify/StoreCreditAccountCreditTransaction/tx_tail_match";

      // 9 non-matching transactions followed by 1 valid match at the tail
      const transactions = [
        ...Array.from({ length: 9 }).map((_, i) => ({
          id: `gid://shopify/StoreCreditAccountCreditTransaction/tx_distractor_${i}`,
          amount: `${(i + 1) * 10}.00`,
          currencyCode: "USD",
          createdAt: new Date(attemptTime.getTime() + (i + 1) * 1000).toISOString(),
        })),
        {
          id: lastTxId,
          amount: "5.00",
          currencyCode: "USD",
          createdAt: "2026-10-05T10:00:08.000Z",
        },
      ];

      const customFetch = createShopifyMockFetch(transactions);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });

      expect(result).toEqual({
        outcome: "confirmed",
        transactionId: lastTxId,
      });
      expect(mockState.redemptions.get(redemptionId).shopifyStoreCreditTransactionId).toBe(lastTxId);
    });

    it("Enforces minCreatedAt temporal window boundary (-120 seconds)", async () => {
      const attemptTime = new Date("2026-10-05T10:00:00.000Z");
      const { redemptionId } = createFixture({
        amountMinor: "500",
        currency: "USD",
        createdAt: attemptTime,
        remoteAttemptedAt: attemptTime.toISOString(),
      });

      // Transaction 121 seconds prior: strictly outside (-120_000ms boundary)
      const txOutsideId = "gid://shopify/StoreCreditAccountCreditTransaction/tx_outside_window";
      const customFetch = createShopifyMockFetch([
        {
          id: txOutsideId,
          amount: "5.00",
          currencyCode: "USD",
          createdAt: new Date(attemptTime.getTime() - 121_000).toISOString(),
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:00:30.000Z"),
        customFetch,
      });

      expect(result).toEqual({ outcome: "deferred" });
      expect(mockState.redemptions.get(redemptionId).shopifyStoreCreditTransactionId).toBeNull();
    });
  });

  // ==========================================================================
  // CHALLENGE 3: Collision Prevention & Double-Claim Protection
  // ==========================================================================
  describe("Challenge 3: Collision Prevention & Double-Claim Protection", () => {
    it("Strictly refuses to claim a transaction ID already bound to another redemption in database", async () => {
      const sharedTxId = "gid://shopify/StoreCreditAccountCreditTransaction/tx_already_claimed";

      // 1. Pre-existing redemption that already claimed sharedTxId
      createFixture({
        redemptionId: "redemp_existing_holder",
        status: WeleticRedemptionStatus.issued,
        shopifyStoreCreditTransactionId: sharedTxId,
      });

      // 2. New pending redemption attempting reconciliation
      const { redemptionId } = createFixture({
        redemptionId: "redemp_colliding_challenger",
        amountMinor: "500",
        currency: "USD",
      });

      // Shopify returns the sharedTxId
      const customFetch = createShopifyMockFetch([
        {
          id: sharedTxId,
          amount: "5.00",
          currencyCode: "USD",
          createdAt: "2026-10-05T10:00:06.000Z",
        },
      ]);

      // Reconcile within active horizon -> must NOT bind sharedTxId
      const resultActive = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });

      expect(resultActive).toEqual({ outcome: "deferred" });
      expect(mockState.redemptions.get(redemptionId).shopifyStoreCreditTransactionId).toBeNull();

      // Reconcile after horizon expiry -> must refund and fail without claiming sharedTxId
      const resultExpired = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:10:00.000Z"),
        customFetch,
      });

      expect(resultExpired).toEqual({ outcome: "refunded_and_failed" });
      expect(mockState.redemptions.get(redemptionId).status).toBe(WeleticRedemptionStatus.failed);
      expect(mockState.redemptions.get(redemptionId).shopifyStoreCreditTransactionId).toBeNull();

      // Original owner remains untouched
      expect(mockState.redemptions.get("redemp_existing_holder").shopifyStoreCreditTransactionId).toBe(sharedTxId);
    });

    it("Skips bound collision transaction and successfully binds the second unclaimed matching transaction", async () => {
      const boundTxId = "gid://shopify/StoreCreditAccountCreditTransaction/tx_bound_1";
      const availableTxId = "gid://shopify/StoreCreditAccountCreditTransaction/tx_available_2";

      // Pre-bind boundTxId to redemp_prior
      createFixture({
        redemptionId: "redemp_prior",
        status: WeleticRedemptionStatus.issued,
        shopifyStoreCreditTransactionId: boundTxId,
      });

      // New pending redemption
      const { redemptionId } = createFixture({
        redemptionId: "redemp_second",
        amountMinor: "500",
        currency: "USD",
      });

      // Both transactions returned by Shopify
      const customFetch = createShopifyMockFetch([
        {
          id: boundTxId,
          amount: "5.00",
          currencyCode: "USD",
          createdAt: "2026-10-05T10:00:06.000Z",
        },
        {
          id: availableTxId,
          amount: "5.00",
          currencyCode: "USD",
          createdAt: "2026-10-05T10:00:08.000Z",
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });

      // Must bypass boundTxId and select availableTxId
      expect(result).toEqual({
        outcome: "confirmed",
        transactionId: availableTxId,
      });
      expect(mockState.redemptions.get(redemptionId).shopifyStoreCreditTransactionId).toBe(availableTxId);
      expect(mockState.redemptions.get("redemp_prior").shopifyStoreCreditTransactionId).toBe(boundTxId);
    });

    it("Tenant isolation: same transaction ID in another store is not a collision in multi-store DB", async () => {
      const otherStoreId = "store_other_tenant";
      const txId = "gid://shopify/StoreCreditAccountCreditTransaction/tx_tenant_test";

      // Bound in another store
      createFixture({
        redemptionId: "redemp_other_store",
        targetStoreId: otherStoreId,
        status: WeleticRedemptionStatus.issued,
        shopifyStoreCreditTransactionId: txId,
      });

      // Pending in target store
      const { redemptionId } = createFixture({
        redemptionId: "redemp_my_store",
        targetStoreId: storeId,
        amountMinor: "500",
        currency: "USD",
      });

      const customFetch = createShopifyMockFetch([
        {
          id: txId,
          amount: "5.00",
          currencyCode: "USD",
          createdAt: "2026-10-05T10:00:06.000Z",
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });

      // Since collision check queries `where: { storeId: redemption.storeId }`, it is isolated per store
      expect(result).toEqual({
        outcome: "confirmed",
        transactionId: txId,
      });
    });
  });

  // ==========================================================================
  // CHALLENGE 4: Currency Mismatch Handling
  // ==========================================================================
  describe("Challenge 4: Currency Mismatch Handling", () => {
    it("Rejects transaction when customer has 500 JPY on Shopify but redemption expected 5.00 USD", async () => {
      const { redemptionId } = createFixture({
        amountMinor: "500", // $5.00 USD
        currency: "USD",
        createdAt: new Date("2026-10-05T10:00:00.000Z"),
        remoteAttemptedAt: "2026-10-05T10:00:05.000Z",
      });

      // Customer account on Shopify received 500 JPY
      const customFetch = createShopifyMockFetch([
        {
          id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_jpy_mismatch",
          amount: "500",
          currencyCode: "JPY",
          createdAt: "2026-10-05T10:00:06.000Z",
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"), // Active horizon
        customFetch,
      });

      // Currency code JPY !== USD -> skipped, defer
      expect(result).toEqual({ outcome: "deferred" });
      expect(mockState.redemptions.get(redemptionId).shopifyStoreCreditTransactionId).toBeNull();
    });

    it("Rejects transaction when amount is identical (5.00) but currency is EUR instead of USD", async () => {
      const { redemptionId } = createFixture({
        amountMinor: "500", // 5.00 USD
        currency: "USD",
        createdAt: new Date("2026-10-05T10:00:00.000Z"),
        remoteAttemptedAt: "2026-10-05T10:00:05.000Z",
      });

      const customFetch = createShopifyMockFetch([
        {
          id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_eur_mismatch",
          amount: "5.00",
          currencyCode: "EUR",
          createdAt: "2026-10-05T10:00:06.000Z",
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });

      expect(result).toEqual({ outcome: "deferred" });
      expect(mockState.redemptions.get(redemptionId).shopifyStoreCreditTransactionId).toBeNull();
    });

    it("Supports case-insensitive currency matching ('usd' in Shopify vs 'USD' in snapshot)", async () => {
      const { redemptionId } = createFixture({
        amountMinor: "500",
        currency: "USD",
      });

      const customFetch = createShopifyMockFetch([
        {
          id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_lowercase_currency",
          amount: "5.00",
          currencyCode: "usd", // lowercase
          createdAt: "2026-10-05T10:00:06.000Z",
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });

      expect(result).toEqual({
        outcome: "confirmed",
        transactionId: "gid://shopify/StoreCreditAccountCreditTransaction/tx_lowercase_currency",
      });
      expect(mockState.redemptions.get(redemptionId).status).toBe(WeleticRedemptionStatus.issued);
    });
  });

  // ==========================================================================
  // CHALLENGE 5: Resiliency, Fallbacks, and Sweeper Error Isolation
  // ==========================================================================
  describe("Challenge 5: Resiliency & Error Isolation", () => {
    it("Falls back gracefully to redemption.createdAt when remoteProvisionAttemptedAt is missing", async () => {
      const createdAt = new Date("2026-10-05T10:00:00.000Z");
      const { redemptionId } = createFixture({
        createdAt,
        remoteAttemptedAt: undefined as any, // missing attempt time
      });

      // Remove remoteProvisionAttemptedAt from metadata
      mockState.redemptions.get(redemptionId).metadata.remoteProvisionAttemptedAt = null;

      const expectedTxId = "gid://shopify/StoreCreditAccountCreditTransaction/tx_fallback_created_at";
      const customFetch = createShopifyMockFetch([
        {
          id: expectedTxId,
          amount: "5.00",
          currencyCode: "USD",
          createdAt: "2026-10-05T10:00:10.000Z", // within 120s of createdAt
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });

      expect(result).toEqual({
        outcome: "confirmed",
        transactionId: expectedTxId,
      });
      expect(mockState.redemptions.get(redemptionId).shopifyStoreCreditTransactionId).toBe(expectedTxId);
    });

    it("Sweeper continues executing subsequent redemptions even if one redemption encounters network failure", async () => {
      // Redemption 1: Fails with permanent network failure
      const customerFailNumeric = "9998887771";
      const { redemptionId: failRedempId } = createFixture({
        redemptionId: "sweep_fail_1",
        createdAt: new Date("2026-10-05T08:00:00.000Z"),
        remoteAttemptedAt: "2026-10-05T08:00:05.000Z",
      });
      mockState.accounts.get("acc_store_adversarial_rewards").shopper.shopifyCustomerId = customerFailNumeric;

      // Redemption 2: Succeeds and confirms on a second store/account
      const secondStoreId = "store_sweep_success";
      const customerSuccessNumeric = "1112223334";
      const { redemptionId: successRedempId } = createFixture({
        redemptionId: "sweep_success_2",
        targetStoreId: secondStoreId,
        createdAt: new Date("2026-10-05T08:00:00.000Z"),
        remoteAttemptedAt: "2026-10-05T08:00:05.000Z",
      });
      mockState.accounts.get(`acc_${secondStoreId}`).shopper.shopifyCustomerId = customerSuccessNumeric;

      const customFetch = vi.fn(async (_url: any, init: any) => {
        const body = JSON.parse(init.body);
        if (body.variables?.id?.includes(customerFailNumeric)) {
          throw new Error("Shopify network connection timeout");
        }
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({
            data: {
              customer: {
                id: `gid://shopify/Customer/${customerSuccessNumeric}`,
                storeCreditAccounts: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/StoreCreditAccount/acc_success",
                        balance: { amount: "5.00", currencyCode: "USD" },
                        transactions: {
                          edges: [
                            {
                              node: {
                                id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_sweep_ok",
                                amount: { amount: "5.00", currencyCode: "USD" },
                                createdAt: "2026-10-05T08:00:06.000Z",
                                expiresAt: null,
                              },
                            },
                          ],
                        },
                      },
                    },
                  ],
                },
              },
            },
          }),
        } as any;
      });

      const sweepResult = await reconcilePendingStoreCreditRedemptionsSweep({
        batchSize: 10,
        now: new Date("2026-10-05T08:02:00.000Z"),
        customFetch: customFetch as any,
      });

      expect(sweepResult.scanned).toBe(2);
      expect(sweepResult.errors).toBe(1);
      expect(sweepResult.confirmed).toBe(1);
      expect(sweepResult.details).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            redemptionId: failRedempId,
            outcome: "error",
            error: expect.stringContaining("timeout"),
          }),
          expect.objectContaining({
            redemptionId: successRedempId,
            outcome: "confirmed",
          }),
        ]),
      );
    });

    it("Skips non-provisioning redemption safely without mutating data", async () => {
      const { redemptionId } = createFixture({
        status: WeleticRedemptionStatus.issued,
        shopifyStoreCreditTransactionId: "existing_tx",
      });

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date(),
      });

      expect(result).toEqual({
        outcome: "skipped",
        reason: "status_issued",
      });
      expect(mockState.redemptions.get(redemptionId).shopifyStoreCreditTransactionId).toBe("existing_tx");
      expect(mockState.compensations).toHaveLength(0);
    });

    it("FIN-01 alignment: reconciles large non-decimal currency (2,500,000,000 VND) without overflow", async () => {
      const largeVndAmount = "2500000000";
      const { redemptionId } = createFixture({
        amountMinor: largeVndAmount,
        currency: "VND",
        pointsSpent: BigInt(5000000),
      });

      const expectedTxId = "gid://shopify/StoreCreditAccountCreditTransaction/tx_vnd_large";
      const customFetch = createShopifyMockFetch([
        {
          id: expectedTxId,
          amount: largeVndAmount,
          currencyCode: "VND",
          createdAt: "2026-10-05T10:00:06.000Z",
        },
      ]);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });

      expect(result).toEqual({
        outcome: "confirmed",
        transactionId: expectedTxId,
      });
      expect(mockState.redemptions.get(redemptionId).shopifyStoreCreditTransactionId).toBe(expectedTxId);
    });

    it("Multi-account customer: traverses multiple store credit accounts to locate matching transaction", async () => {
      const { redemptionId } = createFixture({
        amountMinor: "500",
        currency: "USD",
      });

      const targetTxId = "gid://shopify/StoreCreditAccountCreditTransaction/tx_in_second_account";

      // Mock customer with two distinct store credit accounts (e.g. CAD and USD)
      const multiAccountFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          data: {
            customer: {
              id: customerGid,
              storeCreditAccounts: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/StoreCreditAccount/acc_cad",
                      balance: { amount: "20.00", currencyCode: "CAD" },
                      transactions: {
                        edges: [
                          {
                            node: {
                              id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_cad_unrelated",
                              amount: { amount: "5.00", currencyCode: "CAD" },
                              createdAt: "2026-10-05T10:00:06.000Z",
                              expiresAt: null,
                            },
                          },
                        ],
                      },
                    },
                  },
                  {
                    node: {
                      id: "gid://shopify/StoreCreditAccount/acc_usd",
                      balance: { amount: "50.00", currencyCode: "USD" },
                      transactions: {
                        edges: [
                          {
                            node: {
                              id: targetTxId,
                              amount: { amount: "5.00", currencyCode: "USD" },
                              createdAt: "2026-10-05T10:00:07.000Z",
                              expiresAt: null,
                            },
                          },
                        ],
                      },
                    },
                  },
                ],
              },
            },
          },
        }),
      })) as any;

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch: multiAccountFetch,
      });

      expect(result).toEqual({
        outcome: "confirmed",
        transactionId: targetTxId,
      });
      expect(mockState.redemptions.get(redemptionId).shopifyStoreCreditTransactionId).toBe(targetTxId);
    });

    it("Gracefully skips redemption when metadata or provisioning snapshot is missing/corrupted", async () => {
      const { redemptionId } = createFixture();
      mockState.redemptions.get(redemptionId).metadata = null;

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date(),
      });

      expect(result).toEqual({
        outcome: "skipped",
        reason: "missing_snapshot",
      });
    });

    it("Gracefully skips redemption when customer identifier cannot be resolved", async () => {
      const { redemptionId } = createFixture();
      mockState.accounts.get("acc_store_adversarial_rewards").shopper.shopifyCustomerId = null;

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date(),
      });

      expect(result).toEqual({
        outcome: "skipped",
        reason: "missing_customer_id",
      });
    });

    it("Honors custom reconciliationHorizonMs parameter", async () => {
      const createdAt = new Date("2026-10-05T10:00:00.000Z");
      const { redemptionId } = createFixture({
        createdAt,
        remoteAttemptedAt: "2026-10-05T10:00:05.000Z",
      });

      // Shopify returns no transactions
      const customFetch = createShopifyMockFetch([]);

      // 40 seconds later with custom 30s horizon (default is 5 minutes)
      const now = new Date("2026-10-05T10:00:45.000Z");

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now,
        reconciliationHorizonMs: 30_000, // 30s custom horizon
        customFetch,
      });

      expect(result).toEqual({ outcome: "refunded_and_failed" });
      expect(mockState.redemptions.get(redemptionId).status).toBe(WeleticRedemptionStatus.failed);
      expect(mockState.compensations).toHaveLength(1);
    });
  });
});
