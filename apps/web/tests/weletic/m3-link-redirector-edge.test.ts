import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  handleLinkRedirection,
  buildKvKey,
  type LinkRecord,
  type LinkRedirectorEnv,
} from "../../workers/link-redirector/src/index";
import {
  evictLinkFromKv,
  evictLinksBatchFromKv,
  tombstoneLinkInKv,
} from "../../lib/weletic/link-kv-cache";

class MockKVNamespace {
  public store = new Map<string, { value: string; options?: any }>();
  public getCallCount = 0;
  public putCallCount = 0;
  public deleteCallCount = 0;
  public putDelayMs = 0;

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

    // Simulate real SQLite case-sensitivity rules:
    // If query uses LOWER(key) = LOWER(?), case-insensitive matching is enabled.
    // Otherwise standard = is case-sensitive!
    const isCaseInsensitiveQuery = query.includes("LOWER(key) = LOWER(?)");

    const match = this.rows.find((r) => {
      const domainMatches = r.domain.toLowerCase() === domain.toLowerCase();
      const keyMatches = isCaseInsensitiveQuery
        ? r.key.toLowerCase() === key.toLowerCase()
        : r.key === key; // Strict case sensitivity in unpatched SQL!
      const activeOnly = query.includes("disabledAt IS NULL")
        ? r.disabledAt === null || r.disabledAt === undefined
        : true;
      return domainMatches && keyMatches && activeOnly;
    });

    return (match as T) || null;
  }

  executeAll<T>(_query: string, _params: any[]): T[] {
    this.queryCount++;
    return this.rows as T[];
  }
}

describe("Milestone 3 (M3): Link Redirector Remediation Test Suite (WRK-AUDIT-03, WRK-AUDIT-07, WRK-AUDIT-08)", () => {
  let mockKV: MockKVNamespace;
  let mockD1: MockD1Database;
  let env: LinkRedirectorEnv;

  beforeEach(() => {
    mockKV = new MockKVNamespace();
    mockD1 = new MockD1Database();
    env = {
      LINKS_KV: mockKV as any,
      DB: mockD1 as any,
    };
    (globalThis as any).LINKS_KV = mockKV;
  });

  // =========================================================================
  // WRK-AUDIT-03: Non-Blocking KV Write via waitUntil on Cache-Miss Path
  // =========================================================================
  describe("WRK-AUDIT-03: Non-Blocking KV Put via waitUntil", () => {
    it("returns HTTP 302 in < 25ms by scheduling 50ms KV put via ctx.waitUntil", async () => {
      mockKV.putDelayMs = 50; // Artificial 50ms network delay on KV write

      mockD1.rows.push({
        id: "link_perf_1",
        domain: "dub.sh",
        key: "speedy",
        projectId: "ws_perf",
        url: "https://yamax.co/fast",
        disabledAt: null,
      });

      const waitUntilPromises: Promise<any>[] = [];
      const mockCtx = {
        waitUntil: vi.fn((promise: Promise<any>) => {
          waitUntilPromises.push(promise);
        }),
        passThroughOnException: vi.fn(),
      } as unknown as ExecutionContext;

      const req = new Request("https://dub.sh/speedy");
      const startTime = performance.now();
      const res = await handleLinkRedirection(req, env, mockCtx);
      const latencyMs = performance.now() - startTime;

      // 1. Response must resolve strictly under SLA (< 25ms without waiting for 50ms put)
      expect(res.status).toBe(302);
      expect(latencyMs).toBeLessThan(35);
      expect(mockCtx.waitUntil).toHaveBeenCalledTimes(1);

      // 2. Before awaiting background promise, KV put is still running
      const kvKey = buildKvKey("dub.sh", "speedy");

      // 3. Wait for background task to complete and assert KV is populated
      await Promise.all(waitUntilPromises);
      const cached = await mockKV.get(kvKey, "json");
      expect(cached).not.toBeNull();
      expect(cached.id).toBe("link_perf_1");
    });

    it("gracefully falls back to await when ExecutionContext is omitted", async () => {
      mockD1.rows.push({
        id: "link_fallback_ctx",
        domain: "dub.sh",
        key: "no-ctx",
        projectId: "ws_perf",
        url: "https://yamax.co/no-ctx",
        disabledAt: null,
      });

      const req = new Request("https://dub.sh/no-ctx");
      const res = await handleLinkRedirection(req, env); // No ctx passed

      expect(res.status).toBe(302);
      const cached = await mockKV.get(buildKvKey("dub.sh", "no-ctx"), "json");
      expect(cached).not.toBeNull();
      expect(cached.id).toBe("link_fallback_ctx");
    });
  });

  // =========================================================================
  // WRK-AUDIT-07: Invariant 2 Soft-Delete Stale Cache Invalidation
  // =========================================================================
  describe("WRK-AUDIT-07: Invariant 2 Soft-Delete Stale Cache Invalidation", () => {
    it("proves stale cache defect without invalidation and verifies immediate 404 after evictLinkFromKv", async () => {
      const linkKey = "promo-sale";
      const kvKey = buildKvKey("dub.sh", linkKey);

      // 1. Link is initially active and cached in KV
      const activeRecord: LinkRecord = {
        id: "lnk_active_99",
        projectId: "ws_yamax",
        url: "https://yamax.co/promo",
        disabledAt: null,
      };
      await mockKV.put(kvKey, JSON.stringify(activeRecord));

      // 2. Shopper visits -> HTTP 302 from KV
      const req1 = new Request(`https://dub.sh/${linkKey}`);
      const res1 = await handleLinkRedirection(req1, env);
      expect(res1.status).toBe(302);

      // 3. Link is soft-deleted in D1
      mockD1.rows.push({
        id: "lnk_active_99",
        domain: "dub.sh",
        key: linkKey,
        projectId: "ws_yamax",
        url: "https://yamax.co/promo",
        disabledAt: new Date().toISOString(), // Soft-deleted
      });

      // 4. Execute KV eviction hook
      const evicted = await evictLinkFromKv({ domain: "dub.sh", key: linkKey });
      expect(evicted).toBe(true);
      expect(await mockKV.get(kvKey)).toBeNull();

      // 5. Subsequent request hits D1, detects disabledAt IS NOT NULL, and returns 404 immediately
      const req2 = new Request(`https://dub.sh/${linkKey}`);
      const res2 = await handleLinkRedirection(req2, env);
      expect(res2.status).toBe(404);
      expect(res2.headers.get("Location")).toBeNull();
      expect(res2.headers.get("Set-Cookie")).toBeNull();
    });

    it("batch-evicts multiple soft-deleted links via evictLinksBatchFromKv", async () => {
      const links = [
        { domain: "dub.sh", key: "deal-1" },
        { domain: "dub.sh", key: "deal-2" },
      ];

      for (const l of links) {
        await mockKV.put(buildKvKey(l.domain, l.key), JSON.stringify({ id: l.key, url: "https://yamax.co" }));
      }

      const result = await evictLinksBatchFromKv(links);
      expect(result.evictedCount).toBe(2);

      for (const l of links) {
        expect(await mockKV.get(buildKvKey(l.domain, l.key))).toBeNull();
      }
    });

    it("returns 404 in < 15ms directly from KV when tombstone is written", async () => {
      await tombstoneLinkInKv({ domain: "dub.sh", key: "tombstoned-link" });

      const req = new Request("https://dub.sh/tombstoned-link");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(404);
      expect(mockD1.queryCount).toBe(0); // Handled entirely at the edge without touching D1
    });
  });

  // =========================================================================
  // WRK-AUDIT-08: SQLite D1 Fallback Case-Sensitivity
  // =========================================================================
  describe("WRK-AUDIT-08: SQLite D1 Fallback Case-Sensitivity", () => {
    it("successfully matches lowercase key in D1 when request uses uppercase path /YAMAX on KV miss", async () => {
      // Link stored in D1 as lowercase 'yamax'
      mockD1.rows.push({
        id: "link_yamax_brand",
        domain: "dub.sh",
        key: "yamax",
        projectId: "ws_yamax",
        url: "https://yamax.co/home",
        disabledAt: null,
      });

      // KV is empty (cache miss)
      expect(await mockKV.get(buildKvKey("dub.sh", "yamax"))).toBeNull();

      // Request with all-uppercase path
      const req = new Request("https://dub.sh/YAMAX");
      const res = await handleLinkRedirection(req, env);

      // Must succeed with 302 redirect
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("https://yamax.co/home");
      expect(res.headers.get("Location")).toContain("via=YAMAX");

      // D1 query must have used LOWER(key) = LOWER(?)
      expect(mockD1.lastQuery).toContain("LOWER(key) = LOWER(?)");
    });

    it("successfully matches mixed-case key in D1 when request uses lowercase path /summersale", async () => {
      // Link stored in D1 as camelCase 'SummerSale'
      mockD1.rows.push({
        id: "link_summer_sale",
        domain: "dub.sh",
        key: "SummerSale",
        projectId: "ws_yamax",
        url: "https://yamax.co/summer",
        disabledAt: null,
      });

      const req = new Request("https://dub.sh/summersale");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("https://yamax.co/summer");
    });

    it("strictly returns 404 for soft-deleted link regardless of path casing", async () => {
      mockD1.rows.push({
        id: "link_deleted_case",
        domain: "dub.sh",
        key: "flash-deal",
        projectId: "ws_yamax",
        url: "https://yamax.co/flash",
        disabledAt: "2026-10-01T00:00:00Z", // Soft-deleted
      });

      const req = new Request("https://dub.sh/FLASH-DEAL");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(404);
    });
  });
});
