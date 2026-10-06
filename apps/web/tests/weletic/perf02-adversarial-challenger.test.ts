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
    programId: `prog_${workspaceId}`,
    shopDomain: `${workspaceId}.myshopify.com`,
    accessToken: `shpat_live_token_${workspaceId}`,
    installationGeneration: `gen_${workspaceId}_1`,
  })),
}));

let simulatedGraphqlDelayMs = 0;
let simulatedGraphqlError: Error | null = null;

const mockDefaultShopifyGraphqlHandler = async ({
  query,
}: {
  query: string;
}) => {
  if (simulatedGraphqlDelayMs > 0) {
    await new Promise((r) => setTimeout(r, simulatedGraphqlDelayMs));
  }
  if (simulatedGraphqlError) {
    throw simulatedGraphqlError;
  }
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
              rootUrls: [{ locale: "en", url: "https://test.com" }],
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
            handle: "challenger-prod",
            title: "Challenger Product",
            descriptionHtml: "<p>Empirical Test</p>",
            productType: "Gear",
            vendor: "Weletic",
            tags: ["test"],
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
                  sku: "CHALLENGE-SKU",
                  barcode: null,
                  selectedOptions: [],
                  image: null,
                  availableForSale: true,
                  inventoryQuantity: 10,
                  price: "250.00",
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
    user: { id: "usr_challenger", email: "challenger@weletic.com" },
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

// In-Memory Database State
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
          shopifyStoreId: store?.shopDomain ?? `${where.id}.myshopify.com`,
          defaultProgramId: store?.programId ?? `prog_${where.id}`,
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
                accessToken: `shpat_live_token_${where.id}`,
                shop: `${where.id}.myshopify.com`,
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
    $queryRaw: vi.fn(async (sql: any) => {
      const param = sql?.values?.[0];
      let store = param
        ? fakeStores.get(param) ??
          Array.from(fakeStores.values()).find((s) => s.projectId === param)
        : null;
      if (!store) {
        store = Array.from(fakeStores.values())[0];
      }
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

import {
  acquireDistributedLock,
  releaseDistributedLock,
  resetInMemoryLocks,
} from "@/lib/weletic/redis-lock";
import {
  dispatchWeleticShopifyCatalogSync,
  runCatalogSyncWorker,
} from "@/lib/weletic/shopify/catalog-sync";
import {
  GET as getSyncRouteHandler,
  POST as postSyncRouteHandler,
} from "../../app/(ee)/api/shopify/integration/sync/route";

describe("EMPIRICAL CHALLENGER: PERF-02 Async Catalog Sync Adversarial Stress Test", () => {
  const workspaceA = "ws_challenger_alpha";
  const workspaceB = "ws_challenger_beta";
  const workspaceC = "ws_challenger_gamma";

  const setupStore = (ws: string) => {
    const store: FakeStore = {
      id: `wstore_${ws}`,
      projectId: ws,
      programId: `prog_${ws}`,
      shopDomain: `${ws}.myshopify.com`,
      shopCurrency: "USD",
      installationGeneration: `gen_${ws}_1`,
      apiVersion: "2026-10",
      syncStatus: "pending",
      lastFullSyncAt: null,
      lastSyncError: null,
      complianceState: "active",
    };
    fakeStores.set(store.id, store);
    return store;
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    fakeStores.clear();
    fakeSyncRuns.clear();
    activeRedisLocks.clear();
    capturedBackgroundPromises.length = 0;
    simulatedGraphqlDelayMs = 0;
    simulatedGraphqlError = null;
    resetInMemoryLocks();

    setupStore(workspaceA);
    setupStore(workspaceB);
    setupStore(workspaceC);
  });

  afterEach(async () => {
    await Promise.allSettled(capturedBackgroundPromises);
    capturedBackgroundPromises.length = 0;
    resetInMemoryLocks();
  });

  describe("Boundary 1: POST Dispatch Latency SLA (< 200ms)", () => {
    it("strictly verifies POST dispatch latency is under 200ms across 50 iterations", async () => {
      const latencies: number[] = [];

      for (let i = 0; i < 50; i++) {
        // Clear previous locks/runs to allow clean dispatch
        activeRedisLocks.clear();
        fakeSyncRuns.clear();
        resetInMemoryLocks();

        const req = new Request(
          `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}`,
          { method: "POST" },
        );

        const t0 = performance.now();
        const res = await postSyncRouteHandler(req as any, {
          params: Promise.resolve({}),
        });
        const elapsed = performance.now() - t0;
        latencies.push(elapsed);

        expect(res.status).toBe(202);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.status).toBe("pending");
        expect(data.runId).toMatch(/^wsync_/);
        expect(elapsed).toBeLessThan(200); // Strict SLA check
      }

      latencies.sort((a, b) => a - b);
      const p50 = latencies[Math.floor(latencies.length * 0.5)];
      const p95 = latencies[Math.floor(latencies.length * 0.95)];
      const p99 = latencies[Math.floor(latencies.length * 0.99)];
      const max = latencies[latencies.length - 1];

      // Assert statistical metrics satisfy SLA
      expect(p50).toBeLessThan(50);
      expect(p95).toBeLessThan(100);
      expect(p99).toBeLessThan(150);
      expect(max).toBeLessThan(200);
    });

    it("ensures POST response is detached and under 200ms even if Shopify GraphQL takes 400ms", async () => {
      // Simulate heavy upstream delay of 400ms (> 200ms SLA)
      simulatedGraphqlDelayMs = 400;

      const req = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}`,
        { method: "POST" },
      );

      const t0 = performance.now();
      const res = await postSyncRouteHandler(req as any, {
        params: Promise.resolve({}),
      });
      const elapsed = performance.now() - t0;

      // The POST endpoint MUST return immediately (< 200ms) without waiting for the 3s worker!
      expect(elapsed).toBeLessThan(200);
      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.status).toBe("pending");
      expect(data.runId).toBeDefined();

      // Verify the slow background worker is enqueued in waitUntil
      expect(capturedBackgroundPromises.length).toBeGreaterThan(0);
    });
  });

  describe("Boundary 2: Concurrency Collisions & Race Conditions (HTTP 409 Conflict)", () => {
    it("burst of 10 simultaneous POST requests results in exactly 1 HTTP 202 and 9 HTTP 409s", async () => {
      const requests = Array.from(
        { length: 10 },
        () =>
          new Request(
            `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}`,
            { method: "POST" },
          ),
      );

      // Fire all 10 simultaneously
      const responses = await Promise.all(
        requests.map((r) =>
          postSyncRouteHandler(r as any, { params: Promise.resolve({}) }),
        ),
      );

      const statuses = responses.map((r) => r.status);
      const accepted202 = statuses.filter((s) => s === 202);
      const conflict409 = statuses.filter((s) => s === 409);

      expect(accepted202.length).toBe(1);
      expect(conflict409.length).toBe(9);

      // Verify error bodies for all 409s
      for (const res of responses) {
        if (res.status === 409) {
          const body = await res.json();
          expect(body.error.message).toMatch(
            /already running|Could not acquire lock/,
          );
        }
      }
    });

    it("parallel requests to separate workspaces (A and B) succeed simultaneously without collision", async () => {
      const reqA = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}`,
        { method: "POST" },
      );
      const reqB = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceB}`,
        { method: "POST" },
      );

      const [resA, resB] = await Promise.all([
        postSyncRouteHandler(reqA as any, { params: Promise.resolve({}) }),
        postSyncRouteHandler(reqB as any, { params: Promise.resolve({}) }),
      ]);

      expect(resA.status).toBe(202);
      expect(resB.status).toBe(202);

      const bodyA = await resA.json();
      const bodyB = await resB.json();

      expect(bodyA.runId).toBeDefined();
      expect(bodyB.runId).toBeDefined();
      expect(bodyA.runId).not.toBe(bodyB.runId);
    });

    it("rejects with HTTP 409 when an active run exists in DB even if Redis lock was somehow dropped", async () => {
      // Create a DB run that is currently running and recently updated
      const activeRun: FakeSyncRun = {
        id: "wsync_active_db_fence",
        storeId: `wstore_${workspaceA}`,
        kind: "full_catalog",
        status: "running",
        cursor: null,
        stats: { products: 5, variants: 10, markets: 1, marketPrices: 10 },
        error: null,
        startedAt: new Date(),
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(Date.now() - 30_000), // 30 seconds ago (< 120s)
      };
      fakeSyncRuns.set(activeRun.id, activeRun);

      // Redis lock is NOT set (simulating dropped lock or multi-pod split)
      activeRedisLocks.clear();

      const req = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}`,
        { method: "POST" },
      );

      const res = await postSyncRouteHandler(req as any, {
        params: Promise.resolve({}),
      });

      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.message).toContain("already running");

      // Verify the tentative lock acquired during dispatch was cleanly released
      expect(activeRedisLocks.size).toBe(0);
    });
  });

  describe("Boundary 3: Anti-IDOR Security & Cross-Workspace Tenant Boundary", () => {
    it("returns HTTP 404 Not Found when Workspace B queries Workspace A's runId", async () => {
      const runA: FakeSyncRun = {
        id: "wsync_alpha_secret_run",
        storeId: `wstore_${workspaceA}`,
        kind: "full_catalog",
        status: "succeeded",
        cursor: null,
        stats: { products: 100, variants: 500, markets: 5, marketPrices: 2500 },
        error: null,
        startedAt: new Date(),
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      fakeSyncRuns.set(runA.id, runA);

      // Workspace B tries to read runA
      const req = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceB}&runId=${runA.id}`,
      );

      const res = await getSyncRouteHandler(req as any, {
        params: Promise.resolve({}),
      });

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.message).toBe("Sync run not found.");
      expect(body.stats).toBeUndefined();
    });

    it("returns idle status without leaking data when Workspace C queries without runId", async () => {
      // A and B both have runs
      fakeSyncRuns.set("run_a", {
        id: "run_a",
        storeId: `wstore_${workspaceA}`,
        kind: "full_catalog",
        status: "succeeded",
        cursor: null,
        stats: { products: 10, variants: 20, markets: 1, marketPrices: 20 },
        error: null,
        startedAt: new Date(),
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Workspace C has NO runs
      const req = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceC}`,
      );

      const res = await getSyncRouteHandler(req as any, {
        params: Promise.resolve({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("idle");
      expect(body.message).toBe("No sync run found for this workspace.");
      expect(body.runId).toBeUndefined();
    });

    it("safely handles malicious / tampered runId inputs without 500 crashes", async () => {
      const maliciousProbes = [
        "wsync_does_not_exist",
        "' OR '1'='1",
        "../../etc/passwd",
        "<script>alert(1)</script>",
        "null",
        "undefined",
      ];

      for (const probe of maliciousProbes) {
        const req = new Request(
          `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}&runId=${encodeURIComponent(probe)}`,
        );

        const res = await getSyncRouteHandler(req as any, {
          params: Promise.resolve({}),
        });

        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error.message).toBe("Sync run not found.");
      }
    });

    it("verifies GET response never leaks sensitive tokens or raw store credentials", async () => {
      const runA: FakeSyncRun = {
        id: "wsync_alpha_public_check",
        storeId: `wstore_${workspaceA}`,
        kind: "full_catalog",
        status: "succeeded",
        cursor: null,
        stats: { products: 42, variants: 84, markets: 1, marketPrices: 84 },
        error: null,
        startedAt: new Date(),
        completedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      fakeSyncRuns.set(runA.id, runA);

      const req = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}&runId=${runA.id}`,
      );
      const res = await getSyncRouteHandler(req as any, {
        params: Promise.resolve({}),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      const stringified = JSON.stringify(body);

      // Verify no access tokens or internal secrets in response
      expect(stringified).not.toContain("accessToken");
      expect(stringified).not.toContain("shpat_");
      expect(stringified).not.toContain("installationGeneration");
    });
  });

  describe("Boundary 4: Lock Failure & Fatal Exception Safe Release", () => {
    it("guarantees lock is released and run transitions to failed even on catastrophic worker crash", async () => {
      const runId = "wsync_catastrophic_crash";
      const run: FakeSyncRun = {
        id: runId,
        storeId: `wstore_${workspaceA}`,
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
      fakeSyncRuns.set(runId, run);

      const lockKey = `weletic:catalog-sync:${workspaceA}`;
      const { token } = await acquireDistributedLock({
        key: lockKey,
        ttlSeconds: 120,
      });

      // Simulate fatal GraphQL network exception
      simulatedGraphqlError = new Error("FATAL_GRAPHQL_SOCKET_HANGUP");

      const workerPromise = runCatalogSyncWorker({
        workspaceId: workspaceA,
        runId,
        lockToken: token,
      });

      await expect(workerPromise).rejects.toThrow(
        "FATAL_GRAPHQL_SOCKET_HANGUP",
      );

      // Verify distributed lock is 100% released in Redis / in-memory map
      expect(activeRedisLocks.has(lockKey)).toBe(false);

      // Verify run status was updated to 'failed' and recorded error
      const updatedRun = fakeSyncRuns.get(runId);
      expect(updatedRun?.status).toBe("failed");
      expect(updatedRun?.error).toContain("FATAL_GRAPHQL_SOCKET_HANGUP");
      expect(updatedRun?.completedAt).toBeInstanceOf(Date);

      // Crucial SLA verification: Immediately subsequent POST sync MUST succeed without waiting for 120s TTL
      simulatedGraphqlError = null; // restore service
      const nextReq = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${workspaceA}`,
        { method: "POST" },
      );
      const nextRes = await postSyncRouteHandler(nextReq as any, {
        params: Promise.resolve({}),
      });

      expect(nextRes.status).toBe(202);
      const nextBody = await nextRes.json();
      expect(nextBody.success).toBe(true);
      expect(nextBody.runId).not.toBe(runId);
    });

    it("protects lock ownership so that an expired or mismatched token cannot release an active lock", async () => {
      const lockKey = `weletic:catalog-sync:${workspaceA}`;
      const lock1 = await acquireDistributedLock({
        key: lockKey,
        ttlSeconds: 120,
      });
      expect(lock1.acquired).toBe(true);

      // Dead worker attempts release with expired/wrong token
      const wrongRelease = await releaseDistributedLock({
        key: lockKey,
        token: "stale_token_from_previous_lease",
      });
      expect(wrongRelease).toBe(false);

      // Lock is STILL held by lock1
      expect(activeRedisLocks.get(lockKey)).toBe(lock1.token);

      // Proper owner releases lock
      const properRelease = await releaseDistributedLock({
        key: lockKey,
        token: lock1.token,
      });
      expect(properRelease).toBe(true);
      expect(activeRedisLocks.has(lockKey)).toBe(false);
    });

    it("safely releases acquired lock if dispatch transaction throws an error", async () => {
      const lockKey = `weletic:catalog-sync:${workspaceA}`;

      // Trigger dispatch with mismatched expectedInstallationGeneration to force rejection
      await expect(
        dispatchWeleticShopifyCatalogSync({
          workspaceId: workspaceA,
          expectedInstallationGeneration: "stale_generation_xyz",
        }),
      ).rejects.toThrow(
        "Shopify catalog trigger belongs to a stale installation.",
      );

      // Verify lock was NOT leaked
      expect(activeRedisLocks.has(lockKey)).toBe(false);

      // Verify dispatch with valid generation succeeds immediately
      const result = await dispatchWeleticShopifyCatalogSync({
        workspaceId: workspaceA,
        expectedInstallationGeneration: `gen_${workspaceA}_1`,
      });
      expect(result.status).toBe("pending");
      expect(result.runId).toBeDefined();
    });
  });

  describe("Boundary 5: Architectural Invariant Verification", () => {
    it("complies with Shopify multi-domain and multi-tenant isolation without hardcoding", async () => {
      // Dynamic store setup for a custom merchant domain
      const customStore: FakeStore = {
        id: "wstore_custom_domain",
        projectId: "ws_custom_tenant",
        programId: "prog_ws_custom_tenant",
        shopDomain: "my-custom-store.myshopify.com",
        shopCurrency: "JPY",
        installationGeneration: "gen_ws_custom_tenant_1",
        apiVersion: "2026-10",
        syncStatus: "pending",
        lastFullSyncAt: null,
        lastSyncError: null,
        complianceState: "active",
      };
      fakeStores.set(customStore.id, customStore);

      const req = new Request(
        `http://localhost:3000/api/shopify/integration/sync?workspaceId=${customStore.projectId}`,
        { method: "POST" },
      );

      const res = await postSyncRouteHandler(req as any, {
        params: Promise.resolve({}),
      });

      const body = await res.json();
      if (res.status !== 202) {
        console.error("BOUNDARY 5 ERROR BODY:", body);
      }
      expect(res.status).toBe(202);
      expect(body.runId).toBeDefined();

      const run = fakeSyncRuns.get(body.runId);
      expect(run?.storeId).toBe(customStore.id);
    });
  });
});
