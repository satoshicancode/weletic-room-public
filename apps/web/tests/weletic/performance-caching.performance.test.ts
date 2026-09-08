import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { metadataCache } from "@/lib/api/metadata-cache";
import { workspaceAuthCache } from "@/lib/auth/workspace-cache";
import { WorkspaceWithUsers } from "@/lib/types";
import { redisGlobal } from "@/lib/upstash";

vi.mock("@/lib/upstash", () => {
  const store = new Map<string, unknown>();
  return {
    redisGlobal: {
      set: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
        return "OK";
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      del: vi.fn(async (key: string) => {
        store.delete(key);
        return 1;
      }),
      pipeline: vi.fn(() => ({
        del: vi.fn(function (this: unknown, key: string) {
          store.delete(key);
          return this;
        }),
        exec: vi.fn(async () => []),
      })),
      _store: store,
    },
    redisGlobalWithTimeout: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
    },
  };
});

const createMockWorkspace = (id: string): WorkspaceWithUsers =>
  ({
    id,
    name: `Workspace ${id}`,
    slug: id,
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
    users: [{ role: "owner", defaultFolderId: null }],
  }) as unknown as WorkspaceWithUsers;

describe("Cache wall-clock benchmarks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceAuthCache.clear();
    metadataCache.clear();
    const store = (redisGlobal as unknown as { _store: Map<string, unknown> })
      ._store;
    store.clear();
  });

  it("measures 5,000 in-memory authorization lookups", () => {
    const userId = "usr_benchmark";
    workspaceAuthCache.set({
      workspace: createMockWorkspace("ws_benchmark"),
      userId,
    });

    const iterations = 5000;
    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      expect(
        workspaceAuthCache.get({ identifier: "ws_benchmark", userId }),
      ).not.toBeNull();
    }
    const totalElapsed = performance.now() - start;

    expect(totalElapsed).toBeLessThan(250);
    expect(totalElapsed / iterations).toBeLessThan(0.05);
  });

  it("measures metadata dual-index resolution", async () => {
    const group = { id: "grp_benchmark", slug: "benchmark", name: "Benchmark" };
    await metadataCache.setGroup(
      "prog_benchmark",
      group.id,
      group,
      "default",
      group.id,
      group.slug,
    );

    const start = performance.now();
    const byId = await metadataCache.getGroup("prog_benchmark", group.id);
    const bySlug = await metadataCache.getGroup("prog_benchmark", group.slug);
    const elapsed = performance.now() - start;

    expect(byId).toEqual(group);
    expect(bySlug).toEqual(group);
    expect(elapsed).toBeLessThan(10);
  });

  it("measures batch invalidation across 100 metadata indexes", async () => {
    for (let i = 0; i < 50; i++) {
      await metadataCache.setGroup(
        "prog_invalidation_benchmark",
        `grp_${i}`,
        { id: `grp_${i}`, slug: `slug_${i}` },
        "default",
        `grp_${i}`,
        `slug_${i}`,
      );
    }

    const start = performance.now();
    await metadataCache.invalidateAllGroups("prog_invalidation_benchmark");
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(15);
  });
});
