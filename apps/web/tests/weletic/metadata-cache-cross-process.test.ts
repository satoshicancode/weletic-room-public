import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisStore = new Map<string, unknown>();

vi.mock("@/lib/upstash", () => ({
  redisGlobal: {
    set: vi.fn(async (key: string, value: unknown) => {
      redisStore.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (key: string) => (redisStore.delete(key) ? 1 : 0)),
    pipeline: vi.fn(() => ({
      del(key: string) {
        redisStore.delete(key);
        return this;
      },
      exec: vi.fn(async () => []),
    })),
  },
  redisGlobalWithTimeout: {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
  },
}));

import { MetadataCache } from "@/lib/api/metadata-cache";

describe("MetadataCache distributed invalidation", () => {
  const originalUrl = process.env.UPSTASH_REDIS_REST_URL;

  beforeEach(() => {
    redisStore.clear();
    process.env.UPSTASH_REDIS_REST_URL = "https://mock-redis.example";
  });

  afterEach(() => {
    process.env.UPSTASH_REDIS_REST_URL = originalUrl;
  });

  it("rejects a stale LRU value after another process invalidates the scope", async () => {
    const writer = new MetadataCache();
    const reader = new MetadataCache();

    await writer.setGroup(
      "program_1",
      "group_1",
      { id: "group_1", rate: 10 },
      "default",
      "group_1",
      "default",
    );
    expect(await reader.getGroup("program_1", "group_1")).toEqual({
      id: "group_1",
      rate: 10,
    });

    await writer.invalidateGroup("program_1", "group_1", "default");
    await writer.setGroup(
      "program_1",
      "group_1",
      { id: "group_1", rate: 25 },
      "default",
      "group_1",
      "default",
    );

    expect(await reader.getGroup("program_1", "group_1")).toEqual({
      id: "group_1",
      rate: 25,
    });
  });
});
