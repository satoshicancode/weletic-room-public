import { dispatchShopifyFlowTrigger } from "@/lib/weletic/loyalty/flow-triggers";
import { processOutboxJobsBatch } from "@/lib/weletic/loyalty/outbox-worker";
import { reviewFlowCandidateWhere } from "@/lib/weletic/reviews/flow-candidates";
import { ReviewFlowDeferredError } from "@/lib/weletic/reviews/flow-errors";
import { Prisma, type WeleticLoyaltyOutboxJob } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  updateMany: vi.fn(),
  findAccount: vi.fn(),
  findStore: vi.fn(),
  queryRaw: vi.fn(),
  handleFlowTrigger: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const db = {
    weleticLoyaltyOutboxJob: {
      findMany: mocks.findMany,
      findUnique: vi.fn(),
      updateMany: mocks.updateMany,
    },
    weleticLoyaltyAccount: { findFirst: mocks.findAccount },
    weleticShopifyStore: { findUnique: mocks.findStore },
    $queryRaw: mocks.queryRaw,
  };
  return {
    prisma: {
      ...db,
      $transaction: async (operation: (tx: typeof db) => Promise<unknown>) =>
        operation(db),
    },
  };
});

vi.mock("@/lib/weletic/loyalty/flow-trigger-worker", () => ({
  handleFlowTrigger: mocks.handleFlowTrigger,
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: async ({ fn }: { fn: () => Promise<unknown> }) => fn(),
}));

describe("Shopify Flow durable retry transitions", () => {
  const store = {
    id: "wstore_flow_retry",
    complianceState: "active",
    shopCurrency: "USD",
    currencyVerifiedAt: new Date("2026-09-05T00:00:00.000Z"),
    installationGeneration: "sgen_flow_retry",
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findStore.mockResolvedValue(store);
    mocks.queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      if (query.sql.includes("WeleticShopifyStore")) return [store];
      if (query.sql.includes("WeleticLoyaltyProgram"))
        return [
          {
            id: "wprogram_flow_retry",
            storeId: store.id,
            status: "active",
            killSwitchActive: false,
            metadata: null,
          },
        ];
      return [];
    });
    mocks.findAccount.mockResolvedValue({
      status: "active",
      shopper: { shopifyCustomerId: "42" },
      store: { projectId: "workspace_flow_retry" },
    });
    mocks.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
  });
  it("excludes only disabled or missing-settings review Flow before the page limit", async () => {
    mocks.findMany.mockResolvedValueOnce([]);
    await processOutboxJobsBatch({ batchSize: 50 });
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 50,
        where: expect.objectContaining({
          AND: reviewFlowCandidateWhere(),
        }),
      }),
    );
  });

  it.each(
    [{}, null, "scalar", { handle: null }, { handle: 42 }].flatMap((payload) =>
      ["active", "suspended", "frozen"].map((state) => ({ payload, state })),
    ),
  )(
    "dead-letters malformed $payload before $state authority no-ops",
    async ({ payload, state }) => {
      const now = new Date();
      const job: WeleticLoyaltyOutboxJob = {
        id: "woutbox_invalid_flow",
        storeId: store.id,
        jobType: "FLOW_TRIGGER",
        status: "pending",
        payload,
        idempotencyKey: "invalid-flow-fixture",
        attempts: 0,
        maxAttempts: 5,
        scheduledFor: now,
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        errorLog: [],
        priority: 0,
        processedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      mocks.findMany.mockResolvedValueOnce([job]);
      mocks.findStore.mockResolvedValue({
        ...store,
        storeAccessState: state === "suspended" ? "suspended" : "active",
        complianceState: state === "frozen" ? "frozen" : "active",
      });
      const result = await processOutboxJobsBatch({ batchSize: 1 });
      expect(result).toMatchObject({ succeeded: 0, deadLettered: 1 });
      expect(mocks.handleFlowTrigger).not.toHaveBeenCalled();
      expect(mocks.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: job.id }),
          data: expect.objectContaining({
            status: "dead_letter",
            lastError: "Invalid Shopify Flow payload.",
          }),
        }),
      );
      expect(
        mocks.updateMany.mock.calls.some(
          ([call]) => call.data.status === "completed",
        ),
      ).toBe(false);
    },
  );

  it.each(["weletic-review-submitted", "weletic-review-published"])(
    "restores the exact %s queue claim on pre-transport deferral, even during suspension",
    async (handle) => {
      const now = new Date();
      const job: WeleticLoyaltyOutboxJob = {
        id: "woutbox_review_deferral",
        storeId: store.id,
        jobType: "FLOW_TRIGGER",
        status: "pending",
        payload: {
          handle,
          reviewId: `wreview_${"a".repeat(20)}`,
          version: 1,
          installationGeneration: store.installationGeneration,
          occurredAt: now.toISOString(),
          rating: 1,
          verifiedPurchase: true,
        },
        idempotencyKey: `flow_trigger:${handle}:fixture`,
        attempts: 2,
        maxAttempts: 5,
        scheduledFor: now,
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        errorLog: [],
        priority: 0,
        processedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      mocks.findMany.mockResolvedValueOnce([job]);
      mocks.findStore.mockResolvedValue({
        ...store,
        storeAccessState: "suspended",
      });
      const deferred = new ReviewFlowDeferredError();
      mocks.handleFlowTrigger.mockRejectedValueOnce(deferred);
      const summary = await processOutboxJobsBatch({ batchSize: 1 });
      expect(mocks.handleFlowTrigger).toHaveBeenCalledTimes(1);
      expect(mocks.findAccount).not.toHaveBeenCalled();
      expect(summary).toMatchObject({
        processed: 0,
        succeeded: 0,
        failed: 0,
        deadLettered: 0,
        skipped: 1,
      });
      expect(mocks.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: job.id,
          storeId: job.storeId,
          status: "processing",
          attempts: 3,
          lockedAt: expect.any(Date),
          lockedBy: expect.any(String),
        }),
        data: {
          status: "pending",
          lockedAt: null,
          lockedBy: null,
          attempts: 2,
          nextRetryAt: deferred.retryAt,
        },
      });
      expect(
        mocks.updateMany.mock.calls.some(
          ([call]) => call.data.status === "completed",
        ),
      ).toBe(false);
    },
  );

  it.each([
    { code: "INTERNAL_SERVER_ERROR", expectedStatus: "failed" },
    { code: "ACCESS_DENIED", expectedStatus: "dead_letter" },
  ])(
    "persists $expectedStatus after the first HTTP 200 $code failure",
    async ({ code, expectedStatus }) => {
      const now = new Date();
      const job: WeleticLoyaltyOutboxJob = {
        id: "woutbox_flow_retry",
        storeId: store.id,
        jobType: "FLOW_TRIGGER",
        status: "pending",
        payload: {
          accountId: "waccount_flow_retry",
          handle: "weletic-points-earned",
          pointsDelta: "10",
          pointsBalance: "20",
          reason: "test",
          installationGeneration: store.installationGeneration,
        },
        idempotencyKey: "flow_trigger:weletic-points-earned:test",
        attempts: 0,
        maxAttempts: 5,
        scheduledFor: now,
        nextRetryAt: null,
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        errorLog: [],
        priority: 0,
        processedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      mocks.findMany.mockResolvedValueOnce([job]);
      // Run the real HTTP-envelope classifier inside the real outbox dispatch
      // loop; only Prisma persistence and the remote response are simulated.
      mocks.handleFlowTrigger.mockImplementationOnce(() =>
        dispatchShopifyFlowTrigger({
          shopDomain: "example.myshopify.com",
          offlineToken: "test-token",
          handle: "weletic-points-earned",
          payload: {
            customerGid: "42",
            pointsDelta: "10",
            pointsBalance: "20",
            reason: "test",
          },
          customFetch: async () =>
            new Response(
              JSON.stringify({
                errors: [
                  { message: "GraphQL request failed", extensions: { code } },
                ],
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            ),
        }),
      );

      const summary = await processOutboxJobsBatch({ batchSize: 1 });

      expect(mocks.handleFlowTrigger).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({
        processed: 1,
        succeeded: 0,
        failed: expectedStatus === "failed" ? 1 : 0,
        deadLettered: expectedStatus === "dead_letter" ? 1 : 0,
      });
      expect(mocks.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: job.id }),
          data: expect.objectContaining({
            status: expectedStatus,
            lastError: "GraphQL request failed",
            ...(expectedStatus === "failed"
              ? { nextRetryAt: expect.any(Date) }
              : {}),
          }),
        }),
      );
    },
  );
});
