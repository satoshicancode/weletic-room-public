import { prisma } from "@/lib/prisma";
import { createLoyaltyDiscountProvisioningIdentity } from "@/lib/weletic/loyalty/redemption-discount-identity";
import {
  createLoyaltyRedemptionProvisioningSnapshot,
  getShopifyCustomerSelectionDigest,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import {
  provisionDiscountSaga,
  sweepStuckSagaRedemptions,
} from "@/lib/weletic/loyalty/saga";
import {
  Prisma,
  WeleticRedemptionStatus,
  WeleticRewardStatus,
  WeleticRewardType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stateful in-memory ledger and DB storage for adversarial stress testing
interface MockState {
  accounts: Map<string, any>;
  rewards: Map<string, any>;
  redemptions: Map<string, any>;
  ledgerEntries: any[];
  outboxJobs: any[];
  stores: Map<string, any>;
}

let mockState: MockState;

function resetMockState() {
  mockState = {
    accounts: new Map(),
    rewards: new Map(),
    redemptions: new Map(),
    ledgerEntries: [],
    outboxJobs: [],
    stores: new Map(),
  };
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyProgram: {
      findUnique: vi.fn(async ({ where }) => {
        const account = Array.from(mockState.accounts.values()).find(
          (value) => value.storeId === where.storeId,
        );
        return account
          ? {
              ...account.program,
              storeId: account.storeId,
              metadata: account.program.metadata ?? null,
            }
          : null;
      }),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(async ({ where }) => {
        return mockState.accounts.get(where.id) || null;
      }),
      findFirst: vi.fn(async ({ where }) => {
        const account = mockState.accounts.get(where.id);
        return account
          ? {
              ...account,
              metadata: account.metadata ?? null,
              store: { projectId: "proj_adv_123" },
            }
          : null;
      }),
      update: vi.fn(async ({ where, data }) => {
        const acc = mockState.accounts.get(where.id);
        if (!acc) throw new Error("Account not found");
        const updated = { ...acc, ...data };
        mockState.accounts.set(where.id, updated);
        return updated;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const acc = mockState.accounts.get(where.id);
        if (!acc) return { count: 0 };
        if (
          where.ledgerVersion !== undefined &&
          acc.ledgerVersion !== where.ledgerVersion
        ) {
          return { count: 0 };
        }
        const updated = { ...acc, ...data };
        mockState.accounts.set(where.id, updated);
        return { count: 1 };
      }),
    },
    weleticRewardDefinition: {
      findUnique: vi.fn(async ({ where }) => {
        return mockState.rewards.get(where.id) || null;
      }),
      findFirst: vi.fn(async () => null),
    },
    weleticRewardRedemption: {
      findUnique: vi.fn(async ({ where }) => {
        return mockState.redemptions.get(where.id) || null;
      }),
      findFirst: vi.fn(async ({ where }) => {
        const item = mockState.redemptions.get(where.id);
        if (
          !item ||
          (where.storeId && item.storeId !== where.storeId) ||
          (where.accountId && item.accountId !== where.accountId)
        )
          return null;
        return item;
      }),
      findMany: vi.fn(async ({ where }) => {
        const all = Array.from(mockState.redemptions.values());
        return all.filter((r) => {
          if (where?.status && r.status !== where.status) return false;
          if (where?.storeId && r.storeId !== where.storeId) return false;
          if (where?.createdAt?.lt && !(r.createdAt < where.createdAt.lt))
            return false;
          return true;
        });
      }),
      create: vi.fn(async ({ data }) => {
        const item = {
          artifactKind: "discount_code",
          fulfillmentSource: null,
          settlementQuarantinedAt: null,
          shopifyGiftCardId: null,
          shopifyStoreCreditTransactionId: null,
          ...data,
          createdAt: data.createdAt || new Date(),
        };
        mockState.redemptions.set(data.id, item);
        return item;
      }),
      update: vi.fn(async ({ where, data }) => {
        const item = mockState.redemptions.get(where.id);
        if (!item) throw new Error("Redemption not found");
        const updated = { ...item, ...data };
        mockState.redemptions.set(where.id, updated);
        return updated;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const item = mockState.redemptions.get(where.id);
        if (!item) return { count: 0 };
        if (where.storeId && item.storeId !== where.storeId)
          return { count: 0 };
        if (where.accountId && item.accountId !== where.accountId)
          return { count: 0 };
        if (
          where.metadata?.equals &&
          JSON.stringify(item.metadata) !==
            JSON.stringify(where.metadata.equals)
        )
          return { count: 0 };
        if (typeof where.status === "string" && item.status !== where.status) {
          return { count: 0 };
        }
        if (where.status?.in && !where.status.in.includes(item.status)) {
          return { count: 0 };
        }
        mockState.redemptions.set(where.id, { ...item, ...data });
        return { count: 1 };
      }),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(async ({ where }) => {
        if (where.storeId_idempotencyKey) {
          const { storeId, idempotencyKey } = where.storeId_idempotencyKey;
          return (
            mockState.ledgerEntries.find(
              (e) =>
                e.storeId === storeId && e.idempotencyKey === idempotencyKey,
            ) || null
          );
        }
        return null;
      }),
      findFirst: vi.fn(async ({ where, orderBy }) => {
        let matches = mockState.ledgerEntries.filter(
          (e) =>
            e.accountId === where.accountId &&
            (!where.storeId || e.storeId === where.storeId) &&
            (!where.id || e.id === where.id),
        );
        if (orderBy?.sequenceNumber === "desc") {
          matches.sort((a, b) => b.sequenceNumber - a.sequenceNumber);
        }
        return matches[0] || null;
      }),
      findMany: vi.fn(async ({ where, orderBy }) => {
        let matches = mockState.ledgerEntries.filter(
          (e) => e.accountId === where.accountId,
        );
        if (orderBy?.sequenceNumber === "asc") {
          matches.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
        }
        return matches;
      }),
      create: vi.fn(async ({ data }) => {
        const existing = mockState.ledgerEntries.find(
          (e) =>
            e.storeId === data.storeId &&
            e.idempotencyKey === data.idempotencyKey,
        );
        if (existing) {
          // Simulate MySQL Unique Key Violation P2002
          const p2002Err = new (Prisma as any).PrismaClientKnownRequestError(
            "Unique constraint failed on the fields: (`storeId`,`idempotencyKey`)",
            { code: "P2002", clientVersion: "5.0.0" },
          );
          throw p2002Err;
        }
        const entry = {
          ...data,
          id: data.id || `wledger_${Date.now()}_${Math.random()}`,
          createdAt: new Date(),
        };
        mockState.ledgerEntries.push(entry);
        return entry;
      }),
    },
    weleticLoyaltyOutboxJob: {
      create: vi.fn(async ({ data }) => {
        const job = { ...data, id: `wjob_${Date.now()}` };
        mockState.outboxJobs.push(job);
        return job;
      }),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
    weleticShopifyStore: {
      findFirst: vi.fn(async () => ({
        id: "store_adversarial",
        storeAccessState: "active",
        shopDomain: "yamaxdev.myshopify.com",
        projectId: "proj_adv_123",
        complianceState: "active",
        installationGeneration: "igen_adv_1",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
      })),
      findUnique: vi.fn(async () => ({
        id: "store_adversarial",
        storeAccessState: "active",
        shopDomain: "yamaxdev.myshopify.com",
        projectId: "proj_adv_123",
        complianceState: "active",
        installationGeneration: "igen_adv_1",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
      })),
    },
    project: {
      findUnique: vi.fn(async () => ({
        shopifyStoreId: "yamaxdev.myshopify.com",
      })),
      findFirst: vi.fn(async () => ({
        shopifyStoreId: "yamaxdev.myshopify.com",
      })),
    },
    weleticShopifyAppSession: {
      findFirst: vi.fn(async () => null),
    },
    installedIntegration: {
      findFirst: vi.fn(async () => null),
    },
    $queryRaw: vi.fn(async (statement: any) => {
      const sql = statement?.strings?.join(" ") || "";
      if (sql.includes("FROM WeleticShopifyStore")) {
        return [
          {
            id: "store_adversarial",
            storeAccessState: "active",
            complianceState: "active",
            installationGeneration: "igen_adv_1",
            shopCurrency: "USD",
            currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
          },
        ];
      }
      if (sql.includes("FROM WeleticLoyaltyProgram")) {
        const account = Array.from(mockState.accounts.values())[0];
        return account
          ? [{ ...account.program, storeId: account.storeId }]
          : [];
      }
      throw new Error(`Unexpected raw-query fixture: ${sql}`);
    }),
    $transaction: vi.fn(async (cb) => {
      if (typeof cb === "function") {
        return await cb(prisma);
      }
      return cb;
    }),
  },
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => {
  const enqueueOutboxJob = vi.fn().mockImplementation(async (params) => {
    const job = {
      id: `woutbox_mock_${Date.now()}_${Math.random()}`,
      ...params,
    };
    mockState.outboxJobs.push(job);
    return job;
  });
  return {
    enqueueOutboxJob,
    enqueueOutboxJobFromProgramTransaction: enqueueOutboxJob,
  };
});

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

describe("Adversarial Stress Verification: 4-Phase Distributed Discount Saga (Milestone 4)", () => {
  const storeId = "store_adversarial";
  const accountId = "acc_victim_1";
  const rewardDefId = "reward_50_off";

  beforeEach(() => {
    resetMockState();
    vi.clearAllMocks();
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat_adversarial_token";

    // Setup victim account with 1,000 points
    mockState.accounts.set(accountId, {
      id: accountId,
      storeId,
      cachedPointsBalance: BigInt(1000),
      cachedPendingPoints: BigInt(0),
      lifetimePointsEarned: BigInt(1000),
      lifetimePointsRedeemed: BigInt(0),
      ledgerVersion: 1,
      status: "active",
      program: {
        id: "prog_adv",
        status: "active",
        killSwitchActive: false,
      },
      shopper: {
        shopifyCustomerId: "gid://shopify/Customer/999888",
      },
    });

    // Setup active $50 Off reward costing 500 points
    mockState.rewards.set(rewardDefId, {
      id: rewardDefId,
      storeId,
      name: "$50 Off Exclusive Voucher",
      rewardType: WeleticRewardType.amount_off,
      pointsCost: BigInt(500),
      discountValue: 5000,
      status: WeleticRewardStatus.active,
      expiresInDays: 14,
      combinesWithOrderDiscounts: true,
      combinesWithProductDiscounts: true,
      combinesWithShippingDiscounts: false,
      usageLimit: 1,
      usageLimitPerCustomer: 1,
    });
  });

  // ==========================================================================
  // SECTION 1: Network Timeouts & Connection Drops mid-Shopify Creation
  // ==========================================================================
  describe("Section 1: Mid-Creation Network Drops, Timeouts & Abort Failures", () => {
    it("1.1: Keeps the debit reserved after an ambiguous timeout until recovery proves the remote outcome", async () => {
      let callCount = 0;
      const failingFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        throw new Error(
          "ETIMEDOUT: Connection timed out reaching https://yamaxdev.myshopify.com",
        );
      });

      const sagaResult = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId: rewardDefId,
        discountCode: "WL-TIMEOUT01",
        idempotencyKey: "adversarial-timeout-1",
        customFetch: failingFetch as any,
      });

      // The request may have committed remotely, so the debit remains held.
      expect(sagaResult.success).toBe(false);
      expect(sagaResult.compensated).toBe(false);
      expect(sagaResult.status).toBe(WeleticRedemptionStatus.provisioning);
      expect(sagaResult.error).toMatch(/Network error|ETIMEDOUT/i);

      // 2. Fetch attempted retries with backoff
      expect(callCount).toBeGreaterThanOrEqual(1);

      const redemption = mockState.redemptions.get(sagaResult.redemptionId);
      expect(redemption).toBeDefined();
      expect(redemption.status).toBe(WeleticRedemptionStatus.provisioning);
      expect(redemption.metadata.remoteProvisionAttemptedAt).toEqual(
        expect.any(String),
      );
      expect(redemption.metadata.remoteProvisionReconcileUntil).toEqual(
        expect.any(String),
      );

      const debitEntry = mockState.ledgerEntries.find(
        (e) =>
          e.referenceType === "REWARD_REDEMPTION" &&
          e.pointsDelta === -BigInt(500),
      );
      const refundEntry = mockState.ledgerEntries.find(
        (e) =>
          e.referenceType === "REDEMPTION_REFUND" &&
          e.pointsDelta === BigInt(500),
      );

      expect(debitEntry).toBeDefined();
      expect(refundEntry).toBeUndefined();

      // No double value while Shopify visibility is still ambiguous.
      const account = mockState.accounts.get(accountId);
      expect(account.cachedPointsBalance).toBe(BigInt(500));
    });

    it("1.2: Transient network drop on attempt 1 that succeeds on attempt 2 -> completes saga to 'issued' without triggering compensation", async () => {
      let attempts = 0;
      const transientFetch = vi.fn().mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("ECONNRESET: Connection reset by peer");
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              discountCodeBasicCreate: {
                codeDiscountNode: {
                  id: "gid://shopify/DiscountCodeNode/transient_success_1",
                  codeDiscount: {
                    title: "$50 Off (WL-TRANSIENT01)",
                    status: "ACTIVE",
                    codes: {
                      nodes: [{ id: "c_trans", code: "WL-TRANSIENT01" }],
                    },
                  },
                },
                userErrors: [],
              },
            },
          }),
        };
      });

      const sagaResult = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId: rewardDefId,
        discountCode: "WL-TRANSIENT01",
        idempotencyKey: "adversarial-transient-1",
        customFetch: transientFetch as any,
      });

      expect(sagaResult.success, sagaResult.error).toBe(true);
      expect(sagaResult.status).toBe(WeleticRedemptionStatus.issued);
      expect(sagaResult.shopifyDiscountId).toBe(
        "gid://shopify/DiscountCodeNode/transient_success_1",
      );
      expect(attempts).toBe(2);

      // Verify no REDEMPTION_REFUND ledger entry was created
      const refundEntry = mockState.ledgerEntries.find(
        (e) => e.referenceType === "REDEMPTION_REFUND",
      );
      expect(refundEntry).toBeUndefined();

      // Verify final balance is exactly 500 (1000 - 500)
      const account = mockState.accounts.get(accountId);
      expect(account.cachedPointsBalance).toBe(BigInt(500));
    });
  });

  // ==========================================================================
  // SECTION 2: Code Collision & Nanoid Regeneration Resilience
  // ==========================================================================
  describe("Section 2: Duplicate Code Collisions & Nanoid Regeneration", () => {
    it("2.1: Regenerates only after a TAKEN code is proven to belong to a foreign discount", async () => {
      let callCount = 0;
      let requestedCodes: string[] = [];

      const collisionFetch = vi
        .fn()
        .mockImplementation(async (url, options) => {
          callCount++;
          const body = JSON.parse(options.body);

          if (body.query.includes("discountCodeBasicCreate")) {
            const code = body.variables.basicCodeDiscount.code;
            requestedCodes.push(code);

            if (code === "WL-COLLIDE01") {
              // First attempt collides!
              return {
                ok: true,
                json: async () => ({
                  data: {
                    discountCodeBasicCreate: {
                      codeDiscountNode: null,
                      userErrors: [
                        {
                          field: ["basicCodeDiscount", "code"],
                          message:
                            "The discount code WL-COLLIDE01 is already taken.",
                          code: "TAKEN",
                        },
                      ],
                    },
                  },
                }),
              };
            } else {
              // Second regenerated nanoid code succeeds!
              return {
                ok: true,
                json: async () => ({
                  data: {
                    discountCodeBasicCreate: {
                      codeDiscountNode: {
                        id: "gid://shopify/DiscountCodeNode/collision_resolved_99",
                        codeDiscount: {
                          title: `$50 Off (${code})`,
                          status: "ACTIVE",
                          codes: { nodes: [{ id: "c_regen", code }] },
                        },
                      },
                      userErrors: [],
                    },
                  },
                }),
              };
            }
          }

          if (body.query.includes("codeDiscountNodeByCode")) {
            // A visible title mismatch proves this code belongs to a merchant
            // discount, so generating a new Weletic code is safe.
            return {
              ok: true,
              json: async () => ({
                data: {
                  codeDiscountNodeByCode: {
                    id: "gid://shopify/DiscountCodeNode/foreign",
                    codeDiscount: {
                      title: "Merchant promotion",
                      status: "ACTIVE",
                      codes: {
                        nodes: [{ id: "foreign-code", code: "WL-COLLIDE01" }],
                      },
                    },
                  },
                },
              }),
            };
          }

          return { ok: false, status: 500 };
        });

      const sagaResult = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId: rewardDefId,
        discountCode: "WL-COLLIDE01",
        idempotencyKey: "adversarial-collision-1",
        customFetch: collisionFetch as any,
      });

      expect(sagaResult.success).toBe(true);
      expect(sagaResult.status).toBe(WeleticRedemptionStatus.issued);
      expect(sagaResult.discountCode).not.toBe("WL-COLLIDE01");
      expect(sagaResult.discountCode.startsWith("WL-")).toBe(true);
      expect(sagaResult.shopifyDiscountId).toBe(
        "gid://shopify/DiscountCodeNode/collision_resolved_99",
      );

      // Verify DB redemption was updated with the regenerated code
      const redemption = mockState.redemptions.get(sagaResult.redemptionId);
      expect(redemption.shopifyDiscountCode).toBe(sagaResult.discountCode);
      expect(redemption.status).toBe(WeleticRedemptionStatus.issued);
    });

    it("2.2: Code collision where code ALREADY exists as ours (idempotent saga replay) -> locates existing GID and finalizes to 'issued'", async () => {
      let attemptedTitle = "";
      let attemptedInput: Record<string, any> = {};
      const replayFetch = vi.fn().mockImplementation(async (url, options) => {
        const body = JSON.parse(options.body);

        if (body.query.includes("discountCodeBasicCreate")) {
          attemptedInput = body.variables.basicCodeDiscount;
          attemptedTitle = body.variables.basicCodeDiscount.title;
          return {
            ok: true,
            json: async () => ({
              data: {
                discountCodeBasicCreate: {
                  codeDiscountNode: null,
                  userErrors: [
                    {
                      field: ["code"],
                      message: "Code already exists",
                      code: "DUPLICATE",
                    },
                  ],
                },
              },
            }),
          };
        }

        if (body.query.includes("codeDiscountNodeByCode")) {
          return {
            ok: true,
            json: async () => ({
              data: {
                codeDiscountNodeByCode: {
                  id: "gid://shopify/DiscountCodeNode/replay_existing_gid",
                  codeDiscount: {
                    __typename: "DiscountCodeBasic",
                    title: attemptedTitle,
                    status: "ACTIVE",
                    startsAt: new Date(
                      Math.trunc(
                        new Date(attemptedInput.startsAt).getTime() / 1_000,
                      ) * 1_000,
                    ).toISOString(),
                    endsAt: attemptedInput.endsAt
                      ? new Date(
                          Math.trunc(
                            new Date(attemptedInput.endsAt).getTime() / 1_000,
                          ) * 1_000,
                        ).toISOString()
                      : null,
                    usageLimit: 1,
                    appliesOncePerCustomer: true,
                    recurringCycleLimit: 1,
                    combinesWith: {
                      orderDiscounts: true,
                      productDiscounts: true,
                      shippingDiscounts: false,
                    },
                    customerSelection: {
                      __typename: "DiscountCustomers",
                      customers: [{ id: "gid://shopify/Customer/999888" }],
                    },
                    minimumRequirement: null,
                    customerGets: {
                      appliesOnOneTimePurchase:
                        attemptedInput.customerGets.appliesOnOneTimePurchase ??
                        true,
                      appliesOnSubscription:
                        attemptedInput.customerGets.appliesOnSubscription ??
                        false,
                      value: {
                        __typename: "DiscountAmount",
                        amount: { amount: "50.00", currencyCode: "USD" },
                        appliesOnEachItem: false,
                      },
                      items: {
                        __typename: "AllDiscountItems",
                        allItems: true,
                      },
                    },
                    codes: { nodes: [{ id: "c_replay", code: "WL-REPLAY01" }] },
                  },
                },
              },
            }),
          };
        }

        return { ok: false, status: 500 };
      });

      const sagaResult = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId: rewardDefId,
        discountCode: "WL-REPLAY01",
        idempotencyKey: "adversarial-replay-1",
        customFetch: replayFetch as any,
      });

      expect(sagaResult.success).toBe(true);
      expect(sagaResult.status).toBe(WeleticRedemptionStatus.issued);
      expect(sagaResult.shopifyDiscountId).toBe(
        "gid://shopify/DiscountCodeNode/replay_existing_gid",
      );
    });
  });

  // ==========================================================================
  // SECTION 3: Shopify 429 Rate Throttling & GraphQL Cost Budget Exhaustion
  // ==========================================================================
  describe("Section 3: Shopify 429 Throttling & Cost Budget Exhaustion", () => {
    it("3.1: Handles HTTP 429 with Retry-After header -> backs off and succeeds on retry", async () => {
      let callCount = 0;
      const throttledFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
            headers: new Headers({ "Retry-After": "0.05" }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            data: {
              discountCodeBasicCreate: {
                codeDiscountNode: {
                  id: "gid://shopify/DiscountCodeNode/throttled_then_ok",
                  codeDiscount: {
                    title: "$50 Off",
                    status: "ACTIVE",
                    codes: { nodes: [{ id: "c1", code: "WL-THROTTLE01" }] },
                  },
                },
                userErrors: [],
              },
            },
          }),
        };
      });

      const sagaResult = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId: rewardDefId,
        discountCode: "WL-THROTTLE01",
        idempotencyKey: "adversarial-throttle-1",
        customFetch: throttledFetch as any,
      });

      expect(sagaResult.success).toBe(true);
      expect(callCount).toBe(2);
      expect(sagaResult.shopifyDiscountId).toBe(
        "gid://shopify/DiscountCodeNode/throttled_then_ok",
      );
    });

    it("3.2: Persistent HTTP 429 exceeding maxRetries -> fails with THROTTLED error -> triggers compensating refund", async () => {
      let callCount = 0;
      const persistent429Fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: new Headers({ "Retry-After": "0.01" }),
        };
      });

      const sagaResult = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId: rewardDefId,
        discountCode: "WL-MAX429",
        idempotencyKey: "adversarial-persistent-429-1",
        customFetch: persistent429Fetch as any,
      });

      expect(sagaResult.success).toBe(false);
      expect(sagaResult.compensated).toBe(true);
      expect(sagaResult.error).toMatch(/rate limit|THROTTLED|HTTP 429/i);
      expect(callCount).toBe(4); // 1 initial + 3 retries

      // Verify points were refunded
      const account = mockState.accounts.get(accountId);
      expect(account.cachedPointsBalance).toBe(BigInt(1000));
    });

    it("3.3: GraphQL Cost Budget Throttling (extensions.cost.throttleStatus) -> waits restore rate -> succeeds on retry", async () => {
      let callCount = 0;
      const costThrottledFetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: true,
            json: async () => ({
              extensions: {
                cost: {
                  requestedQueryCost: 100,
                  actualQueryCost: 100,
                  throttleStatus: {
                    maximumAvailable: 1000,
                    currentlyAvailable: -10, // Negative budget!
                    restoreRate: 500,
                  },
                },
              },
              data: null,
            }),
          };
        }

        return {
          ok: true,
          json: async () => ({
            extensions: {
              cost: {
                throttleStatus: {
                  maximumAvailable: 1000,
                  currentlyAvailable: 800,
                  restoreRate: 50,
                },
              },
            },
            data: {
              discountCodeBasicCreate: {
                codeDiscountNode: {
                  id: "gid://shopify/DiscountCodeNode/cost_budget_success",
                  codeDiscount: {
                    title: "$50 Off",
                    status: "ACTIVE",
                    codes: { nodes: [{ id: "c1", code: "WL-COSTOK" }] },
                  },
                },
                userErrors: [],
              },
            },
          }),
        };
      });

      const sagaResult = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId: rewardDefId,
        discountCode: "WL-COSTOK",
        idempotencyKey: "adversarial-cost-throttle-1",
        customFetch: costThrottledFetch as any,
      });

      expect(sagaResult.success).toBe(true);
      expect(callCount).toBe(2);
      expect(sagaResult.shopifyDiscountId).toBe(
        "gid://shopify/DiscountCodeNode/cost_budget_success",
      );
    });
  });

  // ==========================================================================
  // SECTION 4: Concurrent Outbox Recovery Sweeper Stress Test
  // ==========================================================================
  describe("Section 4: Concurrent Outbox Recovery Sweepers & Idempotency", () => {
    it("4.1: 10 concurrent recovery sweepers on a stuck 'provisioning' redemption with missing Shopify discount -> exactly 1 REDEMPTION_REFUND ledger entry created (zero double refunds)", async () => {
      const stuckRedemptionId = "wredemp_stuck_concurrent";
      const stuckCode = "WL-STUCKCONC01";

      // Seed a stuck provisioning redemption created 10 minutes ago
      mockState.redemptions.set(stuckRedemptionId, {
        id: stuckRedemptionId,
        storeId,
        accountId,
        rewardDefinitionId: rewardDefId,
        pointsSpent: BigInt(500),
        shopifyDiscountCode: stuckCode,
        status: WeleticRedemptionStatus.provisioning,
        createdAt: new Date(Date.now() - 600_000),
      });

      // Account had 500 points remaining after debit
      mockState.accounts.get(accountId).cachedPointsBalance = BigInt(500);

      // Shopify GraphQL returns null (discount code does not exist in Shopify)
      const missingFetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          data: {
            codeDiscountNodeByCode: null,
          },
        }),
      }));

      // Launch 10 concurrent sweepers simultaneously!
      const sweeps = await Promise.all([
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: missingFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: missingFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: missingFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: missingFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: missingFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: missingFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: missingFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: missingFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: missingFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: missingFetch as any,
        }),
      ]);

      // Verify exactly ONE REDEMPTION_REFUND ledger entry exists in DB
      const refundEntries = mockState.ledgerEntries.filter(
        (e) =>
          e.referenceType === "REDEMPTION_REFUND" &&
          e.referenceId === stuckRedemptionId,
      );
      expect(refundEntries.length).toBe(1);

      // Verify points were credited back exactly once: 500 + 500 = 1000
      const account = mockState.accounts.get(accountId);
      expect(account.cachedPointsBalance).toBe(BigInt(1000));

      // Redemption status must be failed
      const redemption = mockState.redemptions.get(stuckRedemptionId);
      expect(redemption.status).toBe(WeleticRedemptionStatus.failed);
    });

    it("4.2: 10 concurrent recovery sweepers on a stuck redemption that EXISTS in Shopify -> heals to 'issued' without duplicate GIDs or status drift", async () => {
      const stuckHealId = "wredemp_heal_concurrent";
      const healCode = "WL-HEALCONC01";
      const ownership = createLoyaltyDiscountProvisioningIdentity({
        identity: {
          storeId,
          redemptionId: stuckHealId,
          accountId,
          rewardDefinitionId: rewardDefId,
          discountCode: healCode,
        },
        rewardName: "$50 Off Exclusive Voucher",
      });
      const startsAt = new Date("2026-08-29T10:00:00.000Z");
      const expiresAt = new Date("2026-09-12T10:00:00.000Z");
      const provisioningSnapshot = createLoyaltyRedemptionProvisioningSnapshot({
        reward: mockState.rewards.get(rewardDefId),
        pointsCost: BigInt(500),
        discountValue: 5000,
        expiresInDays: 14,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
        customerSelectionDigest: getShopifyCustomerSelectionDigest({
          storeId,
          shopifyCustomerId: "gid://shopify/Customer/999888",
        }),
        startsAt,
        expiresAt,
      });

      mockState.redemptions.set(stuckHealId, {
        id: stuckHealId,
        storeId,
        accountId,
        rewardDefinitionId: rewardDefId,
        pointsSpent: BigInt(500),
        shopifyDiscountCode: healCode,
        status: WeleticRedemptionStatus.provisioning,
        metadata: {
          rewardSnapshot: { name: "$50 Off Exclusive Voucher" },
          shopifyDiscountOwnership: ownership,
          provisioningSnapshot,
        },
        expiresAt,
        createdAt: new Date(Date.now() - 600_000),
      });

      // Shopify GraphQL returns existing node
      const healFetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          data: {
            codeDiscountNodeByCode: {
              id: "gid://shopify/DiscountCodeNode/heal_existing_123",
              codeDiscount: {
                __typename: "DiscountCodeBasic",
                title: ownership.expectedTitle,
                status: "ACTIVE",
                startsAt: startsAt.toISOString(),
                endsAt: expiresAt.toISOString(),
                usageLimit: 1,
                appliesOncePerCustomer: true,
                recurringCycleLimit: 1,
                combinesWith: {
                  orderDiscounts: true,
                  productDiscounts: true,
                  shippingDiscounts: false,
                },
                customerSelection: {
                  __typename: "DiscountCustomers",
                  customers: [{ id: "gid://shopify/Customer/999888" }],
                },
                minimumRequirement: null,
                customerGets: {
                  appliesOnOneTimePurchase: true,
                  appliesOnSubscription: false,
                  value: {
                    __typename: "DiscountAmount",
                    amount: { amount: "50.00", currencyCode: "USD" },
                    appliesOnEachItem: false,
                  },
                  items: {
                    __typename: "AllDiscountItems",
                    allItems: true,
                  },
                },
                codes: { nodes: [{ id: "c1", code: healCode }] },
              },
            },
          },
        }),
      }));

      // Launch 10 concurrent sweepers
      await Promise.all([
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: healFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: healFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: healFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: healFetch as any,
        }),
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: healFetch as any,
        }),
      ]);

      const redemption = mockState.redemptions.get(stuckHealId);
      expect(redemption.status).toBe(WeleticRedemptionStatus.issued);
      expect(redemption.shopifyDiscountId).toBe(
        "gid://shopify/DiscountCodeNode/heal_existing_123",
      );

      // No refund entries should exist
      const refundEntries = mockState.ledgerEntries.filter(
        (e) =>
          e.referenceType === "REDEMPTION_REFUND" &&
          e.referenceId === stuckHealId,
      );
      expect(refundEntries.length).toBe(0);
    });
  });

  // ==========================================================================
  // SECTION 5: Double-Entry Financial Invariants & Edge Cases
  // ==========================================================================
  describe("Section 5: Double-Entry Financial Invariants & Extreme Boundaries", () => {
    it("5.1: Insufficient points balance rejects immediately at Phase 1 with zero ledger writes or API calls", async () => {
      // Set account balance to 100 (needs 500)
      mockState.accounts.get(accountId).cachedPointsBalance = BigInt(100);

      const mockFetch = vi.fn();

      await expect(
        provisionDiscountSaga({
          storeId,
          accountId,
          rewardDefinitionId: rewardDefId,
          idempotencyKey: "adversarial-insufficient-1",
          customFetch: mockFetch as any,
        }),
      ).rejects.toThrow(/Insufficient points balance/i);

      // Verify zero ledger writes
      expect(mockState.ledgerEntries.length).toBe(0);
      // Verify zero Shopify API calls
      expect(mockFetch).not.toHaveBeenCalled();
      // Balance remains untouched
      expect(mockState.accounts.get(accountId).cachedPointsBalance).toBe(
        BigInt(100),
      );
    });

    it("5.2: Program kill switch active rejects Phase 1 immediately with zero ledger writes", async () => {
      mockState.accounts.get(accountId).program.killSwitchActive = true;

      const mockFetch = vi.fn();

      await expect(
        provisionDiscountSaga({
          storeId,
          accountId,
          rewardDefinitionId: rewardDefId,
          idempotencyKey: "adversarial-kill-switch-1",
          customFetch: mockFetch as any,
        }),
      ).rejects.toThrow(/disabled or inactive/i);

      expect(mockState.ledgerEntries.length).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("5.3: Exact BigInt points conservation under repeated failed & succeeded redemptions", async () => {
      // 1. First redemption fails -> compensated
      const failFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: { get: () => null },
      });

      const res1 = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId: rewardDefId,
        discountCode: "WL-FAIL1",
        idempotencyKey: "adversarial-conservation-fail-1",
        customFetch: failFetch as any,
      });

      expect(res1.success).toBe(false);
      expect(mockState.accounts.get(accountId).cachedPointsBalance).toBe(
        BigInt(1000),
      );

      // 2. Second redemption succeeds
      const successFetch = vi.fn().mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/ok_2",
                codeDiscount: {
                  title: "$50 Off",
                  status: "ACTIVE",
                  codes: { nodes: [{ id: "c2", code: "WL-SUCC2" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      }));

      const res2 = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId: rewardDefId,
        discountCode: "WL-SUCC2",
        idempotencyKey: "adversarial-conservation-success-2",
        customFetch: successFetch as any,
      });

      expect(res2.success).toBe(true);
      expect(mockState.accounts.get(accountId).cachedPointsBalance).toBe(
        BigInt(500),
      );

      // 3. Third redemption succeeds
      const res3 = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId: rewardDefId,
        discountCode: "WL-SUCC3",
        idempotencyKey: "adversarial-conservation-success-3",
        customFetch: successFetch as any,
      });

      expect(res3.success).toBe(true);
      expect(mockState.accounts.get(accountId).cachedPointsBalance).toBe(
        BigInt(0),
      );

      // 4. Fourth redemption fails due to insufficient balance
      await expect(
        provisionDiscountSaga({
          storeId,
          accountId,
          rewardDefinitionId: rewardDefId,
          discountCode: "WL-FAIL4",
          idempotencyKey: "adversarial-conservation-fail-4",
          customFetch: successFetch as any,
        }),
      ).rejects.toThrow(/Insufficient points balance/i);

      expect(mockState.accounts.get(accountId).cachedPointsBalance).toBe(
        BigInt(0),
      );
    });
  });
});
