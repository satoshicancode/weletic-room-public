/** @vitest-environment happy-dom */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const extensionDir = path.resolve(
  __dirname,
  "../../../../packages/shopify-app/extensions/weletic-analytics",
);
const sharedSource = fs.readFileSync(
  path.join(extensionDir, "assets/weletic-loyalty-shared.js"),
  "utf8",
);
const landingSource = fs.readFileSync(
  path.join(extensionDir, "assets/weletic-loyalty-landing.js"),
  "utf8",
);
const widgetSource = fs.readFileSync(
  path.join(extensionDir, "assets/weletic-loyalty-widget.js"),
  "utf8",
);
const productPointsSource = fs.readFileSync(
  path.join(extensionDir, "assets/weletic-product-points.js"),
  "utf8",
);
const stylesSource = fs.readFileSync(
  path.join(extensionDir, "assets/weletic-loyalty-styles.css"),
  "utf8",
);

function loadShared() {
  new Function(sharedSource)();
  return (window as any).WeleticLoyaltyShared;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function setReadyStateComplete() {
  Object.defineProperty(document, "readyState", {
    configurable: true,
    value: "complete",
  });
}

afterEach(() => {
  (window as any).WeleticLoyaltyWidgetRuntime?.dispose();
  (window as any).WeleticLoyaltyLandingRuntime?.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (window as any).WeleticLoyaltyShared;
  delete (window as any).WeleticLoyaltyWidgetRuntime;
  delete (window as any).WeleticLoyaltyLandingRuntime;
  window.sessionStorage.clear();
  document.body.innerHTML = "";
  Reflect.deleteProperty(document, "execCommand");
});

describe("Shopify Basic loyalty theme assets", () => {
  it("normalizes the canonical customer envelope and formats shopper values", () => {
    const shared = loadShared();
    const customer = shared.normalizeCustomer({
      data: {
        isEnrolled: true,
        account: {
          status: "active",
          canParticipate: true,
          pointsBalance: "1250",
          pendingPoints: "25",
        },
        program: { pointNameSingular: "Coin", pointNamePlural: "Coins" },
        tier: { currentTier: { name: "Gold" } },
        referral: {
          referralShareUrl: "https://shop.example/r/alice",
        },
      },
    });

    expect(shared.customerView(customer)).toEqual({
      pointsBalance: "1250",
      pendingPoints: "25",
      tierName: "Gold",
      pointNameSingular: "Coin",
      pointNamePlural: "Coins",
      referralShareUrl: "https://shop.example/r/alice",
    });
    expect(shared.customerCanParticipate(customer, true)).toBe(true);
    expect(
      shared.customerCanParticipate(
        {
          ...customer,
          account: {
            ...customer.account,
            status: "suspended",
            canParticipate: true,
          },
        },
        true,
      ),
    ).toBe(false);
    expect(
      shared.customerCanParticipate(
        {
          ...customer,
          account: { ...customer.account, canParticipate: false },
        },
        true,
      ),
    ).toBe(false);
    expect(
      shared.customerCanParticipate(
        {
          ...customer,
          account: {
            pointsBalance: "1250",
            pendingPoints: "25",
          },
        },
        true,
      ),
    ).toBe(false);
    expect(
      shared.formatEarningValue(
        { triggerCode: "signup", fixedPoints: "100" },
        "Coin",
        "Coins",
      ),
    ).toBe("+100 Coins");
    expect(
      shared.formatEarningValue(
        { triggerCode: "order_paid", multiplier: 2 },
        "Coin",
        "Coins",
      ),
    ).toBe("2× coins");
    expect(
      shared.formatRewardValue(
        { rewardType: "amount_off", discountValue: 500 },
        "USD",
      ),
    ).toContain("5.00");
    expect(shared.isOnlineStoreReward({ salesChannel: "online_store" })).toBe(
      true,
    );
    expect(shared.isOnlineStoreReward({ salesChannel: "pos" })).toBe(false);
    expect(shared.isOnlineStoreReward({ salesChannel: "both" })).toBe(true);
    expect(shared.isOnlineStoreReward({})).toBe(false);
    expect(shared.isOnlineStoreReward({ salesChannel: "marketplace" })).toBe(
      false,
    );
    expect(() =>
      shared.normalizeCustomer({ data: { isEnrolled: true } }),
    ).toThrow("rewards balance is unavailable");
  });

  it("preserves exact integer points beyond MAX_SAFE_INTEGER", () => {
    const shared = loadShared();
    const larger = "9007199254740993";
    const smaller = "9007199254740992";

    expect(shared.formatInteger(larger)).toBe(BigInt(larger).toLocaleString());
    expect(shared.formatPoints(larger, "Coin", "Coins")).toBe(
      `${BigInt(larger).toLocaleString()} Coins`,
    );
    expect(shared.compareIntegerValues(larger, smaller)).toBe(1);
    expect(shared.compareIntegerValues(smaller, larger)).toBe(-1);
    expect(shared.compareIntegerValues(larger, larger)).toBe(0);
    expect(shared.compareIntegerValues("invalid", larger)).toBeNull();
    expect(shared.isIntegerAtLeast(larger, smaller)).toBe(true);
    expect(shared.isIntegerAtLeast(smaller, larger)).toBe(false);
    expect(shared.minIntegerValue(larger, smaller)).toBe(smaller);
  });

  it("formats the effective order earn rate per major currency unit", () => {
    const shared = loadShared();

    const jpyRate = shared.formatEarningValue(
      { triggerCode: "order_paid", multiplier: "1" },
      "Coin",
      "Coins",
      { pointsPerCurrencyUnit: "5", currency: "JPY" },
    );
    expect(jpyRate).toContain("5 Coins per");
    expect(jpyRate).toMatch(/(?:\u00a5|JPY\s*)1/);

    expect(
      shared.formatEarningValue(
        { triggerCode: "order_paid", multiplier: "1.5" },
        "Coin",
        "Coins",
        { pointsPerCurrencyUnit: "2.5", currency: "USD" },
      ),
    ).toContain("3.75 Coins per");
  });

  it("formats the minimum effective incremental amount-off value and cap", () => {
    const shared = loadShared();
    const incrementalReward = {
      rewardType: "amount_off",
      exchangeType: "incremental",
      pointsCost: "100",
      pointsStep: "100",
      minPointsCost: "500",
      discountValue: "100",
    };

    expect(shared.formatRewardValue(incrementalReward, "USD")).toContain(
      "$5.00 off",
    );
    expect(
      shared.formatRewardValue(
        { ...incrementalReward, maxDiscountValue: "350" },
        "USD",
      ),
    ).toContain("$3.50 off");
  });

  it("preserves fractional percentage reward values", () => {
    const shared = loadShared();

    expect(
      shared.formatRewardValue({
        rewardType: "percentage_off",
        discountValue: "33.33",
      }),
    ).toBe("33.33% off");
    expect(
      shared.formatRewardValue({
        rewardType: "percentage_off",
        discountValue: "10.5000",
      }),
    ).toBe("10.5% off");
  });

  it("gives the launcher hidden attribute an explicit author-level CSS rule", () => {
    expect(stylesSource).toMatch(
      /\.weletic-launcher-btn\[hidden\]\s*\{[^}]*display:\s*none;/s,
    );
  });

  it("does not expose an unenrolled shopper as a loyalty member", () => {
    const shared = loadShared();
    const customer = shared.normalizeCustomer({
      data: {
        isEnrolled: false,
        pointsBalance: "0",
        pendingPoints: "0",
      },
    });

    expect(shared.customerView(customer)).toBeNull();
  });

  it("initializes the shared asset idempotently when both theme blocks load it", () => {
    const first = loadShared();
    new Function(sharedSource)();
    expect((window as any).WeleticLoyaltyShared).toBe(first);
  });

  it("rejects non-success HTTP envelopes instead of normalizing them to zeros", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { code: "upstream_timeout", message: "Please retry" } },
          503,
        ),
      ),
    );
    const shared = loadShared();

    await expect(
      shared.fetchJson("/apps/weletic/customer"),
    ).rejects.toMatchObject({
      message: "Please retry",
      status: 503,
      code: "upstream_timeout",
    });
  });

  it("renders nested member data, fixed earn values, online rewards, and the server referral URL", async () => {
    document.body.innerHTML = [
      '<div id="weletic-loyalty-landing-root"',
      ' data-shop="store.myshopify.com"',
      ' data-logged-in="true"',
      ' data-currency="USD"',
      ' data-proxy-prefix="/apps/weletic"',
      ' data-show-tiers="false"',
      ' data-show-earn="true"',
      ' data-show-redeem="true"',
      ' data-show-referrals="true">',
      '<div class="weletic-landing-hero"><h1 class="weletic-landing-title">Theme title</h1><p class="weletic-landing-subtitle">Theme subtitle</p></div>',
      "</div>",
      '<div id="weletic-landing-auth-banner"></div>',
      '<div id="weletic-landing-sections"></div>',
    ].join("");
    setReadyStateComplete();

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/customer?")) {
        return jsonResponse({
          data: {
            isEnrolled: true,
            account: {
              status: "active",
              canParticipate: true,
              pointsBalance: "1250",
              pendingPoints: "25",
            },
            program: {
              isActive: true,
              pointNameSingular: "Coin",
              pointNamePlural: "Coins",
            },
            tier: { currentTier: { name: "Gold" } },
            referral: {
              referralShareUrl: "https://shop.example/r/alice",
            },
          },
        });
      }
      return jsonResponse({
        data: {
          program: {
            isActive: true,
            pointNameSingular: "Coin",
            pointNamePlural: "Coins",
            pointsPerCurrencyUnit: "5",
          },
          branding: {
            launcherText: "Yamax Rewards",
            launcherPosition: "bottom_left",
            launcherIcon: "crown",
            primaryColor: "#123456",
            headerTextColor: "#ffffff",
            panelTitle: "Yamax Club",
            panelWelcomeSubtitle: "Member rewards, clearly presented.",
            heroImageUrl: "https://cdn.example.com/yamax.jpg",
            enableFloatingLauncher: true,
          },
          currency: "USD",
          tiers: [],
          earningRules: [
            {
              id: "signup",
              name: "Create an account",
              triggerCode: "signup",
              fixedPoints: "100",
              multiplier: 1,
            },
            {
              id: "order",
              name: "Place an order",
              triggerCode: "order_paid",
              fixedPoints: null,
              multiplier: "1",
            },
          ],
          rewards: [
            {
              id: "online",
              name: "$5 reward",
              rewardType: "amount_off",
              salesChannel: "online_store",
              discountValue: 500,
              pointsCost: "500",
            },
            {
              id: "pos",
              name: "POS-only reward",
              rewardType: "amount_off",
              salesChannel: "pos",
              discountValue: 500,
              pointsCost: "500",
            },
            {
              id: "missing-channel",
              name: "Unverified-channel reward",
              rewardType: "amount_off",
              discountValue: 500,
              pointsCost: "500",
            },
          ],
          referralOffer: {
            isActive: true,
            friendClaimEnabled: true,
            friendRewardKind: "coupon",
            friendRewardName: "$5 welcome reward",
            friendPointsReward: "0",
            advocateRewardKind: "points",
            advocatePointsReward: "500",
            advocateRewardName: null,
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    loadShared();
    new Function(landingSource)();

    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("1,250 Coins");
      expect(document.body.textContent).toContain("Gold");
      expect(document.body.textContent).toContain("+100 Coins");
      expect(document.body.textContent).toContain("5 Coins per $1");
      expect(document.body.textContent).toContain("Amount off");
      expect(document.body.textContent).toContain("5.00 off");
      expect(document.body.textContent).not.toContain("POS-only reward");
      expect(document.body.textContent).not.toContain(
        "Unverified-channel reward",
      );
      expect(document.body.textContent).toContain(
        "https://shop.example/r/alice",
      );
      expect(document.body.textContent).toContain("Yamax Club");
      expect(document.body.textContent).toContain("$5 welcome reward");
      expect(document.body.textContent).toContain("500 Coins");
      expect(
        document.querySelector<HTMLElement>(".weletic-landing-hero")?.style
          .backgroundImage,
      ).toContain("yamax.jpg");
    });
  });

  it.each([
    {
      pointsBalance: "1",
      pointNameSingular:
        'Coin<img src="x" onerror="window.__weleticXss = true">',
      pointNamePlural: "Coins",
    },
    {
      pointsBalance: "2",
      pointNameSingular: "Coin",
      pointNamePlural:
        'Coins<img src="x" onerror="window.__weleticXss = true">',
    },
  ])(
    "renders a hostile singular or plural point name as text for a $pointsBalance-point balance",
    async ({ pointsBalance, pointNameSingular, pointNamePlural }) => {
      document.body.innerHTML = [
        '<div id="weletic-loyalty-landing-root" data-shop="store.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>',
        '<div id="weletic-landing-auth-banner"></div>',
        '<div id="weletic-landing-sections"></div>',
      ].join("");
      setReadyStateComplete();

      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/customer?")) {
            return jsonResponse({
              data: {
                isEnrolled: true,
                account: {
                  status: "active",
                  canParticipate: true,
                  pointsBalance,
                  pendingPoints: "0",
                },
                program: {
                  isActive: true,
                  pointNameSingular,
                  pointNamePlural,
                },
                tier: { currentTier: { name: "Member" } },
              },
            });
          }
          return jsonResponse({
            data: {
              program: { isActive: true },
              currency: "USD",
              tiers: [],
              earningRules: [],
              rewards: [],
              referralOffer: null,
            },
          });
        }),
      );

      loadShared();
      new Function(landingSource)();

      await vi.waitFor(() => {
        const banner = document.querySelector("#weletic-landing-auth-banner");
        const expectedPointName =
          pointsBalance === "1" ? pointNameSingular : pointNamePlural;
        expect(banner?.textContent).toContain(
          `${pointsBalance} ${expectedPointName}`,
        );
        expect(banner?.querySelector("img")).toBeNull();
        expect(banner?.querySelector("[onerror]")).toBeNull();
      });
    },
  );

  it("keeps public drawer content available on a customer-only failure without a fake zero balance", async () => {
    document.body.innerHTML = [
      '<div id="weletic-loyalty-landing-root" data-shop="store.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>',
      '<div id="weletic-landing-auth-banner"></div>',
      '<div id="weletic-landing-sections"></div>',
      '<div id="weletic-loyalty-root" data-shop="store.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>',
    ].join("");
    setReadyStateComplete();

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/customer?")) {
        return jsonResponse(
          { error: { code: "unavailable", message: "Unavailable" } },
          503,
        );
      }
      return jsonResponse({
        data: {
          program: { isActive: true },
          currency: "USD",
          tiers: [],
          earningRules: [],
          rewards: [],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    loadShared();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    new Function(landingSource)();
    new Function(widgetSource)();
    document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();

    await vi.waitFor(() => {
      expect(document.querySelector("#weletic-landing-retry")).toBeNull();
      expect(document.querySelector("#weletic-widget-retry")).toBeNull();
      expect(
        document.querySelector(".weletic-member-load-error")?.textContent,
      ).toContain("Public program details remain available");
      expect(document.querySelector('[data-tab="earn"]')).not.toBeNull();
      expect(document.querySelector(".weletic-points-val")).toBeNull();
      expect(
        document.querySelector("#weletic-landing-auth-banner")?.textContent,
      ).not.toContain("0 Points");
      expect(
        document.querySelector("#weletic-landing-auth-banner")?.textContent,
      ).toContain("Public program details remain available");
    });
  });

  it("applies saved public branding to the live launcher and drawer", async () => {
    document.body.innerHTML =
      '<div id="weletic-loyalty-root" data-shop="store.myshopify.com" data-logged-in="false" data-position="bottom_right" data-primary-color="#abcdef" data-launcher-text="Theme rewards" data-proxy-prefix="/apps/weletic"></div>';
    setReadyStateComplete();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: {
            program: {
              isActive: true,
              pointNameSingular: "Coin",
              pointNamePlural: "Coins",
              pointsPerCurrencyUnit: "5",
            },
            branding: {
              launcherText: "Yamax Rewards",
              launcherPosition: "bottom_left",
              launcherIcon: "crown",
              primaryColor: "#123456",
              headerTextColor: "#fedcba",
              panelTitle: "Yamax Club",
              panelWelcomeSubtitle: "Welcome to Yamax rewards.",
              heroImageUrl: null,
              enableFloatingLauncher: true,
            },
            currency: "JPY",
            tiers: [],
            earningRules: [],
            rewards: [],
            referralOffer: null,
          },
        }),
      ),
    );

    loadShared();
    new Function(widgetSource)();

    await vi.waitFor(() => {
      const launcher = document.querySelector<HTMLButtonElement>(
        ".weletic-launcher-btn",
      )!;
      expect(launcher.hidden).toBe(false);
      expect(launcher.textContent).toContain("Yamax Rewards");
      expect(launcher.textContent).toContain("👑");
      expect(launcher.classList.contains("weletic-pos-left")).toBe(true);
      expect(
        document.documentElement.style.getPropertyValue("--weletic-primary"),
      ).toBe("#123456");
      expect(
        document.documentElement.style.getPropertyValue(
          "--weletic-header-text",
        ),
      ).toBe("#fedcba");
    });

    document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();
    expect(document.querySelector(".weletic-drawer")?.textContent).toContain(
      "Yamax Club",
    );
  });

  it("keeps the live launcher hidden when saved branding disables it", async () => {
    document.body.innerHTML =
      '<div id="weletic-loyalty-root" data-shop="store.myshopify.com" data-logged-in="false" data-proxy-prefix="/apps/weletic"></div>';
    setReadyStateComplete();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: {
            program: { isActive: true },
            branding: { enableFloatingLauncher: false },
            currency: "USD",
            tiers: [],
            earningRules: [],
            rewards: [],
          },
        }),
      ),
    );

    loadShared();
    new Function(widgetSource)();

    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")
          ?.hidden,
      ).toBe(true);
    });
  });

  it("renders a logged-in unenrolled shopper as a non-member and honors an empty saved subtitle", async () => {
    document.body.innerHTML = [
      '<div data-weletic-loyalty-landing-root data-shop="store.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic">',
      '<div class="weletic-landing-hero"><h1 class="weletic-landing-title">Theme title</h1><p class="weletic-landing-subtitle">Theme subtitle</p><div data-weletic-landing-auth-banner></div></div>',
      "<div data-weletic-landing-sections></div>",
      "</div>",
      '<div data-weletic-loyalty-root data-shop="store.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>',
    ].join("");
    setReadyStateComplete();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/customer?")) {
          return jsonResponse({
            data: {
              isEnrolled: false,
              pointsBalance: "0",
              pendingPoints: "0",
              shopper: { firstName: "Alex" },
            },
          });
        }
        return jsonResponse({
          data: {
            program: {
              isActive: true,
              pointNameSingular: "Coin",
              pointNamePlural: "Coins",
            },
            branding: {
              enableFloatingLauncher: true,
              panelWelcomeSubtitle: "",
            },
            currency: "USD",
            tiers: [],
            earningRules: [],
            rewards: [],
          },
        });
      }),
    );

    loadShared();
    new Function(landingSource)();
    new Function(widgetSource)();

    await vi.waitFor(() => {
      expect(
        document.querySelector("[data-weletic-landing-auth-banner]")
          ?.textContent,
      ).toContain("not enrolled");
      expect(
        document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")
          ?.hidden,
      ).toBe(false);
    });

    document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();

    await vi.waitFor(() => {
      expect(document.querySelector(".weletic-drawer")?.textContent).toContain(
        "not enrolled",
      );
      expect(document.querySelector(".weletic-user-card")).toBeNull();
      expect(document.querySelector(".weletic-points-val")).toBeNull();
      expect(
        document.querySelector(".weletic-drawer")?.textContent,
      ).not.toContain("Your Rewards");
      expect(
        document.querySelector(".weletic-header-subtitle")?.textContent,
      ).toBe("");
    });
  });

  it("posts an exact incremental points string and suppresses concurrent redemption", async () => {
    document.body.innerHTML =
      '<div id="weletic-loyalty-root" data-shop="store.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>';
    setReadyStateComplete();
    const redemptionRequests: Array<{ pointsRequested?: string }> = [];
    let releaseRedemption: (() => void) | null = null;
    const redemptionGate = new Promise<void>((resolve) => {
      releaseRedemption = resolve;
    });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/customer/redeem")) {
        redemptionRequests.push(JSON.parse(String(init?.body || "{}")));
        await redemptionGate;
        return jsonResponse({
          data: {
            success: true,
            artifactKind: "discount_code",
            artifactCode: "EXACT-POINTS",
          },
        });
      }
      if (url.includes("/customer?")) {
        return jsonResponse({
          data: {
            isEnrolled: true,
            account: {
              status: "active",
              canParticipate: true,
              pointsBalance: "9007199254740993",
              pendingPoints: "0",
            },
            program: {
              isActive: true,
              pointNameSingular: "Coin",
              pointNamePlural: "Coins",
            },
            tier: { currentTier: { name: "Gold" } },
            rewardWallet: [],
          },
        });
      }
      return jsonResponse({
        data: {
          program: {
            isActive: true,
            pointNameSingular: "Coin",
            pointNamePlural: "Coins",
            pointsPerCurrencyUnit: "5",
          },
          branding: { enableFloatingLauncher: true },
          currency: "USD",
          tiers: [],
          earningRules: [],
          rewards: [
            {
              id: "incremental_1",
              name: "Flexible reward",
              rewardType: "amount_off",
              salesChannel: "online_store",
              exchangeType: "incremental",
              pointsCost: "100",
              pointsStep: "1",
              minPointsCost: "9007199254740992",
              maxPointsCost: "9007199254740993",
              discountValue: "1",
            },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("alert", vi.fn());

    loadShared();
    new Function(widgetSource)();
    document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();

    await vi.waitFor(() => {
      expect(document.querySelector("[data-redeem-id]")).not.toBeNull();
    });
    const input = document.querySelector<HTMLInputElement>(
      "[data-reward-points]",
    )!;
    input.value = "9007199254740993";
    const button =
      document.querySelector<HTMLButtonElement>("[data-redeem-id]")!;
    button.click();
    button.click();

    expect(redemptionRequests).toHaveLength(0);
    const confirm = document.querySelector<HTMLButtonElement>(
      "#weletic-confirm-redemption",
    )!;
    confirm.click();
    confirm.click();

    await vi.waitFor(() => expect(redemptionRequests).toHaveLength(1));
    expect(redemptionRequests[0].pointsRequested).toBe("9007199254740993");
    releaseRedemption!();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("EXACT-POINTS");
    });
  });

  it("fails closed when the program is inactive and renders no earning or referral actions", async () => {
    document.body.innerHTML = [
      '<div id="weletic-loyalty-landing-root" data-shop="store.myshopify.com" data-logged-in="false" data-proxy-prefix="/apps/weletic"></div>',
      '<div id="weletic-landing-auth-banner"></div>',
      '<div id="weletic-landing-sections"></div>',
      '<div id="weletic-loyalty-root" data-shop="store.myshopify.com" data-logged-in="false" data-proxy-prefix="/apps/weletic"></div>',
    ].join("");
    setReadyStateComplete();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: {
            program: { isActive: false },
            branding: { enableFloatingLauncher: true },
            earningRules: [{ id: "signup", name: "Create an account" }],
            rewards: [{ id: "reward", name: "Reward" }],
            tiers: [],
            referralOffer: {
              isActive: true,
              friendClaimEnabled: true,
              friendRewardKind: "coupon",
              friendRewardName: "$5 coupon",
              advocateRewardKind: "points",
              advocatePointsReward: "100",
            },
          },
        }),
      ),
    );

    loadShared();
    new Function(landingSource)();
    new Function(widgetSource)();

    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")
          ?.hidden,
      ).toBe(true);
      expect(
        document.querySelector("#weletic-landing-sections")?.textContent,
      ).toContain("currently unavailable");
      expect(
        document.querySelector("#weletic-landing-sections")?.textContent,
      ).not.toContain("Ways to Earn Points");
      expect(
        document.querySelector("#weletic-landing-sections")?.textContent,
      ).not.toContain("Refer Your Friends");
    });
  });

  it("does not reveal the launcher when public program preload fails", async () => {
    document.body.innerHTML =
      '<div id="weletic-loyalty-root" data-shop="store.myshopify.com" data-logged-in="false" data-proxy-prefix="/apps/weletic"></div>';
    setReadyStateComplete();
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { code: "unavailable", message: "Unavailable" } },
          503,
        ),
      ),
    );

    loadShared();
    new Function(widgetSource)();

    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalled();
      expect(
        document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")
          ?.hidden,
      ).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        "[Weletic Loyalty Widget] Program preload failed:",
        expect.any(Error),
      );
    });
  });

  it("preserves a successful member wallet when public program loading fails", async () => {
    document.body.innerHTML = [
      '<div id="weletic-loyalty-landing-root" data-shop="store.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>',
      '<div id="weletic-landing-auth-banner"></div>',
      '<div id="weletic-landing-sections"></div>',
      '<div id="weletic-loyalty-root" data-shop="store.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>',
    ].join("");
    setReadyStateComplete();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/customer?")) {
          return jsonResponse({
            data: {
              isEnrolled: true,
              account: {
                status: "active",
                canParticipate: true,
                pointsBalance: "1250",
                pendingPoints: "0",
              },
              program: {
                isActive: true,
                pointNameSingular: "Coin",
                pointNamePlural: "Coins",
              },
              tier: { currentTier: { name: "Gold" } },
              rewardWallet: [
                {
                  id: "wallet_1",
                  rewardName: "$5 reward",
                  status: "available",
                  pointsSpent: "500",
                  artifactKind: "discount_code",
                  artifactCode: "KEEP-ME",
                },
              ],
            },
          });
        }
        return jsonResponse(
          { error: { code: "unavailable", message: "Unavailable" } },
          503,
        );
      }),
    );

    loadShared();
    new Function(landingSource)();
    new Function(widgetSource)();
    document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();

    await vi.waitFor(() => {
      expect(
        document.querySelector("#weletic-landing-auth-banner")?.textContent,
      ).toContain("1,250 Coins");
      expect(
        document.querySelector("#weletic-landing-sections")?.textContent,
      ).toContain("could not load program details");
      expect(document.querySelector(".weletic-drawer")?.textContent).toContain(
        "KEEP-ME",
      );
      expect(document.querySelector(".weletic-points-val")?.textContent).toBe(
        "1,250",
      );
      expect(document.querySelector("[data-redeem-id]")).toBeNull();
      expect(
        document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")
          ?.hidden,
      ).toBe(false);
    });
  });

  it("keeps a suspended member wallet visible while gating every participation action", async () => {
    document.body.innerHTML = [
      '<div data-weletic-loyalty-landing-root data-shop="store.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic">',
      '<div class="weletic-landing-hero"><h1 class="weletic-landing-title">Rewards</h1><p class="weletic-landing-subtitle"></p><div data-weletic-landing-auth-banner></div></div>',
      "<div data-weletic-landing-sections></div>",
      "</div>",
      '<div data-weletic-loyalty-root data-shop="store.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>',
    ].join("");
    setReadyStateComplete();

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/customer?")) {
        return jsonResponse({
          data: {
            isEnrolled: true,
            account: {
              status: "suspended",
              canParticipate: false,
              pointsBalance: "1250",
              pendingPoints: "0",
            },
            program: {
              isActive: true,
              pointNameSingular: "Coin",
              pointNamePlural: "Coins",
            },
            tier: { currentTier: { name: "Gold" } },
            referral: {
              referralShareUrl: "https://shop.example/r/restricted-member",
            },
            rewardWallet: [
              {
                id: "wallet_restricted",
                rewardName: "$5 issued reward",
                status: "available",
                pointsSpent: "500",
                artifactKind: "discount_code",
                artifactCode: "VISIBLE-BUT-INACTIVE",
                applyUrl:
                  "https://store.myshopify.com/discount/VISIBLE-BUT-INACTIVE?redirect=/cart",
              },
            ],
          },
        });
      }
      return jsonResponse({
        data: {
          program: {
            isActive: true,
            pointNameSingular: "Coin",
            pointNamePlural: "Coins",
          },
          branding: { enableFloatingLauncher: true },
          currency: "USD",
          tiers: [],
          earningRules: [
            {
              id: "social_action",
              name: "Follow the store",
              triggerCode: "instagram_follow",
              fixedPoints: "50",
              multiplier: 1,
              action: {
                url: "https://www.instagram.com/example",
                label: "Open Instagram",
              },
            },
          ],
          rewards: [
            {
              id: "online_reward",
              name: "$5 online reward",
              rewardType: "amount_off",
              salesChannel: "online_store",
              discountValue: "500",
              pointsCost: "500",
            },
          ],
          referralOffer: {
            isActive: true,
            friendClaimEnabled: true,
            friendRewardKind: "coupon",
            friendRewardName: "$5 welcome reward",
            friendPointsReward: "0",
            advocateRewardKind: "points",
            advocatePointsReward: "100",
            advocateRewardName: null,
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    loadShared();
    new Function(landingSource)();
    new Function(widgetSource)();

    await vi.waitFor(() => {
      expect(
        document.querySelector("[data-weletic-landing-auth-banner]")
          ?.textContent,
      ).toContain("currently unavailable");
      expect(
        document.querySelector("[data-weletic-landing-sections]")?.textContent,
      ).toContain("Referrals are unavailable");
      expect(document.querySelector("#weletic-landing-copy-ref")).toBeNull();
      expect(document.body.textContent).not.toContain(
        "https://shop.example/r/restricted-member",
      );
      expect(
        document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")
          ?.hidden,
      ).toBe(false);
    });

    document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();

    await vi.waitFor(() => {
      expect(document.querySelector(".weletic-drawer")?.textContent).toContain(
        "VISIBLE-BUT-INACTIVE",
      );
      expect(
        document.querySelector(".weletic-account-restricted"),
      ).not.toBeNull();
      expect(document.querySelector("[data-copy-code]")).toBeNull();
      expect(
        document.querySelector('.weletic-wallet-apply[href*="/discount/"]'),
      ).toBeNull();
      expect(document.querySelector('[data-tab="refer"]')).toBeNull();
      expect(
        document.querySelector<HTMLButtonElement>("[data-redeem-id]")?.disabled,
      ).toBe(true);
    });

    document.querySelector<HTMLButtonElement>('[data-tab="earn"]')!.click();
    expect(document.querySelector("[data-activity-id]")).toBeNull();
    expect(document.querySelector(".weletic-drawer")?.textContent).toContain(
      "Account unavailable",
    );

    document.querySelector<HTMLButtonElement>('[data-tab="redeem"]')!.click();
    expect(
      document.querySelector<HTMLButtonElement>("[data-redeem-id]")?.disabled,
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/customer/redeem"),
      ),
    ).toBe(false);
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/customer/activity/claim"),
      ),
    ).toBe(false);
  });

  it("gates invalid referral offers and derives valid point benefits without coupon claims", async () => {
    document.body.innerHTML = [
      '<div id="weletic-loyalty-landing-root" data-shop="store.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>',
      '<div id="weletic-landing-auth-banner"></div>',
      '<div id="weletic-landing-sections"></div>',
      '<div id="weletic-loyalty-root" data-shop="store.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>',
    ].join("");
    setReadyStateComplete();
    const clipboardWrite = vi.fn().mockRejectedValue(new Error("blocked"));
    vi.stubGlobal("navigator", { clipboard: { writeText: clipboardWrite } });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => false),
    });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("/customer?")) {
        return jsonResponse({
          data: {
            isEnrolled: true,
            account: {
              status: "active",
              canParticipate: true,
              pointsBalance: "500",
              pendingPoints: "0",
            },
            program: {
              isActive: true,
              pointNameSingular: "Coin",
              pointNamePlural: "Coins",
            },
            tier: { currentTier: { name: "Member" } },
            referral: { referralShareUrl: "https://shop.example/r/member" },
            rewardWallet: [],
          },
        });
      }
      return jsonResponse({
        data: {
          program: {
            isActive: true,
            pointNameSingular: "Coin",
            pointNamePlural: "Coins",
          },
          branding: { enableFloatingLauncher: true },
          earningRules: [],
          rewards: [],
          tiers: [],
          referralOffer: {
            isActive: true,
            friendClaimEnabled: false,
            friendRewardKind: "points",
            friendPointsReward: "50",
            friendRewardName: null,
            advocateRewardKind: "points",
            advocatePointsReward: "100",
            advocateRewardName: null,
          },
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    loadShared();
    new Function(landingSource)();
    new Function(widgetSource)();

    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")
          ?.hidden,
      ).toBe(false);
      expect(
        document.querySelector("#weletic-landing-sections")?.textContent,
      ).toContain("Give your friend 50 Coins");
      expect(
        document.querySelector("#weletic-landing-sections")?.textContent,
      ).toContain("Earn 100 Coins");
    });

    document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-tab="refer"]')).not.toBeNull();
    });
    document.querySelector<HTMLButtonElement>('[data-tab="refer"]')!.click();

    expect(document.querySelector(".weletic-drawer")?.textContent).toContain(
      "Give your friend 50 Coins",
    );
    expect(document.querySelector(".weletic-drawer")?.textContent).toContain(
      "Earn 100 Coins",
    );
    expect(
      document.querySelector(".weletic-drawer")?.textContent,
    ).not.toContain("one-time reward before creating an account");

    document
      .querySelector<HTMLButtonElement>("#weletic-copy-referral-btn")!
      .click();
    document
      .querySelector<HTMLButtonElement>("#weletic-landing-copy-ref")!
      .click();
    await vi.waitFor(() => {
      expect(
        document.querySelector("#weletic-copy-referral-btn")?.textContent,
      ).toContain("Copy unavailable");
      expect(
        document.querySelector("#weletic-landing-copy-ref")?.textContent,
      ).toContain("Copy unavailable");
      expect(clipboardWrite).toHaveBeenCalledTimes(2);
      expect(document.execCommand).toHaveBeenCalledTimes(2);
    });
  });

  it("hides referral controls for an unprovisionable coupon offer", async () => {
    document.body.innerHTML = [
      '<div id="weletic-loyalty-landing-root" data-shop="store.myshopify.com" data-logged-in="false" data-proxy-prefix="/apps/weletic"></div>',
      '<div id="weletic-landing-auth-banner"></div>',
      '<div id="weletic-landing-sections"></div>',
      '<div id="weletic-loyalty-root" data-shop="store.myshopify.com" data-logged-in="false" data-proxy-prefix="/apps/weletic"></div>',
    ].join("");
    setReadyStateComplete();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          data: {
            program: { isActive: true },
            branding: { enableFloatingLauncher: true },
            earningRules: [],
            rewards: [],
            tiers: [],
            referralOffer: {
              isActive: true,
              friendClaimEnabled: false,
              friendRewardKind: "coupon",
              friendRewardName: "$5 coupon",
              advocateRewardKind: "points",
              advocatePointsReward: "100",
            },
          },
        }),
      ),
    );

    loadShared();
    new Function(landingSource)();
    new Function(widgetSource)();

    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")
          ?.hidden,
      ).toBe(false);
      expect(
        document.querySelector("#weletic-landing-sections")?.textContent,
      ).not.toContain("Refer Your Friends");
    });
    document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-tab="home"]')).not.toBeNull();
      expect(document.querySelector('[data-tab="refer"]')).toBeNull();
    });
  });

  it("mounts one controller per root and tears it down across Shopify section reloads", async () => {
    const sectionMarkup = (instance: string) =>
      [
        `<div data-weletic-loyalty-root data-shop="${instance}.myshopify.com" data-logged-in="false" data-proxy-prefix="/apps/weletic"></div>`,
        `<div data-weletic-loyalty-landing-root data-shop="${instance}.myshopify.com" data-logged-in="false" data-proxy-prefix="/apps/weletic">`,
        '<div class="weletic-landing-hero"><h1 class="weletic-landing-title">Rewards</h1><p class="weletic-landing-subtitle"></p><div data-weletic-landing-auth-banner></div></div>',
        "<div data-weletic-landing-sections></div>",
        "</div>",
      ].join("");

    document.body.innerHTML = [
      `<section id="shopify-section-one">${sectionMarkup("one")}</section>`,
      `<section id="shopify-section-two">${sectionMarkup("two")}</section>`,
    ].join("");
    setReadyStateComplete();

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          program: { isActive: true },
          branding: { enableFloatingLauncher: true },
          currency: "USD",
          tiers: [],
          earningRules: [],
          rewards: [],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    loadShared();
    new Function(widgetSource)();
    new Function(landingSource)();
    new Function(widgetSource)();
    new Function(landingSource)();

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".weletic-launcher-btn")).toHaveLength(
        2,
      );
      expect(document.querySelectorAll(".weletic-modal-overlay")).toHaveLength(
        2,
      );
      expect(document.querySelectorAll(".weletic-drawer")).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    const firstSection = document.querySelector<HTMLElement>(
      "#shopify-section-one",
    )!;
    const detachedLauncher = document.querySelector<HTMLButtonElement>(
      ".weletic-launcher-btn",
    )!;
    const detachedDrawer =
      document.querySelector<HTMLElement>(".weletic-drawer")!;
    firstSection.dispatchEvent(
      new Event("shopify:section:unload", { bubbles: true }),
    );

    expect(document.querySelectorAll(".weletic-launcher-btn")).toHaveLength(1);
    expect(document.querySelectorAll(".weletic-modal-overlay")).toHaveLength(1);
    expect(document.querySelectorAll(".weletic-drawer")).toHaveLength(1);
    detachedLauncher.click();
    expect(detachedDrawer.classList.contains("weletic-open")).toBe(false);

    firstSection.innerHTML = sectionMarkup("one-reloaded");
    firstSection.dispatchEvent(
      new Event("shopify:section:load", { bubbles: true }),
    );

    await vi.waitFor(() => {
      expect(document.querySelectorAll(".weletic-launcher-btn")).toHaveLength(
        2,
      );
      expect(document.querySelectorAll(".weletic-modal-overlay")).toHaveLength(
        2,
      );
      expect(document.querySelectorAll(".weletic-drawer")).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(6);
    });
  });

  it("loads the shared asset before both storefront controllers", () => {
    for (const blockName of ["app-embed.liquid", "loyalty-landing.liquid"]) {
      const liquid = fs.readFileSync(
        path.join(extensionDir, "blocks", blockName),
        "utf8",
      );
      expect(liquid.indexOf("weletic-loyalty-shared.js")).toBeGreaterThan(-1);
      expect(liquid.indexOf("weletic-loyalty-shared.js")).toBeLessThan(
        liquid.lastIndexOf(
          blockName === "app-embed.liquid"
            ? "weletic-loyalty-widget.js"
            : "weletic-loyalty-landing.js",
        ),
      );
    }

    expect(
      fs.readFileSync(
        path.join(extensionDir, "blocks/app-embed.liquid"),
        "utf8",
      ),
    ).toContain("data-weletic-loyalty-root");
    expect(
      fs.readFileSync(
        path.join(extensionDir, "blocks/loyalty-landing.liquid"),
        "utf8",
      ),
    ).toContain("data-weletic-loyalty-landing-root");

    expect(landingSource).not.toContain("customer.pointsBalance");
    expect(landingSource).not.toContain("YOUR_CODE");
    expect(landingSource).not.toContain("rule.pointsText");
  });

  it("escapes merchant-controlled Liquid settings against quote and markup injection", () => {
    const maliciousSetting = '"><img src=x onerror="alert(1)">';
    expect(maliciousSetting).toContain('"');
    expect(maliciousSetting).toContain("<img");

    for (const blockName of ["app-embed.liquid", "loyalty-landing.liquid"]) {
      const liquid = fs
        .readFileSync(path.join(extensionDir, "blocks", blockName), "utf8")
        .split("{% schema %}")[0];
      const merchantSettingOutputs =
        liquid.match(/{{\s*block\.settings\.[^}]*}}/g) || [];

      expect(merchantSettingOutputs.length).toBeGreaterThan(0);
      for (const output of merchantSettingOutputs) {
        expect(output).toMatch(/\|\s*escape\s*}}$/);
      }
    }
  });

  it("mounts the visible loyalty launcher app embed in the document body", () => {
    const liquid = fs.readFileSync(
      path.join(extensionDir, "blocks/app-embed.liquid"),
      "utf8",
    );
    const schemaSource = liquid.match(
      /{% schema %}\s*([\s\S]*?)\s*{% endschema %}/,
    )?.[1];

    expect(schemaSource).toBeDefined();
    expect(JSON.parse(schemaSource!)).toMatchObject({ target: "body" });
  });

  it("renders product points from the nested authoritative base earn rate", async () => {
    document.body.innerHTML = [
      '<div class="weletic-product-points-container"',
      ' data-shop="store.myshopify.com"',
      ' data-currency="USD"',
      ' data-current-price="4800"',
      ' data-proxy-prefix="/apps/weletic">',
      '<strong class="weletic-points-number">placeholder</strong>',
      "</div>",
    ].join("");
    setReadyStateComplete();

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: {
          program: {
            isActive: true,
            pointsPerCurrencyUnit: "2.5",
          },
          // This is not part of the public contract and must never be treated
          // as an authoritative campaign multiplier by the theme asset.
          activeMultiplier: "99",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    new Function(productPointsSource)();

    await vi.waitFor(() => {
      expect(
        document.querySelector(".weletic-points-number")?.textContent,
      ).toBe("120");
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/apps/weletic/program?shop=store.myshopify.com",
    );
    expect(productPointsSource).not.toContain("activeMultiplier");
  });
});
