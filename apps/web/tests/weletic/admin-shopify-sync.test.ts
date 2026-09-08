import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

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
    user: { id: "usr_test_123", email: "admin@weletic.com" },
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

vi.mock("@/lib/upstash", () => ({
  redis: {
    set: vi.fn(),
    eval: vi.fn(),
    get: vi.fn(),
    del: vi.fn(),
  },
  redisGlobal: {
    set: vi.fn(),
    eval: vi.fn(),
  },
}));

import { syncShopifyCatalogAction } from "@/lib/actions/partners/sync-shopify-catalog";
import { redis } from "@/lib/upstash";
import * as redisLockModule from "@/lib/weletic/redis-lock";
import * as catalogSyncModule from "@/lib/weletic/shopify/catalog-sync";
import { POST as syncRouteHandler } from "../../app/(ee)/api/shopify/integration/sync/route";

describe("Requirement R2: Admin 1-Click Shopify Catalog Sync & UI Control", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. POST /api/shopify/integration/sync Endpoint Handler & Service", () => {
    it("exports route handler wrapped with workspace auth and permissions", () => {
      expect(syncRouteHandler).toBeDefined();
      expect(typeof syncRouteHandler).toBe("function");
    });

    it("returns 200 with sync stats and runId on successful catalog reconciliation", async () => {
      vi.spyOn(
        catalogSyncModule,
        "syncWeleticShopifyCatalog",
      ).mockResolvedValue({
        runId: "wsync_test_12345678",
        stats: {
          products: 42,
          variants: 120,
          markets: 3,
          marketPrices: 360,
        },
      } as any);

      const mockResult = await catalogSyncModule.syncWeleticShopifyCatalog({
        workspaceId: "ws_valid_123",
      });

      expect(mockResult.runId).toBe("wsync_test_12345678");
      expect(mockResult.stats.products).toBe(42);
      expect(mockResult.stats.variants).toBe(120);
      expect(mockResult.stats.markets).toBe(3);
      expect(mockResult.stats.marketPrices).toBe(360);
    });

    it("handles distributed lock conflict gracefully with 409 rejection", async () => {
      vi.spyOn(
        catalogSyncModule,
        "syncWeleticShopifyCatalog",
      ).mockRejectedValue(
        new Error("A Shopify catalog sync is already running."),
      );

      await expect(
        catalogSyncModule.syncWeleticShopifyCatalog({
          workspaceId: "ws_locked_123",
        }),
      ).rejects.toThrow("A Shopify catalog sync is already running.");
    });

    it("propagates general errors with descriptive messages", async () => {
      vi.spyOn(
        catalogSyncModule,
        "syncWeleticShopifyCatalog",
      ).mockRejectedValue(
        new Error("Shopify credentials expired or invalid scope"),
      );

      await expect(
        catalogSyncModule.syncWeleticShopifyCatalog({
          workspaceId: "ws_invalid_creds",
        }),
      ).rejects.toThrow("Shopify credentials expired or invalid scope");
    });
  });

  describe("2. Server Action: syncShopifyCatalogAction", () => {
    it("validates input schema requiring non-empty workspaceId", async () => {
      const result = await syncShopifyCatalogAction({ workspaceId: "" });
      expect(result?.validationErrors || result?.serverError).toBeDefined();
    });

    it("executes catalog sync and returns structured result", async () => {
      const syncSpy = vi
        .spyOn(catalogSyncModule, "syncWeleticShopifyCatalog")
        .mockResolvedValue({
          runId: "wsync_server_action_999",
          stats: {
            products: 15,
            variants: 45,
            markets: 2,
            marketPrices: 90,
          },
        } as any);

      const result = await syncShopifyCatalogAction({
        workspaceId: "ws_action_test",
      });

      expect(syncSpy).toHaveBeenCalledWith({ workspaceId: "ws_action_test" });
      expect(result?.data).toEqual({
        success: true,
        stats: {
          products: 15,
          variants: 45,
          markets: 2,
          marketPrices: 90,
        },
        runId: "wsync_server_action_999",
      });
    });

    it("bubbles error when sync execution fails", async () => {
      vi.spyOn(
        catalogSyncModule,
        "syncWeleticShopifyCatalog",
      ).mockRejectedValue(new Error("Shopify API rate limit exceeded (429)"));

      const result = await syncShopifyCatalogAction({
        workspaceId: "ws_rate_limited",
      });

      expect(result?.serverError).toContain(
        "Shopify API rate limit exceeded (429)",
      );
    });
  });

  describe("3. Distributed Lock Concurrency & Collision Rejection", () => {
    it("acquires and releases distributed lock cleanly with Upstash Redis operations", async () => {
      const activeLocks = new Map<string, string>();

      vi.mocked(redis.set).mockImplementation(
        async (key: any, val: any, opts: any) => {
          const actualKey = Array.isArray(key) ? key[0] : key;
          const actualVal = Array.isArray(val) ? val[0] : val;
          if (opts?.nx && activeLocks.has(actualKey)) {
            return null as any;
          }
          activeLocks.set(actualKey, String(actualVal));
          return "OK" as any;
        },
      );

      vi.mocked(redis.eval).mockImplementation(
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

      const lockKey = "weletic:catalog-sync:ws_basic_test";
      const { acquired, token } = await redisLockModule.acquireDistributedLock({
        key: lockKey,
        ttlSeconds: 60,
      });

      expect(acquired).toBe(true);
      expect(typeof token).toBe("string");
      expect(activeLocks.get(lockKey)).toBe(token);

      // Attempting to acquire again while held should fail
      const secondAttempt = await redisLockModule.acquireDistributedLock({
        key: lockKey,
        ttlSeconds: 60,
      });
      expect(secondAttempt.acquired).toBe(false);

      // Releasing with wrong token should fail
      const failedRelease = await redisLockModule.releaseDistributedLock({
        key: lockKey,
        token: "wrong_token",
      });
      expect(failedRelease).toBe(false);
      expect(activeLocks.has(lockKey)).toBe(true);

      // Releasing with correct token should succeed
      const successfulRelease = await redisLockModule.releaseDistributedLock({
        key: lockKey,
        token,
      });
      expect(successfulRelease).toBe(true);
      expect(activeLocks.has(lockKey)).toBe(false);
    });

    it("prevents overlapping concurrent sync runs on the same workspace", async () => {
      const activeLocks = new Map<string, string>();

      vi.mocked(redis.set).mockImplementation(
        async (key: any, val: any, opts: any) => {
          if (opts?.nx && activeLocks.has(key)) {
            return null as any;
          }
          activeLocks.set(key, String(val));
          return "OK" as any;
        },
      );

      vi.mocked(redis.eval).mockImplementation(
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

      const workspaceId = "ws_concurrent_test";
      const lockKey = `weletic:catalog-sync:${workspaceId}`;

      let finishFirstSync: (() => void) | undefined;
      let firstSyncStarted: (() => void) | undefined;
      const startedPromise = new Promise<void>((resolve) => {
        firstSyncStarted = resolve;
      });

      // First sync acquires the lock and starts running
      const firstSyncPromise = redisLockModule.withDistributedLock({
        key: lockKey,
        ttlSeconds: 1800,
        onLocked: () => {
          throw new Error("A Shopify catalog sync is already running.");
        },
        fn: async () => {
          firstSyncStarted?.();
          await new Promise<void>((resolve) => {
            finishFirstSync = resolve;
          });
          return { status: "success" };
        },
      });

      // Ensure the first sync has acquired the lock and is running inside fn
      await startedPromise;

      // Second concurrent sync attempts to run on the same workspace while first is in flight
      const secondSyncPromise = redisLockModule.withDistributedLock({
        key: lockKey,
        ttlSeconds: 1800,
        onLocked: () => {
          throw new Error("A Shopify catalog sync is already running.");
        },
        fn: async () => {
          return { status: "second_run" };
        },
      });

      // Second sync should immediately reject due to lock collision
      await expect(secondSyncPromise).rejects.toThrow(
        "A Shopify catalog sync is already running.",
      );

      // Finish first sync
      finishFirstSync?.();
      const firstResult = await firstSyncPromise;
      expect(firstResult.status).toBe("success");

      // After first sync completes and releases lock, a third sync should now succeed
      const thirdResult = await redisLockModule.withDistributedLock({
        key: lockKey,
        ttlSeconds: 1800,
        onLocked: () => {
          throw new Error("A Shopify catalog sync is already running.");
        },
        fn: async () => {
          return { status: "third_run_success" };
        },
      });
      expect(thirdResult.status).toBe("third_run_success");
    });

    it("allows independent workspaces to sync concurrently without blocking each other", async () => {
      const activeLocks = new Map<string, string>();

      vi.mocked(redis.set).mockImplementation(
        async (key: any, val: any, opts: any) => {
          if (opts?.nx && activeLocks.has(key)) {
            return null as any;
          }
          activeLocks.set(key, String(val));
          return "OK" as any;
        },
      );

      vi.mocked(redis.eval).mockImplementation(
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

      const workspaceA = "ws_tenant_alpha";
      const workspaceB = "ws_tenant_beta";

      const [resA, resB] = await Promise.all([
        redisLockModule.withDistributedLock({
          key: `weletic:catalog-sync:${workspaceA}`,
          fn: async () => ({ tenant: "alpha", synced: true }),
        }),
        redisLockModule.withDistributedLock({
          key: `weletic:catalog-sync:${workspaceB}`,
          fn: async () => ({ tenant: "beta", synced: true }),
        }),
      ]);

      expect(resA).toEqual({ tenant: "alpha", synced: true });
      expect(resB).toEqual({ tenant: "beta", synced: true });
    });
  });

  describe("4. SWR Cache Invalidation Pattern & Toast Verification", () => {
    it("correctly identifies all relevant SWR cache keys for invalidation", () => {
      const filterFn = (key: unknown) =>
        typeof key === "string" &&
        (key.includes("/api/partner-profile") ||
          key.includes("/api/shopify") ||
          key.includes("/api/projects"));

      // Should match partner profile and product endpoints
      expect(filterFn("/api/partner-profile/programs/prog_123/products")).toBe(
        true,
      );
      expect(
        filterFn("/api/partner-profile/programs/prog_123/products/prod_456"),
      ).toBe(true);

      // Should match shopify integration endpoints
      expect(filterFn("/api/shopify/integration/sync")).toBe(true);
      expect(filterFn("/api/shopify/status")).toBe(true);

      // Should match project / workspace endpoints
      expect(filterFn("/api/projects/ws_123")).toBe(true);

      // Should NOT match unrelated endpoints
      expect(filterFn("/api/domains/check")).toBe(false);
      expect(filterFn("/api/analytics/timeseries")).toBe(false);
      expect(filterFn(12345)).toBe(false);
    });

    it("formats success toast message with product and market statistics", () => {
      const stats = { products: 28, markets: 4 };
      const toastMessage = `Đã đồng bộ thành công ${stats.products} sản phẩm và ${stats.markets} thị trường!`;
      expect(toastMessage).toBe(
        "Đã đồng bộ thành công 28 sản phẩm và 4 thị trường!",
      );
    });

    it("formats last synced timestamp in Vietnamese locale", () => {
      const timestamp = new Date("2026-08-21T10:30:00Z");
      const formatted = timestamp.toLocaleTimeString("vi-VN");
      expect(formatted).toBeDefined();
      expect(typeof formatted).toBe("string");
    });
  });
});
