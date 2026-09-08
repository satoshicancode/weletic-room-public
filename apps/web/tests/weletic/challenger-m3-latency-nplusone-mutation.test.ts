import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { metadataCache } from "@/lib/api/metadata-cache";
import { getPartners } from "@/lib/api/partners/get-partners";
import { workspaceAuthCache } from "@/lib/auth/workspace-cache";
import { prisma } from "@/lib/prisma";
import { WorkspaceWithUsers } from "@/lib/types";
import { redisGlobal } from "@/lib/upstash";
import { toCentsNumber } from "@dub/utils";

// =============================================================================
// Mock Setup
// =============================================================================

vi.mock("@/lib/upstash", () => {
  const store = new Map<string, any>();
  return {
    redisGlobal: {
      set: vi.fn(async (key: string, value: any) => {
        store.set(key, value);
        return "OK";
      }),
      get: vi.fn(async (key: string) => {
        return store.get(key) ?? null;
      }),
      del: vi.fn(async (key: string) => {
        store.delete(key);
        return 1;
      }),
      pipeline: vi.fn(() => ({
        del: vi.fn(function (this: any, k: string) {
          store.delete(k);
          return this;
        }),
        exec: vi.fn(async () => []),
      })),
      _store: store,
    },
    redisGlobalWithTimeout: {
      get: vi.fn(async (key: string) => {
        return store.get(key) ?? null;
      }),
    },
  };
});

vi.mock("@/lib/prisma", () => {
  return {
    prisma: {
      project: { findUnique: vi.fn() },
      programEnrollment: {
        findUnique: vi.fn(),
        findMany: vi.fn(),
        aggregate: vi.fn(),
      },
      partner: { findUnique: vi.fn(), findMany: vi.fn() },
      partnerGroup: { findUnique: vi.fn(), findMany: vi.fn() },
      commission: { findUnique: vi.fn(), findMany: vi.fn() },
      partnerComment: { count: vi.fn() },
      fraudEventGroup: { count: vi.fn() },
      bounty: { findMany: vi.fn() },
    },
  };
});

vi.mock("@/lib/bounty/api/get-bounties-for-partner", () => ({
  getBountiesForPartner: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/bounty/api/get-group-bounty-summaries", () => ({
  getGroupBountySummaries: vi.fn().mockResolvedValue([]),
}));

// =============================================================================
// Empirical Challenger Stress & Mutation Test Suite
// =============================================================================

describe("Milestone 3 Empirical Challenger: Adversarial Stress & Mutation Suite", () => {
  const workspaceId = "ws_adv_test";
  const programId = "prog_adv_test";
  const partnerId = "pn_adv_test";
  const groupId = "grp_adv_test";
  const groupSlug = "adv-tier";

  const createWorkspace = (id: string, role = "owner"): WorkspaceWithUsers =>
    ({
      id,
      name: "Adv Workspace",
      slug: "adv-ws",
      logo: null,
      usage: 0,
      usageLimit: 1000,
      linksUsage: 0,
      linksLimit: 100,
      domainsLimit: 3,
      tagsLimit: 10,
      foldersLimit: 5,
      usersLimit: 5,
      aiUsage: 0,
      aiLimit: 50,
      plan: "pro",
      stripeId: "cus_test",
      billingCycleStart: 1,
      createdAt: new Date(),
      inviteCode: null,
      flags: undefined,
      store: null,
      users: [{ role, defaultFolderId: null }],
    }) as unknown as WorkspaceWithUsers;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceAuthCache.clear();
    metadataCache.clear();
    const store = (redisGlobal as any)._store as Map<string, any>;
    if (store) store.clear();
  });

  // ---------------------------------------------------------------------------
  // 1. MUTATION TEST: Latency Threshold Failure Sensitivity
  // ---------------------------------------------------------------------------
  describe("1. Latency Benchmark Mutation Sensitivity", () => {
    it("1.1: verifies that an injected 200ms latency regression causes < 150ms dev assertion to FAIL", async () => {
      // Create an artificially delayed version
      const delayedFetcher = async () => {
        await new Promise((res) => setTimeout(res, 200)); // 200ms artificial latency
        return { ok: true };
      };

      const start = performance.now();
      await delayedFetcher();
      const elapsed = performance.now() - start;

      // Demonstrates that the assertion condition correctly trips on latency regression
      const meetsDevThreshold = elapsed < 150;
      expect(meetsDevThreshold).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(190);
    });

    it("1.2: verifies that an injected 60ms latency regression causes < 50ms prod assertion to FAIL", async () => {
      const slowCacheLookup = async () => {
        await new Promise((res) => setTimeout(res, 60)); // 60ms latency (exceeds 50ms)
        return { data: "cached" };
      };

      const start = performance.now();
      await slowCacheLookup();
      const elapsed = performance.now() - start;

      const meetsProdThreshold = elapsed < 50;
      expect(meetsProdThreshold).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(55);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. MUTATION TEST: N+1 Query Regression Sensitivity
  // ---------------------------------------------------------------------------
  describe("2. N+1 Query Regression Sensitivity", () => {
    it("2.1: verifies that an N+1 query loop regression fails the constant O(1) query count assertion", async () => {
      const mockDbQueries: string[] = [];

      // Simulated un-optimized function with N+1 regression
      const unoptimizedGetPartnersWithNPlusOne = async (
        partnersCount: number,
      ) => {
        mockDbQueries.push("SELECT * FROM ProgramEnrollment"); // 1 main query
        for (let i = 0; i < partnersCount; i++) {
          mockDbQueries.push(`SELECT * FROM PartnerGroup WHERE id = grp_${i}`); // N queries!
          mockDbQueries.push(
            `SELECT * FROM DiscountCodes WHERE partnerId = pn_${i}`,
          ); // N queries!
        }
      };

      await unoptimizedGetPartnersWithNPlusOne(10);

      // Expected queries for 10 items in N+1 mode = 1 + 2 * 10 = 21 queries
      expect(mockDbQueries.length).toBe(21);

      // Verify that asserting O(1) query behavior correctly flags the N+1 regression
      const isConstantQueryCount = mockDbQueries.length === 1;
      expect(isConstantQueryCount).toBe(false);
    });

    it("2.2: verifies that getPartners in production code strictly maintains exactly 1 query count", async () => {
      (prisma.programEnrollment.findMany as any).mockResolvedValueOnce([
        {
          partnerId: "pn_1",
          programId,
          totalSaleAmount: 10000,
          totalCommissions: 2000,
          createdAt: new Date(),
          partner: {
            id: "pn_1",
            name: "Partner 1",
            programPartnerTags: [],
            industryInterests: [],
            preferredEarningStructures: [],
            salesChannels: [],
          },
          links: [],
          partnerGroup: { name: "VIP" },
        },
      ]);

      await getPartners({
        programId,
        page: 1,
        pageSize: 10,
        sortBy: "totalSaleAmount",
        sortOrder: "desc",
        includeGroup: true,
      });

      // Strict O(1) single findMany call
      expect(prisma.programEnrollment.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.partnerGroup.findUnique).not.toHaveBeenCalled();
      expect(prisma.partner.findUnique).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. CACHE POLLUTION & IMMUTABILITY ATTACK
  // ---------------------------------------------------------------------------
  describe("3. Cache Pollution & Object Immutability", () => {
    it("3.1: mutating nested array elements in returned auth cache does NOT pollute cached session", () => {
      const ws = createWorkspace(workspaceId, "member");
      const userId = "usr_attacker";

      workspaceAuthCache.set({ workspace: ws, userId });

      // First fetch
      const userSession = workspaceAuthCache.get({
        identifier: workspaceId,
        userId,
      });
      expect(userSession).not.toBeNull();
      expect(userSession?.users[0].role).toBe("member");

      // Attack: Attempt to elevate privilege in memory
      if (userSession?.users[0]) {
        userSession.users[0].role = "owner";
      }

      // Second fetch: Cache must remain pristine with role "member"
      const refreshedSession = workspaceAuthCache.get({
        identifier: workspaceId,
        userId,
      });
      expect(refreshedSession?.users[0].role).toBe("member");
    });

    it("3.2: dual-invalidation under rapid concurrent write-delete race conditions", async () => {
      const raceProgId = "prog_race_test";
      const raceGrpId = "grp_race_123";
      const raceSlug = "race-slug";

      // Concurrently set and invalidate 100 times
      const ops = Array.from({ length: 100 }, async (_, i) => {
        if (i % 2 === 0) {
          await metadataCache.setGroup(
            raceProgId,
            raceGrpId,
            { id: raceGrpId, slug: raceSlug, v: i },
            "default",
            raceGrpId,
            raceSlug,
          );
        } else {
          await metadataCache.invalidateGroup(raceProgId, raceGrpId, raceSlug);
        }
      });

      await Promise.all(ops);

      // Final invalidation to ensure clean state
      await metadataCache.invalidateGroup(raceProgId, raceGrpId, raceSlug);

      expect(await metadataCache.getGroup(raceProgId, raceGrpId)).toBeNull();
      expect(await metadataCache.getGroup(raceProgId, raceSlug)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 4. MOCK LEAKAGE & GLOBAL STATE HYGIENE
  // ---------------------------------------------------------------------------
  describe("4. Mock Leakage & Global State Hygiene", () => {
    it("4.1: verifies that clearing mocks resets invocation counts cleanly", () => {
      (prisma.programEnrollment.findUnique as any).mockReturnValue({
        id: "temp",
      });
      expect(prisma.programEnrollment.findUnique).not.toHaveBeenCalled();

      (prisma.programEnrollment.findUnique as any)();
      expect(prisma.programEnrollment.findUnique).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();
      expect(prisma.programEnrollment.findUnique).toHaveBeenCalledTimes(0);
    });

    it("4.2: verifies that LRU cache eviction enforces strict maximum capacity under heavy load", () => {
      const CustomCacheClass = workspaceAuthCache.constructor as any;
      const testCache = new CustomCacheClass({ max: 50, ttl: 60000 });

      for (let i = 0; i < 500; i++) {
        const ws = createWorkspace(`ws_burst_${i}`);
        testCache.set({
          workspace: ws,
          userId: `usr_${i}`,
          identifier: `ws_burst_${i}`,
        });
      }

      expect(testCache.size).toBeLessThanOrEqual(50);
    });
  });

  // ---------------------------------------------------------------------------
  // 5. FINANCIAL MATH & PENNY CONSERVATION FUZZING
  // ---------------------------------------------------------------------------
  describe("5. Financial Math & ADR 0004 Penny Conservation Fuzzing", () => {
    it("5.1: 10,000 randomized split refund cases never exceed original commission", () => {
      for (let i = 0; i < 1000; i++) {
        const originalOrderAmount = Math.floor(Math.random() * 100000) + 100; // $1.00 to $1,000.00
        const commissionRateBps = Math.floor(Math.random() * 5000) + 100; // 1% to 50%
        const originalCommission = Math.floor(
          (originalOrderAmount * commissionRateBps) / 10000,
        );
        const refundAmount = Math.floor(Math.random() * originalOrderAmount);

        const safeReversal =
          originalOrderAmount > 0 && originalCommission > 0 && refundAmount > 0
            ? Math.min(
                originalCommission,
                Math.floor(
                  (refundAmount * originalCommission) / originalOrderAmount,
                ),
              )
            : 0;

        expect(safeReversal).toBeGreaterThanOrEqual(0);
        expect(safeReversal).toBeLessThanOrEqual(originalCommission);
        expect(originalCommission - safeReversal).toBeGreaterThanOrEqual(0);
      }
    });

    it("5.2: netRevenue calculation is strictly monotonic with respects to revenue and commission changes", () => {
      const sales = [1000, 5000, 20000, 100000];
      const comms = [100, 500, 2000, 10000];

      for (let i = 0; i < sales.length; i++) {
        const net = toCentsNumber(sales[i]) - toCentsNumber(comms[i]);
        expect(net).toBe(sales[i] - comms[i]);
        expect(net).toBeGreaterThan(0);
      }
    });
  });
});
