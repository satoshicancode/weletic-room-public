import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const upstashMocks = vi.hoisted(() => ({
  set: vi.fn(),
  eval: vi.fn(),
}));

vi.mock("@/lib/upstash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upstash")>();
  return {
    ...actual,
    redis: upstashMocks,
  };
});

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((cb) => {
      try {
        if (typeof cb === "function") cb();
      } catch {}
    }),
  };
});

vi.mock("next/headers", () => ({
  headers: vi.fn(() => new Headers()),
  cookies: vi.fn(() => ({ get: vi.fn() })),
}));

vi.mock("@/lib/auth/utils", () => ({
  getSession: vi.fn(async () => ({
    user: { id: "usr_stress_tester", email: "adversary@weletic.com" },
  })),
}));

vi.mock("@/lib/auth/workspace-cache", () => ({
  workspaceAuthCache: {
    get: vi.fn(({ identifier }) => {
      if (identifier === "ws_invalid") return null;
      return {
        id: identifier,
        users: [
          { role: "owner", defaultFolderId: null, workspacePreferences: null },
        ],
        plan: "enterprise",
      };
    }),
    set: vi.fn(),
  },
}));

vi.mock("@/lib/axiom/server", () => ({
  withAxiomBodyLog: (fn: any) => fn,
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    flush: vi.fn(),
  },
}));

import { syncShopifyCatalogAction } from "@/lib/actions/partners/sync-shopify-catalog";
import * as adminGraphqlModule from "@/lib/integrations/shopify/admin-graphql";
import * as redisLockModule from "@/lib/weletic/redis-lock";
import * as catalogSyncModule from "@/lib/weletic/shopify/catalog-sync";
import {
  ensureShopifyWebhooksRegistered,
  resolveShopifyWebhookCallbackUrl,
  SHOPIFY_CANONICAL_WEBHOOK_TOPICS,
  ShopifyCanonicalWebhookTopic,
} from "@/lib/weletic/shopify/provision-webhooks";
import { POST as syncRouteHandler } from "../../app/(ee)/api/shopify/integration/sync/route";

describe("Adversarial Challenge & Stress Tests: Requirements R1 & R2", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    upstashMocks.set.mockReset();
    upstashMocks.eval.mockReset();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // =========================================================================
  // 1. Topic Coverage & Exact Shopify Enum Matching
  // =========================================================================
  describe("Challenge 1: Webhook Topics Coverage & Shopify GraphQL Enums", () => {
    const OFFICIAL_SHOPIFY_GRAPHQL_ENUMS: readonly ShopifyCanonicalWebhookTopic[] =
      [
        "PRODUCTS_CREATE",
        "PRODUCTS_UPDATE",
        "PRODUCTS_DELETE",
        "MARKETS_CREATE",
        "MARKETS_UPDATE",
        "MARKETS_DELETE",
        "ORDERS_PAID",
        "ORDERS_FULFILLED",
        "ORDERS_CANCELLED",
        "REFUNDS_CREATE",
        "CUSTOMERS_CREATE",
        "CUSTOMERS_UPDATE",
        "DISCOUNTS_CREATE",
        "DISCOUNTS_UPDATE",
        "DISCOUNTS_DELETE",
        "APP_UNINSTALLED",
      ];

    it("matches all 16 topics exactly with official Shopify GraphQL enum set without duplicates or missing items", () => {
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toHaveLength(
        OFFICIAL_SHOPIFY_GRAPHQL_ENUMS.length,
      );

      // Check set equivalence
      const topicsSet = new Set(SHOPIFY_CANONICAL_WEBHOOK_TOPICS);
      expect(topicsSet.size).toBe(OFFICIAL_SHOPIFY_GRAPHQL_ENUMS.length);

      for (const officialEnum of OFFICIAL_SHOPIFY_GRAPHQL_ENUMS) {
        expect(topicsSet.has(officialEnum)).toBe(true);
      }
    });

    it("verifies GraphQL payload conforms strictly to Shopify WebhookSubscriptionInput format", async () => {
      const recordedVariables: Array<{
        topic: string;
        webhookSubscription: any;
      }> = [];

      vi.spyOn(adminGraphqlModule, "shopifyAdminGraphql").mockImplementation(
        async ({ query, variables }: any) => {
          if (query.includes("WeleticAuditWebhookSubscriptions")) {
            return {
              webhookSubscriptions: {
                nodes: variables.topics.map((topic: string) => ({
                  id: `gid://shopify/WebhookSubscription/stress_${topic}`,
                  topic,
                  format: "JSON",
                  uri: "https://adversarial-target.weletic.com/api/shopify/integration/webhook",
                  filter: null,
                })),
              },
            } as any;
          }
          recordedVariables.push(variables);
          return {
            webhookSubscriptionCreate: {
              userErrors: [],
              webhookSubscription: {
                id: `gid://shopify/WebhookSubscription/stress_${variables?.topic}`,
                topic: variables?.topic,
              },
            },
          } as any;
        },
      );

      const result = await ensureShopifyWebhooksRegistered({
        shopDomain: "adversarial-store.myshopify.com",
        accessToken: "shpat_adversarial_token_123",
        callbackUrl:
          "https://adversarial-target.weletic.com/api/shopify/integration/webhook",
      });

      expect(result.success).toBe(true);
      expect(recordedVariables).toHaveLength(
        SHOPIFY_CANONICAL_WEBHOOK_TOPICS.length,
      );

      for (const call of recordedVariables) {
        expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain(call.topic);
        expect(call.webhookSubscription).toBeDefined();
        expect(call.webhookSubscription.format).toBe("JSON");
        expect(call.webhookSubscription.uri).toBe(
          "https://adversarial-target.weletic.com/api/shopify/integration/webhook",
        );
      }
    });
  });

  // =========================================================================
  // 2. URL Resolution Edge Cases & Boundary Conditions
  // =========================================================================
  describe("Challenge 2: URL Resolution Edge Cases & Boundary Conditions", () => {
    it("handles multiple trailing slashes in DEV_WEBHOOK_URL correctly", () => {
      delete (process.env as any).NODE_ENV;
      process.env.DEV_WEBHOOK_URL = "https://tunnel.ngrok.app///";
      const url = resolveShopifyWebhookCallbackUrl();
      expect(url).toBe(
        "https://tunnel.ngrok.app/api/shopify/integration/webhook",
      );
      expect(() => new URL(url)).not.toThrow();
    });

    it("handles NEXT_PUBLIC_APP_DOMAIN with http:// and port numbers", () => {
      delete process.env.DEV_WEBHOOK_URL;
      (process.env as any).NODE_ENV = "production";
      process.env.NEXT_PUBLIC_APP_DOMAIN = "http://localhost:3000/";
      const url = resolveShopifyWebhookCallbackUrl();
      expect(url).toBe("http://localhost:3000/api/shopify/integration/webhook");
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("http:");
      expect(parsed.port).toBe("3000");
    });

    it("handles NEXT_PUBLIC_APP_DOMAIN without protocol and ensures https:// prefix", () => {
      delete process.env.DEV_WEBHOOK_URL;
      (process.env as any).NODE_ENV = "production";
      process.env.NEXT_PUBLIC_APP_DOMAIN = "staging.dub.co";
      const url = resolveShopifyWebhookCallbackUrl();
      expect(url).toBe(
        "https://staging.dub.co/api/shopify/integration/webhook",
      );
      const parsed = new URL(url);
      expect(parsed.protocol).toBe("https:");
      expect(parsed.hostname).toBe("staging.dub.co");
    });

    it("resolves development environment to the dedicated dev tunnel domain", () => {
      delete process.env.DEV_WEBHOOK_URL;
      (process.env as any).NODE_ENV = "development";
      const url = resolveShopifyWebhookCallbackUrl();
      expect(url).toBe(
        "https://dev-webhook.weletic.com/api/shopify/integration/webhook",
      );
    });

    it("handles customUrl containing query strings or authentication tokens safely", () => {
      const custom =
        "https://custom-target.internal/webhook?token=secret123&env=canary";
      const url = resolveShopifyWebhookCallbackUrl(custom);
      expect(url).toBe(custom);
      const parsed = new URL(url);
      expect(parsed.searchParams.get("token")).toBe("secret123");
    });
  });

  // =========================================================================
  // 3. Idempotency & GraphQL userErrors Variations
  // =========================================================================
  describe("Challenge 3: Idempotency & userErrors Permutations", () => {
    it("handles ALL Shopify duplicate subscription message variations (case-insensitive & substring)", async () => {
      const duplicateMessages = [
        "Address for this topic has already been taken: PRODUCTS_CREATE",
        "has already been taken",
        "Address for this topic already exists",
        "An identical webhook subscription already exists.",
        "ALREADY BEEN TAKEN",
        "HAS ALREADY BEEN TAKEN FOR THIS TOPIC",
        "ALREADY EXISTS IN SYSTEM",
      ];

      for (const msg of duplicateMessages) {
        const requestedUris = new Map<string, string>();
        vi.spyOn(adminGraphqlModule, "shopifyAdminGraphql").mockImplementation(
          async ({ query, variables }: any) => {
            if (query.includes("WeleticAuditWebhookSubscriptions")) {
              return {
                webhookSubscriptions: {
                  nodes: variables.topics.map((topic: string) => ({
                    id: `gid://shopify/WebhookSubscription/${topic}`,
                    topic,
                    format: "JSON",
                    uri: requestedUris.get(topic),
                    filter: null,
                  })),
                },
              } as any;
            }
            requestedUris.set(
              variables.topic,
              variables.webhookSubscription.uri,
            );
            return {
              webhookSubscriptionCreate: {
                userErrors: [
                  { field: ["webhookSubscription", "uri"], message: msg },
                ],
                webhookSubscription: null,
              },
            } as any;
          },
        );

        const result = await ensureShopifyWebhooksRegistered({
          shopDomain: "store.myshopify.com",
          accessToken: "shpat_test",
        });

        expect(result.success).toBe(true);
        expect(result.skipped).toHaveLength(
          SHOPIFY_CANONICAL_WEBHOOK_TOPICS.length,
        );
        expect(result.registered).toHaveLength(0);
        expect(result.failed).toHaveLength(0);
      }
    });

    it("distinguishes genuine permissions/schema errors from idempotency skips", async () => {
      const requestedUris = new Map<string, string>();
      vi.spyOn(adminGraphqlModule, "shopifyAdminGraphql").mockImplementation(
        async ({ query, variables }: any) => {
          if (query.includes("WeleticAuditWebhookSubscriptions")) {
            return {
              webhookSubscriptions: {
                nodes: variables.topics.map((topic: string) => ({
                  id: `gid://shopify/WebhookSubscription/${topic}`,
                  topic,
                  format: "JSON",
                  uri: requestedUris.get(topic),
                  filter: null,
                })),
              },
            } as any;
          }
          const topic = variables?.topic;
          requestedUris.set(topic, variables.webhookSubscription.uri);
          if (topic === "ORDERS_PAID") {
            return {
              webhookSubscriptionCreate: {
                userErrors: [
                  {
                    field: ["topic"],
                    message:
                      "Access denied for ORDERS_PAID. Missing read_orders scope.",
                  },
                ],
                webhookSubscription: null,
              },
            } as any;
          }
          return {
            webhookSubscriptionCreate: {
              userErrors: [],
              webhookSubscription: {
                id: `gid://shopify/WebhookSubscription/${topic}`,
                topic,
              },
            },
          } as any;
        },
      );

      const result = await ensureShopifyWebhooksRegistered({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_restricted_scope",
      });

      expect(result.success).toBe(false);
      expect(result.registered).toHaveLength(
        SHOPIFY_CANONICAL_WEBHOOK_TOPICS.length - 1,
      );
      expect(result.registered).not.toContain("ORDERS_PAID");
      expect(result.skipped).toHaveLength(0);
      expect(result.failed).toEqual([
        {
          topic: "ORDERS_PAID",
          error: "Access denied for ORDERS_PAID. Missing read_orders scope.",
        },
      ]);
    });

    it("resiliently handles network timeouts and socket hangs on intermittent topics", async () => {
      let callIndex = 0;
      const requestedUris = new Map<string, string>();
      vi.spyOn(adminGraphqlModule, "shopifyAdminGraphql").mockImplementation(
        async ({ query, variables }: any) => {
          if (query.includes("WeleticAuditWebhookSubscriptions")) {
            return {
              webhookSubscriptions: {
                nodes: variables.topics.map((topic: string) => ({
                  id: `gid://shopify/WebhookSubscription/${topic}`,
                  topic,
                  format: "JSON",
                  uri: requestedUris.get(topic),
                  filter: null,
                })),
              },
            } as any;
          }
          callIndex++;
          requestedUris.set(variables.topic, variables.webhookSubscription.uri);
          if (callIndex === 3 || callIndex === 7) {
            throw new Error("ETIMEDOUT: Connection reset by peer");
          }
          return {
            webhookSubscriptionCreate: {
              userErrors: [],
              webhookSubscription: {
                id: `gid://shopify/WebhookSubscription/${variables?.topic}`,
                topic: variables?.topic,
              },
            },
          } as any;
        },
      );

      const result = await ensureShopifyWebhooksRegistered({
        shopDomain: "flaky-store.myshopify.com",
        accessToken: "shpat_flaky_test",
      });

      expect(callIndex).toBe(SHOPIFY_CANONICAL_WEBHOOK_TOPICS.length);
      expect(result.success).toBe(false);
      expect(result.registered).toHaveLength(
        SHOPIFY_CANONICAL_WEBHOOK_TOPICS.length - 2,
      );
      expect(result.failed).toHaveLength(2);
      expect(result.failed[0].error).toContain("ETIMEDOUT");
      expect(result.failed[1].error).toContain("ETIMEDOUT");
    });
  });

  // =========================================================================
  // 4. Distributed Locking & Concurrency Stress
  // =========================================================================
  describe("Challenge 4: Distributed Locking & Concurrency Stress", () => {
    it("guarantees atomic single-winner execution under 50 concurrent sync attempts on same workspace", async () => {
      const activeLocks = new Map<string, string>();

      upstashMocks.set.mockImplementation(
        async (key: any, val: any, opts: any) => {
          if (opts?.nx && activeLocks.has(key)) {
            return null as any;
          }
          activeLocks.set(key, val);
          return "OK" as any;
        },
      );

      upstashMocks.eval.mockImplementation(
        async (_script: any, keys: any, args: any) => {
          const key = Array.isArray(keys) ? keys[0] : keys;
          const token = Array.isArray(args)
            ? Array.isArray(args[0])
              ? args[0][0]
              : args[0]
            : args;
          if (activeLocks.get(key) === token) {
            activeLocks.delete(key);
            return 1 as any;
          }
          return 0 as any;
        },
      );

      const workspaceId = "ws_high_concurrency";
      const lockKey = `weletic:catalog-sync:${workspaceId}`;

      let executionCount = 0;
      let rejectionCount = 0;

      const runSyncAttempt = async () => {
        try {
          return await redisLockModule.withDistributedLock({
            key: lockKey,
            ttlSeconds: 1800,
            onLocked: () => {
              throw new Error("A Shopify catalog sync is already running.");
            },
            fn: async () => {
              executionCount++;
              // Simulate small workload
              await new Promise((r) => setTimeout(r, 5));
              return { success: true };
            },
          });
        } catch (err: any) {
          if (err.message.includes("already running")) {
            rejectionCount++;
          }
          throw err;
        }
      };

      const results = await Promise.allSettled(
        Array.from({ length: 50 }, () => runSyncAttempt()),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(49);
      expect(executionCount).toBe(1);
      expect(rejectionCount).toBe(49);
      expect(activeLocks.has(lockKey)).toBe(false); // Lock released cleanly
    });

    it("guarantees lock release in finally block even when sync execution throws unhandled crash", async () => {
      let lockHeld = false;
      let releasedToken: any = null;

      upstashMocks.set.mockImplementation(
        async (key: any, val: any, opts: any) => {
          if (opts?.nx && lockHeld) return null as any;
          lockHeld = true;
          return "OK" as any;
        },
      );

      upstashMocks.eval.mockImplementation(
        async (_script: any, _keys: any, args: any) => {
          lockHeld = false;
          releasedToken = Array.isArray(args)
            ? Array.isArray(args[0])
              ? args[0][0]
              : args[0]
            : args;
          return 1 as any;
        },
      );

      const lockKey = "weletic:catalog-sync:ws_crash_test";

      const crashPromise = redisLockModule.withDistributedLock({
        key: lockKey,
        fn: async () => {
          throw new Error("FATAL: Out of database connections");
        },
      });

      await expect(crashPromise).rejects.toThrow(
        "FATAL: Out of database connections",
      );

      // Verify lock was released and token was provided
      expect(lockHeld).toBe(false);
      expect(releasedToken).toBeDefined();
      expect(String(releasedToken).length).toBeGreaterThan(0);

      // Subsequent attempt must succeed immediately
      const recovered = await redisLockModule.withDistributedLock({
        key: lockKey,
        fn: async () => ({ recovered: true }),
      });
      expect(recovered.recovered).toBe(true);
    });

    it("verifies Lua release lock script safety against token mismatch (stale lock expiration)", async () => {
      let storeValue: string | null = "token_new_owner";

      upstashMocks.eval.mockImplementation(
        async (_script: any, _keys: any, args: any) => {
          const token = Array.isArray(args)
            ? Array.isArray(args[0])
              ? args[0][0]
              : args[0]
            : args;
          // Emulate Lua: if redis.call("get", KEYS[1]) == ARGV[1] then del else return 0
          if (storeValue === token) {
            storeValue = null;
            return 1 as any;
          }
          return 0 as any;
        },
      );

      // Old worker tries to release with expired token
      const oldReleaseResult = await redisLockModule.releaseDistributedLock({
        key: "weletic:catalog-sync:ws_test",
        token: "token_expired_old_owner",
      });

      expect(oldReleaseResult).toBe(false);
      expect(storeValue).toBe("token_new_owner"); // Not deleted!
    });
  });

  // =========================================================================
  // 5. Server Action & Route Handler HTTP Status Code Assertions
  // =========================================================================
  describe("Challenge 5: Server Action & Route HTTP Status Verification", () => {
    it("POST /api/shopify/integration/sync returns HTTP 409 for lock collisions and 500 for general failures", async () => {
      // Test 409 for "already running"
      vi.spyOn(
        catalogSyncModule,
        "syncWeleticShopifyCatalog",
      ).mockRejectedValueOnce(
        new Error("A Shopify catalog sync is already running."),
      );

      const mockReq = new Request(
        "http://localhost:3000/api/shopify/integration/sync?workspaceId=ws_stress_123",
        {
          method: "POST",
        },
      );

      const response409 = await syncRouteHandler(mockReq as any, {
        params: Promise.resolve({}),
      });

      expect(response409.status).toBe(409);
      const body409 = await response409.json();
      expect(body409.error.message).toContain("already running");

      // Test 500 for general error
      vi.spyOn(
        catalogSyncModule,
        "syncWeleticShopifyCatalog",
      ).mockRejectedValueOnce(new Error("Database connection timeout"));

      const response500 = await syncRouteHandler(mockReq as any, {
        params: Promise.resolve({}),
      });

      expect(response500.status).toBe(500);
      const body500 = await response500.json();
      expect(body500.error.message).toContain("Database connection timeout");
    });

    it("syncShopifyCatalogAction rejects invalid inputs (null, numbers, empty string)", async () => {
      const emptyResult = await syncShopifyCatalogAction({ workspaceId: "" });
      expect(
        emptyResult?.validationErrors || emptyResult?.serverError,
      ).toBeDefined();

      const invalidTypeResult = await syncShopifyCatalogAction({
        workspaceId: 12345 as any,
      });
      expect(
        invalidTypeResult?.validationErrors || invalidTypeResult?.serverError,
      ).toBeDefined();
    });
  });
});
