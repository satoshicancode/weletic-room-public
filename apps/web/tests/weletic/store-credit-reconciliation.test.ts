import {
  createLoyaltyRedemptionProvisioningSnapshot,
  getShopifyCustomerSelectionDigest,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import { auditShopifyCustomerStoreCreditTransactions } from "@/lib/weletic/loyalty/shopify-financial-rewards";
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
    async ({ operation }: { operation: (tx: any) => Promise<any> }) => {
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
        // Refund points to account balance
        const acc = mockState.accounts.get(row.accountId);
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
      async ({ storeId }: { storeId: string }) => {
        // Canonical mock credentials dynamic to storeId
        return {
          shopDomain: `${storeId}.myshopify.com`,
          accessToken: `shpat_${storeId}_offline_token`,
          scope:
            "read_gift_cards,write_gift_cards,write_customers,read_store_credit_accounts,write_store_credit_account_transactions",
          source: "app_session",
        };
      },
    ),
  };
});

// ============================================================================
// Test Suite
// ============================================================================

describe("FIN-03: Store Credit Remote Outcome Reconciliation", () => {
  const storeId = "store_acme_rewards";
  const customerId = "7891234567";
  const customerGid = `gid://shopify/Customer/${customerId}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.redemptions.clear();
    mockState.accounts.clear();
    mockState.outboxJobs = [];
    mockState.flowTriggers = [];
    mockState.compensations = [];
  });

  function createTestFixture({
    redemptionId = "redemp_sc_101",
    targetStoreId = storeId,
    amountMinor = "500", // $5.00
    pointsSpent = BigInt(500),
    currency = "USD",
    createdAt = new Date("2026-10-05T10:00:00.000Z"),
    remoteAttemptedAt = "2026-10-05T10:00:05.000Z",
    initialBalance = BigInt(2000), // Customer had 2500, deducted 500 -> 2000 remaining
  } = {}) {
    const accountId =
      targetStoreId === storeId ? "acc_1" : `acc_${targetStoreId}`;
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
        id: "rew_sc_5",
        name: "$5 Store Credit",
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
      shopifyDiscountCode: "WLSC12345678",
      shopifyDiscountCodeCanonical: "WLSC12345678",
      artifactKind: WeleticRewardArtifactKind.store_credit,
      status: WeleticRedemptionStatus.provisioning,
      shopifyStoreCreditTransactionId: null,
      issuanceConfirmedAt: null,
      createdAt,
      metadata: {
        remoteProvisionAttemptedAt: remoteAttemptedAt,
        remoteProvisionPreparationId: "frp_test_prep_123",
        provisioningSnapshot,
      },
    });

    return { redemptionId };
  }

  // --------------------------------------------------------------------------
  // GraphQL Audit Helper Verification
  // --------------------------------------------------------------------------
  it("GraphQL Audit Helper queries Shopify customer store credit transactions and extracts array", async () => {
    const customFetch = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      expect(body.variables.id).toBe(customerGid);
      expect(body.query).toContain("WeleticCustomerStoreCreditAudit");

      return {
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
                      balance: { amount: "15.00", currencyCode: "USD" },
                      transactions: {
                        edges: [
                          {
                            node: {
                              id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_999",
                              amount: { amount: "5.00", currencyCode: "USD" },
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
      } as any;
    });

    const txs = await auditShopifyCustomerStoreCreditTransactions({
      credentials: {
        shopDomain: "acme.myshopify.com",
        accessToken: "shpat_mock",
        scope:
          "read_store_credit_accounts,write_store_credit_account_transactions",
        source: "app_session",
      },
      customerId,
      customFetch: customFetch as any,
    });

    expect(txs).toHaveLength(1);
    expect(txs[0]).toEqual({
      id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_999",
      accountId: "gid://shopify/StoreCreditAccount/acc_01",
      amount: "5.00",
      currencyCode: "USD",
      createdAt: new Date("2026-10-05T10:00:06.000Z"),
      expiresAt: null,
    });
  });

  // --------------------------------------------------------------------------
  // Test Case 1: Matching transaction found on Shopify
  // --------------------------------------------------------------------------
  it("Test Case 1: Matching transaction found on Shopify -> redemption transitions to 'issued', sets shopifyStoreCreditTransactionId, points stay deducted", async () => {
    const { redemptionId } = createTestFixture();

    const expectedTxId =
      "gid://shopify/StoreCreditAccountCreditTransaction/confirmed_tx_123";

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
                    balance: { amount: "5.00", currencyCode: "USD" },
                    transactions: {
                      edges: [
                        {
                          node: {
                            id: expectedTxId,
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
      customFetch,
    });

    expect(result).toEqual({
      outcome: "confirmed",
      transactionId: expectedTxId,
    });

    // Redemption record verified
    const updated = mockState.redemptions.get(redemptionId);
    expect(updated.status).toBe(WeleticRedemptionStatus.issued);
    expect(updated.shopifyStoreCreditTransactionId).toBe(expectedTxId);
    expect(updated.issuanceConfirmedAt).toBeDefined();

    // Points deduction remains finalized (balance still 2000, not refunded)
    const account = mockState.accounts.get("acc_1");
    expect(account.cachedPointsBalance).toBe(BigInt(2000));
    expect(mockState.compensations).toHaveLength(0);

    // Metafield sync enqueued
    expect(mockState.outboxJobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          jobType: "METAFIELD_SYNC",
          payload: expect.objectContaining({
            accountId: "acc_1",
            triggerReason: "financial_reward_redemption_issued",
          }),
        }),
      ]),
    );

    // Flow trigger enqueued
    expect(mockState.flowTriggers).toHaveLength(1);
    expect(mockState.flowTriggers[0]).toMatchObject({
      payload: expect.objectContaining({
        handle: "weletic-reward-redeemed",
        rewardType: "store_credit",
      }),
    });
  });

  // --------------------------------------------------------------------------
  // Test Case 2: No transaction found on Shopify after horizon
  // --------------------------------------------------------------------------
  it("Test Case 2: No transaction found on Shopify after horizon -> redemption transitions to 'failed', points refunded to customer ledger, balance restored", async () => {
    // Attempted 10 minutes ago; horizon is 5 minutes
    const { redemptionId } = createTestFixture({
      createdAt: new Date("2026-10-05T10:00:00.000Z"),
      remoteAttemptedAt: "2026-10-05T10:00:05.000Z",
      initialBalance: BigInt(2000), // 500 pts spent
    });

    const now = new Date("2026-10-05T10:10:00.000Z"); // 10 minutes later

    const customFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        data: {
          customer: {
            id: customerGid,
            storeCreditAccounts: {
              edges: [],
            },
          },
        },
      }),
    })) as any;

    const result = await reconcilePendingStoreCreditRedemption({
      storeId,
      redemptionId,
      now,
      customFetch,
    });

    expect(result).toEqual({ outcome: "refunded_and_failed" });

    // Status transitioned to failed
    const updated = mockState.redemptions.get(redemptionId);
    expect(updated.status).toBe(WeleticRedemptionStatus.failed);
    expect(updated.shopifyStoreCreditTransactionId).toBeNull();

    // Points refunded: 2000 + 500 = 2500
    const account = mockState.accounts.get("acc_1");
    expect(account.cachedPointsBalance).toBe(BigInt(2500));

    // Compensation recorded
    expect(mockState.compensations).toHaveLength(1);
    expect(mockState.compensations[0]).toMatchObject({
      redemptionId,
      targetStatus: WeleticRedemptionStatus.failed,
      reason: expect.stringContaining("timed out"),
    });
  });

  // --------------------------------------------------------------------------
  // Test Case 3: No transaction found on Shopify within active horizon
  // --------------------------------------------------------------------------
  it("Test Case 3: No transaction found on Shopify within active horizon -> redemption remains in 'provisioning', no points refunded yet", async () => {
    // Attempted only 45 seconds ago (well within 5 minute horizon)
    const { redemptionId } = createTestFixture({
      createdAt: new Date("2026-10-05T10:00:00.000Z"),
      remoteAttemptedAt: "2026-10-05T10:00:05.000Z",
      initialBalance: BigInt(2000),
    });

    const now = new Date("2026-10-05T10:00:50.000Z"); // 45s later

    const customFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        data: {
          customer: {
            id: customerGid,
            storeCreditAccounts: {
              edges: [],
            },
          },
        },
      }),
    })) as any;

    const result = await reconcilePendingStoreCreditRedemption({
      storeId,
      redemptionId,
      now,
      customFetch,
    });

    expect(result).toEqual({ outcome: "deferred" });

    // Redemption remains in provisioning
    const current = mockState.redemptions.get(redemptionId);
    expect(current.status).toBe(WeleticRedemptionStatus.provisioning);
    expect(current.shopifyStoreCreditTransactionId).toBeNull();

    // No compensation / points refund yet
    const account = mockState.accounts.get("acc_1");
    expect(account.cachedPointsBalance).toBe(BigInt(2000));
    expect(mockState.compensations).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Test Case 4: Ambiguous network error during initial issuance recovered
  // --------------------------------------------------------------------------
  it("Test Case 4: Ambiguous network error during initial issuance leaves redemption in 'provisioning', subsequently recovered by poller", async () => {
    // 1. Initial redemption was dispatched and network dropped:
    const { redemptionId } = createTestFixture({
      createdAt: new Date("2026-10-05T09:59:00.000Z"),
      remoteAttemptedAt: "2026-10-05T09:59:05.000Z",
      initialBalance: BigInt(2000),
    });

    // 2. Outbox recovery worker executes handleRedemptionRecovery
    const { handleRedemptionRecovery } = await import(
      "@/lib/weletic/loyalty/outbox-worker"
    );

    // Mock Shopify showing that the credit mutation actually completed on Shopify:
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
                    balance: { amount: "5.00", currencyCode: "USD" },
                    transactions: {
                      edges: [
                        {
                          node: {
                            id: "gid://shopify/StoreCreditAccountCreditTransaction/network_drop_recovered_77",
                            amount: { amount: "5.00", currencyCode: "USD" },
                            createdAt: "2026-10-05T09:59:06.000Z",
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

    // We pass customFetch via the offline credentials resolver or mock
    const { resolveShopifyOfflineCredentials } = await import(
      "@/lib/weletic/loyalty/shopify-discounts"
    );
    vi.mocked(resolveShopifyOfflineCredentials).mockResolvedValueOnce({
      shopDomain: "acme.myshopify.com",
      accessToken: "shpat_recovery",
      scope:
        "read_store_credit_accounts,write_store_credit_account_transactions",
      source: "app_session",
    });

    // Spy on auditShopifyCustomerStoreCreditTransactions to inject our customFetch
    const shopifyRewards = await import(
      "@/lib/weletic/loyalty/shopify-financial-rewards"
    );
    const auditSpy = vi
      .spyOn(shopifyRewards, "auditShopifyCustomerStoreCreditTransactions")
      .mockImplementationOnce(async ({ credentials, customerId }) => {
        return [
          {
            id: "gid://shopify/StoreCreditAccountCreditTransaction/network_drop_recovered_77",
            accountId: "gid://shopify/StoreCreditAccount/acc_01",
            amount: "5.00",
            currencyCode: "USD",
            createdAt: new Date("2026-10-05T09:59:06.000Z"),
            expiresAt: null,
          },
        ];
      });

    const recoveryOutcome = await handleRedemptionRecovery(
      storeId,
      {
        redemptionId,
        accountId: "acc_1",
        rewardDefinitionId: "rew_sc_5",
        shopifyDiscountCode: "WLSC12345678",
        pointsCost: "500",
        attemptCount: 1,
        sagaPhase: "provisioning",
        artifactKind: WeleticRewardArtifactKind.store_credit,
      },
      null,
      new Date("2026-10-05T10:02:00.000Z"),
    );

    expect(recoveryOutcome).toBe("confirmed");
    expect(auditSpy).toHaveBeenCalledTimes(1);
    auditSpy.mockRestore();

    const updated = mockState.redemptions.get(redemptionId);
    expect(updated.status).toBe(WeleticRedemptionStatus.issued);
    expect(updated.shopifyStoreCreditTransactionId).toBe(
      "gid://shopify/StoreCreditAccountCreditTransaction/network_drop_recovered_77",
    );
    expect(mockState.accounts.get("acc_1").cachedPointsBalance).toBe(
      BigInt(2000),
    );
  });

  // --------------------------------------------------------------------------
  // Test Case 5: Zero-hardcoding and canonical store resolution adherence
  // --------------------------------------------------------------------------
  it("Test Case 5: Zero-hardcoding and canonical store resolution adherence", async () => {
    const { resolveShopifyOfflineCredentials } = await import(
      "@/lib/weletic/loyalty/shopify-discounts"
    );

    const storeAlpha = "tenant_alpha_store_88";
    const storeBeta = "tenant_beta_store_99";

    // Setup redemptions across two separate tenants
    createTestFixture({
      redemptionId: "redemp_alpha",
      targetStoreId: storeAlpha,
    });
    createTestFixture({
      redemptionId: "redemp_beta",
      targetStoreId: storeBeta,
    });

    const customFetchAlpha = vi.fn(async () => ({
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
                    id: "gid://shopify/StoreCreditAccount/alpha_acc",
                    balance: { amount: "5.00", currencyCode: "USD" },
                    transactions: {
                      edges: [
                        {
                          node: {
                            id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_alpha_1",
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

    const resAlpha = await reconcilePendingStoreCreditRedemption({
      storeId: storeAlpha,
      redemptionId: "redemp_alpha",
      customFetch: customFetchAlpha,
    });

    expect(resAlpha).toEqual({
      outcome: "confirmed",
      transactionId:
        "gid://shopify/StoreCreditAccountCreditTransaction/tx_alpha_1",
    });

    // Verify resolveShopifyOfflineCredentials was invoked dynamically with the exact storeId
    expect(resolveShopifyOfflineCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: storeAlpha,
      }),
    );
  });

  // --------------------------------------------------------------------------
  // Test Case 6: Sweeper Batch Reconciles Multiple Redemptions
  // --------------------------------------------------------------------------
  it("Sweeper Batch Reconciles Multiple Redemptions in Single Sweep", async () => {
    // Redemption 1: Confirmed on Shopify
    createTestFixture({
      redemptionId: "sweep_1",
      createdAt: new Date("2026-10-05T09:00:00.000Z"),
      remoteAttemptedAt: "2026-10-05T09:00:05.000Z",
    });

    // Redemption 2: Timed out on Shopify
    createTestFixture({
      redemptionId: "sweep_2",
      createdAt: new Date("2026-10-05T08:00:00.000Z"),
      remoteAttemptedAt: "2026-10-05T08:00:05.000Z",
    });

    // Custom fetch responds conditionally based on redemption context
    const customFetch = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      // For sweep_1 return matching tx, for sweep_2 return empty
      return {
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
                      balance: { amount: "5.00", currencyCode: "USD" },
                      transactions: {
                        edges: [
                          {
                            node: {
                              id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_sweep_1",
                              amount: { amount: "5.00", currencyCode: "USD" },
                              createdAt: "2026-10-05T09:00:06.000Z",
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
      now: new Date("2026-10-05T09:10:00.000Z"),
      customFetch: customFetch as any,
    });

    expect(sweepResult.scanned).toBe(2);
    // sweep_1 matches tx_sweep_1 (createdAt 09:00:06 is within proximity of 09:00:05 attempt) -> confirmed
    // sweep_2 attempt at 08:00:05 is outside the 09:00:06 tx proximity, and its horizon has expired (1 hour ago) -> refunded_and_failed
    expect(sweepResult.confirmed).toBe(1);
    expect(sweepResult.refunded).toBe(1);
    expect(sweepResult.errors).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test Case 7: Cron Route Handler Verification
  // --------------------------------------------------------------------------
  it("Test Case 7: Cron Route Handler verifies GET and POST endpoints call sweep", async () => {
    const { GET, POST } = await import(
      "../../app/(ee)/api/cron/weletic/reconcile/store-credit/route"
    );
    expect(GET).toBeDefined();
    expect(POST).toBe(GET);

    const req = new Request(
      "https://app.weletic.com/api/cron/weletic/reconcile/store-credit",
      {
        method: "GET",
      },
    );
    const res = await GET(req as any, { params: Promise.resolve({}) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      scanned: expect.any(Number),
      confirmed: expect.any(Number),
      refunded: expect.any(Number),
      deferred: expect.any(Number),
      errors: expect.any(Number),
    });
  });
});
