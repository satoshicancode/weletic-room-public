import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { expect, it, vi } from "vitest";
const sandbox = { window: {} as any };
vm.runInNewContext(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../../packages/shopify-app/extensions/weletic-analytics/assets/weletic-loyalty-shared.js",
    ),
    "utf8",
  ),
  sandbox,
);
const claim = sandbox.window.WeleticLoyaltyShared.claimLoyaltyNudgeImpression;
function fixture() {
  let value: string | null = null;
  let tail = Promise.resolve();
  const storage = {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
  };
  const locks = {
    request: vi.fn(
      (_key: string, _options: unknown, callback: () => boolean) => {
        const result = tail.then(callback);
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    ),
  };
  return {
    kind: "points_spending",
    nowMs: 100000000,
    isEligible: () => true,
    storage,
    locks,
  };
}
it("admits only one concurrent cart prompt across both kinds", async () => {
  const input = fixture();
  expect(
    await Promise.all([
      claim(input),
      claim({ ...input, kind: "reward_usage" }),
      claim(input),
    ]),
  ).toEqual([true, false, false]);
  expect(input.storage.setItem).toHaveBeenCalledTimes(1);
  expect(input.locks.request).toHaveBeenCalledWith(
    "weletic.loyalty.nudges.v1",
    { mode: "exclusive" },
    expect.any(Function),
  );
});
it("honors exact 24-hour boundary and suppresses clock rollback", async () => {
  const input = fixture();
  expect(await claim(input)).toBe(true);
  for (const elapsed of [-1, 0, 86399999])
    expect(await claim({ ...input, nowMs: input.nowMs + elapsed })).toBe(false);
  expect(await claim({ ...input, nowMs: input.nowMs + 86400000 })).toBe(true);
});
it("remembers signup separately from cart prompts without private identifiers", async () => {
  const input = fixture();
  expect(await claim({ ...input, kind: "signup" })).toBe(true);
  expect(await claim({ ...input, kind: "signup" })).toBe(false);
  expect(await claim(input)).toBe(true);
  expect(JSON.parse(input.storage.getItem()!)).toEqual({
    version: 1,
    signupSeen: true,
    cartAt: input.nowMs,
  });
});
it.each([null, {}, { request: undefined }])(
  "suppresses without usable locks %j",
  async (locks) => {
    const input = fixture();
    expect(await claim({ ...input, locks })).toBe(false);
    expect(input.storage.setItem).not.toHaveBeenCalled();
  },
);
it.each([
  "{",
  "null",
  "[]",
  '{"version":2,"signupSeen":false,"cartAt":null}',
  '{"version":1,"signupSeen":false,"cartAt":-1}',
  '{"version":1,"signupSeen":false,"cartAt":null,"customerId":"x"}',
])("does not overwrite corrupt or unexpected storage %s", async (raw) => {
  const input = fixture();
  input.storage.getItem.mockReturnValue(raw);
  expect(await claim(input)).toBe(false);
  expect(input.storage.setItem).not.toHaveBeenCalled();
});
it("suppresses blocked or silently discarded storage writes", async () => {
  const input = fixture();
  input.storage.setItem.mockImplementation(() => {
    throw new Error("denied");
  });
  expect(await claim(input)).toBe(false);
  input.storage.setItem.mockImplementation(() => {});
  expect(await claim(input)).toBe(false);
});
it("rechecks current eligibility after waiting for the lock", async () => {
  const input = fixture();
  let eligible = true;
  const pending = claim({ ...input, isEligible: () => eligible });
  eligible = false;
  expect(await pending).toBe(false);
  expect(input.storage.setItem).not.toHaveBeenCalled();
  expect(await claim({ ...input, isEligible: async () => true })).toBe(false);
});
it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  "rejects invalid local clocks %s",
  async (nowMs) => {
    const input = fixture();
    expect(await claim({ ...input, nowMs })).toBe(false);
    expect(input.locks.request).not.toHaveBeenCalled();
  },
);
