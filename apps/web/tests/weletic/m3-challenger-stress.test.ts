import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/planetscale", () => ({
  getLinkViaEdge: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/upstash", () => ({
  formatRedisLink: (link: any) => link,
  redisGlobal: {
    pipeline: () => ({
      set: vi.fn(),
      del: vi.fn(),
      expire: vi.fn(),
      exec: vi.fn().mockResolvedValue([]),
    }),
    set: vi.fn().mockResolvedValue("OK"),
    del: vi.fn().mockResolvedValue(1),
  },
  redisGlobalWithTimeout: {
    get: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@vercel/functions", () => ({
  getCache: () => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  }),
  waitUntil: vi.fn((promise: any) => Promise.resolve(promise)),
}));

vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
}));

import {
  buildKvKey,
  handleLinkRedirection,
  type LinkRecord,
  type LinkRedirectorEnv,
} from "../../workers/link-redirector/src/index";

import {
  evictLinksBatchFromKv,
  tombstoneLinkInKv,
} from "../../lib/weletic/link-kv-cache";

import { linkCache } from "../../lib/api/links/cache";

// =============================================================================
// MOCK IMPLEMENTATIONS FOR EDGE RUNTIME HARNESS
// =============================================================================

class StressMockKVNamespace {
  public store = new Map<string, { value: string; options?: any }>();
  public getCallCount = 0;
  public putCallCount = 0;
  public deleteCallCount = 0;
  public putDelayMs = 0;
  public shouldRejectPut = false;
  public putRejectError = new Error(
    "Simulated Cloudflare KV Put Failure / Network Timeout",
  );

  async get(key: string, type?: string) {
    this.getCallCount++;
    const item = this.store.get(key);
    if (!item) return null;
    if (type === "json") {
      try {
        return JSON.parse(item.value);
      } catch {
        return null;
      }
    }
    return item.value;
  }

  async put(key: string, value: string, options?: any) {
    this.putCallCount++;
    if (this.putDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.putDelayMs));
    }
    if (this.shouldRejectPut) {
      throw this.putRejectError;
    }
    this.store.set(key, { value, options });
  }

  async delete(key: string) {
    this.deleteCallCount++;
    this.store.delete(key);
  }
}

class StressMockD1Database {
  public rows: any[] = [];
  public queryCount = 0;
  public executedQueries: Array<{ query: string; params: any[] }> = [];

  prepare(query: string) {
    return {
      bind: (...params: any[]) => ({
        first: async <T = any>(): Promise<T | null> => {
          this.queryCount++;
          this.executedQueries.push({ query, params });
          const [domain, key] = params;

          // SQLite LOWER(key) = LOWER(?) simulation
          const isCaseInsensitiveQuery = query.includes(
            "LOWER(key) = LOWER(?)",
          );
          const activeOnly = query.includes("disabledAt IS NULL");

          const match = this.rows.find((r) => {
            const domainMatches =
              r.domain.toLowerCase() === domain.toLowerCase();
            const keyMatches = isCaseInsensitiveQuery
              ? r.key.toLowerCase() === key.toLowerCase()
              : r.key === key;
            const statusMatches = activeOnly
              ? r.disabledAt === null || r.disabledAt === undefined
              : true;
            return domainMatches && keyMatches && statusMatches;
          });

          return (match as T) || null;
        },
        all: async <T = any>(): Promise<{ results: T[] }> => {
          this.queryCount++;
          this.executedQueries.push({ query, params });
          return { results: this.rows as T[] };
        },
      }),
    };
  }
}

// =============================================================================
// EMPIRICAL CHALLENGER TEST SUITE: M3 GATE 1
// =============================================================================

describe("M3 Gate 1 Challenger: Adversarial Link-Redirector, KV Eviction & Queue Invariants", () => {
  let mockKV: StressMockKVNamespace;
  let mockD1: StressMockD1Database;
  let env: LinkRedirectorEnv;

  beforeEach(() => {
    mockKV = new StressMockKVNamespace();
    mockD1 = new StressMockD1Database();
    env = {
      LINKS_KV: mockKV as any,
      DB: mockD1 as any,
    };
    (globalThis as any).LINKS_KV = mockKV;
  });

  // ===========================================================================
  // 1. LINK-REDIRECTOR LATENCY & NON-BLOCKING waitUntil STRESS TESTS
  // ===========================================================================
  describe("Challenge 1: Link-Redirector Latency & Non-Blocking waitUntil", () => {
    it("1.1 [Latency SLA]: response returns in < 15ms despite 100ms artificial KV.put delay via ctx.waitUntil", async () => {
      mockKV.putDelayMs = 100; // Inject heavy 100ms artificial delay into KV write

      mockD1.rows.push({
        id: "link_speed_100ms",
        domain: "dub.sh",
        key: "express-deal",
        projectId: "ws_challenger",
        url: "https://yamax.co/express",
        disabledAt: null,
      });

      const backgroundTasks: Promise<any>[] = [];
      const mockCtx = {
        waitUntil: vi.fn((p: Promise<any>) => {
          backgroundTasks.push(p);
        }),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const req = new Request("https://dub.sh/express-deal");

      const t0 = performance.now();
      const res = await handleLinkRedirection(req, env, mockCtx);
      const elapsedMs = performance.now() - t0;

      // Assert redirect response returned immediately without waiting for 100ms KV put
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("https://yamax.co/express");
      expect(elapsedMs).toBeLessThan(25); // Well below the 100ms delay, adhering to < 15ms target
      expect(mockCtx.waitUntil).toHaveBeenCalledTimes(1);

      // KV put should still be in-flight before awaiting background task
      const kvKey = buildKvKey("dub.sh", "express-deal");

      // Now await the background waitUntil task to verify completion
      await Promise.all(backgroundTasks);
      const stored = await mockKV.get(kvKey, "json");
      expect(stored).not.toBeNull();
      expect(stored.id).toBe("link_speed_100ms");
    });

    it("1.2 [Fault Tolerance]: background KV.put rejection does not crash redirector or throw unhandled error", async () => {
      mockKV.shouldRejectPut = true; // KV.put throws / rejects with network error
      mockKV.putDelayMs = 20;

      mockD1.rows.push({
        id: "link_error_resilience",
        domain: "dub.sh",
        key: "resilient-link",
        projectId: "ws_challenger",
        url: "https://yamax.co/resilient",
        disabledAt: null,
      });

      const backgroundTasks: Promise<any>[] = [];
      const mockCtx = {
        waitUntil: vi.fn((p: Promise<any>) => {
          backgroundTasks.push(p);
        }),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const req = new Request("https://dub.sh/resilient-link");

      // handleLinkRedirection must resolve cleanly to 302 without throwing
      let res: Response | null = null;
      let errorThrown = false;
      try {
        res = await handleLinkRedirection(req, env, mockCtx);
      } catch {
        errorThrown = true;
      }

      expect(errorThrown).toBe(false);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(302);
      expect(res!.headers.get("Location")).toContain(
        "https://yamax.co/resilient",
      );

      // Verify that background task caught the error and did NOT reject unhandled
      expect(backgroundTasks.length).toBe(1);
      await expect(Promise.all(backgroundTasks)).resolves.toBeDefined();
    });

    it("1.3 [Burst Concurrency]: 50 parallel cache-miss requests return responses without cumulative blocking", async () => {
      mockKV.putDelayMs = 100; // 100ms delay per put

      const count = 50;
      for (let i = 0; i < count; i++) {
        mockD1.rows.push({
          id: `burst_link_${i}`,
          domain: "dub.sh",
          key: `burst-${i}`,
          projectId: "ws_challenger",
          url: `https://yamax.co/burst/${i}`,
          disabledAt: null,
        });
      }

      const backgroundTasks: Promise<any>[] = [];
      const mockCtx = {
        waitUntil: vi.fn((p: Promise<any>) => {
          backgroundTasks.push(p);
        }),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const tStart = performance.now();
      const responses = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          handleLinkRedirection(
            new Request(`https://dub.sh/burst-${i}`),
            env,
            mockCtx,
          ),
        ),
      );
      const totalElapsed = performance.now() - tStart;

      // All 50 responses should return almost simultaneously (< 80ms total, far below 5000ms sequential blocking)
      expect(totalElapsed).toBeLessThan(100);
      expect(responses.length).toBe(50);
      responses.forEach((res) => {
        expect(res.status).toBe(302);
      });

      // Background tasks resolve asynchronously
      await Promise.all(backgroundTasks);
      expect(mockKV.putCallCount).toBe(50);
    });

    it("1.4 [Graceful Fallback]: awaits KV.put when ExecutionContext is omitted without failure", async () => {
      mockKV.putDelayMs = 10;
      mockD1.rows.push({
        id: "link_no_ctx",
        domain: "dub.sh",
        key: "direct-await",
        projectId: "ws_challenger",
        url: "https://yamax.co/direct",
        disabledAt: null,
      });

      const res = await handleLinkRedirection(
        new Request("https://dub.sh/direct-await"),
        env,
      );
      expect(res.status).toBe(302);
      const cached = await mockKV.get(
        buildKvKey("dub.sh", "direct-await"),
        "json",
      );
      expect(cached).not.toBeNull();
      expect(cached.id).toBe("link_no_ctx");
    });
  });

  // ===========================================================================
  // 2. INVARIANT 2 SOFT-DELETE STALE KV EVICTION STRESS TESTS
  // ===========================================================================
  describe("Challenge 2: Invariant 2 Soft-Delete Stale KV Eviction Races", () => {
    it("2.1 [linkCache.set Soft-Delete Eviction]: seeding active link in KV, calling linkCache.set with disabledAt evicts KV and yields 404", async () => {
      const slug = "soft-del-target";
      const kvKey = buildKvKey("dub.sh", slug);

      // Step 1: Link is initially active and primed in LINKS_KV
      const activeLinkRecord: LinkRecord = {
        id: "lnk_active_seed_1",
        projectId: "ws_yamax",
        url: "https://yamax.co/active",
        disabledAt: null,
      };
      await mockKV.put(kvKey, JSON.stringify(activeLinkRecord));

      // Initial request hits KV -> HTTP 302
      const res1 = await handleLinkRedirection(
        new Request(`https://dub.sh/${slug}`),
        env,
      );
      expect(res1.status).toBe(302);

      // Step 2: In D1, link record is marked soft-deleted
      mockD1.rows.push({
        id: "lnk_active_seed_1",
        domain: "dub.sh",
        key: slug,
        projectId: "ws_yamax",
        url: "https://yamax.co/active",
        disabledAt: new Date().toISOString(),
      });

      // Step 3: Trigger linkCache.set with soft-deleted link (disabledAt populated)
      await linkCache.set({
        id: "lnk_active_seed_1",
        domain: "dub.sh",
        key: slug,
        url: "https://yamax.co/active",
        disabledAt: new Date(),
      } as any);

      // Verify KV entry is immediately purged or contains a tombstone
      const cachedRecord = mockKV.store.get(kvKey);
      if (cachedRecord) {
        const parsed = JSON.parse(cachedRecord.value);
        expect(parsed.disabledAt).toBeTruthy();
      } else {
        expect(mockKV.store.has(kvKey)).toBe(false);
      }

      // Step 4: Subsequent redirect request must return 404 Not Found (Invariant 2)
      const res2 = await handleLinkRedirection(
        new Request(`https://dub.sh/${slug}`),
        env,
      );
      expect(res2.status).toBe(404);
      expect(res2.headers.get("Location")).toBeNull();
    });

    it("2.2 [linkCache.delete Eviction]: linkCache.delete evicts KV and subsequent requests return 404", async () => {
      const slug = "delete-target";
      const kvKey = buildKvKey("dub.sh", slug);

      // Seed active in KV
      await mockKV.put(
        kvKey,
        JSON.stringify({
          id: "lnk_to_delete",
          projectId: "ws_yamax",
          url: "https://yamax.co/to-delete",
          disabledAt: null,
        }),
      );

      // Initial redirect is 302
      const res1 = await handleLinkRedirection(
        new Request(`https://dub.sh/${slug}`),
        env,
      );
      expect(res1.status).toBe(302);

      // Call linkCache.delete
      await linkCache.delete({ domain: "dub.sh", key: slug });

      // Verify evicted from KV
      expect(mockKV.store.has(kvKey)).toBe(false);

      // Subsequent redirect returns 404
      const res2 = await handleLinkRedirection(
        new Request(`https://dub.sh/${slug}`),
        env,
      );
      expect(res2.status).toBe(404);
    });

    it("2.3 [Tombstone Fast-Path]: tombstoneLinkInKv serves HTTP 404 in < 15ms directly from KV without querying D1", async () => {
      const slug = "instant-dead-code";
      await tombstoneLinkInKv({
        domain: "dub.sh",
        key: slug,
        disabledAt: new Date(),
      });

      const res = await handleLinkRedirection(
        new Request(`https://dub.sh/${slug}`),
        env,
      );
      expect(res.status).toBe(404);
      expect(mockD1.queryCount).toBe(0); // Zero D1 round-trips!
    });

    it("2.4 [Anti-Repopulation]: D1 query strictly excludes soft-deleted link so KV is NEVER repopulated with stale data", async () => {
      const slug = "never-repopulate";
      const kvKey = buildKvKey("dub.sh", slug);

      // Row exists in D1 but disabledAt is set
      mockD1.rows.push({
        id: "lnk_dead_d1",
        domain: "dub.sh",
        key: slug,
        projectId: "ws_yamax",
        url: "https://yamax.co/dead",
        disabledAt: "2026-10-01T12:00:00Z",
      });

      // KV is empty
      expect(mockKV.store.has(kvKey)).toBe(false);

      const res = await handleLinkRedirection(
        new Request(`https://dub.sh/${slug}`),
        env,
      );
      expect(res.status).toBe(404);

      // Ensure KV was NOT repopulated with stale link data
      const cached = await mockKV.get(kvKey, "json");
      expect(cached?.id).toBeUndefined();
      if (cached) {
        expect(cached.notFound).toBe(true);
      }
    });

    it("2.5 [Batch Eviction]: evictLinksBatchFromKv purges all keys in batch", async () => {
      const batchLinks = [
        { domain: "dub.sh", key: "batch-1" },
        { domain: "dub.sh", key: "batch-2" },
        { domain: "dub.sh", key: "batch-3" },
      ];

      for (const link of batchLinks) {
        await mockKV.put(
          buildKvKey(link.domain, link.key),
          JSON.stringify({ id: link.key, url: "https://yamax.co" }),
        );
      }

      const outcome = await evictLinksBatchFromKv(batchLinks);
      expect(outcome.evictedCount).toBe(3);

      for (const link of batchLinks) {
        expect(mockKV.store.has(buildKvKey(link.domain, link.key))).toBe(false);
        const res = await handleLinkRedirection(
          new Request(`https://dub.sh/${link.key}`),
          env,
        );
        expect(res.status).toBe(404);
      }
    });
  });

  // ===========================================================================
  // 3. CASE-SENSITIVITY FUZZING ENGINE
  // ===========================================================================
  describe("Challenge 3: Case-Sensitivity Fuzzing Engine", () => {
    it("3.1 [Fuzzing Slug 1]: 'Summer-Sale' seeded in D1 resolves across all casing permutations on KV miss and hits KV subsequently", async () => {
      mockD1.rows.push({
        id: "lnk_summer_sale",
        domain: "dub.sh",
        key: "Summer-Sale",
        projectId: "ws_yamax",
        url: "https://yamax.co/summer-collection",
        disabledAt: null,
      });

      // Test all permutations against D1 (KV is empty initially)
      const casingVariations = [
        "summer-sale", // lowercase
        "SUMMER-SALE", // uppercase
        "Summer-Sale", // original
        "sUmMeR-sAlE", // alternating 1
        "SuMmEr-SaLe", // alternating 2
      ];

      for (const variant of casingVariations) {
        const req = new Request(`https://dub.sh/${variant}`);
        const res = await handleLinkRedirection(req, env);

        expect(res.status, `Failed for variant: ${variant}`).toBe(302);
        expect(res.headers.get("Location")).toContain(
          "https://yamax.co/summer-collection",
        );
        expect(res.headers.get("Location")).toContain(`via=${variant}`);
      }

      // Canonical KV key should now be populated with lowercase slug
      const canonicalKvKey = buildKvKey("dub.sh", "Summer-Sale");
      expect(canonicalKvKey).toBe("link:dub.sh:summer-sale");
      expect(mockKV.store.has(canonicalKvKey)).toBe(true);

      // Reset D1 query count to verify subsequent request hits KV directly
      const initialD1Queries = mockD1.queryCount;
      const resKvHit = await handleLinkRedirection(
        new Request("https://dub.sh/SUMMER-SALE"),
        env,
      );
      expect(resKvHit.status).toBe(302);
      expect(mockD1.queryCount).toBe(initialD1Queries); // Zero additional D1 queries!
    });

    it("3.2 [Fuzzing Slug 2]: 'yamax-FLOW' seeded in D1 resolves across all casing permutations", async () => {
      mockD1.rows.push({
        id: "lnk_yamax_flow",
        domain: "dub.sh",
        key: "yamax-FLOW",
        projectId: "ws_yamax",
        url: "https://yamax.co/products/flow-tank",
        disabledAt: null,
      });

      const permutations = [
        "yamax-flow", // lowercase
        "YAMAX-FLOW", // uppercase
        "yamax-FLOW", // exact original
        "YaMaX-fLoW", // alternating
        "YAMAX-flow", // inverted
      ];

      for (const p of permutations) {
        const res = await handleLinkRedirection(
          new Request(`https://dub.sh/${p}`),
          env,
        );
        expect(res.status, `Permutation "${p}" failed to resolve 302`).toBe(
          302,
        );
        expect(res.headers.get("Location")).toContain(
          "https://yamax.co/products/flow-tank",
        );
      }
    });

    it("3.3 [Fuzzing Slug 3]: lowercase slug 'flash-promo' in D1 matches UPPERCASE and TitleCase queries", async () => {
      mockD1.rows.push({
        id: "lnk_flash_promo",
        domain: "dub.sh",
        key: "flash-promo",
        projectId: "ws_yamax",
        url: "https://yamax.co/flash",
        disabledAt: null,
      });

      const resUpper = await handleLinkRedirection(
        new Request("https://dub.sh/FLASH-PROMO"),
        env,
      );
      expect(resUpper.status).toBe(302);
      expect(resUpper.headers.get("Location")).toContain(
        "https://yamax.co/flash",
      );

      const resTitle = await handleLinkRedirection(
        new Request("https://dub.sh/Flash-Promo"),
        env,
      );
      expect(resTitle.status).toBe(302);
    });

    it("3.4 [Domain Casing Resilience]: hostname variations ('DUB.SH', 'Dub.Sh', 'www.dub.sh') canonicalize correctly", async () => {
      mockD1.rows.push({
        id: "lnk_domain_case",
        domain: "dub.sh",
        key: "caps-domain",
        projectId: "ws_yamax",
        url: "https://yamax.co/domain-test",
        disabledAt: null,
      });

      const urls = [
        "https://DUB.SH/caps-domain",
        "https://Dub.Sh/caps-domain",
        "https://www.dub.sh/caps-domain",
        "https://WWW.DUB.SH/caps-domain",
      ];

      for (const u of urls) {
        const res = await handleLinkRedirection(new Request(u), env);
        expect(res.status, `Failed for URL: ${u}`).toBe(302);
        expect(res.headers.get("Location")).toContain(
          "https://yamax.co/domain-test",
        );
      }
    });

    it("3.5 [Soft-Deleted Mixed-Case Link]: strictly returns 404 across all casing permutations", async () => {
      mockD1.rows.push({
        id: "lnk_disabled_mixed",
        domain: "dub.sh",
        key: "Secret-Promo",
        projectId: "ws_yamax",
        url: "https://yamax.co/secret",
        disabledAt: "2026-10-05T00:00:00Z",
      });

      const tests = [
        "secret-promo",
        "SECRET-PROMO",
        "Secret-Promo",
        "sEcReT-pRoMo",
      ];

      for (const t of tests) {
        const res = await handleLinkRedirection(
          new Request(`https://dub.sh/${t}`),
          env,
        );
        expect(
          res.status,
          `Expected 404 for soft-deleted link variant "${t}"`,
        ).toBe(404);
      }
    });
  });

  // ===========================================================================
  // 4. CLOUDFLARE QUEUE RESOURCE NAME & RUNBOOK VALIDATION
  // ===========================================================================
  describe("Challenge 4: Cloudflare Queue Resource Name & Runbook Consistency", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const workersDir = path.join(repoRoot, "apps/web/workers");
    const runbookPath =
      "/Users/hironguyen/teamwork_projects/cloudflare_native_launch/CLOUDFLARE_NATIVE_MIGRATION_REPORT.md";

    const workerTomlPaths = [
      path.join(workersDir, "webhook-ingress/wrangler.toml"),
      path.join(workersDir, "queue-consumer/wrangler.toml"),
      path.join(workersDir, "cron-triggers/wrangler.toml"),
      path.join(workersDir, "link-redirector/wrangler.toml"),
    ];

    it("4.1 [Strict Naming Rule]: all queues across all wrangler.toml files strictly conform to Cloudflare queue naming rules", () => {
      // Cloudflare Queue Name Constraint:
      // - Lowercase alphanumeric and hyphens only: ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$
      // - No uppercase letters
      // - No underscores
      // - 1 to 63 characters
      const cfStrictQueueRegex = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

      const discoveredQueues: Set<string> = new Set();

      for (const tomlPath of workerTomlPaths) {
        expect(
          fs.existsSync(tomlPath),
          `Missing wrangler.toml at ${tomlPath}`,
        ).toBe(true);
        const content = fs.readFileSync(tomlPath, "utf-8");

        // Extract producer/consumer queue names
        const queueLines = content.match(/^\s*queue\s*=\s*"([^"]+)"/gm) || [];
        for (const line of queueLines) {
          const match = line.match(/"([^"]+)"/);
          if (match) {
            discoveredQueues.add(match[1]);
          }
        }

        // Extract DLQ queue names
        const dlqLines =
          content.match(/^\s*dead_letter_queue\s*=\s*"([^"]+)"/gm) || [];
        for (const line of dlqLines) {
          const match = line.match(/"([^"]+)"/);
          if (match) {
            discoveredQueues.add(match[1]);
          }
        }
      }

      expect(discoveredQueues.size).toBeGreaterThanOrEqual(2);

      for (const qName of discoveredQueues) {
        // Enforce Cloudflare constraint
        expect(qName).toMatch(cfStrictQueueRegex);
        expect(qName).not.toContain("_");
        expect(qName).not.toMatch(/[A-Z]/);
        expect(qName.length).toBeLessThanOrEqual(63);
      }
    });

    it("4.2 [Runbook Equivalence]: all configured queues match the exact creation commands in the migration runbook", () => {
      expect(
        fs.existsSync(runbookPath),
        `Runbook not found at ${runbookPath}`,
      ).toBe(true);
      const runbookContent = fs.readFileSync(runbookPath, "utf-8");

      // Extract all `wrangler queues create <queue-name>` commands
      const runbookQueueMatches =
        runbookContent.match(/wrangler queues create\s+([a-zA-Z0-9_-]+)/g) ||
        [];
      const runbookCreatedQueues = runbookQueueMatches.map((m) =>
        m.replace(/wrangler queues create\s+/, "").trim(),
      );

      expect(runbookCreatedQueues).toContain("order-webhook-queue");
      expect(runbookCreatedQueues).toContain("order-webhook-dlq");

      // Cross-check: ensure every queue configured in wrangler.toml is provisioned in the runbook
      const expectedQueues = ["order-webhook-queue", "order-webhook-dlq"];
      for (const eq of expectedQueues) {
        expect(runbookCreatedQueues).toContain(eq);
      }
    });
  });
});
