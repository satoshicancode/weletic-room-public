import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  handleLinkRedirection,
  resolveTargetUrl,
  buildKvKey,
  type LinkRecord,
  type LinkRedirectorEnv,
  type AnalyticsEngineDataPointInput,
} from "../../../workers/link-redirector/src/index";
import {
  evictLinkFromKv,
  evictLinksBatchFromKv,
  tombstoneLinkInKv,
} from "../../../lib/weletic/link-kv-cache";
import { linkCache } from "../../../lib/api/links/cache";
import { propagateBulkLinkChanges } from "../../../lib/api/links/propagate-bulk-link-changes";
import { archiveLink } from "../../../lib/api/links/archive-link";
import { prisma } from "../../../lib/prisma";
import { redisGlobal } from "../../../lib/upstash";

// Mock Upstash Redis
vi.mock("../../../lib/upstash", () => {
  const store = new Map<string, string>();
  return {
    redisGlobal: {
      get: vi.fn(async (key: string) => store.get(key) || null),
      set: vi.fn(async (key: string, val: any) => {
        store.set(key, typeof val === "string" ? val : JSON.stringify(val));
        return "OK";
      }),
      del: vi.fn(async (key: string) => {
        store.delete(key);
        return 1;
      }),
      pipeline: vi.fn(() => ({
        set: vi.fn(),
        del: vi.fn(),
        expire: vi.fn(),
        exec: vi.fn(async () => []),
      })),
    },
    redisGlobalWithTimeout: {
      get: vi.fn(async () => null),
    },
    formatRedisLink: vi.fn((link: any) => link),
  };
});

// Mock Vercel functions
vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((promise: Promise<any>) => promise),
  getCache: vi.fn(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  })),
}));

// Mock Next.js cache
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
}));

// Mock Prisma
vi.mock("../../../lib/prisma", () => ({
  prisma: {
    link: {
      update: vi.fn(async ({ where, data }) => ({
        id: where.id,
        domain: "dub.sh",
        key: "test-link",
        url: "https://yamax.co",
        archived: data.archived ?? false,
        disabledAt: data.disabledAt ?? null,
        projectId: "ws_test",
      })),
    },
  },
}));

// Mock Tinybird
vi.mock("../../../lib/tinybird/record-link", () => ({
  recordLink: vi.fn(async () => {}),
}));

class MockKVNamespace {
  public store = new Map<string, { value: string; options?: any }>();
  public getCallCount = 0;
  public putCallCount = 0;
  public deleteCallCount = 0;

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
    this.store.set(key, { value, options });
  }

  async delete(key: string) {
    this.deleteCallCount++;
    this.store.delete(key);
  }
}

class MockD1PreparedStatement {
  constructor(
    private query: string,
    private db: MockD1Database,
    private params: any[] = [],
  ) {}

  bind(...params: any[]) {
    return new MockD1PreparedStatement(this.query, this.db, params);
  }

  async first<T = any>(): Promise<T | null> {
    return this.db.executeFirst<T>(this.query, this.params);
  }

  async all<T = any>(): Promise<{ results: T[] }> {
    return { results: this.db.executeAll<T>(this.query, this.params) };
  }
}

class MockD1Database {
  public rows: any[] = [];
  public queryCount = 0;
  public lastQuery = "";

  prepare(query: string) {
    this.lastQuery = query;
    return new MockD1PreparedStatement(query, this);
  }

  executeFirst<T>(query: string, params: any[]): T | null {
    this.queryCount++;
    const [domain, key] = params;
    const isCaseInsensitiveQuery = query.includes("LOWER(key) = LOWER(?)");

    const match = this.rows.find((r) => {
      const domainMatches = r.domain.toLowerCase() === domain.toLowerCase();
      const keyMatches = isCaseInsensitiveQuery
        ? r.key.toLowerCase() === key.toLowerCase()
        : r.key === key;
      const activeOnly = query.includes("disabledAt IS NULL")
        ? r.disabledAt === null || r.disabledAt === undefined
        : true;
      const unarchivedOnly =
        query.includes("archived = 0") || query.includes("archived IS FALSE")
          ? !r.archived || r.archived === 0 || r.archived === false
          : true;

      return domainMatches && keyMatches && activeOnly && unarchivedOnly;
    });

    return (match as T) || null;
  }

  executeAll<T>(_query: string, _params: any[]): T[] {
    this.queryCount++;
    return this.rows as T[];
  }
}

describe("Milestone 4 (M4) Comprehensive Audit Fixes Test Suite", () => {
  let mockKV: MockKVNamespace;
  let mockD1: MockD1Database;
  let env: LinkRedirectorEnv;
  let writtenDataPoints: AnalyticsEngineDataPointInput[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockKV = new MockKVNamespace();
    mockD1 = new MockD1Database();
    writtenDataPoints = [];
    env = {
      LINKS_KV: mockKV as any,
      DB: mockD1 as any,
      CLICKS_ANALYTICS: {
        writeDataPoint: vi.fn((dp) => {
          writtenDataPoints.push(dp);
        }),
      },
    };
    (globalThis as any).LINKS_KV = mockKV;
  });

  // =========================================================================
  // LNK-01: KV Cache Sync on Active Link Mutations & Bulk Updates
  // =========================================================================
  describe("LNK-01: KV Cache Sync on Active Link Mutations & Bulk Updates", () => {
    it("evicts KV cache on ANY active link modification in linkCache.set", async () => {
      const kvKey = buildKvKey("dub.sh", "active-link");
      await mockKV.put(kvKey, JSON.stringify({ id: "1", url: "https://yamax.co/old" }));
      expect(await mockKV.get(kvKey)).not.toBeNull();

      // Active link modification (disabledAt is null)
      await linkCache.set({
        id: "1",
        domain: "dub.sh",
        key: "active-link",
        url: "https://yamax.co/new",
        projectId: "ws_1",
        disabledAt: null,
      } as any);

      // KV key must be evicted immediately
      expect(await mockKV.get(kvKey)).toBeNull();
    });

    it("writes tombstone to KV when link is disabled (soft-deleted) in linkCache.set", async () => {
      const kvKey = buildKvKey("dub.sh", "disabled-link");
      const disabledAt = new Date().toISOString();

      await linkCache.set({
        id: "2",
        domain: "dub.sh",
        key: "disabled-link",
        url: "https://yamax.co/disabled",
        projectId: "ws_1",
        disabledAt,
      } as any);

      // KV should contain tombstone payload
      const cached = await mockKV.get(kvKey, "json");
      expect(cached).not.toBeNull();
      expect(cached.disabledAt).toBe(disabledAt);
    });

    it("batch-evicts KV cache in propagateBulkLinkChanges for all updated links", async () => {
      const links = [
        { id: "b1", domain: "dub.sh", key: "deal-1", url: "https://yamax.co/1" },
        { id: "b2", domain: "dub.sh", key: "deal-2", url: "https://yamax.co/2" },
      ];

      for (const l of links) {
        await mockKV.put(buildKvKey(l.domain, l.key), JSON.stringify(l));
      }

      await propagateBulkLinkChanges({
        links: links as any,
        skipRedisCache: false,
      });

      for (const l of links) {
        expect(await mockKV.get(buildKvKey(l.domain, l.key))).toBeNull();
      }
    });

    it("batch-evicts KV cache in linkCache.mset", async () => {
      const links = [
        { id: "m1", domain: "dub.sh", key: "mset-1", url: "https://yamax.co/m1" },
        { id: "m2", domain: "dub.sh", key: "mset-2", url: "https://yamax.co/m2" },
      ];

      for (const l of links) {
        await mockKV.put(buildKvKey(l.domain, l.key), JSON.stringify(l));
      }

      await linkCache.mset(links as any);

      for (const l of links) {
        expect(await mockKV.get(buildKvKey(l.domain, l.key))).toBeNull();
      }
    });
  });

  // =========================================================================
  // LNK-02: Archived Link Invalidation & D1 Filtering
  // =========================================================================
  describe("LNK-02: Archived Link Invalidation & D1 Filtering", () => {
    it("invalidates Redis and evicts KV cache when link is archived via archiveLink", async () => {
      const kvKey = buildKvKey("dub.sh", "test-link");
      await mockKV.put(kvKey, JSON.stringify({ id: "lnk_arch", url: "https://yamax.co" }));

      const result = await archiveLink({
        linkId: "lnk_arch",
        archived: true,
      });

      expect(result.archived).toBe(true);
      // KV cache must be evicted
      expect(await mockKV.get(kvKey)).toBeNull();
    });

    it("filters out archived links in D1 fallback SQL query and returns 404", async () => {
      mockD1.rows.push({
        id: "lnk_archived_d1",
        domain: "dub.sh",
        key: "archived-promo",
        url: "https://yamax.co/archived",
        disabledAt: null,
        archived: 1, // Archived link in D1
      });

      const req = new Request("https://dub.sh/archived-promo");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(404);
      expect(mockD1.lastQuery).toContain("AND (archived = 0 OR archived IS FALSE)");
    });

    it("returns 404 immediately if cached KV record has archived set to true", async () => {
      const kvKey = buildKvKey("dub.sh", "stale-archived-kv");
      await mockKV.put(
        kvKey,
        JSON.stringify({
          id: "lnk_stale_kv",
          url: "https://yamax.co/stale",
          archived: true,
        }),
      );

      const req = new Request("https://dub.sh/stale-archived-kv");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(404);
      expect(mockD1.queryCount).toBe(0); // Handled at edge
    });

    it("allows redirection for active unarchived links in D1", async () => {
      mockD1.rows.push({
        id: "lnk_unarchived_ok",
        domain: "dub.sh",
        key: "live-promo",
        url: "https://yamax.co/live",
        disabledAt: null,
        archived: 0,
      });

      const req = new Request("https://dub.sh/live-promo");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("https://yamax.co/live");
    });
  });

  // =========================================================================
  // LNK-03: Geo-Routing Path Prefix Deduplication
  // =========================================================================
  describe("LNK-03: Geo-Routing Path Prefix Deduplication", () => {
    it("strips /ja before prepending /vi when destination is /ja/products/leggings and country is VN", () => {
      const target = resolveTargetUrl({
        baseTargetUrl: "https://yamax.co/ja/products/leggings",
        country: "VN",
      });

      const url = new URL(target);
      expect(url.pathname).toBe("/vi/products/leggings");
      expect(url.pathname).not.toContain("/vi/ja");
      expect(url.searchParams.get("currency")).toBe("VND");
    });

    it("strips /vi before prepending /ja when destination is /vi/products/leggings and country is JP", () => {
      const target = resolveTargetUrl({
        baseTargetUrl: "https://yamax.co/vi/products/leggings",
        country: "JP",
      });

      const url = new URL(target);
      expect(url.pathname).toBe("/ja/products/leggings");
      expect(url.pathname).not.toContain("/ja/vi");
      expect(url.searchParams.get("currency")).toBe("JPY");
    });

    it("strips /en before prepending /ja when country is JP", () => {
      const target = resolveTargetUrl({
        baseTargetUrl: "https://yamax.co/en/products/leggings",
        country: "JP",
      });

      const url = new URL(target);
      expect(url.pathname).toBe("/ja/products/leggings");
      expect(url.searchParams.get("currency")).toBe("JPY");
    });

    it("deduplicates multi-nested prefixes like /vi/ja/products/leggings", () => {
      const target = resolveTargetUrl({
        baseTargetUrl: "https://yamax.co/vi/ja/products/leggings",
        country: "VN",
      });

      const url = new URL(target);
      expect(url.pathname).toBe("/vi/products/leggings");
    });

    it("handles root locale correctly (/ja -> /vi)", () => {
      const target = resolveTargetUrl({
        baseTargetUrl: "https://yamax.co/ja",
        country: "VN",
      });

      const url = new URL(target);
      expect(url.pathname).toBe("/vi");
      expect(url.searchParams.get("currency")).toBe("VND");
    });

    it("does NOT strip words that start with ja or vi (e.g., /jacket)", () => {
      const target = resolveTargetUrl({
        baseTargetUrl: "https://yamax.co/jacket/winter-coat",
        country: "JP",
      });

      const url = new URL(target);
      expect(url.pathname).toBe("/ja/jacket/winter-coat");
    });

    it("handles regional subtag locales like /en-US/products", () => {
      const target = resolveTargetUrl({
        baseTargetUrl: "https://yamax.co/en-US/products",
        country: "JP",
      });

      const url = new URL(target);
      expect(url.pathname).toBe("/ja/products");
    });

    it("preserves customGeoMapping override regardless of default regional routing", () => {
      const target = resolveTargetUrl({
        baseTargetUrl: "https://yamax.co/global",
        country: "VN",
        customGeoMapping: {
          VN: "https://yamax.vn/custom-vietnam",
        },
      });

      expect(target).toBe("https://yamax.vn/custom-vietnam");
    });
  });

  // =========================================================================
  // LNK-04: Non-blocking Analytics Engine Telemetry
  // =========================================================================
  describe("LNK-04: Non-blocking Analytics Engine Telemetry", () => {
    it("schedules telemetry writing via ctx.waitUntil without delaying HTTP 302 response", async () => {
      mockKV.store.set(
        buildKvKey("dub.sh", "fast-redirect"),
        {
          value: JSON.stringify({
            id: "lnk_telemetry_1",
            projectId: "ws_telemetry",
            url: "https://yamax.co/fast",
          }),
        },
      );

      const waitUntilTasks: Promise<any>[] = [];
      const mockCtx = {
        waitUntil: vi.fn((promise: Promise<any>) => {
          waitUntilTasks.push(promise);
        }),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const req = new Request("https://dub.sh/fast-redirect");
      const res = await handleLinkRedirection(req, env, mockCtx);

      // 302 must resolve immediately
      expect(res.status).toBe(302);
      expect(mockCtx.waitUntil).toHaveBeenCalled();

      // Complete background task and assert telemetry write was called
      await Promise.all(waitUntilTasks);
      expect(env.CLICKS_ANALYTICS?.writeDataPoint).toHaveBeenCalledTimes(1);
    });

    it("telemetry exceptions inside background execution do not block 302 redirect", async () => {
      mockKV.store.set(
        buildKvKey("dub.sh", "error-telemetry"),
        {
          value: JSON.stringify({
            id: "lnk_err_1",
            url: "https://yamax.co/err",
          }),
        },
      );

      // Force writeDataPoint to throw
      (env.CLICKS_ANALYTICS!.writeDataPoint as any) = vi.fn(() => {
        throw new Error("Simulated Analytics Engine failure");
      });

      const waitUntilTasks: Promise<any>[] = [];
      const mockCtx = {
        waitUntil: vi.fn((promise: Promise<any>) => {
          waitUntilTasks.push(promise);
        }),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const req = new Request("https://dub.sh/error-telemetry");
      const res = await handleLinkRedirection(req, env, mockCtx);

      expect(res.status).toBe(302);
      // Wait for background tasks to ensure it handled error gracefully without rejection
      await expect(Promise.all(waitUntilTasks)).resolves.toBeDefined();
    });
  });

  // =========================================================================
  // LNK-05 & LNK-06: Telemetry Clamping & Tombstones
  // =========================================================================
  describe("LNK-05 & LNK-06: Telemetry Clamping & Tombstones", () => {
    it("clamps telemetry blobs and index partition to Cloudflare bounds (LNK-05)", async () => {
      const veryLongUA = "A".repeat(1000);
      const veryLongUrl = "https://yamax.co/" + "B".repeat(3000);
      const veryLongProjectId = "ws_" + "C".repeat(50);

      mockKV.store.set(
        buildKvKey("dub.sh", "long-payload"),
        {
          value: JSON.stringify({
            id: "lnk_clamp",
            projectId: veryLongProjectId,
            url: veryLongUrl,
          }),
        },
      );

      const req = new Request("https://dub.sh/long-payload", {
        headers: {
          "user-agent": veryLongUA,
        },
      });

      const res = await handleLinkRedirection(req, env);
      expect(res.status).toBe(302);

      expect(writtenDataPoints.length).toBe(1);
      const dp = writtenDataPoints[0];

      // Blobs: userAgent is blob8, clamped to <= 512
      const userAgentBlob = dp.blobs?.[7] as string;
      expect(userAgentBlob.length).toBeLessThanOrEqual(512);

      // Blobs: targetUrl is blob11, clamped to <= 2048
      const targetUrlBlob = dp.blobs?.[10] as string;
      expect(targetUrlBlob.length).toBeLessThanOrEqual(2048);

      // Indexes: workspace partition index is clamped to <= 32 bytes
      const workspaceIndex = dp.indexes?.[0] as string;
      expect(workspaceIndex.length).toBeLessThanOrEqual(32);
    });

    it("serves sub-15ms 404 fast-path directly from KV tombstone without querying D1 (LNK-06)", async () => {
      await tombstoneLinkInKv({
        domain: "dub.sh",
        key: "tombstoned-link-m4",
      });

      const req = new Request("https://dub.sh/tombstoned-link-m4");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(404);
      expect(mockD1.queryCount).toBe(0); // Never touches D1
    });
  });
});
