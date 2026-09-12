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
const api = sandbox.window.WeleticLoyaltyShared;
const minimum = api.loyaltyNudgeMinimumSatisfied;
const matches = api.loyaltyNudgeRewardMatchesCartLines;
const eligible = api.loyaltyCatalogNudgeEligible;
const cart = () => ({
  amountUnit: "shopify_cart_integer",
  currency: "JPY",
  subtotal: "100000",
  lines: [
    {
      productId: "1",
      variantId: "2",
      quantity: 1,
      amount: "100000",
      purchaseKind: "one_time",
      requiresShipping: true,
      giftCard: false,
      remote: false,
    },
  ],
});
const terms = () => ({
  currency: "JPY",
  currencyMinorUnits: 0,
  minOrderAmount: "1000",
  rewardType: "amount_off",
  purchasePolicy: { purchaseType: "both" },
  appliesToResource: "entire_order",
  entitledProductIds: [],
  entitledVariantIds: [],
  entitledCollectionIds: [],
});
const catalogReward = () => ({
  ...terms(),
  canRedeem: true,
  exchangeType: "fixed",
  salesChannel: "online_store",
  pointsCost: "100",
  purchasePolicy: {
    purchaseType: "one_time",
    subscriptionCadence: "first_payment",
    subscriptionPaymentLimit: null,
  },
});
const program = { isActive: true, currency: "JPY", currencyMinorUnits: 0 };
const walletReward = () => ({
  termsSource: "issuance_snapshot",
  status: "available",
  artifactKind: "discount_code",
  applyUrl: "https://fixture.myshopify.com/discount/TEST",
  rewardType: "amount_off",
  salesChannel: "online_store",
  issuedAt: "2026-09-01T00:00:00Z",
  expiresAt: null,
  termsSnapshot: {
    ...catalogReward(),
    version: 1,
    startsAt: "2026-09-01T00:00:00Z",
  },
});
const walletNow = Date.parse("2026-09-10T00:00:00Z");
it("uses issued wallet terms without affordability or mutable catalog substitution", () => {
  const reward = walletReward();
  delete (reward.termsSnapshot as any).canRedeem;
  delete (reward.termsSnapshot as any).pointsCost;
  expect(
    api.loyaltyWalletNudgeEligible(
      { ...cart(), hasAppliedDiscount: false },
      reward,
      walletNow,
    ),
  ).toBe(true);
  expect(
    api.loyaltyWalletNudgeEligible(
      { ...cart(), hasAppliedDiscount: false },
      {
        ...reward,
        termsSnapshot: { ...reward.termsSnapshot, minOrderAmount: "1001" },
      },
      walletNow,
    ),
  ).toBe(false);
});
it.each([
  { termsSource: "legacy" },
  { status: "used" },
  { status: "cancelled" },
  { artifactKind: "gift_card" },
  { applyUrl: null },
  { termsSnapshot: null },
  { issuedAt: "2026-09-11T00:00:00Z" },
  { issuedAt: "bad" },
  { expiresAt: "2026-09-10T00:00:00Z" },
  { expiresAt: undefined },
  { salesChannel: "pos" },
  { rewardType: "store_credit" },
])("rejects unproven wallet hint %j", (change) => {
  expect(
    api.loyaltyWalletNudgeEligible(
      { ...cart(), hasAppliedDiscount: false },
      { ...walletReward(), ...change },
      walletNow,
    ),
  ).toBe(false);
});
it.each([undefined, "bad", "2026-09-11T00:00:00Z"])(
  "rejects unavailable or future activation %s",
  (startsAt) => {
    const reward = walletReward();
    expect(
      api.loyaltyWalletNudgeEligible(
        { ...cart(), hasAppliedDiscount: false },
        { ...reward, termsSnapshot: { ...reward.termsSnapshot, startsAt } },
        walletNow,
      ),
    ).toBe(false);
  },
);
it.each([null, "incremental", undefined])(
  "rejects unknown or unsupported issued exchange %s",
  (exchangeType) => {
    const reward = walletReward();
    expect(
      api.loyaltyWalletNudgeEligible(
        { ...cart(), hasAppliedDiscount: false },
        { ...reward, termsSnapshot: { ...reward.termsSnapshot, exchangeType } },
        walletNow,
      ),
    ).toBe(false);
  },
);
it("counts non-shipping merchandise toward shipping minimum but requires a shipping item", () => {
  const physical = { ...cart().lines[0], amount: "100" };
  const digital = {
    ...cart().lines[0],
    productId: "9",
    variantId: "10",
    amount: "99900",
    requiresShipping: false,
  };
  const shipping = { ...catalogReward(), rewardType: "free_shipping" };
  expect(
    eligible(
      { ...cart(), hasAppliedDiscount: false, lines: [physical, digital] },
      shipping,
      program,
    ),
  ).toBe(true);
  expect(
    eligible(
      {
        ...cart(),
        hasAppliedDiscount: false,
        lines: [{ ...digital, amount: "100000" }],
      },
      shipping,
      program,
    ),
  ).toBe(false);
});
it("composes current catalog eligibility without accepting a caller eligible flag", () => {
  const current = { ...cart(), hasAppliedDiscount: false };
  expect(eligible(current, catalogReward(), program)).toBe(true);
  expect(
    eligible(
      current,
      { ...catalogReward(), eligible: true, canRedeem: false },
      program,
    ),
  ).toBe(false);
  expect(
    eligible(current, catalogReward(), { ...program, isActive: false }),
  ).toBe(false);
  expect(
    eligible(current, catalogReward(), { ...program, currency: "USD" }),
  ).toBe(false);
});
it.each([
  { exchangeType: "incremental" },
  { salesChannel: "pos" },
  { rewardType: "store_credit" },
  { pointsCost: "0" },
  { pointsCost: "1.5" },
  { canRedeem: undefined },
  { purchasePolicy: null },
  {
    purchasePolicy: {
      purchaseType: "both",
      subscriptionCadence: "first_n_payments",
      subscriptionPaymentLimit: 1,
    },
  },
  {
    purchasePolicy: {
      purchaseType: "one_time",
      subscriptionCadence: "every_payment",
      subscriptionPaymentLimit: null,
    },
  },
  {
    purchasePolicy: {
      purchaseType: "subscription",
      subscriptionCadence: "every_payment",
      subscriptionPaymentLimit: 2,
    },
  },
])("suppresses unproven catalog eligibility %j", (change) => {
  expect(
    eligible(
      { ...cart(), hasAppliedDiscount: false },
      { ...catalogReward(), ...change },
      program,
    ),
  ).toBe(false);
});
it.each([true, undefined, null])(
  "suppresses applied or unknown discounts %j",
  (hasAppliedDiscount) => {
    expect(
      eligible({ ...cart(), hasAppliedDiscount }, catalogReward(), program),
    ).toBe(false);
  },
);
it.each([
  ["first_payment", null],
  ["first_n_payments", 3],
  ["every_payment", null],
])(
  "supports initial subscription cart for valid %s policy without inventing renewal evidence",
  (subscriptionCadence, subscriptionPaymentLimit) => {
    const current = {
      ...cart(),
      hasAppliedDiscount: false,
      lines: [{ ...cart().lines[0], purchaseKind: "subscription" }],
    };
    expect(
      eligible(
        current,
        {
          ...catalogReward(),
          purchasePolicy: {
            purchaseType: "subscription",
            subscriptionCadence,
            subscriptionPaymentLimit,
          },
        },
        program,
      ),
    ).toBe(true);
    expect(eligible(current, catalogReward(), program)).toBe(false);
  },
);
it("composes targeted minimum and exact affordability with the actual selector", () => {
  const current = { ...cart(), hasAppliedDiscount: false };
  const reward = {
    ...catalogReward(),
    pointsCost: "9007199254740993",
    appliesToResource: "specific_items",
    entitledProductIds: ["1"],
  };
  const candidate = { ...reward, eligible: eligible(current, reward, program) };
  const context = {
    stateFresh: true,
    programActive: true,
    launcherVisible: true,
    authenticated: true,
    cartPage: true,
    cartHasItems: true,
    hasAppliedDiscount: false,
    nowMs: 1,
    enabled: { points_spending: true },
    rewards: [candidate],
    availablePoints: "9007199254740993",
  };
  expect(api.selectLoyaltyNudge(context)).toBe("points_spending");
  expect(
    api.selectLoyaltyNudge({ ...context, availablePoints: "9007199254740992" }),
  ).toBeNull();
  expect(
    eligible(current, { ...reward, minOrderAmount: "1001" }, program),
  ).toBe(false);
});
it.each([
  ["JPY", 0, "100000", "1000"],
  ["USD", 2, "1000", "1000"],
])("compares %s without float rounding", (currency, digits, subtotal, min) => {
  const current = {
    ...cart(),
    currency,
    subtotal,
    lines: [{ ...cart().lines[0], amount: subtotal }],
  };
  const policy = {
    ...terms(),
    currency,
    currencyMinorUnits: digits,
    minOrderAmount: min,
  };
  expect(minimum(current, policy)).toBe(true);
  expect(
    minimum(
      {
        ...current,
        subtotal: (BigInt(subtotal as string) - BigInt(1)).toString(),
        lines: [
          {
            ...cart().lines[0],
            amount: (BigInt(subtotal as string) - BigInt(1)).toString(),
          },
        ],
      },
      policy,
    ),
  ).toBe(false);
});
it("compares large values exactly", () => {
  expect(
    minimum(
      {
        ...cart(),
        lines: [{ ...cart().lines[0], amount: "900719925474099300" }],
      },
      { ...terms(), minOrderAmount: "9007199254740993" },
    ),
  ).toBe(true);
  expect(
    minimum(
      {
        ...cart(),
        lines: [{ ...cart().lines[0], amount: "900719925474099299" }],
      },
      { ...terms(), minOrderAmount: "9007199254740993" },
    ),
  ).toBe(false);
});
it.each([
  { currency: "USD" },
  { currencyMinorUnits: undefined },
  { currencyMinorUnits: -1 },
  { currencyMinorUnits: 4 },
  { currencyMinorUnits: 1 },
  { currency: "KWD", currencyMinorUnits: 3 },
  { minOrderAmount: "-1" },
  { minOrderAmount: "1.5" },
])("rejects unproven money comparison %j", (change) => {
  expect(minimum(cart(), { ...terms(), ...change })).toBe(false);
});
it("matches product and variant IDs without crossing resource namespaces", () => {
  expect(
    matches(cart(), {
      ...terms(),
      appliesToResource: "specific_items",
      entitledProductIds: ["gid://shopify/Product/1"],
    }),
  ).toBe(true);
  expect(
    matches(cart(), {
      ...terms(),
      appliesToResource: "specific_items",
      entitledVariantIds: ["gid://shopify/ProductVariant/2"],
    }),
  ).toBe(true);
  expect(
    matches(cart(), {
      ...terms(),
      appliesToResource: "specific_items",
      entitledProductIds: ["gid://shopify/ProductVariant/1"],
    }),
  ).toBe(false);
});
it("requires explicit collection membership and rejects hidden/mixed scopes", () => {
  const scoped = {
    ...terms(),
    appliesToResource: "specific_items",
    entitledCollectionIds: ["gid://shopify/Collection/3"],
  };
  expect(matches(cart(), scoped)).toBe(false);
  expect(matches(cart(), scoped, { "1": ["3"] })).toBe(true);
  expect(matches(cart(), scoped, { "1": ["4"] })).toBe(false);
  expect(
    matches(cart(), { ...scoped, entitledProductIds: ["1"] }, { "1": ["3"] }),
  ).toBe(false);
  expect(
    matches(
      cart(),
      { ...scoped, appliesToResource: "entire_order" },
      { "1": ["3"] },
    ),
  ).toBe(false);
});
it("intersects purchase type on the same targeted line", () => {
  const current = cart();
  current.lines.push({
    ...current.lines[0],
    productId: "9",
    purchaseKind: "subscription",
  });
  const scoped = {
    ...terms(),
    purchasePolicy: { purchaseType: "subscription" },
    appliesToResource: "specific_items",
    entitledProductIds: ["1"],
  };
  expect(matches(current, scoped)).toBe(false);
  expect(matches(current, { ...scoped, entitledProductIds: ["9"] })).toBe(true);
});
it.each([
  { remote: true },
  { remote: undefined },
  { giftCard: true },
  { quantity: 0 },
  { purchaseKind: "unknown" },
])("excludes unsupported line %j", (change) => {
  const current = cart();
  expect(
    matches(
      { ...current, lines: [{ ...current.lines[0], ...change }] },
      terms(),
    ),
  ).toBe(false);
});
it("requires a shippable matched line for a shipping reward", () => {
  const current = cart();
  current.lines[0].requiresShipping = false;
  expect(matches(current, { ...terms(), rewardType: "free_shipping" })).toBe(
    false,
  );
});
it("does not let unrelated or wrong-purchase lines meet a scoped minimum", () => {
  const current = {
    ...cart(),
    currency: "USD",
    subtotal: "10000",
    lines: [
      { ...cart().lines[0], amount: "100" },
      { ...cart().lines[0], productId: "9", amount: "9900" },
    ],
  };
  const scoped = {
    ...terms(),
    currency: "USD",
    currencyMinorUnits: 2,
    minOrderAmount: "10000",
    appliesToResource: "specific_items",
    entitledProductIds: ["1"],
  };
  expect(matches(current, scoped)).toBe(true);
  expect(minimum(current, scoped)).toBe(false);
  expect(minimum(current, { ...scoped, minOrderAmount: "100" })).toBe(true);
  const collection = {
    ...scoped,
    entitledProductIds: [],
    entitledCollectionIds: ["3"],
  };
  expect(minimum(current, collection, { "1": ["3"], "9": ["4"] })).toBe(false);
  expect(minimum(current, collection, { "1": ["3"], "9": ["3"] })).toBe(true);
  current.lines[1].productId = "1";
  current.lines[1].purchaseKind = "subscription";
  expect(
    minimum(current, {
      ...scoped,
      purchasePolicy: { purchaseType: "one_time" },
    }),
  ).toBe(false);
});
