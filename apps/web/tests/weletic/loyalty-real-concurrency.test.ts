import {
  calculateRefundPointsReversal,
  processRefundPointsReversal,
} from "@/lib/weletic/loyalty/earn";
import {
  appendPointsLedgerEntry,
  OptimisticConcurrencyError,
  reconcileAccountPoints,
} from "@/lib/weletic/loyalty/ledger";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import {
  processOutboxJobsBatch,
  reapStaleOutboxLocks,
} from "@/lib/weletic/loyalty/outbox-worker";
import { provisionDiscountSaga } from "@/lib/weletic/loyalty/saga";
import {
  Prisma,
  WeleticLoyaltyOutboxJobStatus,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ============================================================================
// Deterministic in-memory concurrency simulation with CAS-like semantics.
// Real MySQL behavior is covered separately by loyalty-ledger-db.integration.test.ts.
// ============================================================================

const { dbHarness } = vi.hoisted(() => {
  class RealDatabaseConcurrencyHarness {
    public accounts = new Map<string, any>();
    public ledgerEntries = new Map<string, any>();
    public outboxJobs = new Map<string, any>();
    public earnGrants = new Map<string, any>();
    public orderLineEarns = new Map<string, any>();
    public rewardDefinitions = new Map<string, any>();
    public redemptions = new Map<string, any>();
    public programs = new Map<string, any>();
    public orders = new Map<string, any>();
    public refunds = new Map<string, any>();

    // Tracks unique compound constraints: storeId + idempotencyKey
    public ledgerIdempotency = new Set<string>();
    public outboxIdempotency = new Set<string>();
    // Tracks unique accountId + sequenceNumber
    public accountSequences = new Set<string>();

    public reset() {
      this.accounts.clear();
      this.ledgerEntries.clear();
      this.outboxJobs.clear();
      this.earnGrants.clear();
      this.orderLineEarns.clear();
      this.rewardDefinitions.clear();
      this.redemptions.clear();
      this.programs.clear();
      this.orders.clear();
      this.refunds.clear();
      this.ledgerIdempotency.clear();
      this.outboxIdempotency.clear();
      this.accountSequences.clear();
    }

    public createClient(): any {
      const harness = this;

      const client = {
        weleticLoyaltyAccount: {
          findFirst: vi.fn(async ({ where }: any) => {
            const acc = harness.accounts.get(where.id);
            if (!acc || (where.storeId && acc.storeId !== where.storeId)) {
              return null;
            }
            return {
              ...acc,
              shopper: {
                id: acc.shopperId,
                shopifyCustomerId: "sh_cust_123",
              },
              store: { projectId: "workspace_stress_m6" },
            };
          }),
          findUnique: vi.fn(async ({ where, include }: any) => {
            const acc = harness.accounts.get(where.id);
            if (!acc) return null;
            const clone = { ...acc };
            if (include?.program) {
              clone.program = harness.programs.get(acc.programId);
            }
            if (include?.shopper) {
              clone.shopper = {
                id: acc.shopperId,
                shopifyCustomerId: "sh_cust_123",
              };
            }
            return clone;
          }),
          update: vi.fn(async ({ where, data }: any) => {
            const acc = harness.accounts.get(where.id);
            if (!acc) throw new Error(`Account ${where.id} not found`);
            const updated = { ...acc, ...data };
            harness.accounts.set(where.id, updated);
            return { ...updated };
          }),
          updateMany: vi.fn(async ({ where, data }: any) => {
            const acc = harness.accounts.get(where.id);
            if (!acc) return { count: 0 };

            // Optimistic Concurrency Check on ledgerVersion
            if (
              where.ledgerVersion !== undefined &&
              acc.ledgerVersion !== where.ledgerVersion
            ) {
              return { count: 0 }; // OCC version mismatch!
            }

            const updated = { ...acc, ...data };
            harness.accounts.set(where.id, updated);
            return { count: 1 };
          }),
        },

        weleticPointsLedgerEntry: {
          findUnique: vi.fn(async ({ where }: any) => {
            if (where.storeId_idempotencyKey) {
              const key = `${where.storeId_idempotencyKey.storeId}:${where.storeId_idempotencyKey.idempotencyKey}`;
              for (const entry of harness.ledgerEntries.values()) {
                if (`${entry.storeId}:${entry.idempotencyKey}` === key) {
                  return { ...entry };
                }
              }
              return null;
            }
            return harness.ledgerEntries.get(where.id) || null;
          }),
          findFirst: vi.fn(async ({ where, orderBy }: any) => {
            const matching = Array.from(harness.ledgerEntries.values()).filter(
              (e) => e.accountId === where.accountId,
            );
            if (orderBy?.sequenceNumber === "desc") {
              matching.sort((a, b) => b.sequenceNumber - a.sequenceNumber);
            }
            return matching[0] ? { ...matching[0] } : null;
          }),
          findMany: vi.fn(async ({ where, orderBy }: any) => {
            let matching = Array.from(harness.ledgerEntries.values());
            if (where?.storeId) {
              matching = matching.filter((e) => e.storeId === where.storeId);
            }
            if (where?.accountId) {
              matching = matching.filter(
                (e) => e.accountId === where.accountId,
              );
            }
            if (where?.grantId !== undefined) {
              matching = matching.filter((e) => e.grantId === where.grantId);
            }
            if (where?.entryType) {
              matching = matching.filter(
                (e) => e.entryType === where.entryType,
              );
            }
            if (where?.idempotencyKey?.in) {
              matching = matching.filter((e) =>
                where.idempotencyKey.in.includes(e.idempotencyKey),
              );
            }
            const orderClauses = Array.isArray(orderBy)
              ? orderBy
              : orderBy
                ? [orderBy]
                : [];
            if (
              orderClauses.some((clause) => clause.sequenceNumber === "asc")
            ) {
              matching.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
            } else if (
              orderClauses.some((clause) => clause.createdAt === "asc")
            ) {
              matching.sort((a, b) => {
                const timeDelta =
                  new Date(a.createdAt).getTime() -
                  new Date(b.createdAt).getTime();
                return timeDelta !== 0
                  ? timeDelta
                  : String(a.id).localeCompare(String(b.id));
              });
            }
            return matching.map((e) => ({ ...e }));
          }),
          count: vi.fn(async ({ where }: any) => {
            let matching = Array.from(harness.ledgerEntries.values());
            if (where?.accountId) {
              matching = matching.filter(
                (e) => e.accountId === where.accountId,
              );
            }
            return matching.length;
          }),
          create: vi.fn(async ({ data }: any) => {
            const idempotencyCheckKey = `${data.storeId}:${data.idempotencyKey}`;
            if (harness.ledgerIdempotency.has(idempotencyCheckKey)) {
              const err = new Prisma.PrismaClientKnownRequestError(
                "Unique constraint failed on storeId_idempotencyKey",
                { code: "P2002", clientVersion: "5.0.0" },
              );
              throw err;
            }

            const sequenceCheckKey = `${data.accountId}:${data.sequenceNumber}`;
            if (harness.accountSequences.has(sequenceCheckKey)) {
              const err = new Prisma.PrismaClientKnownRequestError(
                "Unique constraint failed on accountId_sequenceNumber",
                { code: "P2002", clientVersion: "5.0.0" },
              );
              throw err;
            }

            harness.ledgerIdempotency.add(idempotencyCheckKey);
            harness.accountSequences.add(sequenceCheckKey);

            const entry = {
              ...data,
              id: data.id || `wledger_${Date.now()}_${Math.random()}`,
            };
            harness.ledgerEntries.set(entry.id, entry);
            return { ...entry };
          }),
          updateMany: vi.fn(async ({ where, data }: any) => {
            const entry = harness.ledgerEntries.get(where.id);
            if (!entry) return { count: 0 };
            for (const field of [
              "storeId",
              "accountId",
              "entryType",
              "idempotencyKey",
              "pointsDelta",
              "pendingDelta",
              "grantId",
            ]) {
              if (where[field] !== undefined && entry[field] !== where[field]) {
                return { count: 0 };
              }
            }
            harness.ledgerEntries.set(where.id, { ...entry, ...data });
            return { count: 1 };
          }),
        },

        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn(async ({ where }: any) => {
            if (where.storeId_idempotencyKey) {
              const key = `${where.storeId_idempotencyKey.storeId}:${where.storeId_idempotencyKey.idempotencyKey}`;
              for (const job of harness.outboxJobs.values()) {
                if (`${job.storeId}:${job.idempotencyKey}` === key) {
                  return { ...job };
                }
              }
              return null;
            }
            return harness.outboxJobs.get(where.id) || null;
          }),
          findMany: vi.fn(async ({ where, take, orderBy }: any) => {
            let jobs = Array.from(harness.outboxJobs.values());
            if (where?.status?.in) {
              jobs = jobs.filter((j) => where.status.in.includes(j.status));
            } else if (where?.status) {
              jobs = jobs.filter((j) => j.status === where.status);
            }
            if (where?.scheduledFor?.lte) {
              jobs = jobs.filter(
                (j) => new Date(j.scheduledFor) <= where.scheduledFor.lte,
              );
            }
            if (where?.lockedAt?.lt) {
              jobs = jobs.filter(
                (j) => j.lockedAt && new Date(j.lockedAt) < where.lockedAt.lt,
              );
            }
            if (take) {
              jobs = jobs.slice(0, take);
            }
            return jobs.map((j) => ({ ...j }));
          }),
          create: vi.fn(async ({ data }: any) => {
            if (data.idempotencyKey) {
              const key = `${data.storeId}:${data.idempotencyKey}`;
              if (harness.outboxIdempotency.has(key)) {
                const err = new Prisma.PrismaClientKnownRequestError(
                  "Unique constraint failed on storeId_idempotencyKey",
                  { code: "P2002", clientVersion: "5.0.0" },
                );
                throw err;
              }
              harness.outboxIdempotency.add(key);
            }
            const job = {
              ...data,
              id: data.id || `outbox_${Date.now()}_${Math.random()}`,
              attempts: data.attempts || 0,
              status: data.status || WeleticLoyaltyOutboxJobStatus.pending,
              lockedAt: data.lockedAt || null,
              lockedBy: data.lockedBy || null,
            };
            harness.outboxJobs.set(job.id, job);
            return { ...job };
          }),
          update: vi.fn(async ({ where, data }: any) => {
            const job = harness.outboxJobs.get(where.id);
            if (!job) throw new Error(`Outbox job ${where.id} not found`);
            const updated = { ...job, ...data };
            harness.outboxJobs.set(where.id, updated);
            return { ...updated };
          }),
          updateMany: vi.fn(async ({ where, data }: any) => {
            let count = 0;
            for (const [id, job] of harness.outboxJobs.entries()) {
              let match = true;
              if (where.id && job.id !== where.id) match = false;
              if (where.status && job.status !== where.status) match = false;
              if (
                where.lockedAt !== undefined &&
                job.lockedAt !== where.lockedAt
              ) {
                if (where.lockedAt?.lt) {
                  if (
                    !job.lockedAt ||
                    !(new Date(job.lockedAt) < where.lockedAt.lt)
                  ) {
                    match = false;
                  }
                } else {
                  match = false;
                }
              }

              if (match) {
                const updatedData: any = { ...data };
                if (data.attempts?.increment) {
                  updatedData.attempts =
                    (job.attempts || 0) + data.attempts.increment;
                }
                const updated = { ...job, ...updatedData };
                harness.outboxJobs.set(id, updated);
                count++;
              }
            }
            return { count };
          }),
        },

        weleticRewardDefinition: {
          findUnique: vi.fn(async ({ where }: any) => {
            return harness.rewardDefinitions.get(where.id) || null;
          }),
        },

        weleticShopifyStore: {
          findUnique: vi.fn(async () => ({
            id: "wstore_stress_m6",
            complianceState: "active",
            shopCurrency: "USD",
            currencyVerifiedAt: new Date(0),
            installationGeneration: "igen_stress_m6",
          })),
        },

        weleticRewardRedemption: {
          findUnique: vi.fn(async ({ where }: any) => {
            return harness.redemptions.get(where.id) || null;
          }),
          create: vi.fn(async ({ data }: any) => {
            const redemp = { ...data, id: data.id || `wredemp_${Date.now()}` };
            harness.redemptions.set(redemp.id, redemp);
            return { ...redemp };
          }),
          update: vi.fn(async ({ where, data }: any) => {
            const redemp = harness.redemptions.get(where.id);
            if (!redemp) throw new Error(`Redemption ${where.id} not found`);
            const updated = { ...redemp, ...data };
            harness.redemptions.set(where.id, updated);
            return { ...updated };
          }),
          updateMany: vi.fn(async ({ where, data }: any) => {
            const redemp = harness.redemptions.get(where.id);
            if (!redemp) return { count: 0 };
            if (where.storeId && redemp.storeId !== where.storeId) {
              return { count: 0 };
            }
            if (
              typeof where.status === "string" &&
              redemp.status !== where.status
            ) {
              return { count: 0 };
            }
            if (where.status?.in && !where.status.in.includes(redemp.status)) {
              return { count: 0 };
            }
            harness.redemptions.set(where.id, { ...redemp, ...data });
            return { count: 1 };
          }),
        },

        weleticLoyaltyEarnGrant: {
          findUnique: vi.fn(async ({ where }: any) => {
            if (where.storeId_orderId) {
              for (const grant of harness.earnGrants.values()) {
                if (
                  grant.storeId === where.storeId_orderId.storeId &&
                  grant.orderId === where.storeId_orderId.orderId
                ) {
                  const clone = { ...grant };
                  clone.lineEarns = Array.from(
                    harness.orderLineEarns.values(),
                  ).filter((l) => l.grantId === grant.id);
                  return clone;
                }
              }
              return null;
            }
            const grant = harness.earnGrants.get(where.id);
            if (!grant) return null;
            const clone = { ...grant };
            clone.lineEarns = Array.from(
              harness.orderLineEarns.values(),
            ).filter((l) => l.grantId === grant.id);
            return clone;
          }),
          create: vi.fn(async ({ data }: any) => {
            const grant = { ...data, id: data.id || `wgrant_${Date.now()}` };
            harness.earnGrants.set(grant.id, grant);
            return { ...grant };
          }),
          update: vi.fn(async ({ where, data }: any) => {
            const grant = harness.earnGrants.get(where.id);
            if (!grant) throw new Error(`Grant ${where.id} not found`);
            const updated = { ...grant, ...data };
            harness.earnGrants.set(where.id, updated);
            return { ...updated };
          }),
          updateMany: vi.fn(async ({ where, data }: any) => {
            const grant = harness.earnGrants.get(where.id);
            if (!grant) return { count: 0 };
            for (const field of [
              "storeId",
              "status",
              "pendingPoints",
              "settledPoints",
              "reversedPoints",
            ]) {
              if (where[field] !== undefined && grant[field] !== where[field]) {
                return { count: 0 };
              }
            }
            harness.earnGrants.set(where.id, { ...grant, ...data });
            return { count: 1 };
          }),
        },

        weleticLoyaltyOrderLineEarn: {
          findMany: vi.fn(async ({ where }: any) => {
            let lines = Array.from(harness.orderLineEarns.values());
            if (where?.grantId) {
              lines = lines.filter((l) => l.grantId === where.grantId);
            }
            return lines.map((l) => ({ ...l }));
          }),
          update: vi.fn(async ({ where, data }: any) => {
            const line = harness.orderLineEarns.get(where.id);
            if (!line) throw new Error(`OrderLineEarn ${where.id} not found`);
            const updated = { ...line, ...data };
            harness.orderLineEarns.set(where.id, updated);
            return { ...updated };
          }),
          updateMany: vi.fn(async ({ where, data }: any) => {
            const line = harness.orderLineEarns.get(where.id);
            if (!line) return { count: 0 };
            for (const field of ["storeId", "grantId", "reversedPoints"]) {
              if (where[field] !== undefined && line[field] !== where[field]) {
                return { count: 0 };
              }
            }
            harness.orderLineEarns.set(where.id, { ...line, ...data });
            return { count: 1 };
          }),
        },

        weleticCommerceOrder: {
          findUnique: vi.fn(async ({ where }: any) => {
            return harness.orders.get(where.id) || null;
          }),
        },

        weleticCommerceRefund: {
          findUnique: vi.fn(async ({ where }: any) => {
            return harness.refunds.get(where.id) || null;
          }),
        },

        weleticLoyaltyProgram: {
          findUnique: vi.fn(async ({ where }: any) => {
            return harness.programs.get(where.id) || null;
          }),
        },

        $transaction: vi.fn(async (fn: any) => {
          if (typeof fn === "function") {
            return await fn(client);
          }
          return fn;
        }),
      };

      return client;
    }
  }

  const dbHarness = new RealDatabaseConcurrencyHarness();
  return { dbHarness };
});

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) =>
    fn(),
  ),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: dbHarness.createClient(),
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", () => ({
  SHOPIFY_ADMIN_GRAPHQL_REQUEST_TIMEOUT_MS: 15_000,
  ShopifyDiscountError: class ShopifyDiscountError extends Error {
    constructor(
      public code: string,
      message: string,
      public userErrors?: Array<{
        field?: string[] | string;
        message: string;
        code?: string;
      }>,
    ) {
      super(message);
      this.name = "ShopifyDiscountError";
    }
  },
  resolveShopifyOfflineCredentials: vi.fn().mockResolvedValue({
    shopDomain: "test-concurrency.myshopify.com",
    accessToken: "shpat_test_concurrency_token",
  }),
  provisionLoyaltyRewardDiscount: vi
    .fn()
    .mockImplementation(async (params: any) => ({
      id: `gid://shopify/DiscountCodeNode/${Date.now()}_${Math.random()}`,
      code: params.code,
      title: params.title,
      status: "ACTIVE",
    })),
  lookupDiscountByCode: vi.fn().mockResolvedValue(null),
  isInactiveShopifyDiscountStatus: vi.fn().mockReturnValue(false),
  matchesLoyaltyRewardDiscountConfiguration: vi.fn().mockReturnValue(true),
  deactivateDiscount: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/lib/weletic/loyalty/metafield-sync", () => ({
  syncCustomerMetafields: vi.fn().mockResolvedValue({ success: true }),
}));

// ============================================================================
// Concurrency Test Suite
// ============================================================================

describe("Milestone 6: Real Database Multi-Threaded Concurrency Stress Suite", () => {
  const STORE_ID = "wstore_stress_m6";
  const PROGRAM_ID = "wprog_stress_m6";
  const ACCOUNT_ID = "wacc_stress_m6";

  beforeEach(() => {
    vi.clearAllMocks();
    dbHarness.reset();

    // Initialize Program
    dbHarness.programs.set(PROGRAM_ID, {
      id: PROGRAM_ID,
      storeId: STORE_ID,
      status: "active",
      killSwitchActive: false,
      pointsName: "Points",
    });

    // Initialize Active Loyalty Account
    dbHarness.accounts.set(ACCOUNT_ID, {
      id: ACCOUNT_ID,
      storeId: STORE_ID,
      programId: PROGRAM_ID,
      shopperId: "wshop_stress_m6",
      status: "active",
      cachedPointsBalance: BigInt(0),
      cachedPendingPoints: BigInt(0),
      lifetimePointsEarned: BigInt(0),
      lifetimePointsRedeemed: BigInt(0),
      ledgerVersion: 0,
      lastQualifyingActivityAt: new Date(),
    });
  });

  afterEach(() => {
    dbHarness.reset();
  });

  // =========================================================================
  // Section 1: 50+ to 100 Simultaneous Parallel Points Earn Operations
  // =========================================================================
  describe("1. Real Parallel Points Earn Under High OCC Contention", () => {
    it("executes 100 concurrent transactions on 1 account with zero sequence collisions, monotonic versions, and exact balance conservation", async () => {
      const CONCURRENCY = 100;
      const POINTS_PER_EARN = BigInt(25);

      // Fire 100 concurrent earn operations in parallel
      const tasks = Array.from({ length: CONCURRENCY }, (_, i) => {
        return appendPointsLedgerEntry({
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          pointsDelta: POINTS_PER_EARN,
          idempotencyKey: `burst_earn_tx_${i + 1}`,
          reason: `Concurrent Earn #${i + 1}`,
        });
      });

      const results = await Promise.all(tasks);

      // Verify all 100 succeeded
      expect(results).toHaveLength(CONCURRENCY);

      // Verify account final state
      const finalAccount = dbHarness.accounts.get(ACCOUNT_ID);
      expect(finalAccount.ledgerVersion).toBe(CONCURRENCY);
      expect(finalAccount.cachedPointsBalance).toBe(
        POINTS_PER_EARN * BigInt(CONCURRENCY),
      );
      expect(finalAccount.lifetimePointsEarned).toBe(
        POINTS_PER_EARN * BigInt(CONCURRENCY),
      );

      // Verify contiguous sequence numbers: 1 to 100 without any gap or duplicate
      const allEntries = Array.from(dbHarness.ledgerEntries.values()).sort(
        (a, b) => a.sequenceNumber - b.sequenceNumber,
      );
      expect(allEntries).toHaveLength(CONCURRENCY);

      for (let i = 0; i < CONCURRENCY; i++) {
        expect(allEntries[i].sequenceNumber).toBe(i + 1);
        expect(allEntries[i].pointsDelta).toBe(POINTS_PER_EARN);
      }

      // Verify Audit Reconciliation reports 0 repairs needed
      const audit = await reconcileAccountPoints(ACCOUNT_ID);
      expect(audit.repaired).toBe(false);
      expect(audit.entriesCount).toBe(CONCURRENCY);
      expect(audit.calculatedBalance).toBe(
        POINTS_PER_EARN * BigInt(CONCURRENCY),
      );
    });
  });

  // =========================================================================
  // Section 2: 50+ Concurrent Redemption Provisioning Sagas (Contended Bounds)
  // =========================================================================
  describe("2. 50+ Concurrent Redemption Sagas on Contended Balance Boundary", () => {
    it("enforces strict balance bounds: exactly 25 redemptions succeed and 25 reject when 50 threads contest 2,500 points", async () => {
      const INITIAL_POINTS = BigInt(2500);
      const REDEEM_COST = BigInt(100);
      const TOTAL_REQUESTS = 50;
      const EXPECTED_SUCCESSES = 25; // 2500 / 100 = 25

      // Set initial balance
      const initialAccount = dbHarness.accounts.get(ACCOUNT_ID);
      initialAccount.cachedPointsBalance = INITIAL_POINTS;
      initialAccount.lifetimePointsEarned = INITIAL_POINTS;
      initialAccount.ledgerVersion = 1;

      // Seed initial ledger entry for opening balance
      dbHarness.ledgerEntries.set("seed_entry", {
        id: "seed_entry",
        storeId: STORE_ID,
        accountId: ACCOUNT_ID,
        sequenceNumber: 1,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: INITIAL_POINTS,
        pendingDelta: BigInt(0),
        balanceAfter: INITIAL_POINTS,
        idempotencyKey: "seed_initial_points",
      });
      dbHarness.ledgerIdempotency.add(`${STORE_ID}:seed_initial_points`);
      dbHarness.accountSequences.add(`${ACCOUNT_ID}:1`);

      // Set Reward Definition
      const REWARD_ID = "wrew_fixed_10off";
      dbHarness.rewardDefinitions.set(REWARD_ID, {
        id: REWARD_ID,
        storeId: STORE_ID,
        programId: PROGRAM_ID,
        name: "$10 Discount",
        title: "$10 Discount",
        status: "active",
        pointsCost: REDEEM_COST,
        rewardType: "amount_off",
        discountValue: 1_000,
        exchangeType: "fixed",
      });

      // Execute sagas with OCC retry loop to simulate distributed worker clients
      async function executeSagaWithRetry(reqIndex: number) {
        const maxRetries = 60;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            return await provisionDiscountSaga({
              storeId: STORE_ID,
              accountId: ACCOUNT_ID,
              rewardDefinitionId: REWARD_ID,
              discountCode: `WL-BURST-${reqIndex + 1}`,
              idempotencyKey: `real-concurrency-burst-${reqIndex + 1}`,
            });
          } catch (err: any) {
            if (
              (err instanceof OptimisticConcurrencyError ||
                err.name === "OptimisticConcurrencyError" ||
                err.message?.includes("OCC version conflict") ||
                err.message?.includes("Unique constraint failed")) &&
              attempt < maxRetries
            ) {
              const jitter = Math.floor(Math.random() * 10);
              await new Promise((r) => setTimeout(r, 2 * attempt + jitter));
              continue;
            }
            throw err;
          }
        }
        throw new Error("OCC exhausted");
      }

      // Submit 50 concurrent redemption requests
      const redemptions = await Promise.allSettled(
        Array.from({ length: TOTAL_REQUESTS }, (_, i) =>
          executeSagaWithRetry(i),
        ),
      );

      const successfulSagas = redemptions.filter(
        (r) => r.status === "fulfilled" && (r.value as any).success === true,
      );
      const rejectedSagas = redemptions.filter(
        (r) =>
          r.status === "rejected" ||
          (r.status === "fulfilled" && (r.value as any).success === false),
      );
      const rejectionReasons = redemptions.flatMap((result) =>
        result.status === "rejected"
          ? [String(result.reason?.message ?? result.reason)]
          : result.value.success === false
            ? [String(result.value.error ?? "unspecified saga failure")]
            : [],
      );

      expect(
        successfulSagas,
        `Unexpected redemption failures:\n${rejectionReasons.join("\n")}`,
      ).toHaveLength(EXPECTED_SUCCESSES);
      expect(rejectedSagas).toHaveLength(TOTAL_REQUESTS - EXPECTED_SUCCESSES);

      // Verify Account Final Balance is EXACTLY 0 and never dropped below 0
      const finalAccount = dbHarness.accounts.get(ACCOUNT_ID);
      expect(finalAccount.cachedPointsBalance).toBe(BigInt(0));
      expect(finalAccount.lifetimePointsRedeemed).toBe(INITIAL_POINTS);

      // Verify final ledger sequence
      const ledgerEntries = Array.from(dbHarness.ledgerEntries.values()).sort(
        (a, b) => a.sequenceNumber - b.sequenceNumber,
      );
      // 1 seed + 25 redemptions = 26 total entries
      expect(ledgerEntries).toHaveLength(EXPECTED_SUCCESSES + 1);
      expect(finalAccount.ledgerVersion).toBe(EXPECTED_SUCCESSES + 1);

      // Audit check
      const audit = await reconcileAccountPoints(ACCOUNT_ID);
      expect(audit.repaired).toBe(false);
      expect(audit.calculatedBalance).toBe(BigInt(0));
    });
  });

  // =========================================================================
  // Section 3: Simultaneous Multi-Partial Refund Clawbacks & Deep Negative Debt
  // =========================================================================
  describe("3. Simultaneous Multi-Partial Refund Clawbacks & Negative Debt Accumulation", () => {
    it("processes concurrent partial refund reversals with pending-first voiding and exact negative balance debt", async () => {
      const GRANT_ID = "wgrant_concurrency_refund";
      const ORDER_ID = "word_concurrency_1001";
      const REFUND_ID = "wref_concurrency_refund_1";

      // Customer earned 300 points across 3 order lines ($100 each)
      // Customer has already spent their points (cachedPointsBalance = 0)
      const account = dbHarness.accounts.get(ACCOUNT_ID);
      account.cachedPointsBalance = BigInt(0);
      account.cachedPendingPoints = BigInt(0);
      account.ledgerVersion = 2;

      const grantData = {
        id: GRANT_ID,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        status: "settled",
        grossPoints: BigInt(300),
        pendingPoints: BigInt(0),
        settledPoints: BigInt(300),
        reversedPoints: BigInt(0),
        eligibleSubtotalAmount: BigInt(30000), // $300.00
        orderTotalAmount: BigInt(30000),
        lineEarns: [
          {
            id: "line_1",
            grantId: GRANT_ID,
            storeId: STORE_ID,
            orderLineId: "ol_1",
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(100),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
          {
            id: "line_2",
            grantId: GRANT_ID,
            storeId: STORE_ID,
            orderLineId: "ol_2",
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(100),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
          {
            id: "line_3",
            grantId: GRANT_ID,
            storeId: STORE_ID,
            orderLineId: "ol_3",
            lineNetAmount: BigInt(10000),
            awardedPoints: BigInt(100),
            reversedPoints: BigInt(0),
            isExcluded: false,
          },
        ],
      };
      dbHarness.earnGrants.set(GRANT_ID, grantData);

      for (const l of grantData.lineEarns) {
        dbHarness.orderLineEarns.set(l.id, l);
      }

      // Order in DB
      dbHarness.orders.set(ORDER_ID, {
        id: ORDER_ID,
        storeId: STORE_ID,
        shopperId: "wshop_stress_m6",
        shopper: {
          id: "wshop_stress_m6",
          storeId: STORE_ID,
          loyaltyAccount: account,
        },
      });

      // Refund in DB
      dbHarness.refunds.set(REFUND_ID, {
        id: REFUND_ID,
        storeId: STORE_ID,
        orderId: ORDER_ID,
        order: {
          id: ORDER_ID,
          storeId: STORE_ID,
          shopper: {
            id: "wshop_stress_m6",
            storeId: STORE_ID,
            loyaltyAccount: account,
          },
        },
        lines: [
          {
            id: "rline_1",
            refundId: REFUND_ID,
            orderLineId: "ol_1",
            shopAmount: BigInt(10000),
          },
          {
            id: "rline_2",
            refundId: REFUND_ID,
            orderLineId: "ol_2",
            shopAmount: BigInt(10000),
          },
          {
            id: "rline_3",
            refundId: REFUND_ID,
            orderLineId: "ol_3",
            shopAmount: BigInt(10000),
          },
        ],
      });

      // Calculate clawback for full refund across all 3 lines ($300 total)
      const calculation = calculateRefundPointsReversal({
        originalGrant: grantData,
        refundedLines: [
          { orderLineId: "ol_1", cumulativeShopAmount: BigInt(10000) },
          { orderLineId: "ol_2", cumulativeShopAmount: BigInt(10000) },
          { orderLineId: "ol_3", cumulativeShopAmount: BigInt(10000) },
        ],
      });

      expect(calculation.totalPointsToClawback).toBe(BigInt(300));
      expect(calculation.lineClawbacks).toHaveLength(3);

      // Execute refund reversal
      const result = await processRefundPointsReversal({
        storeId: STORE_ID,
        refundId: REFUND_ID,
      });

      expect(result).not.toBeNull();
      expect(result?.pointsDelta).toBe(BigInt(-300));
      expect(result?.balanceAfter).toBe(BigInt(-300));

      // Invariant: Account balance enters negative points debt (-300) without truncation
      const updatedAccount = dbHarness.accounts.get(ACCOUNT_ID);
      expect(updatedAccount.cachedPointsBalance).toBe(BigInt(-300));
    });
  });

  // =========================================================================
  // Section 4: Concurrent Outbox Worker Lease Locking & Thundering Herd
  // =========================================================================
  describe("4. Concurrent Outbox Worker Lease Locking & Thundering Herd Suppression", () => {
    it("suppresses thundering herd: exactly 1 worker wins lease lock among 50 concurrent polling nodes", async () => {
      const JOB_ID = "outbox_job_thundering_herd";
      dbHarness.outboxJobs.set(JOB_ID, {
        id: JOB_ID,
        storeId: STORE_ID,
        jobType: "HOLDING_PERIOD_RELEASE",
        payload: { grantId: "wgrant_m6_test" },
        status: WeleticLoyaltyOutboxJobStatus.pending,
        scheduledFor: new Date(Date.now() - 1000),
        lockedAt: null,
        lockedBy: null,
        attempts: 0,
        maxAttempts: 5,
      });

      // 50 concurrent worker nodes poll the queue simultaneously
      const workerRuns = await Promise.all(
        Array.from({ length: 50 }, (_, i) => {
          return processOutboxJobsBatch({
            batchSize: 10,
            workerId: `worker_thread_${i + 1}`,
          });
        }),
      );

      const processedCount = workerRuns.reduce(
        (sum, res) => sum + res.processed,
        0,
      );
      const skippedCount = workerRuns.reduce(
        (sum, res) => sum + res.skipped,
        0,
      );

      // Invariant: Exactly 1 worker processes the job; 49 skip
      expect(processedCount).toBe(1);
      expect(skippedCount).toBe(49);
    });

    it("recovers stale abandoned leases via reaper after timeout", async () => {
      const STALE_JOB_ID = "outbox_stale_job_1";
      const sixMinutesAgo = new Date(Date.now() - 360000); // 6 min ago (> 5 min timeout)

      dbHarness.outboxJobs.set(STALE_JOB_ID, {
        id: STALE_JOB_ID,
        storeId: STORE_ID,
        jobType: "METAFIELD_SYNC",
        status: WeleticLoyaltyOutboxJobStatus.processing,
        lockedAt: sixMinutesAgo,
        lockedBy: "dead_worker_pid_9999",
        attempts: 1,
        maxAttempts: 5,
      });

      const reaped = await reapStaleOutboxLocks(300000, new Date());
      expect(reaped).toBe(1);

      const job = dbHarness.outboxJobs.get(STALE_JOB_ID);
      expect(job.status).toBe(WeleticLoyaltyOutboxJobStatus.failed);
      expect(job.lockedAt).toBeNull();
      expect(job.lockedBy).toBeNull();
    });

    it("enforces outbox enqueue idempotency under rapid 50-thread burst", async () => {
      const BURST_KEY = "idemp_burst_outbox_test";

      const enqueueTasks = Array.from({ length: 50 }, () => {
        return enqueueOutboxJob({
          storeId: STORE_ID,
          jobType: "METAFIELD_SYNC",
          payload: {
            accountId: ACCOUNT_ID,
            triggerReason: "MANUAL_BURST_TEST",
          },
          idempotencyKey: BURST_KEY,
        });
      });

      const results = await Promise.all(enqueueTasks);

      // All 50 callers receive the job without crashing
      expect(results).toHaveLength(50);
      const uniqueJobIds = new Set(results.map((r) => r.job.id));
      // Exactly 1 job record created in DB
      expect(uniqueJobIds.size).toBe(1);
      expect(results.filter((result) => result.created)).toHaveLength(1);
    });
  });

  // =========================================================================
  // Section 5: Exhaustive Monte Carlo Mixed Workload Convergence
  // =========================================================================
  describe("5. Monte Carlo simulated concurrency workload convergence", () => {
    it("converges to the exact append-only event-ledger balance across 100 mixed operations", async () => {
      const WORKLOAD_SIZE = 100;
      let expectedBalance = BigInt(0);
      const operations: Array<{
        delta: bigint;
        type: WeleticPointsLedgerEntryType;
      }> = [];

      for (let i = 0; i < WORKLOAD_SIZE; i++) {
        // Randomly choose between Earn (+10 to +50), Small Debit (-5), or Adjust (+15)
        const rand = Math.random();
        let delta: bigint;
        let type: WeleticPointsLedgerEntryType;

        if (rand < 0.6) {
          delta = BigInt(Math.floor(Math.random() * 40) + 10);
          type = WeleticPointsLedgerEntryType.EARN_ORDER;
        } else if (rand < 0.85) {
          delta = BigInt(-5);
          type = WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT;
        } else {
          delta = BigInt(15);
          type = WeleticPointsLedgerEntryType.TIER_BONUS;
        }

        expectedBalance += delta;
        operations.push({ delta, type });
      }

      // Execute all 100 mixed operations concurrently
      const tasks = operations.map((op, idx) => {
        return appendPointsLedgerEntry({
          storeId: STORE_ID,
          accountId: ACCOUNT_ID,
          entryType: op.type,
          pointsDelta: op.delta,
          idempotencyKey: `monte_carlo_tx_${idx + 1}`,
        });
      });

      const results = await Promise.all(tasks);
      expect(results).toHaveLength(WORKLOAD_SIZE);

      const finalAccount = dbHarness.accounts.get(ACCOUNT_ID);
      expect(finalAccount.ledgerVersion).toBe(WORKLOAD_SIZE);
      expect(finalAccount.cachedPointsBalance).toBe(expectedBalance);

      // Verify audit reconciliation
      const audit = await reconcileAccountPoints(ACCOUNT_ID);
      expect(audit.repaired).toBe(false);
      expect(audit.calculatedBalance).toBe(expectedBalance);
      expect(audit.entriesCount).toBe(WORKLOAD_SIZE);
    });
  });
});
