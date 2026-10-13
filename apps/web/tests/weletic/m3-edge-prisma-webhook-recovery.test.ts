import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { prisma } from "../../lib/prisma";
import { prismaEdge } from "../../lib/prisma/edge";
import {
  initCronWorkerPrisma,
  recoverStalledWebhooksJob,
  type CronWorkerEnv,
  type QueueSender,
} from "../../workers/cron-triggers/src/index";
import {
  initQueueConsumerPrisma,
  processQueueMessage,
  type QueueConsumerEnv,
  type QueueMessageItem,
} from "../../workers/queue-consumer/src/index";

describe("Milestone 3: Edge Prisma Client Binding & Webhook Recovery Domain (WRK-AUDIT-01 & WRK-AUDIT-02)", () => {
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
  // 1. WRK-AUDIT-01: Disconnected Edge Prisma Client & Dynamic Proxy
  // =========================================================================
  describe("1. WRK-AUDIT-01: Edge Prisma Client Binding", () => {
    it("1.1 initQueueConsumerPrisma binds env.DB to globalThis.DB and globalThis.prisma", () => {
      const mockD1: any = {
        prepare: vi.fn(),
        batch: vi.fn(),
        exec: vi.fn(),
      };

      const env: QueueConsumerEnv = { DB: mockD1 };
      const client = initQueueConsumerPrisma(env);

      expect(client).toBeDefined();
      expect((globalThis as any).DB).toBe(mockD1);
      expect((globalThis as any).prisma).toBe(client);
      expect((globalThis as any).__boundD1).toBe(mockD1);
    });

    it("1.2 dynamic prisma Proxy forwards property access to globalThis.prisma", async () => {
      const mockFindUnique = vi.fn().mockResolvedValue({
        id: "store_mock_1",
        shopDomain: "test-proxy.myshopify.com",
      });

      const mockClient: any = {
        weleticShopifyStore: {
          findUnique: mockFindUnique,
        },
      };

      // Set globalThis.prisma dynamically
      (globalThis as any).prisma = mockClient;

      // Access through static singleton import
      const result = await prisma.weleticShopifyStore.findUnique({
        where: { shopDomain: "test-proxy.myshopify.com" },
      });

      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { shopDomain: "test-proxy.myshopify.com" },
      });
      expect(result?.shopDomain).toBe("test-proxy.myshopify.com");
    });

    it("1.3 prismaEdge points to the active dynamic proxy", async () => {
      const mockCount = vi.fn().mockResolvedValue(42);
      const mockClient: any = {
        user: { count: mockCount },
      };

      (globalThis as any).prisma = mockClient;

      const count = await prismaEdge.user.count();
      expect(mockCount).toHaveBeenCalled();
      expect(count).toBe(42);
    });

    it("1.4 initQueueConsumerPrisma caches instance across messages in the same isolate", () => {
      const mockD1: any = { prepare: vi.fn() };
      const env: QueueConsumerEnv = { DB: mockD1 };

      const client1 = initQueueConsumerPrisma(env);
      const client2 = initQueueConsumerPrisma(env);

      expect(client1).toBe(client2);
      expect((globalThis as any).__boundD1).toBe(mockD1);
    });

    it("1.5 initCronWorkerPrisma binds during scheduled execution", async () => {
      const mockD1: any = { prepare: vi.fn() };
      const env: CronWorkerEnv = { DB: mockD1 };

      initCronWorkerPrisma(env);

      expect((globalThis as any).DB).toBe(mockD1);
      expect((globalThis as any).prisma).toBeDefined();
    });
  });

  // =========================================================================
  // 2. WRK-AUDIT-02: Stalled Webhook Recovery Domain Resolution
  // =========================================================================
  describe("2. WRK-AUDIT-02: Webhook Recovery Canonical Domain Re-Enqueuing", () => {
    it("2.1 recoverStalledWebhooksJob joins WeleticShopifyStore and re-enqueues shopDomain instead of storeId", async () => {
      const enqueuedMessages: any[] = [];
      const mockQueue: QueueSender = {
        async send(message) {
          enqueuedMessages.push(message);
        },
      };

      const executedUpdates: any[] = [];
      let executedSelectQuery = "";

      const mockD1: any = {
        prepare(query: string) {
          if (query.includes("SELECT")) {
            executedSelectQuery = query;
          }
          if (
            query.includes("SELECT") &&
            query.includes("WeleticShopifyWebhookEvent")
          ) {
            return {
              bind: vi.fn().mockReturnThis(),
              async all() {
                return {
                  results: [
                    {
                      id: "evt_stalled_1",
                      webhookId: "wh_shopify_stalled_101",
                      topic: "orders/paid",
                      storeId: "store_db_internal_pk_999", // internal database ID
                      shopDomain: "yamax-flagship.myshopify.com", // joined canonical domain
                      attempts: 2,
                      payload: JSON.stringify({ id: 101, total_price: "5000" }),
                    },
                  ],
                };
              },
            };
          }
          if (
            query.includes("UPDATE") &&
            query.includes("WeleticShopifyWebhookEvent")
          ) {
            return {
              bind(...args: any[]) {
                const id = args[args.length - 1];
                executedUpdates.push([id]);
                return {
                  async run() {
                    return { success: true };
                  },
                };
              },
            };
          }
          return {
            bind: vi.fn().mockReturnThis(),
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
        },
      };

      const env: CronWorkerEnv = {
        DB: mockD1,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      vi.spyOn(
        await import("../../lib/weletic/shopify/orders-paid-recovery"),
        "recoverStuckOrdersPaidWebhooks",
      ).mockResolvedValue([]);

      const result = await recoverStalledWebhooksJob(env);

      // Verify SQL contains the JOIN
      expect(executedSelectQuery).toContain("JOIN WeleticShopifyStore");
      expect(executedSelectQuery).toContain("s.shopDomain");

      // Verify recovery count
      expect(result.reEnqueued).toBe(1);

      // CRITICAL ASSERTION: The message must contain shopDomain, NOT storeId
      expect(enqueuedMessages).toHaveLength(1);
      expect(enqueuedMessages[0].webhookId).toBe("wh_shopify_stalled_101");
      expect(enqueuedMessages[0].shopDomain).toBe(
        "yamax-flagship.myshopify.com",
      );
      expect(enqueuedMessages[0].shopDomain).not.toBe(
        "store_db_internal_pk_999",
      );

      // Verify attempt increment
      expect(executedUpdates).toHaveLength(1);
      expect(executedUpdates[0]).toEqual(["evt_stalled_1"]);
    });

    it("2.2 orphaned webhook event (missing store) is marked failed and not re-enqueued", async () => {
      const enqueuedMessages: any[] = [];
      const mockQueue: QueueSender = {
        async send(message) {
          enqueuedMessages.push(message);
        },
      };

      const executedUpdates: any[] = [];
      const mockD1: any = {
        prepare(query: string) {
          if (
            query.includes("SELECT") &&
            query.includes("WeleticShopifyWebhookEvent")
          ) {
            return {
              bind: vi.fn().mockReturnThis(),
              async all() {
                return {
                  results: [
                    {
                      id: "evt_orphan_2",
                      webhookId: "wh_orphan_202",
                      topic: "orders/paid",
                      storeId: "store_deleted_id",
                      shopDomain: null, // orphan store!
                      attempts: 1,
                      payload: JSON.stringify({ id: 202 }),
                    },
                  ],
                };
              },
            };
          }
          if (
            query.includes("UPDATE") &&
            query.includes("WeleticShopifyWebhookEvent")
          ) {
            return {
              bind(...args: any[]) {
                const id = args[args.length - 1];
                executedUpdates.push([id]);
                return {
                  async run() {
                    return { success: true };
                  },
                };
              },
            };
          }
          return {
            bind: vi.fn().mockReturnThis(),
            async all() {
              return { results: [] };
            },
            async run() {
              return { success: true };
            },
          };
        },
      };

      const env: CronWorkerEnv = {
        DB: mockD1,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      vi.spyOn(
        await import("../../lib/weletic/shopify/orders-paid-recovery"),
        "recoverStuckOrdersPaidWebhooks",
      ).mockResolvedValue([]);

      const result = await recoverStalledWebhooksJob(env);

      // Zero re-enqueues for orphaned store
      expect(result.reEnqueued).toBe(0);
      expect(enqueuedMessages).toHaveLength(0);

      // Transitioned to failed in D1
      expect(executedUpdates).toHaveLength(1);
      expect(executedUpdates[0]).toEqual(["evt_orphan_2"]);
    });

    it("2.3 end-to-end: re-enqueued message with canonical shopDomain resolves in queue-consumer", async () => {
      const reEnqueuedShopDomain = "valid-tenant.myshopify.com";

      // Mock resolveShopifyStoreByDomain to return store when canonical domain is supplied
      vi.spyOn(
        await import("../../lib/weletic/shopify/store-resolver"),
        "resolveShopifyStoreByDomain",
      ).mockImplementation(async (domain) => {
        if (domain === reEnqueuedShopDomain) {
          return {
            shopId: "shop_canon_1",
            primaryDomain: reEnqueuedShopDomain,
            myshopifyDomain: reEnqueuedShopDomain,
            allDomains: [reEnqueuedShopDomain],
            workspaceId: "ws_canon_1",
            programId: "prog_canon_1",
            accessToken: "token_mock",
            storeId: "store_db_internal_pk_999",
          };
        }
        return null;
      });

      // Mock recordWeleticOrder
      const recordOrderSpy = vi
        .spyOn(
          await import("../../lib/weletic/commerce/record-order"),
          "recordWeleticOrder",
        )
        .mockResolvedValueOnce({} as any);

      const testWebhookId = `wh_recov_${Date.now()}_${Math.random().toString(36).substring(2)}`;
      const msg: QueueMessageItem<any> = {
        id: "msg_recov_1",
        body: {
          webhookId: testWebhookId,
          topic: "orders/paid",
          shopDomain: reEnqueuedShopDomain, // Canonical domain passed
          triggeredAt: new Date().toISOString(),
          rawPayload: JSON.stringify({ id: 9999, line_items: [] }),
          enqueuedAt: Date.now(),
        },
        attempts: 2,
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const queueEnv: QueueConsumerEnv = {};
      const outcome = await processQueueMessage(msg, queueEnv);

      expect(outcome.status).toBe("completed");
      expect(recordOrderSpy).toHaveBeenCalled();
      expect(msg.ack).toHaveBeenCalled();
      expect(msg.retry).not.toHaveBeenCalled();
    });
  });
});
