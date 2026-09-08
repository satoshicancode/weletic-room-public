/** @vitest-environment happy-dom */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const widgetPath = path.resolve(
  process.cwd(),
  "../../packages/shopify-app/extensions/weletic-analytics/assets/weletic-loyalty-widget.js",
);
const sharedPath = path.resolve(
  process.cwd(),
  "../../packages/shopify-app/extensions/weletic-analytics/assets/weletic-loyalty-shared.js",
);

describe("storefront referral capture runtime", () => {
  beforeEach(() => {
    document.body.innerHTML = [
      '<div id="weletic-loyalty-root"',
      ' data-shop="n0pvef-cs.myshopify.com"',
      ' data-logged-in="false"',
      ' data-proxy-prefix="/apps/weletic"></div>',
    ].join("");
    window.history.replaceState({}, "", "/?ref=ALICE-1234");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: {
            branding: {},
            earningRules: [],
            program: { isActive: true },
            referralOffer: {
              isActive: true,
              friendClaimEnabled: true,
              friendRewardKind: "coupon",
              friendRewardName: "Welcome reward",
              advocateRewardKind: "points",
              advocatePointsReward: "100",
            },
            rewards: [],
            tiers: [],
          },
        }),
      ),
    );
  });

  afterEach(() => {
    (window as any).WeleticLoyaltyWidgetRuntime?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (window as any).WeleticLoyaltyShared;
    delete (window as any).WeleticLoyaltyWidgetRuntime;
    window.sessionStorage.clear();
    document.body.innerHTML = "";
  });

  it("keeps the URL referral usable when session storage rejects writes", async () => {
    const setItemSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Storage blocked", "SecurityError");
      });
    Object.defineProperty(document, "readyState", {
      configurable: true,
      value: "complete",
    });

    const sharedSource = fs.readFileSync(sharedPath, "utf8");
    const widgetSource = fs.readFileSync(widgetPath, "utf8");
    new Function(sharedSource)();
    new Function(widgetSource)();
    setItemSpy.mockRestore();

    const launcher = document.querySelector<HTMLButtonElement>(
      ".weletic-launcher-btn",
    );
    expect(launcher).not.toBeNull();
    launcher!.click();

    await vi.waitFor(() => {
      expect(
        document.querySelector("#weletic-friend-claim-form"),
      ).not.toBeNull();
    });
  });

  it("binds a captured referral once without opening the rewards drawer", async () => {
    document.body.innerHTML = [
      '<div id="weletic-loyalty-root"',
      ' data-shop="n0pvef-cs.myshopify.com"',
      ' data-logged-in="true"',
      ' data-proxy-prefix="/apps/weletic"></div>',
    ].join("");
    Object.defineProperty(document, "readyState", {
      configurable: true,
      value: "complete",
    });
    window.history.replaceState({}, "", "/");
    window.sessionStorage.setItem("weletic_referral_code", "ALICE-1234");

    const bindBodies: unknown[] = [];
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/customer/referral/bind")) {
          bindBodies.push(JSON.parse(String(init?.body || "{}")));
          return Response.json({ data: { success: true, status: "pending" } });
        }
        if (url.includes("/customer?")) {
          return Response.json({
            data: {
              isEnrolled: true,
              account: {
                status: "active",
                canParticipate: true,
                pointsBalance: "100",
              },
              program: { isActive: true },
              rewardWallet: [],
            },
          });
        }
        return Response.json({
          data: {
            program: { isActive: true },
            branding: {},
            earningRules: [],
            rewards: [],
            tiers: [],
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    new Function(fs.readFileSync(sharedPath, "utf8"))();
    new Function(fs.readFileSync(widgetPath, "utf8"))();

    await vi.waitFor(() => {
      expect(bindBodies).toEqual([{ referralCode: "ALICE-1234" }]);
      expect(window.sessionStorage.getItem("weletic_referral_code")).toBeNull();
    });
    expect(
      document
        .querySelector(".weletic-drawer")
        ?.classList.contains("weletic-open"),
    ).toBe(false);

    document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();
    document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();
    expect(bindBodies).toHaveLength(1);
  });

  it("retains a captured referral after a transient bind failure", async () => {
    document.body.innerHTML =
      '<div id="weletic-loyalty-root" data-shop="n0pvef-cs.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>';
    Object.defineProperty(document, "readyState", {
      configurable: true,
      value: "complete",
    });

    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/customer/referral/bind")) {
        return Response.json(
          { error: { code: "unavailable", message: "Retry later" } },
          { status: 503 },
        );
      }
      if (url.includes("/customer?")) {
        return Response.json({
          data: {
            isEnrolled: true,
            account: {
              status: "active",
              canParticipate: true,
              pointsBalance: "100",
            },
            program: { isActive: true },
          },
        });
      }
      return Response.json({
        data: {
          program: { isActive: true },
          branding: {},
          earningRules: [],
          rewards: [],
          tiers: [],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    new Function(fs.readFileSync(sharedPath, "utf8"))();
    new Function(fs.readFileSync(widgetPath, "utf8"))();
    await vi.waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([url]) =>
          String(url).includes("/customer/referral/bind"),
        ),
      ).toBe(true);
    });
    expect(window.sessionStorage.getItem("weletic_referral_code")).toBe(
      "ALICE-1234",
    );
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

    document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();
    await vi.waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes("/customer/referral/bind"),
        ),
      ).toHaveLength(2);
    });
    expect(window.sessionStorage.getItem("weletic_referral_code")).toBe(
      "ALICE-1234",
    );
  });

  it("clears terminal referrals but never binds for a restricted member", async () => {
    document.body.innerHTML =
      '<div id="weletic-loyalty-root" data-shop="n0pvef-cs.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>';
    Object.defineProperty(document, "readyState", {
      configurable: true,
      value: "complete",
    });

    let status = "active";
    let canParticipate = true;
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("/customer/referral/bind")) {
        return Response.json(
          { error: { code: "referral_bind_failed", message: "Invalid code" } },
          { status: 422 },
        );
      }
      if (url.includes("/customer?")) {
        return Response.json({
          data: {
            isEnrolled: true,
            account: { status, canParticipate, pointsBalance: "100" },
            program: { isActive: true },
          },
        });
      }
      return Response.json({
        data: {
          program: { isActive: true },
          branding: {},
          earningRules: [],
          rewards: [],
          tiers: [],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    new Function(fs.readFileSync(sharedPath, "utf8"))();
    new Function(fs.readFileSync(widgetPath, "utf8"))();
    await vi.waitFor(() => {
      expect(window.sessionStorage.getItem("weletic_referral_code")).toBeNull();
    });

    (window as any).WeleticLoyaltyWidgetRuntime.dispose();
    delete (window as any).WeleticLoyaltyShared;
    delete (window as any).WeleticLoyaltyWidgetRuntime;
    window.history.replaceState({}, "", "/?ref=BOB-5678");
    document.body.innerHTML =
      '<div id="weletic-loyalty-root" data-shop="n0pvef-cs.myshopify.com" data-logged-in="true" data-proxy-prefix="/apps/weletic"></div>';
    status = "suspended";
    canParticipate = false;
    fetchMock.mockClear();

    new Function(fs.readFileSync(sharedPath, "utf8"))();
    new Function(fs.readFileSync(widgetPath, "utf8"))();
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")
          ?.hidden,
      ).toBe(false);
    });
    document.querySelector<HTMLButtonElement>(".weletic-launcher-btn")!.click();
    await vi.waitFor(() => {
      expect(
        document.querySelector(".weletic-account-restricted"),
      ).not.toBeNull();
    });
    expect(
      fetchMock.mock.calls.some(([url]) =>
        String(url).includes("/customer/referral/bind"),
      ),
    ).toBe(false);
    expect(window.sessionStorage.getItem("weletic_referral_code")).toBe(
      "BOB-5678",
    );
  });
});
