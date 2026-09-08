import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  set: vi.fn(),
  eval: vi.fn(),
}));

vi.mock("@/lib/upstash", () => ({ redis: mocks }));
vi.mock("@dub/utils", () => ({ nanoid: () => "lock-token" }));

import { withDistributedLock } from "@/lib/weletic/redis-lock";

describe("distributed lock lease renewal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.set.mockReset().mockResolvedValue("OK");
    mocks.eval.mockReset().mockResolvedValue(1);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews a token-owned lease while the protected operation is running", async () => {
    const result = withDistributedLock({
      key: "settlement:customer:1",
      ttlSeconds: 3,
      fn: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3_500));
        return "settled";
      },
    });

    await vi.advanceTimersByTimeAsync(3_500);

    await expect(result).resolves.toBe("settled");
    expect(
      mocks.eval.mock.calls.some(
        ([script, keys, args]) =>
          String(script).includes("expire") &&
          keys[0] === "settlement:customer:1" &&
          args[0] === "lock-token" &&
          args[1] === "3",
      ),
    ).toBe(true);
  });
});
