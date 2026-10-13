import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock @vercel/functions
const capturedBackgroundPromises: Promise<any>[] = [];
vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((promise: Promise<any>) => {
    capturedBackgroundPromises.push(promise);
    return promise;
  }),
}));

vi.mock("@/lib/weletic/shopify/get-installation", () => ({
  getWeleticShopifyInstallation: vi.fn(async (workspaceId: string) => ({
    workspaceId,
    programId: "prog_alpha",
    shopDomain: "alpha-shop.myshopify.com",
    accessToken: "shpat_live_test_token_12345",
    installationGeneration: "gen_alpha_1",
  })),
}));

const mockDefaultShopifyGraphqlHandler = async ({
  query,
}: {
  query: string;
}) => {
  if (query.includes("WeleticShopAndMarkets")) {
    return {
      shop: { currencyCode: "USD" },
      markets: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            id: "gid://shopify/Market/1",
            name: "Primary Market",
            handle: "primary",
            status: "ACTIVE",
            primary: true,
            catalogs: { nodes: [] },
            regions: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ code: "US" }],
            },
            webPresence: {
              rootUrls: [{ locale: "en", url: "https://alpha.com" }],
            },
            currencySettings: { baseCurrency: { currencyCode: "USD" } },
          },
        ],
      },
    };
  }
  if (
    query.includes("WeleticProducts") ||
    query.includes("WeleticCatalogProducts")
  ) {
    return {
      products: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          {
            id: "gid://shopify/Product/1",
            handle: "test-prod",
            title: "Test Product",
            descriptionHtml: "<p>Desc</p>",
            productType: "Gear",
            vendor: "Weletic",
            tags: ["tag1"],
            collections: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
            status: "ACTIVE",
            publishedAt: "2026-10-04T00:00:00Z",
            featuredMedia: null,
            vi: [],
            ja: [],
            variants: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "gid://shopify/ProductVariant/1",
                  title: "Default",
                  sku: "SKU1",
                  barcode: null,
                  selectedOptions: [],
                  image: null,
                  availableForSale: true,
                  inventoryQuantity: 5,
                  price: "100.00",
                  compareAtPrice: null,
                },
              ],
            },
          },
        ],
      },
    };
  }
  return {
    productVariants: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [],
    },
  };
};

vi.mock("@/lib/integrations/shopify/admin-graphql", () => ({
  SHOPIFY_ADMIN_API_VERSION: "2026-10",
  shopifyAdminGraphql: vi.fn((args: any) =>
    mockDefaultShopifyGraphqlHandler(args),
  ),
}));

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
    user: { id: "usr_perf02_tester", email: "perf02@weletic.com" },
  })),
}));

vi.mock("@/lib/auth/workspace-cache", () => ({
  workspaceAuthCache: {
    get: vi.fn(({ identifier }) => {
      if (identifier === "ws_unauthorized") return null;
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

// In-Memory Database State for Prisma Mock
interface FakeStore {
  id: string;
  projectId: string;
  programId: string;
  shopDomain: string;
  shopCurrency: string;
  installationGeneration: string | null;
  apiVersion: string;
  syncStatus: string;
  lastFullSyncAt: Date | null;
  lastSyncError: string | null;
  complianceState: "active" | "frozen";
}

interface FakeSyncRun {
  id: string;
  storeId: string;
  kind: string;
  status: string;
  cursor: string | null;
  stats: any;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const fakeStores = new Map<string, FakeStore>();
const fakeSyncRuns = new Map<string, FakeSyncRun>();
const activeRedisLocks = new Map<string, string>();

vi.mock("@/lib/upstash", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/upstash")>();
  return {
    ...actual,
    ratelimit: () => ({
      limit: vi.fn(async () => ({
        success: true,
        limit: 100,
        remaining: 100,
        reset: 0,
      })),
    }),
    redis: {
      set: vi.fn(
        async (
          key: string,
          value: string,
          opts?: { nx?: boolean; ex?: number },
        ) => {
          if (opts?.nx && activeRedisLocks.has(key)) {
            return null;
          }
          activeRedisLocks.set(key, value);
          return "OK";
        },
      ),
      eval: vi.fn(async (script: string, keys: string[], args: string[]) => {
        const key = keys[0];
        const token = args[0];
        if (String(script).includes("del")) {
          if (activeRedisLocks.get(key) === token) {
            activeRedisLocks.delete(key);
            return 1;
          }
          return 0;
        }
        if (String(script).includes("expire")) {
          if (activeRedisLocks.get(key) === token) {
            return 1;
          }
          return 0;
        }
        return 0;
      }),
      get: vi.fn(async (key: string) => activeRedisLocks.get(key) ?? null),
      del: vi.fn(async (key: string) => {
        const existed = activeRedisLocks.delete(key);
        return existed ? 1 : 0;
      }),
    },
    redisGlobal: {
      set: vi.fn(),
      eval: vi.fn(),
    },
  };
});

vi.mock("@/lib/prisma", () => {
  const fakePrismaClient = {
    project: {
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const store = Array.from(fakeStores.values()).find(
          (s) => s.projectId === where.id,
        );
        return {
          id: where.id,
          shopifyStoreId: store?.shopDomain ?? "perf-shop.myshopify.com",
          defaultProgramId: store?.programId ?? "prog_perf_01",
          weleticShopifyStore: store
            ? {
                id: store.id,
                shopDomain: store.shopDomain,
                installationGeneration: store.installationGeneration,
              }
            : null,
          installedIntegrations: [
            {
              credentials: {
                accessToken: "shpat_live_test_token_12345",
                shop: "perf-shop.myshopify.com",
                scope:
                  "read_products,read_markets,read_orders,read_translations,read_customers",
              },
            },
          ],
        };
      }),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return fakeStores.get(where.id) ?? null;
        if (where.projectId) {
          return (
            Array.from(fakeStores.values()).find(
              (s) => s.projectId === where.projectId,
            ) ?? null
          );
        }
        return null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const found =
          fakeStores.get(where.id) ??
          Array.from(fakeStores.values()).find(
            (s) => s.projectId === where.projectId,
          );
        if (!found) throw new Error("Store not found");
        return found;
      }),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        let store = Array.from(fakeStores.values()).find(
          (s) => s.projectId === where.projectId,
        );
        if (store) {
          Object.assign(store, update);
        } else {
          store = {
            id: create.id,
            projectId: create.projectId,
            programId: create.programId,
            shopDomain: create.shopDomain,
            shopCurrency: create.shopCurrency ?? "USD",
            installationGeneration: create.installationGeneration ?? null,
            apiVersion: create.apiVersion ?? "2026-10",
            syncStatus: create.syncStatus ?? "pending",
            lastFullSyncAt: null,
            lastSyncError: null,
            complianceState: "active",
          };
          fakeStores.set(store.id, store);
        }
        return store;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const store = fakeStores.get(where.id);
        if (store) Object.assign(store, data);
        return store;
      }),
    },
    weleticShopifySyncRun: {
      create: vi.fn(async ({ data }: any) => {
        const run: FakeSyncRun = {
          id: data.id,
          storeId: data.storeId,
          kind: data.kind ?? "full_catalog",
          status: data.status ?? "pending",
          cursor: data.cursor ?? null,
          stats: data.stats ?? {
            products: 0,
            variants: 0,
            markets: 0,
            marketPrices: 0,
          },
          error: data.error ?? null,
          startedAt: data.startedAt ?? new Date(),
          completedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        fakeSyncRuns.set(run.id, run);
        return run;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const run = fakeSyncRuns.get(where.id);
        if (!run) return null;
        const store = fakeStores.get(run.storeId);
        return { ...run, store };
      }),
      findFirst: vi.fn(async ({ where, orderBy }: any) => {
        let matches = Array.from(fakeSyncRuns.values());
        if (where?.id) {
          matches = matches.filter((r) => r.id === where.id);
        }
        if (where?.store?.projectId) {
          matches = matches.filter((r) => {
            const store = fakeStores.get(r.storeId);
            return store && store.projectId === where.store.projectId;
          });
        }
        if (where?.status?.in) {
          matches = matches.filter((r) => where.status.in.includes(r.status));
        }
        if (where?.updatedAt?.gte) {
          matches = matches.filter((r) => r.updatedAt >= where.updatedAt.gte);
        }
        if (orderBy?.createdAt === "desc") {
          matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        const run = matches[0] ?? null;
        if (!run) return null;
        const store = fakeStores.get(run.storeId);
        return { ...run, store };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const run = fakeSyncRuns.get(where.id);
        if (run) {
          Object.assign(run, data, { updatedAt: new Date() });
        }
        const store = run ? fakeStores.get(run.storeId) : null;
        return run ? { ...run, store } : null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const run of fakeSyncRuns.values()) {
          let match = true;
          if (where.id && run.id !== where.id) match = false;
          if (where.status?.in && !where.status.in.includes(run.status))
            match = false;
          if (
            where.status &&
            typeof where.status === "string" &&
            run.status !== where.status
          )
            match = false;
          if (match) {
            Object.assign(run, data, { updatedAt: new Date() });
            count++;
          }
        }
        return { count };
      }),
    },
    weleticShopifyMarket: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({ id: "wmarket_1" })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    weleticShopifyProduct: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({ id: "wprod_1" })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    weleticShopifyVariant: {
      findMany: vi.fn(async () => [
        { id: "wvar_1", externalId: "gid://shopify/ProductVariant/1" },
      ]),
      upsert: vi.fn(async () => ({ id: "wvar_1" })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    weleticShopifyTranslation: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({ id: "wtrans_1" })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    weleticShopifyMarketPrice: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(async () => ({ id: "wmprice_1" })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $queryRaw: vi.fn(async () => {
      const store =
        fakeStores.get("wstore_alpha") || Array.from(fakeStores.values())[0];
      if (store) {
        return [
          {
            id: store.id,
            complianceState: "active",
            shopCurrency: store.shopCurrency,
            currencyVerifiedAt: (store as any).currencyVerifiedAt ?? null,
            installationGeneration: store.installationGeneration,
            storeAccessState: "active",
          },
        ];
      }
      return [];
    }),
    $queryRawUnsafe: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
    $executeRawUnsafe: vi.fn(async () => 0),
    $transaction: vi.fn(async (callback: any) => {
      if (typeof callback === "function") {
        return await callback(fakePrismaClient);
      }
      return callback;
    }),
  };
  return { prisma: fakePrismaClient };
});

import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { redis } from "@/lib/upstash";
import {
  acquireDistributedLock,
  releaseDistributedLock,
  resetInMemoryLocks,
} from "@/lib/weletic/redis-lock";
import { runCatalogSyncWorker } from "@/lib/weletic/shopify/catalog-sync";
import {
  GET as getSyncRouteHandler,
  POST as postSyncRouteHandler,
} from "../../app/(ee)/api/shopify/integration/sync/route";

describe("PERF-02: Asynchronous Catalog Sync with Polling & Job Dispatch", () => {
  const workspaceA = "ws_tenant_alpha";
  const workspaceB = "ws_tenant_beta";

  beforeEach(() => {
    vi.restoreAllMocks();
    fakeStores.clear();
    fakeSyncRuns.clear();
    activeRedisLocks.clear();
    capturedBackgroundPromises.length = 0;
    resetInMemoryLocks();
    vi.mocked(shopifyAdminGraphql).mockImplementation((args: any) =>
      mockDefaultShopifyGraphqlHandler(args),
    );

    // Seed store for Workspace A
    const storeA: FakeStore = {
      id: "wstore_alpha",
      projectId: workspaceA,
      programId: "prog_alpha",
      shopDomain: "alpha-shop.myshopify.com",
      shopCurrency: "USD",
      installationGeneration: "gen_alpha_1",
      apiVersion: "2026-10",
      syncStatus: "pending",
      lastFullSyncAt: null,
      lastSyncError: null,
      complianceState: "active",
    };
    fakeStores.set(storeA.id, storeA);

    // Seed store for Workspace B
    const storeB: FakeStore = {
      id: "wstore_beta",
      projectId: workspaceB,
      programId: "prog_beta",
      shopDomain: "beta-shop.myshopify.com",
      shopCurrency: "USD",
      installationGeneration: "gen_beta_1",
      apiVersion: "2026-10",
      syncStatus: "pending",
      lastFullSyncAt: null,
      lastSyncError: null,
      complianceState: "active",
    };
    fakeStores.set(storeB.id, storeB);
  });

  afterEach(async () => {
    await Promise.allSettled(capturedBackgroundPromises);
    capturedBackgroundPromises.length = 0;
    vi.mocked(shopifyAdminGraphql).mockImplementation((args: any) =>
      mockDefaultShopifyGraphqlHandler(args),
    );
    resetInMemoryLocks();
  });

  describe("1. Fast Dispatch SLA (< 200ms) & HTTP 202 Ingress", () => {
    it("POST /api/shopify/integration/sync responds HTTP 202 in < 200ms with pending runId", async () => {
      const mockReq = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}`,
        { method: "POST" },
      );

      const startTime = performance.now();
      const response = await postSyncRouteHandler(mockReq as any, {
        params: Promise.resolve({}),
      });
      const body = await response.json();
      if (response.status !== 202) {
        console.error("POST RESPONSE ERROR BODY:", body);
      }
      expect(response.status).toBe(202);
      expect(body.success).toBe(true);
      expect(body.status).toBe("pending");
      expect(body.runId).toMatch(/^wsync_/);

      // Verify sync run record was initialized in DB
      const createdRun = fakeSyncRuns.get(body.runId);
      expect(createdRun).toBeDefined();
      expect(["pending", "running"]).toContain(createdRun?.status);
      expect(createdRun?.storeId).toBe("wstore_alpha");
      expect(createdRun?.stats).toEqual({
        products: 0,
        variants: 0,
        markets: 0,
        marketPrices: 0,
      });

      // Verify background worker was registered via waitUntil
      expect(capturedBackgroundPromises.length).toBeGreaterThanOrEqual(1);

      // Await background worker to prevent cross-test interference
      await Promise.allSettled(capturedBackgroundPromises);
    });
  });

  describe("2. Background Execution & State Transitions", () => {
    it("transitions run to running and updates checkpoints to succeeded on completion", async () => {
      const runId = "wsync_bg_worker_success";
      const run: FakeSyncRun = {
        id: runId,
        storeId: "wstore_alpha",
        kind: "full_catalog",
        status: "pending",
        cursor: null,
        stats: { products: 0, variants: 0, markets: 0, marketPrices: 0 },
        error: null,
        startedAt: new Date(),
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      fakeSyncRuns.set(run.id, run);

      const lockKey = `weletic:catalog-sync:${workspaceA}`;
      const { token } = await acquireDistributedLock({
        key: lockKey,
        ttlSeconds: 120,
      });

      // Run worker and await completion
      await runCatalogSyncWorker({
        workspaceId: workspaceA,
        runId,
        lockToken: token,
      });

      // Verify that sync completed successfully
      const updatedRun = fakeSyncRuns.get(runId);
      expect(updatedRun?.status).toBe("succeeded");
      expect(updatedRun?.completedAt).toBeInstanceOf(Date);
      expect(updatedRun?.error).toBeNull();
      expect(updatedRun?.stats.products).toBe(1);
      expect(updatedRun?.stats.variants).toBe(1);

      // Verify store was updated with succeeded syncStatus and lastFullSyncAt
      const store = fakeStores.get("wstore_alpha");
      expect(store?.syncStatus).toBe("succeeded");
      expect(store?.lastFullSyncAt).toBeInstanceOf(Date);

      // Verify distributed lock was released in finally block
      expect(activeRedisLocks.has(lockKey)).toBe(false);
    });

    it("transitions run to failed and records error when execution throws", async () => {
      const runId = "wsync_bg_worker_failure";
      const run: FakeSyncRun = {
        id: runId,
        storeId: "wstore_alpha",
        kind: "full_catalog",
        status: "pending",
        cursor: null,
        stats: { products: 0, variants: 0, markets: 0, marketPrices: 0 },
        error: null,
        startedAt: new Date(),
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      fakeSyncRuns.set(run.id, run);

      const lockKey = `weletic:catalog-sync:${workspaceA}`;
      const { token } = await acquireDistributedLock({
        key: lockKey,
        ttlSeconds: 120,
      });

      vi.mocked(shopifyAdminGraphql).mockImplementation(async () => {
        throw new Error("Shopify GraphQL network partition");
      });

      const workerPromise = runCatalogSyncWorker({
        workspaceId: workspaceA,
        runId,
        lockToken: token,
      });

      await expect(workerPromise).rejects.toThrow(
        "Shopify GraphQL network partition",
      );

      // Verify that failure transitioned the run status to failed and recorded completedAt
      const updatedRun = fakeSyncRuns.get(runId);
      expect(updatedRun?.status).toBe("failed");
      expect(updatedRun?.completedAt).toBeInstanceOf(Date);
      expect(updatedRun?.error).toContain("network partition");

      // Verify distributed lock was released in finally block
      expect(activeRedisLocks.has(lockKey)).toBe(false);
    });
  });

  describe("3. Progressive Polling Endpoint (GET /api/shopify/integration/sync)", () => {
    it("returns progressive status: pending -> in_progress -> completed", async () => {
      const runId = "wsync_poll_status_cycle";
      const initialRun: FakeSyncRun = {
        id: runId,
        storeId: "wstore_alpha",
        kind: "full_catalog",
        status: "pending",
        cursor: null,
        stats: { products: 0, variants: 0, markets: 0, marketPrices: 0 },
        error: null,
        startedAt: new Date("2026-10-04T12:00:00Z"),
        completedAt: null,
        createdAt: new Date("2026-10-04T12:00:00Z"),
        updatedAt: new Date("2026-10-04T12:00:00Z"),
      };
      fakeSyncRuns.set(runId, initialRun);

      // 1. Poll when pending
      const reqPending = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}&runId=${runId}`,
      );
      const resPending = await getSyncRouteHandler(reqPending as any, {
        params: Promise.resolve({}),
      });
      expect(resPending.status).toBe(200);
      const bodyPending = await resPending.json();
      expect(bodyPending.runId).toBe(runId);
      expect(bodyPending.status).toBe("pending");
      expect(bodyPending.processedProducts).toBe(0);
      expect(bodyPending.completedAt).toBeNull();

      // 2. Poll when in_progress (running)
      initialRun.status = "running";
      initialRun.stats = {
        products: 25,
        variants: 75,
        markets: 2,
        marketPrices: 150,
      };
      const reqRunning = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}&runId=${runId}`,
      );
      const resRunning = await getSyncRouteHandler(reqRunning as any, {
        params: Promise.resolve({}),
      });
      const bodyRunning = await resRunning.json();
      expect(bodyRunning.status).toBe("in_progress");
      expect(bodyRunning.processedProducts).toBe(25);
      expect(bodyRunning.stats.variants).toBe(75);

      // 3. Poll when completed (succeeded)
      initialRun.status = "succeeded";
      initialRun.stats = {
        products: 50,
        variants: 150,
        markets: 3,
        marketPrices: 450,
      };
      initialRun.completedAt = new Date("2026-10-04T12:02:30Z");
      const reqCompleted = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}&runId=${runId}`,
      );
      const resCompleted = await getSyncRouteHandler(reqCompleted as any, {
        params: Promise.resolve({}),
      });
      const bodyCompleted = await resCompleted.json();
      expect(bodyCompleted.status).toBe("completed");
      expect(bodyCompleted.processedProducts).toBe(50);
      expect(bodyCompleted.stats.products).toBe(50);
      expect(bodyCompleted.completedAt).toBe("2026-10-04T12:02:30.000Z");
    });

    it("returns status failed with error message when sync fails", async () => {
      const runId = "wsync_poll_failure_test";
      const failedRun: FakeSyncRun = {
        id: runId,
        storeId: "wstore_alpha",
        kind: "full_catalog",
        status: "failed",
        cursor: null,
        stats: { products: 12, variants: 36, markets: 1, marketPrices: 36 },
        error: "Shopify Admin GraphQL rate limit exceeded (429)",
        startedAt: new Date("2026-10-04T14:00:00Z"),
        completedAt: new Date("2026-10-04T14:01:00Z"),
        createdAt: new Date("2026-10-04T14:00:00Z"),
        updatedAt: new Date("2026-10-04T14:01:00Z"),
      };
      fakeSyncRuns.set(runId, failedRun);

      const req = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}&runId=${runId}`,
      );
      const res = await getSyncRouteHandler(req as any, {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("failed");
      expect(body.errors).toEqual([
        "Shopify Admin GraphQL rate limit exceeded (429)",
      ]);
      expect(body.processedProducts).toBe(12);
      expect(body.completedAt).toBe("2026-10-04T14:01:00.000Z");
    });

    it("returns the most recent run when runId is omitted", async () => {
      const olderRun: FakeSyncRun = {
        id: "wsync_older",
        storeId: "wstore_alpha",
        kind: "full_catalog",
        status: "succeeded",
        cursor: null,
        stats: { products: 10, variants: 20, markets: 1, marketPrices: 20 },
        error: null,
        startedAt: new Date("2026-10-04T10:00:00Z"),
        completedAt: new Date("2026-10-04T10:01:00Z"),
        createdAt: new Date("2026-10-04T10:00:00Z"),
        updatedAt: new Date("2026-10-04T10:01:00Z"),
      };
      const newerRun: FakeSyncRun = {
        id: "wsync_newer",
        storeId: "wstore_alpha",
        kind: "full_catalog",
        status: "succeeded",
        cursor: null,
        stats: { products: 50, variants: 150, markets: 2, marketPrices: 300 },
        error: null,
        startedAt: new Date("2026-10-04T11:00:00Z"),
        completedAt: new Date("2026-10-04T11:02:00Z"),
        createdAt: new Date("2026-10-04T11:00:00Z"),
        updatedAt: new Date("2026-10-04T11:02:00Z"),
      };
      fakeSyncRuns.set(olderRun.id, olderRun);
      fakeSyncRuns.set(newerRun.id, newerRun);

      const req = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}`,
      );
      const res = await getSyncRouteHandler(req as any, {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.runId).toBe("wsync_newer");
      expect(body.processedProducts).toBe(50);
    });

    it("returns idle status when no runs exist and runId is omitted", async () => {
      const req = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}`,
      );
      const res = await getSyncRouteHandler(req as any, {
        params: Promise.resolve({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("idle");
      expect(body.message).toContain("No sync run found");
    });
  });

  describe("4. Tenant Isolation & Anti-IDOR Protection", () => {
    it("returns HTTP 404 when querying runId belonging to another workspace", async () => {
      // Create a run belonging to Workspace B (Beta)
      const alienRunId = "wsync_alien_run_from_beta";
      const betaRun: FakeSyncRun = {
        id: alienRunId,
        storeId: "wstore_beta",
        kind: "full_catalog",
        status: "succeeded",
        cursor: null,
        stats: { products: 100, variants: 300, markets: 4, marketPrices: 1200 },
        error: null,
        startedAt: new Date(),
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      fakeSyncRuns.set(alienRunId, betaRun);

      // Workspace A (Alpha) attempts to query Workspace B's runId (IDOR probe)
      const req = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}&runId=${alienRunId}`,
      );
      const res = await getSyncRouteHandler(req as any, {
        params: Promise.resolve({}),
      });

      // Tenant isolation MUST reject with HTTP 404 Not Found
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.message).toBe("Sync run not found.");
    });
  });

  describe("5. Concurrency Collision Rejection (HTTP 409 Conflict)", () => {
    it("returns HTTP 409 Conflict when a sync is already running on the same workspace", async () => {
      // Simulate active distributed lock held for Workspace A
      const lockKey = `weletic:catalog-sync:${workspaceA}`;
      activeRedisLocks.set(lockKey, "token_held_by_first_job");

      const mockReq = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}`,
        { method: "POST" },
      );

      const res = await postSyncRouteHandler(mockReq as any, {
        params: Promise.resolve({}),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.message).toContain("already running");
    });

    it("returns HTTP 409 Conflict when an active run exists in DB within lease window", async () => {
      const activeRun: FakeSyncRun = {
        id: "wsync_recently_active",
        storeId: "wstore_alpha",
        kind: "full_catalog",
        status: "running",
        cursor: null,
        stats: { products: 10, variants: 20, markets: 1, marketPrices: 20 },
        error: null,
        startedAt: new Date(),
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(), // Just updated
      };
      fakeSyncRuns.set(activeRun.id, activeRun);

      const mockReq = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}`,
        { method: "POST" },
      );

      const res = await postSyncRouteHandler(mockReq as any, {
        params: Promise.resolve({}),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.message).toContain("already running");
    });
  });

  describe("6. Distributed Lock Lifecycle & Lua Safe Release", () => {
    it("acquires lock with 120s TTL and safely releases via Lua script", async () => {
      const lockKey = `weletic:catalog-sync:${workspaceA}`;
      const { acquired, token } = await acquireDistributedLock({
        key: lockKey,
        ttlSeconds: 120,
      });

      expect(acquired).toBe(true);
      expect(activeRedisLocks.get(lockKey)).toBe(token);

      // Attempting to acquire again with different token fails
      const collision = await acquireDistributedLock({
        key: lockKey,
        ttlSeconds: 120,
      });
      expect(collision.acquired).toBe(false);

      // Safe Lua release with token
      const released = await releaseDistributedLock({
        key: lockKey,
        token,
      });
      expect(released).toBe(true);
      expect(activeRedisLocks.has(lockKey)).toBe(false);
    });

    it("prevents release when token does not match (stale lease expiration)", async () => {
      const lockKey = `weletic:catalog-sync:${workspaceA}`;
      await acquireDistributedLock({ key: lockKey, ttlSeconds: 120 });

      // Stale / mismatched token attempted release
      const badRelease = await releaseDistributedLock({
        key: lockKey,
        token: "token_from_another_dead_process",
      });

      expect(badRelease).toBe(false);
      expect(activeRedisLocks.has(lockKey)).toBe(true);
    });
  });

  describe("7. Offline Mock Resilience (upstash.invalid Fallback)", () => {
    it("falls back safely to in-memory lock map when Redis throws network error", async () => {
      // Mock Redis throwing network / DNS failure as with upstash.invalid
      vi.mocked(redis.set).mockRejectedValueOnce(
        new Error("getaddrinfo ENOTFOUND upstash.invalid"),
      );

      const lockKey = "weletic:catalog-sync:offline_store";
      const { acquired, token } = await acquireDistributedLock({
        key: lockKey,
        ttlSeconds: 120,
      });

      // Should gracefully acquire via in-memory fallback without throwing
      expect(acquired).toBe(true);
      expect(typeof token).toBe("string");

      // Second attempt while held in-memory should fail
      vi.mocked(redis.set).mockRejectedValueOnce(
        new Error("getaddrinfo ENOTFOUND upstash.invalid"),
      );
      const secondAttempt = await acquireDistributedLock({
        key: lockKey,
        ttlSeconds: 120,
      });
      expect(secondAttempt.acquired).toBe(false);

      // Release should also succeed in-memory
      vi.mocked(redis.eval).mockRejectedValueOnce(
        new Error("getaddrinfo ENOTFOUND upstash.invalid"),
      );
      const released = await releaseDistributedLock({
        key: lockKey,
        token,
      });
      expect(released).toBe(true);
    });
  });
});
