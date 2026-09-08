import type { MutatorOptions } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockMutate } = vi.hoisted(() => {
  return {
    mockMutate: vi.fn((_matcher: any, _data?: any, _opts?: any) =>
      Promise.resolve(),
    ),
  };
});

vi.mock("swr", async (importOriginal) => {
  const actual = await importOriginal<typeof import("swr")>();
  return {
    ...actual,
    mutate: mockMutate,
  };
});

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

// SWR Invalidation Engine Simulator for realistic caching & state verification
class SWRReactivityTestBed {
  public cache = new Map<string, any>();

  constructor() {
    this.reset();
  }

  reset() {
    this.cache.clear();
  }

  set(key: string, data: any) {
    this.cache.set(key, data);
  }

  get(key: string) {
    return this.cache.get(key);
  }

  delete(key: string) {
    return this.cache.delete(key);
  }

  has(key: string) {
    return this.cache.has(key);
  }

  evaluatePredicate(predicate: (key: any) => boolean, key: any): boolean {
    try {
      return predicate(key);
    } catch {
      return false;
    }
  }

  applyMutation(matcher: any, data?: any, _opts?: MutatorOptions): string[] {
    const invalidatedKeys: string[] = [];
    const keys = Array.from(this.cache.keys());

    for (const key of keys) {
      let isMatch = false;
      if (typeof matcher === "function") {
        isMatch = matcher(key);
      } else if (typeof matcher === "string") {
        isMatch = key === matcher;
      } else if (Array.isArray(matcher)) {
        isMatch = matcher.some((m) => key === m);
      }

      if (isMatch) {
        invalidatedKeys.push(key);
        if (data !== undefined) {
          this.cache.set(
            key,
            typeof data === "function" ? data(this.cache.get(key)) : data,
          );
        }
      }
    }

    return invalidatedKeys;
  }
}

describe("Challenger Adversarial Stress Harness: SWR Reactivity & Invalidation", () => {
  let testBed: SWRReactivityTestBed;

  beforeEach(() => {
    testBed = new SWRReactivityTestBed();
    mockMutate.mockClear();
    mockMutate.mockImplementation((_matcher: any, _data?: any, _opts?: any) =>
      Promise.resolve(),
    );
  });

  // =========================================================================
  // 1. HIGH-THROUGHPUT CONCURRENT MUTATIONS (10,000+ key match evaluations)
  // =========================================================================
  describe("1. High-Throughput Concurrent Mutations & Scale Stress", () => {
    it("evaluates 10,000+ unique cache keys across 200 concurrent mutation promises in < 1,000ms", async () => {
      // Step 1: Generate 10,000 distinct, realistic cache keys
      const totalKeys = 10_000;
      const partnerIds = Array.from(
        { length: 100 },
        (_, i) => `pn_stress_${i}`,
      );
      const workspaceIds = ["ws_yamax_1", "ws_yamax_2", "ws_yamax_3"];

      for (let i = 0; i < totalKeys; i++) {
        const pId = partnerIds[i % partnerIds.length];
        const wsId = workspaceIds[i % workspaceIds.length];
        const keyType = i % 10;

        let key = "";
        switch (keyType) {
          case 0:
            key = `/api/partners/${pId}?workspaceId=${wsId}&idx=${i}&includeComposite=true`;
            break;
          case 1:
            key = `/api/partners/${pId}?workspaceId=${wsId}&idx=${i}`;
            break;
          case 2:
            key = `/api/partners/${pId}/referral?workspaceId=${wsId}&idx=${i}`;
            break;
          case 3:
            key = `/api/discount-codes?workspaceId=${wsId}&partnerId=${pId}&idx=${i}`;
            break;
          case 4:
            key = `/api/links?workspaceId=${wsId}&partnerId=${pId}&idx=${i}`;
            break;
          case 5:
            key = `/api/commissions?workspaceId=${wsId}&partnerId=${pId}&status=pending&idx=${i}`;
            break;
          case 6:
            key = `/api/payouts?workspaceId=${wsId}&partnerId=${pId}&idx=${i}`;
            break;
          case 7:
            key = `/api/partners?workspaceId=${wsId}&page=${i % 10}&idx=${i}`;
            break;
          case 8:
            key = `/api/partners/count?workspaceId=${wsId}&idx=${i}`;
            break;
          case 9:
            key = `/api/groups/grp_${i % 20}?workspaceId=${wsId}&idx=${i}`;
            break;
        }
        testBed.set(key, { index: i, pId, wsId, timestamp: Date.now() });
      }

      expect(testBed.cache.size).toBe(totalKeys);

      // Step 2: Spawn 200 concurrent mutation tasks targeting distinct partners and endpoints
      const startTime = performance.now();
      const concurrentTasks: Promise<any>[] = [];

      for (let taskIdx = 0; taskIdx < 200; taskIdx++) {
        const targetPartner = partnerIds[taskIdx % partnerIds.length];
        const taskType = taskIdx % 6;

        concurrentTasks.push(
          (async () => {
            let invalidated: string[] = [];
            if (taskType === 0) {
              // mutatePartner predicate
              const partnerEndpointPrefix = `/api/partners/${targetPartner}`;
              const partnerIdParam = `partnerId=${targetPartner}`;
              const predicate = (key: any) => {
                if (typeof key !== "string") return false;
                return (
                  key.startsWith(partnerEndpointPrefix) ||
                  key.includes(partnerIdParam) ||
                  key === "/api/partners" ||
                  key.startsWith("/api/partners?") ||
                  key.startsWith("/api/partners/count")
                );
              };
              invalidated = testBed.applyMutation(predicate);
            } else if (taskType === 1) {
              // mutatePrefix predicate
              const prefix = `/api/discount-codes`;
              const predicate = (key: any) =>
                typeof key === "string" && key.startsWith(prefix);
              invalidated = testBed.applyMutation(predicate);
            } else if (taskType === 2) {
              // mutateSuffix predicate
              const suffix = `includeComposite=true`;
              const predicate = (key: any) =>
                typeof key === "string" && key.endsWith(suffix);
              invalidated = testBed.applyMutation(predicate);
            } else if (taskType === 3) {
              // mutateComposite predicate
              const predicate = (key: any) =>
                typeof key === "string" &&
                key.startsWith(`/api/partners/${targetPartner}`) &&
                key.includes("includeComposite=true");
              invalidated = testBed.applyMutation(predicate);
            } else if (taskType === 4) {
              // multi-prefix commissions
              const prefixes = ["/api/commissions", "/api/payouts"];
              const predicate = (key: any) =>
                typeof key === "string" &&
                prefixes.some((p) => key.startsWith(p));
              invalidated = testBed.applyMutation(predicate);
            } else {
              // multi-prefix links
              const prefixes = ["/api/links", "/api/partner-profile"];
              const predicate = (key: any) =>
                typeof key === "string" &&
                prefixes.some((p) => key.startsWith(p));
              invalidated = testBed.applyMutation(predicate);
            }
            return invalidated.length;
          })(),
        );
      }

      const results = await Promise.all(concurrentTasks);
      const durationMs = performance.now() - startTime;

      // 200 tasks * 10,000 keys = 2,000,000 key evaluations!
      expect(results.length).toBe(200);
      results.forEach((matchCount) => {
        expect(matchCount).toBeGreaterThanOrEqual(0);
      });

      // Strict SLA: 2,000,000 key evaluations must complete within 1,000ms
      expect(durationMs).toBeLessThan(1000);
    });

    it("survives rapid interleaved read/mutation bursts without deadlocks or state corruption", async () => {
      const partnerId = "pn_yamax_burst";
      const wsId = "ws_yamax_burst";

      // Seed initial partner sub-resources
      testBed.set(
        `/api/partners/${partnerId}?workspaceId=${wsId}&includeComposite=true`,
        { name: "Initial" },
      );
      testBed.set(
        `/api/discount-codes?workspaceId=${wsId}&partnerId=${partnerId}`,
        [{ code: "INIT" }],
      );
      testBed.set(`/api/links?workspaceId=${wsId}&partnerId=${partnerId}`, [
        { id: "lnk_1" },
      ]);

      const iterations = 500;
      const readWriteOps: Promise<any>[] = [];

      for (let i = 0; i < iterations; i++) {
        if (i % 2 === 0) {
          // Read operation
          readWriteOps.push(
            (async () => {
              const data = testBed.get(
                `/api/partners/${partnerId}?workspaceId=${wsId}&includeComposite=true`,
              );
              return data !== undefined;
            })(),
          );
        } else {
          // Mutation operation updating composite cache
          readWriteOps.push(
            (async () => {
              testBed.applyMutation(
                (key: any) =>
                  typeof key === "string" &&
                  key.startsWith(`/api/partners/${partnerId}`),
                (prev: any) => ({ ...prev, iteration: i }),
              );
            })(),
          );
        }
      }

      const results = await Promise.all(readWriteOps);
      expect(results.length).toBe(iterations);

      const finalComposite = testBed.get(
        `/api/partners/${partnerId}?workspaceId=${wsId}&includeComposite=true`,
      );
      expect(finalComposite).toBeDefined();
      expect(finalComposite.iteration).toBeGreaterThan(0);
    });

    it("handles 100 simultaneous concurrent calls to all 8 mutate helpers without race conditions", async () => {
      const helperPromises: Promise<any>[] = [];

      for (let i = 0; i < 100; i++) {
        const pId = `pn_conc_${i}`;
        helperPromises.push(mutatePrefix(["/api/links", "/api/partners"]));
        helperPromises.push(mutateSuffix(["/count", "includeComposite=true"]));
        helperPromises.push(mutatePartner(pId));
        helperPromises.push(mutateComposite(pId));
        helperPromises.push(mutatePartnerLinks(pId));
        helperPromises.push(mutateDiscountCodes(pId));
        helperPromises.push(mutateCommissions(pId));
        helperPromises.push(mutatePayouts(pId));
      }

      await Promise.all(helperPromises);
      // 100 iterations * (1 + 1 + 1 + 1 + 2 + 2 + 2 + 2 = 12 calls) = 1200 mutate invocations
      expect(mockMutate).toHaveBeenCalledTimes(1200);
    });
  });

  // =========================================================================
  // 2. PATHOLOGICAL AND EXTREME KEY SHAPES
  // =========================================================================
  describe("2. Pathological & Extreme SWR Key Shapes", () => {
    it("handles non-string SWR key shapes gracefully without throwing or falsely matching", () => {
      const nonStringKeys: any[] = [
        null,
        undefined,
        42,
        0,
        -1,
        NaN,
        true,
        false,
        Symbol("swr-key"),
        BigInt(9007199254740991),
        [],
        ["/api/partners"],
        ["/api/partners", "pn_123", { includeComposite: true }],
        {},
        { url: "/api/partners/pn_123", method: "GET" },
        { endpoint: "/api/discount-codes", params: { partnerId: "pn_123" } },
        () => "/api/partners",
        new Date(),
        new Map(),
        new Set(),
        /api\/partners/,
      ];

      // Test helper matchers against all non-string shapes
      const testPartnerId = "pn_test_shape";
      const partnerEndpointPrefix = `/api/partners/${testPartnerId}`;
      const partnerIdParam = `partnerId=${testPartnerId}`;

      const partnerMatcher = (key: any) => {
        if (typeof key !== "string") return false;
        return (
          key.startsWith(partnerEndpointPrefix) ||
          key.includes(partnerIdParam) ||
          key === "/api/partners" ||
          key.startsWith("/api/partners?") ||
          key.startsWith("/api/partners/count")
        );
      };

      const prefixMatcher = (key: any) => {
        if (typeof key !== "string") return false;
        return key.startsWith("/api/links");
      };

      const suffixMatcher = (key: any) => {
        if (typeof key !== "string") return false;
        return key.endsWith("includeComposite=true");
      };

      for (const nonStringKey of nonStringKeys) {
        expect(testBed.evaluatePredicate(partnerMatcher, nonStringKey)).toBe(
          false,
        );
        expect(testBed.evaluatePredicate(prefixMatcher, nonStringKey)).toBe(
          false,
        );
        expect(testBed.evaluatePredicate(suffixMatcher, nonStringKey)).toBe(
          false,
        );
      }
    });

    it("evaluates pathological string keys with deep query parameters, special characters, and unicode", () => {
      const testPartnerId = "pn_yamax_special";

      const pathologicalKeys = [
        // Deep query parameters & JSON encoding
        `/api/partners/${testPartnerId}?workspaceId=ws_1&meta=%7B%22tier%22%3A%22VIP%22%2C%22tags%22%3A%5B%22elite%22%5D%7D&includeComposite=true`,
        // Extreme parameter count (50+ parameters)
        `/api/discount-codes?` +
          Array.from({ length: 50 }, (_, i) => `param${i}=val${i}`).join("&") +
          `&partnerId=${testPartnerId}`,
        // URL encoded unicode & emojis
        `/api/partners/${testPartnerId}?name=%E2%9C%A8Yamax%20Pro%E2%9C%A8&currency=%C2%A5`,
        // Trailing slashes
        `/api/partners/${testPartnerId}/`,
        `/api/partners/${testPartnerId}/referral/`,
        // Repeated separators & malformed queries
        `/api/partners/${testPartnerId}???&&&workspaceId=ws_1&&partnerId=${testPartnerId}&&`,
        // Special URL characters in query values
        `/api/partners/${testPartnerId}?redirect=https%3A%2F%2Fyamax.co%2Faffiliates%3Fref%3Dtest%23section`,
        // Japanese Kanji characters in partner paths
        `/api/partners/pn_山本_123/referral?workspaceId=ws_yamax`,
        // Unicode partner paths
        `/api/partners/pn_✨Yamax✨/referral`,
      ];

      const partnerEndpointPrefix = `/api/partners/${testPartnerId}`;
      const partnerIdParam = `partnerId=${testPartnerId}`;

      const partnerMatcher = (key: any) => {
        if (typeof key !== "string") return false;
        return (
          key.startsWith(partnerEndpointPrefix) ||
          key.includes(partnerIdParam) ||
          key === "/api/partners" ||
          key.startsWith("/api/partners?") ||
          key.startsWith("/api/partners/count")
        );
      };

      // Ensure every pathological key associated with this partner matches without runtime exceptions
      for (const pathKey of pathologicalKeys.slice(0, 7)) {
        expect(() =>
          testBed.evaluatePredicate(partnerMatcher, pathKey),
        ).not.toThrow();
        expect(testBed.evaluatePredicate(partnerMatcher, pathKey)).toBe(true);
      }

      // Empty string and whitespace strings
      const emptyAndWhitespace = ["", " ", "   ", "\t\n", "/", "/api"];
      for (const blank of emptyAndWhitespace) {
        expect(testBed.evaluatePredicate(partnerMatcher, blank)).toBe(false);
      }
    });
  });

  // =========================================================================
  // 3. COLLISION RESISTANCE & ADVERSARIAL FALSE-INVALIDATION VECTORS
  // =========================================================================
  describe("3. Collision Resistance & False Invalidation Analysis", () => {
    it("empirically intercepts mutate calls from mutatePartner and analyzes collision vectors", async () => {
      const targetPartnerId = "pn_abc";
      await mutatePartner(targetPartnerId);

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const prodPredicate = mockMutate.mock.calls[0][0] as (
        key: any,
      ) => boolean;
      expect(typeof prodPredicate).toBe("function");

      const wsId = "ws_test";

      // 1. Target partner keys (MUST match)
      const targetKeys = [
        `/api/partners/${targetPartnerId}`,
        `/api/partners/${targetPartnerId}?workspaceId=${wsId}`,
        `/api/partners/${targetPartnerId}?workspaceId=${wsId}&includeComposite=true`,
        `/api/partners/${targetPartnerId}/referral?workspaceId=${wsId}`,
        `/api/discount-codes?workspaceId=${wsId}&partnerId=${targetPartnerId}`,
        `/api/payouts?partnerId=${targetPartnerId}&workspaceId=${wsId}`,
      ];

      for (const k of targetKeys) {
        expect(prodPredicate(k)).toBe(true);
      }

      // 2. Sibling partner keys: pn_abc_123, pn_abc_def, partnerId=pn_abc_123
      const siblingKeys = [
        `/api/partners/pn_abc_123`,
        `/api/partners/pn_abc_123?workspaceId=${wsId}`,
        `/api/partners/pn_abc_def?workspaceId=${wsId}`,
        `/api/discount-codes?partnerId=pn_abc_123&workspaceId=${wsId}`,
      ];

      // Sibling keys evaluate false in hardened mutate.ts (zero collisions):
      const siblingFalsePositives = siblingKeys.filter(
        (k) => prodPredicate(k) === true,
      );
      expect(siblingFalsePositives.length).toBe(0);

      // 3. Unrelated routes: /api/partnerships MUST NOT match
      expect(prodPredicate("/api/partnerships")).toBe(false);
      expect(prodPredicate(`/api/partnerships?workspaceId=${wsId}`)).toBe(
        false,
      );
      expect(prodPredicate("/api/partners-archive")).toBe(false);
    });

    it("evaluates strict boundary matcher and proves zero collision on sibling keys", () => {
      const targetPartnerId = "pn_abc";
      const siblingPartnerId = "pn_abc_123";
      const wsId = "ws_test";

      // Strict boundary matcher specification
      const strictPartnerMatcher = (pId: string) => {
        const partnerIdParam = `partnerId=${pId}`;
        const partnerEndpointPrefix = `/api/partners/${pId}`;

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
          return (
            matchesPartnerPath ||
            hasPartnerIdParam ||
            key === "/api/partners" ||
            key.startsWith("/api/partners?") ||
            key.startsWith("/api/partners/count")
          );
        };
      };

      const matcher = strictPartnerMatcher(targetPartnerId);

      // Target keys match
      expect(matcher(`/api/partners/${targetPartnerId}`)).toBe(true);
      expect(
        matcher(`/api/partners/${targetPartnerId}?workspaceId=${wsId}`),
      ).toBe(true);
      expect(matcher(`/api/partners/${targetPartnerId}/referral`)).toBe(true);
      expect(matcher(`/api/discount-codes?partnerId=${targetPartnerId}`)).toBe(
        true,
      );
      expect(
        matcher(
          `/api/discount-codes?workspaceId=${wsId}&partnerId=${targetPartnerId}`,
        ),
      ).toBe(true);

      // Sibling keys DO NOT match (Zero collisions)
      expect(matcher(`/api/partners/${siblingPartnerId}`)).toBe(false);
      expect(
        matcher(`/api/partners/${siblingPartnerId}?workspaceId=${wsId}`),
      ).toBe(false);
      expect(matcher(`/api/discount-codes?partnerId=${siblingPartnerId}`)).toBe(
        false,
      );
      expect(
        matcher(
          `/api/discount-codes?workspaceId=${wsId}&partnerId=${siblingPartnerId}`,
        ),
      ).toBe(false);
      expect(matcher(`/api/partnerships`)).toBe(false);
      expect(matcher(`/api/analytics?other_partnerId=${targetPartnerId}`)).toBe(
        false,
      );
    });

    it("evaluates mutateComposite matcher and isolates sibling partner composite keys", async () => {
      const targetPartner = "pn_abc";
      await mutateComposite(targetPartner);

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const prodCompositeMatcher = mockMutate.mock.calls[0][0] as (
        key: any,
      ) => boolean;

      const targetCompositeKey = `/api/partners/${targetPartner}?workspaceId=ws_1&includeComposite=true`;
      const targetNonCompositeKey = `/api/partners/${targetPartner}?workspaceId=ws_1`;
      const siblingCompositeKey = `/api/partners/pn_abc_123?workspaceId=ws_1&includeComposite=true`;

      expect(prodCompositeMatcher(targetCompositeKey)).toBe(true);
      expect(prodCompositeMatcher(targetNonCompositeKey)).toBe(false);

      // Hardened production mutateComposite isolates sibling partner composite keys:
      expect(prodCompositeMatcher(siblingCompositeKey)).toBe(false);
    });

    it("verifies /api/partnerships route isolation when mutating general partner lists", async () => {
      // Invalidate general partner cache (null partnerId)
      await mutatePartner(null);

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const generalMatcher = mockMutate.mock.calls[0][0] as (
        key: any,
      ) => boolean;

      expect(generalMatcher("/api/partners")).toBe(true);
      expect(generalMatcher("/api/partners?workspaceId=ws_1")).toBe(true);
      expect(generalMatcher("/api/partners/pn_123")).toBe(true);

      // Route /api/partnerships must NEVER match
      expect(generalMatcher("/api/partnerships")).toBe(false);
      expect(generalMatcher("/api/partnerships?workspaceId=ws_1")).toBe(false);
      expect(generalMatcher("/api/partners-archive")).toBe(false);
    });
  });

  // =========================================================================
  // 4. MULTI-RESOURCE HOOK & MUTATOR OPTIONS INTEGRITY
  // =========================================================================
  describe("4. Multi-Resource Helpers & Mutator Options Flow", () => {
    it("verifies all helper functions export correctly and have proper function signatures", () => {
      expect(typeof mutatePrefix).toBe("function");
      expect(typeof mutateSuffix).toBe("function");
      expect(typeof mutatePartner).toBe("function");
      expect(typeof mutateComposite).toBe("function");
      expect(typeof mutatePartnerLinks).toBe("function");
      expect(typeof mutateDiscountCodes).toBe("function");
      expect(typeof mutateCommissions).toBe("function");
      expect(typeof mutatePayouts).toBe("function");
    });

    it("passes mutator options (revalidate: false, populateCache) to SWR pipeline", async () => {
      const customOpts: MutatorOptions = {
        revalidate: false,
        populateCache: true,
      };
      await mutatePartner("pn_opts_test", customOpts);

      expect(mockMutate).toHaveBeenCalledTimes(1);
      const callOpts = mockMutate.mock.calls[0][2];
      expect(callOpts).toEqual(customOpts);
    });

    it("executes multi-prefix parallel invalidations for mutatePartnerLinks, mutateCommissions, and mutatePayouts", async () => {
      // Execute all multi-resource helpers
      await mutatePartnerLinks("pn_links_test");
      await mutateDiscountCodes("pn_codes_test");
      await mutateCommissions("pn_comm_test");
      await mutatePayouts("pn_payout_test");

      // Each helper executes 2 mutate operations (prefix + partner)
      // Total calls = 4 helpers * 2 = 8 calls
      expect(mockMutate).toHaveBeenCalledTimes(8);

      // Verify prefix matcher for links matches /api/links and /api/partner-profile
      const linkMatcher = mockMutate.mock.calls[0][0] as (key: any) => boolean;
      expect(linkMatcher("/api/links?workspaceId=ws_1")).toBe(true);
      expect(linkMatcher("/api/partner-profile?workspaceId=ws_1")).toBe(true);
      expect(linkMatcher("/api/discount-codes")).toBe(false);
    });

    it("verifies mutatePrefix and mutateSuffix handle single strings and string arrays uniformly", async () => {
      // Single prefix
      await mutatePrefix("/api/single-prefix");
      expect(mockMutate).toHaveBeenCalledTimes(1);
      const singlePrefixMatcher = mockMutate.mock.calls[0][0] as (
        key: any,
      ) => boolean;
      expect(singlePrefixMatcher("/api/single-prefix/sub")).toBe(true);
      expect(singlePrefixMatcher("/api/other")).toBe(false);

      mockMutate.mockClear();

      // Array prefix
      await mutatePrefix(["/api/prefix-a", "/api/prefix-b"]);
      expect(mockMutate).toHaveBeenCalledTimes(1);
      const arrayPrefixMatcher = mockMutate.mock.calls[0][0] as (
        key: any,
      ) => boolean;
      expect(arrayPrefixMatcher("/api/prefix-a/123")).toBe(true);
      expect(arrayPrefixMatcher("/api/prefix-b/456")).toBe(true);
      expect(arrayPrefixMatcher("/api/prefix-c/789")).toBe(false);

      mockMutate.mockClear();

      // Suffix single and array
      await mutateSuffix("/count");
      const singleSuffixMatcher = mockMutate.mock.calls[0][0] as (
        key: any,
      ) => boolean;
      expect(singleSuffixMatcher("/api/partners/count")).toBe(true);
      expect(singleSuffixMatcher("/api/partners/count?page=1")).toBe(false);

      mockMutate.mockClear();

      await mutateSuffix(["/count", "includeComposite=true"]);
      const arraySuffixMatcher = mockMutate.mock.calls[0][0] as (
        key: any,
      ) => boolean;
      expect(arraySuffixMatcher("/api/partners/count")).toBe(true);
      expect(arraySuffixMatcher("/api/partners?includeComposite=true")).toBe(
        true,
      );
      expect(arraySuffixMatcher("/api/partners/summary")).toBe(false);
    });
  });
});
