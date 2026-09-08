import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { metadataCache } from "@/lib/api/metadata-cache";
import { workspaceAuthCache } from "@/lib/auth/workspace-cache";
import { WorkspaceWithUsers } from "@/lib/types";
import { redisGlobal } from "@/lib/upstash";

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

describe("Cache release invariants", () => {
  const createMockWorkspace = (id: string, slug: string): WorkspaceWithUsers =>
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
          role: "owner",
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

  describe("1. Workspace Auth LRU Cache", () => {
    it("1.1: returns a cached workspace without changing its data", () => {
      const ws = createMockWorkspace("ws_micro_1", "micro-1");
      const userId = "usr_micro_bench";

      workspaceAuthCache.set({ workspace: ws, userId });

      const cached = workspaceAuthCache.get({
        identifier: "ws_micro_1",
        userId,
      });

      expect(cached?.id).toBe("ws_micro_1");
      expect(cached?.slug).toBe("micro-1");
    });

    it("1.2: maintains 99%+ hit rate under high concurrent reads across 500 workspaces", () => {
      const workspaceCount = 500;
      const users = ["usr_1", "usr_2", "usr_3", "usr_4", "usr_5"];

      // Seed all workspaces
      for (let i = 0; i < workspaceCount; i++) {
        const ws = createMockWorkspace(`ws_${i}`, `slug-${i}`);
        for (const user of users) {
          workspaceAuthCache.set({ workspace: ws, userId: user });
        }
      }

      let hits = 0;
      let misses = 0;
      const iterations = 5000;

      for (let i = 0; i < iterations; i++) {
        const wsId = `ws_${i % workspaceCount}`;
        const user = users[i % users.length];
        const res = workspaceAuthCache.get({ identifier: wsId, userId: user });
        if (res) hits++;
        else misses++;
      }

      const hitRate = hits / (hits + misses);
      expect(hitRate).toBeGreaterThanOrEqual(0.99);
      expect(hits).toBe(iterations);
    });

    it("1.3: keeps identical workspace identifiers isolated by user", () => {
      const ws = createMockWorkspace("ws_shared", "shared");
      workspaceAuthCache.set({ workspace: ws, userId: "usr_a" });

      expect(
        workspaceAuthCache.get({ identifier: "ws_shared", userId: "usr_a" }),
      ).not.toBeNull();
      expect(
        workspaceAuthCache.get({ identifier: "ws_shared", userId: "usr_b" }),
      ).toBeNull();
    });
  });

  describe("2. Server-Side MetadataCache", () => {
    it("2.1: resolves partner groups through both ID and slug indexes", async () => {
      const progId = "prog_dual_perf";
      const grpId = "grp_dual_perf";
      const slug = "elite-tier";
      const groupData = { id: grpId, name: "Elite", slug, rate: 2000 };

      await metadataCache.setGroup(
        progId,
        grpId,
        groupData,
        "default",
        grpId,
        slug,
      );

      const byId = await metadataCache.getGroup(progId, grpId);
      const bySlug = await metadataCache.getGroup(progId, slug);

      expect(byId).toEqual(groupData);
      expect(bySlug).toEqual(groupData);
    });

    it("2.2: batch invalidation clears every ID and slug index", async () => {
      const progId = "prog_batch_invalidation";

      for (let i = 0; i < 50; i++) {
        await metadataCache.setGroup(
          progId,
          `grp_${i}`,
          { id: `grp_${i}`, slug: `slug_${i}` },
          "default",
          `grp_${i}`,
          `slug_${i}`,
        );
      }

      await metadataCache.invalidateAllGroups(progId);

      expect(await metadataCache.getGroup(progId, "grp_0")).toBeNull();
      expect(await metadataCache.getGroup(progId, "slug_0")).toBeNull();
    });
  });

  describe("3. Memory & Resource Leak Isolation", () => {
    it("3.1: memory consumption remains bounded across 50,000 cyclic write/eviction operations", () => {
      const CustomCacheClass = workspaceAuthCache.constructor as any;
      const maxEntries = 1000;
      const cache = new CustomCacheClass({ max: maxEntries, ttl: 60000 });

      for (let i = 0; i < 50000; i++) {
        const ws = createMockWorkspace(
          `ws_cycle_${i % 2000}`,
          `cycle-${i % 2000}`,
        );
        cache.set({ workspace: ws, userId: `usr_${i % 100}` });
      }

      expect(cache.size).toBeLessThanOrEqual(maxEntries);
    });
  });
});
