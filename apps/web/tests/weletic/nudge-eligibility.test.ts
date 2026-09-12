import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { expect, it } from "vitest";
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
const select = sandbox.window.WeleticLoyaltyShared.selectLoyaltyNudge;
const reward = {
  eligible: true,
  exchangeType: "fixed",
  salesChannel: "online_store",
  rewardType: "amount_off",
  pointsCost: "9007199254740993",
};
const context = () => ({
  stateFresh: true,
  programActive: true,
  launcherVisible: true,
  authenticated: true,
  cartPage: true,
  cartHasItems: true,
  hasAppliedDiscount: false,
  nowMs: Date.parse("2026-09-10T00:00:00Z"),
  enabled: { signup: true, points_spending: true, reward_usage: true },
  availablePoints: "9007199254740993",
  rewards: [reward],
  wallet: [] as any[],
});
it.each(["-1", "garbage", "1.5", Number.MAX_SAFE_INTEGER + 1, null])(
  "rejects invalid points %j",
  (points) => {
    expect(select({ ...context(), availablePoints: points })).toBeNull();
    expect(
      select({ ...context(), rewards: [{ ...reward, pointsCost: points }] }),
    ).toBeNull();
  },
);
it("rejects unknown types/channels and missing projection inputs", () => {
  expect(
    select({ ...context(), rewards: [{ ...reward, rewardType: "future" }] }),
  ).toBeNull();
  expect(
    select({ ...context(), rewards: [{ ...reward, salesChannel: "pos" }] }),
  ).toBeNull();
  expect(select({ ...context(), rewards: null, wallet: {} })).toBeNull();
  expect(select({ ...context(), hasAppliedDiscount: undefined })).toBeNull();
  expect(select({ ...context(), enabled: {} })).toBeNull();
});
it("honors each disabled policy and exact expiry boundaries", () => {
  const wallet = [{ ...reward, status: "available", expiresAt: null }];
  expect(
    select({
      ...context(),
      wallet,
      rewards: [],
      enabled: { reward_usage: false },
    }),
  ).toBeNull();
  expect(
    select({ ...context(), enabled: { points_spending: false } }),
  ).toBeNull();
  expect(
    select({
      ...context(),
      authenticated: false,
      firstVisit: true,
      enabled: { signup: false },
    }),
  ).toBeNull();
  for (const delta of [-1, 1]) {
    const input = context();
    input.rewards = [];
    input.wallet = [
      { ...wallet[0], expiresAt: new Date(input.nowMs + delta).toISOString() },
    ];
    expect(select(input)).toBe(delta > 0 ? "reward_usage" : null);
  }
});
it("compares affordability exactly above Number precision", () => {
  expect(select(context())).toBe("points_spending");
  expect(
    select({ ...context(), availablePoints: "9007199254740992" }),
  ).toBeNull();
});
it("gives usable wallet rewards precedence and respects applied discounts", () => {
  const input = context();
  input.wallet = [{ ...reward, status: "available", expiresAt: null }];
  expect(select(input)).toBe("reward_usage");
  expect(select({ ...input, hasAppliedDiscount: true })).toBe(
    "points_spending",
  );
});
it.each(["gift_card", "store_credit"])(
  "excludes %s from both prompts",
  (rewardType) => {
    const excluded = {
      ...reward,
      rewardType,
      status: "available",
      expiresAt: null,
    };
    expect(
      select({ ...context(), rewards: [excluded], wallet: [excluded] }),
    ).toBeNull();
  },
);
it.each([
  "stateFresh",
  "programActive",
  "launcherVisible",
  "cartPage",
  "cartHasItems",
])("suppresses when %s is false", (field) => {
  expect(select({ ...context(), [field]: false })).toBeNull();
});
it.each(["used", "expired", "cancelled"])(
  "ignores %s wallet artifacts",
  (status) => {
    expect(
      select({
        ...context(),
        rewards: [],
        wallet: [{ ...reward, status, expiresAt: null }],
      }),
    ).toBeNull();
  },
);
it("rejects expiry boundaries, unavailable and variable rewards", () => {
  for (const overrides of [
    { expiresAt: "2026-09-10T00:00:00Z" },
    { expiresAt: "invalid" },
    { eligible: false },
    { exchangeType: "incremental" },
  ]) {
    expect(
      select({
        ...context(),
        rewards: [],
        wallet: [
          { ...reward, status: "available", expiresAt: null, ...overrides },
        ],
      }),
    ).toBeNull();
  }
});
it("requires first visit and enabled signup for a guest; never prompts unknown authentication", () => {
  expect(select({ ...context(), authenticated: false, firstVisit: true })).toBe(
    "signup",
  );
  expect(
    select({ ...context(), authenticated: false, firstVisit: false }),
  ).toBeNull();
  expect(
    select({ ...context(), authenticated: undefined, firstVisit: true }),
  ).toBeNull();
  expect(
    select({
      ...context(),
      authenticated: false,
      firstVisit: true,
      enabled: {},
    }),
  ).toBeNull();
});
