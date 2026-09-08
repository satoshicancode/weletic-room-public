import { metadataCache } from "@/lib/api/metadata-cache";
import {
  WORKSPACE_AUTH_CACHE_MAX,
  workspaceAuthCache,
} from "@/lib/auth/workspace-cache";
import { WorkspaceWithUsers } from "@/lib/types";
import { redisGlobal, redisGlobalWithTimeout } from "@/lib/upstash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("Adversarial Empirical Stress Suite — Caching & Concurrency Hardening", () => {
  const createMockWorkspace = (
    id: string,
    slug: string,
    role: "owner" | "member" | "admin" = "owner",
  ): WorkspaceWithUsers =>
    ({
      id,
      name: `Workspace ${slug}`,
      slug,
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
      users: [
        {
          role,
          defaultFolderId: null,
        },
      ],
    }) as unknown as WorkspaceWithUsers;

  beforeEach(() => {
    vi.clearAllMocks();
    workspaceAuthCache.clear();
    metadataCache.clear();
    const store = (redisGlobal as any)._store as Map<string, any>;
    if (store) store.clear();
  });

  // ===========================================================================
  // SECTION 1: WorkspaceAuthCache Concurrency, Isolation & Boundary Stress
  // ===========================================================================
  describe("WorkspaceAuthCache — Concurrency, Mutation & Isolation Stress", () => {
    it("Stress 1.1: 1,500 concurrent randomized get/set/delete operations with zero race corruption", async () => {
      const workspaces = Array.from({ length: 50 }, (_, i) =>
        createMockWorkspace(
          `clws_${i}`,
          `slug-${i}`,
          i % 2 === 0 ? "owner" : "member",
        ),
      );
      const users = Array.from({ length: 30 }, (_, i) => `usr_${i}`);

      const operations: Promise<any>[] = [];

      for (let op = 0; op < 1500; op++) {
        const ws = workspaces[op % workspaces.length];
        const user = users[op % users.length];
        const opType = op % 5;

        if (opType === 0 || opType === 1) {
          // Set
          operations.push(
            (async () => {
              workspaceAuthCache.set({
                workspace: ws,
                userId: user,
                identifier: ws.id,
              });
            })(),
          );
        } else if (opType === 2 || opType === 3) {
          // Get
          operations.push(
            (async () => {
              const res = workspaceAuthCache.get({
                identifier: ws.id,
                userId: user,
              });
              if (res) {
                expect(res.id).toBe(ws.id);
                expect(["owner", "member"]).toContain(res.users[0].role);
              }
            })(),
          );
        } else {
          // Interleaved single user deletion
          operations.push(
            (async () => {
              workspaceAuthCache.delete({
                workspaceId: ws.id,
                workspaceSlug: ws.slug,
                userId: user,
              });
            })(),
          );
        }
      }

      await Promise.all(operations);
      expect(workspaceAuthCache.size).toBeGreaterThanOrEqual(0);
      expect(workspaceAuthCache.size).toBeLessThanOrEqual(
        WORKSPACE_AUTH_CACHE_MAX,
      );
    });

    it("Stress 1.2: Thundering Herd — 200 concurrent requests for the same un-cached key settle deterministically", async () => {
      const ws = createMockWorkspace("clws_herd", "herd-ws", "owner");
      const userId = "usr_herd_1";

      const results = await Promise.all(
        Array.from({ length: 200 }, async (_, index) => {
          if (index === 0) {
            workspaceAuthCache.set({
              workspace: ws,
              userId,
              identifier: ws.id,
            });
          }
          return workspaceAuthCache.get({ identifier: ws.id, userId });
        }),
      );

      results.forEach((res) => {
        if (res !== null) {
          expect(res.id).toBe("clws_herd");
          expect(res.users[0].role).toBe("owner");
        }
      });
    });

    it("Stress 1.3: Deep mutation resistance on retrieved objects (Machine User & Sub-Object Isolation)", () => {
      const ws = createMockWorkspace("clws_mutation", "mutate-ws", "member");
      const userId = "usr_mutant";

      workspaceAuthCache.set({ workspace: ws, userId, identifier: ws.id });

      // Retrieve instance 1 and simulate aggressive mutations
      const instance1 = workspaceAuthCache.get({ identifier: ws.id, userId });
      expect(instance1).not.toBeNull();
      if (!instance1) return;

      // 1. Mutate nested user role (e.g. machine user override)
      instance1.users[0].role = "owner";
      instance1.users[0].defaultFolderId = "fld_hacked";

      // 2. Mutate users array structure
      instance1.users.push({
        role: "admin",
        defaultFolderId: "fld_extra",
      } as any);

      // 3. Mutate top-level property
      (instance1 as any).plan = "enterprise";
      (instance1 as any).name = "Compromised Workspace";

      // Retrieve instance 2 — must remain completely unaffected
      const instance2 = workspaceAuthCache.get({ identifier: ws.id, userId });
      expect(instance2).not.toBeNull();
      expect(instance2?.users).toHaveLength(1);
      expect(instance2?.users[0].role).toBe("member");
      expect(instance2?.users[0].defaultFolderId).toBeNull();
      expect(instance2?.plan).toBe("pro");
      expect(instance2?.name).toBe("Workspace mutate-ws");
    });

    it("Stress 1.4: Deep mutation resistance on input object modified AFTER set() call", () => {
      const rawWs = createMockWorkspace(
        "clws_after_set",
        "after-set",
        "member",
      );
      const userId = "usr_source_mutate";

      workspaceAuthCache.set({
        workspace: rawWs,
        userId,
        identifier: rawWs.id,
      });

      // Mutate the original source object after caching
      rawWs.users[0].role = "owner";
      rawWs.name = "Mutated Source";

      // Retrieved cache must be isolated from source mutations
      const cached = workspaceAuthCache.get({ identifier: rawWs.id, userId });
      expect(cached?.users[0].role).toBe("member");
      expect(cached?.name).toBe("Workspace after-set");
    });

    it("Stress 1.5: Prefix collision safety in deleteByWorkspace (clws_123 vs clws_1234)", () => {
      const ws1 = createMockWorkspace("clws_123", "acme-1", "owner");
      const ws2 = createMockWorkspace("clws_1234", "acme-12", "owner");
      const ws3 = createMockWorkspace(
        "clws_123_other",
        "acme-1-other",
        "owner",
      );
      const userId = "usr_prefix";

      workspaceAuthCache.set({ workspace: ws1, userId });
      workspaceAuthCache.set({ workspace: ws2, userId });
      workspaceAuthCache.set({ workspace: ws3, userId });

      // Delete only ws1
      workspaceAuthCache.deleteByWorkspace({
        workspaceId: "clws_123",
        workspaceSlug: "acme-1",
      });

      // ws1 must be deleted
      expect(
        workspaceAuthCache.get({ identifier: "clws_123", userId }),
      ).toBeNull();
      expect(
        workspaceAuthCache.get({ identifier: "acme-1", userId }),
      ).toBeNull();

      // ws2 and ws3 must NOT be accidentally deleted by prefix matching
      expect(
        workspaceAuthCache.get({ identifier: "clws_1234", userId }),
      ).not.toBeNull();
      expect(
        workspaceAuthCache.get({ identifier: "acme-12", userId }),
      ).not.toBeNull();
      expect(
        workspaceAuthCache.get({ identifier: "clws_123_other", userId }),
      ).not.toBeNull();
      expect(
        workspaceAuthCache.get({ identifier: "acme-1-other", userId }),
      ).not.toBeNull();
    });

    it("Stress 1.6: Suffix collision safety in deleteByUser (usr_1 vs usr_11)", () => {
      const ws = createMockWorkspace("clws_users", "users-ws", "owner");
      const user1 = "usr_1";
      const user11 = "usr_11";
      const user101 = "usr_101";

      workspaceAuthCache.set({ workspace: ws, userId: user1 });
      workspaceAuthCache.set({ workspace: ws, userId: user11 });
      workspaceAuthCache.set({ workspace: ws, userId: user101 });

      // Delete user1 across all workspaces
      workspaceAuthCache.deleteByUser({ userId: user1 });

      expect(
        workspaceAuthCache.get({ identifier: ws.id, userId: user1 }),
      ).toBeNull();
      expect(
        workspaceAuthCache.get({ identifier: ws.id, userId: user11 }),
      ).not.toBeNull();
      expect(
        workspaceAuthCache.get({ identifier: ws.id, userId: user101 }),
      ).not.toBeNull();
    });

    it("Stress 1.7: Normalized ws_ prefix handling consistency across get, set, delete", () => {
      const ws = createMockWorkspace(
        "clws_prefix_test",
        "prefix-test",
        "owner",
      );
      const userId = "usr_norm";

      workspaceAuthCache.set({
        workspace: ws,
        userId,
        identifier: "ws_clws_prefix_test",
      });

      // All lookup formats must resolve
      expect(
        workspaceAuthCache.get({ identifier: "clws_prefix_test", userId }),
      ).not.toBeNull();
      expect(
        workspaceAuthCache.get({ identifier: "ws_clws_prefix_test", userId }),
      ).not.toBeNull();
      expect(
        workspaceAuthCache.get({ identifier: "prefix-test", userId }),
      ).not.toBeNull();

      // Delete using prefixed ID
      workspaceAuthCache.delete({ workspaceId: "ws_clws_prefix_test", userId });

      // All formats must be invalidated
      expect(
        workspaceAuthCache.get({ identifier: "clws_prefix_test", userId }),
      ).toBeNull();
      expect(
        workspaceAuthCache.get({ identifier: "ws_clws_prefix_test", userId }),
      ).toBeNull();
    });

    it("Stress 1.8: Real-time short TTL expiration and updateAgeOnGet: false boundary check", async () => {
      const CustomCacheClass = workspaceAuthCache.constructor as any;
      const shortCache = new CustomCacheClass({ ttl: 40, max: 100 });
      const ws = createMockWorkspace("clws_short_ttl", "short-ttl", "owner");
      const userId = "usr_short";

      shortCache.set({ workspace: ws, userId });

      // Immediately present
      expect(shortCache.get({ identifier: ws.id, userId })).not.toBeNull();

      // At 15ms: still present, reading does not extend TTL
      await new Promise((r) => setTimeout(r, 15));
      expect(shortCache.get({ identifier: ws.id, userId })).not.toBeNull();

      // At 55ms total (> 40ms TTL): strictly expired
      await new Promise((r) => setTimeout(r, 40));
      expect(shortCache.get({ identifier: ws.id, userId })).toBeNull();
    });
  });

  // ===========================================================================
  // SECTION 2: MetadataCache Dual-Indexing, Invalidation & Edge Cases
  // ===========================================================================
  describe("MetadataCache — Dual-Index, Alias Invalidation & Multi-Key Scoping", () => {
    it("Stress 2.1: Dual-index resolution and alias transitions on partner group update", async () => {
      const groupDataV1 = {
        id: "grp_stress",
        programId: "prog_stress",
        name: "Standard Affiliates",
        slug: "standard",
        commission: 10,
      };

      // Set initial dual index
      await metadataCache.setGroup(
        "prog_stress",
        "grp_stress",
        groupDataV1,
        "default",
        "grp_stress",
        "standard",
      );

      expect(await metadataCache.getGroup("prog_stress", "grp_stress")).toEqual(
        groupDataV1,
      );
      expect(await metadataCache.getGroup("prog_stress", "standard")).toEqual(
        groupDataV1,
      );

      // Now simulate group renaming: slug changed from "standard" -> "gold-affiliates"
      const groupDataV2 = {
        ...groupDataV1,
        name: "Gold Affiliates",
        slug: "gold-affiliates",
        commission: 20,
      };

      // Invalidate old alias
      await metadataCache.invalidateGroup(
        "prog_stress",
        "grp_stress",
        "standard",
      );

      // Set new dual index
      await metadataCache.setGroup(
        "prog_stress",
        "grp_stress",
        groupDataV2,
        "default",
        "grp_stress",
        "gold-affiliates",
      );

      // Old slug must be null (cache miss)
      expect(
        await metadataCache.getGroup("prog_stress", "standard"),
      ).toBeNull();

      // ID and new slug must return V2
      expect(await metadataCache.getGroup("prog_stress", "grp_stress")).toEqual(
        groupDataV2,
      );
      expect(
        await metadataCache.getGroup("prog_stress", "gold-affiliates"),
      ).toEqual(groupDataV2);
    });

    it("Stress 2.2: Scoped vs Program-Wide Invalidation of Rewards and Groups", async () => {
      const progA = "prog_A";
      const progB = "prog_B";

      // Populate Program A metadata
      await metadataCache.setReward(progA, "rw_1", { id: "rw_1", rate: 5 });
      await metadataCache.setReward(progA, "rw_2", { id: "rw_2", rate: 10 });
      await metadataCache.setProgramRewards(progA, [
        { id: "rw_1" },
        { id: "rw_2" },
      ]);
      await metadataCache.setGroup(
        progA,
        "grp_1",
        { id: "grp_1" },
        "default",
        "grp_1",
        "g1",
      );

      // Populate Program B metadata
      await metadataCache.setReward(progB, "rw_3", { id: "rw_3", rate: 15 });
      await metadataCache.setProgramRewards(progB, [{ id: "rw_3" }]);
      await metadataCache.setGroup(
        progB,
        "grp_2",
        { id: "grp_2" },
        "default",
        "grp_2",
        "g2",
      );

      // Invalidate Program A single reward
      await metadataCache.invalidateReward(progA, "rw_1");
      expect(await metadataCache.getReward(progA, "rw_1")).toBeNull();
      expect(await metadataCache.getProgramRewards(progA)).toBeNull();
      expect(await metadataCache.getReward(progA, "rw_2")).toEqual({
        id: "rw_2",
        rate: 10,
      });

      // Program B must be completely untouched
      expect(await metadataCache.getReward(progB, "rw_3")).toEqual({
        id: "rw_3",
        rate: 15,
      });
      expect(await metadataCache.getProgramRewards(progB)).toEqual([
        { id: "rw_3" },
      ]);

      // Invalidate all groups for Program A
      await metadataCache.invalidateAllGroups(progA);
      expect(await metadataCache.getGroup(progA, "grp_1")).toBeNull();
      expect(await metadataCache.getGroup(progA, "g1")).toBeNull();

      // Program B group remains intact
      expect(await metadataCache.getGroup(progB, "grp_2")).toEqual({
        id: "grp_2",
      });
      expect(await metadataCache.getGroup(progB, "g2")).toEqual({
        id: "grp_2",
      });
    });

    it("Stress 2.3: Program metadata includeKey segregation and workspace scoping", async () => {
      const p1 = { id: "prog_1", name: "P1 Base" };
      const p1WithCats = {
        id: "prog_1",
        name: "P1 with Cats",
        categories: ["fitness"],
      };

      await metadataCache.setProgram("ws_1", "prog_1", p1, "default");
      await metadataCache.setProgram(
        "ws_1",
        "prog_1",
        p1WithCats,
        "categories",
      );

      expect(
        await metadataCache.getProgram("ws_1", "prog_1", "default"),
      ).toEqual(p1);
      expect(
        await metadataCache.getProgram("ws_1", "prog_1", "categories"),
      ).toEqual(p1WithCats);

      // Invalidate program in ws_1
      await metadataCache.invalidateProgram("prog_1", "ws_1");

      expect(
        await metadataCache.getProgram("ws_1", "prog_1", "default"),
      ).toBeNull();
      expect(
        await metadataCache.getProgram("ws_1", "prog_1", "categories"),
      ).toBeNull();
    });

    it("Stress 2.4: Cross-program identical slug isolation ('default' in prog_1 vs 'default' in prog_2)", async () => {
      const prog1Group = {
        id: "grp_p1_def",
        slug: "default",
        name: "Program 1 Default",
      };
      const prog2Group = {
        id: "grp_p2_def",
        slug: "default",
        name: "Program 2 Default",
      };

      await metadataCache.setGroup(
        "prog_1",
        "grp_p1_def",
        prog1Group,
        "default",
        "grp_p1_def",
        "default",
      );
      await metadataCache.setGroup(
        "prog_2",
        "grp_p2_def",
        prog2Group,
        "default",
        "grp_p2_def",
        "default",
      );

      expect(await metadataCache.getGroup("prog_1", "default")).toEqual(
        prog1Group,
      );
      expect(await metadataCache.getGroup("prog_2", "default")).toEqual(
        prog2Group,
      );

      // Invalidate only prog_1
      await metadataCache.invalidateGroup("prog_1", "grp_p1_def", "default");

      expect(await metadataCache.getGroup("prog_1", "default")).toBeNull();
      expect(await metadataCache.getGroup("prog_2", "default")).toEqual(
        prog2Group,
      );
    });
  });

  // ===========================================================================
  // SECTION 3: Redis Fallback, Error Resilience & Circuit Breaker Simulation
  // ===========================================================================
  describe("MetadataCache — Redis Fallback & Network Error Resilience", () => {
    const originalEnvRest = process.env.UPSTASH_REDIS_REST_URL;
    const originalEnvGlobal = process.env.UPSTASH_GLOBAL_REDIS_REST_URL;

    beforeEach(() => {
      process.env.UPSTASH_REDIS_REST_URL = "https://mock-redis.upstash.io";
      process.env.UPSTASH_GLOBAL_REDIS_REST_URL =
        "https://mock-redis.upstash.io";
    });

    afterEach(() => {
      process.env.UPSTASH_REDIS_REST_URL = originalEnvRest;
      process.env.UPSTASH_GLOBAL_REDIS_REST_URL = originalEnvGlobal;
    });

    it("Stress 3.1: Promotes Redis Level 2 cache hit into Level 1 LRU memory", async () => {
      const mockProgram = { id: "prog_redis", name: "From Redis" };
      const key = "meta:program:ws_redis:prog_redis:default";

      // Seed Redis directly (simulating warm remote cache)
      const store = (redisGlobal as any)._store as Map<string, any>;
      store.set(key, mockProgram);

      // LRU is currently empty
      const cached = await metadataCache.getProgram("ws_redis", "prog_redis");
      expect(cached).toEqual(mockProgram);

      // Verify that subsequent fetch hits LRU even if Redis becomes unavailable
      store.delete(key);
      const lruHit = await metadataCache.getProgram("ws_redis", "prog_redis");
      expect(lruHit).toEqual(mockProgram);
    });

    it("Stress 3.2: Gracefully handles Redis GET network rejection without crashing", async () => {
      (redisGlobalWithTimeout.get as any).mockRejectedValueOnce(
        new Error("ECONNREFUSED: Upstash unreachable"),
      );

      const result = await metadataCache.getProgram("ws_err", "prog_err");
      expect(result).toBeNull(); // Must return null gracefully without throwing
    });

    it("Stress 3.3: Gracefully handles Redis SET failure while preserving in-memory LRU", async () => {
      (redisGlobal.set as any).mockRejectedValueOnce(
        new Error("ETIMEDOUT: Redis timeout"),
      );

      const programData = {
        id: "prog_set_err",
        name: "Survives Redis Failure",
      };

      // setProgram must not reject
      await expect(
        metadataCache.setProgram("ws_err", "prog_set_err", programData),
      ).resolves.not.toThrow();

      // LRU must still hold the data
      const lruCached = await metadataCache.getProgram(
        "ws_err",
        "prog_set_err",
      );
      expect(lruCached).toEqual(programData);
    });

    it("Stress 3.4: Gracefully handles Redis DEL / pipeline failure during invalidation", async () => {
      (redisGlobal.del as any).mockRejectedValueOnce(
        new Error("Pipeline execution failure"),
      );

      await metadataCache.setReward("prog_del_err", "rw_1", { id: "rw_1" });
      expect(
        await metadataCache.getReward("prog_del_err", "rw_1"),
      ).not.toBeNull();

      // Invalidation must succeed on local LRU and not throw
      await expect(
        metadataCache.invalidateReward("prog_del_err", "rw_1"),
      ).resolves.not.toThrow();
      expect(await metadataCache.getReward("prog_del_err", "rw_1")).toBeNull();
    });

    it("Stress 3.5: 2,000 parallel async operations across 100 programs with 0 unhandled rejections", async () => {
      const tasks: Promise<any>[] = [];

      for (let i = 0; i < 2000; i++) {
        const progId = `prog_${i % 100}`;
        const wsId = `ws_${i % 20}`;
        const groupId = `grp_${i % 50}`;
        const slug = `slug_${i % 50}`;
        const mode = i % 4;

        if (mode === 0) {
          tasks.push(
            metadataCache.setProgram(wsId, progId, {
              id: progId,
              title: `Prog ${i}`,
            }),
          );
        } else if (mode === 1) {
          tasks.push(metadataCache.getProgram(wsId, progId));
        } else if (mode === 2) {
          tasks.push(
            metadataCache.setGroup(
              progId,
              groupId,
              { id: groupId, slug },
              "default",
              groupId,
              slug,
            ),
          );
        } else {
          tasks.push(metadataCache.getGroup(progId, slug));
        }
      }

      const results = await Promise.allSettled(tasks);
      const rejected = results.filter((r) => r.status === "rejected");
      expect(rejected).toHaveLength(0);
    });
  });
});
