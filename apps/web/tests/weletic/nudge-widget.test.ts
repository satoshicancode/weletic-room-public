/** @vitest-environment happy-dom */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getDefaultLauncherPresentation } from "../../lib/weletic/loyalty/launcher-presentation";
import { defaultLoyaltyNudgeSettings } from "../../lib/weletic/loyalty/nudge-contract";
const assets = path.resolve(
  __dirname,
  "../../../../packages/shopify-app/extensions/weletic-analytics/assets",
);
const shared = fs.readFileSync(
  path.join(assets, "weletic-loyalty-shared.js"),
  "utf8",
);
const widget = fs.readFileSync(
  path.join(assets, "weletic-loyalty-widget.js"),
  "utf8",
);
beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(document, "readyState", {
    configurable: true,
    value: "complete",
  });
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  let tail = Promise.resolve();
  Object.defineProperty(window.navigator, "locks", {
    configurable: true,
    value: {
      request: vi.fn((_key, _options, fn) => {
        const result = tail.then(fn);
        tail = result.then(() => undefined);
        return result;
      }),
    },
  });
});
afterEach(() => {
  (window as any).WeleticLoyaltyWidgetRuntime?.dispose();
  vi.useRealTimers();
  delete (window as any).WeleticLoyaltyShared;
  Reflect.deleteProperty(window.navigator, "locks");
  Reflect.deleteProperty(document, "hidden");
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  document.body.innerHTML = "";
});
async function mount({
  locale = "en",
  enabled = true,
  visible = true,
  launcherPresentation = undefined as
    | ReturnType<typeof getDefaultLauncherPresentation>
    | undefined,
  loggedIn = false,
  authAttribute = "default" as string | null,
  cartNudge = false,
  walletNudge = false,
  walletStatus = "available",
  walletExpiresAt = null as string | null,
  points = "100",
  customerStatus = 200,
  customerDelay = undefined as Promise<void> | undefined,
  collectionScoped = false,
  membershipDelay = undefined as Promise<void> | undefined,
  membership = {
    "gid://shopify/Product/1": ["gid://shopify/Collection/3"],
  } as unknown,
} = {}) {
  const settings = defaultLoyaltyNudgeSettings();
  settings.policies[0].enabled = enabled;
  settings.policies[1].enabled = cartNudge;
  settings.policies[2].enabled = walletNudge;
  document.body.innerHTML = `<div id="weletic-loyalty-root" data-shop="fixture.myshopify.com" data-logged-in="${loggedIn}" data-locale="${locale}" data-proxy-prefix="/apps/weletic"></div>`;
  if (cartNudge || walletNudge) {
    const root = document.querySelector("#weletic-loyalty-root")!;
    root.setAttribute("data-page-type", "cart");
    root.setAttribute("data-locale-root", "/");
  }
  if (authAttribute === null)
    document
      .querySelector("#weletic-loyalty-root")!
      .removeAttribute("data-logged-in");
  else if (authAttribute !== "default")
    document
      .querySelector("#weletic-loyalty-root")!
      .setAttribute("data-logged-in", authAttribute);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (String(url).includes("/customer/nudge-collections?")) {
        await membershipDelay;
        return new Response(JSON.stringify({ data: { membership } }));
      }
      if (String(url).includes("/customer?")) await customerDelay;
      if (String(url) === "/cart.js")
        return new Response(
          JSON.stringify({
            currency: "JPY",
            total_price: 100000,
            items_subtotal_price: 100000,
            total_discount: 0,
            item_count: 1,
            cart_level_discount_applications: [],
            items: [
              {
                product_id: 1,
                variant_id: 2,
                quantity: 1,
                final_line_price: 100000,
                requires_shipping: true,
                gift_card: false,
              },
            ],
          }),
        );
      if (String(url).includes("/customer?"))
        return new Response(
          JSON.stringify({
            data: {
              account: {
                status: "active",
                canParticipate: true,
                pointsBalance: points,
              },
              rewardWallet: walletNudge
                ? [
                    {
                      id: "fixture_reward",
                      rewardName: "Fixture issued reward",
                      termsSource: "issuance_snapshot",
                      status: walletStatus,
                      artifactKind: "discount_code",
                      discountCode: "FIXTURE",
                      applyUrl:
                        "https://fixture.myshopify.com/discount/FIXTURE",
                      rewardType: "amount_off",
                      salesChannel: "online_store",
                      issuedAt: "2020-01-01T00:00:00Z",
                      expiresAt: walletExpiresAt,
                      termsSnapshot: {
                        version: 1,
                        exchangeType: "fixed",
                        startsAt: "2020-01-01T00:00:00Z",
                        rewardType: "amount_off",
                        salesChannel: "online_store",
                        currency: "JPY",
                        currencyMinorUnits: 0,
                        minOrderAmount: null,
                        appliesToResource: collectionScoped
                          ? "specific_items"
                          : "entire_order",
                        entitledProductIds: [],
                        entitledVariantIds: [],
                        entitledCollectionIds: collectionScoped
                          ? ["gid://shopify/Collection/3"]
                          : [],
                        purchasePolicy: {
                          purchaseType: "one_time",
                          subscriptionCadence: "first_payment",
                          subscriptionPaymentLimit: null,
                        },
                      },
                    },
                  ]
                : [],
              program: {
                isActive: true,
                currency: "JPY",
                currencyMinorUnits: 0,
                pointNamePlural: "Stars",
              },
              rewards: [
                {
                  canRedeem: true,
                  exchangeType: "fixed",
                  salesChannel: "online_store",
                  rewardType: "amount_off",
                  pointsCost: "100",
                  minOrderAmount: null,
                  appliesToResource: collectionScoped
                    ? "specific_items"
                    : "entire_order",
                  entitledProductIds: [],
                  entitledVariantIds: [],
                  entitledCollectionIds: collectionScoped
                    ? ["gid://shopify/Collection/3"]
                    : [],
                  purchasePolicy: {
                    purchaseType: "one_time",
                    subscriptionCadence: "first_payment",
                    subscriptionPaymentLimit: null,
                  },
                },
              ],
            },
          }),
          { status: customerStatus },
        );
      return new Response(
        JSON.stringify({
          data: {
            program: { isActive: true },
            branding: { enableFloatingLauncher: visible, launcherPresentation },
            nudges: settings,
            earningRules: [],
            rewards: [],
            tiers: [],
          },
        }),
        { status: 200 },
      );
    }),
  );
  new Function(shared)();
  new Function(widget)();
  await new Promise((resolve) => setTimeout(resolve, 20));
  return settings.policies[0];
}
it.each(["en", "ja", "vi"] as const)(
  "prioritizes reward use over spending in %s with a read-only wallet CTA",
  async (locale) => {
    await mount({ locale, cartNudge: true, walletNudge: true, loggedIn: true });
    const prompt = document.querySelector<HTMLElement>(".weletic-nudge")!;
    expect(prompt).not.toBeNull();
    expect(prompt.textContent).toContain(
      defaultLoyaltyNudgeSettings().policies[2].templates[locale].title,
    );
    prompt.querySelector<HTMLButtonElement>("button")!.click();
    await vi.waitFor(() =>
      expect(document.querySelector(".weletic-drawer")?.textContent).toContain(
        "Fixture issued reward",
      ),
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(
          ([url, init]) =>
            !String(url).includes("/discount/") &&
            (!init?.method || init.method === "GET"),
        ),
    ).toBe(true);
  },
);
it.each([false, true])(
  "suppresses expired wallet prompt with pending lock=%s",
  async (pendingLock) => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    if (pendingLock)
      Object.defineProperty(window.navigator, "locks", {
        configurable: true,
        value: {
          request: vi.fn((key, _options, fn) =>
            key === "weletic.loyalty.nudges.v1"
              ? new Promise((resolve) => {
                  release = () => resolve(fn());
                })
              : Promise.resolve(fn()),
          ),
        },
      });
    const mounted = mount({
      walletNudge: true,
      loggedIn: true,
      walletExpiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(30);
    await mounted;
    if (pendingLock) expect(release).toBeDefined();
    else expect(document.querySelector(".weletic-nudge")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    if (release) {
      release();
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(document.querySelector(".weletic-nudge")).toBeNull();
    if (pendingLock)
      expect(
        window.localStorage.getItem("weletic.loyalty.nudges.v1"),
      ).toBeNull();
  },
);
it("shows issued reward without spendable points or enabled spending policy", async () => {
  await mount({ walletNudge: true, loggedIn: true, points: "0" });
  expect(document.querySelector(".weletic-nudge")?.textContent).toContain(
    defaultLoyaltyNudgeSettings().policies[2].templates.en.title,
  );
});
it("falls back to spending when the wallet reward is used", async () => {
  await mount({
    cartNudge: true,
    walletNudge: true,
    walletStatus: "used",
    loggedIn: true,
  });
  expect(document.querySelector(".weletic-nudge")?.textContent).toContain(
    defaultLoyaltyNudgeSettings().policies[1].templates.en.title.replace(
      "{{points_label}}",
      "Stars",
    ),
  );
});
it.each([false, true])(
  "shows a verified collection-scoped prompt, wallet=%s",
  async (walletNudge) => {
    await mount({
      loggedIn: true,
      cartNudge: true,
      walletNudge,
      collectionScoped: true,
    });
    expect(document.querySelector(".weletic-nudge")).not.toBeNull();
    expect(document.querySelector(".weletic-nudge")?.textContent).toContain(
      defaultLoyaltyNudgeSettings().policies[
        walletNudge ? 2 : 1
      ].templates.en.title.replace("{{points_label}}", "Stars"),
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) =>
          String(url).includes("/customer/nudge-collections?productIds=1"),
        ),
    ).toBe(true);
  },
);
it("rejects membership arriving after cart invalidation", async () => {
  let release!: () => void;
  const membershipDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  await mount({
    loggedIn: true,
    cartNudge: true,
    collectionScoped: true,
    membershipDelay,
  });
  document.dispatchEvent(new Event("cart:updated"));
  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(document.querySelector(".weletic-nudge")).toBeNull();
  expect(window.localStorage.getItem("weletic.loyalty.nudges.v1")).toBeNull();
});
it.each([
  null,
  {},
  { "gid://shopify/Product/1": [] },
  { "gid://shopify/Product/1": [true] },
  { "gid://shopify/Product/9": ["gid://shopify/Collection/3"] },
])("suppresses unverified collection membership %#", async (membership) => {
  await mount({
    loggedIn: true,
    cartNudge: true,
    collectionScoped: true,
    membership,
  });
  expect(document.querySelector(".weletic-nudge")).toBeNull();
});
it.each(["en", "ja", "vi"])(
  "renders member cart spending prompt in %s with read-only CTA",
  async (locale) => {
    await mount({ locale, cartNudge: true, loggedIn: true });
    await vi.waitFor(() =>
      expect(document.querySelector(".weletic-nudge")).not.toBeNull(),
    );
    const prompt = document.querySelector<HTMLElement>(".weletic-nudge")!;
    expect(prompt.lang).toBe(locale);
    expect(prompt.textContent).not.toContain("{{");
    prompt.querySelector<HTMLButtonElement>("button")!.click();
    expect(document.querySelector(".weletic-nudge")).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(([, init]) => !init?.method || init.method === "GET"),
    ).toBe(true);
  },
);
it.each([{ points: "99" }, { customerStatus: 401 }])(
  "suppresses member prompt for %j",
  async (options) => {
    await mount({ cartNudge: true, loggedIn: true, ...options });
    expect(document.querySelector(".weletic-nudge")).toBeNull();
  },
);
it("removes the member prompt when cart input changes", async () => {
  await mount({ cartNudge: true, loggedIn: true });
  expect(document.querySelector(".weletic-nudge")).not.toBeNull();
  document.dispatchEvent(new Event("input", { bubbles: true }));
  expect(document.querySelector(".weletic-nudge")).toBeNull();
});
it.each(["dispose", "input", "auth", "drawer"])(
  "suppresses delayed customer response after %s without consuming an impression",
  async (change) => {
    let release!: () => void;
    const customerDelay = new Promise<void>((resolve) => {
      release = resolve;
    });
    await mount({ cartNudge: true, loggedIn: true, customerDelay });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).includes("/customer?")),
    ).toBe(true);
    if (change === "dispose")
      (window as any).WeleticLoyaltyWidgetRuntime.dispose();
    else if (change === "input")
      document.dispatchEvent(new Event("input", { bubbles: true }));
    else if (change === "auth")
      document
        .querySelector("#weletic-loyalty-root")!
        .setAttribute("data-logged-in", "false");
    else
      document
        .querySelector<HTMLButtonElement>(".weletic-launcher-btn")!
        .click();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector(".weletic-nudge")).toBeNull();
    expect(window.localStorage.getItem("weletic.loyalty.nudges.v1")).toBeNull();
  },
);
it("expires the member hint and restores keyboard focus", async () => {
  vi.useFakeTimers();
  const mounted = mount({ cartNudge: true, loggedIn: true });
  await vi.advanceTimersByTimeAsync(30);
  await mounted;
  const action = document.querySelector<HTMLButtonElement>(
    ".weletic-nudge button",
  )!;
  expect(action).not.toBeNull();
  action.focus();
  await vi.advanceTimersByTimeAsync(10000);
  expect(document.querySelector(".weletic-nudge")).toBeNull();
  expect(document.activeElement).toBe(
    document.querySelector(".weletic-launcher-btn"),
  );
});
it("removes the member prompt for click-only Ajax cart controls", async () => {
  await mount({ cartNudge: true, loggedIn: true });
  expect(document.querySelector(".weletic-nudge")).not.toBeNull();
  const remove = document.createElement("button");
  document.body.append(remove);
  remove.click();
  expect(document.querySelector(".weletic-nudge")).toBeNull();
});
it.each(["input", "click"])(
  "does not render after %s while waiting for impression lock",
  async (event) => {
    let release: (() => unknown) | undefined;
    Object.defineProperty(window.navigator, "locks", {
      configurable: true,
      value: {
        request: vi.fn((key, _options, fn) =>
          key === "weletic.loyalty.nudges.v1"
            ? new Promise((resolve) => {
                release = () => resolve(fn());
              })
            : Promise.resolve(fn()),
        ),
      },
    });
    await mount({ cartNudge: true, loggedIn: true });
    expect(release).toBeDefined();
    document.body.dispatchEvent(new Event(event, { bubbles: true }));
    release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector(".weletic-nudge")).toBeNull();
    expect(window.localStorage.getItem("weletic.loyalty.nudges.v1")).toBeNull();
  },
);
it.each(["en", "ja", "vi"] as const)(
  "renders actual signup prompt in %s and opens the existing drawer without a write",
  async (locale) => {
    const policy = await mount({ locale });
    await vi.waitFor(() =>
      expect(document.querySelector(".weletic-nudge")).not.toBeNull(),
    );
    const prompt = document.querySelector<HTMLElement>(".weletic-nudge")!;
    expect(prompt.lang).toBe(locale);
    expect(prompt.textContent).toContain(policy.templates[locale].title);
    expect(document.activeElement).not.toBe(prompt);
    prompt.querySelector<HTMLButtonElement>("button")!.click();
    expect(document.querySelector(".weletic-nudge")).toBeNull();
    expect(document.querySelector<HTMLElement>(".weletic-drawer")!.hidden).toBe(
      false,
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.every(
          ([, options]) => !options?.method || options.method === "GET",
        ),
    ).toBe(true);
  },
);
it("suppresses a configured nudge when the viewport has insufficient space above its launcher", async () => {
  vi.stubGlobal("innerHeight", 160);
  const presentation = getDefaultLauncherPresentation();
  presentation.mobile.bottomSpacing = 128;
  presentation.desktop.bottomSpacing = 128;
  await mount({ launcherPresentation: presentation });
  expect(document.querySelector(".weletic-nudge")).toBeNull();
});

it("dismisses an existing signup nudge when responsive launcher visibility changes", async () => {
  vi.stubGlobal("innerWidth", 1024);
  await mount({
    launcherPresentation: {
      ...getDefaultLauncherPresentation(),
      visibility: "desktop_only",
    },
  });
  expect(document.querySelector(".weletic-nudge")).not.toBeNull();
  vi.stubGlobal("innerWidth", 375);
  window.dispatchEvent(new Event("resize"));
  expect(document.querySelector(".weletic-nudge")).toBeNull();
});
it("aligns an existing nudge with mobile launcher overrides", async () => {
  vi.stubGlobal("innerWidth", 1024);
  const presentation = getDefaultLauncherPresentation();
  presentation.mobile.position = "bottom_left";
  presentation.mobile.sideSpacing = 20;
  await mount({ launcherPresentation: presentation });
  vi.stubGlobal("innerWidth", 375);
  window.dispatchEvent(new Event("resize"));
  const nudge = document.querySelector<HTMLElement>(".weletic-nudge")!;
  expect(nudge.classList.contains("weletic-pos-left")).toBe(true);
  expect(nudge.style.left).toBe("20px");
});

it("dismisses with Escape, returns focus, and does not redisplay on another page", async () => {
  await mount();
  const close = document.querySelectorAll<HTMLButtonElement>(
    ".weletic-nudge button",
  )[1];
  close.focus();
  close.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(document.querySelector(".weletic-nudge")).toBeNull();
  expect(document.activeElement).toBe(
    document.querySelector(".weletic-launcher-btn"),
  );
  (window as any).WeleticLoyaltyWidgetRuntime.dispose();
  await mount();
  expect(document.querySelector(".weletic-nudge")).toBeNull();
});
it.each([{ enabled: false }, { visible: false }, { loggedIn: true }])(
  "does not display for ineligible presentation %j",
  async (options) => {
    await mount(options);
    expect(document.querySelector(".weletic-nudge")).toBeNull();
  },
);
it("does not defer a first-visit prompt to a later page where nudges become enabled", async () => {
  await mount({ enabled: false });
  (window as any).WeleticLoyaltyWidgetRuntime.dispose();
  await mount();
  expect(document.querySelector(".weletic-nudge")).toBeNull();
});
it("suppresses without browser locks", async () => {
  Reflect.deleteProperty(window.navigator, "locks");
  await mount();
  expect(document.querySelector(".weletic-nudge")).toBeNull();
});
it("removes the prompt on controller unmount", async () => {
  await mount();
  expect(document.querySelector(".weletic-nudge")).not.toBeNull();
  (window as any).WeleticLoyaltyWidgetRuntime.dispose();
  expect(document.querySelector(".weletic-nudge")).toBeNull();
});
it.each([null, "", "FALSE", "unknown"])(
  "suppresses unknown authentication attribute %j",
  async (authAttribute) => {
    await mount({ authAttribute });
    expect(document.querySelector(".weletic-nudge")).toBeNull();
  },
);
it.each(["weletic.loyalty.first-visit.v1", "weletic.loyalty.nudges.v1"])(
  "does not display after destruction while waiting for %s",
  async (blockedKey) => {
    let release: (() => void) | undefined;
    Object.defineProperty(window.navigator, "locks", {
      configurable: true,
      value: {
        request: (_key: string, _options: unknown, callback: () => boolean) => {
          if (_key !== blockedKey) return Promise.resolve(callback());
          return new Promise((resolve) => {
            release = () => resolve(callback());
          });
        },
      },
    });
    await mount();
    expect(release).toBeDefined();
    (window as any).WeleticLoyaltyWidgetRuntime.dispose();
    release!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.querySelector(".weletic-nudge")).toBeNull();
    expect(window.localStorage.getItem("weletic.loyalty.nudges.v1")).toBeNull();
  },
);
