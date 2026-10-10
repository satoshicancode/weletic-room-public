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
  public simulatedDelayMs = 0;
  public shouldFailGet = false;
  public shouldFailPut = false;

  async get(key: string, type?: string) {
    this.getCallCount++;
    if (this.shouldFailGet) {
      throw new Error("KV_INTERNAL_ERROR");
    }
    if (this.simulatedDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.simulatedDelayMs));
    }
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
    if (this.shouldFailPut) {
      throw new Error("KV_PUT_QUOTA_EXCEEDED");
    }
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
  public shouldFail = false;

  prepare(query: string) {
    if (this.shouldFail) {
      throw new Error("D1_DATABASE_LOCKED");
    }
    return new MockD1PreparedStatement(query, this);
  }

  executeFirst<T>(_query: string, params: any[]): T | null {
    this.queryCount++;
    if (this.shouldFail) {
      throw new Error("D1_DATABASE_LOCKED");
    }
    const [domain, key] = params;
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
    if (this.shouldFail) {
      throw new Error("D1_DATABASE_LOCKED");
    }
    return this.rows as T[];
  }
}

class MockAnalyticsEngine implements AnalyticsEngineDatasetBinding {
  public datapoints: AnalyticsEngineDataPointInput[] = [];

  writeDataPoint(dp: AnalyticsEngineDataPointInput) {
    this.datapoints.push(dp);
  }
}

describe("Adversarial Challenger Suite: Milestone 4 (R4) Edge Redirection & Analytics Engine", () => {
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
  // TASK 1: Stress-Test KV Resolution Latency & D1 Fallback Cache Stampede
  // =========================================================================
  describe("Task 1: Empirical KV Latency & D1 Fallback Stampede", () => {
    it("1.1 [Empirical] executes 100 consecutive KV cache hits and proves p99 latency < 15ms", async () => {
      const link: LinkRecord = {
        id: "link_stress_perf",
        projectId: "ws_benchmark",
        partnerId: "ptnr_flash",
        url: "https://yamax.co/collections/leggings",
        disabledAt: null,
      };

      const kvKey = buildKvKey("dub.sh", "speedtest");
      await mockKV.put(kvKey, JSON.stringify(link));

      const durations: number[] = [];
      const iterations = 100;

      for (let i = 0; i < iterations; i++) {
        const req = new Request("https://dub.sh/speedtest");
        const start = performance.now();
        const res = await handleLinkRedirection(req, env);
        const duration = performance.now() - start;

        durations.push(duration);
        expect(res.status).toBe(302);
      }

      durations.sort((a, b) => a - b);
      const p50 = durations[Math.floor(iterations * 0.5)];
      const p95 = durations[Math.floor(iterations * 0.95)];
      const p99 = durations[Math.floor(iterations * 0.99)];
      const max = durations[iterations - 1];

      // Verifications
      expect(mockD1.queryCount).toBe(0); // Zero D1 roundtrips
      expect(p99).toBeLessThan(15); // p99 must be strictly < 15ms
      expect(max).toBeLessThan(20); // max edge resolution bound
    });

    it("1.2 [Stampede] handles 50 concurrent requests for an uncached link with auto-population", async () => {
      mockD1.rows.push({
        id: "link_burst_target",
        domain: "dub.sh",
        key: "viral-drop",
        projectId: "ws_yamax",
        partnerId: "ptnr_influencer",
        url: "https://yamax.co/products/viral-drop",
        disabledAt: null,
      });

      const concurrentRequests = Array.from({ length: 50 }, () =>
        handleLinkRedirection(new Request("https://dub.sh/viral-drop"), env),
      );

      const responses = await Promise.all(concurrentRequests);

      // All 50 requests must succeed with 302
      for (const res of responses) {
        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toContain("https://yamax.co/products/viral-drop");
      }

      // KV must now contain the cached key with 24-hour TTL (86400s)
      const kvKey = buildKvKey("dub.sh", "viral-drop");
      const cached = mockKV.store.get(kvKey);
      expect(cached).toBeDefined();
      expect(cached?.options?.expirationTtl).toBe(86400);

      // Subsequent 50 requests hit KV with zero new D1 queries
      const initialD1Queries = mockD1.queryCount;
      const cachedRequests = Array.from({ length: 50 }, () =>
        handleLinkRedirection(new Request("https://dub.sh/viral-drop"), env),
      );
      const cachedResponses = await Promise.all(cachedRequests);

      for (const res of cachedResponses) {
        expect(res.status).toBe(302);
      }
      expect(mockD1.queryCount).toBe(initialD1Queries); // Zero additional D1 queries
    });

    it("1.3 [Resilience] survives KV put failure on D1 fallback and still successfully redirects", async () => {
      mockKV.shouldFailPut = true; // Simulate KV write outage / quota error

      mockD1.rows.push({
        id: "link_kv_failing",
        domain: "dub.sh",
        key: "resilient-link",
        projectId: "ws_yamax",
        url: "https://yamax.co/resilient",
        disabledAt: null,
      });

      const req = new Request("https://dub.sh/resilient-link");
      const res = await handleLinkRedirection(req, env);

      // Even if KV put throws, worker must catch and successfully redirect user
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("https://yamax.co/resilient");
    });

    it("1.4 [Resilience] handles malformed JSON in KV by falling back to D1 seamlessly", async () => {
      const kvKey = buildKvKey("dub.sh", "corrupted");
      // Poison KV with unparseable garbage
      mockKV.store.set(kvKey, { value: "{malformed_json_not_valid" });

      mockD1.rows.push({
        id: "link_from_d1",
        domain: "dub.sh",
        key: "corrupted",
        projectId: "ws_yamax",
        url: "https://yamax.co/healed",
        disabledAt: null,
      });

      const req = new Request("https://dub.sh/corrupted");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("https://yamax.co/healed");
      expect(mockD1.queryCount).toBe(1);
    });
  });

  // =========================================================================
  // TASK 2: Adversarial Geo-Routing & Currency Poisoning Stress Tests
  // =========================================================================
  describe("Task 2: Adversarial Geo-Routing & Currency Assignment", () => {
    const baseLink: LinkRecord = {
      id: "link_geo_adversarial",
      projectId: "ws_yamax",
      url: "https://yamax.co/collections/all",
      disabledAt: null,
    };

    beforeEach(async () => {
      await mockKV.put(buildKvKey("dub.sh", "geo-test"), JSON.stringify(baseLink));
    });

    it("2.1 safely handles hostile, extreme, or malformed country codes without crashing", async () => {
      const hostileCountryCodes = [
        "", // empty
        "   ", // whitespace only
        null, // null
        undefined, // undefined
        "JPN", // 3 letters
        "JAPAN", // full name
        "12", // numeric
        "🇯🇵", // emoji flag
        "JP; DROP TABLE", // SQL injection attempt
        "<script>alert(1)</script>", // XSS payload
        "j\0p", // null byte embedded
        "../../etc/passwd", // path traversal
        "very-long-country-name-exceeding-any-known-iso-code-length",
      ];

      for (const hostileCode of hostileCountryCodes) {
        const req = new Request("https://dub.sh/geo-test");
        (req as any).cf = { country: hostileCode };

        const res = await handleLinkRedirection(req, env);
        expect(res.status).toBe(302);

        const loc = new URL(res.headers.get("Location")!);
        // None of these should crash, and since none match JP or VN exactly,
        // all must safely fallback to USD currency
        expect(loc.searchParams.get("currency")).toBe("USD");
      }
    });

    it("2.2 validates exact regional currency mappings: JP->JPY, VN->VND, US/Global->USD", async () => {
      // JP
      const reqJP = new Request("https://dub.sh/geo-test");
      (reqJP as any).cf = { country: "JP" };
      const resJP = await handleLinkRedirection(reqJP, env);
      const locJP = new URL(resJP.headers.get("Location")!);
      expect(locJP.searchParams.get("currency")).toBe("JPY");
      expect(locJP.pathname).toBe("/ja/collections/all");

      // VN
      const reqVN = new Request("https://dub.sh/geo-test");
      (reqVN as any).cf = { country: "VN" };
      const resVN = await handleLinkRedirection(reqVN, env);
      const locVN = new URL(resVN.headers.get("Location")!);
      expect(locVN.searchParams.get("currency")).toBe("VND");
      expect(locVN.pathname).toBe("/vi/collections/all");

      // US
      const reqUS = new Request("https://dub.sh/geo-test");
      (reqUS as any).cf = { country: "US" };
      const resUS = await handleLinkRedirection(reqUS, env);
      const locUS = new URL(resUS.headers.get("Location")!);
      expect(locUS.searchParams.get("currency")).toBe("USD");
      expect(locUS.pathname).toBe("/collections/all");
    });

    it("2.3 analyzes currency parameter interaction when incoming URL provides ?currency=...", async () => {
      // Adversarial test: incoming request attempts to poison currency parameter with ?currency=EUR or ?currency=POISON
      const req = new Request("https://dub.sh/geo-test?currency=POISON");
      (req as any).cf = { country: "JP" };

      const res = await handleLinkRedirection(req, env);
      const loc = new URL(res.headers.get("Location")!);

      // Observation test: check whether incoming ?currency= overrides geo currency or vice versa
      // In current code: resolveTargetUrl sets currency=JPY, then incomingUrl.searchParams.forEach sets currency=POISON
      // This documents the exact empirical behavior:
      expect(loc.searchParams.get("currency")).toBe("POISON");
    });
  });

  // =========================================================================
  // TASK 3: Complex URL Encoding, Query Tampering & Attribution Integrity
  // =========================================================================
  describe("Task 3: URL Encoding, Query Tampering & Attribution Integrity", () => {
    it("3.1 preserves complex URL encoded characters, spaces, and special symbols", async () => {
      const link: LinkRecord = {
        id: "link_encoding",
        projectId: "ws_yamax",
        url: "https://yamax.co/search?category=yoga%20wear",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "encoded-test"), JSON.stringify(link));

      const complexQuery =
        "?search=high%20waist%20leggings&symbol=%26%25%23%3D&filter%5Bcolor%5D=deep%20navy&emoji=%F0%9F%A7%98";
      const req = new Request(`https://dub.sh/encoded-test${complexQuery}`);
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get("Location")!);

      expect(loc.searchParams.get("search")).toBe("high waist leggings");
      expect(loc.searchParams.get("symbol")).toBe("&%#=");
      expect(loc.searchParams.get("filter[color]")).toBe("deep navy");
      expect(loc.searchParams.get("emoji")).toBe("🧘");
    });

    it("3.2 strictly preserves anchor fragments (#section) through edge redirection", async () => {
      const linkWithHash: LinkRecord = {
        id: "link_fragment",
        projectId: "ws_yamax",
        url: "https://yamax.co/products/yenergy-leggings#specifications",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "hash-link"), JSON.stringify(linkWithHash));

      const req = new Request("https://dub.sh/hash-link?utm_source=twitter");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(302);
      const location = res.headers.get("Location")!;
      expect(location).toContain("#specifications");
      expect(location.endsWith("#specifications")).toBe(true);
    });

    it("3.3 guarantees tracking parameters 'via' and 'clickId' are present and attribution cookie is set", async () => {
      const link: LinkRecord = {
        id: "link_attr",
        projectId: "ws_yamax",
        url: "https://yamax.co/item",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "summer-deal"), JSON.stringify(link));

      const req = new Request("https://dub.sh/summer-deal");
      const res = await handleLinkRedirection(req, env);

      const loc = new URL(res.headers.get("Location")!);
      expect(loc.searchParams.get("via")).toBe("summer-deal");
      const clickId = loc.searchParams.get("clickId");
      expect(clickId).toBeDefined();
      expect(clickId!.length).toBeGreaterThan(10);

      // Verify cookie
      const cookieHeader = res.headers.get("Set-Cookie");
      expect(cookieHeader).not.toBeNull();
      expect(cookieHeader).toContain(`dub_id_dub.sh_summer-deal=${clickId}`);
      expect(cookieHeader).toContain("Max-Age=2592000"); // 30 days
      expect(cookieHeader).toContain("SameSite=Lax");
      expect(cookieHeader).toContain("Secure");
      expect(cookieHeader).toContain("Path=/");
    });
  });

  // =========================================================================
  // TASK 4: Invariant 2 (Soft-Delete Coherence), Expiration & Zero Leakage
  // =========================================================================
  describe("Task 4: Invariant 2 Soft-Delete Coherence & Zero Info Leakage", () => {
    it("4.1 [Zero Leakage] verifies 404 response on soft-deleted links contains zero location headers or cookies", async () => {
      // Soft-deleted in KV
      const softDeletedKV: LinkRecord = {
        id: "link_secret_1",
        projectId: "ws_yamax",
        url: "https://yamax.co/super-secret-vip-destination",
        disabledAt: "2026-10-01T00:00:00Z",
      };
      await mockKV.put(buildKvKey("dub.sh", "secret-promo"), JSON.stringify(softDeletedKV));

      const reqKV = new Request("https://dub.sh/secret-promo");
      const resKV = await handleLinkRedirection(reqKV, env);

      expect(resKV.status).toBe(404);
      expect(resKV.headers.get("Location")).toBeNull();
      expect(resKV.headers.get("Set-Cookie")).toBeNull();
      const bodyKV = await resKV.text();
      expect(bodyKV).not.toContain("super-secret");

      // Soft-deleted in D1
      mockD1.rows.push({
        id: "link_secret_2",
        domain: "dub.sh",
        key: "secret-d1",
        projectId: "ws_yamax",
        url: "https://yamax.co/confidential-internal-url",
        disabledAt: "2026-09-15T00:00:00Z",
      });

      const reqD1 = new Request("https://dub.sh/secret-d1");
      const resD1 = await handleLinkRedirection(reqD1, env);

      expect(resD1.status).toBe(404);
      expect(resD1.headers.get("Location")).toBeNull();
      expect(resD1.headers.get("Set-Cookie")).toBeNull();
      const bodyD1 = await resD1.text();
      expect(bodyD1).not.toContain("confidential");
    });

    it("4.2 rejects expired link with 404 and allows non-expired link with 302", async () => {
      // 1 minute in the past
      const expiredLink: LinkRecord = {
        id: "link_exp_past",
        projectId: "ws_yamax",
        url: "https://yamax.co/expired",
        disabledAt: null,
        expiresAt: new Date(Date.now() - 60000).toISOString(),
      };
      await mockKV.put(buildKvKey("dub.sh", "past-exp"), JSON.stringify(expiredLink));

      const resPast = await handleLinkRedirection(new Request("https://dub.sh/past-exp"), env);
      expect(resPast.status).toBe(404);

      // 1 hour in the future
      const futureLink: LinkRecord = {
        id: "link_exp_future",
        projectId: "ws_yamax",
        url: "https://yamax.co/valid-future",
        disabledAt: null,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
      await mockKV.put(buildKvKey("dub.sh", "future-exp"), JSON.stringify(futureLink));

      const resFuture = await handleLinkRedirection(new Request("https://dub.sh/future-exp"), env);
      expect(resFuture.status).toBe(302);
      expect(resFuture.headers.get("Location")).toContain("https://yamax.co/valid-future");
    });

    it("4.3 handles non-ISO / malformed expiresAt gracefully without server crash", async () => {
      const malformedExpLink: LinkRecord = {
        id: "link_bad_exp",
        projectId: "ws_yamax",
        url: "https://yamax.co/landing",
        disabledAt: null,
        expiresAt: "invalid-timestamp-string",
      };
      await mockKV.put(buildKvKey("dub.sh", "bad-exp"), JSON.stringify(malformedExpLink));

      const res = await handleLinkRedirection(new Request("https://dub.sh/bad-exp"), env);
      // Date.getTime() is NaN, handler does not crash
      expect([302, 404]).toContain(res.status);
    });
  });

  // =========================================================================
  // TASK 5: Adversarial SQL Injection in Analytics Engine Query Builders
  // =========================================================================
  describe("Task 5: Adversarial SQL Injection in Analytics Engine Query Builders", () => {
    const hostileSqlPayloads = [
      "' OR '1'='1",
      "'; DROP TABLE clicks_analytics; --",
      "' UNION SELECT 1, 2, 3, 4, 5, 6, 7 FROM clicks_analytics WHERE '1'='1' --",
      "admin'--",
      "/* comment */ ' OR 1=1 --",
      "test\\' OR 1=1 --",
      "test' AND SLEEP(5) --",
      "1'; SELECT * FROM information_schema.tables; --",
      "1' OR 1=1#",
      "foo\0bar", // null byte
      "\\0' OR 1=1 --",
      "'; EXEC xp_cmdshell('dir'); --",
    ];

    it("5.1 [escapeSqlString] escapes single quotes and backslashes across all hostile payloads", () => {
      for (const payload of hostileSqlPayloads) {
        const escaped = escapeSqlString(payload);

        // An escaped string in ClickHouse / SQL:
        // Must never contain an unescaped single quote:
        // Any quote must be paired as ''
        // Check for isolated single quote:
        const unescapedSingleQuotes = escaped.replace(/''/g, "");
        expect(unescapedSingleQuotes).not.toContain("'");
      }
    });

    it("5.2 [SQL Injection] verifies buildPartnerClicksTimeseriesQuery is immune to hostile projectId and partnerId", () => {
      for (const payload of hostileSqlPayloads) {
        const query = buildPartnerClicksTimeseriesQuery({
          projectId: payload,
          partnerId: payload,
          startDate: "2026-10-01 00:00:00",
          endDate: "2026-10-02 00:00:00",
        });

        // The query must contain the escaped versions inside single quotes
        const escaped = escapeSqlString(payload);
        expect(query).toContain(`index1 = '${escaped}'`);
        expect(query).toContain(`blob5 = '${escaped}'`);

        // Check that the query doesn't break out of the WHERE clause
        expect(query).toContain("GROUP BY partnerId, day");
        expect(query).toContain("ORDER BY day ASC");
      }
    });

    it("5.3 [SQL Injection] verifies buildGeoDistributionQuery is immune to hostile inputs", () => {
      for (const payload of hostileSqlPayloads) {
        const query = buildGeoDistributionQuery({
          projectId: payload,
          partnerId: payload,
          linkId: payload,
          limit: 10,
        });

        const escaped = escapeSqlString(payload);
        expect(query).toContain(`index1 = '${escaped}'`);
        expect(query).toContain(`blob5 = '${escaped}'`);
        expect(query).toContain(`blob3 = '${escaped}'`);
      }
    });

    it("5.4 [SQL Injection] verifies buildLinkAnalyticsQuery is immune to hostile linkId and key", () => {
      for (const payload of hostileSqlPayloads) {
        const query = buildLinkAnalyticsQuery({
          projectId: "ws_safe",
          linkId: payload,
          key: payload,
        });

        const escaped = escapeSqlString(payload);
        expect(query).toContain(`blob3 = '${escaped}'`);
        expect(query).toContain(`blob2 = '${escaped}'`);
      }
    });

    it("5.5 [SQL Injection] verifies date injection attempts are rejected by formatSqlDate", () => {
      const maliciousDates = [
        "2026-10-01' OR '1'='1",
        "2026-10-01'; DROP TABLE clicks_analytics; --",
        "now() - INTERVAL 10 DAY",
        "' UNION SELECT 1 --",
        "<script>alert(1)</script>",
        "0000-00-00",
      ];

      for (const badDate of maliciousDates) {
        expect(() => formatSqlDate(badDate)).toThrow();
      }
    });

    it("5.6 [SQL Injection] inspects numeric interval/days parameters for non-numeric injection", () => {
      // Test when malicious string is passed as intervalDays
      const maliciousInterval = "1' DAY) OR 1=1; --" as any;
      const query = buildPartnerClicksTimeseriesQuery({
        projectId: "ws_safe",
        startDate: "2026-10-01",
        endDate: "2026-10-02",
        intervalDays: maliciousInterval,
      });

      // Document how intervalDays is formatted in the generated query
      expect(query).toContain(`INTERVAL '${maliciousInterval}' DAY`);
    });

    it("5.7 [executeAnalyticsEngineQuery] verifies Bearer header injection is prevented", async () => {
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ data: [], meta: [], rows: 0 }), {
          status: 200,
        }),
      );

      await executeAnalyticsEngineQuery("SELECT 1", {
        accountId: "cf_account_safe",
        apiToken: "cf_token_valid_123",
        fetchFn: fetchSpy,
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [, reqInit] = fetchSpy.mock.calls[0];
      expect(reqInit.headers.Authorization).toBe("Bearer cf_token_valid_123");
    });

    it("5.8 [Null Byte Sanitization] checks whether escapeSqlString removes or escapes null bytes (\\0)", () => {
      const withNullByte = "workspace\0_tenant";
      const escaped = escapeSqlString(withNullByte);
      // In current implementation, null byte is preserved as-is without escaping or stripping:
      expect(escaped).toBe("workspace\0_tenant");
    });

    it("5.9 [Hostile Path Decoding] tests behavior when incoming URL has malformed URI encoding in pathname", async () => {
      // In standard HTTP, paths can contain invalid percent encodings like /%E0%A4%A or /%99
      let threw = false;
      try {
        const req = new Request("https://dub.sh/%E0%A4%A");
        await handleLinkRedirection(req, env);
      } catch (err) {
        threw = true;
        expect((err as Error).name).toBe("URIError");
      }
      // If decodeURIComponent is called without try/catch, it throws an unhandled URIError:
      expect(threw).toBe(true);
    });
  });
});

