import {
  createLoyaltyRedemptionProvisioningSnapshot,
  getShopifyCustomerSelectionDigest,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import {
  reconcilePendingStoreCreditRedemption,
  reconcilePendingStoreCreditRedemptionsSweep,
} from "@/lib/weletic/loyalty/store-credit-reconciliation";
import {
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// State store
const mockDb = {
  redemptions: new Map<string, any>(),
  accounts: new Map<string, any>(),
  compensations: [] as any[],
  outboxJobs: [] as any[],
  flowTriggers: [] as any[],
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticRewardRedemption: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = mockDb.redemptions.get(where.id);
        if (!row) return null;
        return {
          ...row,
          account: mockDb.accounts.get(row.accountId) ?? null,
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
          for (const row of mockDb.redemptions.values()) {
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
          for (const row of mockDb.redemptions.values()) {
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
          const row = mockDb.redemptions.get(where.id);
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
        return mockDb.accounts.get(where.id) ?? null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: any }) => {
          const acc = mockDb.accounts.get(where.id);
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
    async ({ operation }: { operation: (tx: any) => Promise<any> }) => {
      const { prisma } = await import("@/lib/prisma");
      return operation(prisma);
    },
  ),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn(async (params: any) => {
    mockDb.flowTriggers.push(params);
  }),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: vi.fn(async (job: any) => {
    mockDb.outboxJobs.push(job);
  }),
  enqueueOutboxJobFromProgramTransaction: vi.fn(async (job: any) => {
    mockDb.outboxJobs.push(job);
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
      mockDb.compensations.push({ redemptionId, reason, targetStatus });
      const row = mockDb.redemptions.get(redemptionId);
      if (row) {
        row.status = targetStatus ?? WeleticRedemptionStatus.failed;
        row.compensationReason = reason;
        const acc = mockDb.accounts.get(row.accountId);
        if (acc) {
          acc.cachedPointsBalance += row.pointsSpent;
        }
      }
    },
  ),
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/weletic/loyalty/shopify-discounts")
    >();
  return {
    ...actual,
    resolveShopifyOfflineCredentials: vi.fn(
      async ({ storeId }: { storeId: string }) => ({
        shopDomain: `${storeId}.myshopify.com`,
        accessToken: `shpat_${storeId}_offline`,
        scope:
          "read_gift_cards,write_gift_cards,write_customers,read_store_credit_accounts,write_store_credit_account_transactions",
        source: "app_session",
      }),
    ),
  };
});

describe("Auditor Challenger Stress Tests: FIN-03 Store Credit Reconciliation", () => {
  const storeId = "store_auditor_stress";
  const customerId = "9988776655";
  const customerGid = `gid://shopify/Customer/${customerId}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.redemptions.clear();
    mockDb.accounts.clear();
    mockDb.compensations = [];
    mockDb.outboxJobs = [];
    mockDb.flowTriggers = [];
  });

  function setupFixture({
    id,
    amountMinor = "1000", // $10.00
    pointsSpent = BigInt(1000),
    currency = "USD",
    createdAt = new Date("2026-10-05T10:00:00.000Z"),
    remoteAttemptedAt = "2026-10-05T10:00:05.000Z",
    hasShopperCustomerId = true,
    snapshotOverride = null as any,
  }: {
    id: string;
    amountMinor?: string;
    pointsSpent?: bigint;
    currency?: string;
    createdAt?: Date;
    remoteAttemptedAt?: string | null;
    hasShopperCustomerId?: boolean;
    snapshotOverride?: any;
  }) {
    const accountId = `acc_${id}`;
    mockDb.accounts.set(accountId, {
      id: accountId,
      storeId,
      cachedPointsBalance: BigInt(5000),
      shopper: hasShopperCustomerId
        ? {
            id: `shopper_${id}`,
            shopifyCustomerId: customerId,
          }
        : null,
    });

    const provisioningSnapshot =
      snapshotOverride !== null
        ? snapshotOverride
        : createLoyaltyRedemptionProvisioningSnapshot({
            reward: {
              id: `rew_${id}`,
              name: `$${Number(amountMinor) / 100} Store Credit`,
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
              storeId,
              shopifyCustomerId: customerId,
            }),
            startsAt: new Date("2026-10-01T00:00:00.000Z"),
            expiresAt: null,
          });

    mockDb.redemptions.set(id, {
      id,
      storeId,
      accountId,
      pointsSpent,
      shopifyDiscountCode: `WLSC_${id}`,
      shopifyDiscountCodeCanonical: `WLSC_${id}`,
      artifactKind: WeleticRewardArtifactKind.store_credit,
      status: WeleticRedemptionStatus.provisioning,
      shopifyStoreCreditTransactionId: null,
      issuanceConfirmedAt: null,
      createdAt,
      metadata: {
        remoteProvisionAttemptedAt: remoteAttemptedAt,
        provisioningSnapshot,
      },
    });
  }

  // --------------------------------------------------------------------------
  // Stress 1: Collision Prevention (Single transaction cannot be claimed twice)
  // --------------------------------------------------------------------------
  it("Stress 1: Prevents double-claiming the same Shopify transaction across two identical redemptions", async () => {
    setupFixture({
      id: "redemp_first",
      createdAt: new Date("2026-10-05T10:00:00.000Z"),
      remoteAttemptedAt: "2026-10-05T10:00:05.000Z",
    });
    setupFixture({
      id: "redemp_second",
      createdAt: new Date("2026-10-05T10:00:02.000Z"),
      remoteAttemptedAt: "2026-10-05T10:00:07.000Z",
    });

    const txId =
      "gid://shopify/StoreCreditAccountCreditTransaction/tx_shared_single";

    const customFetch = vi.fn(async () => ({
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
                    id: "gid://shopify/StoreCreditAccount/acc_01",
                    balance: { amount: "10.00", currencyCode: "USD" },
                    transactions: {
                      edges: [
                        {
                          node: {
                            id: txId,
                            amount: { amount: "10.00", currencyCode: "USD" },
                            createdAt: "2026-10-05T10:00:06.000Z",
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

    // 1. Reconcile first redemption: successfully claims txId
    const res1 = await reconcilePendingStoreCreditRedemption({
      storeId,
      redemptionId: "redemp_first",
      now: new Date("2026-10-05T10:01:00.000Z"),
      customFetch,
    });
    expect(res1).toEqual({ outcome: "confirmed", transactionId: txId });
    expect(
      mockDb.redemptions.get("redemp_first").shopifyStoreCreditTransactionId,
    ).toBe(txId);

    // 2. Reconcile second redemption: txId is already bound to redemp_first in DB!
    // Since horizon is 5 minutes and now is 1 min later, it must be DEFERRED, NOT confirmed with txId!
    const res2 = await reconcilePendingStoreCreditRedemption({
      storeId,
      redemptionId: "redemp_second",
      now: new Date("2026-10-05T10:01:00.000Z"),
      customFetch,
    });
    expect(res2).toEqual({ outcome: "deferred" });
    expect(
      mockDb.redemptions.get("redemp_second").shopifyStoreCreditTransactionId,
    ).toBeNull();

    // 3. Reconcile second redemption after horizon (10 minutes later): must transition to failed & refund points
    const res3 = await reconcilePendingStoreCreditRedemption({
      storeId,
      redemptionId: "redemp_second",
      now: new Date("2026-10-05T10:11:00.000Z"),
      customFetch,
    });
    expect(res3).toEqual({ outcome: "refunded_and_failed" });
    expect(mockDb.redemptions.get("redemp_second").status).toBe(
      WeleticRedemptionStatus.failed,
    );
  });

  // --------------------------------------------------------------------------
  // Stress 2: Currency Mismatch Rejection
  // --------------------------------------------------------------------------
  it("Stress 2: Rejects transaction when amount matches but currency differs (JPY vs USD)", async () => {
    // Redemption in JPY (500 JPY)
    setupFixture({
      id: "redemp_jpy",
      amountMinor: "500",
      currency: "JPY",
      createdAt: new Date("2026-10-05T10:00:00.000Z"),
      remoteAttemptedAt: "2026-10-05T10:00:05.000Z",
    });

    // Remote Shopify has a transaction for 500 USD (not JPY)
    const customFetch = vi.fn(async () => ({
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
                    id: "gid://shopify/StoreCreditAccount/acc_01",
                    balance: { amount: "500.00", currencyCode: "USD" },
                    transactions: {
                      edges: [
                        {
                          node: {
                            id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_usd_500",
                            amount: { amount: "500", currencyCode: "USD" },
                            createdAt: "2026-10-05T10:00:06.000Z",
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

    const res = await reconcilePendingStoreCreditRedemption({
      storeId,
      redemptionId: "redemp_jpy",
      now: new Date("2026-10-05T10:10:00.000Z"), // horizon expired
      customFetch,
    });

    // Since USD != JPY, the transaction is rejected; horizon expired -> refunded_and_failed
    expect(res).toEqual({ outcome: "refunded_and_failed" });
    expect(mockDb.redemptions.get("redemp_jpy").status).toBe(
      WeleticRedemptionStatus.failed,
    );
  });

  // --------------------------------------------------------------------------
  // Stress 3: Temporal Proximity Window Boundary
  // --------------------------------------------------------------------------
  it("Stress 3: Rejects transactions created outside the proximity window (-120s buffer)", async () => {
    const attemptTime = new Date("2026-10-05T10:00:00.000Z");
    setupFixture({
      id: "redemp_temporal",
      createdAt: attemptTime,
      remoteAttemptedAt: attemptTime.toISOString(),
    });

    // Transaction was created 121 seconds BEFORE the attempt (outside [-120s, +10min] window)
    const staleTxCreatedAt = new Date(
      attemptTime.getTime() - 121_000,
    ).toISOString();

    const customFetch = vi.fn(async () => ({
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
                    id: "gid://shopify/StoreCreditAccount/acc_01",
                    balance: { amount: "10.00", currencyCode: "USD" },
                    transactions: {
                      edges: [
                        {
                          node: {
                            id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_too_old",
                            amount: { amount: "10.00", currencyCode: "USD" },
                            createdAt: staleTxCreatedAt,
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

    const res = await reconcilePendingStoreCreditRedemption({
      storeId,
      redemptionId: "redemp_temporal",
      now: new Date("2026-10-05T10:02:00.000Z"), // 2 mins later, within horizon
      customFetch,
    });

    // Stale transaction should not match; outcome is deferred
    expect(res).toEqual({ outcome: "deferred" });
    expect(mockDb.redemptions.get("redemp_temporal").status).toBe(
      WeleticRedemptionStatus.provisioning,
    );
  });

  // --------------------------------------------------------------------------
  // Stress 4: Sweeper Batch Resilience against Partial Failures
  // --------------------------------------------------------------------------
  it("Stress 4: Sweeper processes batch resiliently even when individual items throw", async () => {
    // 3 redemptions older than 60s
    setupFixture({
      id: "sweep_ok_1",
      createdAt: new Date("2026-10-05T09:00:00.000Z"),
      remoteAttemptedAt: "2026-10-05T09:00:05.000Z",
    });
    setupFixture({
      id: "sweep_error_2",
      createdAt: new Date("2026-10-05T09:00:00.000Z"),
      remoteAttemptedAt: "2026-10-05T09:00:05.000Z",
    });
    setupFixture({
      id: "sweep_ok_3",
      createdAt: new Date("2026-10-05T08:00:00.000Z"),
      remoteAttemptedAt: "2026-10-05T08:00:05.000Z",
    });

    let callCount = 0;
    const customFetch = vi.fn(async () => {
      callCount++;
      // sweep_error_2 retries once (maxRetries: 1), so calls 2 and 3 both throw
      if (callCount === 2 || callCount === 3) {
        throw new Error("Simulated Shopify 503 Service Unavailable");
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          data: {
            customer: {
              id: customerGid,
              storeCreditAccounts: {
                edges:
                  callCount === 1
                    ? [
                        {
                          node: {
                            id: "gid://shopify/StoreCreditAccount/acc_01",
                            balance: { amount: "10.00", currencyCode: "USD" },
                            transactions: {
                              edges: [
                                {
                                  node: {
                                    id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_batch",
                                    amount: {
                                      amount: "10.00",
                                      currencyCode: "USD",
                                    },
                                    createdAt: "2026-10-05T09:00:06.000Z",
                                    expiresAt: null,
                                  },
                                },
                              ],
                            },
                          },
                        },
                      ]
                    : [], // callCount 4 (sweep_ok_3) returns no transactions -> times out
              },
            },
          },
        }),
      } as any;
    });

    const result = await reconcilePendingStoreCreditRedemptionsSweep({
      batchSize: 10,
      now: new Date("2026-10-05T09:10:00.000Z"),
      customFetch: customFetch as any,
    });

    expect(result.scanned).toBe(3);
    expect(result.confirmed).toBe(1); // sweep_ok_1 confirmed
    expect(result.errors).toBe(1); // sweep_error_2 errored without crashing sweep
    expect(result.refunded).toBe(1); // sweep_ok_3 timed out and refunded
    expect(result.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          redemptionId: "sweep_error_2",
          outcome: "error",
          error: expect.stringContaining(
            "Simulated Shopify 503 Service Unavailable",
          ),
        }),
      ]),
    );
  });

  // --------------------------------------------------------------------------
  // Stress 5: Corrupt or Missing Snapshot Handling
  // --------------------------------------------------------------------------
  it("Stress 5: Safely skips redemption with missing or non-store-credit provisioning snapshot", async () => {
    // 5a: Missing snapshot (null)
    setupFixture({
      id: "redemp_no_snapshot",
      snapshotOverride: "NONE",
    });
    // Manually delete provisioningSnapshot from metadata
    mockDb.redemptions.get("redemp_no_snapshot").metadata.provisioningSnapshot =
      null;

    const res1 = await reconcilePendingStoreCreditRedemption({
      storeId,
      redemptionId: "redemp_no_snapshot",
    });

    expect(res1).toEqual({ outcome: "skipped", reason: "missing_snapshot" });

    // 5b: Non-store-credit snapshot (gift_card)
    const giftCardSnapshot = createLoyaltyRedemptionProvisioningSnapshot({
      reward: {
        id: "rew_gift_card",
        name: "$10 Gift Card",
        description: null,
        rewardType: "gift_card",
        salesChannel: "both",
        exchangeType: "fixed",
        purchasePolicy: null,
        discountValue: "1000",
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
      pointsCost: BigInt(1000),
      discountValue: "1000",
      expiresInDays: null,
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-10-01T00:00:00.000Z"),
      customerSelectionDigest: getShopifyCustomerSelectionDigest({
        storeId,
        shopifyCustomerId: customerId,
      }),
      startsAt: new Date("2026-10-01T00:00:00.000Z"),
      expiresAt: null,
    });

    setupFixture({
      id: "redemp_wrong_reward_type",
      snapshotOverride: giftCardSnapshot,
    });

    const res2 = await reconcilePendingStoreCreditRedemption({
      storeId,
      redemptionId: "redemp_wrong_reward_type",
    });

    expect(res2).toEqual({ outcome: "skipped", reason: "missing_snapshot" });
    expect(mockDb.compensations).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Stress 6: Missing Customer ID Handling
  // --------------------------------------------------------------------------
  it("Stress 6: Safely skips redemption when customer lacks shopifyCustomerId", async () => {
    setupFixture({
      id: "redemp_no_cust_id",
      hasShopperCustomerId: false,
    });

    const res = await reconcilePendingStoreCreditRedemption({
      storeId,
      redemptionId: "redemp_no_cust_id",
    });

    expect(res).toEqual({ outcome: "skipped", reason: "missing_customer_id" });
  });
});
