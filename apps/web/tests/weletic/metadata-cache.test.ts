import { beforeEach, describe, expect, it, vi } from "vitest";

const upstashMocks = vi.hoisted(() => {
  const pipeline = {
    del: vi.fn(),
    exec: vi.fn().mockResolvedValue([]),
  };

  return {
    pipeline,
    redisGlobal: {
      del: vi.fn().mockResolvedValue(1),
      pipeline: vi.fn(() => pipeline),
      set: vi.fn().mockResolvedValue("OK"),
    },
    redisGlobalWithTimeout: {
      get: vi.fn().mockResolvedValue(null),
    },
  };
});

vi.mock("@/lib/upstash", () => ({
  redisGlobal: upstashMocks.redisGlobal,
  redisGlobalWithTimeout: upstashMocks.redisGlobalWithTimeout,
}));

import { metadataCache } from "@/lib/api/metadata-cache";

describe("MetadataCache (Server-Side Metadata Caching Layer)", () => {
  beforeEach(() => {
    metadataCache.clear();
  });

  describe("Program Metadata Caching", () => {
    it("caches and retrieves program metadata by workspace and program ID", async () => {
      const mockProgram = {
        id: "prog_123",
        workspaceId: "ws_123",
        name: "Partner Program",
        slug: "partners",
      };

      await metadataCache.setProgram("ws_123", "prog_123", mockProgram);

      const cached = await metadataCache.getProgram("ws_123", "prog_123");
      expect(cached).toEqual(mockProgram);

      // Miss on different include key
      const cachedInclude = await metadataCache.getProgram(
        "ws_123",
        "prog_123",
        JSON.stringify({ categories: true }),
      );
      expect(cachedInclude).toBeNull();
    });

    it("invalidates program metadata by workspace and program ID", async () => {
      const mockProgram = {
        id: "prog_123",
        workspaceId: "ws_123",
        name: "Alpha",
      };
      await metadataCache.setProgram("ws_123", "prog_123", mockProgram);
      await metadataCache.setProgram(
        "ws_123",
        "prog_123",
        mockProgram,
        JSON.stringify({ categories: true }),
      );

      await metadataCache.invalidateProgram("prog_123", "ws_123");

      expect(await metadataCache.getProgram("ws_123", "prog_123")).toBeNull();
      expect(
        await metadataCache.getProgram(
          "ws_123",
          "prog_123",
          JSON.stringify({ categories: true }),
        ),
      ).toBeNull();
    });
  });

  describe("Partner Group Dual-Index Metadata Caching", () => {
    it("dual-indexes partner group lookups by ID and slug", async () => {
      const mockGroup = {
        id: "grp_456",
        programId: "prog_123",
        name: "VIP Affiliates",
        slug: "vip",
      };

      // Set cache with resolved ID and slug
      await metadataCache.setGroup(
        "prog_123",
        "grp_456",
        mockGroup,
        "default",
        mockGroup.id,
        mockGroup.slug,
      );

      // Retrieve by group ID
      const byId = await metadataCache.getGroup("prog_123", "grp_456");
      expect(byId).toEqual(mockGroup);

      // Retrieve by group slug without additional DB fetch
      const bySlug = await metadataCache.getGroup("prog_123", "vip");
      expect(bySlug).toEqual(mockGroup);
    });

    it("invalidates partner group across all aliases (ID and slugs)", async () => {
      const mockGroup = {
        id: "grp_456",
        programId: "prog_123",
        name: "VIP Affiliates",
        slug: "vip",
      };

      await metadataCache.setGroup(
        "prog_123",
        "grp_456",
        mockGroup,
        "default",
        mockGroup.id,
        mockGroup.slug,
      );

      // Invalidate by group ID and old slug
      await metadataCache.invalidateGroup(
        "prog_123",
        "grp_456",
        "vip",
        "old-vip",
      );

      expect(await metadataCache.getGroup("prog_123", "grp_456")).toBeNull();
      expect(await metadataCache.getGroup("prog_123", "vip")).toBeNull();
    });

    it("invalidates all groups for a program via invalidateAllGroups()", async () => {
      const group1 = { id: "grp_1", programId: "prog_123", slug: "g1" };
      const group2 = { id: "grp_2", programId: "prog_123", slug: "g2" };

      await metadataCache.setGroup(
        "prog_123",
        "grp_1",
        group1,
        "default",
        "grp_1",
        "g1",
      );
      await metadataCache.setGroup(
        "prog_123",
        "grp_2",
        group2,
        "default",
        "grp_2",
        "g2",
      );

      await metadataCache.invalidateAllGroups("prog_123");

      expect(await metadataCache.getGroup("prog_123", "grp_1")).toBeNull();
      expect(await metadataCache.getGroup("prog_123", "grp_2")).toBeNull();
      expect(await metadataCache.getGroup("prog_123", "g1")).toBeNull();
      expect(await metadataCache.getGroup("prog_123", "g2")).toBeNull();
    });
  });

  describe("Reward Metadata Caching", () => {
    it("caches and invalidates single reward and program rewards list", async () => {
      const mockReward = {
        id: "rw_789",
        programId: "prog_123",
        event: "sale",
        type: "percentage",
        amountInPercentage: 15,
      };
      const mockRewardsList = [mockReward];

      await metadataCache.setReward("prog_123", "rw_789", mockReward);
      await metadataCache.setProgramRewards("prog_123", mockRewardsList);

      expect(await metadataCache.getReward("prog_123", "rw_789")).toEqual(
        mockReward,
      );
      expect(await metadataCache.getProgramRewards("prog_123")).toEqual(
        mockRewardsList,
      );

      // Invalidate specific reward
      await metadataCache.invalidateReward("prog_123", "rw_789");

      expect(await metadataCache.getReward("prog_123", "rw_789")).toBeNull();
      expect(await metadataCache.getProgramRewards("prog_123")).toBeNull();
    });

    it("invalidates all rewards for a program when rewardId is omitted", async () => {
      const r1 = { id: "rw_1", programId: "prog_123" };
      const r2 = { id: "rw_2", programId: "prog_123" };

      await metadataCache.setReward("prog_123", "rw_1", r1);
      await metadataCache.setReward("prog_123", "rw_2", r2);

      await metadataCache.invalidateReward("prog_123");

      expect(await metadataCache.getReward("prog_123", "rw_1")).toBeNull();
      expect(await metadataCache.getReward("prog_123", "rw_2")).toBeNull();
    });
  });
});
