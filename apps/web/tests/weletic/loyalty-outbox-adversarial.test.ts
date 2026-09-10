import { prisma } from "@/lib/prisma";
import { retainExpiryDeliveryRequest } from "@/lib/weletic/loyalty/expiry-delivery-snapshot";
import { syncCustomerMetafields } from "@/lib/weletic/loyalty/metafield-sync";
import {
  HoldingPeriodReleasePayload,
  calculateExponentialBackoff,
  enqueueOutboxJob,
  processOutboxJobsBatch,
  reapStaleOutboxLocks,
  validateOutboxPayload,
} from "@/lib/weletic/loyalty/outbox";
import { executeOutboxJob } from "@/lib/weletic/loyalty/outbox-worker";
import { sendPointsExpiryNotification } from "@/lib/weletic/loyalty/points-expiry-notifications";
import { auditStoreLedgers } from "@/lib/weletic/loyalty/reconciliation";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import {
  Prisma,
  WeleticLoyaltyAccountStatus,
  WeleticLoyaltyOutboxJob,
  WeleticLoyaltyOutboxJobStatus,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateLedgerVersions } from "../../scripts/loyalty/migrate-ledger-version";

// ============================================================================
// Mock Setup
// ============================================================================
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findFirst: vi.fn().mockResolvedValue({
        status: "active",
        shopper: { shopifyCustomerId: "customer_adversarial" },
        store: { projectId: "workspace_adversarial" },
      }),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
      create: vi.fn(),
    },
    weleticRewardRedemption: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/weletic/loyalty/metafield-sync", () => ({
  syncCustomerMetafields: vi.fn(),
}));
vi.mock("@/lib/weletic/loyalty/points-expiry-notifications", () => ({
  sendPointsExpiryNotification: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: vi.fn(
    async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
  ),
}));

const TEST_STORE_A = "wstore_adv_tenant_a";
const TEST_STORE_B = "wstore_adv_tenant_b";
const TEST_ACCOUNT_A = "wlacc_adv_a";
const TEST_ACCOUNT_B = "wlacc_adv_b";

describe("Milestone 2: Outbox Subsystem Adversarial Stress & Resilience Verification", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticLoyaltyOutboxJob.findFirst).mockReset();
    vi.mocked(prisma.weleticLoyaltyOutboxJob.findFirst).mockResolvedValue(
      undefined as any,
    );
    vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockReset();
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      installationGeneration: null,
    } as any);
    vi.mocked(prisma.$transaction).mockImplementation((async (fns: any) => {
      if (Array.isArray(fns)) {
        return Promise.all(fns);
      }
      if (typeof fns === "function") {
        return fns(prisma);
      }
      return fns;
    }) as any);
  });

  // =========================================================================
  // Section 1: Concurrent Lease Lock Race Conditions (Thundering Herd)
  // =========================================================================
  describe("Section 1: Concurrent Lease Lock Race Conditions", () => {
    it("1.1: 50 concurrent worker threads competing for the same pending job result in exactly 1 lock winner and 49 skips", async () => {
      const targetJob: WeleticLoyaltyOutboxJob = {
        id: "woutbox_race_candidate_1",
        storeId: TEST_STORE_A,
        jobType: "METAFIELD_SYNC",
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          accountId: TEST_ACCOUNT_A,
          triggerReason: "race_test",
        },
        idempotencyKey: "race_key_1",
        scheduledFor: new Date(Date.now() - 5000),
        nextRetryAt: null,
        attempts: 0,
        maxAttempts: 5,
        priority: 10,
        lockedAt: null,
        lockedBy: null,
        processedAt: null,
        completedAt: null,
        lastError: null,
        errorLog: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Candidate polling sees the pending row; the separate stale-lock query
      // must not return that row merely because this focused mock ignores SQL.
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockImplementation(
        (async ({ where }: any) =>
          where?.status === WeleticLoyaltyOutboxJobStatus.processing
            ? []
            : [targetJob]) as any,
      );
      vi.mocked(prisma.weleticLoyaltyOutboxJob.update).mockResolvedValue(
        targetJob,
      );

      // Simulate atomic optimistic locking: ONLY the first caller gets count: 1, remaining 49 get count: 0
      let lockAcquiredCount = 0;
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mockImplementation(
        (async (args: any) => {
          // Check if this is the stale lock reaper.
          if (args?.where?.lockedAt?.lt) {
            return { count: 0 } as any;
          }
          // The winning worker may finalize only while it still owns the lease.
          if (args?.where?.lockedBy) {
            return { count: 1 } as any;
          }
          // Lease lock acquisition
          if (lockAcquiredCount === 0) {
            lockAcquiredCount++;
            return { count: 1 } as any;
          }
          return { count: 0 } as any;
        }) as any,
      );

      // Isolate the lease race from the Redis-backed domain handler.
      const syncMock = vi.mocked(syncCustomerMetafields).mockResolvedValue({
        success: true,
        shopifyCustomerId: "gid://shopify/Customer/1",
        syncedKeys: ["points"],
        metafieldsCount: 1,
        metafields: [],
      });

      // Launch 50 concurrent worker batches
      const workerPromises = Array.from({ length: 50 }, (_, i) =>
        processOutboxJobsBatch({
          workerId: `worker_node_${i}`,
          batchSize: 10,
        }),
      );

      const results = await Promise.all(workerPromises);

      const totalProcessed = results.reduce((acc, r) => acc + r.processed, 0);
      const totalSucceeded = results.reduce((acc, r) => acc + r.succeeded, 0);
      const totalSkipped = results.reduce((acc, r) => acc + r.skipped, 0);

      expect(totalProcessed).toBe(1);
      expect(totalSucceeded).toBe(1);
      expect(totalSkipped).toBe(49);
      expect(syncMock).toHaveBeenCalledTimes(1);
    });

    it("1.2: Atomic lock acquisition respects lockedAt condition to prevent stealing active jobs", async () => {
      // Candidate search returns 0 jobs because status is processing
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValue([]);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mockResolvedValue({
        count: 0,
      });

      const summary = await processOutboxJobsBatch({
        workerId: "worker_intruder",
        batchSize: 10,
      });

      expect(summary.processed).toBe(0);
      expect(summary.succeeded).toBe(0);
      expect(summary.skipped).toBe(0);
    });
  });

  // =========================================================================
  // Section 2: Worker Crash Recovery via Stale Lock Reaper
  // =========================================================================
  describe("Section 2: Worker Crash Recovery via Stale Lock Reaper", () => {
    it("2.1: Reaps abandoned locks older than lockTimeoutMs and makes them eligible immediately", async () => {
      const now = new Date("2026-08-26T12:00:00Z");
      const lockTimeoutMs = 300000; // 5 minutes

      vi.mocked(
        prisma.weleticLoyaltyOutboxJob.updateMany,
      ).mockResolvedValueOnce({
        count: 4,
      });

      const reapedCount = await reapStaleOutboxLocks(lockTimeoutMs, now);

      expect(reapedCount).toBe(4);
      expect(prisma.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledWith({
        where: {
          status: WeleticLoyaltyOutboxJobStatus.processing,
          lockedAt: { lt: new Date("2026-08-26T11:55:00.000Z") },
        },
        data: {
          status: WeleticLoyaltyOutboxJobStatus.failed,
          lockedAt: null,
          lockedBy: null,
          lastError: "Lease lock expired / worker timeout reaped",
          nextRetryAt: now,
        },
      });
    });

    it("2.2: Preserves active in-flight worker leases under high concurrency", async () => {
      const now = new Date("2026-08-26T12:00:00Z");
      const lockTimeoutMs = 300000;

      // When no jobs exceed the 5-minute threshold, 0 jobs are reaped
      vi.mocked(
        prisma.weleticLoyaltyOutboxJob.updateMany,
      ).mockResolvedValueOnce({
        count: 0,
      });

      const reapedCount = await reapStaleOutboxLocks(lockTimeoutMs, now);
      expect(reapedCount).toBe(0);
    });
  });

  // =========================================================================
  // Section 2B: Current-Row Claim Generation Fences
  // =========================================================================
  describe("Section 2B: Current-Row Claim Generation Fences", () => {
    const fixedNow = new Date("2026-08-26T12:00:00.000Z");

    function makeMetafieldJob(
      overrides: Partial<WeleticLoyaltyOutboxJob> = {},
    ): WeleticLoyaltyOutboxJob {
      return {
        id: "woutbox_claim_fence",
        storeId: TEST_STORE_A,
        jobType: "METAFIELD_SYNC",
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          accountId: TEST_ACCOUNT_A,
          triggerReason: "claim_fence",
        },
        idempotencyKey: "claim_fence:key",
        scheduledFor: new Date("2026-08-26T11:55:00.000Z"),
        nextRetryAt: null,
        attempts: 0,
        maxAttempts: 5,
        priority: 10,
        lockedAt: null,
        lockedBy: null,
        processedAt: null,
        completedAt: null,
        lastError: null,
        errorLog: [],
        createdAt: new Date("2026-08-26T11:50:00.000Z"),
        updatedAt: new Date("2026-08-26T11:50:00.000Z"),
        ...overrides,
      };
    }

    function mockCandidatePoll(candidates: WeleticLoyaltyOutboxJob[]) {
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockImplementation(
        (async ({ where }: any) =>
          where?.status === WeleticLoyaltyOutboxJobStatus.processing
            ? []
            : candidates) as any,
      );
    }

    function mockSuccessfulMetafieldSync() {
      vi.mocked(syncCustomerMetafields).mockResolvedValue({
        success: true,
        shopifyCustomerId: "gid://shopify/Customer/claim-fence",
        syncedKeys: ["points"],
        metafieldsCount: 1,
        metafields: [],
      });
    }

    it.each([false, true])(
      "preserves the encrypted payload in worker completion/retry CAS (failure=%s)",
      async (fail) => {
        vi.stubEnv("ENCRYPTION_KEY", "test-only-worker-envelope-key");
        let row = makeMetafieldJob({
          jobType: "INACTIVITY_EXPIRY",
          payload: {
            accountId: TEST_ACCOUNT_A,
            stage: "warning",
            installationGeneration: null,
          },
        });
        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
          id: TEST_ACCOUNT_A,
          status: "active",
          metadata: null,
          shopper: { shopifyCustomerId: "customer_adversarial" },
          store: { projectId: "workspace_adversarial" },
        } as any);
        mockCandidatePoll([structuredClone(row)]);
        vi.mocked(prisma.weleticLoyaltyOutboxJob.findFirst).mockImplementation(
          (async ({ where }: any) => {
            if (Array.isArray(where?.status?.in)) return structuredClone(row);
            if (
              where.lockedBy !== row.lockedBy ||
              where.attempts !== row.attempts ||
              JSON.stringify(where.payload?.equals) !==
                JSON.stringify(row.payload)
            )
              return null;
            return structuredClone(row);
          }) as any,
        );
        vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mockImplementation(
          (async ({ where, data }: any) => {
            if (
              JSON.stringify(where.payload?.equals) !==
              JSON.stringify(row.payload)
            )
              return { count: 0 };
            if (
              where.lockedBy !== row.lockedBy ||
              where.attempts !== row.attempts
            )
              return { count: 0 };
            row = {
              ...row,
              ...data,
              attempts:
                typeof data.attempts === "object"
                  ? row.attempts + data.attempts.increment
                  : data.attempts ?? row.attempts,
            };
            return { count: 1 };
          }) as any,
        );
        vi.mocked(sendPointsExpiryNotification).mockImplementationOnce(
          async ({ deliveryClaim }) => {
            expect(deliveryClaim).toBeDefined();
            await retainExpiryDeliveryRequest({
              claim: deliveryClaim!,
              accountId: TEST_ACCOUNT_A,
              expectedInstallationGeneration: null,
              recipientEmail: "synthetic@example.com",
              idempotencyKey: `loyalty-expiry-job-${row.id}`,
              prepare: async () => ({
                to: "synthetic@example.com",
                from: "test@example.com",
                subject: "Saved",
                html: "<p>Saved</p>",
              }),
            });
            expect(row.payload).toHaveProperty("expiryDeliverySnapshot");
            if (fail) throw new Error("Synthetic ambiguous provider response");
            return "sent";
          },
        );
        const result = await processOutboxJobsBatch({
          batchSize: 1,
          workerId: "snapshot-worker",
          now: fixedNow,
        });
        expect(result).toMatchObject({
          processed: 1,
          succeeded: fail ? 0 : 1,
          failed: fail ? 1 : 0,
          skipped: 0,
        });
        expect(row.status).toBe(fail ? "failed" : "completed");
        expect(row.payload).toHaveProperty("expiryDeliverySnapshot");
        expect(row.lockedBy).toBeNull();
      },
    );

    it("holds the customer settlement lock across the remote metafield mutation", async () => {
      let lockHeld = false;
      let signalSyncStarted!: () => void;
      let releaseSync!: () => void;
      const syncStarted = new Promise<void>((resolve) => {
        signalSyncStarted = resolve;
      });
      const syncGate = new Promise<void>((resolve) => {
        releaseSync = resolve;
      });
      vi.mocked(withShopifyCustomerSettlementLocks).mockImplementationOnce(
        async ({ fn }) => {
          lockHeld = true;
          try {
            return await fn();
          } finally {
            lockHeld = false;
          }
        },
      );
      vi.mocked(syncCustomerMetafields).mockImplementationOnce(async () => {
        expect(lockHeld).toBe(true);
        signalSyncStarted();
        await syncGate;
        expect(lockHeld).toBe(true);
        return {
          success: true,
          shopifyCustomerId: "gid://shopify/Customer/claim-fence",
          syncedKeys: ["points"],
          metafieldsCount: 1,
          metafields: [],
        };
      });

      const execution = executeOutboxJob(makeMetafieldJob());
      await syncStarted;
      expect(lockHeld).toBe(true);
      releaseSync();
      await execution;

      expect(lockHeld).toBe(false);
      expect(withShopifyCustomerSettlementLocks).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: TEST_STORE_A,
          shopifyCustomerId: "customer_adversarial",
        }),
      );
      expect(syncCustomerMetafields).toHaveBeenCalledOnce();
    });

    it("executes the current eligible payload instead of the stale polled payload", async () => {
      const staleCandidate = makeMetafieldJob({
        payload: {
          accountId: "wlacc_stale_payload",
          triggerReason: "stale_poll",
        },
      });
      const currentCandidate = makeMetafieldJob({
        payload: {
          accountId: "wlacc_current_payload",
          triggerReason: "current_row",
        },
        updatedAt: new Date("2026-08-26T11:59:00.000Z"),
      });
      let currentClaim: WeleticLoyaltyOutboxJob | null = null;

      mockCandidatePoll([staleCandidate]);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findFirst).mockImplementation(
        (async ({ where }: any) => {
          if (Array.isArray(where?.status?.in)) return currentCandidate;
          if (
            currentClaim?.status === WeleticLoyaltyOutboxJobStatus.processing &&
            where?.lockedBy === currentClaim.lockedBy &&
            where?.attempts === currentClaim.attempts
          ) {
            return currentClaim;
          }
          return null;
        }) as any,
      );
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mockImplementation(
        (async ({ where, data }: any) => {
          if (data?.status === WeleticLoyaltyOutboxJobStatus.processing) {
            expect(where.payload.equals).toEqual(currentCandidate.payload);
            currentClaim = {
              ...currentCandidate,
              status: WeleticLoyaltyOutboxJobStatus.processing,
              lockedAt: data.lockedAt,
              lockedBy: data.lockedBy,
              attempts: currentCandidate.attempts + 1,
            };
            return { count: 1 };
          }
          if (
            data?.status === WeleticLoyaltyOutboxJobStatus.completed &&
            currentClaim &&
            where?.lockedBy === currentClaim.lockedBy
          ) {
            currentClaim = {
              ...currentClaim,
              ...data,
            };
            return { count: 1 };
          }
          return { count: 0 };
        }) as any,
      );
      mockSuccessfulMetafieldSync();

      const summary = await processOutboxJobsBatch({
        batchSize: 1,
        workerId: "claim-fence-worker",
        now: fixedNow,
      });

      expect(summary).toMatchObject({
        processed: 1,
        succeeded: 1,
        failed: 0,
        deadLettered: 0,
        skipped: 0,
      });
      expect(syncCustomerMetafields).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "wlacc_current_payload" }),
      );
      expect(syncCustomerMetafields).not.toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "wlacc_stale_payload" }),
      );
    });

    it.each([
      {
        mutation: "privacy cancellation",
        current: makeMetafieldJob({
          status: WeleticLoyaltyOutboxJobStatus.completed,
          completedAt: new Date("2026-08-26T11:59:00.000Z"),
          updatedAt: new Date("2026-08-26T11:59:00.000Z"),
        }),
      },
      {
        mutation: "future reschedule",
        current: makeMetafieldJob({
          scheduledFor: new Date("2026-08-26T12:05:00.000Z"),
          updatedAt: new Date("2026-08-26T11:59:00.000Z"),
        }),
      },
      {
        mutation: "future retry deferral",
        current: makeMetafieldJob({
          status: WeleticLoyaltyOutboxJobStatus.failed,
          nextRetryAt: new Date("2026-08-26T12:05:00.000Z"),
          updatedAt: new Date("2026-08-26T11:59:00.000Z"),
        }),
      },
    ])(
      "skips an old poll after a $mutation makes the current row ineligible",
      async ({ current }) => {
        const staleCandidate = makeMetafieldJob();
        mockCandidatePoll([staleCandidate]);
        vi.mocked(prisma.weleticLoyaltyOutboxJob.findFirst).mockImplementation(
          (async () => {
            const statusEligible: boolean = [
              WeleticLoyaltyOutboxJobStatus.pending,
              WeleticLoyaltyOutboxJobStatus.failed,
            ].some((status) => status === current.status);
            const scheduleEligible = current.scheduledFor <= fixedNow;
            const retryEligible =
              current.nextRetryAt === null || current.nextRetryAt <= fixedNow;
            return statusEligible && scheduleEligible && retryEligible
              ? current
              : null;
          }) as any,
        );

        const summary = await processOutboxJobsBatch({
          batchSize: 1,
          workerId: "claim-fence-worker",
          now: fixedNow,
        });

        expect(summary).toMatchObject({
          processed: 0,
          succeeded: 0,
          failed: 0,
          deadLettered: 0,
          skipped: 1,
        });
        expect(syncCustomerMetafields).not.toHaveBeenCalled();
        expect(
          prisma.weleticLoyaltyOutboxJob.updateMany,
        ).not.toHaveBeenCalled();
      },
    );

    it("uses a distinct owner token for every claim even with the same workerId and clock", async () => {
      const candidates = [
        makeMetafieldJob({ id: "woutbox_claim_generation_1" }),
        makeMetafieldJob({ id: "woutbox_claim_generation_2" }),
      ];
      const rows = new Map(
        candidates.map((candidate) => [candidate.id, candidate]),
      );
      const ownerTokens: string[] = [];

      mockCandidatePoll(candidates);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findFirst).mockImplementation(
        (async ({ where }: any) => {
          const row = rows.get(where.id);
          if (!row) return null;
          if (Array.isArray(where?.status?.in)) return row;
          return row.status === WeleticLoyaltyOutboxJobStatus.processing &&
            row.lockedBy === where.lockedBy &&
            row.attempts === where.attempts
            ? row
            : null;
        }) as any,
      );
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mockImplementation(
        (async ({ where, data }: any) => {
          const row = rows.get(where.id);
          if (!row) return { count: 0 };
          if (data?.status === WeleticLoyaltyOutboxJobStatus.processing) {
            ownerTokens.push(data.lockedBy);
            rows.set(row.id, {
              ...row,
              status: WeleticLoyaltyOutboxJobStatus.processing,
              lockedAt: data.lockedAt,
              lockedBy: data.lockedBy,
              attempts: row.attempts + 1,
            });
            return { count: 1 };
          }
          if (
            data?.status === WeleticLoyaltyOutboxJobStatus.completed &&
            row.lockedBy === where.lockedBy
          ) {
            rows.set(row.id, { ...row, ...data });
            return { count: 1 };
          }
          return { count: 0 };
        }) as any,
      );
      mockSuccessfulMetafieldSync();

      const summary = await processOutboxJobsBatch({
        batchSize: 2,
        workerId: "shared-worker",
        now: fixedNow,
      });

      expect(summary.succeeded).toBe(2);
      expect(ownerTokens).toHaveLength(2);
      expect(new Set(ownerTokens).size).toBe(2);
      expect(ownerTokens).toEqual([
        expect.stringMatching(/^shared-worker:wlease_/),
        expect.stringMatching(/^shared-worker:wlease_/),
      ]);
    });

    it.each([
      { transition: "completion", attempts: 0, outcome: "success" },
      { transition: "retry", attempts: 0, outcome: "failure" },
      { transition: "dead-letter", attempts: 4, outcome: "failure" },
    ])(
      "prevents stale claim A from committing a $transition after claim B takes ownership",
      async ({ attempts, outcome }) => {
        const candidate = makeMetafieldJob({ attempts, maxAttempts: 5 });
        let row = candidate;
        let claimAOwner = "";
        let settleHandler!: (value: {
          success: true;
          shopifyCustomerId: string;
          syncedKeys: string[];
          metafieldsCount: number;
          metafields: never[];
        }) => void;
        let rejectHandler!: (error: Error) => void;
        const handlerGate = new Promise<any>((resolve, reject) => {
          settleHandler = resolve;
          rejectHandler = reject;
        });

        mockCandidatePoll([candidate]);
        vi.mocked(prisma.weleticLoyaltyOutboxJob.findFirst).mockImplementation(
          (async ({ where }: any) => {
            if (Array.isArray(where?.status?.in)) return row;
            return row.status === WeleticLoyaltyOutboxJobStatus.processing &&
              row.lockedBy === where.lockedBy &&
              row.attempts === where.attempts
              ? row
              : null;
          }) as any,
        );
        vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mockImplementation(
          (async ({ data }: any) => {
            if (data?.status !== WeleticLoyaltyOutboxJobStatus.processing) {
              return { count: 0 };
            }
            claimAOwner = data.lockedBy;
            row = {
              ...row,
              status: WeleticLoyaltyOutboxJobStatus.processing,
              lockedAt: data.lockedAt,
              lockedBy: data.lockedBy,
              attempts: row.attempts + 1,
            };
            return { count: 1 };
          }) as any,
        );
        vi.mocked(syncCustomerMetafields).mockImplementationOnce(
          () => handlerGate,
        );

        const batchPromise = processOutboxJobsBatch({
          batchSize: 1,
          workerId: "shared-worker",
          now: fixedNow,
        });
        await vi.waitFor(() =>
          expect(syncCustomerMetafields).toHaveBeenCalledTimes(1),
        );

        const claimBOwner = "shared-worker:wlease_newer_claim_B";
        row = {
          ...row,
          lockedAt: new Date("2026-08-26T12:00:01.000Z"),
          lockedBy: claimBOwner,
          attempts: row.attempts + 1,
          updatedAt: new Date("2026-08-26T12:00:01.000Z"),
        };
        if (outcome === "success") {
          settleHandler({
            success: true,
            shopifyCustomerId: "gid://shopify/Customer/claim-fence",
            syncedKeys: ["points"],
            metafieldsCount: 1,
            metafields: [],
          });
        } else {
          rejectHandler(new Error("simulated handler failure"));
        }

        const summary = await batchPromise;

        expect(claimAOwner).not.toBe(claimBOwner);
        expect(row.lockedBy).toBe(claimBOwner);
        expect(summary).toMatchObject({
          processed: 1,
          succeeded: 0,
          failed: 0,
          deadLettered: 0,
          skipped: 1,
        });
        expect(summary.jobs).toEqual([]);
        expect(prisma.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledTimes(
          1,
        );
      },
    );

    it("does not let a stale reaper snapshot reset a newer claim token", async () => {
      const staleSnapshot = makeMetafieldJob({
        status: WeleticLoyaltyOutboxJobStatus.processing,
        attempts: 1,
        lockedAt: new Date("2026-08-26T11:50:00.000Z"),
        lockedBy: "shared-worker:wlease_stale_claim_A",
      });
      const newerClaim = {
        ...staleSnapshot,
        attempts: 2,
        lockedAt: new Date("2026-08-26T11:59:00.000Z"),
        lockedBy: "shared-worker:wlease_newer_claim_B",
        updatedAt: new Date("2026-08-26T11:59:00.000Z"),
      };

      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValue([
        staleSnapshot,
      ]);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findFirst).mockImplementation(
        (async ({ where }: any) =>
          where.lockedBy === newerClaim.lockedBy &&
          where.attempts === newerClaim.attempts &&
          where.updatedAt?.getTime() === newerClaim.updatedAt.getTime()
            ? newerClaim
            : null) as any,
      );

      const reaped = await reapStaleOutboxLocks(300_000, fixedNow);

      expect(reaped).toBe(0);
      expect(prisma.weleticLoyaltyOutboxJob.findFirst).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: staleSnapshot.id,
          lockedBy: staleSnapshot.lockedBy,
          attempts: staleSnapshot.attempts,
          updatedAt: staleSnapshot.updatedAt,
        }),
      });
      expect(prisma.weleticLoyaltyOutboxJob.updateMany).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Section 3: Exponential Backoff with Full Jitter Mathematical Bounds
  // =========================================================================
  describe("Section 3: Exponential Backoff & Jitter Verification", () => {
    it("3.1: Enforces mathematical bounds across 1,000 Monte Carlo simulations", () => {
      const baseDelay = 2000;
      const maxDelay = 3600000;

      // Test attempts 1 through 10
      for (let attempt = 1; attempt <= 10; attempt++) {
        const expectedBase = Math.min(
          baseDelay * Math.pow(2, attempt - 1),
          maxDelay,
        );

        for (let sim = 0; sim < 100; sim++) {
          const delay = calculateExponentialBackoff(
            attempt,
            baseDelay,
            maxDelay,
          );

          // Delay must be strictly in [expectedBase, expectedBase + 1000]
          expect(delay).toBeGreaterThanOrEqual(expectedBase);
          expect(delay).toBeLessThanOrEqual(expectedBase + 1000);
        }
      }
    });

    it("3.2: Handles extreme boundary inputs (attempt <= 0, attempt = 100) safely without overflow", () => {
      const zeroAttemptDelay = calculateExponentialBackoff(0, 2000, 3600000);
      expect(zeroAttemptDelay).toBe(2000);

      const negativeAttemptDelay = calculateExponentialBackoff(
        -5,
        2000,
        3600000,
      );
      expect(negativeAttemptDelay).toBe(2000);

      // Attempt 100 should cap cleanly at maxDelay + 1000 without returning Infinity or NaN
      const hugeAttemptDelay = calculateExponentialBackoff(100, 2000, 3600000);
      expect(Number.isFinite(hugeAttemptDelay)).toBe(true);
      expect(hugeAttemptDelay).toBeGreaterThanOrEqual(3600000);
      expect(hugeAttemptDelay).toBeLessThanOrEqual(3600000 + 1000);
    });

    it("3.3: Verifies jitter produces non-deterministic distribution", () => {
      const samples = new Set<number>();
      for (let i = 0; i < 50; i++) {
        samples.add(calculateExponentialBackoff(1, 2000, 3600000));
      }
      // Out of 50 samples with [0, 1000) jitter, we expect multiple distinct values
      expect(samples.size).toBeGreaterThan(10);
    });
  });

  // =========================================================================
  // Section 4: Idempotency Deduplication Under Rapid Concurrent Bursts
  // =========================================================================
  describe("Section 4: Idempotency Deduplication Under Rapid Concurrent Bursts", () => {
    it("4.1: Concurrent enqueueing with identical idempotencyKey catches P2002 and returns original job", async () => {
      const idempotencyKey = "dedup_burst_key_101";
      const existingJob: WeleticLoyaltyOutboxJob = {
        id: "woutbox_first_created",
        storeId: TEST_STORE_A,
        jobType: "HOLDING_PERIOD_RELEASE",
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          orderId: "ord_101",
          accountId: TEST_ACCOUNT_A,
          shopperId: "shop_101",
          pendingPoints: "200",
          holdingPeriodDays: 14,
          availableAt: new Date().toISOString(),
        },
        idempotencyKey,
        scheduledFor: new Date(),
        nextRetryAt: null,
        attempts: 0,
        maxAttempts: 5,
        priority: 0,
        lockedAt: null,
        lockedBy: null,
        processedAt: null,
        completedAt: null,
        lastError: null,
        errorLog: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      let createCallCount = 0;
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findUnique).mockImplementation(
        (async () => {
          if (createCallCount > 0) return existingJob;
          return null;
        }) as any,
      );

      vi.mocked(prisma.weleticLoyaltyOutboxJob.create).mockImplementation(
        (async () => {
          createCallCount++;
          if (createCallCount === 1) {
            return existingJob;
          }
          // Simulate database unique constraint violation (P2002) for subsequent calls
          const error = new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed",
            {
              code: "P2002",
              clientVersion: "5.0.0",
            },
          );
          throw error;
        }) as any,
      );

      const payload: HoldingPeriodReleasePayload = {
        orderId: "ord_101",
        accountId: TEST_ACCOUNT_A,
        shopperId: "shop_101",
        pendingPoints: "200",
        holdingPeriodDays: 14,
        availableAt: new Date().toISOString(),
      };

      // 20 concurrent enqueue calls
      const enqueueCalls = Array.from({ length: 20 }, () =>
        enqueueOutboxJob({
          storeId: TEST_STORE_A,
          jobType: "HOLDING_PERIOD_RELEASE",
          payload,
          idempotencyKey,
        }),
      );

      const results = await Promise.all(enqueueCalls);

      expect(results.length).toBe(20);
      for (const res of results) {
        expect(res.job.id).toBe("woutbox_first_created");
      }
    });

    it("4.2: Enforces multi-tenant isolation: identical idempotencyKey under different storeIds create distinct jobs", async () => {
      const sharedKey = "shared_order_reference_999";

      const jobA: WeleticLoyaltyOutboxJob = {
        id: "woutbox_store_a",
        storeId: TEST_STORE_A,
        jobType: "METAFIELD_SYNC",
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: { accountId: TEST_ACCOUNT_A, triggerReason: "sync" },
        idempotencyKey: sharedKey,
        scheduledFor: new Date(),
        nextRetryAt: null,
        attempts: 0,
        maxAttempts: 5,
        priority: 0,
        lockedAt: null,
        lockedBy: null,
        processedAt: null,
        completedAt: null,
        lastError: null,
        errorLog: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const jobB: WeleticLoyaltyOutboxJob = {
        id: "woutbox_store_b",
        storeId: TEST_STORE_B,
        jobType: "METAFIELD_SYNC",
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: { accountId: TEST_ACCOUNT_B, triggerReason: "sync" },
        idempotencyKey: sharedKey,
        scheduledFor: new Date(),
        nextRetryAt: null,
        attempts: 0,
        maxAttempts: 5,
        priority: 0,
        lockedAt: null,
        lockedBy: null,
        processedAt: null,
        completedAt: null,
        lastError: null,
        errorLog: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      vi.mocked(prisma.weleticLoyaltyOutboxJob.findUnique).mockResolvedValue(
        null,
      );
      vi.mocked(prisma.weleticLoyaltyOutboxJob.create)
        .mockResolvedValueOnce(jobA as any)
        .mockResolvedValueOnce(jobB as any);

      const resA = await enqueueOutboxJob({
        storeId: TEST_STORE_A,
        jobType: "METAFIELD_SYNC",
        payload: { accountId: TEST_ACCOUNT_A, triggerReason: "sync" },
        idempotencyKey: sharedKey,
      });

      const resB = await enqueueOutboxJob({
        storeId: TEST_STORE_B,
        jobType: "METAFIELD_SYNC",
        payload: { accountId: TEST_ACCOUNT_B, triggerReason: "sync" },
        idempotencyKey: sharedKey,
      });

      expect(resA.job.id).toBe("woutbox_store_a");
      expect(resA.job.storeId).toBe(TEST_STORE_A);
      expect(resB.job.id).toBe("woutbox_store_b");
      expect(resB.job.storeId).toBe(TEST_STORE_B);
    });
  });

  // =========================================================================
  // Section 5: Terminal Errors & Dead-Letter State Machine
  // =========================================================================
  describe("Section 5: Terminal Errors & Dead-Letter State Machine", () => {
    it("5.1: Automatically routes job to dead_letter with complete errorLog when attempts reach maxAttempts", async () => {
      const candidate = {
        id: "woutbox_dead_letter_target",
        storeId: TEST_STORE_A,
        jobType: "UNSUPPORTED_JOB_TYPE",
        status: WeleticLoyaltyOutboxJobStatus.failed,
        payload: {
          orderId: "ord_corrupt_nonexistent",
          accountId: TEST_ACCOUNT_A,
          shopperId: "shop_1",
          pendingPoints: "100",
          holdingPeriodDays: 14,
          availableAt: new Date().toISOString(),
        },
        idempotencyKey: "dead_letter_key",
        scheduledFor: new Date(Date.now() - 10000),
        nextRetryAt: new Date(Date.now() - 5000),
        attempts: 4, // Next will be attempt 5 (maxAttempts: 5)
        maxAttempts: 5,
        priority: 0,
        lockedAt: null,
        lockedBy: null,
        processedAt: null,
        completedAt: null,
        lastError: "Previous network error",
        errorLog: [
          {
            attempt: 4,
            error: "Previous network error",
            at: "2026-08-26T00:00:00Z",
          },
        ],
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as WeleticLoyaltyOutboxJob;

      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 }) // reap
        .mockResolvedValueOnce({ count: 1 }) // acquire lock
        .mockResolvedValueOnce({ count: 1 }); // dead-letter while owning lease

      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        candidate,
      ]);

      const batch = await processOutboxJobsBatch({ batchSize: 1 });

      expect(batch.processed).toBe(1);
      expect(batch.deadLettered).toBe(1);
      expect(batch.failed).toBe(0);
      expect(batch.succeeded).toBe(0);

      expect(prisma.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: "woutbox_dead_letter_target",
          status: WeleticLoyaltyOutboxJobStatus.processing,
        }),
        data: expect.objectContaining({
          status: WeleticLoyaltyOutboxJobStatus.dead_letter,
          lockedAt: null,
          lockedBy: null,
          lastError: expect.stringContaining("Unknown job type"),
          errorLog: expect.arrayContaining([
            expect.objectContaining({ attempt: 5 }),
          ]),
        }),
      });
    });

    it("5.2: Rejects corrupted or invalid payload types before enqueueing", () => {
      expect(() =>
        validateOutboxPayload("HOLDING_PERIOD_RELEASE", {
          orderId: 12345, // invalid type
        }),
      ).toThrow();

      expect(() =>
        validateOutboxPayload("INACTIVITY_EXPIRY", {
          accountId: "acc_1",
          expiryMonths: -3, // negative
        }),
      ).toThrow();

      expect(() =>
        validateOutboxPayload("REDEMPTION_RECOVERY", {
          redemptionId: "r1",
          // missing pointsCost and shopifyDiscountCode
        }),
      ).toThrow();
    });
  });

  // =========================================================================
  // Section 6: Non-Crashing Ledger Migration & Anomaly Isolation
  // =========================================================================
  describe("Section 6: Non-Crashing Ledger Migration & Anomaly Isolation", () => {
    it("6.1: Handles ledgerVersion migration on massive batch cursor loop without memory leaks", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.count).mockResolvedValue(100);

      // Simulate 5 batches of 20 accounts
      const generateBatch = (startIndex: number) =>
        Array.from({ length: 20 }, (_, i) => ({
          id: `acc_batch_${startIndex + i}`,
          storeId: TEST_STORE_A,
          ledgerVersion: 0,
        }));

      for (let b = 0; b < 5; b++) {
        vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce(
          generateBatch(b * 20) as any,
        );
        vi.mocked(
          prisma.weleticPointsLedgerEntry.groupBy,
        ).mockResolvedValueOnce(
          Array.from({ length: 20 }, (_, i) => ({
            accountId: `acc_batch_${b * 20 + i}`,
            _max: { sequenceNumber: (b + 1) * 10 },
          })) as any,
        );
      }

      vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValue(
        {} as any,
      );

      const result = await migrateLedgerVersions({
        batchSize: 20,
        dryRun: false,
      });

      expect(result.totalAccounts).toBe(100);
      expect(result.updatedAccounts).toBe(100);
      expect(result.errors.length).toBe(0);
      expect(prisma.weleticLoyaltyAccount.findMany).toHaveBeenCalledTimes(5);
    });

    it("6.2: Non-crashing reconciliation isolates corrupt account without affecting subsequent accounts", async () => {
      // Setup store with 2 accounts: 1 corrupted with multiple anomalies, 1 clean
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValue([
        { id: "acc_fatal_gap" } as any,
        { id: "acc_healthy" } as any,
      ]);

      // Account 1: sequence gap + balance discontinuity
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique)
        .mockResolvedValueOnce({
          id: "acc_fatal_gap",
          storeId: TEST_STORE_A,
          status: WeleticLoyaltyAccountStatus.active,
          cachedPointsBalance: BigInt(500),
          lifetimePointsEarned: BigInt(500),
          lifetimePointsRedeemed: BigInt(0),
          metadata: {},
        } as any)
        // Account 2: clean
        .mockResolvedValueOnce({
          id: "acc_healthy",
          storeId: TEST_STORE_A,
          status: WeleticLoyaltyAccountStatus.active,
          cachedPointsBalance: BigInt(100),
          lifetimePointsEarned: BigInt(100),
          lifetimePointsRedeemed: BigInt(0),
          metadata: {},
        } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany)
        .mockResolvedValueOnce([
          {
            id: "e1",
            sequenceNumber: 1,
            pointsDelta: BigInt(100),
            balanceAfter: BigInt(100),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
          {
            id: "e3",
            sequenceNumber: 4, // GAP & DISCONTINUITY
            pointsDelta: BigInt(200),
            balanceAfter: BigInt(999),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
        ] as any)
        .mockResolvedValueOnce([
          {
            id: "e_h1",
            sequenceNumber: 1,
            pointsDelta: BigInt(100),
            balanceAfter: BigInt(100),
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
          },
        ] as any);

      vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValue(
        {} as any,
      );

      const summary = await auditStoreLedgers(TEST_STORE_A, {
        quarantineFatal: true,
      });

      expect(summary.totalAccounts).toBe(2);
      expect(summary.quarantinedAccounts).toBe(1);
      expect(summary.cleanAccounts).toBe(1);
      expect(summary.anomalies.length).toBeGreaterThan(0);

      // Verify corrupt account was quarantined into suspended status
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "acc_fatal_gap" },
          data: expect.objectContaining({
            status: WeleticLoyaltyAccountStatus.suspended,
            metadata: expect.objectContaining({
              quarantine: expect.objectContaining({
                isQuarantined: true,
              }),
            }),
          }),
        }),
      );
    });
  });
});
