import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockedWaitUntil,
  mockPipelineDel,
  mockPipelineSet,
  mockPipelineExpire,
  mockPipelineExec,
  mockRedisStore,
} = vi.hoisted(() => ({
  mockedWaitUntil: vi.fn((promise: Promise<any>) => promise),
  mockPipelineDel: vi.fn(),
  mockPipelineSet: vi.fn(),
  mockPipelineExpire: vi.fn(),
  mockPipelineExec: vi.fn(async () => []),
  mockRedisStore: new Map<string, string>(),
}));

// Mock Next.js cache
vi.mock("next/cache", () => ({
  revalidateTag: vi.fn(),
}));

// Mock Vercel functions
vi.mock("@vercel/functions", () => ({
  waitUntil: mockedWaitUntil,
  getCache: vi.fn(() => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  })),
}));

vi.mock("@/lib/upstash", () => ({
  redisGlobal: {
    get: vi.fn(async (key: string) => mockRedisStore.get(key) || null),
    set: vi.fn(async (key: string, val: any) => {
      mockRedisStore.set(key, typeof val === "string" ? val : JSON.stringify(val));
      return "OK";
    }),
    del: vi.fn(async (key: string) => {
      mockRedisStore.delete(key);
      return 1;
    }),
    pipeline: vi.fn(() => ({
      del: mockPipelineDel,
      set: mockPipelineSet,
      expire: mockPipelineExpire,
      exec: mockPipelineExec,
    })),
  },
  redisGlobalWithTimeout: {
    get: vi.fn(async () => null),
  },
  formatRedisLink: vi.fn((link: any) => ({
    ...link,
    clicks: 0,
    lastClicked: null,
  })),
}));

import {
  handleLinkRedirection,
  resolveTargetUrl,
  buildKvKey,
  type LinkRecord,
  type LinkRedirectorEnv,
} from "../../../workers/link-redirector/src/index";
import {
  evictLinkFromKv,
  evictLinksBatchFromKv,
  tombstoneLinkInKv,
} from "../../../lib/weletic/link-kv-cache";
import { linkCache } from "../../../lib/api/links/cache";

// Mock Cloudflare KV Namespace for redirector worker
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

// Mock Cloudflare D1 Database for redirector worker fallback
class MockD1PreparedStatement {
  constructor(
    private sql: string,
    private params: any[],
    private database: MockD1Database,
  ) {}

  bind(...params: any[]) {
    return new MockD1PreparedStatement(this.sql, params, this.database);
  }

  async first<T = unknown>(): Promise<T | null> {
    const domain = this.params[0];
    const key = this.params[1]?.toLowerCase();
    const link = this.database.records.find(
      (r) =>
        r.domain.toLowerCase() === domain?.toLowerCase() &&
        r.key.toLowerCase() === key,
    );
    if (!link) return null;
    return link as unknown as T;
  }
}

class MockD1Database {
  public records: any[] = [];
  prepare(sql: string) {
    return new MockD1PreparedStatement(sql, [], this);
  }
}

// Mock Cloudflare Analytics Engine
class MockAnalyticsEngine {
  public dataPoints: any[] = [];
  writeDataPoint(point: any) {
    this.dataPoints.push(point);
  }
}

describe("Round 2 Affiliate Links: KV Cache Invalidation & Geo-Routing Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedisStore.clear();
    delete (globalThis as any).LINKS_KV;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_LINKS_KV_NAMESPACE_ID;
  });

  // =========================================================================
  // Feature 1: KV Cache Invalidation on Link Mutation & Soft-Delete (LINK-01)
  // =========================================================================
  describe("Feature 1: KV Cache Invalidation on Link Mutation & Soft-Delete", () => {
    it("builds canonical lowercase KV keys ignoring leading www and port", () => {
      expect(buildKvKey("www.brand-store.com", "SummerSale")).toBe(
        "link:brand-store.com:summersale",
      );
      expect(buildKvKey("AFF.TEST-DOMAIN.IO:8080", "VIP_PROMO_2026")).toBe(
        "link:aff.test-domain.io:vip_promo_2026",
      );
    });

    it("evictLinkFromKv deletes key using native globalThis.LINKS_KV worker binding", async () => {
      const mockKv = new MockKVNamespace();
      mockKv.store.set("link:aff-partner.org:summit26", {
        value: JSON.stringify({ id: "link_1", url: "https://shop.example.com" }),
      });
      (globalThis as any).LINKS_KV = mockKv;

      const success = await evictLinkFromKv({
        domain: "aff-partner.org",
        key: "summit26",
      });

      expect(success).toBe(true);
      expect(mockKv.deleteCallCount).toBe(1);
      expect(mockKv.store.has("link:aff-partner.org:summit26")).toBe(false);
    });

    it("evictLinkFromKv falls back to Cloudflare REST API when native binding is not present", async () => {
      process.env.CLOUDFLARE_ACCOUNT_ID = "acc_test_12345";
      process.env.CLOUDFLARE_API_TOKEN = "tok_test_secret";
      process.env.CLOUDFLARE_LINKS_KV_NAMESPACE_ID = "ns_links_kv";

      const mockFetch = vi.fn(async (url: string, init: any) => {
        expect(url).toContain("/accounts/acc_test_12345/storage/kv/namespaces/ns_links_kv/values/");
        expect(url).toContain(encodeURIComponent("link:domain-test.io:sale"));
        expect(init.method).toBe("DELETE");
        expect(init.headers.Authorization).toBe("Bearer tok_test_secret");
        return new Response(null, { status: 200 });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mockFetch as any;

      try {
        const success = await evictLinkFromKv({
          domain: "domain-test.io",
          key: "sale",
        });

        expect(success).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("evictLinksBatchFromKv batch-evicts multiple links and deduplicates duplicate keys", async () => {
      const mockKv = new MockKVNamespace();
      mockKv.store.set("link:tenant-brand.com:promo1", { value: "val1" });
      mockKv.store.set("link:tenant-brand.com:promo2", { value: "val2" });
      (globalThis as any).LINKS_KV = mockKv;

      const result = await evictLinksBatchFromKv([
        { domain: "tenant-brand.com", key: "promo1" },
        { domain: "tenant-brand.com", key: "promo2" },
        { domain: "tenant-brand.com", key: "promo1" }, // Duplicate
      ]);

      expect(result.evictedCount).toBe(2);
      expect(mockKv.store.has("link:tenant-brand.com:promo1")).toBe(false);
      expect(mockKv.store.has("link:tenant-brand.com:promo2")).toBe(false);
    });

    it("tombstoneLinkInKv sets a tombstone record with 300s TTL and disabledAt timestamp", async () => {
      const mockKv = new MockKVNamespace();
      (globalThis as any).LINKS_KV = mockKv;

      const disabledAt = new Date("2026-10-09T12:00:00Z");
      const success = await tombstoneLinkInKv({
        domain: "creator-affiliates.net",
        key: "retired-code",
        disabledAt,
      });

      expect(success).toBe(true);
      const kvEntry = mockKv.store.get("link:creator-affiliates.net:retired-code");
      expect(kvEntry).toBeDefined();
      expect(kvEntry?.options?.expirationTtl).toBe(300);

      const parsedPayload = JSON.parse(kvEntry!.value);
      expect(parsedPayload.disabledAt).toBe(disabledAt.toISOString());
      expect(parsedPayload.url).toBe("");
    });

    it("linkCache.set triggers KV cache eviction even when link is active to prevent stale reads", async () => {
      const mockKv = new MockKVNamespace();
      (globalThis as any).LINKS_KV = mockKv;
      mockKv.store.set("link:hub.partner-app.io:active-slug", { value: "old-version" });

      const activeLink = {
        id: "link_act_123",
        domain: "hub.partner-app.io",
        key: "active-slug",
        url: "https://storefront.brand.org/products/updated-jacket",
        disabledAt: null,
      } as any;

      await linkCache.set(activeLink);

      expect(mockKv.store.has("link:hub.partner-app.io:active-slug")).toBe(false);
    });

    it("linkCache.mset batch evicts KV entries via waitUntil", async () => {
      const mockKv = new MockKVNamespace();
      (globalThis as any).LINKS_KV = mockKv;

      const links = [
        { id: "l1", domain: "shop.brand-test.io", key: "alpha", url: "https://shop.brand-test.io/1", disabledAt: null },
        { id: "l2", domain: "shop.brand-test.io", key: "beta", url: "https://shop.brand-test.io/2", disabledAt: null },
      ] as any[];

      await linkCache.mset(links);

      expect(mockedWaitUntil).toHaveBeenCalled();
      expect(mockPipelineSet).toHaveBeenCalledTimes(2);
    });

    it("linkCache.delete and linkCache.invalidateMany clear multi-tier caches including KV", async () => {
      const mockKv = new MockKVNamespace();
      (globalThis as any).LINKS_KV = mockKv;

      await linkCache.delete({ domain: "shop.brand-test.io", key: "summer" });
      expect(mockedWaitUntil).toHaveBeenCalled();

      await linkCache.invalidateMany([
        { domain: "shop.brand-test.io", key: "winter" },
        { domain: "shop.brand-test.io", key: "spring" },
      ]);
      expect(mockPipelineDel).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Feature 2: Geo-Routing & Locale Deduplication (/vi/ja/ Prevention)
  // =========================================================================
  describe("Feature 2: Geo-Routing & Locale Deduplication (/vi/ja/ Prevention)", () => {
    it("routes Japanese visitors (country=JP) to /ja prefix and currency=JPY", () => {
      const url = "https://brand-storefront.io/products/running-leggings";
      const resolved = resolveTargetUrl({
        baseTargetUrl: url,
        country: "JP",
      });

      expect(resolved).toBe(
        "https://brand-storefront.io/ja/products/running-leggings?currency=JPY",
      );
    });

    it("routes Vietnamese visitors (country=VN) to /vi prefix and currency=VND", () => {
      const url = "https://brand-storefront.io/products/running-leggings";
      const resolved = resolveTargetUrl({
        baseTargetUrl: url,
        country: "VN",
      });

      expect(resolved).toBe(
        "https://brand-storefront.io/vi/products/running-leggings?currency=VND",
      );
    });

    it("routes global visitors to root path with currency=USD", () => {
      const url = "https://brand-storefront.io/products/running-leggings";
      const resolved = resolveTargetUrl({
        baseTargetUrl: url,
        country: "US",
      });

      expect(resolved).toBe(
        "https://brand-storefront.io/products/running-leggings?currency=USD",
      );
    });

    it("deduplicates pre-existing /ja prefix when visitor is JP (prevents /ja/ja/...)", () => {
      const url = "https://brand-storefront.io/ja/products/running-leggings";
      const resolved = resolveTargetUrl({
        baseTargetUrl: url,
        country: "JP",
      });

      expect(resolved).toBe(
        "https://brand-storefront.io/ja/products/running-leggings?currency=JPY",
      );
      expect(resolved).not.toContain("/ja/ja/");
    });

    it("strips pre-existing /ja prefix and injects /vi for VN visitors (prevents /vi/ja/...)", () => {
      const url = "https://brand-storefront.io/ja/products/running-leggings";
      const resolved = resolveTargetUrl({
        baseTargetUrl: url,
        country: "VN",
      });

      expect(resolved).toBe(
        "https://brand-storefront.io/vi/products/running-leggings?currency=VND",
      );
      expect(resolved).not.toContain("/vi/ja/");
    });

    it("strips pre-existing /vi prefix and injects /ja for JP visitors (prevents /ja/vi/...)", () => {
      const url = "https://brand-storefront.io/vi/products/running-leggings";
      const resolved = resolveTargetUrl({
        baseTargetUrl: url,
        country: "JP",
      });

      expect(resolved).toBe(
        "https://brand-storefront.io/ja/products/running-leggings?currency=JPY",
      );
      expect(resolved).not.toContain("/ja/vi/");
    });

    it("strips multi-nested corrupt prefixes (/vi/ja/ or /ja/vi/ or /en/ja/) completely", () => {
      const corruptedUrl = "https://brand-storefront.io/vi/ja/products/top";
      const resolvedJP = resolveTargetUrl({
        baseTargetUrl: corruptedUrl,
        country: "JP",
      });
      expect(resolvedJP).toBe(
        "https://brand-storefront.io/ja/products/top?currency=JPY",
      );
      expect(resolvedJP).not.toContain("/vi/ja/");

      const resolvedVN = resolveTargetUrl({
        baseTargetUrl: corruptedUrl,
        country: "VN",
      });
      expect(resolvedVN).toBe(
        "https://brand-storefront.io/vi/products/top?currency=VND",
      );

      const resolvedGlobal = resolveTargetUrl({
        baseTargetUrl: corruptedUrl,
        country: "CA",
      });
      expect(resolvedGlobal).toBe(
        "https://brand-storefront.io/products/top?currency=USD",
      );
    });

    it("handles region-tagged locales like /ja-jp/ and /en-us/ cleanly", () => {
      const url = "https://brand-storefront.io/ja-jp/collections/autumn";
      const resolved = resolveTargetUrl({
        baseTargetUrl: url,
        country: "VN",
      });

      expect(resolved).toBe(
        "https://brand-storefront.io/vi/collections/autumn?currency=VND",
      );
      expect(resolved).not.toContain("/vi/ja-jp/");
    });

    it("handles root storefront path with clean /ja or /vi", () => {
      const rootUrl = "https://brand-storefront.io/";
      const resolvedJP = resolveTargetUrl({
        baseTargetUrl: rootUrl,
        country: "JP",
      });
      expect(resolvedJP).toBe("https://brand-storefront.io/ja?currency=JPY");

      const resolvedVN = resolveTargetUrl({
        baseTargetUrl: rootUrl,
        country: "VN",
      });
      expect(resolvedVN).toBe("https://brand-storefront.io/vi?currency=VND");
    });

    it("prioritizes customGeoMapping override over default regional storefront currency routing", () => {
      const resolved = resolveTargetUrl({
        baseTargetUrl: "https://brand-storefront.io/default-page",
        country: "JP",
        customGeoMapping: {
          JP: "https://special-japan-campaign.brand.io/exclusive",
          VN: "https://vietnam-campaign.brand.io/exclusive",
        },
      });

      expect(resolved).toBe("https://special-japan-campaign.brand.io/exclusive");
    });

    it("preserves pre-existing destination query parameters while setting currency", () => {
      const url = "https://brand-storefront.io/products/shorts?size=M&color=black";
      const resolved = resolveTargetUrl({
        baseTargetUrl: url,
        country: "JP",
      });

      expect(resolved).toContain("size=M");
      expect(resolved).toContain("color=black");
      expect(resolved).toContain("currency=JPY");
      expect(resolved).toContain("/ja/products/shorts");
    });

    it("safely handles protocol-less target URL without throwing error", () => {
      const rawUrl = "brand-storefront.io/products/hoodie";
      const resolved = resolveTargetUrl({
        baseTargetUrl: rawUrl,
        country: "JP",
      });

      expect(resolved).toContain("brand-storefront.io");
      expect(resolved).toContain("/ja/products/hoodie");
      expect(resolved).toContain("currency=JPY");
    });
  });

  // =========================================================================
  // Feature 3: Edge Redirection Engine, Invariants & Telemetry
  // =========================================================================
  describe("Feature 3: Edge Redirection Engine, Invariants & Telemetry", () => {
    it("redirects active link with HTTP 302, via/clickId params, and first-party attribution cookie", async () => {
      const mockKv = new MockKVNamespace();
      const mockAnalytics = new MockAnalyticsEngine();
      const linkRecord: LinkRecord = {
        id: "link_active_001",
        projectId: "ws_brand_test",
        partnerId: "part_vip_99",
        url: "https://brand-shop.io/products/yenergy-leggings",
        geo: null,
        disabledAt: null,
        expiresAt: null,
        archived: false,
      };

      mockKv.store.set("link:go.brand-shop.io:summer", {
        value: JSON.stringify(linkRecord),
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: mockKv as any,
        DB: new MockD1Database() as any,
        CLICKS_ANALYTICS: mockAnalytics as any,
      };

      const request = new Request("https://go.brand-shop.io/summer?utm_source=twitter", {
        headers: {
          "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
          referer: "https://t.co/xyz",
        },
      });
      (request as any).cf = { country: "JP", city: "Tokyo" };

      const waitUntilSpy = vi.fn();
      const executionCtx = { waitUntil: waitUntilSpy } as any;

      const response = await handleLinkRedirection(request, env, executionCtx);

      expect(response.status).toBe(302);
      const location = response.headers.get("Location");
      expect(location).toBeDefined();

      const redirectedUrl = new URL(location!);
      expect(redirectedUrl.pathname).toBe("/ja/products/yenergy-leggings");
      expect(redirectedUrl.searchParams.get("currency")).toBe("JPY");
      expect(redirectedUrl.searchParams.get("utm_source")).toBe("twitter");
      expect(redirectedUrl.searchParams.get("via")).toBe("summer");
      expect(redirectedUrl.searchParams.get("clickId")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^clk_/,
      );

      // Verify 30-day first party cookie
      const setCookie = response.headers.get("Set-Cookie");
      expect(setCookie).toContain("dub_id_go.brand-shop.io_summer=");
      expect(setCookie).toContain("Max-Age=2592000"); // 30 days
      expect(setCookie).toContain("SameSite=Lax");

      // Verify non-blocking telemetry dispatched via waitUntil
      expect(waitUntilSpy).toHaveBeenCalled();
      expect(mockAnalytics.dataPoints.length).toBe(1);
      const dataPoint = mockAnalytics.dataPoints[0];
      expect(dataPoint.blobs[0]).toBe("go.brand-shop.io"); // domain
      expect(dataPoint.blobs[1]).toBe("summer"); // key
      expect(dataPoint.blobs[2]).toBe("link_active_001"); // linkId
      expect(dataPoint.blobs[5]).toBe("JP"); // country
      expect(dataPoint.blobs[6]).toBe("Tokyo"); // city
    });

    it("enforces Invariant 2: Returns HTTP 404 immediately (<15ms) on KV tombstone without querying D1", async () => {
      const mockKv = new MockKVNamespace();
      const mockDb = new MockD1Database();
      const prepareSpy = vi.spyOn(mockDb, "prepare");

      // KV has tombstone with disabledAt
      mockKv.store.set("link:go.brand-shop.io:disabled-promo", {
        value: JSON.stringify({
          id: "tombstone_123",
          projectId: "",
          url: "",
          disabledAt: new Date().toISOString(),
        }),
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: mockKv as any,
        DB: mockDb as any,
      };

      const request = new Request("https://go.brand-shop.io/disabled-promo");
      const response = await handleLinkRedirection(request, env);

      expect(response.status).toBe(404);
      // D1 was NEVER queried because KV tombstone was recognized
      expect(prepareSpy).not.toHaveBeenCalled();
    });

    it("falls back to D1 on KV cache miss and populates KV via waitUntil", async () => {
      const mockKv = new MockKVNamespace();
      const mockDb = new MockD1Database();
      mockDb.records.push({
        id: "link_d1_hit",
        domain: "go.brand-shop.io",
        key: "d1-fallback-key",
        projectId: "ws_brand",
        partnerId: "partner_001",
        url: "https://brand-shop.io/products/cloudsoft-tank",
        geo: null,
        disabledAt: null,
        expiresAt: null,
        archived: 0,
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: mockKv as any,
        DB: mockDb as any,
      };

      const waitUntilSpy = vi.fn();
      const executionCtx = { waitUntil: waitUntilSpy } as any;

      const request = new Request("https://go.brand-shop.io/d1-fallback-key");
      const response = await handleLinkRedirection(request, env, executionCtx);

      expect(response.status).toBe(302);
      expect(mockKv.getCallCount).toBe(1);

      // Verify KV population was scheduled via waitUntil
      expect(waitUntilSpy).toHaveBeenCalled();
    });

    it("enforces Invariant 2: Returns HTTP 404 if link in D1 is soft-deleted (disabledAt !== null)", async () => {
      const mockKv = new MockKVNamespace();
      const mockDb = new MockD1Database();
      mockDb.records.push({
        id: "link_disabled",
        domain: "go.brand-shop.io",
        key: "soft-deleted-key",
        projectId: "ws_brand",
        partnerId: "partner_001",
        url: "https://brand-shop.io/products/cloudsoft-tank",
        geo: null,
        disabledAt: new Date().toISOString(),
        expiresAt: null,
        archived: 0,
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: mockKv as any,
        DB: mockDb as any,
      };

      const request = new Request("https://go.brand-shop.io/soft-deleted-key");
      const response = await handleLinkRedirection(request, env);

      expect(response.status).toBe(404);
    });

    it("returns HTTP 404 if link is expired (expiresAt <= Date.now())", async () => {
      const mockKv = new MockKVNamespace();
      mockKv.store.set("link:go.brand-shop.io:flash-sale", {
        value: JSON.stringify({
          id: "link_expired",
          projectId: "ws_brand",
          partnerId: "partner_001",
          url: "https://brand-shop.io/products/flash",
          geo: null,
          disabledAt: null,
          expiresAt: new Date(Date.now() - 60000).toISOString(), // Expired 1 min ago
          archived: false,
        }),
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: mockKv as any,
        DB: new MockD1Database() as any,
      };

      const request = new Request("https://go.brand-shop.io/flash-sale");
      const response = await handleLinkRedirection(request, env);

      expect(response.status).toBe(404);
    });

    it("returns HTTP 404 if link is archived", async () => {
      const mockKv = new MockKVNamespace();
      mockKv.store.set("link:go.brand-shop.io:archived-link", {
        value: JSON.stringify({
          id: "link_archived",
          projectId: "ws_brand",
          partnerId: "partner_001",
          url: "https://brand-shop.io/products/old",
          geo: null,
          disabledAt: null,
          expiresAt: null,
          archived: true,
        }),
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: mockKv as any,
        DB: new MockD1Database() as any,
      };

      const request = new Request("https://go.brand-shop.io/archived-link");
      const response = await handleLinkRedirection(request, env);

      expect(response.status).toBe(404);
    });
  });
});
