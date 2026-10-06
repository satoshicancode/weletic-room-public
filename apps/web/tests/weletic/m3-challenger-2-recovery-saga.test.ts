import {
  createLoyaltyRedemptionProvisioningSnapshot,
  getShopifyCustomerSelectionDigest,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import {
  reconcilePendingStoreCreditRedemption,
  reconcilePendingStoreCreditRedemptionsSweep,
} from "@/lib/weletic/loyalty/store-credit-reconciliation";
import {
  WeleticPointsLedgerEntryType,
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// ============================================================================
// State & In-Memory Mocks
// ============================================================================

interface MockAccount {
  id: string;
  storeId: string;
  cachedPointsBalance: bigint;
  status?: string;
  metadata?: any;
  shopper?: {
    id: string;
    shopifyCustomerId: string;
  };
}

interface MockRedemption {
  id: string;
  storeId: string;
  accountId: string;
  pointsSpent: bigint;
  shopifyDiscountCode: string;
  shopifyDiscountCodeCanonical: string;
  artifactKind: WeleticRewardArtifactKind;
  status: WeleticRedemptionStatus;
  shopifyStoreCreditTransactionId: string | null;
  issuanceConfirmedAt: Date | null;
  compensationReason?: string | null;
  settlementQuarantinedAt?: Date | null;
  createdAt: Date;
  expiresAt?: Date | null;
  metadata: any;
}

interface MockLedgerEntry {
  storeId: string;
  accountId: string;
  entryType: WeleticPointsLedgerEntryType;
  pointsDelta: bigint;
  referenceType: string;
  referenceId: string;
  idempotencyKey: string;
  reason?: string;
  metadata?: any;
}

const mockState = {
  redemptions: new Map<string, MockRedemption>(),
  accounts: new Map<string, MockAccount>(),
  ledgerEntries: [] as MockLedgerEntry[],
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
          where: {
            id: string;
            storeId?: string;
            status?: any;
            settlementQuarantinedAt?: null;
          };
          data: any;
        }) => {
          const row = mockState.redemptions.get(where.id);
          if (!row) return { count: 0 };
          if (where.storeId && row.storeId !== where.storeId)
            return { count: 0 };

          // Status match check
          if (where.status) {
            if (
              typeof where.status === "string" &&
              row.status !== where.status
            ) {
              return { count: 0 };
            }
            if (
              where.status?.in &&
              Array.isArray(where.status.in) &&
              !where.status.in.includes(row.status)
            ) {
              return { count: 0 };
            }
          }

          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return mockState.accounts.get(where.id) ?? null;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; storeId?: string } }) => {
          const acc = mockState.accounts.get(where.id);
          if (acc && (!where.storeId || acc.storeId === where.storeId)) {
            return { ...acc };
          }
          return null;
        },
      ),
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

// Emulate full financial saga compensation with points ledger entry append
vi.mock("@/lib/weletic/loyalty/saga", () => ({
  compensateDiscountSaga: vi.fn(
    async ({
      redemptionId,
      reason,
      targetStatus = WeleticRedemptionStatus.failed,
    }: {
      redemptionId: string;
      reason: string;
      targetStatus?: WeleticRedemptionStatus;
    }) => {
      mockState.compensations.push({ redemptionId, reason, targetStatus });
      const redemption = mockState.redemptions.get(redemptionId);
      if (!redemption) return;

      // Idempotency: only transition if in cancelable/compensatable status
      if (
        redemption.status === WeleticRedemptionStatus.cancelled ||
        redemption.status === WeleticRedemptionStatus.expired ||
        redemption.status === WeleticRedemptionStatus.failed
      ) {
        return;
      }

      // Check quarantine
      if (redemption.settlementQuarantinedAt != null) {
        throw new Error(
          `Cannot automatically compensate quarantined redemption ${redemption.id}; exact Shopify identity reconciliation is required`,
        );
      }

      // Transition redemption status
      redemption.status = targetStatus;
      redemption.compensationReason = reason;

      // Append ledger entry (idempotency key: saga_compensate:{redemptionId})
      const idempotencyKey = `saga_compensate:${redemption.id}`;
      const existingLedger = mockState.ledgerEntries.find(
        (e) =>
          e.storeId === redemption.storeId &&
          e.idempotencyKey === idempotencyKey,
      );

      if (!existingLedger) {
        mockState.ledgerEntries.push({
          storeId: redemption.storeId,
          accountId: redemption.accountId,
          entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
          pointsDelta: redemption.pointsSpent,
          referenceType: "REDEMPTION_REFUND",
          referenceId: redemption.id,
          idempotencyKey,
          reason: `Compensating refund for failed discount voucher (${reason})`,
          metadata: {
            redemptionId: redemption.id,
            discountCode: redemption.shopifyDiscountCode,
            failedReason: reason,
          },
        });

        // Restore cachedPointsBalance atomically
        const account = mockState.accounts.get(redemption.accountId);
        if (account) {
          account.cachedPointsBalance += redemption.pointsSpent;
        }

        // Enqueue storefront metafield sync
        mockState.outboxJobs.push({
          storeId: redemption.storeId,
          jobType: "METAFIELD_SYNC",
          payload: {
            accountId: redemption.accountId,
            triggerReason: "discount_voucher_compensation",
          },
          idempotencyKey: `metafield_sync:compensate:${redemption.id}`,
        });
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
        accessToken: `shpat_${storeId}_offline_token`,
        scope:
          "read_gift_cards,write_gift_cards,write_customers,read_store_credit_accounts,write_store_credit_account_transactions",
        source: "app_session",
      }),
    ),
  };
});

// ============================================================================
// Adversarial Challenger Test Suite
// ============================================================================

describe("Challenger 2: Adversarial Outbox Recovery & Saga Compensation", () => {
  const storeId = "store_adversarial_challenger_2";
  const customerId = "cust_adv_888999";

  beforeEach(() => {
    vi.clearAllMocks();
    mockState.redemptions.clear();
    mockState.accounts.clear();
    mockState.ledgerEntries = [];
    mockState.outboxJobs = [];
    mockState.flowTriggers = [];
    mockState.compensations = [];
  });

  function setupFixture({
    redemptionId = "redemp_adv_01",
    pointsSpent = BigInt(500),
    initialBalance = BigInt(2000), // after debit: 2000 remaining
    currency = "USD",
    amountMinor = "500",
    createdAt = new Date("2026-10-05T10:00:00.000Z"),
    remoteAttemptedAt = "2026-10-05T10:00:05.000Z" as string | null,
    status = WeleticRedemptionStatus.provisioning,
    artifactKind = WeleticRewardArtifactKind.store_credit,
  }: {
    redemptionId?: string;
    pointsSpent?: bigint;
    initialBalance?: bigint;
    currency?: string;
    amountMinor?: string;
    createdAt?: Date;
    remoteAttemptedAt?: string | null;
    status?: WeleticRedemptionStatus;
    artifactKind?: WeleticRewardArtifactKind;
  } = {}) {
    const accountId = `acc_${redemptionId}`;
    mockState.accounts.set(accountId, {
      id: accountId,
      storeId,
      cachedPointsBalance: initialBalance,
      status: "active",
      shopper: {
        id: `shopper_${redemptionId}`,
        shopifyCustomerId: customerId,
      },
    });

    const provisioningSnapshot = createLoyaltyRedemptionProvisioningSnapshot({
      reward: {
        id: "rew_sc_adv",
        name: "Adversarial Store Credit",
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

    const metadata: Record<string, any> = {
      provisioningSnapshot,
      remoteProvisionPreparationId: "prep_adv_123",
    };
    if (remoteAttemptedAt !== null) {
      metadata.remoteProvisionAttemptedAt = remoteAttemptedAt;
    }

    mockState.redemptions.set(redemptionId, {
      id: redemptionId,
      storeId,
      accountId,
      pointsSpent,
      shopifyDiscountCode: `WLSC_${redemptionId}`,
      shopifyDiscountCodeCanonical: `WLSC_${redemptionId}`,
      artifactKind,
      status,
      shopifyStoreCreditTransactionId: null,
      issuanceConfirmedAt: null,
      createdAt,
      metadata,
    });

    return { redemptionId, accountId };
  }

  const emptyShopifyFetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => ({
      data: {
        customer: {
          id: `gid://shopify/Customer/${customerId}`,
          storeCreditAccounts: { edges: [] },
        },
      },
    }),
  })) as any;

  // ==========================================================================
  // 1. Timeout Horizon Boundary Tests
  // ==========================================================================
  describe("1. Timeout Horizon Boundary Stress Testing", () => {
    it("T_attempt + 299,999ms (1ms before 5m horizon) -> DEFERRED, status stays provisioning, zero refund", async () => {
      const attemptBase = new Date("2026-10-05T10:00:00.000Z");
      const { redemptionId, accountId } = setupFixture({
        createdAt: attemptBase,
        remoteAttemptedAt: attemptBase.toISOString(),
        pointsSpent: BigInt(750),
        initialBalance: BigInt(1250),
      });

      // 1 millisecond before 5 minutes (299,999 ms)
      const justBeforeHorizon = new Date(attemptBase.getTime() + 299_999);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: justBeforeHorizon,
        customFetch: emptyShopifyFetch,
      });

      expect(result).toEqual({ outcome: "deferred" });

      const currentRedemption = mockState.redemptions.get(redemptionId);
      expect(currentRedemption?.status).toBe(
        WeleticRedemptionStatus.provisioning,
      );
      expect(mockState.compensations).toHaveLength(0);
      expect(mockState.ledgerEntries).toHaveLength(0);

      // Points balance must remain untouched
      const account = mockState.accounts.get(accountId);
      expect(account?.cachedPointsBalance).toBe(BigInt(1250));
    });

    it("T_attempt + 300,000ms (exact 5m horizon boundary) -> REFUNDED_AND_FAILED, transitions to failed, refund executed", async () => {
      const attemptBase = new Date("2026-10-05T10:00:00.000Z");
      const { redemptionId, accountId } = setupFixture({
        createdAt: attemptBase,
        remoteAttemptedAt: attemptBase.toISOString(),
        pointsSpent: BigInt(750),
        initialBalance: BigInt(1250),
      });

      // Exactly at 5 minutes (300,000 ms)
      const exactHorizon = new Date(attemptBase.getTime() + 300_000);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: exactHorizon,
        customFetch: emptyShopifyFetch,
      });

      expect(result).toEqual({ outcome: "refunded_and_failed" });

      const currentRedemption = mockState.redemptions.get(redemptionId);
      expect(currentRedemption?.status).toBe(WeleticRedemptionStatus.failed);
      expect(currentRedemption?.compensationReason).toContain(
        "timed out after 300s",
      );

      // Points balance must be restored: 1250 + 750 = 2000
      const account = mockState.accounts.get(accountId);
      expect(account?.cachedPointsBalance).toBe(BigInt(2000));
      expect(mockState.compensations).toHaveLength(1);
    });

    it("T_attempt + 300,001ms (1ms past 5m horizon) -> REFUNDED_AND_FAILED", async () => {
      const attemptBase = new Date("2026-10-05T10:00:00.000Z");
      const { redemptionId, accountId } = setupFixture({
        createdAt: attemptBase,
        remoteAttemptedAt: attemptBase.toISOString(),
        pointsSpent: BigInt(500),
        initialBalance: BigInt(1500),
      });

      // 1 millisecond past 5 minutes (300,001 ms)
      const justPastHorizon = new Date(attemptBase.getTime() + 300_001);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: justPastHorizon,
        customFetch: emptyShopifyFetch,
      });

      expect(result).toEqual({ outcome: "refunded_and_failed" });

      const currentRedemption = mockState.redemptions.get(redemptionId);
      expect(currentRedemption?.status).toBe(WeleticRedemptionStatus.failed);

      const account = mockState.accounts.get(accountId);
      expect(account?.cachedPointsBalance).toBe(BigInt(2000));
    });

    it("horizon anchor: when remoteProvisionAttemptedAt is present, anchor is remoteProvisionAttemptedAt, NOT createdAt", async () => {
      const createdAt = new Date("2026-10-05T10:00:00.000Z");
      // Remote attempt happened 2 minutes after record creation
      const remoteAttemptAt = new Date("2026-10-05T10:02:00.000Z");

      const { redemptionId, accountId } = setupFixture({
        createdAt,
        remoteAttemptedAt: remoteAttemptAt.toISOString(),
        pointsSpent: BigInt(500),
        initialBalance: BigInt(1000),
      });

      // At 10:06:00 (which is 6 min after createdAt, but only 4 min after remote attempt):
      // Must NOT expire yet!
      const checkAt1006 = new Date("2026-10-05T10:06:00.000Z");
      const resultDeferred = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: checkAt1006,
        customFetch: emptyShopifyFetch,
      });
      expect(resultDeferred).toEqual({ outcome: "deferred" });
      expect(mockState.redemptions.get(redemptionId)?.status).toBe(
        WeleticRedemptionStatus.provisioning,
      );
      expect(mockState.accounts.get(accountId)?.cachedPointsBalance).toBe(
        BigInt(1000),
      );

      // At 10:07:00 (5 min after remote attempt):
      // Must now expire and refund!
      const checkAt1007 = new Date("2026-10-05T10:07:00.000Z");
      const resultExpired = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: checkAt1007,
        customFetch: emptyShopifyFetch,
      });
      expect(resultExpired).toEqual({ outcome: "refunded_and_failed" });
      expect(mockState.redemptions.get(redemptionId)?.status).toBe(
        WeleticRedemptionStatus.failed,
      );
      expect(mockState.accounts.get(accountId)?.cachedPointsBalance).toBe(
        BigInt(1500),
      );
    });

    it("horizon anchor fallback: when remoteProvisionAttemptedAt is absent, anchor cleanly falls back to createdAt", async () => {
      const createdAt = new Date("2026-10-05T10:00:00.000Z");

      const { redemptionId, accountId } = setupFixture({
        createdAt,
        remoteAttemptedAt: null, // absent
        pointsSpent: BigInt(300),
        initialBalance: BigInt(700),
      });

      // At 4 min 50 sec: deferred
      const resDeferred = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date(createdAt.getTime() + 290_000),
        customFetch: emptyShopifyFetch,
      });
      expect(resDeferred).toEqual({ outcome: "deferred" });
      expect(mockState.redemptions.get(redemptionId)?.status).toBe(
        WeleticRedemptionStatus.provisioning,
      );

      // At 5 min 05 sec: expired and refunded
      const resExpired = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date(createdAt.getTime() + 305_000),
        customFetch: emptyShopifyFetch,
      });
      expect(resExpired).toEqual({ outcome: "refunded_and_failed" });
      expect(mockState.redemptions.get(redemptionId)?.status).toBe(
        WeleticRedemptionStatus.failed,
      );
      expect(mockState.accounts.get(accountId)?.cachedPointsBalance).toBe(
        BigInt(1000),
      );
    });

    it("custom horizon parameter: respects custom reconciliationHorizonMs (e.g. 15s horizon)", async () => {
      const attemptBase = new Date("2026-10-05T10:00:00.000Z");
      const { redemptionId, accountId } = setupFixture({
        createdAt: attemptBase,
        remoteAttemptedAt: attemptBase.toISOString(),
        pointsSpent: BigInt(100),
        initialBalance: BigInt(900),
      });

      const customHorizonMs = 15_000; // 15 seconds

      // At 14 seconds: deferred
      const resDeferred = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date(attemptBase.getTime() + 14_000),
        reconciliationHorizonMs: customHorizonMs,
        customFetch: emptyShopifyFetch,
      });
      expect(resDeferred).toEqual({ outcome: "deferred" });

      // At 15 seconds: expired & refunded
      const resExpired = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date(attemptBase.getTime() + 15_000),
        reconciliationHorizonMs: customHorizonMs,
        customFetch: emptyShopifyFetch,
      });
      expect(resExpired).toEqual({ outcome: "refunded_and_failed" });
      expect(mockState.accounts.get(accountId)?.cachedPointsBalance).toBe(
        BigInt(1000),
      );
    });
  });

  // ==========================================================================
  // 2. Points Ledger Integrity & Balance Restoration Tests
  // ==========================================================================
  describe("2. Points Ledger Integrity & Balance Restoration", () => {
    it("ledger delta equals debited points: appends exact REDEMPTION_REFUND ledger entry", async () => {
      const attemptBase = new Date("2026-10-05T10:00:00.000Z");
      const pointsSpent = BigInt(1250);
      const initialBalance = BigInt(3750); // Total before debit was 5000

      const { redemptionId, accountId } = setupFixture({
        createdAt: attemptBase,
        remoteAttemptedAt: attemptBase.toISOString(),
        pointsSpent,
        initialBalance,
      });

      const now = new Date(attemptBase.getTime() + 350_000); // 5m 50s later

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now,
        customFetch: emptyShopifyFetch,
      });

      expect(result).toEqual({ outcome: "refunded_and_failed" });

      // Check account balance restoration
      const account = mockState.accounts.get(accountId);
      expect(account?.cachedPointsBalance).toBe(BigInt(5000));

      // Check ledger entry integrity
      expect(mockState.ledgerEntries).toHaveLength(1);
      const entry = mockState.ledgerEntries[0];
      expect(entry.storeId).toBe(storeId);
      expect(entry.accountId).toBe(accountId);
      expect(entry.entryType).toBe(
        WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
      );
      expect(entry.pointsDelta).toBe(pointsSpent);
      expect(entry.referenceType).toBe("REDEMPTION_REFUND");
      expect(entry.referenceId).toBe(redemptionId);
      expect(entry.idempotencyKey).toBe(`saga_compensate:${redemptionId}`);
      expect(entry.reason).toContain("timed out after 300s");
      expect(entry.metadata).toMatchObject({
        redemptionId,
        failedReason: expect.stringContaining("timed out after 300s"),
      });

      // Check metafield sync outbox job
      expect(mockState.outboxJobs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            jobType: "METAFIELD_SYNC",
            idempotencyKey: `metafield_sync:compensate:${redemptionId}`,
            payload: expect.objectContaining({
              accountId,
              triggerReason: "discount_voucher_compensation",
            }),
          }),
        ]),
      );
    });

    it("high-magnitude BigInt points: 250,000,000 BigInt points spent, accurately restores without overflow or rounding", async () => {
      const attemptBase = new Date("2026-10-05T10:00:00.000Z");
      const pointsSpent = BigInt("250000000"); // 250 million points (VND/JPY style)
      const initialBalance = BigInt("1000000000"); // 1 billion points

      const { redemptionId, accountId } = setupFixture({
        createdAt: attemptBase,
        remoteAttemptedAt: attemptBase.toISOString(),
        pointsSpent,
        initialBalance,
        currency: "VND",
        amountMinor: "250000000",
      });

      const now = new Date(attemptBase.getTime() + 400_000);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now,
        customFetch: emptyShopifyFetch,
      });

      expect(result).toEqual({ outcome: "refunded_and_failed" });

      const account = mockState.accounts.get(accountId);
      // Expected: 1,000,000,000 + 250,000,000 = 1,250,000,000
      expect(account?.cachedPointsBalance).toBe(BigInt("1250000000"));

      const entry = mockState.ledgerEntries[0];
      expect(entry.pointsDelta).toBe(BigInt("250000000"));
    });

    it("boundary single-point redemption: 1 point spent, accurately restores balance from 0 to 1", async () => {
      const attemptBase = new Date("2026-10-05T10:00:00.000Z");
      const pointsSpent = BigInt(1);
      const initialBalance = BigInt(0);

      const { redemptionId, accountId } = setupFixture({
        createdAt: attemptBase,
        remoteAttemptedAt: attemptBase.toISOString(),
        pointsSpent,
        initialBalance,
      });

      const now = new Date(attemptBase.getTime() + 400_000);

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now,
        customFetch: emptyShopifyFetch,
      });

      expect(result).toEqual({ outcome: "refunded_and_failed" });

      const account = mockState.accounts.get(accountId);
      expect(account?.cachedPointsBalance).toBe(BigInt(1));
    });
  });

  // ==========================================================================
  // 3. Idempotency & Double-Refund / Mutation Defense Tests
  // ==========================================================================
  describe("3. Idempotency & Double-Refund / Mutation Defense", () => {
    it("sequential reconciliation on confirmed redemption: subsequent runs return skipped (status_issued) with zero duplicate mutations", async () => {
      const attemptBase = new Date("2026-10-05T10:00:00.000Z");
      const { redemptionId, accountId } = setupFixture({
        createdAt: attemptBase,
        remoteAttemptedAt: attemptBase.toISOString(),
        pointsSpent: BigInt(500),
        initialBalance: BigInt(2000),
      });

      const matchingTxId =
        "gid://shopify/StoreCreditAccountCreditTransaction/tx_confirmed_adv_1";
      const customFetch = vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({
          data: {
            customer: {
              id: `gid://shopify/Customer/${customerId}`,
              storeCreditAccounts: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/StoreCreditAccount/acc_adv",
                      balance: { amount: "5.00", currencyCode: "USD" },
                      transactions: {
                        edges: [
                          {
                            node: {
                              id: matchingTxId,
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
      })) as any;

      // First run: confirms issuance
      const run1 = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:01:00.000Z"),
        customFetch,
      });
      expect(run1).toEqual({
        outcome: "confirmed",
        transactionId: matchingTxId,
      });

      const initialOutboxCount = mockState.outboxJobs.length;
      const initialFlowTriggerCount = mockState.flowTriggers.length;
      expect(initialOutboxCount).toBeGreaterThan(0);
      expect(initialFlowTriggerCount).toBe(1);

      // Second run: redemption is now 'issued'
      const run2 = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:02:00.000Z"),
        customFetch,
      });
      expect(run2).toEqual({ outcome: "skipped", reason: "status_issued" });

      // Third run: redemption is still 'issued'
      const run3 = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:03:00.000Z"),
        customFetch,
      });
      expect(run3).toEqual({ outcome: "skipped", reason: "status_issued" });

      // ZERO additional outbox jobs or flow triggers should have been queued
      expect(mockState.outboxJobs.length).toBe(initialOutboxCount);
      expect(mockState.flowTriggers.length).toBe(initialFlowTriggerCount);

      // Points balance remains strictly debited (2000)
      const account = mockState.accounts.get(accountId);
      expect(account?.cachedPointsBalance).toBe(BigInt(2000));
      expect(mockState.ledgerEntries).toHaveLength(0);
    });

    it("sequential reconciliation on failed redemption: subsequent runs return skipped (status_failed) with ZERO second refund and ZERO duplicate ledger entries", async () => {
      const attemptBase = new Date("2026-10-05T10:00:00.000Z");
      const { redemptionId, accountId } = setupFixture({
        createdAt: attemptBase,
        remoteAttemptedAt: attemptBase.toISOString(),
        pointsSpent: BigInt(600),
        initialBalance: BigInt(1400),
      });

      const expiredTime = new Date("2026-10-05T10:10:00.000Z");

      // First run: times out, refunds points from 1400 to 2000 (+600)
      const run1 = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: expiredTime,
        customFetch: emptyShopifyFetch,
      });
      expect(run1).toEqual({ outcome: "refunded_and_failed" });
      expect(mockState.accounts.get(accountId)?.cachedPointsBalance).toBe(
        BigInt(2000),
      );
      expect(mockState.ledgerEntries).toHaveLength(1);

      // Second run: redemption is now 'failed'
      const run2 = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:11:00.000Z"),
        customFetch: emptyShopifyFetch,
      });
      expect(run2).toEqual({ outcome: "skipped", reason: "status_failed" });

      // Third run: redemption is still 'failed'
      const run3 = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date("2026-10-05T10:12:00.000Z"),
        customFetch: emptyShopifyFetch,
      });
      expect(run3).toEqual({ outcome: "skipped", reason: "status_failed" });

      // CRITICAL FINANCIAL INVARIANT: Balance must NOT be refunded again (still 2000, NOT 2600 or 3200)
      expect(mockState.accounts.get(accountId)?.cachedPointsBalance).toBe(
        BigInt(2000),
      );
      // Exactly 1 ledger entry, no duplicate appends
      expect(mockState.ledgerEntries).toHaveLength(1);
    });

    it("sweeper idempotency: second sweep over resolved redemptions scans 0 records and mutates nothing", async () => {
      const t0 = new Date("2026-10-05T08:00:00.000Z");
      setupFixture({
        redemptionId: "sweep_item_1",
        createdAt: t0,
        remoteAttemptedAt: t0.toISOString(),
      });
      setupFixture({
        redemptionId: "sweep_item_2",
        createdAt: t0,
        remoteAttemptedAt: t0.toISOString(),
      });

      const now = new Date("2026-10-05T08:10:00.000Z");

      // Sweep 1: both items time out and fail
      const sweep1 = await reconcilePendingStoreCreditRedemptionsSweep({
        batchSize: 10,
        now,
        customFetch: emptyShopifyFetch,
      });
      expect(sweep1.scanned).toBe(2);
      expect(sweep1.refunded).toBe(2);

      // Sweep 2: both items are now 'failed', so Prisma findMany(where: { status: provisioning }) returns 0
      const sweep2 = await reconcilePendingStoreCreditRedemptionsSweep({
        batchSize: 10,
        now: new Date(now.getTime() + 60_000),
        customFetch: emptyShopifyFetch,
      });
      expect(sweep2.scanned).toBe(0);
      expect(sweep2.confirmed).toBe(0);
      expect(sweep2.refunded).toBe(0);
      expect(sweep2.deferred).toBe(0);
      expect(sweep2.errors).toBe(0);
    });

    it("outbox worker recovery idempotency: handleRedemptionRecovery on already-issued store credit returns undefined and skips reconciliation", async () => {
      const { redemptionId } = setupFixture({
        redemptionId: "recovery_idemp_01",
        status: WeleticRedemptionStatus.issued, // Already confirmed previously
        pointsSpent: BigInt(500),
      });

      const { handleRedemptionRecovery } = await import(
        "@/lib/weletic/loyalty/outbox-worker"
      );

      const recoveryOutcome = await handleRedemptionRecovery(
        storeId,
        {
          redemptionId,
          accountId: `acc_${redemptionId}`,
          rewardDefinitionId: "rew_sc_adv",
          shopifyDiscountCode: `WLSC_${redemptionId}`,
          pointsCost: "500",
          attemptCount: 1,
          sagaPhase: "provisioning",
          artifactKind: WeleticRewardArtifactKind.store_credit,
        },
        null,
        new Date("2026-10-05T10:10:00.000Z"),
      );

      expect(recoveryOutcome).toBeUndefined();
      // No compensation or refund executed
      expect(mockState.compensations).toHaveLength(0);
      expect(mockState.ledgerEntries).toHaveLength(0);
    });

    it("tenant isolation: storeId mismatch strictly returns { outcome: 'skipped', reason: 'not_found' }", async () => {
      const { redemptionId } = setupFixture({
        redemptionId: "tenant_iso_01",
      });

      const result = await reconcilePendingStoreCreditRedemption({
        storeId: "foreign_attacker_store_999",
        redemptionId,
        now: new Date(),
        customFetch: emptyShopifyFetch,
      });

      expect(result).toEqual({ outcome: "skipped", reason: "not_found" });
      expect(mockState.compensations).toHaveLength(0);
    });

    it("already used status: status_used returns skipped and never compensates or mutates", async () => {
      const { redemptionId } = setupFixture({
        redemptionId: "used_redemp_01",
        status: WeleticRedemptionStatus.used,
      });

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date(),
        customFetch: emptyShopifyFetch,
      });

      expect(result).toEqual({ outcome: "skipped", reason: "status_used" });
      expect(mockState.compensations).toHaveLength(0);
    });

    it("missing shopper customer ID: returns skipped (missing_customer_id) without throwing", async () => {
      const { redemptionId } = setupFixture({
        redemptionId: "no_cust_01",
      });
      // Clear customer ID on account and shopper
      const acc = mockState.accounts.get(`acc_${redemptionId}`);
      if (acc?.shopper) acc.shopper.shopifyCustomerId = "";

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date(),
        customFetch: emptyShopifyFetch,
      });

      expect(result).toEqual({
        outcome: "skipped",
        reason: "missing_customer_id",
      });
      expect(mockState.compensations).toHaveLength(0);
    });

    it("missing snapshot: returns skipped (missing_snapshot) without throwing", async () => {
      const { redemptionId } = setupFixture({
        redemptionId: "no_snap_01",
      });
      const redemp = mockState.redemptions.get(redemptionId);
      if (redemp) redemp.metadata = null;

      const result = await reconcilePendingStoreCreditRedemption({
        storeId,
        redemptionId,
        now: new Date(),
        customFetch: emptyShopifyFetch,
      });

      expect(result).toEqual({
        outcome: "skipped",
        reason: "missing_snapshot",
      });
      expect(mockState.compensations).toHaveLength(0);
    });

    it("quarantined redemption defense: rejects automatic compensation when settlementQuarantinedAt is set", async () => {
      const attemptBase = new Date("2026-10-05T10:00:00.000Z");
      const { redemptionId } = setupFixture({
        redemptionId: "quarantined_sc_01",
        createdAt: attemptBase,
        remoteAttemptedAt: attemptBase.toISOString(),
      });
      const redemp = mockState.redemptions.get(redemptionId);
      if (redemp) {
        redemp.settlementQuarantinedAt = new Date("2026-10-05T10:01:00.000Z");
      }

      const expiredTime = new Date(attemptBase.getTime() + 400_000);

      await expect(
        reconcilePendingStoreCreditRedemption({
          storeId,
          redemptionId,
          now: expiredTime,
          customFetch: emptyShopifyFetch,
        }),
      ).rejects.toThrow(
        "Cannot automatically compensate quarantined redemption",
      );

      expect(mockState.ledgerEntries).toHaveLength(0);
    });

    it("sweeper respects batchSize: caps processed redemptions strictly to batchSize", async () => {
      const t0 = new Date("2026-10-05T07:00:00.000Z");
      setupFixture({
        redemptionId: "batch_1",
        createdAt: t0,
        remoteAttemptedAt: t0.toISOString(),
      });
      setupFixture({
        redemptionId: "batch_2",
        createdAt: t0,
        remoteAttemptedAt: t0.toISOString(),
      });
      setupFixture({
        redemptionId: "batch_3",
        createdAt: t0,
        remoteAttemptedAt: t0.toISOString(),
      });

      const sweepResult = await reconcilePendingStoreCreditRedemptionsSweep({
        batchSize: 2, // strictly 2
        now: new Date("2026-10-05T07:15:00.000Z"),
        customFetch: emptyShopifyFetch,
      });

      expect(sweepResult.scanned).toBe(2);
      expect(sweepResult.refunded).toBe(2);
    });
  });
});
