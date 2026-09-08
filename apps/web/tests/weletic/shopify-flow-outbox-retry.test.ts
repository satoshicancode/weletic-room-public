import { dispatchShopifyFlowTrigger } from "@/lib/weletic/loyalty/flow-triggers";
import { processOutboxJobsBatch } from "@/lib/weletic/loyalty/outbox-worker";
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
    vi.clearAllMocks();
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
