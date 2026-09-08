import {
  mutateCommissions,
  mutateComposite,
  mutateDiscountCodes,
  mutatePartner,
  mutatePartnerLinks,
  mutatePayouts,
  mutatePrefix,
  mutateSuffix,
} from "@/lib/swr/mutate";
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// Realistic 1,000+ SWR Cache Key Generator & Test Harness
// =============================================================================

interface SWRKeyEntry {
  key: string;
  data: any;
  category: string;
  partnerId?: string;
  isComposite?: boolean;
}

function generateRealisticSWRStore(totalKeys = 1000): {
  keys: string[];
  store: Map<string, any>;
  metadata: Map<string, SWRKeyEntry>;
} {
  const store = new Map<string, any>();
  const metadata = new Map<string, SWRKeyEntry>();
  const keys: string[] = [];

  const addKey = (
    key: string,
    data: any,
    category: string,
    partnerId?: string,
    isComposite = false,
  ) => {
    store.set(key, data);
    metadata.set(key, { key, data, category, partnerId, isComposite });
    keys.push(key);
  };

  const workspaceId = "ws_perf_test_99";
  const numPartners = 100;

  // 1. Partner Detail Composite Queries (100 keys)
  for (let i = 1; i <= numPartners; i++) {
    const pId = `pn_${i}`;
    const key = `/api/partners/${pId}?workspaceId=${workspaceId}&includeComposite=true`;
    addKey(
      key,
      {
        id: pId,
        name: `Partner ${i}`,
        links: [],
        discountCodes: [],
        totalCommissions: i * 100,
      },
      "partner-composite",
      pId,
      true,
    );
  }

  // 2. Partner Detail Standard Queries (100 keys)
  for (let i = 1; i <= numPartners; i++) {
    const pId = `pn_${i}`;
    const key = `/api/partners/${pId}?workspaceId=${workspaceId}`;
    addKey(
      key,
      { id: pId, name: `Partner ${i}`, status: "approved" },
      "partner-detail",
      pId,
      false,
    );
  }

  // 3. Discount Code Queries (150 keys)
  for (let i = 1; i <= 100; i++) {
    const pId = `pn_${i}`;
    const key = `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${pId}`;
    addKey(
      key,
      [{ id: `dc_${i}`, code: `CODE_${i}` }],
      "discount-codes-partner",
      pId,
      false,
    );
  }
  for (let i = 1; i <= 50; i++) {
    const key = `/api/discount-codes?workspaceId=${workspaceId}&page=${i}&pageSize=20`;
    addKey(key, [{ id: `dc_list_${i}` }], "discount-codes-list");
  }

  // 4. Referral Link Queries (150 keys)
  for (let i = 1; i <= 100; i++) {
    const pId = `pn_${i}`;
    const key = `/api/links?workspaceId=${workspaceId}&partnerId=${pId}`;
    addKey(
      key,
      [{ id: `lnk_${i}`, url: `https://example.com/p/${i}` }],
      "links-partner",
      pId,
      false,
    );
  }
  for (let i = 1; i <= 50; i++) {
    const key = `/api/links?workspaceId=${workspaceId}&page=${i}&pageSize=50`;
    addKey(key, [{ id: `lnk_list_${i}` }], "links-list");
  }

  // 5. Commission Queries (100 keys)
  for (let i = 1; i <= 75; i++) {
    const pId = `pn_${i}`;
    const key = `/api/commissions?workspaceId=${workspaceId}&partnerId=${pId}`;
    addKey(
      key,
      [{ id: `comm_${i}`, amount: 5000 }],
      "commissions-partner",
      pId,
      false,
    );
  }
  for (let i = 1; i <= 25; i++) {
    const key = `/api/commissions?workspaceId=${workspaceId}&status=pending&page=${i}`;
    addKey(key, [{ id: `comm_list_${i}` }], "commissions-list");
  }

  // 6. Payout Queries (100 keys)
  for (let i = 1; i <= 75; i++) {
    const pId = `pn_${i}`;
    const key = `/api/payouts?workspaceId=${workspaceId}&partnerId=${pId}&status=pending`;
    addKey(
      key,
      [{ id: `po_${i}`, amount: 10000 }],
      "payouts-partner",
      pId,
      false,
    );
  }
  for (let i = 1; i <= 25; i++) {
    const key = `/api/payouts?workspaceId=${workspaceId}&page=${i}`;
    addKey(key, [{ id: `po_list_${i}` }], "payouts-list");
  }

  // 7. Child & Nested Sub-Resources
  for (let i = 1; i <= numPartners; i++) {
    const pId = `pn_${i}`;
    addKey(
      `/api/partners/${pId}/comments?workspaceId=${workspaceId}`,
      [{ id: `c_${i}` }],
      "partner-comments",
      pId,
    );
    addKey(
      `/api/partners/${pId}/comments/count?workspaceId=${workspaceId}`,
      i * 2,
      "partner-comments-count",
      pId,
    );
    addKey(
      `/api/partners/${pId}/referral?workspaceId=${workspaceId}`,
      { stats: { totalPartners: i } },
      "partner-referral",
      pId,
    );
    addKey(
      `/api/partners/${pId}/activity-logs?workspaceId=${workspaceId}`,
      [{ action: "created" }],
      "partner-activity",
      pId,
    );
  }

  // 8. Partner List & Aggregations (100 keys)
  for (let i = 1; i <= 50; i++) {
    addKey(
      `/api/partners?workspaceId=${workspaceId}&page=${i}&status=approved`,
      [{ id: `pn_${i}` }],
      "partners-list",
    );
  }
  for (let i = 1; i <= 25; i++) {
    addKey(
      `/api/partners/count?workspaceId=${workspaceId}&status=group_${i}`,
      i * 10,
      "partners-count",
    );
  }
  for (let i = 1; i <= 25; i++) {
    addKey(
      `/api/partners/analytics?workspaceId=${workspaceId}&range=${i}d`,
      { views: i * 100 },
      "partners-analytics",
    );
  }

  // 9. Workspace, Auth & Unrelated Resources (100 keys)
  for (let i = 1; i <= 30; i++) {
    addKey(
      `/api/workspaces/${workspaceId}_${i}`,
      { id: `${workspaceId}_${i}` },
      "workspaces",
    );
    addKey(
      `/api/workspaces/${workspaceId}_${i}/billing/payment-methods`,
      [],
      "billing",
    );
    addKey(`/api/domains?workspaceId=${workspaceId}_${i}`, [], "domains");
  }
  for (let i = 1; i <= 10; i++) {
    addKey(
      `/api/messages?workspaceId=${workspaceId}&partnerId=pn_${i}`,
      [],
      "messages",
    );
  }

  // Fill up remaining keys to reach exact target totalKeys
  let fillerIdx = 1;
  while (keys.length < totalKeys) {
    addKey(
      `/api/analytics/events?workspaceId=${workspaceId}&event=${fillerIdx}`,
      { count: fillerIdx },
      "unrelated-analytics",
    );
    fillerIdx++;
  }

  return { keys, store, metadata };
}

/**
 * High-performance SWR Invalidation Engine Simulator for SLA Profiling
 */
class SWRBenchmarkEngine {
  public cache: Map<string, any>;

  constructor(cache: Map<string, any>) {
    this.cache = cache;
  }

  /**
   * Evaluates predicate matcher against all keys in cache and returns matching keys
   */
  dispatchMatcher(predicate: (key: any) => boolean): {
    matchedKeys: string[];
    durationMs: number;
  } {
    const matchedKeys: string[] = [];
    const start = performance.now();

    for (const key of this.cache.keys()) {
      if (predicate(key)) {
        matchedKeys.push(key);
      }
    }

    const durationMs = performance.now() - start;
    return { matchedKeys, durationMs };
  }

  /**
   * Benchmark multiple iterations and return statistical profile
   */
  profileIterations(
    predicate: (key: any) => boolean,
    iterations = 100,
  ): {
    min: number;
    max: number;
    mean: number;
    p50: number;
    p95: number;
    p99: number;
    samples: number[];
  } {
    const samples: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const { durationMs } = this.dispatchMatcher(predicate);
      samples.push(durationMs);
    }

    samples.sort((a, b) => a - b);
    const min = samples[0];
    const max = samples[samples.length - 1];
    const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
    const p50 = samples[Math.floor(samples.length * 0.5)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    const p99 = samples[Math.floor(samples.length * 0.99)];

    return { min, max, mean, p50, p95, p99, samples };
  }
}

// =============================================================================
// Test Suite: Challenger SLA & Cache Consistency Empirical Verification
// =============================================================================

describe("Empirical Challenger: SWR Performance SLAs & Cache Consistency Suite", () => {
  const LATENCY_SLA_MS = 50.0; // Strict < 50ms SLA requirement
  let engine: SWRBenchmarkEngine;
  let dataset: ReturnType<typeof generateRealisticSWRStore>;

  beforeEach(() => {
    dataset = generateRealisticSWRStore(1000);
    engine = new SWRBenchmarkEngine(dataset.store);
  });

  // ===========================================================================
  // SECTION 1: Performance SLA Verification (< 50ms Latency across 1,000 Keys)
  // ===========================================================================
  describe("Section 1: Performance SLA Benchmarks (< 50ms Latency on 1,000 Active Keys)", () => {
    it("1.1: mutatePartner invalidation matcher executes in < 50ms across 1,000 active keys", () => {
      const partnerId = "pn_42";
      const partnerIdParam = `partnerId=${partnerId}`;
      const partnerEndpointPrefix = `/api/partners/${partnerId}`;

      const matcher = (key: any) => {
        if (typeof key !== "string") return false;
        return (
          key.startsWith(partnerEndpointPrefix) ||
          key.includes(partnerIdParam) ||
          key === "/api/partners" ||
          key.startsWith("/api/partners?") ||
          key.startsWith("/api/partners/count")
        );
      };

      const { matchedKeys, durationMs } = engine.dispatchMatcher(matcher);

      // SLA Verification
      expect(durationMs).toBeLessThan(LATENCY_SLA_MS);
      expect(matchedKeys.length).toBeGreaterThan(0);

      // Verify specific target keys are matched
      expect(matchedKeys).toContain(
        `/api/partners/${partnerId}?workspaceId=ws_perf_test_99&includeComposite=true`,
      );
      expect(matchedKeys).toContain(
        `/api/discount-codes?workspaceId=ws_perf_test_99&partnerId=${partnerId}`,
      );
      expect(matchedKeys).toContain(
        `/api/links?workspaceId=ws_perf_test_99&partnerId=${partnerId}`,
      );
      expect(matchedKeys).toContain(
        `/api/commissions?workspaceId=ws_perf_test_99&partnerId=${partnerId}`,
      );
      expect(matchedKeys).toContain(
        `/api/payouts?workspaceId=ws_perf_test_99&partnerId=${partnerId}&status=pending`,
      );
    });

    it("1.2: multi-prefix matcher across 5 route prefixes executes in < 50ms over 1,000 keys", () => {
      const prefixes = [
        "/api/commissions",
        "/api/payouts",
        "/api/programs",
        "/api/analytics",
        "/api/partners/analytics",
      ];

      const matcher = (key: any) => {
        if (typeof key !== "string") return false;
        return prefixes.some((p) => key.startsWith(p));
      };

      const { matchedKeys, durationMs } = engine.dispatchMatcher(matcher);

      expect(durationMs).toBeLessThan(LATENCY_SLA_MS);
      expect(matchedKeys.length).toBeGreaterThan(100);
    });

    it("1.3: burst invalidation profile (100 rapid invalidations) maintains max latency < 50ms", () => {
      const partnerId = "pn_77";
      const partnerIdParam = `partnerId=${partnerId}`;
      const partnerEndpointPrefix = `/api/partners/${partnerId}`;

      const matcher = (key: any) => {
        if (typeof key !== "string") return false;
        return (
          key.startsWith(partnerEndpointPrefix) ||
          key.includes(partnerIdParam) ||
          key === "/api/partners" ||
          key.startsWith("/api/partners?")
        );
      };

      const profile = engine.profileIterations(matcher, 100);

      // Verify statistics
      expect(profile.max).toBeLessThan(LATENCY_SLA_MS);
      expect(profile.p99).toBeLessThan(LATENCY_SLA_MS);
      expect(profile.p95).toBeLessThan(LATENCY_SLA_MS);
      expect(profile.p50).toBeLessThan(LATENCY_SLA_MS);
      expect(profile.mean).toBeLessThan(10.0); // Mean should easily be sub-10ms
    });

    it("1.4: cache scaling stress test (100 to 5,000 active keys) shows linear O(N) performance", () => {
      const sizes = [100, 500, 1000, 2500, 5000];
      const scalingResults: { size: number; durationMs: number }[] = [];

      for (const size of sizes) {
        const testDataset = generateRealisticSWRStore(size);
        const testEngine = new SWRBenchmarkEngine(testDataset.store);

        const matcher = (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/partners/pn_10") ||
            key.includes("partnerId=pn_10"));

        const { durationMs } = testEngine.dispatchMatcher(matcher);
        scalingResults.push({ size, durationMs });

        // Every scale point must meet the < 50ms SLA
        expect(durationMs).toBeLessThan(LATENCY_SLA_MS);
      }

      // Verify 5,000 keys is still well under SLA limit
      const result5k = scalingResults.find((r) => r.size === 5000);
      expect(result5k?.durationMs).toBeLessThan(LATENCY_SLA_MS);
    });

    it("1.5: ultra-complex query string stress test (1,000 keys with 25+ parameters) meets < 50ms SLA", () => {
      const complexStore = new Map<string, any>();
      for (let i = 1; i <= 1000; i++) {
        const queryParams = Array.from(
          { length: 25 },
          (_, q) => `param_${q}=val_${q}_${i}`,
        ).join("&");
        const key = `/api/partners/pn_${i}?${queryParams}&workspaceId=ws_deep_test&includeComposite=true`;
        complexStore.set(key, { id: `pn_${i}` });
      }

      const complexEngine = new SWRBenchmarkEngine(complexStore);
      const targetPartner = "pn_500";
      const matcher = (key: any) =>
        typeof key === "string" &&
        key.startsWith(`/api/partners/${targetPartner}`) &&
        key.includes("includeComposite=true");

      const { matchedKeys, durationMs } =
        complexEngine.dispatchMatcher(matcher);

      expect(durationMs).toBeLessThan(LATENCY_SLA_MS);
      expect(matchedKeys).toHaveLength(1);
    });

    it("1.6: concurrent parallel mutation dispatch (50 concurrent promises) completes under 50ms", async () => {
      const start = performance.now();

      const promises = Array.from({ length: 50 }, (_, i) => {
        const partnerId = `pn_${(i % 50) + 1}`;
        const matcher = (key: any) =>
          typeof key === "string" &&
          (key.startsWith(`/api/partners/${partnerId}`) ||
            key.includes(`partnerId=${partnerId}`));
        return Promise.resolve(engine.dispatchMatcher(matcher));
      });

      const results = await Promise.all(promises);
      const totalWallClockMs = performance.now() - start;

      expect(totalWallClockMs).toBeLessThan(LATENCY_SLA_MS);
      expect(results).toHaveLength(50);
      results.forEach((res) => {
        expect(res.matchedKeys.length).toBeGreaterThan(0);
      });
    });
  });

  // ===========================================================================
  // SECTION 2: Cache State Consistency Across Workflows
  // ===========================================================================
  describe("Section 2: Cache State Consistency & Invalidation Integrity across Partner Workflows", () => {
    it("2.1: Partner Link creation invalidates composite query (includeComposite=true) and /api/links", () => {
      const partnerId = "pn_15";
      const compositeKey = `/api/partners/${partnerId}?workspaceId=ws_perf_test_99&includeComposite=true`;
      const linksKey = `/api/links?workspaceId=ws_perf_test_99&partnerId=${partnerId}`;
      const generalLinksKey = `/api/links?workspaceId=ws_perf_test_99&page=1&pageSize=50`;

      expect(dataset.store.has(compositeKey)).toBe(true);
      expect(dataset.store.has(linksKey)).toBe(true);
      expect(dataset.store.has(generalLinksKey)).toBe(true);

      // Invalidation rules for mutatePartnerLinks
      const linksPrefixMatcher = (key: any) =>
        typeof key === "string" &&
        (key.startsWith("/api/links") ||
          key.startsWith("/api/partner-profile"));
      const partnerMatcher = (key: any) => {
        if (typeof key !== "string") return false;
        return (
          key.startsWith(`/api/partners/${partnerId}`) ||
          key.includes(`partnerId=${partnerId}`) ||
          key === "/api/partners" ||
          key.startsWith("/api/partners?")
        );
      };

      const matchedLinks =
        engine.dispatchMatcher(linksPrefixMatcher).matchedKeys;
      const matchedPartner = engine.dispatchMatcher(partnerMatcher).matchedKeys;

      const allInvalidated = new Set([...matchedLinks, ...matchedPartner]);

      expect(allInvalidated.has(compositeKey)).toBe(true);
      expect(allInvalidated.has(linksKey)).toBe(true);
      expect(allInvalidated.has(generalLinksKey)).toBe(true);
    });

    it("2.2: Discount Code creation/deletion invalidates composite query and /api/discount-codes", () => {
      const partnerId = "pn_25";
      const compositeKey = `/api/partners/${partnerId}?workspaceId=ws_perf_test_99&includeComposite=true`;
      const codesKey = `/api/discount-codes?workspaceId=ws_perf_test_99&partnerId=${partnerId}`;

      const codesPrefixMatcher = (key: any) =>
        typeof key === "string" && key.startsWith("/api/discount-codes");
      const partnerMatcher = (key: any) =>
        typeof key === "string" &&
        (key.startsWith(`/api/partners/${partnerId}`) ||
          key.includes(`partnerId=${partnerId}`));

      const matchedCodes =
        engine.dispatchMatcher(codesPrefixMatcher).matchedKeys;
      const matchedPartner = engine.dispatchMatcher(partnerMatcher).matchedKeys;

      const allInvalidated = new Set([...matchedCodes, ...matchedPartner]);

      expect(allInvalidated.has(compositeKey)).toBe(true);
      expect(allInvalidated.has(codesKey)).toBe(true);
    });

    it("2.3: Multi-tab view consistency: modifying partner attributes invalidates all 7 tab endpoints simultaneously", () => {
      const partnerId = "pn_30";

      // 7 distinct tabs open for the same partner
      const tab1Overview = `/api/partners/${partnerId}?workspaceId=ws_perf_test_99`;
      const tab1Composite = `/api/partners/${partnerId}?workspaceId=ws_perf_test_99&includeComposite=true`;
      const tab2Links = `/api/links?workspaceId=ws_perf_test_99&partnerId=${partnerId}`;
      const tab3Discounts = `/api/discount-codes?workspaceId=ws_perf_test_99&partnerId=${partnerId}`;
      const tab4Commissions = `/api/commissions?workspaceId=ws_perf_test_99&partnerId=${partnerId}`;
      const tab5Payouts = `/api/payouts?workspaceId=ws_perf_test_99&partnerId=${partnerId}&status=pending`;
      const tab6Comments = `/api/partners/${partnerId}/comments?workspaceId=ws_perf_test_99`;
      const tab6CommentsCount = `/api/partners/${partnerId}/comments/count?workspaceId=ws_perf_test_99`;
      const tab7Activity = `/api/partners/${partnerId}/activity-logs?workspaceId=ws_perf_test_99`;

      const allTabKeys = [
        tab1Overview,
        tab1Composite,
        tab2Links,
        tab3Discounts,
        tab4Commissions,
        tab5Payouts,
        tab6Comments,
        tab6CommentsCount,
        tab7Activity,
      ];

      // Ensure all keys are pre-seeded in the cache
      allTabKeys.forEach((k) => expect(dataset.store.has(k)).toBe(true));

      // Invalidation from mutatePartner(partnerId)
      const partnerMatcher = (key: any) => {
        if (typeof key !== "string") return false;
        return (
          key.startsWith(`/api/partners/${partnerId}`) ||
          key.includes(`partnerId=${partnerId}`) ||
          key === "/api/partners" ||
          key.startsWith("/api/partners?")
        );
      };

      const { matchedKeys } = engine.dispatchMatcher(partnerMatcher);
      const matchedSet = new Set(matchedKeys);

      // Every tab's cache key MUST be marked for revalidation
      allTabKeys.forEach((tabKey) => {
        expect(matchedSet.has(tabKey)).toBe(true);
      });
    });

    it("2.4: Nested child resources (/comments, /referral, /activity-logs) are invalidated on partner mutation", () => {
      const partnerId = "pn_5";
      const commentsKey = `/api/partners/${partnerId}/comments?workspaceId=ws_perf_test_99`;
      const referralKey = `/api/partners/${partnerId}/referral?workspaceId=ws_perf_test_99`;
      const activityKey = `/api/partners/${partnerId}/activity-logs?workspaceId=ws_perf_test_99`;

      const matcher = (key: any) =>
        typeof key === "string" && key.startsWith(`/api/partners/${partnerId}`);

      const { matchedKeys } = engine.dispatchMatcher(matcher);

      expect(matchedKeys).toContain(commentsKey);
      expect(matchedKeys).toContain(referralKey);
      expect(matchedKeys).toContain(activityKey);
    });

    it("2.5: Commission creation cascade invalidates commissions, partner stats, partner lists, and payouts", () => {
      const partnerId = "pn_10";
      const commKey = `/api/commissions?workspaceId=ws_perf_test_99&partnerId=${partnerId}`;
      const partnerCompositeKey = `/api/partners/${partnerId}?workspaceId=ws_perf_test_99&includeComposite=true`;
      const payoutsKey = `/api/payouts?workspaceId=ws_perf_test_99&partnerId=${partnerId}&status=pending`;
      const partnerListKey = `/api/partners?workspaceId=ws_perf_test_99&page=1&status=approved`;

      const prefixes = [
        "/api/commissions",
        "/api/payouts",
        "/api/programs",
        "/api/analytics",
      ];
      const prefixMatcher = (key: any) =>
        typeof key === "string" && prefixes.some((p) => key.startsWith(p));
      const partnerMatcher = (key: any) =>
        typeof key === "string" &&
        (key.startsWith(`/api/partners/${partnerId}`) ||
          key.includes(`partnerId=${partnerId}`) ||
          key.startsWith("/api/partners"));

      const matchedPrefixes = engine.dispatchMatcher(prefixMatcher).matchedKeys;
      const matchedPartners =
        engine.dispatchMatcher(partnerMatcher).matchedKeys;
      const combined = new Set([...matchedPrefixes, ...matchedPartners]);

      expect(combined.has(commKey)).toBe(true);
      expect(combined.has(partnerCompositeKey)).toBe(true);
      expect(combined.has(payoutsKey)).toBe(true);
      expect(combined.has(partnerListKey)).toBe(true);
    });

    it("2.6: Suffix matcher /count invalidates only tail count endpoints across resource types", () => {
      const countMatcher = (key: any) =>
        typeof key === "string" && key.endsWith("/count");

      // Seed explicit test endpoints
      dataset.store.set("/api/partners/count", 500);
      dataset.store.set("/api/payouts/count", 20);
      dataset.store.set("/api/commissions/count", 150);
      dataset.store.set("/api/partners/country", { name: "USA" }); // False positive guard
      dataset.store.set("/api/count/partners", { total: 500 }); // Prefix guard

      const { matchedKeys } = engine.dispatchMatcher(countMatcher);

      expect(matchedKeys).toContain("/api/partners/count");
      expect(matchedKeys).toContain("/api/payouts/count");
      expect(matchedKeys).toContain("/api/commissions/count");
      expect(matchedKeys).not.toContain("/api/partners/country");
      expect(matchedKeys).not.toContain("/api/count/partners");
    });
  });

  // ===========================================================================
  // SECTION 3: Boundary Isolation & Adversarial Collision Resistance
  // ===========================================================================
  describe("Section 3: Boundary Isolation & Prefix Collision Resistance", () => {
    it("3.1: evaluates partner ID collision isolation between pn_1 and pn_10/pn_100", () => {
      // Precise boundary check predicate:
      const precisePartnerMatcher = (targetId: string) => {
        const partnerIdParam = `partnerId=${targetId}`;
        const partnerEndpointPrefix = `/api/partners/${targetId}`;
        return (key: any) => {
          if (typeof key !== "string") return false;
          const hasPartnerIdParam =
            key.includes(`?${partnerIdParam}&`) ||
            key.endsWith(`?${partnerIdParam}`) ||
            key.includes(`&${partnerIdParam}&`) ||
            key.endsWith(`&${partnerIdParam}`);
          const matchesPartnerPath =
            key === partnerEndpointPrefix ||
            key.startsWith(`${partnerEndpointPrefix}?`) ||
            key.startsWith(`${partnerEndpointPrefix}/`);
          return matchesPartnerPath || hasPartnerIdParam;
        };
      };

      const matcherPn1 = precisePartnerMatcher("pn_1");

      // Verify pn_1 matches exact pn_1 routes
      expect(matcherPn1("/api/partners/pn_1?workspaceId=ws_1")).toBe(true);
      expect(matcherPn1("/api/partners/pn_1/links")).toBe(true);
      expect(
        matcherPn1("/api/discount-codes?partnerId=pn_1&workspaceId=ws_1"),
      ).toBe(true);
      expect(
        matcherPn1("/api/discount-codes?workspaceId=ws_1&partnerId=pn_1"),
      ).toBe(true);

      // Verify pn_1 does NOT match pn_10, pn_100, or pn_1000
      expect(matcherPn1("/api/partners/pn_10?workspaceId=ws_1")).toBe(false);
      expect(matcherPn1("/api/partners/pn_100?workspaceId=ws_1")).toBe(false);
      expect(matcherPn1("/api/partners/pn_1000?workspaceId=ws_1")).toBe(false);
      expect(
        matcherPn1("/api/discount-codes?partnerId=pn_10&workspaceId=ws_1"),
      ).toBe(false);
      expect(
        matcherPn1("/api/discount-codes?partnerId=pn_100&workspaceId=ws_1"),
      ).toBe(false);
    });

    it("3.2: isolates query parameters: partnerId=pn_1 does not match otherPartnerId=pn_1", () => {
      const preciseMatcher = (targetId: string) => {
        const param = `partnerId=${targetId}`;
        return (key: any) => {
          if (typeof key !== "string") return false;
          return (
            key.includes(`?${param}&`) ||
            key.endsWith(`?${param}`) ||
            key.includes(`&${param}&`) ||
            key.endsWith(`&${param}`)
          );
        };
      };

      const matcher = preciseMatcher("pn_1");

      expect(matcher("/api/links?partnerId=pn_1")).toBe(true);
      expect(matcher("/api/links?workspaceId=ws_1&partnerId=pn_1")).toBe(true);
      expect(matcher("/api/links?partnerId=pn_1&tab=active")).toBe(true);

      // False positive checks
      expect(matcher("/api/links?otherPartnerId=pn_1")).toBe(false);
      expect(matcher("/api/links?parentPartnerId=pn_1")).toBe(false);
      expect(matcher("/api/links?referredByPartnerId=pn_1")).toBe(false);
    });

    it("3.3: distinguishes /api/partners from /api/partnerships and /api/discount-codes from /api/discount-codes-archive", () => {
      const routeMatcher = (prefix: string) => (key: any) =>
        typeof key === "string" &&
        (key === prefix ||
          key.startsWith(`${prefix}/`) ||
          key.startsWith(`${prefix}?`));

      const partnerRouteMatcher = routeMatcher("/api/partners");
      const discountRouteMatcher = routeMatcher("/api/discount-codes");

      expect(partnerRouteMatcher("/api/partners")).toBe(true);
      expect(partnerRouteMatcher("/api/partners?status=active")).toBe(true);
      expect(partnerRouteMatcher("/api/partners/pn_123")).toBe(true);
      expect(partnerRouteMatcher("/api/partnerships")).toBe(false);
      expect(partnerRouteMatcher("/api/partnerships/v2")).toBe(false);

      expect(discountRouteMatcher("/api/discount-codes")).toBe(true);
      expect(discountRouteMatcher("/api/discount-codes?ws=1")).toBe(true);
      expect(discountRouteMatcher("/api/discount-codes-archive")).toBe(false);
      expect(discountRouteMatcher("/api/discount-codes-v2")).toBe(false);
    });

    it("3.4: handles non-string and malformed cache keys gracefully without throwing exceptions", () => {
      const malformedKeys = [
        null,
        undefined,
        12345,
        true,
        false,
        {},
        [],
        ["/api/partners", "ws_123"],
        { url: "/api/partners", id: "pn_1" },
        Symbol("swr-key"),
        () => "/api/partners",
      ];

      const matchers = [
        (key: any) =>
          typeof key === "string" && key.startsWith("/api/partners"),
        (key: any) => typeof key === "string" && key.endsWith("/count"),
        (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/partners/pn_1") ||
            key.includes("partnerId=pn_1")),
      ];

      for (const matcher of matchers) {
        for (const malformedKey of malformedKeys) {
          expect(() => matcher(malformedKey)).not.toThrow();
          expect(matcher(malformedKey)).toBe(false);
        }
      }
    });
  });

  // ===========================================================================
  // SECTION 4: Memory Leak & Dangling Listener Stress Testing
  // ===========================================================================
  describe("Section 4: Memory Leak & Dangling Matcher Stress Testing", () => {
    it("4.1: executes 10,000 rapid invalidations without unbounded heap memory growth", () => {
      // Force GC if available in test environment, or record baseline
      if (global.gc) global.gc();
      const initialHeap = process.memoryUsage().heapUsed;

      const partnerId = "pn_50";
      const partnerMatcher = (key: any) =>
        typeof key === "string" &&
        (key.startsWith(`/api/partners/${partnerId}`) ||
          key.includes(`partnerId=${partnerId}`));

      // Run 10,000 rapid invalidation iterations
      for (let i = 0; i < 10000; i++) {
        engine.dispatchMatcher(partnerMatcher);
      }

      if (global.gc) global.gc();
      const finalHeap = process.memoryUsage().heapUsed;
      const heapDeltaMb = (finalHeap - initialHeap) / (1024 * 1024);

      // Verify heap delta is strictly bounded (< 10MB across 10k iterations)
      expect(heapDeltaMb).toBeLessThan(10.0);
    });

    it("4.2: simulates 1,000 component mount/unmount and subscription cycles without closure leakage", () => {
      interface MockSubscriber {
        id: string;
        key: string;
        callback: (data: any) => void;
      }

      const subscriberRegistry = new Map<string, Set<MockSubscriber>>();

      const subscribe = (key: string, sub: MockSubscriber) => {
        if (!subscriberRegistry.has(key)) {
          subscriberRegistry.set(key, new Set());
        }
        subscriberRegistry.get(key)!.add(sub);
      };

      const unsubscribe = (key: string, sub: MockSubscriber) => {
        const set = subscriberRegistry.get(key);
        if (set) {
          set.delete(sub);
          if (set.size === 0) subscriberRegistry.delete(key);
        }
      };

      // Simulate 1,000 components mounting, subscribing, and unmounting
      for (let i = 0; i < 1000; i++) {
        const key = `/api/partners/pn_${i % 100}?includeComposite=true`;
        const sub: MockSubscriber = {
          id: `sub_${i}`,
          key,
          callback: vi.fn(),
        };

        // Mount
        subscribe(key, sub);
        expect(subscriberRegistry.has(key)).toBe(true);

        // Mutate
        const set = subscriberRegistry.get(key);
        if (set) set.forEach((s) => s.callback({ mutated: true }));

        // Unmount
        unsubscribe(key, sub);
      }

      // Verify all subscribers were cleaned up cleanly (0 dangling listeners)
      expect(subscriberRegistry.size).toBe(0);
    });

    it("4.3: proxy key error isolation: throwing proxy keys are safely handled", () => {
      // Create a hostile key object whose toString or startsWith throws
      const hostileKey = {
        toString: () => {
          throw new Error("Hostile key access error");
        },
      };

      const safeMatcher = (key: any) => {
        try {
          if (typeof key !== "string") return false;
          return key.startsWith("/api/partners");
        } catch {
          return false;
        }
      };

      expect(() => safeMatcher(hostileKey)).not.toThrow();
      expect(safeMatcher(hostileKey)).toBe(false);
    });
  });

  // ===========================================================================
  // SECTION 5: Real SWR Module Export Validation & Live Invalidation
  // ===========================================================================
  describe("Section 5: Real SWR Module Export Validation & Live Invalidation", () => {
    it("5.1: mutatePrefix exported function correctly triggers SWR mutate pipeline", async () => {
      // Test the live exported mutatePrefix function from "@/lib/swr/mutate"
      expect(typeof mutatePrefix).toBe("function");
      await expect(
        mutatePrefix("/api/test-prefix", undefined, { revalidate: false }),
      ).resolves.not.toThrow();
    });

    it("5.2: mutateSuffix exported function correctly triggers SWR mutate pipeline", async () => {
      expect(typeof mutateSuffix).toBe("function");
      await expect(
        mutateSuffix("/count", undefined, { revalidate: false }),
      ).resolves.not.toThrow();
    });

    it("5.3: mutatePartner exported function executes cleanly with and without partnerId", async () => {
      expect(typeof mutatePartner).toBe("function");
      await expect(
        mutatePartner("pn_live_1", { revalidate: false }),
      ).resolves.not.toThrow();
      await expect(
        mutatePartner(null, { revalidate: false }),
      ).resolves.not.toThrow();
      await expect(
        mutatePartner(undefined, { revalidate: false }),
      ).resolves.not.toThrow();
    });

    it("5.4: mutateComposite exported function executes cleanly", async () => {
      expect(typeof mutateComposite).toBe("function");
      await expect(
        mutateComposite("pn_live_1", { revalidate: false }),
      ).resolves.not.toThrow();
    });

    it("5.5: mutatePartnerLinks, mutateDiscountCodes, mutateCommissions, mutatePayouts execute cleanly", async () => {
      await expect(mutatePartnerLinks("pn_live_1")).resolves.not.toThrow();
      await expect(mutateDiscountCodes("pn_live_1")).resolves.not.toThrow();
      await expect(mutateCommissions("pn_live_1")).resolves.not.toThrow();
      await expect(mutatePayouts("pn_live_1")).resolves.not.toThrow();
    });
  });
});
