import { prisma } from "@/lib/prisma";
import {
  createAuthenticatedFixtureCustomerCreateMaintenancePermit,
  createLoyaltyMaintenanceLeaseMetadata,
  createLoyaltyMaintenanceOwnerPermit,
  LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
  LoyaltyMaintenanceBlockedError,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import {
  calculateExponentialBackoff,
  enqueueOutboxJob,
  enqueueOutboxJobs,
  executeOutboxJob,
  handleBirthdayReward,
  handleHoldingPeriodRelease,
  handleInactivityExpiry,
  handleRedemptionRecovery,
  handleTierReview,
  HoldingPeriodReleasePayload,
  processOutboxJobsBatch,
  reapStaleOutboxLocks,
  validateOutboxPayload,
} from "@/lib/weletic/loyalty/outbox";
import { createLoyaltyDiscountProvisioningIdentity } from "@/lib/weletic/loyalty/redemption-discount-identity";
import { createReferralCouponRewardSnapshot } from "@/lib/weletic/loyalty/referral-coupon-snapshot";
import {
  Prisma,
  WeleticLoyaltyOutboxJobStatus,
  WeleticLoyaltyOutboxJobType,
  WeleticPointsLedgerEntryType,
  WeleticRedemptionStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock prisma client for isolation
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    weleticRewardRedemption: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(),
    },
    weleticReconciliationIssue: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn((fns) =>
      Array.isArray(fns) ? Promise.all(fns) : fns(prisma),
    ),
  },
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

const TEST_STORE_ID = "wstore_test_m2";
const TEST_ACCOUNT_ID = "wlacc_test_m2";
const TEST_SHOPPER_ID = "wshop_test_m2";
const TEST_ORDER_ID = "ord_test_m2";
const TEST_MAINTENANCE_RUN_MARKER = "a1-outbox-maintenance-test";
const TEST_MAINTENANCE_FIXTURE_EMAIL = "a1-outbox@example.test";
let mockProgramMetadata: Prisma.JsonValue | null = null;

function installTestMaintenanceLease() {
  mockProgramMetadata = createLoyaltyMaintenanceLeaseMetadata({
    existingMetadata: null,
    ownerToken: "o".repeat(64),
    runMarker: TEST_MAINTENANCE_RUN_MARKER,
    fixtureEmails: [TEST_MAINTENANCE_FIXTURE_EMAIL],
    acquiredAt: new Date("2026-08-30T00:00:00.000Z"),
    recoveryAfter: new Date("2026-08-30T01:00:00.000Z"),
  }) as unknown as Prisma.JsonValue;
  return createLoyaltyMaintenanceOwnerPermit({
    storeId: TEST_STORE_ID,
    metadata: mockProgramMetadata,
    ownerToken: "o".repeat(64),
  });
}

function installTestFixtureMaintenancePermit() {
  installTestMaintenanceLease();
  return createAuthenticatedFixtureCustomerCreateMaintenancePermit({
    storeId: TEST_STORE_ID,
    metadata: mockProgramMetadata,
    topic: "customers/create",
    webhookAuthenticated: true,
    email: TEST_MAINTENANCE_FIXTURE_EMAIL,
    tags: [
      LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
      TEST_MAINTENANCE_RUN_MARKER,
    ],
  });
}

function verifiedDiscountMetadata({
  redemptionId,
  rewardDefinitionId,
  discountCode,
  rewardName,
}: {
  redemptionId: string;
  rewardDefinitionId: string;
  discountCode: string;
  rewardName: string;
}) {
  return {
    rewardSnapshot: { name: rewardName },
    shopifyDiscountOwnership: createLoyaltyDiscountProvisioningIdentity({
      identity: {
        storeId: TEST_STORE_ID,
        redemptionId,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId,
        discountCode,
      },
      rewardName,
    }),
  };
}

describe("Milestone 2: Outbox Job Infrastructure Unit & Integration Test Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProgramMetadata = null;
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      id: TEST_STORE_ID,
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
      installationGeneration: "sgen_outbox_two",
    } as any);
    vi.mocked(prisma.$transaction).mockImplementation((fns: any) =>
      Array.isArray(fns) ? Promise.all(fns) : fns(prisma),
    );
    vi.mocked(prisma.$queryRaw).mockImplementation((query: any) => {
      const sql = Array.isArray(query?.strings)
        ? query.strings.join(" ")
        : String(query);
      if (sql.includes("WeleticShopifyStore")) {
        return Promise.resolve([
          {
            id: TEST_STORE_ID,
            complianceState: "active",
            shopCurrency: "USD",
            currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
            installationGeneration: "sgen_outbox_two",
          },
        ]) as never;
      }
      if (sql.includes("WeleticLoyaltyProgram")) {
        return Promise.resolve([
          {
            id: "wloyalty_program_outbox",
            storeId: TEST_STORE_ID,
            status: "active",
            killSwitchActive: false,
            metadata: mockProgramMetadata,
          },
        ]) as never;
      }
      return Promise.resolve([]) as never;
    });
  });

  // =========================================================================
  // 1. Transactional Enqueueing & Atomicity
  // =========================================================================
  describe("1. Transactional Enqueueing & Atomicity", () => {
    it("accepts birthday and referral coupon provisioning payloads", () => {
      expect(() =>
        validateOutboxPayload("BIRTHDAY_REWARD", {
          accountId: TEST_ACCOUNT_ID,
          birthDate: "2000-08-29",
          registeredAt: "2026-01-01T00:00:00.000Z",
          calendarYear: 2026,
        }),
      ).not.toThrow();
      expect(() =>
        validateOutboxPayload("REFERRAL_REWARD_PROVISION", {
          referralId: "wreferral_test",
          qualificationOrderId: "worder_test",
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: "wreward_test",
          side: "advocate",
        }),
      ).not.toThrow();
      expect(() =>
        validateOutboxPayload("REFERRAL_REWARD_PROVISION", {
          referralId: "wreferral_test",
          qualificationOrderId: "worder_test",
          side: "other",
        }),
      ).toThrow();
    });

    it("1.1: Successfully enqueues HOLDING_PERIOD_RELEASE within interactive transaction", async () => {
      const mockCreate = vi.fn().mockImplementation(({ data }) => ({
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const mockTx = {
        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: mockCreate,
        },
      } as unknown as Prisma.TransactionClient;

      const payload: HoldingPeriodReleasePayload = {
        orderId: TEST_ORDER_ID,
        accountId: TEST_ACCOUNT_ID,
        shopperId: TEST_SHOPPER_ID,
        pendingPoints: "150",
        holdingPeriodDays: 14,
        availableAt: new Date(Date.now() + 14 * 86400000).toISOString(),
      };

      const job = await enqueueOutboxJob({
        storeId: TEST_STORE_ID,
        jobType: "HOLDING_PERIOD_RELEASE",
        payload,
        idempotencyKey: `holding:${TEST_ORDER_ID}`,
        tx: mockTx,
      });

      expect(job.job.storeId).toBe(TEST_STORE_ID);
      expect(job.job.jobType).toBe("HOLDING_PERIOD_RELEASE");
      expect(job.job.status).toBe(WeleticLoyaltyOutboxJobStatus.pending);
      expect(job.created).toBe(true);
      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it("binds newly enqueued ordinary work to the exact installation generation", async () => {
      const create = vi.fn().mockImplementation(({ data }) => data);
      const mockTx = {
        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn().mockResolvedValue(null),
          create,
        },
        weleticShopifyStore: {
          findUnique: vi.fn().mockResolvedValue({
            installationGeneration: "sgen_outbox_one",
          }),
        },
      } as unknown as Prisma.TransactionClient;

      await enqueueOutboxJob({
        storeId: TEST_STORE_ID,
        jobType: "HOLDING_PERIOD_RELEASE",
        payload: {
          orderId: TEST_ORDER_ID,
          accountId: TEST_ACCOUNT_ID,
          shopperId: TEST_SHOPPER_ID,
          pendingPoints: "150",
          holdingPeriodDays: 14,
          availableAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
        },
        idempotencyKey: `holding:generation:${TEST_ORDER_ID}`,
        tx: mockTx,
      });

      expect(create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            installationGeneration: "sgen_outbox_one",
          }),
        }),
      });
    });

    it("terminally suppresses generation-one ordinary work after generation two reconnects", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: TEST_STORE_ID,
        complianceState: "active",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
        installationGeneration: "sgen_outbox_two",
      } as any);

      await expect(
        executeOutboxJob({
          id: "woutbox_generation_one",
          storeId: TEST_STORE_ID,
          jobType: "HOLDING_PERIOD_RELEASE",
          payload: {
            orderId: TEST_ORDER_ID,
            accountId: TEST_ACCOUNT_ID,
            shopperId: TEST_SHOPPER_ID,
            pendingPoints: "150",
            holdingPeriodDays: 14,
            availableAt: new Date().toISOString(),
            installationGeneration: "sgen_outbox_one",
          },
        } as any),
      ).resolves.toBeUndefined();

      expect(prisma.weleticLoyaltyAccount.findFirst).not.toHaveBeenCalled();
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
    });

    it("1.2: Returns existing outbox job upon duplicate idempotencyKey without throwing", async () => {
      const existingJob = {
        id: "woutbox_existing_1",
        storeId: TEST_STORE_ID,
        jobType: "HOLDING_PERIOD_RELEASE" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        idempotencyKey: `holding:${TEST_ORDER_ID}`,
        attempts: 0,
      };

      const mockTx = {
        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn().mockResolvedValue(existingJob),
          create: vi.fn(),
        },
      } as unknown as Prisma.TransactionClient;

      const job = await enqueueOutboxJob({
        storeId: TEST_STORE_ID,
        jobType: "HOLDING_PERIOD_RELEASE",
        payload: {
          orderId: TEST_ORDER_ID,
          accountId: TEST_ACCOUNT_ID,
          shopperId: TEST_SHOPPER_ID,
          pendingPoints: "150",
          holdingPeriodDays: 14,
          availableAt: new Date().toISOString(),
        },
        idempotencyKey: `holding:${TEST_ORDER_ID}`,
        tx: mockTx,
      });

      expect(job.job.id).toBe("woutbox_existing_1");
      expect(job.created).toBe(false);
      expect(mockTx.weleticLoyaltyOutboxJob.create).not.toHaveBeenCalled();
    });

    it("1.3: Rejects malformed payload failing Zod schema validation", async () => {
      await expect(
        enqueueOutboxJob({
          storeId: TEST_STORE_ID,
          jobType: "HOLDING_PERIOD_RELEASE",
          payload: {
            orderId: TEST_ORDER_ID,
            // Missing required accountId, pendingPoints, etc.
          } as any,
        }),
      ).rejects.toThrow();
    });

    it("1.4: Batch enqueues multiple outbox jobs within transaction", async () => {
      const mockCreate = vi.fn().mockImplementation(({ data }) => ({
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const mockTx = {
        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: mockCreate,
        },
      } as unknown as Prisma.TransactionClient;

      const count = await enqueueOutboxJobs(
        [
          {
            storeId: TEST_STORE_ID,
            jobType: "METAFIELD_SYNC",
            payload: {
              accountId: TEST_ACCOUNT_ID,
              triggerReason: "batch_1",
            },
          },
          {
            storeId: TEST_STORE_ID,
            jobType: "METAFIELD_SYNC",
            payload: {
              accountId: TEST_ACCOUNT_ID,
              triggerReason: "batch_2",
            },
          },
        ],
        mockTx,
      );

      expect(count).toBe(2);
      expect(mockCreate).toHaveBeenCalledTimes(2);
    });
  });

  describe("Birthday reward scheduling", () => {
    it("evaluates rule windows at the payload birthday when a job is delayed", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2027-01-10T00:00:00.000Z"));
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValueOnce({
        count: 1,
      });
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue(null);

      try {
        await handleBirthdayReward(TEST_STORE_ID, {
          accountId: TEST_ACCOUNT_ID,
          birthDate: "2000-08-29",
          registeredAt: "2025-01-01T00:00:00.000Z",
          calendarYear: 2026,
        });
      } finally {
        vi.useRealTimers();
      }

      const accountQuery = vi.mocked(prisma.weleticLoyaltyAccount.findFirst)
        .mock.calls[0]?.[0] as any;
      const ruleWhere = accountQuery.include.program.include.earningRules
        .where as any;
      expect(ruleWhere.OR).toEqual([
        { startAt: null },
        { startAt: { lte: new Date("2026-08-29T00:00:00.000Z") } },
      ]);
      expect(ruleWhere.AND).toEqual([
        {
          OR: [
            { endAt: null },
            { endAt: { gte: new Date("2026-08-29T00:00:00.000Z") } },
          ],
        },
      ]);
    });

    it("does not award or reschedule after customer redaction wins the account claim", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValueOnce({
        count: 0,
      });

      await handleBirthdayReward(TEST_STORE_ID, {
        accountId: TEST_ACCOUNT_ID,
        birthDate: "2000-08-29",
        registeredAt: "2025-01-01T00:00:00.000Z",
        calendarYear: 2026,
      });

      expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith({
        where: {
          id: TEST_ACCOUNT_ID,
          storeId: TEST_STORE_ID,
          status: "active",
        },
        data: { updatedAt: expect.any(Date) },
      });
      expect(prisma.weleticLoyaltyAccount.findFirst).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyOutboxJob.create).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. Worker Polling, Concurrency Locking & Backoff
  // =========================================================================
  describe("2. Worker Polling, Concurrency Locking & Backoff", () => {
    it("2.1: Calculates exponential backoff with full jitter accurately", () => {
      const delay1 = calculateExponentialBackoff(1, 2000, 3600000);
      expect(delay1).toBeGreaterThanOrEqual(2000);
      expect(delay1).toBeLessThanOrEqual(3000);

      const delay2 = calculateExponentialBackoff(2, 2000, 3600000);
      expect(delay2).toBeGreaterThanOrEqual(4000);
      expect(delay2).toBeLessThanOrEqual(5000);

      const delay3 = calculateExponentialBackoff(3, 2000, 3600000);
      expect(delay3).toBeGreaterThanOrEqual(8000);
      expect(delay3).toBeLessThanOrEqual(9000);

      const maxDelay = calculateExponentialBackoff(20, 2000, 3600000);
      expect(maxDelay).toBeLessThanOrEqual(3600000 + 1000);
    });

    it("2.2: Reaps stale locks exceeding lockTimeoutMs", async () => {
      vi.mocked(
        prisma.weleticLoyaltyOutboxJob.updateMany,
      ).mockResolvedValueOnce({
        count: 3,
      });

      const reaped = await reapStaleOutboxLocks(300000, new Date());
      expect(reaped).toBe(3);
      expect(prisma.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: WeleticLoyaltyOutboxJobStatus.processing,
          }),
        }),
      );
    });

    it("scopes stale-lock reaping and candidate polling to the requested store and job IDs", async () => {
      const now = new Date("2099-08-30T00:00:00.000Z");
      const jobIds = ["woutbox_a1_one", "woutbox_a1_two"];
      vi.mocked(
        prisma.weleticLoyaltyOutboxJob.updateMany,
      ).mockResolvedValueOnce({ count: 0 });
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce(
        [],
      );

      await processOutboxJobsBatch({
        batchSize: 2,
        now,
        storeId: TEST_STORE_ID,
        jobIds,
      });

      expect(prisma.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledWith({
        where: {
          storeId: TEST_STORE_ID,
          id: { in: jobIds },
          status: WeleticLoyaltyOutboxJobStatus.processing,
          lockedAt: { lt: new Date("2099-08-29T23:55:00.000Z") },
        },
        data: {
          status: WeleticLoyaltyOutboxJobStatus.failed,
          lockedAt: null,
          lockedBy: null,
          lastError: "Lease lock expired / worker timeout reaped",
          nextRetryAt: now,
        },
      });
      expect(prisma.weleticLoyaltyOutboxJob.findMany).toHaveBeenCalledWith({
        where: {
          storeId: TEST_STORE_ID,
          id: { in: jobIds },
          status: {
            in: [
              WeleticLoyaltyOutboxJobStatus.pending,
              WeleticLoyaltyOutboxJobStatus.failed,
            ],
          },
          scheduledFor: { lte: now },
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          NOT: {
            store: { merchantSettings: { is: { shopperEmailPaused: true } } },
            OR: [
              { jobType: "REVIEW_REQUEST_EMAIL" },
              {
                jobType: "INACTIVITY_EXPIRY",
                OR: [
                  { payload: { path: "$.stage", equals: "warning" } },
                  { payload: { path: "$.stage", equals: "last_chance" } },
                ],
              },
            ],
          },
        },
        orderBy: [{ priority: "desc" }, { scheduledFor: "asc" }],
        take: 2,
      });
    });

    it("preserves all-store stale-lock and candidate query shapes when no scope is supplied", async () => {
      const now = new Date("2099-08-30T00:00:00.000Z");
      vi.mocked(
        prisma.weleticLoyaltyOutboxJob.updateMany,
      ).mockResolvedValueOnce({ count: 0 });
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce(
        [],
      );

      await processOutboxJobsBatch({ batchSize: 2, now });

      const reaperWhere = vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mock.calls[0]?.[0]?.where as Record<string, unknown>;
      const candidateWhere = vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany)
        .mock.calls[0]?.[0]?.where as Record<string, unknown>;
      expect(reaperWhere).not.toHaveProperty("storeId");
      expect(reaperWhere).not.toHaveProperty("id");
      expect(candidateWhere).not.toHaveProperty("storeId");
      expect(candidateWhere).not.toHaveProperty("id");
    });

    it.each([
      {
        label: "has no scope",
        options: {},
      },
      {
        label: "has only a store",
        options: { storeId: TEST_STORE_ID },
      },
      {
        label: "has only job IDs",
        options: { jobIds: ["woutbox_logical_guard"] },
      },
      {
        label: "has an empty job allowlist",
        options: { storeId: TEST_STORE_ID, jobIds: [] },
      },
      {
        label: "also supplies the legacy wall-clock override",
        options: {
          storeId: TEST_STORE_ID,
          jobIds: ["woutbox_logical_guard"],
          now: new Date("2026-08-30T00:00:00.000Z"),
        },
      },
    ])("fails closed when logical time $label", async ({ options }) => {
      await expect(
        processOutboxJobsBatch({
          ...options,
          logicalNow: new Date("2100-01-01T00:00:00.000Z"),
        }),
      ).rejects.toThrow(
        "logicalNow requires a valid Date, no caller-supplied now, an exact storeId, and a non-empty explicit jobIds allowlist.",
      );

      expect(prisma.weleticLoyaltyOutboxJob.updateMany).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyOutboxJob.findMany).not.toHaveBeenCalled();
    });

    it("defers maintained operational jobs before stale reaping or claim", async () => {
      installTestMaintenanceLease();
      const pendingJob = {
        id: "woutbox_maintained_pending",
        storeId: TEST_STORE_ID,
        jobType: "METAFIELD_SYNC" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          accountId: TEST_ACCOUNT_ID,
          triggerReason: "maintenance_test",
        },
        attempts: 0,
        maxAttempts: 5,
        scheduledFor: new Date("2026-08-30T00:00:00.000Z"),
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        errorLog: [],
      };
      const staleJob = {
        ...pendingJob,
        id: "woutbox_maintained_stale",
        status: WeleticLoyaltyOutboxJobStatus.processing,
        lockedAt: new Date("2026-08-29T23:00:00.000Z"),
        lockedBy: "dead-worker",
      };
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany)
        .mockResolvedValueOnce([pendingJob as any])
        .mockResolvedValueOnce([staleJob as any]);

      const result = await processOutboxJobsBatch({
        storeId: TEST_STORE_ID,
        jobIds: [pendingJob.id],
        now: new Date("2026-08-30T00:00:00.000Z"),
      });

      expect(result).toMatchObject({
        processed: 0,
        succeeded: 0,
        failed: 0,
        deadLettered: 0,
        skipped: 1,
        jobs: [],
      });
      expect(prisma.weleticLoyaltyOutboxJob.updateMany).not.toHaveBeenCalled();
    });

    it("restores an in-flight claim when maintenance begins before completion", async () => {
      const job = {
        id: "woutbox_maintenance_completion_race",
        storeId: TEST_STORE_ID,
        jobType: "METAFIELD_SYNC" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          accountId: TEST_ACCOUNT_ID,
          triggerReason: "maintenance_completion_race",
          installationGeneration: "sgen_outbox_two",
        },
        attempts: 0,
        maxAttempts: 5,
        scheduledFor: new Date("2026-08-30T00:00:00.000Z"),
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        errorLog: [],
      };
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany)
        .mockResolvedValueOnce([job as any])
        .mockResolvedValueOnce([]);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mockResolvedValue({
        count: 1,
      });
      vi.mocked(
        prisma.weleticLoyaltyAccount
          .findFirst as unknown as () => Promise<unknown>,
      ).mockImplementationOnce(async () => {
        installTestMaintenanceLease();
        return null;
      });

      const result = await processOutboxJobsBatch({
        storeId: TEST_STORE_ID,
        jobIds: [job.id],
        now: new Date("2026-08-30T00:00:00.000Z"),
      });

      expect(result).toMatchObject({
        processed: 0,
        succeeded: 0,
        failed: 0,
        deadLettered: 0,
        skipped: 1,
        jobs: [],
      });
      expect(prisma.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledTimes(
        2,
      );
      expect(
        vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mock.calls[0]?.[0],
      ).toMatchObject({
        where: {
          id: job.id,
          status: WeleticLoyaltyOutboxJobStatus.pending,
          lockedAt: null,
        },
        data: {
          status: WeleticLoyaltyOutboxJobStatus.processing,
          attempts: { increment: 1 },
        },
      });
      expect(
        vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mock.calls[1]?.[0],
      ).toMatchObject({
        where: {
          id: job.id,
          status: WeleticLoyaltyOutboxJobStatus.processing,
          lockedAt: new Date("2026-08-30T00:00:00.000Z"),
          lockedBy: expect.stringContaining(":wlease_"),
          attempts: 1,
        },
        data: {
          status: WeleticLoyaltyOutboxJobStatus.pending,
          lockedAt: null,
          lockedBy: null,
          attempts: 0,
        },
      });
    });

    it("allows an owner permit only for its exact store and job allowlist", async () => {
      const loyaltyMaintenancePermit = installTestMaintenanceLease();
      const job = {
        id: "woutbox_maintained_owner",
        storeId: TEST_STORE_ID,
        jobType: "METAFIELD_SYNC" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          accountId: TEST_ACCOUNT_ID,
          triggerReason: "maintenance_owner_test",
        },
        attempts: 0,
        maxAttempts: 5,
        scheduledFor: new Date("2026-08-30T00:00:00.000Z"),
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        errorLog: [],
      };
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany)
        .mockResolvedValueOnce([job as any])
        .mockResolvedValueOnce([]);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mockResolvedValue({
        count: 1,
      });
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue(null);

      await expect(
        processOutboxJobsBatch({ loyaltyMaintenancePermit }),
      ).rejects.toThrow(
        "loyaltyMaintenancePermit requires an exact storeId and a non-empty unique jobIds allowlist.",
      );
      await expect(
        processOutboxJobsBatch({
          storeId: TEST_STORE_ID,
          jobIds: [job.id, job.id],
          loyaltyMaintenancePermit,
        }),
      ).rejects.toThrow(
        "loyaltyMaintenancePermit requires an exact storeId and a non-empty unique jobIds allowlist.",
      );

      const result = await processOutboxJobsBatch({
        storeId: TEST_STORE_ID,
        jobIds: [job.id],
        now: new Date("2026-08-30T00:00:00.000Z"),
        loyaltyMaintenancePermit,
      });
      expect(result).toMatchObject({
        processed: 1,
        succeeded: 1,
        failed: 0,
        deadLettered: 0,
      });
    });

    it("rejects a fixture customer permit at every queued-worker entry point", async () => {
      const fixturePermit = installTestFixtureMaintenancePermit();
      const job = {
        id: "woutbox_fixture_permit_scope",
        storeId: TEST_STORE_ID,
        jobType: "METAFIELD_SYNC" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          accountId: TEST_ACCOUNT_ID,
          triggerReason: "fixture_permit_scope",
        },
      } as any;
      const scope = { storeId: TEST_STORE_ID, jobIds: [job.id] };

      await expect(
        processOutboxJobsBatch({
          ...scope,
          loyaltyMaintenancePermit: fixturePermit,
        }),
      ).rejects.toBeInstanceOf(LoyaltyMaintenanceBlockedError);
      await expect(
        reapStaleOutboxLocks(
          300_000,
          new Date("2026-08-30T00:00:00.000Z"),
          scope,
          fixturePermit,
        ),
      ).rejects.toBeInstanceOf(LoyaltyMaintenanceBlockedError);
      await expect(
        executeOutboxJob(
          job,
          new Date("2026-08-30T00:00:00.000Z"),
          fixturePermit,
        ),
      ).rejects.toBeInstanceOf(LoyaltyMaintenanceBlockedError);
      expect(prisma.weleticLoyaltyOutboxJob.findMany).not.toHaveBeenCalled();
    });

    it("rejects an owner-shaped object without the private permit brand", async () => {
      const ownerPermit = installTestMaintenanceLease();
      const forgedPermit = {
        authorization: ownerPermit.authorization,
        leaseSha256: ownerPermit.leaseSha256,
        storeId: ownerPermit.storeId,
      } as unknown as typeof ownerPermit;
      const job = {
        id: "woutbox_forged_owner_permit",
        storeId: TEST_STORE_ID,
        jobType: "METAFIELD_SYNC" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: { accountId: TEST_ACCOUNT_ID },
      } as any;
      const scope = { storeId: TEST_STORE_ID, jobIds: [job.id] };

      await expect(
        processOutboxJobsBatch({
          ...scope,
          loyaltyMaintenancePermit: forgedPermit,
        }),
      ).rejects.toBeInstanceOf(LoyaltyMaintenanceBlockedError);
      await expect(
        reapStaleOutboxLocks(
          300_000,
          new Date("2026-08-30T00:00:00.000Z"),
          scope,
          forgedPermit,
        ),
      ).rejects.toBeInstanceOf(LoyaltyMaintenanceBlockedError);
      await expect(
        executeOutboxJob(
          job,
          new Date("2026-08-30T00:00:00.000Z"),
          forgedPermit,
        ),
      ).rejects.toBeInstanceOf(LoyaltyMaintenanceBlockedError);
      expect(prisma.weleticLoyaltyOutboxJob.findMany).not.toHaveBeenCalled();
    });

    it("continues stale privacy cleanup reaping during maintenance", async () => {
      installTestMaintenanceLease();
      const stalePrivacyJob = {
        id: "woutbox_privacy_stale",
        storeId: TEST_STORE_ID,
        jobType: "VOUCHER_PRIVACY_CLEANUP" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.processing,
        payload: {
          cleanupId: "cleanup_test",
          redemptionId: "redemption_test",
          accountId: TEST_ACCOUNT_ID,
        },
        lockedAt: new Date("2026-08-29T23:00:00.000Z"),
        lockedBy: "dead-worker",
      };
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        stalePrivacyJob as any,
      ]);
      vi.mocked(
        prisma.weleticLoyaltyOutboxJob.updateMany,
      ).mockResolvedValueOnce({
        count: 1,
      });

      await expect(
        reapStaleOutboxLocks(300_000, new Date("2026-08-30T00:00:00.000Z"), {
          storeId: TEST_STORE_ID,
          jobIds: [stalePrivacyJob.id],
        }),
      ).resolves.toBe(1);
      expect(prisma.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: stalePrivacyJob.id }),
        }),
      );
    });

    it("uses logical time only for scoped eligibility while leases remain on wall time", async () => {
      vi.useFakeTimers();
      const wallNow = new Date("2026-08-30T00:00:00.000Z");
      const logicalNow = new Date("2100-08-30T00:00:00.000Z");
      vi.setSystemTime(wallNow);
      const job = {
        id: "woutbox_logical_lease_boundary",
        storeId: TEST_STORE_ID,
        jobType: "METAFIELD_SYNC" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: { accountId: TEST_ACCOUNT_ID },
        attempts: 0,
        maxAttempts: 5,
        scheduledFor: logicalNow,
        nextRetryAt: null,
        lockedAt: null,
        errorLog: [],
      };
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 });
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        job as any,
      ]);

      try {
        await processOutboxJobsBatch({
          batchSize: 1,
          logicalNow,
          storeId: TEST_STORE_ID,
          jobIds: [job.id],
        });

        expect(
          vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mock
            .calls[0]?.[0],
        ).toMatchObject({
          where: {
            storeId: TEST_STORE_ID,
            id: { in: [job.id] },
            lockedAt: {
              lt: new Date(wallNow.getTime() - 5 * 60_000),
            },
          },
          data: { nextRetryAt: wallNow },
        });
        expect(prisma.weleticLoyaltyOutboxJob.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              scheduledFor: { lte: logicalNow },
              OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: logicalNow } }],
            }),
          }),
        );
        expect(
          vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mock
            .calls[1]?.[0],
        ).toMatchObject({
          where: { id: job.id },
          data: { lockedAt: wallNow },
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses a future logical clock to run a birthday job that is not due in wall-clock time", async () => {
      vi.useFakeTimers();
      const wallNow = new Date("2026-08-30T00:00:00.000Z");
      const logicalNow = new Date("2100-08-30T00:00:00.000Z");
      vi.setSystemTime(wallNow);
      const job = {
        id: "woutbox_birthday_logical_future",
        storeId: TEST_STORE_ID,
        jobType: "BIRTHDAY_REWARD" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          accountId: TEST_ACCOUNT_ID,
          birthDate: "2000-08-29",
          registeredAt: "2099-01-01T00:00:00.000Z",
          calendarYear: 2100,
          installationGeneration: "sgen_outbox_two",
        },
        idempotencyKey: "birthday_reward:logical_future:2100",
        attempts: 0,
        maxAttempts: 5,
        scheduledFor: new Date("2100-08-29T00:00:00.000Z"),
        nextRetryAt: null,
        lockedAt: null,
        errorLog: [],
      };
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        job as any,
      ]);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst)
        .mockResolvedValueOnce({
          status: "active",
          shopper: { shopifyCustomerId: "customer_birthday_logical" },
          store: { projectId: "workspace_birthday_logical" },
        } as any)
        .mockResolvedValueOnce({ status: "active" } as any)
        .mockResolvedValueOnce({
          id: TEST_ACCOUNT_ID,
          storeId: TEST_STORE_ID,
          status: "active",
          metadata: {
            birthday: {
              birthDate: "2000-08-29",
              registeredAt: "2099-01-01T00:00:00.000Z",
              nextEligibleYear: 2100,
            },
          },
          program: {
            status: "active",
            killSwitchActive: false,
            earningRules: [
              {
                id: "wearning_birthday_logical",
                name: "Logical birthday reward",
                fixedPoints: BigInt(200),
              },
            ],
          },
        } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValue({
        count: 1,
      });
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        status: "active",
        cachedPointsBalance: BigInt(100),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1,
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.findUnique)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValueOnce({
        id: "wledger_birthday_logical",
        balanceAfter: BigInt(300),
      } as any);
      vi.mocked(
        prisma.weleticLoyaltyOutboxJob.findUnique,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.create).mockResolvedValueOnce({
        id: "woutbox_birthday_logical_2101",
      } as any);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        {
          id: TEST_STORE_ID,
          complianceState: "active",
          shopCurrency: "USD",
          currencyVerifiedAt: new Date("2099-01-01T00:00:00.000Z"),
          installationGeneration: "sgen_outbox_two",
        },
      ] as never);

      try {
        const summary = await processOutboxJobsBatch({
          batchSize: 1,
          logicalNow,
          storeId: TEST_STORE_ID,
          jobIds: [job.id],
        });

        expect(summary).toMatchObject({ succeeded: 1, failed: 0 });
        expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            storeId: TEST_STORE_ID,
            accountId: TEST_ACCOUNT_ID,
            entryType: WeleticPointsLedgerEntryType.EARN_BONUS,
            pointsDelta: BigInt(200),
            idempotencyKey: `birthday:${TEST_ACCOUNT_ID}:2100`,
            referenceType: "BIRTHDAY_REWARD",
            referenceId: "2100",
          }),
        });
        expect(prisma.weleticLoyaltyOutboxJob.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            storeId: TEST_STORE_ID,
            jobType: "BIRTHDAY_REWARD",
            scheduledFor: new Date("2101-08-29T00:00:00.000Z"),
            idempotencyKey: `birthday_reward:${TEST_ACCOUNT_ID}:2101`,
          }),
        });
        expect(
          vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mock
            .calls[1]?.[0],
        ).toMatchObject({ data: { lockedAt: wallNow } });
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects a birthday job when the logical clock is before its scheduled date", async () => {
      const now = new Date("2000-08-28T00:00:00.000Z");
      const job = {
        id: "woutbox_birthday_logical_early",
        storeId: TEST_STORE_ID,
        jobType: "BIRTHDAY_REWARD" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          accountId: TEST_ACCOUNT_ID,
          birthDate: "1980-08-29",
          registeredAt: "1999-01-01T00:00:00.000Z",
          calendarYear: 2000,
          installationGeneration: "sgen_outbox_two",
        },
        idempotencyKey: "birthday_reward:logical_early:2000",
        attempts: 0,
        maxAttempts: 5,
        scheduledFor: new Date("2000-08-28T00:00:00.000Z"),
        nextRetryAt: null,
        lockedAt: null,
        errorLog: [],
      };
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        job as any,
      ]);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst)
        .mockResolvedValueOnce({
          status: "active",
          shopper: { shopifyCustomerId: "customer_birthday_early" },
          store: { projectId: "workspace_birthday_early" },
        } as any)
        .mockResolvedValueOnce({ status: "active" } as any);

      const summary = await processOutboxJobsBatch({
        batchSize: 1,
        logicalNow: now,
        storeId: TEST_STORE_ID,
        jobIds: [job.id],
      });

      expect(summary).toMatchObject({ succeeded: 0, failed: 1 });
      expect(summary.jobs[0]?.error).toBe(
        `Birthday reward job for ${TEST_ACCOUNT_ID} ran before its scheduled date.`,
      );
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
    });

    it("uses a future logical clock to expire a voucher that is not due in wall-clock time", async () => {
      const logicalNow = new Date("2100-01-02T00:00:00.000Z");
      const redemptionId = "wredemp_logical_future_expiry";
      const discountCode = "WL-LOGICAL-FUTURE";
      const rewardDefinitionId = "wreward_logical_future";
      const redemptionMetadata = verifiedDiscountMetadata({
        redemptionId,
        rewardDefinitionId,
        discountCode,
        rewardName: "Logical future reward",
      });
      const logicalRedemption = {
        id: redemptionId,
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.issued,
        pointsSpent: BigInt(200),
        shopifyDiscountCode: discountCode,
        shopifyDiscountCodeCanonical: discountCode,
        shopifyDiscountId:
          "gid://shopify/DiscountCodeNode/logical_future_expiry",
        expiresAt: new Date("2100-01-01T00:00:00.000Z"),
        metadata: redemptionMetadata,
        rewardDefinition: { name: "Logical future reward" },
      };
      const job = {
        id: "woutbox_logical_future_expiry",
        storeId: TEST_STORE_ID,
        jobType: "REDEMPTION_RECOVERY" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          redemptionId,
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId,
          pointsCost: "200",
          shopifyDiscountCode: discountCode,
          attemptCount: 0,
          sagaPhase: "expiry",
          installationGeneration: "sgen_outbox_two",
        },
        idempotencyKey: `redemption_expiry:${redemptionId}`,
        attempts: 0,
        maxAttempts: 5,
        scheduledFor: new Date("2100-01-01T00:00:00.000Z"),
        nextRetryAt: null,
        lockedAt: null,
        errorLog: [],
      };
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        job as any,
      ]);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst)
        .mockResolvedValueOnce({
          status: "active",
          shopper: { shopifyCustomerId: "customer_expiry_logical" },
          store: { projectId: "workspace_expiry_logical" },
        } as any)
        .mockResolvedValueOnce({ status: "active" } as any)
        .mockResolvedValueOnce({ status: "active", metadata: null } as any);
      vi.mocked(prisma.weleticRewardRedemption.findUnique)
        .mockResolvedValueOnce(logicalRedemption as any)
        .mockResolvedValueOnce(logicalRedemption as any)
        .mockResolvedValueOnce(logicalRedemption as any);
      vi.mocked(
        prisma.weleticRewardRedemption.updateMany,
      ).mockResolvedValueOnce({ count: 1 });
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        cachedPointsBalance: BigInt(100),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(500),
        lifetimePointsRedeemed: BigInt(200),
        ledgerVersion: 2,
        status: "active",
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValueOnce({
        count: 1,
      });
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findUnique,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValueOnce({
        id: "wledger_logical_expiry_refund",
      } as any);
      vi.mocked(
        prisma.weleticLoyaltyOutboxJob.findUnique,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.create).mockResolvedValueOnce({
        id: "woutbox_logical_expiry_metafield",
      } as any);
      vi.mocked(prisma.$queryRaw).mockResolvedValue([
        {
          id: TEST_STORE_ID,
          complianceState: "active",
          shopCurrency: "USD",
          currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
          installationGeneration: "sgen_outbox_two",
        },
      ] as never);
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      vi.spyOn(
        shopifyDiscounts,
        "resolveShopifyOfflineCredentials",
      ).mockResolvedValueOnce({
        shopDomain: "test.myshopify.com",
        accessToken: "test-token",
        source: "app_session",
      });
      vi.spyOn(shopifyDiscounts, "lookupDiscountByCode").mockResolvedValueOnce({
        id: "gid://shopify/DiscountCodeNode/logical_future_expiry",
        code: discountCode,
        title: redemptionMetadata.shopifyDiscountOwnership.expectedTitle,
        status: "ACTIVE",
      });
      const deactivateSpy = vi
        .spyOn(shopifyDiscounts, "deactivateDiscount")
        .mockResolvedValueOnce(true);

      const summary = await processOutboxJobsBatch({
        batchSize: 1,
        logicalNow,
        storeId: TEST_STORE_ID,
        jobIds: [job.id],
      });

      expect(summary).toMatchObject({ succeeded: 1, failed: 0 });
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledTimes(
        1,
      );
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: redemptionId,
            status: {
              in: [
                WeleticRedemptionStatus.provisioning,
                WeleticRedemptionStatus.issued,
                WeleticRedemptionStatus.active,
              ],
            },
          }),
          data: expect.objectContaining({
            status: WeleticRedemptionStatus.expired,
          }),
        }),
      );
      expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledTimes(1);
      expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          accountId: TEST_ACCOUNT_ID,
          pointsDelta: BigInt(200),
          idempotencyKey: `saga_compensate:${redemptionId}`,
        }),
      });
      expect(deactivateSpy).toHaveBeenCalledWith(
        "test.myshopify.com",
        "test-token",
        "gid://shopify/DiscountCodeNode/logical_future_expiry",
      );
    });

    it("rejects voucher expiry when the logical clock is before expiresAt", async () => {
      const now = new Date("2000-01-01T00:00:00.000Z");
      const redemptionId = "wredemp_logical_early_expiry";
      const job = {
        id: "woutbox_logical_early_expiry",
        storeId: TEST_STORE_ID,
        jobType: "REDEMPTION_RECOVERY" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          redemptionId,
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: "wreward_logical_early",
          pointsCost: "200",
          shopifyDiscountCode: "WL-LOGICAL-EARLY",
          attemptCount: 0,
          sagaPhase: "expiry",
          installationGeneration: "sgen_outbox_two",
        },
        idempotencyKey: `redemption_expiry:${redemptionId}`,
        attempts: 0,
        maxAttempts: 5,
        scheduledFor: now,
        nextRetryAt: null,
        lockedAt: null,
        errorLog: [],
      };
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        job as any,
      ]);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst)
        .mockResolvedValueOnce({
          status: "active",
          shopper: { shopifyCustomerId: "customer_expiry_early" },
          store: { projectId: "workspace_expiry_early" },
        } as any)
        .mockResolvedValueOnce({ status: "active" } as any);
      vi.mocked(
        prisma.weleticRewardRedemption.findUnique,
      ).mockResolvedValueOnce({
        id: redemptionId,
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_logical_early",
        status: WeleticRedemptionStatus.expired,
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-LOGICAL-EARLY",
        shopifyDiscountId: null,
        expiresAt: new Date("2000-01-02T00:00:00.000Z"),
        metadata: null,
        rewardDefinition: { name: "Logical early reward" },
      } as any);

      const summary = await processOutboxJobsBatch({
        batchSize: 1,
        logicalNow: now,
        storeId: TEST_STORE_ID,
        jobIds: [job.id],
      });

      expect(summary).toMatchObject({ succeeded: 0, failed: 1 });
      expect(summary.jobs[0]?.error).toBe(
        `Redemption ${redemptionId} expiry job ran before expiresAt`,
      );
    });

    it("2.3: Transitions job to dead_letter state upon exhausting maxAttempts", async () => {
      const failingJob = {
        id: "woutbox_fail_1",
        storeId: TEST_STORE_ID,
        jobType: "METAFIELD_SYNC" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.failed,
        payload: {
          accountId: TEST_ACCOUNT_ID,
          triggerReason: "test_failure",
          installationGeneration: "sgen_outbox_two",
        },
        attempts: 4, // Next attempt will be 5 (maxAttempts = 5)
        maxAttempts: 5,
        scheduledFor: new Date(Date.now() - 10000),
        nextRetryAt: null,
        lockedAt: null,
        errorLog: [],
      };

      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 }) // reap
        .mockResolvedValueOnce({ count: 1 }) // acquire lock
        .mockResolvedValueOnce({ count: 1 }); // dead-letter while owning lease

      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        failingJob as any,
      ]);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst)
        .mockResolvedValueOnce({
          status: "active",
          shopper: { shopifyCustomerId: "customer_test" },
          store: { projectId: "workspace_test" },
        } as any)
        .mockResolvedValueOnce({ status: "active" } as any);

      // Mock domain handler to throw error
      vi.spyOn(
        await import("@/lib/weletic/loyalty/metafield-sync"),
        "syncCustomerMetafields",
      ).mockRejectedValueOnce(new Error("Shopify GraphQL rate limit 429"));

      const summary = await processOutboxJobsBatch({ batchSize: 10 });

      expect(summary.processed).toBe(1);
      expect(summary.deadLettered).toBe(1);
      expect(summary.succeeded).toBe(0);

      expect(prisma.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "woutbox_fail_1" }),
          data: expect.objectContaining({
            status: WeleticLoyaltyOutboxJobStatus.dead_letter,
            lastError: "Shopify GraphQL rate limit 429",
          }),
        }),
      );
    });

    it("2.4: Retries failed job with exponential backoff when attempts < maxAttempts", async () => {
      vi.useFakeTimers();
      const pollNow = new Date("2026-08-30T00:00:00.000Z");
      const failureAt = new Date("2026-08-30T00:00:30.000Z");
      vi.setSystemTime(pollNow);
      const failingJob = {
        id: "woutbox_retry_1",
        storeId: TEST_STORE_ID,
        jobType: "METAFIELD_SYNC" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          accountId: TEST_ACCOUNT_ID,
          triggerReason: "test_transient_failure",
          installationGeneration: "sgen_outbox_two",
        },
        attempts: 1, // Next attempt will be 2 (< maxAttempts 5)
        maxAttempts: 5,
        scheduledFor: new Date(pollNow.getTime() - 10000),
        nextRetryAt: null,
        lockedAt: null,
        errorLog: [],
      };

      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 }) // reap
        .mockResolvedValueOnce({ count: 1 }) // acquire lock
        .mockResolvedValueOnce({ count: 1 }); // fail while owning lease

      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        failingJob as any,
      ]);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst)
        .mockResolvedValueOnce({
          status: "active",
          shopper: { shopifyCustomerId: "customer_test" },
          store: { projectId: "workspace_test" },
        } as any)
        .mockResolvedValueOnce({ status: "active" } as any);

      vi.spyOn(
        await import("@/lib/weletic/loyalty/metafield-sync"),
        "syncCustomerMetafields",
      ).mockImplementationOnce(async () => {
        // Model a slow remote call: retry delay must start after this failure,
        // not from the poll/lease timestamp captured before the handler ran.
        vi.setSystemTime(failureAt);
        throw new Error("Network timeout 504");
      });

      try {
        const summary = await processOutboxJobsBatch({
          batchSize: 10,
          now: pollNow,
        });

        expect(summary.processed).toBe(1);
        expect(summary.failed).toBe(1);
        expect(summary.deadLettered).toBe(0);

        expect(prisma.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({ id: "woutbox_retry_1" }),
            data: expect.objectContaining({
              status: WeleticLoyaltyOutboxJobStatus.failed,
              lastError: "Network timeout 504",
              nextRetryAt: expect.any(Date),
            }),
          }),
        );

        const failedTransition = vi
          .mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
          .mock.calls.find(
            ([args]) =>
              (args.data as { status?: WeleticLoyaltyOutboxJobStatus })
                ?.status === WeleticLoyaltyOutboxJobStatus.failed &&
              !(
                args.where as {
                  lockedAt?: { lt?: Date };
                }
              ).lockedAt?.lt,
          )?.[0];
        const nextRetryAt = (failedTransition?.data as any)
          ?.nextRetryAt as Date;
        const errorLog = (failedTransition?.data as any)?.errorLog as Array<{
          at: string;
        }>;
        expect(nextRetryAt.getTime()).toBeGreaterThanOrEqual(
          failureAt.getTime() + 4000,
        );
        expect(nextRetryAt.getTime()).toBeLessThan(failureAt.getTime() + 5000);
        expect(errorLog.at(-1)?.at).toBe(failureAt.toISOString());
      } finally {
        vi.useRealTimers();
      }
    });

    it("records a critical reconciliation issue when referral coupon provisioning dead-letters", async () => {
      const failingJob = {
        id: "woutbox_referral_coupon_dead",
        storeId: TEST_STORE_ID,
        jobType: "REFERRAL_REWARD_PROVISION" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.failed,
        payload: {
          referralId: "wreferral_dead",
          qualificationOrderId: "worder_dead",
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: "wreward_dead",
          side: "advocate",
        },
        idempotencyKey:
          "job:referral_coupon:wreferral_dead:worder_dead:advocate",
        attempts: 4,
        maxAttempts: 5,
        scheduledFor: new Date(Date.now() - 10_000),
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        errorLog: [],
      };

      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 }) // reap
        .mockResolvedValueOnce({ count: 1 }) // acquire lock
        .mockResolvedValueOnce({ count: 1 }); // transactional dead-letter
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        failingJob as any,
      ]);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst)
        .mockResolvedValueOnce({
          status: "active",
          shopper: { shopifyCustomerId: "customer_referral_dead" },
          store: { projectId: "workspace_referral_dead" },
        } as any)
        .mockResolvedValueOnce({ status: "active" } as any);
      vi.mocked(prisma.weleticReconciliationIssue.upsert).mockResolvedValueOnce(
        { id: "wrecon_referral_dead" } as any,
      );
      vi.spyOn(
        await import("@/lib/weletic/loyalty/referral-coupon"),
        "issueReferralRewardCoupon",
      ).mockRejectedValueOnce(
        new Error("Shopify outcome unknown after network timeout"),
      );

      const summary = await processOutboxJobsBatch({ batchSize: 1 });

      expect(summary.deadLettered).toBe(1);
      expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith({
        where: {
          storeId_kind_externalKey: {
            storeId: TEST_STORE_ID,
            kind: "referral_coupon_dead_letter",
            externalKey: "wreferral_dead:worder_dead:advocate",
          },
        },
        create: expect.objectContaining({
          storeId: TEST_STORE_ID,
          externalKey: "wreferral_dead:worder_dead:advocate",
          kind: "referral_coupon_dead_letter",
          severity: "critical",
          status: "open",
          details: expect.objectContaining({
            remoteOutcome: "ambiguous",
            resolutionMarker: "redrive_or_manual_shopify_verification_required",
            outboxJobId: "woutbox_referral_coupon_dead",
          }),
        }),
        update: expect.objectContaining({
          severity: "critical",
          status: "open",
          resolvedAt: null,
        }),
      });
    });

    it("resolves the referral coupon dead-letter issue after an audited redrive succeeds", async () => {
      const redrivenJob = {
        id: "woutbox_referral_coupon_redrive",
        storeId: TEST_STORE_ID,
        jobType: "REFERRAL_REWARD_PROVISION" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.failed,
        payload: {
          referralId: "wreferral_redrive",
          qualificationOrderId: "worder_redrive",
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: "wreward_redrive",
          side: "referee",
        },
        idempotencyKey:
          "job:referral_coupon:wreferral_redrive:worder_redrive:referee",
        attempts: 5,
        maxAttempts: 6,
        scheduledFor: new Date(Date.now() - 10_000),
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        errorLog: [],
      };

      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 }) // reap
        .mockResolvedValueOnce({ count: 1 }) // acquire lock
        .mockResolvedValueOnce({ count: 1 }); // transactional completion
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        redrivenJob as any,
      ]);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst)
        .mockResolvedValueOnce({
          status: "active",
          shopper: { shopifyCustomerId: "customer_referral_redrive" },
          store: { projectId: "workspace_referral_redrive" },
        } as any)
        .mockResolvedValueOnce({ status: "active" } as any);
      vi.mocked(
        prisma.weleticReconciliationIssue.updateMany,
      ).mockResolvedValueOnce({ count: 1 });
      vi.spyOn(
        await import("@/lib/weletic/loyalty/referral-coupon"),
        "issueReferralRewardCoupon",
      ).mockResolvedValueOnce({} as any);

      const summary = await processOutboxJobsBatch({ batchSize: 1 });

      expect(summary.succeeded).toBe(1);
      expect(prisma.weleticReconciliationIssue.updateMany).toHaveBeenCalledWith(
        {
          where: {
            storeId: TEST_STORE_ID,
            kind: "referral_coupon_dead_letter",
            externalKey: "wreferral_redrive:worder_redrive:referee",
            status: "open",
          },
          data: {
            status: "resolved",
            resolvedAt: expect.any(Date),
            details: expect.objectContaining({
              remoteOutcome: "verified",
              resolutionMarker: "audited_redrive_completed",
              resolutionMethod: "outbox_redrive",
              resolvedAt: expect.any(String),
            }),
          },
        },
      );
    });

    it("does not wrapper-skip or resolve a referral redrive when the account is missing", async () => {
      const redrivenJob = {
        id: "woutbox_referral_coupon_missing_account",
        storeId: TEST_STORE_ID,
        jobType: "REFERRAL_REWARD_PROVISION" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.failed,
        payload: {
          referralId: "wreferral_missing_account",
          qualificationOrderId: "worder_missing_account",
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: "wreward_missing_account",
          side: "advocate",
        },
        idempotencyKey:
          "job:referral_coupon:wreferral_missing_account:worder_missing_account:advocate",
        attempts: 1,
        maxAttempts: 6,
        scheduledFor: new Date(Date.now() - 10_000),
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        errorLog: [],
      };

      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 }) // reap
        .mockResolvedValueOnce({ count: 1 }) // acquire lock
        .mockResolvedValueOnce({ count: 1 }); // retain failed redrive
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        redrivenJob as any,
      ]);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
        null,
      );
      vi.spyOn(
        await import("@/lib/weletic/loyalty/referral-coupon"),
        "issueReferralRewardCoupon",
      ).mockRejectedValueOnce(
        new Error("Referral coupon account requires audited recovery."),
      );

      const summary = await processOutboxJobsBatch({ batchSize: 1 });

      expect(summary).toMatchObject({ succeeded: 0, failed: 1 });
      expect(
        prisma.weleticReconciliationIssue.updateMany,
      ).not.toHaveBeenCalled();
    });

    it("records a critical reconciliation issue when redemption recovery dead-letters", async () => {
      const failingJob = {
        id: "woutbox_redemption_recovery_dead",
        storeId: TEST_STORE_ID,
        jobType: "REDEMPTION_RECOVERY" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.failed,
        payload: {
          redemptionId: "wredemp_recovery_dead",
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: "wreward_recovery_dead",
          pointsCost: "200",
          shopifyDiscountCode: "WL-RECOVERY-DEAD",
          attemptCount: 4,
          sagaPhase: "compensating",
        },
        idempotencyKey: "discount_deactivate:wredemp_recovery_dead",
        attempts: 4,
        maxAttempts: 5,
        scheduledFor: new Date(Date.now() - 10_000),
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        errorLog: [],
      };

      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 }) // reap
        .mockResolvedValueOnce({ count: 1 }) // acquire lock
        .mockResolvedValueOnce({ count: 1 }); // transactional dead-letter
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        failingJob as any,
      ]);
      vi.mocked(prisma.weleticRewardRedemption.findUnique)
        .mockResolvedValueOnce({
          id: "wredemp_recovery_dead",
          storeId: "another_store",
          accountId: TEST_ACCOUNT_ID,
        } as any)
        .mockResolvedValueOnce({
          storeId: TEST_STORE_ID,
          shopifyDiscountCode: "WL-RECOVERY-REPLACED",
        } as any);
      vi.mocked(prisma.weleticReconciliationIssue.upsert).mockResolvedValueOnce(
        { id: "wrecon_redemption_recovery_dead" } as any,
      );

      const summary = await processOutboxJobsBatch({ batchSize: 1 });

      expect(summary.deadLettered).toBe(1);
      expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith({
        where: {
          storeId_kind_externalKey: {
            storeId: TEST_STORE_ID,
            kind: "redemption_recovery_dead_letter",
            externalKey: "wredemp_recovery_dead:compensating",
          },
        },
        create: expect.objectContaining({
          storeId: TEST_STORE_ID,
          externalKey: "wredemp_recovery_dead:compensating",
          kind: "redemption_recovery_dead_letter",
          severity: "critical",
          status: "open",
          details: expect.objectContaining({
            redemptionId: "wredemp_recovery_dead",
            shopifyDiscountCode: "WL-RECOVERY-REPLACED",
            sagaPhase: "compensating",
            remoteOutcome: "ambiguous",
            resolutionMarker: "redrive_or_manual_shopify_verification_required",
            outboxJobId: "woutbox_redemption_recovery_dead",
          }),
        }),
        update: expect.objectContaining({
          severity: "critical",
          status: "open",
          resolvedAt: null,
        }),
      });
    });

    it("keeps the recovery issue open when a redrive cannot audit a missing redemption", async () => {
      const redrivenJob = {
        id: "woutbox_redemption_recovery_redrive",
        storeId: TEST_STORE_ID,
        jobType: "REDEMPTION_RECOVERY" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.failed,
        payload: {
          redemptionId: "wredemp_recovery_redrive",
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: "wreward_recovery_redrive",
          pointsCost: "200",
          shopifyDiscountCode: "WL-RECOVERY-REDRIVE",
          attemptCount: 5,
          sagaPhase: "compensating",
        },
        idempotencyKey: "discount_deactivate:wredemp_recovery_redrive",
        attempts: 5,
        maxAttempts: 6,
        scheduledFor: new Date(Date.now() - 10_000),
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        errorLog: [],
      };

      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 }) // reap
        .mockResolvedValueOnce({ count: 1 }) // acquire lock
        .mockResolvedValueOnce({ count: 1 }); // transactional completion
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        redrivenJob as any,
      ]);
      vi.mocked(
        prisma.weleticRewardRedemption.findUnique,
      ).mockResolvedValueOnce(null);
      vi.mocked(
        prisma.weleticReconciliationIssue.updateMany,
      ).mockResolvedValueOnce({ count: 1 });

      const summary = await processOutboxJobsBatch({ batchSize: 1 });

      expect(summary.succeeded).toBe(1);
      expect(
        prisma.weleticReconciliationIssue.updateMany,
      ).not.toHaveBeenCalled();
    });

    it("resolves the recovery issue only after an audited Shopify deactivation", async () => {
      const redemptionId = "wredemp_recovery_audited";
      const redemptionMetadata = verifiedDiscountMetadata({
        redemptionId,
        rewardDefinitionId: "wreward_recovery_audited",
        discountCode: "WL-RECOVERY-AUDITED",
        rewardName: "Audited reward",
      });
      const redrivenJob = {
        id: "woutbox_redemption_recovery_audited",
        storeId: TEST_STORE_ID,
        jobType: "REDEMPTION_RECOVERY" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.failed,
        payload: {
          redemptionId,
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: "wreward_recovery_audited",
          pointsCost: "200",
          shopifyDiscountCode: "WL-RECOVERY-AUDITED",
          attemptCount: 5,
          sagaPhase: "compensating",
        },
        idempotencyKey: `discount_deactivate:${redemptionId}`,
        attempts: 5,
        maxAttempts: 6,
        scheduledFor: new Date(Date.now() - 10_000),
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        errorLog: [],
      };

      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        redrivenJob as any,
      ]);
      vi.mocked(
        prisma.weleticRewardRedemption.findUnique,
      ).mockResolvedValueOnce({
        id: redemptionId,
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_recovery_audited",
        status: WeleticRedemptionStatus.cancelled,
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-RECOVERY-AUDITED",
        shopifyDiscountId: "gid://shopify/DiscountCodeNode/audited",
        metadata: redemptionMetadata,
        rewardDefinition: { name: "Audited reward" },
      } as any);
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      vi.spyOn(
        shopifyDiscounts,
        "resolveShopifyOfflineCredentials",
      ).mockResolvedValueOnce({
        shopDomain: "test.myshopify.com",
        accessToken: "test-token",
        source: "app_session",
      });
      vi.spyOn(shopifyDiscounts, "lookupDiscountByCode").mockResolvedValueOnce({
        id: "gid://shopify/DiscountCodeNode/audited",
        code: "WL-RECOVERY-AUDITED",
        title: redemptionMetadata.shopifyDiscountOwnership.expectedTitle,
        status: "ACTIVE",
      });
      vi.spyOn(shopifyDiscounts, "deactivateDiscount").mockResolvedValueOnce(
        true,
      );
      vi.mocked(
        prisma.weleticReconciliationIssue.updateMany,
      ).mockResolvedValueOnce({ count: 1 });

      const summary = await processOutboxJobsBatch({ batchSize: 1 });

      expect(summary.succeeded).toBe(1);
      expect(prisma.weleticReconciliationIssue.updateMany).toHaveBeenCalledWith(
        {
          where: {
            storeId: TEST_STORE_ID,
            kind: "redemption_recovery_dead_letter",
            externalKey: `${redemptionId}:compensating`,
            status: "open",
          },
          data: {
            status: "resolved",
            resolvedAt: expect.any(Date),
            details: expect.objectContaining({
              shopifyDiscountCode: "WL-RECOVERY-AUDITED",
              remoteOutcome: "deactivated",
              resolutionMarker: "audited_redrive_completed",
              resolutionMethod: "outbox_redrive",
              resolvedAt: expect.any(String),
            }),
          },
        },
      );
    });

    it("2.5: extends retry capacity while orphan coupon reconciliation is still pending", async () => {
      const reconciliationCheckTime = Date.parse("2026-08-29T05:00:00.000Z");
      const redemptionId = "wredemp_reconcile_horizon";
      const failingJob = {
        id: "woutbox_reconcile_horizon",
        storeId: TEST_STORE_ID,
        jobType: "REDEMPTION_RECOVERY" as WeleticLoyaltyOutboxJobType,
        status: WeleticLoyaltyOutboxJobStatus.failed,
        payload: {
          redemptionId,
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: "wreward_referral",
          pointsCost: "0",
          shopifyDiscountCode: "WLR-RECONCILE",
          attemptCount: 4,
          sagaPhase: "compensating",
        },
        attempts: 4,
        maxAttempts: 5,
        scheduledFor: new Date(reconciliationCheckTime - 10_000),
        nextRetryAt: null,
        lockedAt: null,
        errorLog: [],
      };
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        failingJob as any,
      ]);
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
        id: redemptionId,
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_referral",
        status: WeleticRedemptionStatus.cancelled,
        pointsSpent: BigInt(0),
        shopifyDiscountCode: "WLR-RECONCILE",
        shopifyDiscountId: null,
        expiresAt: null,
        metadata: {
          referralId: "wreferral_reconcile",
          qualificationOrderId: "worder_reconcile",
          referralSide: "advocate",
          remoteProvisionAttemptedAt: new Date(
            reconciliationCheckTime - 120_000,
          ).toISOString(),
          remoteProvisionReconcileUntil: new Date(
            reconciliationCheckTime + 1,
          ).toISOString(),
          rewardSnapshot: {
            name: "Referral voucher",
            description: null,
            rewardType: "amount_off",
          },
        },
        rewardDefinition: { name: "Referral voucher" },
      } as any);

      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      vi.spyOn(
        shopifyDiscounts,
        "resolveShopifyOfflineCredentials",
      ).mockResolvedValue({
        shopDomain: "test.myshopify.com",
        accessToken: "test-token",
        source: "app_session",
      });
      vi.spyOn(shopifyDiscounts, "lookupDiscountByCode").mockResolvedValue(
        null,
      );
      const dateNowSpy = vi
        .spyOn(Date, "now")
        // The recovery lookup decides it is still inside the horizon.
        .mockReturnValueOnce(reconciliationCheckTime)
        // The deadline passes before the worker schedules the retry.
        .mockReturnValueOnce(reconciliationCheckTime + 1_000);

      const summary = await processOutboxJobsBatch({
        batchSize: 1,
        now: new Date(reconciliationCheckTime),
        workerId: "worker_reconciliation_boundary",
      });
      dateNowSpy.mockRestore();

      expect(summary.failed).toBe(1);
      expect(summary.deadLettered).toBe(0);
      expect(prisma.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: failingJob.id }),
          data: expect.objectContaining({
            status: WeleticLoyaltyOutboxJobStatus.failed,
            maxAttempts: 6,
            nextRetryAt: expect.any(Date),
          }),
        }),
      );
    });
  });

  // =========================================================================
  // 3. Domain Job Handlers Execution
  // =========================================================================
  describe("3. Domain Job Handlers Execution", () => {
    it("3.1: HOLDING_PERIOD_RELEASE writes EARN_ORDER ledger entry and enqueues METAFIELD_SYNC", async () => {
      const mockAccount = {
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        cachedPendingPoints: BigInt(150),
        cachedPointsBalance: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 0,
      };

      const mockOrder = {
        id: TEST_ORDER_ID,
        orderName: "#1001",
        externalId: "gid://shopify/Order/1001",
        status: "paid",
        refunds: [],
      };

      const mockTx = {
        weleticLoyaltyEarnGrant: {
          findUnique: vi.fn().mockResolvedValue({
            id: "wgrant_holding_1",
            storeId: TEST_STORE_ID,
            accountId: TEST_ACCOUNT_ID,
            orderId: TEST_ORDER_ID,
            status: "pending",
            grossPoints: BigInt(150),
            pendingPoints: BigInt(150),
            settledPoints: BigInt(0),
            reversedPoints: BigInt(0),
            order: mockOrder,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue(mockAccount),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticCommerceOrder: {
          findUnique: vi.fn().mockResolvedValue(mockOrder),
        },
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "wledger_holding_1",
            sequenceNumber: 1,
            pointsDelta: BigInt(150),
            balanceAfter: BigInt(150),
          }),
        },
        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "woutbox_metafield_1" }),
        },
      };

      vi.mocked(prisma.$transaction).mockImplementation(
        async (cb: any) => await cb(mockTx),
      );

      await handleHoldingPeriodRelease(TEST_STORE_ID, {
        orderId: TEST_ORDER_ID,
        accountId: TEST_ACCOUNT_ID,
        shopperId: TEST_SHOPPER_ID,
        pendingPoints: "150",
        holdingPeriodDays: 14,
        availableAt: new Date().toISOString(),
      });

      expect(mockTx.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
            pointsDelta: BigInt(150),
            idempotencyKey: `holding_release:${TEST_ORDER_ID}`,
          }),
        }),
      );

      expect(mockTx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: TEST_ACCOUNT_ID,
            storeId: TEST_STORE_ID,
            ledgerVersion: 0,
          },
          data: expect.objectContaining({
            cachedPointsBalance: BigInt(150),
            cachedPendingPoints: BigInt(0),
            ledgerVersion: 1,
          }),
        }),
      );

      expect(mockTx.weleticLoyaltyOutboxJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            jobType: "METAFIELD_SYNC",
          }),
        }),
      );
    });

    it("3.2: HOLDING_PERIOD_RELEASE cancels pending points without awarding if order was voided/refunded", async () => {
      const mockAccount = {
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        cachedPendingPoints: BigInt(150),
        cachedPointsBalance: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 0,
      };

      const mockVoidedOrder = {
        id: TEST_ORDER_ID,
        orderName: "#1001",
        externalId: "gid://shopify/Order/1001",
        status: "voided",
        refunds: [],
      };

      const mockTx = {
        weleticLoyaltyEarnGrant: {
          findUnique: vi.fn().mockResolvedValue({
            id: "wgrant_holding_1",
            storeId: TEST_STORE_ID,
            accountId: TEST_ACCOUNT_ID,
            orderId: TEST_ORDER_ID,
            status: "pending",
            grossPoints: BigInt(150),
            pendingPoints: BigInt(150),
            settledPoints: BigInt(0),
            reversedPoints: BigInt(0),
            lineEarns: [
              {
                id: "wlineearn_void_1",
                orderLineId: "wline_void_1",
                storeId: TEST_STORE_ID,
                awardedPoints: BigInt(150),
                reversedPoints: BigInt(0),
                isExcluded: false,
              },
            ],
            order: mockVoidedOrder,
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyOrderLineEarn: {
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue(mockAccount),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticCommerceOrder: {
          findUnique: vi.fn().mockResolvedValue(mockVoidedOrder),
        },
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "wledger_void_1" }),
        },
        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "woutbox_void_1" }),
        },
      };

      vi.mocked(prisma.$transaction).mockImplementation(
        async (cb: any) => await cb(mockTx),
      );

      await handleHoldingPeriodRelease(TEST_STORE_ID, {
        orderId: TEST_ORDER_ID,
        accountId: TEST_ACCOUNT_ID,
        shopperId: TEST_SHOPPER_ID,
        pendingPoints: "150",
        holdingPeriodDays: 14,
        availableAt: new Date().toISOString(),
      });

      expect(mockTx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: TEST_ACCOUNT_ID,
            storeId: TEST_STORE_ID,
            ledgerVersion: 0,
          },
          data: expect.objectContaining({
            cachedPendingPoints: BigInt(0),
            ledgerVersion: 1,
          }),
        }),
      );
      expect(mockTx.weleticLoyaltyEarnGrant.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "voided" }),
        }),
      );
      expect(mockTx.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
            pointsDelta: BigInt(0),
            pendingDelta: BigInt(-150),
            idempotencyKey: `holding_void:${TEST_ORDER_ID}`,
          }),
        }),
      );
    });

    it("3.3: legacy expiry jobs without exact policy identity fail closed", async () => {
      await handleInactivityExpiry(TEST_STORE_ID, {
        accountId: TEST_ACCOUNT_ID,
        lastActivityAt: new Date("2025-01-01").toISOString(),
        expiryMonths: 12,
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
    });

    it("3.3b: stale warning-only payloads never expire points", async () => {
      await handleInactivityExpiry(TEST_STORE_ID, {
        accountId: TEST_ACCOUNT_ID,
        lastActivityAt: new Date("2025-01-01").toISOString(),
        expiryMonths: 12,
        warningOnly: true,
      } as any);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
    });

    it("3.3c: policy-bound expiry clears the current clock after expiration", async () => {
      const expiryAt = new Date("2026-09-30T00:00:00.000Z");
      const mockAccount = {
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        cachedPointsBalance: BigInt(500),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(500),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1,
        nextExpiryDate: expiryAt,
        pointsExpiryPolicyVersion: 4,
        program: {
          status: "active",
          killSwitchActive: false,
          pointsExpiryDays: 0,
          pointsExpiryMonths: 12,
          pointsExpiryPolicyAnchorAt: new Date("2025-09-30T00:00:00.000Z"),
          pointsExpiryPolicyVersion: 4,
          activatedAt: new Date("2025-01-01T00:00:00.000Z"),
          createdAt: new Date("2025-01-01T00:00:00.000Z"),
        },
      };
      const mockTx = {
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue(mockAccount),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "wledger_expire_policy_1",
            sequenceNumber: 2,
            pointsDelta: BigInt(-500),
            balanceAfter: BigInt(0),
          }),
        },
        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "woutbox_metafield_policy" }),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementation(
        async (cb: any) => await cb(mockTx),
      );

      await handleInactivityExpiry(
        TEST_STORE_ID,
        {
          accountId: TEST_ACCOUNT_ID,
          lastActivityAt: "2025-09-30T00:00:00.000Z",
          expiryMonths: 12,
          expiryDays: 0,
          expiryAt: expiryAt.toISOString(),
          stage: "expire",
          policyVersion: 4,
        },
        undefined,
        expiryAt,
      );

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      expect(mockTx.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entryType: WeleticPointsLedgerEntryType.EXPIRATION,
            pointsDelta: BigInt(-500),
            idempotencyKey: `expire:${TEST_ACCOUNT_ID}:${expiryAt.toISOString()}`,
          }),
        }),
      );
      expect(mockTx.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            nextExpiryDate: null,
            pointsExpiryJobsScheduledAt: null,
          },
        }),
      );
    });

    it("3.3d: a superseded expiry job cannot debit a newly active balance", async () => {
      const staleExpiryAt = new Date("2026-09-30T00:00:00.000Z");
      const mockTx = {
        weleticLoyaltyAccount: {
          findUnique: vi.fn().mockResolvedValue({
            id: TEST_ACCOUNT_ID,
            storeId: TEST_STORE_ID,
            cachedPointsBalance: BigInt(500),
            nextExpiryDate: new Date("2026-10-31T00:00:00.000Z"),
            pointsExpiryPolicyVersion: 4,
            program: {
              status: "active",
              killSwitchActive: false,
              pointsExpiryDays: 0,
              pointsExpiryMonths: 12,
              pointsExpiryPolicyVersion: 4,
            },
          }),
        },
        weleticPointsLedgerEntry: {
          findUnique: vi.fn(),
          create: vi.fn(),
        },
      };
      vi.mocked(prisma.$transaction).mockImplementation(
        async (cb: any) => await cb(mockTx),
      );

      await handleInactivityExpiry(
        TEST_STORE_ID,
        {
          accountId: TEST_ACCOUNT_ID,
          lastActivityAt: "2025-09-30T00:00:00.000Z",
          expiryMonths: 12,
          expiryAt: staleExpiryAt.toISOString(),
          stage: "expire",
          policyVersion: 4,
        },
        undefined,
        staleExpiryAt,
      );

      expect(mockTx.weleticPointsLedgerEntry.create).not.toHaveBeenCalled();
    });

    it("3.4: TIER_REVIEW enqueues follow-up TIER_REVIEW on grace period and METAFIELD_SYNC", async () => {
      const mockOutboxCreate = vi
        .fn()
        .mockResolvedValue({ id: "woutbox_tier_followup" });
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findUnique).mockResolvedValue(
        null,
      );
      vi.mocked(prisma.weleticLoyaltyOutboxJob.create).mockImplementation(
        mockOutboxCreate,
      );

      vi.spyOn(
        await import("@/lib/weletic/loyalty/tier-lifecycle"),
        "evaluateTierMaintenanceCycle",
      ).mockResolvedValueOnce({
        accountId: TEST_ACCOUNT_ID,
        previousTierId: "wtier_gold",
        newTierId: "wtier_gold",
        status: "IN_GRACE_PERIOD",
        gracePeriodExpiresAt: new Date(Date.now() + 30 * 86400000),
        qualifyingSpend: BigInt(5000),
        qualifyingPoints: BigInt(50),
        reviewPeriod: "ROLLING_12M",
        reason: "Entered 30-day grace period",
        tierChanged: false,
      });

      await handleTierReview(TEST_STORE_ID, {
        accountId: TEST_ACCOUNT_ID,
        reviewPeriod: "ROLLING_12M",
      });

      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      // Verifies 2 outbox jobs enqueued: 1 follow-up TIER_REVIEW and 1 METAFIELD_SYNC
      expect(
        mockOutboxCreate.mock.calls.map(([call]) => call.data.jobType),
      ).toEqual(["TIER_REVIEW", "METAFIELD_SYNC"]);
    });

    it("3.5a: compensated referral recovery retries a miss, then persists and deactivates the orphan coupon", async () => {
      const rewardSnapshot = createReferralCouponRewardSnapshot({
        identity: {
          storeId: TEST_STORE_ID,
          referralId: "wreferral_orphan",
          qualificationOrderId: "worder_orphan",
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: "wreward_referral",
          side: "advocate",
        },
        reward: {
          id: "wreward_referral",
          name: "Referral voucher",
          description: null,
          rewardType: "amount_off",
          salesChannel: "online_store",
          discountValue: 1000,
          maxDiscountValue: null,
          minOrderAmount: null,
          appliesToResource: "entire_order",
          entitledCollectionIds: [],
          entitledProductIds: [],
          entitledVariantIds: [],
          combinesWithProductDiscounts: false,
          combinesWithOrderDiscounts: false,
          combinesWithShippingDiscounts: false,
          usageLimit: 1,
          usageLimitPerCustomer: 1,
          expiresInDays: 30,
        },
        qualifiedAt: new Date("2026-08-29T04:00:00.000Z"),
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
        shopifyCustomerId: "customer_referral_orphan",
      });
      const redemption = {
        id: "wredemp_referral_orphan",
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_referral",
        status: WeleticRedemptionStatus.cancelled,
        pointsSpent: BigInt(0),
        shopifyDiscountCode: rewardSnapshot.discountCode,
        shopifyDiscountId: null,
        expiresAt: new Date(rewardSnapshot.expiresAt!),
        metadata: {
          referralId: "wreferral_orphan",
          qualificationOrderId: "worder_orphan",
          referralSide: "advocate",
          remoteProvisionAttemptedAt: "2026-08-29T04:00:00.000Z",
          remoteProvisionReconcileUntil: new Date(
            Date.now() + 120_000,
          ).toISOString(),
          rewardSnapshot,
          shopifyDiscountOwnershipFingerprint:
            rewardSnapshot.ownershipFingerprint,
          shopifyDiscountProvisioningName: rewardSnapshot.provisioningName,
          shopifyDiscountExpectedTitle: rewardSnapshot.expectedTitle,
        },
        rewardDefinition: { name: "Referral voucher" },
      };
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
        redemption as any,
      );
      vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
        count: 1,
      });
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
        id: TEST_ACCOUNT_ID,
        storeId: TEST_STORE_ID,
        status: "active",
        shopper: { shopifyCustomerId: "customer_referral_orphan" },
      } as any);
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        shopCurrency: "USD",
      } as any);

      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      vi.spyOn(
        shopifyDiscounts,
        "resolveShopifyOfflineCredentials",
      ).mockResolvedValue({
        shopDomain: "test.myshopify.com",
        accessToken: "test-token",
        source: "app_session",
      });
      const lookupSpy = vi
        .spyOn(shopifyDiscounts, "lookupDiscountByCode")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "gid://shopify/DiscountCodeNode/referral_orphan",
          code: rewardSnapshot.discountCode,
          title: rewardSnapshot.expectedTitle,
          status: "ACTIVE",
          configuration: {
            kind: "basic",
            startsAt: rewardSnapshot.startsAt,
            endsAt: rewardSnapshot.expiresAt,
            usageLimit: 1,
            appliesOncePerCustomer: true,
            appliesOnOneTimePurchase: true,
            appliesOnSubscription: false,
            recurringCycleLimit: 1,
            combinesWith: {
              orderDiscounts: false,
              productDiscounts: false,
              shippingDiscounts: false,
            },
            customerSelection: {
              kind: "customers",
              customerIds: ["gid://shopify/Customer/customer_referral_orphan"],
            },
            minimumRequirement: null,
            basicValue: {
              kind: "amount",
              amount: "10.00",
              currencyCode: "USD",
              appliesOnEachItem: false,
            },
            basicItems: { kind: "all" },
          },
        } as any);
      const deactivateSpy = vi
        .spyOn(shopifyDiscounts, "deactivateDiscount")
        .mockResolvedValue(true);
      const payload = {
        redemptionId: redemption.id,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: redemption.rewardDefinitionId,
        pointsCost: "0",
        shopifyDiscountCode: redemption.shopifyDiscountCode,
        attemptCount: 0,
        sagaPhase: "compensating" as const,
      };

      await expect(
        handleRedemptionRecovery(TEST_STORE_ID, payload),
      ).rejects.toThrow(
        `Shopify referral discount ${rewardSnapshot.discountCode} is not visible yet; reconciliation remains pending.`,
      );
      await expect(
        handleRedemptionRecovery(TEST_STORE_ID, payload),
      ).resolves.toBe("dedicated_referral_recovery");

      expect(lookupSpy).toHaveBeenCalledTimes(2);
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: redemption.id,
          storeId: TEST_STORE_ID,
          status: {
            in: [
              WeleticRedemptionStatus.cancelled,
              WeleticRedemptionStatus.expired,
              WeleticRedemptionStatus.failed,
            ],
          },
          shopifyDiscountId: null,
        }),
        data: {
          shopifyDiscountId: "gid://shopify/DiscountCodeNode/referral_orphan",
        },
      });
      expect(deactivateSpy).toHaveBeenCalledWith(
        "test.myshopify.com",
        "test-token",
        "gid://shopify/DiscountCodeNode/referral_orphan",
      );
    });

    it("3.5b: compensated referral recovery completes when cancellation preceded every remote attempt", async () => {
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
        id: "wredemp_referral_not_attempted",
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_referral",
        status: WeleticRedemptionStatus.cancelled,
        pointsSpent: BigInt(0),
        shopifyDiscountCode: "WLR-NOT-ATTEMPTED",
        shopifyDiscountId: null,
        expiresAt: null,
        metadata: {
          referralId: "wreferral_not_attempted",
          qualificationOrderId: "worder_not_attempted",
          referralSide: "advocate",
        },
        rewardDefinition: { name: "Referral voucher" },
      } as any);

      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      const credentialsSpy = vi.spyOn(
        shopifyDiscounts,
        "resolveShopifyOfflineCredentials",
      );
      const lookupSpy = vi.spyOn(shopifyDiscounts, "lookupDiscountByCode");

      await expect(
        handleRedemptionRecovery(TEST_STORE_ID, {
          redemptionId: "wredemp_referral_not_attempted",
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: "wreward_referral",
          pointsCost: "0",
          shopifyDiscountCode: "WLR-NOT-ATTEMPTED",
          attemptCount: 0,
          sagaPhase: "compensating",
        }),
      ).resolves.toBe("dedicated_referral_recovery");

      expect(credentialsSpy).not.toHaveBeenCalled();
      expect(lookupSpy).not.toHaveBeenCalled();
    });

    it("3.5: REDEMPTION_RECOVERY compensates stuck provisioning saga by restoring points", async () => {
      const mockRedemption = {
        id: "wredemp_stuck_1",
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_1",
        status: WeleticRedemptionStatus.provisioning,
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-FAILCODE",
        rewardDefinition: { name: "$10 Voucher" },
      };

      const mockTx = {
        weleticRewardRedemption: {
          findUnique: vi.fn().mockResolvedValue(mockRedemption),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyAccount: {
          findFirst: vi.fn().mockResolvedValue({
            status: "active",
            metadata: null,
          }),
          findUnique: vi.fn().mockResolvedValue({
            id: TEST_ACCOUNT_ID,
            cachedPointsBalance: BigInt(100),
            lifetimePointsEarned: BigInt(500),
            lifetimePointsRedeemed: BigInt(200),
            ledgerVersion: 2,
          }),
          update: vi.fn().mockResolvedValue({}),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "wledger_comp_1",
            sequenceNumber: 3,
            pointsDelta: BigInt(200),
            balanceAfter: BigInt(300),
          }),
        },
        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "woutbox_metafield_3" }),
        },
      };

      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
        mockRedemption as any,
      );

      vi.mocked(prisma.$transaction).mockImplementation(
        async (cb: any) => await cb(mockTx),
      );

      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      vi.spyOn(
        shopifyDiscounts,
        "resolveShopifyOfflineCredentials",
      ).mockResolvedValue({
        shopDomain: "test.myshopify.com",
        accessToken: "test-token",
        source: "app_session",
      });
      vi.spyOn(shopifyDiscounts, "lookupDiscountByCode").mockResolvedValue(
        null,
      );

      await handleRedemptionRecovery(TEST_STORE_ID, {
        redemptionId: "wredemp_stuck_1",
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_1",
        pointsCost: "200",
        shopifyDiscountCode: "WL-FAILCODE",
        attemptCount: 3,
        sagaPhase: "provisioning",
      });

      expect(mockTx.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: "wredemp_stuck_1" }),
          data: expect.objectContaining({
            status: WeleticRedemptionStatus.cancelled,
          }),
        }),
      );

      expect(mockTx.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
            pointsDelta: BigInt(200),
            idempotencyKey: "saga_compensate:wredemp_stuck_1",
          }),
        }),
      );
    });

    it("keeps points reserved when an active remote voucher has unverifiable ownership", async () => {
      const redemption = {
        id: "wredemp_unverified_active",
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_unverified",
        status: WeleticRedemptionStatus.provisioning,
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-UNVERIFIED-ACTIVE",
        shopifyDiscountId: null,
        metadata: { rewardSnapshot: { name: "Legacy reward" } },
        rewardDefinition: { name: "Legacy reward" },
        account: { status: "active", metadata: null, shopper: {} },
      };
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
        redemption as any,
      );
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      vi.spyOn(
        shopifyDiscounts,
        "resolveShopifyOfflineCredentials",
      ).mockResolvedValue({
        shopDomain: "test.myshopify.com",
        accessToken: "test-token",
        source: "app_session",
      });
      vi.spyOn(shopifyDiscounts, "lookupDiscountByCode").mockResolvedValue({
        id: "gid://shopify/DiscountCodeNode/unverified",
        code: redemption.shopifyDiscountCode,
        title: "Legacy reward (WL-UNVERIFIED-ACTIVE)",
        status: "ACTIVE",
      });

      await expect(
        handleRedemptionRecovery(TEST_STORE_ID, {
          redemptionId: redemption.id,
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: redemption.rewardDefinitionId,
          pointsCost: "200",
          shopifyDiscountCode: redemption.shopifyDiscountCode,
          attemptCount: 3,
          sagaPhase: "provisioning",
        }),
      ).rejects.toThrow("Cannot verify Shopify discount ownership");
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("3.6: REDEMPTION_RECOVERY expires an unused voucher, refunds points once, and deactivates Shopify", async () => {
      const redemptionMetadata = verifiedDiscountMetadata({
        redemptionId: "wredemp_expired_1",
        rewardDefinitionId: "wreward_1",
        discountCode: "WL-EXPIRED",
        rewardName: "$10 Voucher",
      });
      const redemption = {
        id: "wredemp_expired_1",
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_1",
        status: WeleticRedemptionStatus.issued,
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-EXPIRED",
        shopifyDiscountId: "gid://shopify/DiscountCodeNode/expired_1",
        expiresAt: new Date(Date.now() - 60_000),
        metadata: redemptionMetadata,
        rewardDefinition: { name: "$10 Voucher" },
      };
      const mockTx = {
        weleticRewardRedemption: {
          findUnique: vi.fn().mockResolvedValue(redemption),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticLoyaltyAccount: {
          findFirst: vi.fn().mockResolvedValue({
            status: "active",
            metadata: null,
          }),
          findUnique: vi.fn().mockResolvedValue({
            id: TEST_ACCOUNT_ID,
            storeId: TEST_STORE_ID,
            cachedPointsBalance: BigInt(100),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(500),
            lifetimePointsRedeemed: BigInt(200),
            ledgerVersion: 2,
            status: "active",
          }),
          updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        },
        weleticPointsLedgerEntry: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({
            id: "wledger_expiry_refund_1",
            sequenceNumber: 3,
            pointsDelta: BigInt(200),
            balanceAfter: BigInt(300),
          }),
        },
        weleticLoyaltyOutboxJob: {
          findUnique: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "woutbox_expiry_sync_1" }),
        },
      };

      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
        redemption as any,
      );
      vi.mocked(prisma.$transaction).mockImplementation(
        async (cb: any) => await cb(mockTx),
      );

      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      vi.spyOn(
        shopifyDiscounts,
        "resolveShopifyOfflineCredentials",
      ).mockResolvedValue({
        shopDomain: "test.myshopify.com",
        accessToken: "test-token",
        source: "app_session",
      });
      vi.spyOn(shopifyDiscounts, "lookupDiscountByCode").mockResolvedValue({
        id: redemption.shopifyDiscountId,
        code: redemption.shopifyDiscountCode,
        title: redemptionMetadata.shopifyDiscountOwnership.expectedTitle,
        status: "ACTIVE",
      });
      const deactivateSpy = vi
        .spyOn(shopifyDiscounts, "deactivateDiscount")
        .mockResolvedValue(true);

      await handleRedemptionRecovery(TEST_STORE_ID, {
        redemptionId: redemption.id,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: redemption.rewardDefinitionId,
        pointsCost: "200",
        shopifyDiscountCode: redemption.shopifyDiscountCode,
        attemptCount: 0,
        sagaPhase: "expiry",
      });

      expect(mockTx.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: redemption.id }),
          data: expect.objectContaining({
            status: WeleticRedemptionStatus.expired,
          }),
        }),
      );
      expect(mockTx.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            pointsDelta: BigInt(200),
            idempotencyKey: `saga_compensate:${redemption.id}`,
          }),
        }),
      );
      expect(deactivateSpy).toHaveBeenCalledWith(
        "test.myshopify.com",
        "test-token",
        redemption.shopifyDiscountId,
      );
    });

    it("fails closed instead of trusting a legacy persisted Shopify discount ID", async () => {
      const redemption = {
        id: "wredemp_legacy_discount_id",
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_legacy",
        status: WeleticRedemptionStatus.cancelled,
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-LEGACY-ID",
        shopifyDiscountId: "gid://shopify/DiscountCodeNode/legacy",
        metadata: { rewardSnapshot: { name: "Legacy reward" } },
        rewardDefinition: { name: "Legacy reward" },
      };
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
        redemption as any,
      );
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      vi.spyOn(
        shopifyDiscounts,
        "resolveShopifyOfflineCredentials",
      ).mockResolvedValue({
        shopDomain: "test.myshopify.com",
        accessToken: "test-token",
        source: "app_session",
      });
      vi.spyOn(shopifyDiscounts, "lookupDiscountByCode").mockResolvedValue({
        id: redemption.shopifyDiscountId,
        code: redemption.shopifyDiscountCode,
        title: "Legacy reward (WL-LEGACY-ID)",
        status: "ACTIVE",
      });
      const deactivateSpy = vi.spyOn(shopifyDiscounts, "deactivateDiscount");

      await expect(
        handleRedemptionRecovery(TEST_STORE_ID, {
          redemptionId: redemption.id,
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: redemption.rewardDefinitionId,
          pointsCost: "200",
          shopifyDiscountCode: redemption.shopifyDiscountCode,
          attemptCount: 0,
          sagaPhase: "compensating",
        }),
      ).rejects.toThrow("Cannot verify Shopify discount ownership");
      expect(deactivateSpy).not.toHaveBeenCalled();
    });

    it("does not deactivate a persisted Shopify GID that disagrees with the verified code", async () => {
      const redemptionMetadata = verifiedDiscountMetadata({
        redemptionId: "wredemp_swapped_discount_id",
        rewardDefinitionId: "wreward_swapped",
        discountCode: "WL-SWAPPED-ID",
        rewardName: "Swapped reward",
      });
      const redemption = {
        id: "wredemp_swapped_discount_id",
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_swapped",
        status: WeleticRedemptionStatus.cancelled,
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-SWAPPED-ID",
        shopifyDiscountId: "gid://shopify/DiscountCodeNode/wrong-stored-id",
        metadata: redemptionMetadata,
        rewardDefinition: { name: "Swapped reward" },
      };
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
        redemption as any,
      );
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      vi.spyOn(
        shopifyDiscounts,
        "resolveShopifyOfflineCredentials",
      ).mockResolvedValue({
        shopDomain: "test.myshopify.com",
        accessToken: "test-token",
        source: "app_session",
      });
      vi.spyOn(shopifyDiscounts, "lookupDiscountByCode").mockResolvedValue({
        id: "gid://shopify/DiscountCodeNode/verified-code-id",
        code: redemption.shopifyDiscountCode,
        title: redemptionMetadata.shopifyDiscountOwnership.expectedTitle,
        status: "ACTIVE",
      });
      const deactivateSpy = vi.spyOn(shopifyDiscounts, "deactivateDiscount");

      await expect(
        handleRedemptionRecovery(TEST_STORE_ID, {
          redemptionId: redemption.id,
          accountId: TEST_ACCOUNT_ID,
          rewardDefinitionId: redemption.rewardDefinitionId,
          pointsCost: "200",
          shopifyDiscountCode: redemption.shopifyDiscountCode,
          attemptCount: 0,
          sagaPhase: "compensating",
        }),
      ).rejects.toThrow(
        "Persisted Shopify discount ID does not match the verified code",
      );
      expect(deactivateSpy).not.toHaveBeenCalled();
    });

    it("3.7: REDEMPTION_RECOVERY never refunds or deactivates a used voucher", async () => {
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
        id: "wredemp_used_1",
        storeId: TEST_STORE_ID,
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_1",
        status: WeleticRedemptionStatus.used,
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-USED",
        shopifyDiscountId: "gid://shopify/DiscountCodeNode/used_1",
        expiresAt: new Date(Date.now() - 60_000),
        rewardDefinition: { name: "$10 Voucher" },
      } as any);
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      const deactivateSpy = vi.spyOn(shopifyDiscounts, "deactivateDiscount");

      await handleRedemptionRecovery(TEST_STORE_ID, {
        redemptionId: "wredemp_used_1",
        accountId: TEST_ACCOUNT_ID,
        rewardDefinitionId: "wreward_1",
        pointsCost: "200",
        shopifyDiscountCode: "WL-USED",
        attemptCount: 0,
        sagaPhase: "expiry",
      });

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(deactivateSpy).not.toHaveBeenCalled();
    });
  });
});
