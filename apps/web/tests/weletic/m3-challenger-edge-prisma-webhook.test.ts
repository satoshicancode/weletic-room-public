import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));

import { prisma, createPrismaClient } from "../../lib/prisma";
import { prismaEdge } from "../../lib/prisma/edge";
import {
  initQueueConsumerPrisma,
  processQueueMessage,
  handleQueueBatch,
  type QueueConsumerEnv,
  type QueueMessageItem,
} from "../../workers/queue-consumer/src/index";
import {
  initCronWorkerPrisma,
  recoverStalledWebhooksJob,
  scheduledHandler,
  CRON_SCHEDULE_5_MIN,
  type CronWorkerEnv,
  type QueueSender,
} from "../../workers/cron-triggers/src/index";

function createMockD1Database(mockRows: any[] = []) {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: mockRows, success: true, meta: {} }),
    raw: vi.fn().mockResolvedValue(mockRows.map(r => Object.values(r))),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    first: vi.fn().mockResolvedValue(mockRows[0] ?? null),
  };
  return {
    prepare: vi.fn().mockReturnValue(statement),
    batch: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue({ count: 1, duration: 1 }),
    statement,
  };
}

describe("Milestone 3 Challenger: Adversarial Edge Prisma & Webhook Recovery Stress", () => {
  const originalPrisma = (globalThis as any).prisma;
  const originalDB = (globalThis as any).DB;
  const originalBoundD1 = (globalThis as any).__boundD1;

  beforeEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).prisma;
    delete (globalThis as any).DB;
    delete (globalThis as any).__boundD1;
  });

  afterEach(() => {
    (globalThis as any).prisma = originalPrisma;
    (globalThis as any).DB = originalDB;
    (globalThis as any).__boundD1 = originalBoundD1;
  });

  // =========================================================================
  // 1. ADVERSARIAL STRESS: EDGE PRISMA PROXY CONCURRENCY & BINDING
  // =========================================================================
  describe("1. Adversarial Edge Prisma Proxy Stress", () => {
    it("1.1 Concurrency race: 50 simultaneous queries dispatched during worker cold start binding", async () => {
      const mockStoreData = {
        id: "store_concurrent_test",
        shopDomain: "concurrent-shop.myshopify.com",
      };

      const mockFindUnique = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return mockStoreData;
      });

      const dynamicClient: any = {
        weleticShopifyStore: {
          findUnique: mockFindUnique,
        },
      };

      // Set initial dynamic client
      (globalThis as any).prisma = dynamicClient;

      // Dispatch 25 queries BEFORE rebinding
      const earlyQueries = Array.from({ length: 25 }, async (_, i) => {
        if (i === 12) {
          // In the middle of flight, a new client is assigned
          (globalThis as any).prisma = dynamicClient;
        }
        return prisma.weleticShopifyStore.findUnique({
          where: { shopDomain: `shop-${i}.myshopify.com` },
        });
      });

      // Dispatch 25 queries AFTER
      const lateQueries = Array.from({ length: 25 }, async (_, i) => {
        return prisma.weleticShopifyStore.findUnique({
          where: { shopDomain: `shop-${i + 25}.myshopify.com` },
        });
      });

      const allResults = await Promise.all([...earlyQueries, ...lateQueries]);

      expect(allResults).toHaveLength(50);
      expect(mockFindUnique).toHaveBeenCalledTimes(50);
      allResults.forEach((res) => {
        expect(res).toEqual(mockStoreData);
      });
    });

    it("1.2 Concurrent worker initialization: multiple cold-start events in same isolate share cached instance", () => {
      const mockD1 = createMockD1Database();
      const env: QueueConsumerEnv = { DB: mockD1 as any };

      const instances = Array.from({ length: 20 }, () => initQueueConsumerPrisma(env));

      // All returned instances should be strictly identical (cached)
      const first = instances[0];
      instances.forEach((inst) => {
        expect(inst).toBe(first);
      });
      expect((globalThis as any).__boundD1).toBe(mockD1);
    });

    it("1.3 Re-binding on D1 change: handles database re-connection / tenant switch dynamically", () => {
      const mockD1A = createMockD1Database();
      const mockD1B = createMockD1Database();

      const clientA = initQueueConsumerPrisma({ DB: mockD1A as any });
      expect((globalThis as any).__boundD1).toBe(mockD1A);

      // Same D1 returns cached instance
      const clientA2 = initQueueConsumerPrisma({ DB: mockD1A as any });
      expect(clientA2).toBe(clientA);

      // Different D1 invalidates and creates new client
      const clientB = initQueueConsumerPrisma({ DB: mockD1B as any });
      expect((globalThis as any).__boundD1).toBe(mockD1B);
      expect(clientB).not.toBe(clientA);

      // Cron worker init also adheres to cache invalidation
      const cronClientB = initCronWorkerPrisma({ DB: mockD1B as any });
      expect(cronClientB).toBe(clientB);
    });

    it("1.4 Arbitrary Prisma model getters dispatch to active client", () => {
      const mockUserFindMany = vi.fn().mockResolvedValue([{ id: "u1" }]);
      const mockProjectFindUnique = vi.fn().mockResolvedValue({ id: "p1" });
      const mockCustomerCount = vi.fn().mockResolvedValue(10);
      const mockDiscountFind = vi.fn().mockResolvedValue(null);

      const mockClient: any = {
        user: { findMany: mockUserFindMany },
        project: { findUnique: mockProjectFindUnique },
        customer: { count: mockCustomerCount },
        discountCode: { findFirst: mockDiscountFind },
      };

      (globalThis as any).prisma = mockClient;

      expect(prisma.user).toBeDefined();
      expect(prisma.project).toBeDefined();
      expect(prisma.customer).toBeDefined();
      expect(prisma.discountCode).toBeDefined();

      prisma.user.findMany();
      expect(mockUserFindMany).toHaveBeenCalledTimes(1);

      prisma.project.findUnique({ where: { id: "p1" } });
      expect(mockProjectFindUnique).toHaveBeenCalledWith({ where: { id: "p1" } });

      prisma.customer.count();
      expect(mockCustomerCount).toHaveBeenCalledTimes(1);
    });

    it("1.5 Interactive and batch transactions dispatch with active client receiver", async () => {
      const mockTxClient = {
        user: { create: vi.fn().mockResolvedValue({ id: "user_in_tx" }) },
      };

      const mockTransaction = vi.fn().mockImplementation(async (arg) => {
        if (typeof arg === "function") {
          return arg(mockTxClient);
        }
        return Promise.all(arg);
      });

      const mockClient: any = {
        $transaction: mockTransaction,
      };

      (globalThis as any).prisma = mockClient;

      // 1. Interactive transaction callback
      const txResult = await prisma.$transaction(async (tx: any) => {
        return tx.user.create({ data: { email: "tx@example.com" } });
      });

      expect(mockTransaction).toHaveBeenCalled();
      expect(mockTxClient.user.create).toHaveBeenCalledWith({
        data: { email: "tx@example.com" },
      });
      expect(txResult).toEqual({ id: "user_in_tx" });

      // 2. Batch array transaction
      const p1 = Promise.resolve("query1");
      const p2 = Promise.resolve("query2");
      const batchResult = await prisma.$transaction([p1, p2]);
      expect(batchResult).toEqual(["query1", "query2"]);
    });

    it("1.6 Raw query execution ($queryRaw, $executeRaw) preserves active client receiver", async () => {
      const mockQueryRaw = vi.fn().mockResolvedValue([{ count: 1 }]);
      const mockExecuteRaw = vi.fn().mockResolvedValue(1);

      const mockClient: any = {
        $queryRaw: mockQueryRaw,
        $executeRaw: mockExecuteRaw,
      };

      (globalThis as any).prisma = mockClient;

      const rawRes = await prisma.$queryRaw`SELECT 1`;
      expect(mockQueryRaw).toHaveBeenCalled();
      expect(rawRes).toEqual([{ count: 1 }]);

      const execRes = await prisma.$executeRaw`UPDATE test SET x = 1`;
      expect(mockExecuteRaw).toHaveBeenCalled();
      expect(execRes).toBe(1);
    });

    it("1.7 Reflection traps: has, getOwnPropertyDescriptor, getPrototypeOf adhere to ES Proxy spec", () => {
      const mockClient: any = {
        user: { findMany: vi.fn() },
        customField: "custom_val",
      };

      (globalThis as any).prisma = mockClient;

      expect("user" in prisma).toBe(true);
      expect("customField" in prisma).toBe(true);
      expect("completelyMissingField" in prisma).toBe(false);

      const desc = Object.getOwnPropertyDescriptor(prisma, "customField");
      expect(desc).toBeDefined();

      const proto = Object.getPrototypeOf(prisma);
      expect(proto).toBe(Object.getPrototypeOf(mockClient));
    });

    it("1.8 Runtime behavior when env.DB is undefined vs provided", () => {
      // 1. env.DB is undefined: does not throw, does not set globalThis.DB
      const undefinedEnv: QueueConsumerEnv = { DB: undefined };
      const fallbackClient = initQueueConsumerPrisma(undefinedEnv);
      expect(fallbackClient).toBeDefined();
      expect((globalThis as any).DB).toBeUndefined();

      const cronUndefinedEnv: CronWorkerEnv = { DB: undefined };
      const cronFallback = initCronWorkerPrisma(cronUndefinedEnv);
      expect(cronFallback).toBeDefined();

      // 2. env.DB is provided: binds properly
      const mockD1 = createMockD1Database();
      const definedEnv: QueueConsumerEnv = { DB: mockD1 as any };
      const boundClient = initQueueConsumerPrisma(definedEnv);

      expect(boundClient).toBeDefined();
      expect((globalThis as any).DB).toBe(mockD1);
      expect((globalThis as any).prisma).toBe(boundClient);
    });

    it("1.9 Dynamic dispatch to D1-created client queries", async () => {
      // Test when real PrismaClient with D1 adapter is created and invoked through prisma proxy
      const mockD1 = createMockD1Database([
        { id: "store_d1_1", shopDomain: "test-d1.myshopify.com" },
      ]);
      const boundClient = initQueueConsumerPrisma({ DB: mockD1 as any });
      expect(boundClient).toBeDefined();

      // Query executed via proxy targets D1 prepare
      await prisma.$executeRaw`SELECT 1`;
      expect(mockD1.prepare).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 2. ADVERSARIAL STRESS: STALLED WEBHOOK RECOVERY ORPHAN & SCALE HARNESS
  // =========================================================================
  describe("2. Adversarial Webhook Recovery Stress", () => {
    it("2.1 Orphaned events (store missing/deleted): status set to failed, attempts incremented, 0 enqueued", async () => {
      const enqueuedMessages: any[] = [];
      const mockQueue: QueueSender = {
        async send(message) {
          enqueuedMessages.push(message);
        },
      };

      const updatedRecords: Array<{ id: string; status?: string; error?: string }> = [];

      const mockD1: any = {
        prepare(query: string) {
          if (query.includes("SELECT") && query.includes("WeleticShopifyWebhookEvent")) {
            return {
              async all() {
                return {
                  results: [
                    {
                      id: "evt_orphan_A",
                      webhookId: "wh_orphan_101",
                      topic: "orders/paid",
                      storeId: "non_existent_store_1",
                      shopDomain: null, // Orphaned
                      attempts: 1,
                      payload: JSON.stringify({ id: 101 }),
                    },
                    {
                      id: "evt_orphan_B",
                      webhookId: "wh_orphan_102",
                      topic: "orders/paid",
                      storeId: "deleted_store_2",
                      shopDomain: null, // Orphaned
                      attempts: 2,
                      payload: JSON.stringify({ id: 102 }),
                    },
                  ],
                };
              },
            };
          }
          if (query.includes("UPDATE") && query.includes("WeleticShopifyWebhookEvent")) {
            return {
              bind(...args: any[]) {
                const id = args[0];
                return {
                  async run() {
                    updatedRecords.push({ id, status: "failed", error: "Orphaned event: associated store not found" });
                    return { success: true };
                  },
                };
              },
            };
          }
          return {
            async all() { return { results: [] }; },
            async run() { return { success: true }; },
          };
        },
      };

      const env: CronWorkerEnv = {
        DB: mockD1,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      vi.spyOn(await import("../../lib/weletic/shopify/orders-paid-recovery"), "recoverStuckOrdersPaidWebhooks")
        .mockResolvedValue([]);

      const result = await recoverStalledWebhooksJob(env);

      // Absolutely no messages enqueued for orphans
      expect(result.reEnqueued).toBe(0);
      expect(enqueuedMessages).toHaveLength(0);

      // Both orphaned records marked failed
      expect(updatedRecords).toHaveLength(2);
      expect(updatedRecords.map((r) => r.id)).toEqual(["evt_orphan_A", "evt_orphan_B"]);
    });

    it("2.2 Valid events: canonical shopDomain placed into ORDER_WEBHOOK_QUEUE, not storeId", async () => {
      const enqueuedMessages: any[] = [];
      const mockQueue: QueueSender = {
        async send(message) {
          enqueuedMessages.push(message);
        },
      };

      const updatedRecords: string[] = [];

      const mockD1: any = {
        prepare(query: string) {
          if (query.includes("SELECT") && query.includes("WeleticShopifyWebhookEvent")) {
            return {
              async all() {
                return {
                  results: [
                    {
                      id: "evt_valid_1",
                      webhookId: "wh_valid_1",
                      topic: "orders/paid",
                      storeId: "store_internal_db_uuid_12345",
                      shopDomain: "yamax-active.myshopify.com",
                      attempts: 0,
                      payload: JSON.stringify({ id: 501, total_price: "12000" }),
                    },
                  ],
                };
              },
            };
          }
          if (query.includes("UPDATE") && query.includes("WeleticShopifyWebhookEvent")) {
            return {
              bind(...args: any[]) {
                return {
                  async run() {
                    updatedRecords.push(args[0]);
                    return { success: true };
                  },
                };
              },
            };
          }
          return {
            async all() { return { results: [] }; },
            async run() { return { success: true }; },
          };
        },
      };

      const env: CronWorkerEnv = {
        DB: mockD1,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      vi.spyOn(await import("../../lib/weletic/shopify/orders-paid-recovery"), "recoverStuckOrdersPaidWebhooks")
        .mockResolvedValue([]);

      const result = await recoverStalledWebhooksJob(env);

      expect(result.reEnqueued).toBe(1);
      expect(enqueuedMessages).toHaveLength(1);

      const msg = enqueuedMessages[0];
      expect(msg.webhookId).toBe("wh_valid_1");
      expect(msg.topic).toBe("orders/paid");
      // Canonical domain must be shopDomain, NEVER internal storeId
      expect(msg.shopDomain).toBe("yamax-active.myshopify.com");
      expect(msg.shopDomain).not.toBe("store_internal_db_uuid_12345");
      expect(updatedRecords).toEqual(["evt_valid_1"]);
    });

    it("2.3 Scale stress: 120 stalled events (40 orphans + 40 myshopify + 40 custom domains) drain cleanly across cycles", async () => {
      // Simulate an in-memory D1 table of 120 stalled events
      interface DbEventRow {
        id: string;
        webhookId: string;
        topic: string;
        storeId: string;
        shopDomain: string | null;
        status: "received" | "failed" | "completed";
        attempts: number;
        updatedAt: number; // timestamp
        payload: string;
      }

      const dbEvents: DbEventRow[] = [];

      // 40 orphans
      for (let i = 0; i < 40; i++) {
        dbEvents.push({
          id: `evt_orphan_${i}`,
          webhookId: `wh_orphan_${i}`,
          topic: "orders/paid",
          storeId: `missing_store_${i}`,
          shopDomain: null,
          status: "received",
          attempts: 1,
          updatedAt: Date.now() - 400_000,
          payload: JSON.stringify({ id: 1000 + i }),
        });
      }

      // 40 myshopifyDomain events
      for (let i = 0; i < 40; i++) {
        dbEvents.push({
          id: `evt_myshopify_${i}`,
          webhookId: `wh_myshopify_${i}`,
          topic: "orders/paid",
          storeId: `store_myshopify_${i % 5}`,
          shopDomain: `brand-${i % 5}.myshopify.com`,
          status: "received",
          attempts: 1,
          updatedAt: Date.now() - 400_000,
          payload: JSON.stringify({ id: 2000 + i }),
        });
      }

      // 40 custom domain events
      for (let i = 0; i < 40; i++) {
        dbEvents.push({
          id: `evt_custom_${i}`,
          webhookId: `wh_custom_${i}`,
          topic: "orders/paid",
          storeId: `store_custom_${i % 5}`,
          shopDomain: `shop.brand-custom-${i % 5}.com`,
          status: "received",
          attempts: 1,
          updatedAt: Date.now() - 400_000,
          payload: JSON.stringify({ id: 3000 + i }),
        });
      }

      const queueMessages: any[] = [];
      const mockQueue: QueueSender = {
        async send(message) {
          queueMessages.push(message);
        },
      };

      const simulatedD1: any = {
        prepare(query: string) {
          if (query.includes("SELECT") && query.includes("WeleticShopifyWebhookEvent")) {
            return {
              async all() {
                // Find up to 10 matching events (limit 10 in query)
                const matching = dbEvents
                  .filter((e) => e.status === "received" && e.attempts < 5)
                  .slice(0, 10);
                return { results: matching };
              },
            };
          }
          if (query.includes("UPDATE WeleticShopifyWebhookEvent SET status = 'failed'")) {
            return {
              bind(id: string) {
                return {
                  async run() {
                    const row = dbEvents.find((e) => e.id === id);
                    if (row) {
                      row.status = "failed";
                      row.attempts += 1;
                    }
                    return { success: true };
                  },
                };
              },
            };
          }
          if (query.includes("UPDATE WeleticShopifyWebhookEvent SET attempts = attempts + 1")) {
            return {
              bind(id: string) {
                return {
                  async run() {
                    const row = dbEvents.find((e) => e.id === id);
                    if (row) {
                      row.attempts += 1;
                      row.updatedAt = Date.now();
                      // In simulation, once enqueued, queue-consumer marks completed
                      row.status = "completed";
                    }
                    return { success: true };
                  },
                };
              },
            };
          }
          return {
            async all() { return { results: [] }; },
            async run() { return { success: true }; },
          };
        },
      };

      const env: CronWorkerEnv = {
        DB: simulatedD1,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      vi.spyOn(await import("../../lib/weletic/shopify/orders-paid-recovery"), "recoverStuckOrdersPaidWebhooks")
        .mockResolvedValue([]);

      // Execute 12 consecutive recovery cycles (each recovers up to 10 events)
      let totalReEnqueued = 0;
      for (let cycle = 0; cycle < 12; cycle++) {
        const sweepResult = await recoverStalledWebhooksJob(env);
        totalReEnqueued += sweepResult.reEnqueued;
      }

      // Assertions on the 120-event batch:
      // 1. All 40 orphans transitioned to status = 'failed'
      const failedOrphans = dbEvents.filter((e) => e.status === "failed");
      expect(failedOrphans).toHaveLength(40);

      // 2. All 80 valid events were completed and re-enqueued
      const completedEvents = dbEvents.filter((e) => e.status === "completed");
      expect(completedEvents).toHaveLength(80);
      expect(totalReEnqueued).toBe(80);
      expect(queueMessages).toHaveLength(80);

      // 3. No events left in 'received' status
      const remainingReceived = dbEvents.filter((e) => e.status === "received");
      expect(remainingReceived).toHaveLength(0);

      // 4. Verify custom domains and myshopify domains all present in re-enqueued payload
      const customDomainMessages = queueMessages.filter((m) =>
        m.shopDomain.includes("brand-custom"),
      );
      const myshopifyMessages = queueMessages.filter((m) =>
        m.shopDomain.includes("myshopify.com"),
      );
      expect(customDomainMessages).toHaveLength(40);
      expect(myshopifyMessages).toHaveLength(40);
    });

    it("2.4 Queue producer failure isolation: cron worker cycle reports error without unhandled crash", async () => {
      const failingQueue: QueueSender = {
        async send() {
          throw new Error("Cloudflare Queue rate limit exceeded / transient error");
        },
      };

      const mockD1 = createMockD1Database([
        {
          id: "evt_flaky_1",
          webhookId: "wh_flaky_1",
          topic: "orders/paid",
          storeId: "store_1",
          shopDomain: "store-flaky.myshopify.com",
          attempts: 0,
          payload: JSON.stringify({ id: 99 }),
        },
      ]);

      const env: CronWorkerEnv = {
        DB: mockD1 as any,
        ORDER_WEBHOOK_QUEUE: failingQueue,
      };

      // Spies for other jobs in 5-min cron
      vi.spyOn(await import("../../lib/weletic/loyalty/store-credit-reconciliation"), "reconcilePendingStoreCreditRedemptionsSweep")
        .mockResolvedValue({ scanned: 0, confirmed: 0, refunded: 0, deferred: 0, errors: 0 } as any);
      vi.spyOn(await import("../../lib/weletic/loyalty/outbox"), "processOutboxJobsBatch")
        .mockResolvedValue({ processed: 0 } as any);
      vi.spyOn(await import("../../lib/weletic/shopify/orders-paid-recovery"), "recoverStuckOrdersPaidWebhooks")
        .mockResolvedValue([]);

      // scheduledHandler executes the 5-min cycle containing recoverStalledWebhooksJob
      const report = await scheduledHandler(
        { cron: CRON_SCHEDULE_5_MIN },
        env,
      );

      // The cycle itself must NOT throw; it should report job results
      expect(report.jobs).toHaveLength(3);
      const webhookRecoveryJob = report.jobs.find(
        (j) => j.name === "stalled-webhooks-recovery",
      );
      expect(webhookRecoveryJob).toBeDefined();
      expect(webhookRecoveryJob?.status).toBe("error");
      expect(webhookRecoveryJob?.error).toContain("rate limit exceeded");

      // The other jobs in the same cycle must have completed successfully
      const otherJobs = report.jobs.filter(
        (j) => j.name !== "stalled-webhooks-recovery",
      );
      expect(otherJobs.every((j) => j.status === "success")).toBe(true);
    });

    it("2.5 End-to-end custom domain resolution and DLQ retry escalation in queue-consumer", async () => {
      const customDomain = "shop.yamax-sportswear.com";

      // Mock resolveShopifyStoreByDomain to handle custom domain
      vi.spyOn(await import("../../lib/weletic/shopify/store-resolver"), "resolveShopifyStoreByDomain")
        .mockImplementation(async (domain) => {
          if (domain === customDomain) {
            return {
              shopId: "shop_custom_tenant",
              primaryDomain: customDomain,
              myshopifyDomain: "yamax-internal.myshopify.com",
              allDomains: [customDomain, "yamax-internal.myshopify.com"],
              workspaceId: "ws_custom_tenant",
              programId: "prog_custom_tenant",
              accessToken: "token_custom",
              storeId: "store_custom_db_id",
            };
          }
          return null;
        });

      // Mock recordWeleticOrder to simulate 5th failure
      vi.spyOn(await import("../../lib/weletic/commerce/record-order"), "recordWeleticOrder")
        .mockRejectedValue(new Error("Downstream billing API failure"));

      const dlqDispatched: any[] = [];
      const mockDlq: QueueSender = {
        async send(message) {
          dlqDispatched.push(message);
        },
      };

      const msg: QueueMessageItem<any> = {
        id: "msg_custom_dlq",
        body: {
          webhookId: "wh_custom_dlq_001",
          topic: "orders/paid",
          shopDomain: customDomain,
          triggeredAt: new Date().toISOString(),
          rawPayload: JSON.stringify({ id: 8888 }),
          enqueuedAt: Date.now(),
        },
        attempts: 5, // 5th attempt!
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const mockD1: any = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: vi.fn().mockResolvedValue(null),
            run: vi.fn().mockResolvedValue({ success: true }),
          }),
        }),
      };

      const queueEnv: QueueConsumerEnv = {
        DB: mockD1,
        ORDER_WEBHOOK_DLQ: mockDlq,
      };

      const outcome = await processQueueMessage(msg, queueEnv);

      // On 5th attempt, error routed to DLQ and message acked
      expect(outcome.status).toBe("failed");
      expect(outcome.error).toContain("Downstream billing API failure");
      expect(dlqDispatched).toHaveLength(1);
      expect(dlqDispatched[0].webhookId).toBe("wh_custom_dlq_001");
      expect(dlqDispatched[0].shopDomain).toBe(customDomain);
      expect(dlqDispatched[0].attempts).toBe(5);
      expect(msg.ack).toHaveBeenCalled();
      expect(msg.retry).not.toHaveBeenCalled();
    });
  });
});
