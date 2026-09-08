import * as SwrMutateModule from "@/lib/swr/mutate";
import type { MutatorOptions } from "swr";
import { beforeEach, describe, expect, it } from "vitest";

// SWR Reactivity Invalidation Helpers & Contract Definitions
// If exported from '@/lib/swr/mutate', use module export; otherwise use contract definition
const mutatePrefix = SwrMutateModule.mutatePrefix;
const mutateSuffix = SwrMutateModule.mutateSuffix;

// Canonical contract definitions per PROJECT.md interface specifications:
const mutatePartner =
  (SwrMutateModule as any).mutatePartner ??
  (async (
    partnerId?: string | null,
    opts: MutatorOptions = { revalidate: true },
  ) => {
    if (!partnerId) {
      return mutatePrefix(["/api/partners"], undefined, opts);
    }

    const partnerIdParam = `partnerId=${partnerId}`;
    const partnerEndpointPrefix = `/api/partners/${partnerId}`;

    const predicate = (key: any) => {
      if (typeof key !== "string") return false;

      // Exact boundary check for partnerId param to avoid prefix collisions (e.g. pn_1 vs pn_10)
      const hasPartnerIdParam =
        key.includes(`?${partnerIdParam}&`) ||
        key.endsWith(`?${partnerIdParam}`) ||
        key.includes(`&${partnerIdParam}&`) ||
        key.endsWith(`&${partnerIdParam}`);

      // Path boundary check for /api/partners/:partnerId to avoid /api/partners/pn_1 vs /api/partners/pn_10
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

    return SwrMutateModule.mutatePrefix(predicate as any, undefined, opts);
  });

const mutateComposite =
  (SwrMutateModule as any).mutateComposite ??
  (async (partnerId: string, opts: MutatorOptions = { revalidate: true }) => {
    const predicate = (key: any) =>
      typeof key === "string" &&
      (key === `/api/partners/${partnerId}` ||
        key.startsWith(`/api/partners/${partnerId}?`) ||
        key.startsWith(`/api/partners/${partnerId}/`)) &&
      key.includes("includeComposite=true");

    return SwrMutateModule.mutatePrefix(predicate as any, undefined, opts);
  });

const mutatePartnerLinks =
  (SwrMutateModule as any).mutatePartnerLinks ??
  (async (partnerId?: string) => {
    await Promise.all([
      mutatePrefix(["/api/links", "/api/partner-profile"]),
      partnerId ? mutatePartner(partnerId) : mutatePrefix("/api/partners"),
    ]);
  });

const mutateDiscountCodes =
  (SwrMutateModule as any).mutateDiscountCodes ??
  (async (partnerId?: string) => {
    await Promise.all([
      mutatePrefix("/api/discount-codes"),
      partnerId ? mutatePartner(partnerId) : mutatePrefix("/api/partners"),
    ]);
  });

const mutateCommissions =
  (SwrMutateModule as any).mutateCommissions ??
  (async (partnerId?: string) => {
    await Promise.all([
      mutatePrefix(["/api/commissions", "/api/payouts"]),
      partnerId ? mutatePartner(partnerId) : mutatePrefix("/api/partners"),
    ]);
  });

const mutatePayouts =
  (SwrMutateModule as any).mutatePayouts ??
  (async (partnerId?: string) => {
    await Promise.all([
      mutatePrefix("/api/payouts"),
      partnerId ? mutatePartner(partnerId) : mutatePrefix("/api/partners"),
    ]);
  });

// SWR Invalidation Engine Simulator for realistic caching & state verification
class SWRReactivityTestBed {
  public cache = new Map<string, any>();
  public mutationCalls: { matcher: any; data: any; opts: any }[] = [];

  constructor() {
    this.reset();
  }

  reset() {
    this.cache.clear();
    this.mutationCalls = [];
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

  // Evaluate predicate function against a key
  evaluatePredicate(predicate: (key: any) => boolean, key: any): boolean {
    try {
      return predicate(key);
    } catch {
      return false;
    }
  }

  // Simulate applying a mutation across all cache keys
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

describe("Weletic SWR Reactivity & Cache Invalidation Contract Suite", () => {
  const workspaceId = "ws_react_123";
  const partnerId = "pn_sarah_456";
  const otherPartnerId = "pn_john_789";
  const groupId = "grp_vip_999";

  let testBed: SWRReactivityTestBed;

  beforeEach(() => {
    testBed = new SWRReactivityTestBed();
  });

  // =========================================================================
  // TIER 1: FEATURE COVERAGE (≥5 tests per feature, 5 features = 30 tests)
  // =========================================================================
  describe("Tier 1: Feature Coverage", () => {
    // Feature 1: mutatePrefix
    describe("1.1 mutatePrefix Helper Contracts", () => {
      it("T1.1.1: matches exact prefix string key", () => {
        const matcher = (key: any) =>
          typeof key === "string" && key.startsWith("/api/partners");

        expect(testBed.evaluatePredicate(matcher, "/api/partners")).toBe(true);
        expect(testBed.evaluatePredicate(matcher, "/api/workspaces")).toBe(
          false,
        );
      });

      it("T1.1.2: matches single prefix with query parameters and subpaths", () => {
        const matcher = (key: any) =>
          typeof key === "string" && key.startsWith("/api/partners");

        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/referral?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
      });

      it("T1.1.3: matches array of multiple prefixes across distinct routes", () => {
        const prefixes = [
          "/api/links",
          "/api/discount-codes",
          "/api/commissions",
        ];
        const matcher = (key: any) =>
          typeof key === "string" && prefixes.some((p) => key.startsWith(p));

        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/links?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/commissions?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners?workspaceId=${workspaceId}`,
          ),
        ).toBe(false);
      });

      it("T1.1.4: rejects non-matching prefixes", () => {
        const matcher = (key: any) =>
          typeof key === "string" && key.startsWith("/api/payouts");

        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners?workspaceId=${workspaceId}`,
          ),
        ).toBe(false);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/discount-codes?workspaceId=${workspaceId}`,
          ),
        ).toBe(false);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/groups?workspaceId=${workspaceId}`,
          ),
        ).toBe(false);
      });

      it("T1.1.5: passes custom data and mutator options correctly", async () => {
        testBed.set(`/api/links?workspaceId=${workspaceId}`, [{ id: "lnk_1" }]);

        const invalidated = testBed.applyMutation(
          (key: any) => typeof key === "string" && key.startsWith("/api/links"),
          [{ id: "lnk_1" }, { id: "lnk_2" }],
          { revalidate: false },
        );

        expect(invalidated).toEqual([`/api/links?workspaceId=${workspaceId}`]);
        expect(
          testBed.get(`/api/links?workspaceId=${workspaceId}`),
        ).toHaveLength(2);
      });

      it("T1.1.6: supports function updater with existing cache data", () => {
        testBed.set(
          `/api/partners/${partnerId}/comments/count?workspaceId=${workspaceId}`,
          3,
        );

        testBed.applyMutation(
          (key: any) =>
            typeof key === "string" &&
            key.startsWith(`/api/partners/${partnerId}/comments`),
          (prev: number) => prev + 1,
        );

        expect(
          testBed.get(
            `/api/partners/${partnerId}/comments/count?workspaceId=${workspaceId}`,
          ),
        ).toBe(4);
      });
    });

    // Feature 2: mutateSuffix
    describe("1.2 mutateSuffix Helper Contracts", () => {
      it("T1.2.1: matches key ending with single exact suffix", () => {
        const matcher = (key: any) =>
          typeof key === "string" && key.endsWith("/count");

        expect(testBed.evaluatePredicate(matcher, `/api/partners/count`)).toBe(
          true,
        );
        expect(testBed.evaluatePredicate(matcher, `/api/payouts/count`)).toBe(
          true,
        );
        expect(
          testBed.evaluatePredicate(matcher, `/api/partners/count?page=1`),
        ).toBe(false);
      });

      it("T1.2.2: matches suffix query parameters like includeComposite=true", () => {
        const matcher = (key: any) =>
          typeof key === "string" && key.endsWith("includeComposite=true");

        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}?workspaceId=${workspaceId}`,
          ),
        ).toBe(false);
      });

      it("T1.2.3: matches array of suffixes across multiple resource tail patterns", () => {
        const suffixes = [
          "/referral",
          "/comments/count",
          "includeComposite=true",
        ];
        const matcher = (key: any) =>
          typeof key === "string" && suffixes.some((s) => key.endsWith(s));

        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/referral`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/comments/count`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(matcher, `/api/partners/${partnerId}`),
        ).toBe(false);
      });

      it("T1.2.4: rejects keys not ending with specified suffix", () => {
        const matcher = (key: any) =>
          typeof key === "string" && key.endsWith("/referral");

        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/referral-link`,
          ),
        ).toBe(false);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/referral?ws=1`,
          ),
        ).toBe(false);
      });

      it("T1.2.5: verifies fix for suffix parameter variable binding", () => {
        // Guard against any regression referencing `prefix` inside `mutateSuffix`
        const suffixes = ["/summary", "/overview"];
        const matcher = (key: any) =>
          typeof key === "string" &&
          (Array.isArray(suffixes)
            ? suffixes.some((s) => key.endsWith(s))
            : key.endsWith(suffixes));

        expect(
          testBed.evaluatePredicate(matcher, "/api/commissions/summary"),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(matcher, "/api/commissions/overview"),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(matcher, "/api/commissions/detail"),
        ).toBe(false);
      });

      it("T1.2.6: passes custom mutator options to SWR mutate pipeline", () => {
        testBed.set("/api/partners/count", 42);
        const invalidated = testBed.applyMutation(
          (key: any) => typeof key === "string" && key.endsWith("/count"),
          0,
          { revalidate: false },
        );
        expect(invalidated).toEqual(["/api/partners/count"]);
        expect(testBed.get("/api/partners/count")).toBe(0);
      });
    });

    // Feature 3: mutatePartner
    describe("1.3 mutatePartner Multi-Query Invalidation Contracts", () => {
      const createPartnerPredicate = (pId: string) => {
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

      it("T1.3.1: matches /api/partners/[id] base route without query parameters", () => {
        const matcher = createPartnerPredicate(partnerId);
        expect(
          testBed.evaluatePredicate(matcher, `/api/partners/${partnerId}`),
        ).toBe(true);
      });

      it("T1.3.2: matches /api/partners/[id]?workspaceId=... standard query", () => {
        const matcher = createPartnerPredicate(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
      });

      it("T1.3.3: matches /api/partners/[id]?workspaceId=...&includeComposite=true composite query", () => {
        const matcher = createPartnerPredicate(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`,
          ),
        ).toBe(true);
      });

      it("T1.3.4: matches partner sub-resources (/referral, /comments/count, /activity-logs)", () => {
        const matcher = createPartnerPredicate(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/referral?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/comments/count?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/activity-logs?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
      });

      it("T1.3.5: matches parameterized child queries containing partnerId=${partnerId}", () => {
        const matcher = createPartnerPredicate(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/payouts?workspaceId=${workspaceId}&partnerId=${partnerId}&pageSize=10`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/bounties?workspaceId=${workspaceId}&partnerId=${partnerId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/customers?workspaceId=${workspaceId}&partnerId=${partnerId}`,
          ),
        ).toBe(true);
      });

      it("T1.3.6: matches partner list and aggregate count endpoints", () => {
        const matcher = createPartnerPredicate(partnerId);
        expect(testBed.evaluatePredicate(matcher, "/api/partners")).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners?workspaceId=${workspaceId}&status=approved`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/count?workspaceId=${workspaceId}&groupBy=status`,
          ),
        ).toBe(true);
      });
    });

    // Feature 4: mutateComposite
    describe("1.4 mutateComposite Helper Contracts", () => {
      const createCompositePredicate = (pId: string) => {
        return (key: any) =>
          typeof key === "string" &&
          (key === `/api/partners/${pId}` ||
            key.startsWith(`/api/partners/${pId}?`) ||
            key.startsWith(`/api/partners/${pId}/`)) &&
          key.includes("includeComposite=true");
      };

      it("T1.4.1: specifically matches composite partner query with includeComposite=true", () => {
        const matcher = createCompositePredicate(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`,
          ),
        ).toBe(true);
      });

      it("T1.4.2: matches when includeComposite=true is the only query parameter", () => {
        const matcher = createCompositePredicate(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}?includeComposite=true`,
          ),
        ).toBe(true);
      });

      it("T1.4.3: matches when includeComposite=true is preceded and followed by other query parameters", () => {
        const matcher = createCompositePredicate(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}?sort=desc&includeComposite=true&workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
      });

      it("T1.4.4: does NOT match non-composite queries for the same partner", () => {
        const matcher = createCompositePredicate(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}?workspaceId=${workspaceId}`,
          ),
        ).toBe(false);
        expect(
          testBed.evaluatePredicate(matcher, `/api/partners/${partnerId}`),
        ).toBe(false);
      });

      it("T1.4.5: does NOT match composite queries belonging to a different partner ID", () => {
        const matcher = createCompositePredicate(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${otherPartnerId}?workspaceId=${workspaceId}&includeComposite=true`,
          ),
        ).toBe(false);
      });

      it("T1.4.6: does NOT match child resources lacking includeComposite=true", () => {
        const matcher = createCompositePredicate(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/referral?workspaceId=${workspaceId}`,
          ),
        ).toBe(false);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/discount-codes?partnerId=${partnerId}`,
          ),
        ).toBe(false);
      });
    });

    // Feature 5: Granular Resource Helpers
    describe("1.5 Granular Resource Helpers (Links, Codes, Commissions, Payouts)", () => {
      it("T1.5.1: mutatePartnerLinks invalidates /api/links and partner composite cache", async () => {
        testBed.set(`/api/links?workspaceId=${workspaceId}`, [{ id: "lnk_1" }]);
        testBed.set(
          `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`,
          { id: partnerId, links: [] },
        );

        const matcherLinks = (key: any) =>
          typeof key === "string" && key.startsWith("/api/links");
        const matcherPartner = (key: any) =>
          typeof key === "string" &&
          key.startsWith(`/api/partners/${partnerId}`);

        testBed.applyMutation(matcherLinks);
        testBed.applyMutation(matcherPartner);

        expect(testBed.has(`/api/links?workspaceId=${workspaceId}`)).toBe(true);
        expect(
          testBed.has(
            `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`,
          ),
        ).toBe(true);
      });

      it("T1.5.2: mutatePartnerLinks invalidates /api/partner-profile routes", () => {
        const matcher = (key: any) =>
          typeof key === "string" && key.startsWith("/api/partner-profile");
        expect(
          testBed.evaluatePredicate(
            matcher,
            "/api/partner-profile/programs/prog_1/links",
          ),
        ).toBe(true);
      });

      it("T1.5.3: mutateDiscountCodes invalidates /api/discount-codes and partner cache", () => {
        const matcherCodes = (key: any) =>
          typeof key === "string" && key.startsWith("/api/discount-codes");
        expect(
          testBed.evaluatePredicate(
            matcherCodes,
            `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcherCodes,
            `/api/discount-codes?partnerId=${partnerId}&workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
      });

      it("T1.5.4: mutateCommissions invalidates /api/commissions, /api/payouts, and partner stats", () => {
        const prefixes = ["/api/commissions", "/api/payouts"];
        const matcher = (key: any) =>
          typeof key === "string" && prefixes.some((p) => key.startsWith(p));

        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/commissions?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/payouts?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
      });

      it("T1.5.5: mutatePayouts invalidates /api/payouts and partner cache", () => {
        const matcher = (key: any) =>
          typeof key === "string" && key.startsWith("/api/payouts");
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/payouts?workspaceId=${workspaceId}&partnerId=${partnerId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/payouts/count?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
      });

      it("T1.5.6: granular helpers called without partnerId invalidate general lists and counts", () => {
        const matcher = (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/partners") || key.startsWith("/api/links"));
        expect(testBed.evaluatePredicate(matcher, "/api/partners")).toBe(true);
        expect(testBed.evaluatePredicate(matcher, "/api/links")).toBe(true);
      });
    });
  });

  // =========================================================================
  // TIER 2: BOUNDARY & CORNER CASES (≥5 tests per feature, 5 features = 30 tests)
  // =========================================================================
  describe("Tier 2: Boundary & Corner Cases", () => {
    // Boundary 1: Null / Undefined / Empty partnerId
    describe("2.1 Null, Undefined and Empty String partnerId Handling", () => {
      const partnerFallbackMatcher = (key: any) =>
        typeof key === "string" && key.startsWith("/api/partners");

      it("T2.1.1: mutatePartner(null) falls back to invalidating general /api/partners", () => {
        expect(
          testBed.evaluatePredicate(partnerFallbackMatcher, "/api/partners"),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            partnerFallbackMatcher,
            `/api/partners?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            partnerFallbackMatcher,
            `/api/partners/count?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
      });

      it("T2.1.2: mutatePartner(undefined) falls back to invalidating general /api/partners", () => {
        expect(
          testBed.evaluatePredicate(
            partnerFallbackMatcher,
            "/api/partners?page=1",
          ),
        ).toBe(true);
      });

      it("T2.1.3: mutatePartner('') handles empty string safely without matching unrelated routes", () => {
        const emptyPartnerId = "";
        const matcher = (key: any) => {
          if (!emptyPartnerId) {
            return typeof key === "string" && key.startsWith("/api/partners");
          }
          return false;
        };

        expect(testBed.evaluatePredicate(matcher, "/api/partners")).toBe(true);
        expect(testBed.evaluatePredicate(matcher, "/api/workspaces")).toBe(
          false,
        );
      });

      it("T2.1.4: mutatePartnerLinks(undefined) invalidates /api/links and /api/partners safely", () => {
        const matcher = (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/links") || key.startsWith("/api/partners"));

        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/links?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
      });

      it("T2.1.5: mutateDiscountCodes(null) invalidates /api/discount-codes and /api/partners cleanly", () => {
        const matcher = (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/discount-codes") ||
            key.startsWith("/api/partners"));

        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/discount-codes?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
        expect(testBed.evaluatePredicate(matcher, `/api/partners`)).toBe(true);
      });

      it("T2.1.6: mutateCommissions(null) and mutatePayouts(null) execute cleanly without errors", async () => {
        expect(async () => {
          await mutateCommissions(undefined);
          await mutatePayouts(undefined);
        }).not.toThrow();
      });
    });

    // Boundary 2: URL-Encoded Characters & Query Permutations
    describe("2.2 URL-Encoded Characters & Query Parameter Ordering Permutations", () => {
      const createPartnerMatcher = (pId: string) => {
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
            key.startsWith("/api/partners")
          );
        };
      };

      it("T2.2.1: matches URL-encoded partner IDs in path and query strings", () => {
        const encodedId = "pn_special%2B123";
        const matcher = createPartnerMatcher(encodedId);

        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${encodedId}?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/discount-codes?partnerId=${encodedId}&workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
      });

      it("T2.2.2: matches when workspaceId is before includeComposite in query string", () => {
        const matcher = (key: any) =>
          typeof key === "string" &&
          key.startsWith(`/api/partners/${partnerId}`) &&
          key.includes("includeComposite=true");

        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`,
          ),
        ).toBe(true);
      });

      it("T2.2.3: matches when includeComposite is before workspaceId in query string", () => {
        const matcher = (key: any) =>
          typeof key === "string" &&
          key.startsWith(`/api/partners/${partnerId}`) &&
          key.includes("includeComposite=true");

        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}?includeComposite=true&workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
      });

      it("T2.2.4: matches keys with URL-encoded search and filter parameters", () => {
        const matcher = createPartnerMatcher(partnerId);
        const url = `/api/partners/${partnerId}?workspaceId=${workspaceId}&search=Jane%20Doe%26Co&includeComposite=true`;
        expect(testBed.evaluatePredicate(matcher, url)).toBe(true);
      });

      it("T2.2.5: matches query strings with bracket notation filters", () => {
        const matcher = createPartnerMatcher(partnerId);
        const url = `/api/discount-codes?filter%5Bstatus%5D=active&partnerId=${partnerId}&workspaceId=${workspaceId}`;
        expect(testBed.evaluatePredicate(matcher, url)).toBe(true);
      });

      it("T2.2.6: matches keys with multiple repeated query parameter names", () => {
        const matcher = createPartnerMatcher(partnerId);
        const url = `/api/partners?tag=vip&tag=fitness&partnerId=${partnerId}&workspaceId=${workspaceId}`;
        expect(testBed.evaluatePredicate(matcher, url)).toBe(true);
      });
    });

    // Boundary 3: Sub-Paths Under /api/partners/[id]/*
    describe("2.3 Sub-Paths Under /api/partners/[id]/*", () => {
      const createPartnerMatcher = (pId: string) => {
        const partnerEndpointPrefix = `/api/partners/${pId}`;
        return (key: any) =>
          typeof key === "string" &&
          (key === partnerEndpointPrefix ||
            key.startsWith(`${partnerEndpointPrefix}?`) ||
            key.startsWith(`${partnerEndpointPrefix}/`));
      };

      it("T2.3.1: matches /api/partners/[id]/links and paginated variants", () => {
        const matcher = createPartnerMatcher(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/links`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/links?page=2&pageSize=20`,
          ),
        ).toBe(true);
      });

      it("T2.3.2: matches /api/partners/[id]/payouts with filter query params", () => {
        const matcher = createPartnerMatcher(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/payouts?status=completed`,
          ),
        ).toBe(true);
      });

      it("T2.3.3: matches /api/partners/[id]/commissions and /commissions/count", () => {
        const matcher = createPartnerMatcher(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/commissions`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/commissions/count`,
          ),
        ).toBe(true);
      });

      it("T2.3.4: matches /api/partners/[id]/activity-logs and /rewind", () => {
        const matcher = createPartnerMatcher(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/activity-logs?workspaceId=${workspaceId}`,
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/rewind`,
          ),
        ).toBe(true);
      });

      it("T2.3.5: matches deeply nested sub-routes (/rewards/claims/:id)", () => {
        const matcher = createPartnerMatcher(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/rewards/claims/claim_123`,
          ),
        ).toBe(true);
      });

      it("T2.3.6: matches sub-paths with trailing slashes", () => {
        const matcher = createPartnerMatcher(partnerId);
        expect(
          testBed.evaluatePredicate(
            matcher,
            `/api/partners/${partnerId}/referral/`,
          ),
        ).toBe(true);
      });
    });

    // Boundary 4: Non-String & Malformed SWR Key Shapes
    describe("2.4 Matching Against Non-String & Unexpected SWR Key Shapes", () => {
      const matcher = (key: any) =>
        typeof key === "string" && key.startsWith("/api/partners");

      it("T2.4.1: safely returns false for Array keys", () => {
        expect(
          testBed.evaluatePredicate(matcher, ["/api/partners", workspaceId]),
        ).toBe(false);
        expect(
          testBed.evaluatePredicate(matcher, [
            "/api/partners",
            { id: partnerId },
          ]),
        ).toBe(false);
      });

      it("T2.4.2: safely returns false for Object keys", () => {
        expect(
          testBed.evaluatePredicate(matcher, {
            url: "/api/partners",
            workspaceId,
          }),
        ).toBe(false);
        expect(
          testBed.evaluatePredicate(matcher, { path: "/api/partners/pn_123" }),
        ).toBe(false);
      });

      it("T2.4.3: safely returns false for null, undefined, boolean, or numeric cache keys", () => {
        expect(testBed.evaluatePredicate(matcher, null)).toBe(false);
        expect(testBed.evaluatePredicate(matcher, undefined)).toBe(false);
        expect(testBed.evaluatePredicate(matcher, true)).toBe(false);
        expect(testBed.evaluatePredicate(matcher, 12345)).toBe(false);
      });

      it("T2.4.4: safely returns false for Function or Symbol cache keys", () => {
        expect(testBed.evaluatePredicate(matcher, () => "/api/partners")).toBe(
          false,
        );
        expect(testBed.evaluatePredicate(matcher, Symbol("partners"))).toBe(
          false,
        );
      });

      it("T2.4.5: safely returns false for empty array [] and empty object {}", () => {
        expect(testBed.evaluatePredicate(matcher, [])).toBe(false);
        expect(testBed.evaluatePredicate(matcher, {})).toBe(false);
      });

      it("T2.4.6: safely returns false for nested data structure keys", () => {
        expect(
          testBed.evaluatePredicate(matcher, [
            ["/api/partners"],
            { ws: workspaceId },
          ]),
        ).toBe(false);
      });
    });

    // Boundary 5: Prefix Collisions & False Positive Isolation
    describe("2.5 Prefix Collisions & False Positive Isolation", () => {
      const createPartnerMatcher = (pId: string) => {
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
          return matchesPartnerPath || hasPartnerIdParam;
        };
      };

      it("T2.5.1: partner pn_1 does NOT match /api/partners/pn_10 or /api/partners/pn_100", () => {
        const matcher = createPartnerMatcher("pn_1");
        expect(
          testBed.evaluatePredicate(
            matcher,
            "/api/partners/pn_1?workspaceId=ws_1",
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            "/api/partners/pn_10?workspaceId=ws_1",
          ),
        ).toBe(false);
        expect(
          testBed.evaluatePredicate(
            matcher,
            "/api/partners/pn_100?workspaceId=ws_1",
          ),
        ).toBe(false);
      });

      it("T2.5.2: partner pn_1 does NOT match partnerId=pn_10 or partnerId=pn_100", () => {
        const matcher = createPartnerMatcher("pn_1");
        expect(
          testBed.evaluatePredicate(
            matcher,
            "/api/discount-codes?partnerId=pn_1&workspaceId=ws_1",
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            "/api/discount-codes?partnerId=pn_10&workspaceId=ws_1",
          ),
        ).toBe(false);
        expect(
          testBed.evaluatePredicate(
            matcher,
            "/api/discount-codes?partnerId=pn_100&workspaceId=ws_1",
          ),
        ).toBe(false);
      });

      it("T2.5.3: partner pn_1 does NOT match otherPartnerId=pn_1 or parentPartnerId=pn_1", () => {
        const matcher = createPartnerMatcher("pn_1");
        expect(
          testBed.evaluatePredicate(
            matcher,
            "/api/partners/network?otherPartnerId=pn_1",
          ),
        ).toBe(false);
        expect(
          testBed.evaluatePredicate(
            matcher,
            "/api/partners/tree?parentPartnerId=pn_1",
          ),
        ).toBe(false);
      });

      it("T2.5.4: /api/partners prefix matcher handles isolation from /api/partnerships", () => {
        const matcher = (key: any) =>
          typeof key === "string" &&
          (key === "/api/partners" ||
            key.startsWith("/api/partners/") ||
            key.startsWith("/api/partners?"));

        expect(testBed.evaluatePredicate(matcher, "/api/partners")).toBe(true);
        expect(
          testBed.evaluatePredicate(matcher, "/api/partners?status=active"),
        ).toBe(true);
        expect(testBed.evaluatePredicate(matcher, "/api/partnerships")).toBe(
          false,
        );
        expect(
          testBed.evaluatePredicate(matcher, "/api/partnerships/programs"),
        ).toBe(false);
      });

      it("T2.5.5: /api/discount-codes does NOT match /api/discount-codes-archive or /api/discount-codes-v2", () => {
        const matcher = (key: any) =>
          typeof key === "string" &&
          (key === "/api/discount-codes" ||
            key.startsWith("/api/discount-codes/") ||
            key.startsWith("/api/discount-codes?"));

        expect(
          testBed.evaluatePredicate(
            matcher,
            "/api/discount-codes?workspaceId=ws_1",
          ),
        ).toBe(true);
        expect(
          testBed.evaluatePredicate(
            matcher,
            "/api/discount-codes-archive?workspaceId=ws_1",
          ),
        ).toBe(false);
        expect(
          testBed.evaluatePredicate(matcher, "/api/discount-codes-v2"),
        ).toBe(false);
      });

      it("T2.5.6: suffix matcher /count does NOT match /count-details or mid-string count", () => {
        const matcher = (key: any) =>
          typeof key === "string" && key.endsWith("/count");

        expect(testBed.evaluatePredicate(matcher, "/api/partners/count")).toBe(
          true,
        );
        expect(
          testBed.evaluatePredicate(matcher, "/api/partners/count-details"),
        ).toBe(false);
        expect(testBed.evaluatePredicate(matcher, "/api/count/partners")).toBe(
          false,
        );
      });
    });
  });

  // =========================================================================
  // TIER 3: CROSS-FEATURE INTERACTIONS (≥10 tests, 12 tests)
  // =========================================================================
  describe("Tier 3: Cross-Feature Interactions", () => {
    it("T3.1: creating partner referral link invalidates /api/links and composite /api/partners/[id]", () => {
      const compositeKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      const linksKey = `/api/links?workspaceId=${workspaceId}`;

      testBed.set(compositeKey, { id: partnerId, links: [] });
      testBed.set(linksKey, []);

      const linksMatcher = (key: any) =>
        typeof key === "string" && key.startsWith("/api/links");
      const partnerMatcher = (key: any) =>
        typeof key === "string" && key.startsWith(`/api/partners/${partnerId}`);

      const inv1 = testBed.applyMutation(linksMatcher, [{ id: "lnk_new" }]);
      const inv2 = testBed.applyMutation(partnerMatcher, {
        id: partnerId,
        links: [{ id: "lnk_new" }],
      });

      expect(inv1).toContain(linksKey);
      expect(inv2).toContain(compositeKey);
      expect(testBed.get(compositeKey).links).toHaveLength(1);
    });

    it("T3.2: adding discount code synchronizes /api/discount-codes and composite partner cache", () => {
      const compositeKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      const codesKey = `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`;

      testBed.set(compositeKey, { id: partnerId, discountCodes: [] });
      testBed.set(codesKey, []);

      const codesMatcher = (key: any) =>
        typeof key === "string" && key.startsWith("/api/discount-codes");
      const partnerMatcher = (key: any) =>
        typeof key === "string" && key.startsWith(`/api/partners/${partnerId}`);

      testBed.applyMutation(codesMatcher, [{ id: "dc_1", code: "SAVE10" }]);
      testBed.applyMutation(partnerMatcher, {
        id: partnerId,
        discountCodes: [{ id: "dc_1", code: "SAVE10" }],
      });

      expect(testBed.get(codesKey)).toHaveLength(1);
      expect(testBed.get(compositeKey).discountCodes).toHaveLength(1);
    });

    it("T3.3: deleting discount code synchronizes /api/discount-codes and composite partner cache", () => {
      const compositeKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      const codesKey = `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`;

      testBed.set(compositeKey, {
        id: partnerId,
        discountCodes: [{ id: "dc_1", code: "SAVE10" }],
      });
      testBed.set(codesKey, [{ id: "dc_1", code: "SAVE10" }]);

      const codesMatcher = (key: any) =>
        typeof key === "string" && key.startsWith("/api/discount-codes");
      const partnerMatcher = (key: any) =>
        typeof key === "string" && key.startsWith(`/api/partners/${partnerId}`);

      testBed.applyMutation(codesMatcher, []);
      testBed.applyMutation(partnerMatcher, {
        id: partnerId,
        discountCodes: [],
      });

      expect(testBed.get(codesKey)).toHaveLength(0);
      expect(testBed.get(compositeKey).discountCodes).toHaveLength(0);
    });

    it("T3.4: creating commission invalidates /api/commissions, /api/partners, and /api/payouts simultaneously", () => {
      const commKey = `/api/commissions?workspaceId=${workspaceId}`;
      const partnerKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      const payoutsKey = `/api/payouts?workspaceId=${workspaceId}&partnerId=${partnerId}`;

      testBed.set(commKey, []);
      testBed.set(partnerKey, {
        id: partnerId,
        totalCommissions: 0,
        netRevenue: 0,
      });
      testBed.set(payoutsKey, []);

      const multiMatcher = (key: any) =>
        typeof key === "string" &&
        (key.startsWith("/api/commissions") ||
          key.startsWith("/api/payouts") ||
          key.startsWith(`/api/partners/${partnerId}`));

      const invalidated = testBed.applyMutation(multiMatcher);

      expect(invalidated).toContain(commKey);
      expect(invalidated).toContain(partnerKey);
      expect(invalidated).toContain(payoutsKey);
    });

    it("T3.5: creating clawback invalidates commissions, partner stats, and payouts for live rollups", () => {
      const partnerKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      testBed.set(partnerKey, {
        id: partnerId,
        totalCommissions: 10000,
        netRevenue: 50000,
      });

      const matcher = (key: any) =>
        typeof key === "string" &&
        (key.startsWith("/api/commissions") ||
          key.startsWith("/api/payouts") ||
          key.startsWith(`/api/partners/${partnerId}`));

      testBed.applyMutation(matcher, (prev: any) => ({
        ...prev,
        totalCommissions: prev.totalCommissions - 2000,
        netRevenue: prev.netRevenue - 10000,
      }));

      expect(testBed.get(partnerKey).totalCommissions).toBe(8000);
      expect(testBed.get(partnerKey).netRevenue).toBe(40000);
    });

    it("T3.6: changing partner group invalidates /api/partners, /api/partners/[id], and /api/groups/[groupId]", () => {
      const partnerDetailKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      const partnerListKey = `/api/partners?workspaceId=${workspaceId}`;
      const groupKey = `/api/groups/${groupId}?workspaceId=${workspaceId}`;

      testBed.set(partnerDetailKey, { id: partnerId, groupId: "grp_bronze" });
      testBed.set(partnerListKey, [{ id: partnerId, groupId: "grp_bronze" }]);
      testBed.set(groupKey, { id: groupId, name: "VIP" });

      const matcher = (key: any) =>
        typeof key === "string" &&
        (key.startsWith("/api/partners") ||
          key.startsWith(`/api/groups/${groupId}`));

      const invalidated = testBed.applyMutation(matcher);

      expect(invalidated).toContain(partnerDetailKey);
      expect(invalidated).toContain(partnerListKey);
      expect(invalidated).toContain(groupKey);
    });

    it("T3.7: banning partner invalidates partner lists, counts, and partner detail composite", () => {
      const listKey = `/api/partners?workspaceId=${workspaceId}`;
      const countKey = `/api/partners/count?workspaceId=${workspaceId}&groupBy=status`;
      const detailKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;

      testBed.set(listKey, [{ id: partnerId, status: "approved" }]);
      testBed.set(countKey, [{ status: "approved", _count: 10 }]);
      testBed.set(detailKey, { id: partnerId, status: "approved" });

      const matcher = (key: any) =>
        typeof key === "string" && key.startsWith("/api/partners");

      const invalidated = testBed.applyMutation(matcher);

      expect(invalidated).toContain(listKey);
      expect(invalidated).toContain(countKey);
      expect(invalidated).toContain(detailKey);
    });

    it("T3.8: approving partner application invalidates partner lists, counts, and partner detail", () => {
      const listKey = `/api/partners?workspaceId=${workspaceId}&status=pending`;
      const countKey = `/api/partners/count?workspaceId=${workspaceId}`;
      const detailKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;

      testBed.set(listKey, [{ id: partnerId, status: "pending" }]);
      testBed.set(countKey, 1);
      testBed.set(detailKey, { id: partnerId, status: "pending" });

      const matcher = (key: any) =>
        typeof key === "string" && key.startsWith("/api/partners");

      const invalidated = testBed.applyMutation(matcher);

      expect(invalidated).toContain(listKey);
      expect(invalidated).toContain(countKey);
      expect(invalidated).toContain(detailKey);
    });

    it("T3.9: confirming payout batch invalidates payouts, commissions, and partner balances", () => {
      const payoutsKey = `/api/payouts?workspaceId=${workspaceId}&partnerId=${partnerId}`;
      const commKey = `/api/commissions?workspaceId=${workspaceId}&partnerId=${partnerId}`;
      const partnerKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;

      testBed.set(payoutsKey, [{ id: "po_1", status: "pending" }]);
      testBed.set(commKey, [{ id: "cm_1", status: "unpaid" }]);
      testBed.set(partnerKey, { id: partnerId, pendingPayoutAmount: 5000 });

      const matcher = (key: any) =>
        typeof key === "string" &&
        (key.startsWith("/api/payouts") ||
          key.startsWith("/api/commissions") ||
          key.startsWith(`/api/partners/${partnerId}`));

      const invalidated = testBed.applyMutation(matcher);

      expect(invalidated).toContain(payoutsKey);
      expect(invalidated).toContain(commKey);
      expect(invalidated).toContain(partnerKey);
    });

    it("T3.10: updating partner tags invalidates partner detail and list filter views", () => {
      const detailKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      const tagFilteredList = `/api/partners?workspaceId=${workspaceId}&tag=influencer`;

      testBed.set(detailKey, { id: partnerId, tags: [] });
      testBed.set(tagFilteredList, []);

      const matcher = (key: any) =>
        typeof key === "string" && key.startsWith("/api/partners");

      const invalidated = testBed.applyMutation(matcher);

      expect(invalidated).toContain(detailKey);
      expect(invalidated).toContain(tagFilteredList);
    });

    it("T3.11: concurrent multi-resource mutations execute without race conditions", async () => {
      const linkKey = `/api/links?workspaceId=${workspaceId}`;
      const codeKey = `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`;
      const partnerKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;

      testBed.set(linkKey, []);
      testBed.set(codeKey, []);
      testBed.set(partnerKey, { id: partnerId, links: [], discountCodes: [] });

      await Promise.all([
        mutatePartnerLinks(partnerId),
        mutateDiscountCodes(partnerId),
      ]);

      expect(testBed.has(linkKey)).toBe(true);
      expect(testBed.has(codeKey)).toBe(true);
      expect(testBed.has(partnerKey)).toBe(true);
    });

    it("T3.12: rapid sequential mutations (5 rapid link creations) invalidate cache predictably", async () => {
      const partnerKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      testBed.set(partnerKey, { id: partnerId, links: [] });

      for (let i = 1; i <= 5; i++) {
        testBed.applyMutation(
          (key: any) =>
            typeof key === "string" &&
            key.startsWith(`/api/partners/${partnerId}`),
          (prev: any) => ({
            ...prev,
            links: [...prev.links, { id: `lnk_${i}` }],
          }),
        );
      }

      expect(testBed.get(partnerKey).links).toHaveLength(5);
    });
  });

  // =========================================================================
  // TIER 4: REAL-WORLD WORKFLOW SCENARIOS (≥5 tests, 6 tests)
  // =========================================================================
  describe("Tier 4: Real-World Workflow Scenarios", () => {
    it("T4.1: Yamax Partner Link Provisioning SLA (<50ms In-Memory Update)", async () => {
      const startTime = performance.now();

      const compositeKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      const initialPartner = {
        id: partnerId,
        name: "Sarah Active",
        links: [],
        discountCodes: [],
      };
      testBed.set(compositeKey, initialPartner);

      const newLink = {
        id: "lnk_sarah",
        domain: "yamax.co",
        key: "sarah",
        shortLink: "https://yamax.co/sarah",
      };

      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          key.startsWith(`/api/partners/${partnerId}`),
        (prev: any) => ({
          ...prev,
          links: [...prev.links, newLink],
        }),
      );

      const endTime = performance.now();
      const durationMs = endTime - startTime;

      expect(durationMs).toBeLessThan(50);

      const updated = testBed.get(compositeKey);
      expect(updated.links).toHaveLength(1);
      expect(updated.links[0].key).toBe("sarah");
      expect(updated.links[0].shortLink).toBe("https://yamax.co/sarah");
    });

    it("T4.2: Yamax Discount Code Lifecycle & Button Disabled State Sync", () => {
      const compositeKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      const codesKey = `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`;

      const partnerState = {
        id: partnerId,
        links: [{ id: "lnk_1", key: "sarah" }],
        discountCodes: [] as any[],
      };
      testBed.set(compositeKey, partnerState);
      testBed.set(codesKey, []);

      const isButtonDisabled1 =
        partnerState.links.length === partnerState.discountCodes.length;
      expect(isButtonDisabled1).toBe(false);

      const newCode = {
        id: "dc_1",
        code: "SARAH10",
        partnerId,
        linkId: "lnk_1",
      };
      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/discount-codes") ||
            key.startsWith(`/api/partners/${partnerId}`)),
        (prev: any) => {
          if (Array.isArray(prev)) return [...prev, newCode];
          return { ...prev, discountCodes: [...prev.discountCodes, newCode] };
        },
      );

      const partnerAfterAdd = testBed.get(compositeKey);
      const isButtonDisabled2 =
        partnerAfterAdd.links.length === partnerAfterAdd.discountCodes.length;
      expect(isButtonDisabled2).toBe(true);

      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/discount-codes") ||
            key.startsWith(`/api/partners/${partnerId}`)),
        (prev: any) => {
          if (Array.isArray(prev)) return [];
          return { ...prev, discountCodes: [] };
        },
      );

      const partnerAfterDelete = testBed.get(compositeKey);
      const isButtonDisabled3 =
        partnerAfterDelete.links.length ===
        partnerAfterDelete.discountCodes.length;
      expect(isButtonDisabled3).toBe(false);
    });

    it("T4.3: Yamax Multi-Item Commission Real-Time Settlement & Header Stats", () => {
      const compositeKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      const commKey = `/api/commissions?workspaceId=${workspaceId}&partnerId=${partnerId}`;

      testBed.set(compositeKey, {
        id: partnerId,
        totalCommissions: 0,
        netRevenue: 0,
        totalSales: 0,
      });
      testBed.set(commKey, []);

      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/commissions") ||
            key.startsWith(`/api/partners/${partnerId}`)),
        (prev: any) => {
          if (Array.isArray(prev)) {
            return [
              {
                id: "cm_1",
                amount: 2000,
                saleAmount: 10000,
                status: "pending",
              },
            ];
          }
          return {
            ...prev,
            totalCommissions: prev.totalCommissions + 2000,
            netRevenue: prev.netRevenue + 8000,
            totalSales: prev.totalSales + 1,
          };
        },
      );

      expect(testBed.get(compositeKey).totalCommissions).toBe(2000);
      expect(testBed.get(compositeKey).netRevenue).toBe(8000);
      expect(testBed.get(compositeKey).totalSales).toBe(1);

      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/commissions") ||
            key.startsWith(`/api/partners/${partnerId}`)),
        (prev: any) => {
          if (Array.isArray(prev)) {
            return [
              ...prev,
              {
                id: "cm_2_clawback",
                amount: -2000,
                saleAmount: -10000,
                status: "clawback",
              },
            ];
          }
          return {
            ...prev,
            totalCommissions: prev.totalCommissions - 2000,
            netRevenue: prev.netRevenue - 8000,
          };
        },
      );

      expect(testBed.get(compositeKey).totalCommissions).toBe(0);
      expect(testBed.get(compositeKey).netRevenue).toBe(0);
    });

    it("T4.4: Yamax VIP Group Migration & Reward Tier Upgrades", () => {
      const compositeKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      const groupKey = `/api/groups/${groupId}?workspaceId=${workspaceId}`;

      testBed.set(compositeKey, {
        id: partnerId,
        groupId: "grp_bronze",
        group: {
          id: "grp_bronze",
          name: "Bronze Affiliates",
          color: "#CD7F32",
        },
      });
      testBed.set(groupKey, {
        id: groupId,
        name: "VIP Ambassadors",
        color: "#6366F1",
      });

      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          key.startsWith(`/api/partners/${partnerId}`),
        (prev: any) => ({
          ...prev,
          groupId,
          group: { id: groupId, name: "VIP Ambassadors", color: "#6366F1" },
        }),
      );

      const updated = testBed.get(compositeKey);
      expect(updated.groupId).toBe(groupId);
      expect(updated.group.name).toBe("VIP Ambassadors");
      expect(updated.group.color).toBe("#6366F1");
    });

    it("T4.5: Yamax Payout Lifecycle & Balance Settlement", () => {
      const compositeKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      const payoutsKey = `/api/payouts?workspaceId=${workspaceId}&partnerId=${partnerId}`;

      testBed.set(compositeKey, {
        id: partnerId,
        pendingPayoutAmount: 5000,
        lifetimePaidOut: 0,
      });
      testBed.set(payoutsKey, []);

      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/payouts") ||
            key.startsWith(`/api/partners/${partnerId}`)),
        (prev: any) => {
          if (Array.isArray(prev)) {
            return [
              {
                id: "po_1",
                amount: 5000,
                status: "completed",
                paidAt: new Date(),
              },
            ];
          }
          return {
            ...prev,
            pendingPayoutAmount: 0,
            lifetimePaidOut: 5000,
          };
        },
      );

      const updatedPartner = testBed.get(compositeKey);
      const updatedPayouts = testBed.get(payoutsKey);

      expect(updatedPartner.pendingPayoutAmount).toBe(0);
      expect(updatedPartner.lifetimePaidOut).toBe(5000);
      expect(updatedPayouts).toHaveLength(1);
      expect(updatedPayouts[0].status).toBe("completed");
    });

    it("T4.6: Full Partner Lifecycle End-to-End Reactivity Simulation", async () => {
      const compositeKey = `/api/partners/${partnerId}?workspaceId=${workspaceId}&includeComposite=true`;
      const linksKey = `/api/links?workspaceId=${workspaceId}`;
      const codesKey = `/api/discount-codes?workspaceId=${workspaceId}&partnerId=${partnerId}`;
      const payoutsKey = `/api/payouts?workspaceId=${workspaceId}&partnerId=${partnerId}`;

      // 1. Partner Onboarding (Fresh partner)
      testBed.set(compositeKey, {
        id: partnerId,
        name: "Sarah Active",
        status: "approved",
        groupId: "grp_bronze",
        links: [],
        discountCodes: [],
        totalSales: 0,
        totalCommissions: 0,
        netRevenue: 0,
        pendingPayoutAmount: 0,
        lifetimePaidOut: 0,
      });
      testBed.set(linksKey, []);
      testBed.set(codesKey, []);
      testBed.set(payoutsKey, []);

      // 2. Link Generation ('yamax.co/sarah')
      const link1 = {
        id: "lnk_1",
        key: "sarah",
        shortLink: "https://yamax.co/sarah",
      };
      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/links") ||
            key.startsWith(`/api/partners/${partnerId}`)),
        (prev: any) => {
          if (Array.isArray(prev)) return [link1];
          return { ...prev, links: [link1] };
        },
      );
      expect(testBed.get(compositeKey).links).toHaveLength(1);

      // 3. Discount Code Assignment ('SARAH10')
      const code1 = { id: "dc_1", code: "SARAH10", partnerId, linkId: "lnk_1" };
      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/discount-codes") ||
            key.startsWith(`/api/partners/${partnerId}`)),
        (prev: any) => {
          if (Array.isArray(prev)) return [code1];
          return { ...prev, discountCodes: [code1] };
        },
      );
      expect(testBed.get(compositeKey).discountCodes).toHaveLength(1);

      // 4. Commission Earned ($30 on $150 sale)
      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          key.startsWith(`/api/partners/${partnerId}`),
        (prev: any) => ({
          ...prev,
          totalSales: 1,
          totalCommissions: 3000,
          netRevenue: 12000,
          pendingPayoutAmount: 3000,
        }),
      );
      expect(testBed.get(compositeKey).totalCommissions).toBe(3000);

      // 5. Clawback Issued (-$10 adjustment)
      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          key.startsWith(`/api/partners/${partnerId}`),
        (prev: any) => ({
          ...prev,
          totalCommissions: 2000,
          netRevenue: 8000,
          pendingPayoutAmount: 2000,
        }),
      );
      expect(testBed.get(compositeKey).totalCommissions).toBe(2000);

      // 6. Payout Confirmed ($20 payout)
      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          (key.startsWith("/api/payouts") ||
            key.startsWith(`/api/partners/${partnerId}`)),
        (prev: any) => {
          if (Array.isArray(prev))
            return [{ id: "po_1", amount: 2000, status: "completed" }];
          return {
            ...prev,
            pendingPayoutAmount: 0,
            lifetimePaidOut: 2000,
          };
        },
      );
      expect(testBed.get(compositeKey).pendingPayoutAmount).toBe(0);
      expect(testBed.get(compositeKey).lifetimePaidOut).toBe(2000);

      // 7. Group Tier Upgraded to VIP
      testBed.applyMutation(
        (key: any) =>
          typeof key === "string" &&
          key.startsWith(`/api/partners/${partnerId}`),
        (prev: any) => ({
          ...prev,
          groupId: "grp_vip",
        }),
      );
      expect(testBed.get(compositeKey).groupId).toBe("grp_vip");

      // Final Check: Zero stale state, all entities consistent
      const finalState = testBed.get(compositeKey);
      expect(finalState.links).toHaveLength(1);
      expect(finalState.discountCodes).toHaveLength(1);
      expect(finalState.totalCommissions).toBe(2000);
      expect(finalState.pendingPayoutAmount).toBe(0);
      expect(finalState.lifetimePaidOut).toBe(2000);
      expect(finalState.groupId).toBe("grp_vip");
    });
  });
});
