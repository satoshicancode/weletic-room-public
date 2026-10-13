import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  buildKvKey,
  handleLinkRedirection,
  parseLinkGeo,
  type AnalyticsEngineDataPointInput,
  type AnalyticsEngineDatasetBinding,
  type LinkRecord,
  type LinkRedirectorEnv,
} from "../../workers/link-redirector/src/index";

import {
  buildGeoDistributionQuery,
  buildLinkAnalyticsQuery,
  buildPartnerClicksTimeseriesQuery,
  executeAnalyticsEngineQuery,
  formatSqlDate,
} from "../../lib/analytics/analytics-engine";

class MockKVNamespace {
  public store = new Map<string, { value: string; options?: any }>();
  public getCalls = 0;
  public putCalls = 0;

  async get(key: string, type?: string) {
    this.getCalls++;
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
    this.putCalls++;
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
  public throwOnError = false;

  prepare(query: string) {
    return new MockD1PreparedStatement(query, this);
  }

  executeFirst<T>(_query: string, params: any[]): T | null {
    this.queryCount++;
    if (this.throwOnError) {
      throw new Error("D1 internal connection failure");
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
    if (this.throwOnError) {
      throw new Error("D1 internal connection failure");
    }
    return this.rows as T[];
  }
}

class MockAnalyticsEngine implements AnalyticsEngineDatasetBinding {
  public datapoints: AnalyticsEngineDataPointInput[] = [];
  public throwOnWrite = false;

  writeDataPoint(dp: AnalyticsEngineDataPointInput) {
    if (this.throwOnWrite) {
      throw new Error("Analytics Engine quota exceeded");
    }
    this.datapoints.push(dp);
  }
}

describe("Milestone 4 (R4) Adversarial & Stress Challenge Suite", () => {
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

  describe("A. Edge Redirection Worker Boundary & Attack Scenarios", () => {
    it("A.1 handles domain with ports and query params correctly", async () => {
      const link: LinkRecord = {
        id: "link_port_test",
        projectId: "ws_test",
        url: "https://yamax.co/target",
        disabledAt: null,
      };

      await mockKV.put(
        buildKvKey("shop.yamax.co", "item"),
        JSON.stringify(link),
      );

      const req = new Request("http://shop.yamax.co:8787/item");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("https://yamax.co/target");
    });

    it("A.7 demonstrates trailing slash behavior in path", async () => {
      const link: LinkRecord = {
        id: "link_slash_test",
        projectId: "ws_test",
        url: "https://yamax.co/target",
        disabledAt: null,
      };

      await mockKV.put(
        buildKvKey("shop.yamax.co", "item"),
        JSON.stringify(link),
      );

      // Trailing slash currently results in key 'item/' which returns 404
      const req = new Request("http://shop.yamax.co/item/");
      const res = await handleLinkRedirection(req, env);
      expect(res.status).toBe(404);
    });

    it("A.2 survives Analytics Engine writeDataPoint exception without blocking redirection", async () => {
      const link: LinkRecord = {
        id: "link_quota_test",
        projectId: "ws_test",
        url: "https://yamax.co/sale",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "sale"), JSON.stringify(link));
      mockAnalytics.throwOnWrite = true; // Simulate AE crash/quota exhaustion

      const req = new Request("https://dub.sh/sale");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("https://yamax.co/sale");
    });

    it("A.3 generates unique clickId across rapid consecutive redirects", async () => {
      const link: LinkRecord = {
        id: "link_unique_test",
        projectId: "ws_test",
        url: "https://yamax.co/products",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "rapid"), JSON.stringify(link));

      const clickIds = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const req = new Request("https://dub.sh/rapid");
        const res = await handleLinkRedirection(req, env);
        const loc = new URL(res.headers.get("Location")!);
        const clickId = loc.searchParams.get("clickId")!;
        expect(clickId).toBeDefined();
        clickIds.add(clickId);
      }

      expect(clickIds.size).toBe(20); // 100% uniqueness
    });

    it("A.4 prevents attribution spoofing by overriding via with shortlink slug", async () => {
      const link: LinkRecord = {
        id: "link_spoof_test",
        projectId: "ws_test",
        url: "https://yamax.co/catalog",
        disabledAt: null,
      };

      await mockKV.put(
        buildKvKey("dub.sh", "legit-partner"),
        JSON.stringify(link),
      );

      // Attacker attempts to pass via=attacker to steal attribution
      const req = new Request(
        "https://dub.sh/legit-partner?via=attacker_hijack",
      );
      const res = await handleLinkRedirection(req, env);

      const loc = new URL(res.headers.get("Location")!);
      expect(loc.searchParams.get("via")).toBe("legit-partner"); // Must be overwritten
    });

    it("A.5 respects explicit client currency override over geo default", async () => {
      const link: LinkRecord = {
        id: "link_curr_override",
        projectId: "ws_test",
        url: "https://yamax.co/collections/all",
        disabledAt: null,
      };

      await mockKV.put(buildKvKey("dub.sh", "curr"), JSON.stringify(link));

      const req = new Request("https://dub.sh/curr?currency=EUR");
      (req as any).cf = { country: "JP" };

      const res = await handleLinkRedirection(req, env);
      const loc = new URL(res.headers.get("Location")!);

      // Path is localized to /ja, but explicit client query currency=EUR takes precedence
      expect(loc.pathname).toBe("/ja/collections/all");
      expect(loc.searchParams.get("currency")).toBe("EUR");
    });

    it("A.6 parses malformed geo JSON gracefully without crashing", () => {
      expect(parseLinkGeo("{not valid json}")).toBeNull();
      expect(parseLinkGeo(undefined)).toBeNull();
      expect(parseLinkGeo(12345 as any)).toBeNull();
      expect(parseLinkGeo([1, 2, 3] as any)).toEqual({});
    });
  });

  describe("B. Analytics Engine SQL Injection & Stress Testing", () => {
    it("B.1 escapes complex SQL injection vectors in all query builders", () => {
      const maliciousPartner =
        "p' UNION SELECT * FROM secret_table WHERE '1'='1";
      const maliciousProject = "proj\\'; DROP TABLE links; --";

      const timeseriesQuery = buildPartnerClicksTimeseriesQuery({
        projectId: maliciousProject,
        partnerId: maliciousPartner,
        startDate: "2026-10-01",
        endDate: "2026-10-02",
      });

      expect(timeseriesQuery).toContain(
        "index1 = 'proj\\\\''; DROP TABLE links; --'",
      );
      expect(timeseriesQuery).toContain(
        "blob5 = 'p'' UNION SELECT * FROM secret_table WHERE ''1''=''1'",
      );

      const geoQuery = buildGeoDistributionQuery({
        projectId: maliciousProject,
        linkId: "link' OR 1=1 --",
      });
      expect(geoQuery).toContain("blob3 = 'link'' OR 1=1 --'");

      const linkQuery = buildLinkAnalyticsQuery({
        projectId: maliciousProject,
        key: "key'--",
      });
      expect(linkQuery).toContain("blob2 = 'key''--'");
    });

    it("B.2 strictly rejects invalid dates in formatSqlDate", () => {
      expect(() => formatSqlDate("not-a-date")).toThrow(
        "Invalid date provided",
      );
      expect(() => formatSqlDate(NaN)).toThrow("Invalid date provided");
    });

    it("B.3 correctly formats leap year and boundary dates", () => {
      const leapDate = new Date("2028-02-29T12:34:56.000Z");
      expect(formatSqlDate(leapDate)).toBe("2028-02-29 12:34:56");

      const yearEnd = new Date("2026-12-31T23:59:59.000Z");
      expect(formatSqlDate(yearEnd)).toBe("2026-12-31 23:59:59");
    });

    it("B.4 validates Analytics Engine query error responses", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        json: async () => ({
          errors: [{ message: "Unauthorized account access" }],
        }),
      });

      await expect(
        executeAnalyticsEngineQuery("SELECT 1", {
          accountId: "acc_test",
          apiToken: "tok_test",
          fetchFn: mockFetch as any,
        }),
      ).rejects.toThrow("Analytics Engine SQL query failed with status 403");
    });
  });

  describe("C. Invariant 2 (Soft-Delete) & Invariant 4 (Zero Hardcoding) Verification", () => {
    it("C.1 soft-deleted link with future expiresAt still strictly returns 404", async () => {
      const disabledLink: LinkRecord = {
        id: "link_future_disabled",
        projectId: "ws_test",
        url: "https://yamax.co/future",
        disabledAt: "2026-10-08T10:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };

      await mockKV.put(
        buildKvKey("dub.sh", "future-disabled"),
        JSON.stringify(disabledLink),
      );

      const req = new Request("https://dub.sh/future-disabled");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(404);
    });

    it("C.2 recycling slug after soft-delete resolves newly active link from D1", async () => {
      // Old record is soft-deleted
      mockD1.rows.push({
        id: "link_old",
        domain: "brand.co",
        key: "summer",
        projectId: "ws_old",
        url: "https://brand.co/old",
        disabledAt: "2026-09-01T00:00:00.000Z",
      });

      // New record re-uses key "summer"
      mockD1.rows.push({
        id: "link_new",
        domain: "brand.co",
        key: "summer",
        projectId: "ws_new",
        url: "https://brand.co/new",
        disabledAt: null,
      });

      const req = new Request("https://brand.co/summer");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("https://brand.co/new");
    });
  });
});
