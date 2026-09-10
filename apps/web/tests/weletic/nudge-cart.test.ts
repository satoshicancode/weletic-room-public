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
const normalize = sandbox.window.WeleticLoyaltyShared.normalizeLoyaltyNudgeCart;
const line = () => ({
  product_id: 123,
  variant_id: 456,
  quantity: 1,
  final_line_price: 1000,
  requires_shipping: true,
  gift_card: false,
});
const cart = () => ({
  currency: "JPY",
  total_price: 1000,
  items_subtotal_price: 1000,
  total_discount: 0,
  item_count: 1,
  cart_level_discount_applications: [],
  items: [line()],
});
it("projects only necessary cart facts, excluding tokens and freeform properties", () => {
  const input = {
    ...cart(),
    token: "private-token",
    note: "private-note",
    attributes: { email: "private-email" },
    items: [
      { ...line(), key: "private-key", properties: { name: "private-name" } },
    ],
  };
  const result = normalize(input);
  expect(result).toEqual({
    amountUnit: "shopify_cart_integer",
    currency: "JPY",
    total: "1000",
    subtotal: "1000",
    discount: "0",
    hasAppliedDiscount: false,
    lines: [
      {
        productId: "123",
        variantId: "456",
        quantity: 1,
        amount: "1000",
        purchaseKind: "one_time",
        requiresShipping: true,
        giftCard: false,
        remote: false,
      },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("private");
});
it("retains exact large integer amounts without pretending currency conversion", () => {
  const result = normalize({
    ...cart(),
    total_price: "9007199254740993",
    items_subtotal_price: "9007199254740993",
    items: [{ ...line(), final_line_price: "9007199254740993" }],
  });
  expect(result.total).toBe("9007199254740993");
  expect(result.amountUnit).toBe("shopify_cart_integer");
});
it("keeps subscription and one-time lines separate without inventing renewal sequence", () => {
  const result = normalize({
    ...cart(),
    item_count: 2,
    items: [
      line(),
      { ...line(), selling_plan_allocation: { selling_plan: { id: 789 } } },
    ],
  });
  expect(
    result.lines.map((item: { purchaseKind: string }) => item.purchaseKind),
  ).toEqual(["one_time", "subscription"]);
  expect(JSON.stringify(result)).not.toContain("sequence");
});
it.each([
  null,
  {},
  { currency: "usd" },
  { item_count: 2 },
  { items: "invalid" },
  { cart_level_discount_applications: null },
])("rejects malformed cart %j", (change) => {
  expect(
    normalize(
      change === null
        ? null
        : Object.keys(change).length === 0
          ? {}
          : { ...cart(), ...change },
    ),
  ).toBeNull();
});
it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1e3", "abc", null])(
  "rejects unsafe amount %j",
  (amount) => {
    expect(normalize({ ...cart(), total_price: amount })).toBeNull();
    expect(
      normalize({
        ...cart(),
        items: [{ ...line(), final_line_price: amount }],
      }),
    ).toBeNull();
  },
);
it.each([
  { quantity: 0 },
  { quantity: 1.5 },
  { product_id: 0 },
  { variant_id: Number.MAX_SAFE_INTEGER + 1 },
  { gift_card: null },
  { requires_shipping: undefined },
  { selling_plan_allocation: {} },
])("rejects unknown line facts %j", (change) => {
  expect(
    normalize({ ...cart(), items: [{ ...line(), ...change }] }),
  ).toBeNull();
});
it("supports empty carts and detects discounts without copying codes", () => {
  expect(
    normalize({
      ...cart(),
      item_count: 0,
      items: [],
      total_price: 0,
      items_subtotal_price: 0,
    }).lines,
  ).toEqual([]);
  expect(normalize({ ...cart(), total_discount: 1 }).hasAppliedDiscount).toBe(
    true,
  );
  const result = normalize({
    ...cart(),
    cart_level_discount_applications: [{ title: "private-code" }],
  });
  expect(result.hasAppliedDiscount).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private-code");
});
it("loads a locale-aware cart with read-only uncached same-origin transport", async () => {
  sandbox.window.fetch = vi
    .fn()
    .mockResolvedValue({ ok: true, json: async () => cart() });
  const result =
    await sandbox.window.WeleticLoyaltyShared.loadLoyaltyNudgeCart("/ja/");
  expect(result.currency).toBe("JPY");
  expect(sandbox.window.fetch).toHaveBeenCalledWith(
    "/ja/cart.js",
    expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    }),
  );
});
it.each([
  "//evil.test/",
  "https://evil.test/",
  "/../",
  "/ja/?",
  "/%2f/",
  "ja/",
])("never fetches an invalid locale root %s", async (root) => {
  sandbox.window.fetch = vi.fn();
  expect(
    await sandbox.window.WeleticLoyaltyShared.loadLoyaltyNudgeCart(root),
  ).toBeNull();
  expect(sandbox.window.fetch).not.toHaveBeenCalled();
});
it("suppresses aborted and failed reads without leaking raw errors", async () => {
  sandbox.window.fetch = vi
    .fn()
    .mockRejectedValue(new Error("private-cart-token"));
  expect(
    await sandbox.window.WeleticLoyaltyShared.loadLoyaltyNudgeCart("/", {
      aborted: true,
    }),
  ).toBeNull();
  expect(sandbox.window.fetch).not.toHaveBeenCalled();
  expect(
    await sandbox.window.WeleticLoyaltyShared.loadLoyaltyNudgeCart("/"),
  ).toBeNull();
});
it.each(["true", 1, null])(
  "rejects malformed explicit remote flag %j",
  (remote) => {
    expect(normalize({ ...cart(), items: [{ ...line(), remote }] })).toBeNull();
  },
);
it.each([true, false])(
  "preserves explicit remote, gift-card and shipping facts %s",
  (flag) => {
    const result = normalize({
      ...cart(),
      items: [
        { ...line(), remote: flag, gift_card: flag, requires_shipping: flag },
      ],
    });
    expect(result.lines[0]).toMatchObject({
      remote: flag,
      giftCard: flag,
      requiresShipping: flag,
    });
  },
);
it("suppresses HTTP errors and invalid JSON", async () => {
  for (const response of [
    { ok: false, status: 500, json: async () => ({ error: "private" }) },
    {
      ok: true,
      json: async () => {
        throw new Error("invalid json");
      },
    },
  ]) {
    sandbox.window.fetch = vi.fn().mockResolvedValue(response);
    expect(
      await sandbox.window.WeleticLoyaltyShared.loadLoyaltyNudgeCart("/"),
    ).toBeNull();
  }
});
it("cancels in-flight reads through the real AbortController", async () => {
  sandbox.window.AbortController = AbortController;
  sandbox.window.setTimeout = setTimeout;
  sandbox.window.clearTimeout = clearTimeout;
  sandbox.window.fetch = vi.fn(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      }),
  );
  const controller = new AbortController();
  const result = sandbox.window.WeleticLoyaltyShared.loadLoyaltyNudgeCart(
    "/",
    controller.signal,
  );
  controller.abort();
  expect(await result).toBeNull();
  expect(sandbox.window.fetch.mock.calls[0][1].signal.aborted).toBe(true);
});
it("suppresses a timed-out read and cancels its transport", async () => {
  vi.useFakeTimers();
  try {
    sandbox.window.AbortController = AbortController;
    sandbox.window.setTimeout = setTimeout;
    sandbox.window.clearTimeout = clearTimeout;
    sandbox.window.fetch = vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const result =
      sandbox.window.WeleticLoyaltyShared.loadLoyaltyNudgeCart("/");
    await vi.runAllTimersAsync();
    expect(await result).toBeNull();
    expect(sandbox.window.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    sandbox.window.setTimeout = setTimeout;
    sandbox.window.clearTimeout = clearTimeout;
  }
});
