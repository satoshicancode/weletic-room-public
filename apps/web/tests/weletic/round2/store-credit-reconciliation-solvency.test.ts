import {
  createLoyaltyRedemptionProvisioningSnapshot,
  getShopifyCustomerSelectionDigest,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import { reconcilePendingStoreCreditRedemption } from "@/lib/weletic/loyalty/store-credit-reconciliation";
import {
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

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
        const acc = mockState.accounts.get(row.accountId);
        if (acc) {
          acc.cachedPointsBalance += row.pointsSpent;
        }
      }
    },
  ),
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", () => ({
  resolveShopifyOfflineCredentials: vi.fn(
    async ({ storeId }: { storeId: string }) => ({
      shopDomain: `${storeId}.myshopify.com`,
      accessToken: `shpat_${storeId}_offline_token`,
      scope:
        "read_gift_cards,write_gift_cards,write_customers,read_store_credit_accounts,write_store_credit_account_transactions",
      source: "app_session",
    }),
  ),
  formatShopifyGid: (resource: string, id: string | number) =>
    String(id).startsWith("gid://shopify/")
      ? String(id)
      : `gid://shopify/${resource}/${id}`,
  parseShopifyGid: (gid: string) => {
    const parts = gid.split("/");
    return parts[parts.length - 1];
  },
  shopifyAdminGraphqlRequest: vi.fn(async (params: any) => {
    const fetchFn = params.customFetch || fetch;
    const res = await fetchFn(
      `https://${params.shopDomain}/admin/api/2025-01/graphql.json`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-shopify-access-token": params.accessToken,
        },
        body: JSON.stringify({
          query: params.query,
          variables: params.variables,
        }),
      },
    );
    const json = await res.json();
    return json.data;
  }),
}));

describe("Round 2 Store Credit Reconciliation & Solvency Test Suite", () => {
  const storeId = "store_credit_test_store";
  const customerId = "1234567890";
  const customerGid = `gid://shopify/Customer/${customerId}`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.redemptions.clear();
    mockState.accounts.clear();
    mockState.outboxJobs = [];
    mockState.flowTriggers = [];
    mockState.compensations = [];
  });

  function seedFixture({
    redemptionId = "redemp_r2_1",
    targetStoreId = storeId,
    amountMinor = "1000",
    pointsSpent = BigInt(100),
    currency = "USD",
    createdAt = new Date("2026-10-09T10:00:00.000Z"),
    remoteAttemptedAt = "2026-10-09T10:00:05.000Z",
    initialStatus = WeleticRedemptionStatus.provisioning,
    accountId = "account_r2_1",
    idempotencyToken = "idemp_tok_12345",
  }: {
    redemptionId?: string;
    targetStoreId?: string;
    amountMinor?: string;
    pointsSpent?: bigint;
    currency?: string;
    createdAt?: Date;
    remoteAttemptedAt?: string;
    initialStatus?: WeleticRedemptionStatus | string;
    accountId?: string;
    idempotencyToken?: string;
  } = {}) {
    const shopper = {
      id: `shopper_${customerId}`,
      storeId: targetStoreId,
      shopifyCustomerId: customerId,
      shopifyCustomerGid: customerGid,
    };

    const account = {
      id: accountId,
      storeId: targetStoreId,
      shopperId: shopper.id,
      cachedPointsBalance: BigInt(500),
      shopper,
    };
    mockState.accounts.set(accountId, account);

    const selectionDigest = getShopifyCustomerSelectionDigest({
      storeId: targetStoreId,
      shopifyCustomerId: customerId,
    });

    const snapshot = createLoyaltyRedemptionProvisioningSnapshot({
      reward: {
        id: "reward_sc_1",
        name: "$10 Store Credit",
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
      customerSelectionDigest: selectionDigest,
      startsAt: new Date("2026-10-01T00:00:00.000Z"),
      expiresAt: null,
    });

    const redemption = {
      id: redemptionId,
      storeId: targetStoreId,
      accountId,
      shopperId: shopper.id,
      status: initialStatus,
      artifactKind: WeleticRewardArtifactKind.store_credit,
      pointsSpent,
      createdAt,
      metadata: {
        provisioningSnapshot: snapshot,
        remoteProvisionAttemptedAt: remoteAttemptedAt,
        idempotencyKey: idempotencyToken,
        correlationNote: `Weletic Loyalty Reward ${redemptionId} (${idempotencyToken})`,
      },
      shopper,
      account,
    };
    mockState.redemptions.set(redemptionId, redemption);

    return { redemption, account, shopper };
  }

  describe("Feature 10: Remote Outcome Reconciliation & Note Matching Against Concurrent Manual Credits", () => {
    it("confirms redemption when matching Shopify transaction is found in customer ledger", async () => {
      const { redemption } = seedFixture({
        amountMinor: "1000", // $10.00 USD
        currency: "USD",
        createdAt: new Date("2026-10-09T10:00:00.000Z"),
      });

      const now = new Date("2026-10-09T10:02:00.000Z");

      // Mock Shopify GraphQL response returning the issued transaction
      const mockCustomFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: {
              customer: {
                storeCreditAccounts: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/StoreCreditAccount/1",
                        balance: { amount: "50.00", currencyCode: "USD" },
                        transactions: {
                          edges: [
                            {
                              node: {
                                id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_100",
                                amount: {
                                  amount: "10.00",
                                  currencyCode: "USD",
                                },
                                createdAt: "2026-10-09T10:00:06.000Z",
                                test: false,
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
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId: redemption.id,
        now,
        customFetch: mockCustomFetch,
      });

      expect(result.outcome).toBe("confirmed");
      if (result.outcome === "confirmed") {
        expect(result.transactionId).toBe(
          "gid://shopify/StoreCreditAccountCreditTransaction/tx_100",
        );
      }

      // Check redemption updated to issued
      const updated = mockState.redemptions.get(redemption.id);
      expect(updated.status).toBe(WeleticRedemptionStatus.issued);
      expect(updated.shopifyStoreCreditTransactionId).toBe(
        "gid://shopify/StoreCreditAccountCreditTransaction/tx_100",
      );
      expect(updated.issuanceConfirmedAt).toEqual(now);

      // Verify Flow trigger job dispatched
      expect(mockState.flowTriggers).toContainEqual(
        expect.objectContaining({
          storeId,
          eventId: redemption.id,
          payload: expect.objectContaining({
            accountId: redemption.accountId,
            handle: "weletic-reward-redeemed",
          }),
        }),
      );
    });

    it("prevents transaction stealing when transaction ID is already bound to another redemption (collision check)", async () => {
      // 1. Existing redemption that already claimed tx_bound
      seedFixture({
        redemptionId: "redemp_already_bound",
        amountMinor: "1000",
        initialStatus: WeleticRedemptionStatus.issued,
      });
      const boundRow = mockState.redemptions.get("redemp_already_bound");
      boundRow.shopifyStoreCreditTransactionId =
        "gid://shopify/StoreCreditAccountCreditTransaction/tx_bound";

      // 2. Pending contender redemption
      const { redemption } = seedFixture({
        redemptionId: "redemp_contender",
        amountMinor: "1000",
      });

      const now = new Date("2026-10-09T10:02:00.000Z");

      // Shopify returns only the already bound transaction
      const mockCustomFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: {
              customer: {
                storeCreditAccounts: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/StoreCreditAccount/1",
                        balance: { amount: "50.00", currencyCode: "USD" },
                        transactions: {
                          edges: [
                            {
                              node: {
                                id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_bound",
                                amount: {
                                  amount: "10.00",
                                  currencyCode: "USD",
                                },
                                createdAt: "2026-10-09T10:00:06.000Z",
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
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId: redemption.id,
        now,
        customFetch: mockCustomFetch,
      });

      // Must NOT steal tx_bound; since within 5-min horizon, defers to future sweep
      expect(result.outcome).toBe("deferred");
      const contender = mockState.redemptions.get(redemption.id);
      expect(contender.status).toBe(WeleticRedemptionStatus.provisioning);
      expect(contender.shopifyStoreCreditTransactionId).toBeUndefined();
    });

    it("defers outcome when transaction is absent but reconciliation horizon is active (< 5 mins)", async () => {
      const createdAt = new Date("2026-10-09T10:00:00.000Z");
      const { redemption } = seedFixture({
        createdAt,
        remoteAttemptedAt: "2026-10-09T10:00:05.000Z",
      });

      // Evaluated only 2 minutes after attempt (< 5 minutes horizon)
      const now = new Date("2026-10-09T10:02:00.000Z");

      // Empty transactions on Shopify
      const mockCustomFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: {
              customer: {
                storeCreditAccounts: {
                  edges: [],
                },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId: redemption.id,
        now,
        customFetch: mockCustomFetch,
      });

      expect(result.outcome).toBe("deferred");
      expect(mockState.compensations).toHaveLength(0); // No refund yet
    });

    it("fails and triggers points refund saga when transaction is absent and horizon has expired (> 5 mins)", async () => {
      const createdAt = new Date("2026-10-09T10:00:00.000Z");
      const pointsSpent = BigInt(250);
      const { redemption } = seedFixture({
        createdAt,
        remoteAttemptedAt: "2026-10-09T10:00:05.000Z",
        pointsSpent,
      });

      // Evaluated 7 minutes after attempt (horizon 5 mins expired)
      const now = new Date("2026-10-09T10:07:05.000Z");

      const mockCustomFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: {
              customer: {
                storeCreditAccounts: { edges: [] },
              },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId: redemption.id,
        now,
        customFetch: mockCustomFetch,
      });

      expect(result.outcome).toBe("refunded_and_failed");

      // Check compensation saga was executed to refund points
      expect(mockState.compensations).toContainEqual(
        expect.objectContaining({
          redemptionId: redemption.id,
          reason:
            "Store credit remote outcome reconciliation timed out after 300s without matching Shopify transaction",
          targetStatus: WeleticRedemptionStatus.failed,
        }),
      );

      // Account points balance was restored
      const account = mockState.accounts.get(redemption.accountId);
      expect(account.cachedPointsBalance).toBe(BigInt(500) + pointsSpent);
    });
  });

  describe("Zero-Decimal Currency Minor Unit Scaling (JPY / VND)", () => {
    it("handles zero-decimal currencies (JPY) without decimal cent scaling", async () => {
      const amountJpyMinor = "5000"; // ¥5,000 JPY
      const { redemption } = seedFixture({
        amountMinor: amountJpyMinor,
        currency: "JPY",
        createdAt: new Date("2026-10-09T10:00:00.000Z"),
      });

      const now = new Date("2026-10-09T10:02:00.000Z");

      // Shopify returns amount: "5000" (or "5000.0") for JPY
      const mockCustomFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: {
              customer: {
                storeCreditAccounts: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/StoreCreditAccount/1",
                        balance: { amount: "10000", currencyCode: "JPY" },
                        transactions: {
                          edges: [
                            {
                              node: {
                                id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_jpy_1",
                                amount: { amount: "5000", currencyCode: "JPY" },
                                createdAt: "2026-10-09T10:00:10.000Z",
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
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId: redemption.id,
        now,
        customFetch: mockCustomFetch,
      });

      expect(result.outcome).toBe("confirmed");
      if (result.outcome === "confirmed") {
        expect(result.transactionId).toBe(
          "gid://shopify/StoreCreditAccountCreditTransaction/tx_jpy_1",
        );
      }
    });

    it("rejects transaction when currency code does not match expected store currency", async () => {
      const { redemption } = seedFixture({
        amountMinor: "5000",
        currency: "JPY",
      });

      const now = new Date("2026-10-09T10:02:00.000Z");

      // Transaction on Shopify is in USD instead of expected JPY
      const mockCustomFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: {
              customer: {
                storeCreditAccounts: {
                  edges: [
                    {
                      node: {
                        transactions: {
                          edges: [
                            {
                              node: {
                                id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_usd_wrong",
                                amount: {
                                  amount: "5000.00",
                                  currencyCode: "USD",
                                },
                                createdAt: "2026-10-09T10:00:10.000Z",
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
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId: redemption.id,
        now,
        customFetch: mockCustomFetch,
      });

      expect(result.outcome).toBe("deferred");
    });
  });

  describe("Feature 12: Concurrency & Idempotency", () => {
    it("guarantees idempotency when concurrent contender sweeps process the same redemption", async () => {
      const { redemption } = seedFixture();
      const now = new Date("2026-10-09T10:02:00.000Z");

      const mockCustomFetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: {
              customer: {
                storeCreditAccounts: {
                  edges: [
                    {
                      node: {
                        transactions: {
                          edges: [
                            {
                              node: {
                                id: "gid://shopify/StoreCreditAccountCreditTransaction/tx_concurrent",
                                amount: {
                                  amount: "10.00",
                                  currencyCode: "USD",
                                },
                                createdAt: "2026-10-09T10:00:10.000Z",
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
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch;

      // First contender runs and confirms
      const run1 = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId: redemption.id,
        now,
        customFetch: mockCustomFetch,
      });
      expect(run1.outcome).toBe("confirmed");

      // Second contender arrives concurrently after run1 transitioned status to issued
      const run2 = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId: redemption.id,
        now,
        customFetch: mockCustomFetch,
      });

      // Second contender must skip safely without error and without duplicate flow trigger jobs
      expect(run2.outcome).toBe("skipped");
      expect(run2).toMatchObject({
        outcome: "skipped",
        reason: "status_issued",
      });

      // Flow trigger must be enqueued exactly once
      expect(mockState.flowTriggers).toHaveLength(1);
    });
  });
});
