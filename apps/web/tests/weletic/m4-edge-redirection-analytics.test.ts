import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import {
  handleLinkRedirection,
  buildKvKey,
  resolveTargetUrl,
  parseLinkGeo,
  isBot,
  isQrScan,
  ATTRIBUTION_COOKIE_MAX_AGE_SECONDS,
  type LinkRecord,
  type LinkRedirectorEnv,
  type AnalyticsEngineDataPointInput,
  type AnalyticsEngineDatasetBinding,
} from "../../workers/link-redirector/src/index";
import {
  buildPartnerClicksTimeseriesQuery,
  buildGeoDistributionQuery,
  buildLinkAnalyticsQuery,
  buildDailyWorkspaceAggregationsQuery,
  executeAnalyticsEngineQuery,
  fetchPartnerClicksTimeseries,
  fetchGeoDistribution,
  fetchLinkAnalytics,
  fetchDailyWorkspaceAggregations,
  escapeSqlString,
  formatSqlDate,
  AnalyticsEngineError,
  ANALYTICS_ENGINE_DATASET,
} from "../../lib/analytics/analytics-engine";

class MockKVNamespace {
  public store = new Map<string, { value: string; options?: any }>();
  public getCallCount = 0;
  public putCallCount = 0;

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

  prepare(query: string) {
    return new MockD1PreparedStatement(query, this);
  }

  executeFirst<T>(_query: string, params: any[]): T | null {
    this.queryCount++;
    const [domain, key] = params;
    // Invariant 2: WHERE domain = ? AND key = ? AND disabledAt IS NULL
    const match = this.rows.find(
      (r) =>
        r.domain.toLowerCase() === domain.toLowerCase() &&
        r.key.toLowerCase() === key.toLowerCase() &&
        (r.disabledAt === null || r.disabledAt === undefined),
    );
    return (match as T) || null;
  }

  executeAll<T>(_query: string, _params: any[]): T[] {
    this.queryCount++;
    return this.rows as T[];
  }
}

class MockAnalyticsEngine implements AnalyticsEngineDatasetBinding {
  public datapoints: AnalyticsEngineDataPointInput[] = [];

  writeDataPoint(dp: AnalyticsEngineDataPointInput) {
    this.datapoints.push(dp);
  }
}

describe("Milestone 4 (R4): Edge Redirection Worker & Workers Analytics Engine", () => {
  let mockKV: MockKVNamespace;
  let mockD1: MockD1Database;
  let mockAnalytics: MockAnalyticsEngine;
  let env: LinkRedirectorEnv;

  beforeEach(() => {
    mockKV = new MockKVNamespace();
    mockD1 = new MockD1Database();
    mockAnalytics = new MockAnalyticsEngine();
    env = {
      LINKS_KV: mockKV as unknown as KVNamespace,
      DB: mockD1 as unknown as D1Database,
      CLICKS_ANALYTICS: mockAnalytics,
    };
  });

  // =========================================================================
  // 1. Sub-15ms KV Lookup & Cache Hit Redirection
  // =========================================================================
  describe("1. Sub-15ms KV Lookup & Cache Hit Redirection", () => {
    it("1.1 returns HTTP 302 redirect in < 15ms on KV cache hit with zero D1 operations", async () => {
      const link: LinkRecord = {
        id: "link_yamax_1",
        projectId: "ws_yamax_prod",
        partnerId: "ptnr_charlotte",
        url: "https://yamax.co/collections/all",
        disabledAt: null,
        expiresAt: null,
      };

      const kvKey = buildKvKey("dub.sh", "yamax");
      await mockKV.put(kvKey, JSON.stringify(link));

      const req = new Request("https://dub.sh/yamax", {
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
          referer: "https://instagram.com/p/123",
        },
      });

      const startTime = performance.now();
      const res = await handleLinkRedirection(req, env);
      const durationMs = performance.now() - startTime;

      expect(res.status).toBe(302);
      expect(durationMs).toBeLessThan(15);
      expect(mockD1.queryCount).toBe(0); // Zero database I/O

      const location = res.headers.get("Location")!;
      expect(location).toContain("https://yamax.co/collections/all");
      expect(location).toContain("via=yamax");
      expect(location).toContain("clickId=");

      // Cache control and anti-indexing
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    });

    it("1.2 normalizes keys case-insensitively and strips www from domain", async () => {
      const link: LinkRecord = {
        id: "link_test_ci",
        projectId: "ws_yamax_prod",
        url: "https://yamax.co/products/leggings",
        disabledAt: null,
      };

      await mockKV.put(
        buildKvKey("shop.yamax.co", "summer-drop"),
        JSON.stringify(link),
      );

      const req = new Request("https://www.shop.yamax.co/Summer-Drop");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain(
        "https://yamax.co/products/leggings",
      );
    });

    it("1.3 handles Dub inspect mode suffix (+) gracefully", async () => {
      const link: LinkRecord = {
        id: "link_inspect",
        projectId: "ws_inspect",
        url: "https://yamax.co/inspect-page",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "promo"), JSON.stringify(link));

      const req = new Request("https://dub.sh/promo+");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain(
        "https://yamax.co/inspect-page",
      );
    });

    it("1.4 returns 404 for favicon.ico and robots.txt without redirection", async () => {
      const reqFavicon = new Request("https://dub.sh/favicon.ico");
      const resFavicon = await handleLinkRedirection(reqFavicon, env);
      expect(resFavicon.status).toBe(404);

      const reqRobots = new Request("https://dub.sh/robots.txt");
      const resRobots = await handleLinkRedirection(reqRobots, env);
      expect(resRobots.status).toBe(404);
    });
  });

  // =========================================================================
  // 2. D1 Fallback on Cache Miss & KV Auto-Population
  // =========================================================================
  describe("2. D1 Fallback on Cache Miss & KV Auto-Population", () => {
    it("2.1 queries D1 on KV miss, returns 302, and auto-populates KV with 24h TTL", async () => {
      mockD1.rows.push({
        id: "link_d1_fallback",
        domain: "dub.sh",
        key: "new-launch",
        projectId: "ws_yamax_prod",
        partnerId: "ptnr_lucas",
        url: "https://yamax.co/collections/new",
        geo: JSON.stringify({ JP: "https://yamax.co/ja/new" }),
        disabledAt: null,
        expiresAt: null,
      });

      const kvKey = buildKvKey("dub.sh", "new-launch");
      expect(await mockKV.get(kvKey)).toBeNull(); // Ensure initial cache miss

      const req = new Request("https://dub.sh/new-launch");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(302);
      expect(mockD1.queryCount).toBe(1);

      // KV must be auto-populated
      const cachedRaw = await mockKV.get(kvKey);
      expect(cachedRaw).not.toBeNull();
      const cached = JSON.parse(cachedRaw!);
      expect(cached.id).toBe("link_d1_fallback");
      expect(cached.partnerId).toBe("ptnr_lucas");
      expect(mockKV.store.get(kvKey)?.options?.expirationTtl).toBe(86400);

      // Subsequent request hits KV directly without calling D1 again
      const secondReq = new Request("https://dub.sh/new-launch");
      const secondRes = await handleLinkRedirection(secondReq, env);
      expect(secondRes.status).toBe(302);
      expect(mockD1.queryCount).toBe(1); // Still 1, did not re-query D1
    });

    it("2.2 correctly parses object or string geo JSON from D1", () => {
      const parsed1 = parseLinkGeo('{"JP":"https://yamax.co/ja","VN":"https://yamax.co/vi"}');
      expect(parsed1?.JP).toBe("https://yamax.co/ja");
      expect(parsed1?.VN).toBe("https://yamax.co/vi");

      const parsed2 = parseLinkGeo({ jp: "https://yamax.co/ja", US: "https://yamax.co/us" });
      expect(parsed2?.JP).toBe("https://yamax.co/ja");
      expect(parsed2?.US).toBe("https://yamax.co/us");

      expect(parseLinkGeo(null)).toBeNull();
      expect(parseLinkGeo("invalid-json")).toBeNull();
    });
  });

  // =========================================================================
  // 3. Invariant 2 (Soft-Delete Coherence) & Link Expiration
  // =========================================================================
  describe("3. Invariant 2 (Soft-Delete Coherence) & Link Expiration", () => {
    it("3.1 strictly rejects soft-deleted links in D1 with HTTP 404 (disabledAt IS NOT NULL)", async () => {
      mockD1.rows.push({
        id: "link_deleted_d1",
        domain: "dub.sh",
        key: "promo-expired",
        projectId: "ws_yamax_prod",
        partnerId: "ptnr_deleted",
        url: "https://yamax.co/promos",
        disabledAt: "2026-10-01T00:00:00.000Z",
      });

      const req = new Request("https://dub.sh/promo-expired");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(404);
      expect(mockD1.queryCount).toBe(1);
    });

    it("3.2 strictly rejects soft-deleted links in KV with HTTP 404", async () => {
      const disabledLink: LinkRecord = {
        id: "link_disabled_kv",
        projectId: "ws_yamax_prod",
        url: "https://yamax.co/disabled",
        disabledAt: "2026-10-05T12:00:00.000Z",
      };

      await mockKV.put(
        buildKvKey("dub.sh", "disabled-kv"),
        JSON.stringify(disabledLink),
      );

      const req = new Request("https://dub.sh/disabled-kv");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(404);
    });

    it("3.3 strictly rejects expired links (expiresAt in the past) with HTTP 404", async () => {
      const expiredLink: LinkRecord = {
        id: "link_expired",
        projectId: "ws_yamax_prod",
        url: "https://yamax.co/flash-sale",
        disabledAt: null,
        expiresAt: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
      };

      await mockKV.put(
        buildKvKey("dub.sh", "flash-sale"),
        JSON.stringify(expiredLink),
      );

      const req = new Request("https://dub.sh/flash-sale");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(404);
    });

    it("3.4 returns 404 when link does not exist in either KV or D1", async () => {
      const req = new Request("https://dub.sh/unknown-slug-xyz");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(404);
    });
  });

  // =========================================================================
  // 4. Geo-Routing Engine via request.cf.country
  // =========================================================================
  describe("4. Geo-Routing Engine via request.cf.country", () => {
    const baseLink: LinkRecord = {
      id: "link_geo_store",
      projectId: "ws_yamax_prod",
      partnerId: "ptnr_yamax",
      url: "https://yamax.co/collections/all",
      disabledAt: null,
    };

    beforeEach(async () => {
      await mockKV.put(
        buildKvKey("dub.sh", "catalog"),
        JSON.stringify(baseLink),
      );
    });

    it("4.1 routes Japan (JP) users to JPY currency and /ja localized path", async () => {
      const req = new Request("https://dub.sh/catalog");
      (req as any).cf = { country: "JP", city: "Tokyo" };

      const res = await handleLinkRedirection(req, env);
      expect(res.status).toBe(302);

      const loc = new URL(res.headers.get("Location")!);
      expect(loc.pathname).toBe("/ja/collections/all");
      expect(loc.searchParams.get("currency")).toBe("JPY");
    });

    it("4.2 routes Vietnam (VN) users to VND currency and /vi localized path", async () => {
      const req = new Request("https://dub.sh/catalog");
      (req as any).cf = { country: "VN", city: "Hanoi" };

      const res = await handleLinkRedirection(req, env);
      expect(res.status).toBe(302);

      const loc = new URL(res.headers.get("Location")!);
      expect(loc.pathname).toBe("/vi/collections/all");
      expect(loc.searchParams.get("currency")).toBe("VND");
    });

    it("4.3 routes Global / US (US) users to USD currency and default path", async () => {
      const req = new Request("https://dub.sh/catalog");
      (req as any).cf = { country: "US", city: "New York" };

      const res = await handleLinkRedirection(req, env);
      expect(res.status).toBe(302);

      const loc = new URL(res.headers.get("Location")!);
      expect(loc.pathname).toBe("/collections/all");
      expect(loc.searchParams.get("currency")).toBe("USD");
    });

    it("4.4 routes other countries (e.g. AU, GB, or null) to USD currency default", async () => {
      const reqAU = new Request("https://dub.sh/catalog");
      (reqAU as any).cf = { country: "AU", city: "Sydney" };

      const resAU = await handleLinkRedirection(reqAU, env);
      const locAU = new URL(resAU.headers.get("Location")!);
      expect(locAU.searchParams.get("currency")).toBe("USD");

      const reqNull = new Request("https://dub.sh/catalog");
      const resNull = await handleLinkRedirection(reqNull, env);
      const locNull = new URL(resNull.headers.get("Location")!);
      expect(locNull.searchParams.get("currency")).toBe("USD");
    });

    it("4.5 prioritizes custom geo mapping override over default currency routing", async () => {
      const customGeoLink: LinkRecord = {
        id: "link_custom_geo",
        projectId: "ws_yamax_prod",
        url: "https://yamax.co/collections/all",
        geo: {
          FR: "https://yamax.co/fr/special-landing",
          DE: "https://yamax.co/de/special-landing",
        },
        disabledAt: null,
      };

      await mockKV.put(
        buildKvKey("dub.sh", "custom-geo"),
        JSON.stringify(customGeoLink),
      );

      // FR gets custom URL
      const reqFR = new Request("https://dub.sh/custom-geo");
      (reqFR as any).cf = { country: "FR", city: "Paris" };
      const resFR = await handleLinkRedirection(reqFR, env);
      expect(resFR.headers.get("Location")).toContain(
        "https://yamax.co/fr/special-landing",
      );

      // JP falls back to regional currency routing because JP is not in custom geo mapping
      const reqJP = new Request("https://dub.sh/custom-geo");
      (reqJP as any).cf = { country: "JP", city: "Osaka" };
      const resJP = await handleLinkRedirection(reqJP, env);
      const locJP = new URL(resJP.headers.get("Location")!);
      expect(locJP.pathname).toBe("/ja/collections/all");
      expect(locJP.searchParams.get("currency")).toBe("JPY");
    });
  });

  // =========================================================================
  // 5. Query Parameter Preservation & Attribution Decoration
  // =========================================================================
  describe("5. Query Parameter Preservation & Attribution Decoration", () => {
    it("5.1 preserves and merges all incoming query parameters onto destination URL", async () => {
      const link: LinkRecord = {
        id: "link_query_preservation",
        projectId: "ws_yamax_prod",
        url: "https://yamax.co/collections/all?existing=1",
        disabledAt: null,
      };

      await mockKV.put(
        buildKvKey("dub.sh", "summer-promo"),
        JSON.stringify(link),
      );

      const req = new Request(
        "https://dub.sh/summer-promo?ref=aff_super123&discount=VIP20&utm_source=instagram&utm_campaign=summer_sale&custom_param=active",
      );

      const res = await handleLinkRedirection(req, env);
      expect(res.status).toBe(302);

      const loc = new URL(res.headers.get("Location")!);
      expect(loc.searchParams.get("existing")).toBe("1");
      expect(loc.searchParams.get("ref")).toBe("aff_super123");
      expect(loc.searchParams.get("discount")).toBe("VIP20");
      expect(loc.searchParams.get("utm_source")).toBe("instagram");
      expect(loc.searchParams.get("utm_campaign")).toBe("summer_sale");
      expect(loc.searchParams.get("custom_param")).toBe("active");
    });

    it("5.2 decorates destination URL with via and clickId tracking parameters", async () => {
      const link: LinkRecord = {
        id: "link_tracking_test",
        projectId: "ws_yamax_prod",
        url: "https://yamax.co/products/tank-top",
        disabledAt: null,
      };

      await mockKV.put(
        buildKvKey("dub.sh", "tank-top"),
        JSON.stringify(link),
      );

      const req = new Request("https://dub.sh/tank-top");
      const res = await handleLinkRedirection(req, env);

      const loc = new URL(res.headers.get("Location")!);
      expect(loc.searchParams.get("via")).toBe("tank-top");
      expect(loc.searchParams.get("clickId")).toMatch(/^clk_|^[0-9a-f-]{36}$/);
    });

    it("5.3 sets 30-day first-party attribution cookie dub_id_${domain}_${key}", async () => {
      const link: LinkRecord = {
        id: "link_cookie_test",
        projectId: "ws_yamax_prod",
        url: "https://yamax.co/products/shorts",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "shorts"), JSON.stringify(link));

      const req = new Request("https://dub.sh/shorts?clickId=client_cid_9999");
      const res = await handleLinkRedirection(req, env);

      const cookie = res.headers.get("Set-Cookie");
      expect(cookie).not.toBeNull();
      expect(cookie).toContain("dub_id_dub.sh_shorts=client_cid_9999");
      expect(cookie).toContain(`Max-Age=${ATTRIBUTION_COOKIE_MAX_AGE_SECONDS}`);
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Path=/");
    });
  });

  // =========================================================================
  // 6. Workers Analytics Engine Telemetry
  // =========================================================================
  describe("6. Workers Analytics Engine Telemetry", () => {
    it("6.1 synchronously logs click datapoint matching the exact blobs/doubles/indexes schema", async () => {
      const link: LinkRecord = {
        id: "link_telemetry_1",
        projectId: "ws_yamax_prod",
        partnerId: "ptnr_emma",
        url: "https://yamax.co/collections/leggings",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "leggings"), JSON.stringify(link));

      const req = new Request("https://dub.sh/leggings?clickId=cid_test_777", {
        headers: {
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
          referer: "https://tiktok.com/@emma_fitness",
        },
      });
      (req as any).cf = { country: "JP", city: "Osaka" };

      await handleLinkRedirection(req, env);

      expect(mockAnalytics.datapoints.length).toBe(1);
      const dp = mockAnalytics.datapoints[0];

      // Blobs: [domain, key, id, projectId, partnerId, country, city, userAgent, referrerHost, clickId, targetUrl]
      expect(dp.blobs).toHaveLength(11);
      expect(dp.blobs![0]).toBe("dub.sh");
      expect(dp.blobs![1]).toBe("leggings");
      expect(dp.blobs![2]).toBe("link_telemetry_1");
      expect(dp.blobs![3]).toBe("ws_yamax_prod");
      expect(dp.blobs![4]).toBe("ptnr_emma");
      expect(dp.blobs![5]).toBe("JP");
      expect(dp.blobs![6]).toBe("Osaka");
      expect(dp.blobs![7]).toContain("iPhone");
      expect(dp.blobs![8]).toBe("tiktok.com");
      expect(dp.blobs![9]).toBe("cid_test_777");
      expect(dp.blobs![10]).toContain("https://yamax.co/ja/collections/leggings?currency=JPY");

      // Doubles: [isBot, isQr, conversionValue]
      expect(dp.doubles).toHaveLength(3);
      expect(dp.doubles![0]).toBe(0); // not a bot
      expect(dp.doubles![1]).toBe(0); // not a QR code
      expect(dp.doubles![2]).toBe(0); // initial conversion value

      // Indexes: [projectId]
      expect(dp.indexes).toEqual(["ws_yamax_prod"]);
    });

    it("6.2 accurately flags bot traffic in double1", async () => {
      const link: LinkRecord = {
        id: "link_bot_test",
        projectId: "ws_yamax_prod",
        url: "https://yamax.co/bot-test",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "bot-link"), JSON.stringify(link));

      const botReq = new Request("https://dub.sh/bot-link", {
        headers: {
          "user-agent":
            "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        },
      });

      await handleLinkRedirection(botReq, env);

      expect(mockAnalytics.datapoints.length).toBe(1);
      expect(mockAnalytics.datapoints[0].doubles![0]).toBe(1); // bot detected
    });

    it("6.3 accurately flags QR scan in double2 when qr=1 query param is present", async () => {
      const link: LinkRecord = {
        id: "link_qr_test",
        projectId: "ws_yamax_prod",
        url: "https://yamax.co/qr-test",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "qr-link"), JSON.stringify(link));

      const qrReq = new Request("https://dub.sh/qr-link?qr=1");
      await handleLinkRedirection(qrReq, env);

      expect(mockAnalytics.datapoints.length).toBe(1);
      expect(mockAnalytics.datapoints[0].doubles![1]).toBe(1); // QR scan detected
    });

    it("6.4 bot detection helper isBot and isQrScan functions behave correctly", () => {
      const reqNormal = new Request("https://dub.sh/x", {
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      expect(isBot(reqNormal)).toBe(false);

      const reqCurl = new Request("https://dub.sh/x", {
        headers: { "user-agent": "curl/8.1.2" },
      });
      expect(isBot(reqCurl)).toBe(true);

      const reqCfBot = new Request("https://dub.sh/x", {
        headers: { "cf-verified-bot": "1" },
      });
      expect(isBot(reqCfBot)).toBe(true);

      expect(isQrScan(new URL("https://dub.sh/x?qr=1"))).toBe(true);
      expect(isQrScan(new URL("https://dub.sh/x?qr=0"))).toBe(false);
      expect(isQrScan(new URL("https://dub.sh/x"))).toBe(false);
    });
  });

  // =========================================================================
  // 7. Analytics Engine SQL API Client & Query Builder
  // =========================================================================
  describe("7. Analytics Engine SQL API Client & Query Builder", () => {
    it("7.1 builds partner clicks timeseries query with proper intervals and filters", () => {
      const query = buildPartnerClicksTimeseriesQuery({
        projectId: "ws_yamax_prod",
        partnerId: "ptnr_charlotte",
        startDate: "2026-10-01T00:00:00Z",
        endDate: "2026-10-08T23:59:59Z",
        intervalDays: 1,
      });

      expect(query).toContain(`FROM ${ANALYTICS_ENGINE_DATASET}`);
      expect(query).toContain("index1 = 'ws_yamax_prod'");
      expect(query).toContain("blob5 = 'ptnr_charlotte'");
      expect(query).toContain("toStartOfInterval(timestamp, INTERVAL '1' DAY)");
      expect(query).toContain("count() AS totalClicks");
      expect(query).toContain("countIf(double1 = 0) AS validClicks");
      expect(query).toContain("countIf(double1 = 1) AS botClicks");
      expect(query).toContain("sum(double3) AS totalConversionValue");
      expect(query).toContain("GROUP BY partnerId, day");
      expect(query).toContain("ORDER BY day ASC");
    });

    it("7.2 builds geographic distribution query with limit and grouping", () => {
      const query = buildGeoDistributionQuery({
        projectId: "ws_yamax_prod",
        partnerId: "ptnr_charlotte",
        startDate: "2026-09-01 00:00:00",
        endDate: "2026-10-01 00:00:00",
        limit: 25,
      });

      expect(query).toContain("blob6 AS country");
      expect(query).toContain("index1 = 'ws_yamax_prod'");
      expect(query).toContain("blob5 = 'ptnr_charlotte'");
      expect(query).toContain("GROUP BY country");
      expect(query).toContain("ORDER BY totalClicks DESC");
      expect(query).toContain("LIMIT 25");
    });

    it("7.3 builds link-level analytics aggregation query", () => {
      const query = buildLinkAnalyticsQuery({
        projectId: "ws_yamax_prod",
        linkId: "link_12345",
        key: "summer-tank",
      });

      expect(query).toContain("blob3 AS linkId");
      expect(query).toContain("blob2 AS key");
      expect(query).toContain("index1 = 'ws_yamax_prod'");
      expect(query).toContain("blob3 = 'link_12345'");
      expect(query).toContain("blob2 = 'summer-tank'");
      expect(query).toContain("countIf(double2 = 1) AS qrClicks");
    });

    it("7.4 builds daily workspace aggregations query", () => {
      const query = buildDailyWorkspaceAggregationsQuery({
        projectId: "ws_yamax_prod",
        days: 14,
      });

      expect(query).toContain("index1 = 'ws_yamax_prod'");
      expect(query).toContain("INTERVAL '14' DAY");
      expect(query).toContain("GROUP BY day");
      expect(query).toContain("ORDER BY day DESC");
    });

    it("7.5 protects against SQL injection in escapeSqlString", () => {
      const malicious = "ws_test' OR 1=1; DROP TABLE clicks_analytics; --";
      const sanitized = escapeSqlString(malicious);

      expect(sanitized).toBe("ws_test'' OR 1=1; DROP TABLE clicks_analytics; --");
      expect(sanitized).not.toContain("'' OR 1=1' OR 1=1");

      const queryWithEscape = buildGeoDistributionQuery({
        projectId: malicious,
      });
      expect(queryWithEscape).toContain(
        "index1 = 'ws_test'' OR 1=1; DROP TABLE clicks_analytics; --'",
      );
    });

    it("7.6 formats dates safely for ClickHouse SQL via formatSqlDate", () => {
      const date = new Date("2026-10-08T18:00:00.000Z");
      expect(formatSqlDate(date)).toBe("2026-10-08 18:00:00");

      expect(() => formatSqlDate("not-a-valid-date")).toThrow(
        "Invalid date provided to formatSqlDate",
      );
    });

    it("7.7 executes Analytics Engine SQL query successfully with custom fetch mock", async () => {
      const mockResult = {
        data: [
          {
            partnerId: "ptnr_charlotte",
            day: "2026-10-08 00:00:00",
            totalClicks: 250,
            validClicks: 242,
            botClicks: 8,
            totalConversionValue: 125000,
          },
        ],
        meta: [
          { name: "partnerId", type: "String" },
          { name: "totalClicks", type: "UInt64" },
        ],
        rows: 1,
      };

      const customFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(mockResult), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

      const response = await executeAnalyticsEngineQuery("SELECT 1", {
        accountId: "cf_account_12345",
        apiToken: "cf_token_secret_xyz",
        fetchFn: customFetch,
      });

      expect(customFetch).toHaveBeenCalledTimes(1);
      const [url, init] = customFetch.mock.calls[0];
      expect(url).toBe(
        "https://api.cloudflare.com/client/v4/accounts/cf_account_12345/analytics_engine/sql",
      );
      expect(init.method).toBe("POST");
      expect(init.headers["Authorization"]).toBe("Bearer cf_token_secret_xyz");
      expect(init.headers["Content-Type"]).toBe("text/plain");
      expect(init.body).toBe("SELECT 1");

      expect(response.rows).toBe(1);
      expect(response.data[0].totalClicks).toBe(250);
    });

    it("7.8 throws descriptive AnalyticsEngineError on authentication or query errors", async () => {
      // Missing account ID
      await expect(
        executeAnalyticsEngineQuery("SELECT 1", {
          apiToken: "token_only",
        }),
      ).rejects.toThrow(AnalyticsEngineError);

      // Missing API token
      await expect(
        executeAnalyticsEngineQuery("SELECT 1", {
          accountId: "acc_only",
        }),
      ).rejects.toThrow(AnalyticsEngineError);

      // HTTP Error from Cloudflare API
      const errorFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [{ code: 1000, message: "Dataset not found" }],
          }),
          { status: 404 },
        ),
      );

      await expect(
        executeAnalyticsEngineQuery("SELECT 1", {
          accountId: "acc_123",
          apiToken: "tok_123",
          fetchFn: errorFetch,
        }),
      ).rejects.toThrow("Analytics Engine SQL query failed with status 404");
    });

    it("7.9 executes high-level domain functions with mock fetch", async () => {
      const mockTimeseries = [
        {
          partnerId: "ptnr_1",
          day: "2026-10-01 00:00:00",
          totalClicks: 10,
          validClicks: 9,
          botClicks: 1,
          totalConversionValue: 500,
        },
      ];

      const customFetch = vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ data: mockTimeseries, rows: 1 }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );

      const config = {
        accountId: "acc_999",
        apiToken: "tok_999",
        fetchFn: customFetch,
      };

      const timeseries = await fetchPartnerClicksTimeseries(
        {
          projectId: "ws_1",
          partnerId: "ptnr_1",
          startDate: "2026-10-01",
          endDate: "2026-10-02",
        },
        config,
      );
      expect(timeseries).toHaveLength(1);
      expect(timeseries[0].partnerId).toBe("ptnr_1");

      const geo = await fetchGeoDistribution({ projectId: "ws_1" }, config);
      expect(geo).toHaveLength(1);

      const link = await fetchLinkAnalytics({ projectId: "ws_1", linkId: "l_1" }, config);
      expect(link).toHaveLength(1);

      const workspace = await fetchDailyWorkspaceAggregations(
        { projectId: "ws_1" },
        config,
      );
      expect(workspace).toHaveLength(1);
    });
  });

  // =========================================================================
  // 8. Invariants 1, 2, and 4 Architectural Compliance
  // =========================================================================
  describe("8. Invariants Compliance Matrix (shopify_sync_invariants.md)", () => {
    it("8.1 strictly complies with Invariant 2: soft-deleted links cannot be accessed or redirected", async () => {
      // Invariant 2 requirement: Uniqueness checks for new resource creation must ignore or auto-purge
      // soft-deleted/disabled records, and API queries must include where: { disabledAt: null }.
      const softDeletedInD1 = {
        id: "link_invar_2_d1",
        domain: "store.yamax.co",
        key: "promo-recycled",
        projectId: "ws_yamax",
        url: "https://yamax.co/old",
        disabledAt: "2026-09-01T00:00:00.000Z",
      };
      mockD1.rows.push(softDeletedInD1);

      const reqD1 = new Request("https://store.yamax.co/promo-recycled");
      const resD1 = await handleLinkRedirection(reqD1, env);
      expect(resD1.status).toBe(404);

      // Now add active link with the same recycled key
      const activeRecycled = {
        id: "link_invar_2_active",
        domain: "store.yamax.co",
        key: "promo-recycled",
        projectId: "ws_yamax",
        url: "https://yamax.co/new-active",
        disabledAt: null,
      };
      mockD1.rows.push(activeRecycled);
      if (env.LINKS_KV) {
        await env.LINKS_KV.delete("link:store.yamax.co:promo-recycled");
      }

      const resActive = await handleLinkRedirection(reqD1, env);
      expect(resActive.status).toBe(302);
      expect(resActive.headers.get("Location")).toContain(
        "https://yamax.co/new-active",
      );
    });

    it("8.2 complies with Invariant 4: Zero hardcoding of store domains or workspace IDs", async () => {
      // Works seamlessly with any multi-tenant domain and workspace ID dynamically
      const tenantDomains = [
        { domain: "partner.brand-alpha.com", key: "deal1", ws: "ws_alpha" },
        { domain: "deals.beta-store.net", key: "deal2", ws: "ws_beta" },
        { domain: "go.gamma-fitness.org", key: "deal3", ws: "ws_gamma" },
      ];

      for (const item of tenantDomains) {
        mockD1.rows.push({
          id: `link_${item.key}`,
          domain: item.domain,
          key: item.key,
          projectId: item.ws,
          url: `https://${item.domain}/target`,
          disabledAt: null,
        });

        const req = new Request(`https://${item.domain}/${item.key}`);
        const res = await handleLinkRedirection(req, env);
        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toContain(
          `https://${item.domain}/target`,
        );
      }
    });
  });

  // =========================================================================
  // 9. Adversarial & Edge Cases Matrix
  // =========================================================================
  describe("9. Adversarial & Edge Cases Matrix", () => {
    it("9.1 gracefully falls back to D1 when KV throws a transient error", async () => {
      const failingKV = {
        async get() {
          throw new Error("KV_TRANSIENT_TIMEOUT");
        },
        async put() {},
        async delete() {},
      };

      mockD1.rows.push({
        id: "link_fallback_err",
        domain: "dub.sh",
        key: "resilient-link",
        projectId: "ws_resilient",
        url: "https://yamax.co/resilient",
        disabledAt: null,
      });

      const resilientEnv: LinkRedirectorEnv = {
        LINKS_KV: failingKV as unknown as KVNamespace,
        DB: mockD1 as unknown as D1Database,
      };

      const req = new Request("https://dub.sh/resilient-link");
      const res = await handleLinkRedirection(req, resilientEnv);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("https://yamax.co/resilient");
    });

    it("9.2 returns 404 cleanly when D1 throws an error", async () => {
      const failingD1 = {
        prepare() {
          throw new Error("D1_CORRUPTED_OR_LOCKED");
        },
      };

      const brokenEnv: LinkRedirectorEnv = {
        DB: failingD1 as unknown as D1Database,
      };

      const req = new Request("https://dub.sh/any-link");
      const res = await handleLinkRedirection(req, brokenEnv);

      expect(res.status).toBe(404);
    });

    it("9.3 preserves URL fragments (#anchor) and existing target query parameters", async () => {
      const linkWithHash: LinkRecord = {
        id: "link_hash",
        projectId: "ws_yamax",
        url: "https://yamax.co/products/leggings?sku=L123#reviews",
        disabledAt: null,
      };

      await mockKV.put(
        buildKvKey("dub.sh", "leggings-hash"),
        JSON.stringify(linkWithHash),
      );

      const req = new Request("https://dub.sh/leggings-hash?utm_medium=cpc");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(302);
      const loc = res.headers.get("Location")!;
      expect(loc).toContain("sku=L123");
      expect(loc).toContain("utm_medium=cpc");
      expect(loc).toContain("#reviews");
    });

    it("9.4 normalizes lowercase country code (e.g. 'jp', 'vn') properly", async () => {
      const link: LinkRecord = {
        id: "link_lowercase_geo",
        projectId: "ws_yamax",
        url: "https://yamax.co/collections/all",
        disabledAt: null,
      };

      await mockKV.put(
        buildKvKey("dub.sh", "lowercase-geo"),
        JSON.stringify(link),
      );

      const req = new Request("https://dub.sh/lowercase-geo");
      (req as any).cf = { country: "jp" }; // lowercase

      const res = await handleLinkRedirection(req, env);
      const loc = new URL(res.headers.get("Location")!);
      expect(loc.pathname).toBe("/ja/collections/all");
      expect(loc.searchParams.get("currency")).toBe("JPY");
    });

    it("9.5 accurately flags AI & crawler user agents in double1", () => {
      const crawlerUAs = [
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
        "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
        "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
        "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        "Twitterbot/1.0",
      ];

      for (const ua of crawlerUAs) {
        const req = new Request("https://dub.sh/test", {
          headers: { "user-agent": ua },
        });
        expect(isBot(req)).toBe(true);
      }
    });

    it("9.6 parses float and integer conversionValue into telemetry double3", async () => {
      const link: LinkRecord = {
        id: "link_conv",
        projectId: "ws_conv",
        url: "https://yamax.co/product",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "conv-val"), JSON.stringify(link));

      const req = new Request("https://dub.sh/conv-val?conversionValue=249.99");
      await handleLinkRedirection(req, env);

      expect(mockAnalytics.datapoints.length).toBe(1);
      expect(mockAnalytics.datapoints[0].doubles![2]).toBe(249.99);
    });

    it("9.7 works seamlessly when CLICKS_ANALYTICS binding is omitted", async () => {
      const link: LinkRecord = {
        id: "link_no_analytics",
        projectId: "ws_no_analytics",
        url: "https://yamax.co/home",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "home"), JSON.stringify(link));

      const envWithoutAnalytics: LinkRedirectorEnv = {
        LINKS_KV: mockKV as unknown as KVNamespace,
      };

      const req = new Request("https://dub.sh/home");
      const res = await handleLinkRedirection(req, envWithoutAnalytics);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("https://yamax.co/home");
    });

    it("9.8 rejects non-GET and non-HEAD methods with 405 Method Not Allowed", async () => {
      const postReq = new Request("https://dub.sh/yamax", { method: "POST" });
      const postRes = await handleLinkRedirection(postReq, env);
      expect(postRes.status).toBe(405);

      const putReq = new Request("https://dub.sh/yamax", { method: "PUT" });
      const putRes = await handleLinkRedirection(putReq, env);
      expect(putRes.status).toBe(405);

      const delReq = new Request("https://dub.sh/yamax", { method: "DELETE" });
      const delRes = await handleLinkRedirection(delReq, env);
      expect(delRes.status).toBe(405);
    });

    it("9.9 clamps geo distribution query limit between 1 and 1000", () => {
      const queryMin = buildGeoDistributionQuery({
        projectId: "ws_test",
        limit: -5,
      });
      expect(queryMin).toContain("LIMIT 1");

      const queryMax = buildGeoDistributionQuery({
        projectId: "ws_test",
        limit: 5000,
      });
      expect(queryMax).toContain("LIMIT 1000");
    });
  });
});
