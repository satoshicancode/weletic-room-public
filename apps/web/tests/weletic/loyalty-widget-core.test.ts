/** @vitest-environment happy-dom */

import { getDefaultLauncherPresentation } from "@/lib/weletic/loyalty/launcher-presentation";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const reward = {
  id: "fixed-reward",
  name: "Fixed reward",
  rewardType: "amount_off",
  salesChannel: "online_store",
  exchangeType: "fixed",
  pointsCost: "1000",
  discountValue: "500",
};
const program = {
  program: {
    isActive: true,
    pointNameSingular: "Point",
    pointNamePlural: "Points",
  },
  branding: { panelTitle: "Weletic Rewards", enableFloatingLauncher: true },
  currency: "JPY",
  rewards: [reward],
  tiers: [],
  earningRules: [],
};

function response(data: unknown, status = 200) {
  return new Response(
    JSON.stringify(status < 400 ? { data } : { error: data }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

async function mount(
  options: {
    locale?: string;
    branding?: Record<string, unknown>;
    balance?: string;
    guest?: boolean;
    initialStatus?: number;
    programStatus?: number;
    activity?: boolean;
    redeem?: (
      body: Record<string, unknown>,
      attempt: number,
    ) => Promise<Response>;
    refresh?: () => Response;
  } = {},
) {
  document.documentElement.lang = options.locale || "en";
  document.body.innerHTML = `<a href="#outside">Outside</a><div data-weletic-loyalty-root data-shop="fixture.myshopify.com" data-logged-in="${!options.guest}" data-currency="JPY"></div>`;
  Object.defineProperty(document, "readyState", {
    configurable: true,
    value: "complete",
  });
  let issued = false;
  const requests: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/customer/redeem")) {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      const result = options.redeem
        ? await options.redeem(body, requests.length)
        : response({
            success: true,
            artifactKind: "discount_code",
            artifactCode: "FIXTURE-CODE",
          });
      if (result.ok) issued = true;
      return result;
    }
    if (url.includes("/customer?")) {
      if (options.initialStatus)
        return response({ code: "unauthorized" }, options.initialStatus);
      if (issued && options.refresh) return options.refresh();
      return response({
        isEnrolled: true,
        account: {
          id: "PRIVATE_ACCOUNT",
          status: "active",
          canParticipate: true,
          pointsBalance: options.balance || (issued ? "1500" : "2500"),
          pendingPoints: "300",
        },
        shopper: {
          id: "PRIVATE_SHOPPER",
          firstName: "PRIVATE_NAME",
          email: "private@example.test",
          shopifyCustomerId: "PRIVATE_SHOPIFY_ID",
        },
        program: program.program,
        rewardWallet: issued
          ? [
              {
                id: "wallet",
                rewardName: reward.name,
                status: "available",
                artifactKind: "discount_code",
                artifactCode: "FIXTURE-CODE",
                pointsSpent: "1000",
              },
              {
                id: "used-wallet",
                rewardName: "Earlier reward",
                status: "used",
                artifactKind: "discount_code",
                artifactCode: "USED-FIXTURE",
                statusDate: "2026-09-08T03:00:00Z",
              },
            ]
          : [],
      });
    }
    if (options.programStatus)
      return response({ code: "unavailable" }, options.programStatus);
    return response(
      options.activity
        ? {
            ...program,
            earningRules: [
              {
                id: "action",
                name: "Visit",
                action: { label: "Visit", url: "https://example.test" },
              },
            ],
          }
        : {
            ...program,
            branding: { ...program.branding, ...options.branding },
          },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("alert", vi.fn());
  new Function(shared)();
  new Function(widget)();
  button(".weletic-launcher-btn").click();
  await vi.waitFor(() =>
    expect(document.querySelector(".weletic-load-state")).toBeNull(),
  );
  return { requests, fetchMock };
}

function button(selector: string) {
  return document.querySelector<HTMLButtonElement>(selector)!;
}
function selectReward() {
  button("[data-redeem-id]").click();
}
function confirmReward() {
  button("#weletic-confirm-redemption").click();
}

afterEach(() => {
  (window as any).WeleticLoyaltyWidgetRuntime?.dispose();
  delete (window as any).WeleticLoyaltyWidgetRuntime;
  delete (window as any).WeleticLoyaltyShared;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  document.documentElement.lang = "en";
  sessionStorage.clear();
});

describe("actual loyalty drawer core journey with mocked transport", () => {
  it("does not expose the floating launcher when initial visibility policy cannot load", async () => {
    await mount({ programStatus: 503 });
    expect(button(".weletic-launcher-btn").hidden).toBe(true);
  });
  it("applies device overrides and updates visibility on resize", async () => {
    vi.stubGlobal("innerWidth", 375);
    const presentation = getDefaultLauncherPresentation();
    presentation.mobile = {
      ...presentation.mobile,
      text: "Quà <b>tặng</b>",
      position: "bottom_left",
      layout: "text_only",
      sideSpacing: 16,
      bottomSpacing: 20,
    };
    presentation.shape = "rounded";
    await mount({ branding: { launcherPresentation: presentation } });
    const launcher = button(".weletic-launcher-btn");
    expect(launcher.getAttribute("aria-label")).toBe("Quà <b>tặng</b>");
    expect(launcher.querySelector("b")).toBeNull();
    expect(launcher.dataset.layout).toBe("text_only");
    expect(launcher.dataset.shape).toBe("rounded");
    expect(launcher.classList.contains("weletic-pos-left")).toBe(true);
    expect(launcher.style.getPropertyValue("--weletic-launcher-side")).toBe(
      "16px",
    );
    vi.stubGlobal("innerWidth", 1024);
    window.dispatchEvent(new Event("resize"));
    expect(launcher.dataset.layout).toBe("icon_text");
    expect(launcher.style.getPropertyValue("--weletic-launcher-side")).toBe(
      "24px",
    );
  });

  it("hides a desktop-only launcher on mobile and removes responsive listeners on disposal", async () => {
    vi.stubGlobal("innerWidth", 1024);
    const remove = vi.spyOn(window, "removeEventListener");
    await mount({
      branding: {
        launcherPresentation: {
          ...getDefaultLauncherPresentation(),
          visibility: "desktop_only",
        },
      },
    });
    const launcher = button(".weletic-launcher-btn");
    expect(launcher.hidden).toBe(false);
    vi.stubGlobal("innerWidth", 375);
    window.dispatchEvent(new Event("resize"));
    expect(launcher.hidden).toBe(true);
    (window as any).WeleticLoyaltyWidgetRuntime.dispose();
    for (const name of ["resize", "popstate", "hashchange"])
      expect(remove).toHaveBeenCalledWith(name, expect.any(Function));
  });

  it("fails closed on malformed presentation", async () => {
    await mount({ branding: { launcherPresentation: { visibility: "all" } } });
    expect(button(".weletic-launcher-btn").hidden).toBe(true);
  });

  it.each([
    [
      "en",
      "Available Points",
      "Confirm redemption",
      "Reward Redeemed!",
      "1,000 points will be spent.",
      "Become a VIP Member",
    ],
    [
      "ja",
      "利用可能ポイント",
      "交換を確定",
      "特典を交換しました！",
      "1,000ポイントを使用します。",
      "会員になる",
    ],
    [
      "vi",
      "Điểm khả dụng",
      "Xác nhận đổi thưởng",
      "Đổi thưởng thành công!",
      "Bạn sẽ sử dụng 1.000 điểm.",
      "Trở thành thành viên VIP",
    ],
  ])(
    "localizes the %s core journey without translating merchant content",
    async (locale, balanceLabel, confirmLabel, successLabel, pointsLabel) => {
      await mount({ locale });
      expect(
        document.querySelector(".weletic-points-lbl")?.textContent,
      ).toContain(balanceLabel);
      expect(document.body.textContent).toContain("Fixed reward");
      selectReward();
      expect(button("#weletic-confirm-redemption").textContent).toBe(
        confirmLabel,
      );
      expect(
        document.querySelector(".weletic-redemption-confirmation")?.textContent,
      ).toContain(pointsLabel);
      confirmReward();
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(successLabel),
      );
      expect(
        document.querySelector(".weletic-wallet-card")?.textContent,
      ).toContain("FIXTURE-CODE");
      expect(document.body.innerHTML).not.toContain("PRIVATE_");
    },
  );

  it.each([
    ["en", "Become a VIP Member"],
    ["ja", "会員になる"],
    ["vi", "Trở thành thành viên VIP"],
  ])(
    "localizes the %s guest state without fetching private data",
    async (locale, heading) => {
      const { fetchMock, requests } = await mount({ locale, guest: true });
      expect(document.querySelector(".weletic-guest-title")?.textContent).toBe(
        heading,
      );
      expect(document.querySelector(".weletic-user-card")).toBeNull();
      expect(
        fetchMock.mock.calls.some(([url]) => url.includes("/customer")),
      ).toBe(false);
      expect(requests).toHaveLength(0);
    },
  );

  it.each([401, 403])(
    "treats initial summary HTTP %s as expired authentication, not enrollment",
    async (initialStatus) => {
      await mount({ initialStatus });
      expect(document.body.textContent).toContain("Your session expired");
      expect(document.querySelector(".weletic-guest-box")).toBeNull();
      expect(document.querySelector(".weletic-user-card")).toBeNull();
      expect(document.querySelector("#weletic-customer-retry")).toBeNull();
    },
  );

  it("does not let an outstanding activity summary restore member data after redemption authentication expires", async () => {
    const { fetchMock } = await mount({ activity: true });
    let resolveSummary!: (value: Response) => void;
    const summary = new Promise<Response>((resolve) => {
      resolveSummary = resolve;
    });
    let summaryStarted = false;
    let releaseRedemption!: () => void;
    const redemptionGate = new Promise<void>((resolve) => {
      releaseRedemption = resolve;
    });
    fetchMock.mockImplementation(async (url) => {
      if (url.includes("/activity/claim"))
        return response({ pointsAwarded: "10" });
      if (url.includes("/customer?")) {
        summaryStarted = true;
        return summary;
      }
      await redemptionGate;
      return response({ code: "unauthorized" }, 401);
    });
    button('[data-tab="earn"]').click();
    const activity =
      document.querySelector<HTMLAnchorElement>("[data-activity-id]")!;
    activity.addEventListener("click", (event) => event.preventDefault());
    activity.click();
    button('[data-tab="redeem"]').click();
    selectReward();
    confirmReward();
    await vi.waitFor(() => expect(summaryStarted).toBe(true));
    releaseRedemption();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Your session expired"),
    );
    resolveSummary(
      response({
        isEnrolled: true,
        account: {
          status: "active",
          canParticipate: true,
          pointsBalance: "9999",
        },
        program: program.program,
        rewardWallet: [
          { status: "available", rewardName: "STALE_PRIVATE_WALLET" },
        ],
      }),
    );
    await summary;
    await new Promise((resolve) => setTimeout(resolve, 0));
    button('[data-tab="home"]').click();
    expect(document.querySelector(".weletic-user-card")).toBeNull();
    expect(document.body.textContent).not.toContain("STALE_PRIVATE_WALLET");
    expect(document.body.textContent).toContain("Your session expired");
  });

  it("keeps the initially opened drawer visible after metadata and customer loading without rendering private identity", async () => {
    await mount();
    expect(button(".weletic-drawer").classList.contains("weletic-open")).toBe(
      true,
    );
    expect(button(".weletic-drawer").hidden).toBe(false);
    expect(button(".weletic-drawer").getAttribute("aria-label")).toBe(
      "Weletic Rewards",
    );
    expect(button(".weletic-drawer").innerHTML).not.toMatch(
      /PRIVATE_|private@example/,
    );
    expect(document.activeElement).toBe(button(".weletic-close-btn"));
    expect(
      document.querySelector(".weletic-points-val")?.textContent,
    ).toContain("2,500");
    expect(
      document.querySelector(".weletic-points-lbl")?.textContent,
    ).toContain("300 pending");
  });

  it("ignores a pre-redemption activity summary arriving after the fresh post-redemption balance", async () => {
    const { fetchMock } = await mount({ activity: true });
    let resolveSummary!: (value: Response) => void;
    const stale = new Promise<Response>((resolve) => {
      resolveSummary = resolve;
    });
    let summaryCount = 0;
    let releaseRedemption!: () => void;
    const redemptionGate = new Promise<void>((resolve) => {
      releaseRedemption = resolve;
    });
    const customer = (pointsBalance: string) =>
      response({
        isEnrolled: true,
        account: { status: "active", canParticipate: true, pointsBalance },
        program: program.program,
        rewardWallet: [],
      });
    fetchMock.mockImplementation(async (url) => {
      if (url.includes("/activity/claim"))
        return response({ pointsAwarded: "10" });
      if (url.includes("/customer?"))
        return ++summaryCount === 1 ? stale : customer("1500");
      await redemptionGate;
      return response({
        success: true,
        artifactKind: "discount_code",
        artifactCode: "FRESH-CODE",
      });
    });
    button('[data-tab="earn"]').click();
    const activity =
      document.querySelector<HTMLAnchorElement>("[data-activity-id]")!;
    activity.addEventListener("click", (event) => event.preventDefault());
    activity.click();
    button('[data-tab="redeem"]').click();
    selectReward();
    confirmReward();
    await vi.waitFor(() => expect(summaryCount).toBe(1));
    releaseRedemption();
    await vi.waitFor(() =>
      expect(document.querySelector(".weletic-points-val")?.textContent).toBe(
        "1,500",
      ),
    );
    resolveSummary(customer("2500"));
    await stale;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector(".weletic-points-val")?.textContent).toBe(
      "1,500",
    );
    expect(document.body.textContent).toContain("FRESH-CODE");
  });

  it("requires confirmation, cancels without a request, and shows successful redemption in wallet from the redeem tab", async () => {
    const { requests } = await mount();
    button('[data-tab="redeem"]').click();
    selectReward();
    expect(requests).toHaveLength(0);
    expect(
      document.querySelector(".weletic-redemption-confirmation")?.textContent,
    ).toContain("1,000 points will be spent");
    button("#weletic-cancel-redemption").click();
    expect(requests).toHaveLength(0);
    selectReward();
    confirmReward();
    await vi.waitFor(() =>
      expect(
        document.querySelector(".weletic-wallet-card")?.textContent,
      ).toContain("FIXTURE-CODE"),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ rewardDefinitionId: "fixed-reward" });
    expect(document.querySelector(".weletic-points-val")?.textContent).toBe(
      "1,500",
    );
    expect(
      button('[data-tab="home"]').classList.contains("weletic-active"),
    ).toBe(true);
  });

  it("keeps the balance gated if a newer activity summary supersedes the post-redemption read and fails", async () => {
    const { fetchMock } = await mount({ activity: true });
    let resolveActivity!: (value: Response) => void;
    let resolveRedemptionSummary!: (value: Response) => void;
    const activityResult = new Promise<Response>((resolve) => {
      resolveActivity = resolve;
    });
    const redemptionSummary = new Promise<Response>((resolve) => {
      resolveRedemptionSummary = resolve;
    });
    let summaryCount = 0;
    const fresh = () =>
      response({
        isEnrolled: true,
        account: {
          status: "active",
          canParticipate: true,
          pointsBalance: "1500",
        },
        program: program.program,
        rewardWallet: [],
      });
    fetchMock.mockImplementation(async (url) => {
      if (url.includes("/activity/claim")) return activityResult;
      if (url.includes("/customer?")) {
        summaryCount++;
        return summaryCount === 1
          ? redemptionSummary
          : summaryCount === 2
            ? response({ code: "unavailable" }, 503)
            : fresh();
      }
      return response({
        success: true,
        artifactKind: "discount_code",
        artifactCode: "ISSUED-CODE",
      });
    });
    button('[data-tab="earn"]').click();
    const activity =
      document.querySelector<HTMLAnchorElement>("[data-activity-id]")!;
    activity.addEventListener("click", (event) => event.preventDefault());
    activity.click();
    button('[data-tab="redeem"]').click();
    selectReward();
    confirmReward();
    await vi.waitFor(() => expect(summaryCount).toBe(1));
    resolveActivity(response({ pointsAwarded: "10" }));
    await vi.waitFor(() => expect(summaryCount).toBe(2));
    resolveRedemptionSummary(fresh());
    await redemptionSummary;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector(".weletic-points-val")).toBeNull();
    expect(button("[data-redeem-id]").disabled).toBe(true);
    expect(document.body.textContent).toContain("ISSUED-CODE");
    button("#weletic-customer-retry").click();
    await vi.waitFor(() =>
      expect(document.querySelector(".weletic-points-val")?.textContent).toBe(
        "1,500",
      ),
    );
    expect(button("[data-redeem-id]").disabled).toBe(false);
  });

  it("suppresses duplicate confirmation while a request is pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { requests } = await mount({
      redeem: async () => {
        await gate;
        return response({ success: true });
      },
    });
    selectReward();
    const confirm = button("#weletic-confirm-redemption");
    confirm.click();
    confirm.click();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(button("[data-redeem-id]").disabled).toBe(true);
    release();
    await vi.waitFor(() =>
      expect(button("[data-redeem-id]").disabled).toBe(false),
    );
  });

  it("keeps the idempotency key for an explicit retry after an ambiguous response and never retries automatically", async () => {
    const { requests } = await mount({
      redeem: async (_body, attempt) => {
        if (attempt === 1)
          throw new TypeError("lost response with PRIVATE_TRANSPORT_DETAIL");
        return response({ success: true });
      },
    });
    selectReward();
    confirmReward();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("could not confirm"),
    );
    expect(requests).toHaveLength(1);
    expect(document.body.textContent).not.toContain("PRIVATE_TRANSPORT_DETAIL");
    expect(document.querySelector(".weletic-points-val")).toBeNull();
    expect(button("[data-redeem-id]").disabled).toBe(true);
    button("#weletic-customer-retry").click();
    await vi.waitFor(() =>
      expect(button("[data-redeem-id]").disabled).toBe(false),
    );
    selectReward();
    confirmReward();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0].idempotencyKey).toBe(requests[1].idempotencyKey);
  });

  it("clears private wallet state and disables further writes after authentication expires", async () => {
    const { requests } = await mount({
      redeem: async () =>
        response({ code: "unauthorized", message: "PRIVATE_AUTH_DETAIL" }, 401),
    });
    selectReward();
    confirmReward();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Your session expired"),
    );
    expect(document.querySelector(".weletic-points-val")).toBeNull();
    expect(document.querySelector(".weletic-wallet-card")).toBeNull();
    expect(document.body.textContent).not.toContain("PRIVATE_");
    button('[data-tab="redeem"]').click();
    expect(button("[data-redeem-id]").disabled).toBe(true);
    button("[data-redeem-id]").click();
    expect(requests).toHaveLength(1);
  });

  it("handles the existing generic rejection contract for unavailable rewards without displaying private errors or claiming issuance", async () => {
    const { requests } = await mount({
      redeem: async () =>
        response(
          { code: "redemption_failed", message: "PRIVATE_CAPABILITY_DETAIL" },
          400,
        ),
    });
    selectReward();
    confirmReward();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("could not confirm"),
    );
    expect(requests).toHaveLength(1);
    expect(document.querySelector(".weletic-points-val")).toBeNull();
    expect(document.querySelector(".weletic-wallet-card")).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /Reward Redeemed|PRIVATE_CAPABILITY/,
    );
  });

  it("does not display a stale balance or allow another redemption after successful issuance with failed summary refresh", async () => {
    let refreshFails = true;
    const { requests } = await mount({
      refresh: () =>
        refreshFails
          ? response({ code: "unavailable" }, 503)
          : response({
              isEnrolled: true,
              account: {
                status: "active",
                canParticipate: true,
                pointsBalance: "1500",
                pendingPoints: "300",
              },
              program: program.program,
              rewardWallet: [],
            }),
    });
    selectReward();
    confirmReward();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("balance could not refresh"),
    );
    expect(document.body.textContent).toContain("FIXTURE-CODE");
    expect(document.querySelector(".weletic-points-val")).toBeNull();
    expect(button("[data-redeem-id]").disabled).toBe(true);
    button("#weletic-customer-retry").click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "Public program details remain available",
      ),
    );
    expect(document.body.textContent).toContain("FIXTURE-CODE");
    expect(document.querySelector(".weletic-guest-box")).toBeNull();
    refreshFails = false;
    button("#weletic-customer-retry").click();
    await vi.waitFor(() =>
      expect(document.querySelector(".weletic-points-val")?.textContent).toBe(
        "1,500",
      ),
    );
    expect(requests).toHaveLength(1);
  });

  it("blocks unaffordable rewards without treating pending points as available", async () => {
    const { requests } = await mount({ balance: "999" });
    expect(button("[data-redeem-id]").disabled).toBe(true);
    button("[data-redeem-id]").click();
    expect(
      document.querySelector(".weletic-redemption-confirmation"),
    ).toBeNull();
    expect(requests).toHaveLength(0);
  });

  it("traps keyboard focus, cancels confirmation with Escape, and restores launcher focus on close", async () => {
    await mount();
    const last = button("[data-redeem-id]");
    last.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(button(".weletic-close-btn"));
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(last);
    selectReward();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(
      document.querySelector(".weletic-redemption-confirmation"),
    ).toBeNull();
    expect(button(".weletic-drawer").hidden).toBe(false);
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(button(".weletic-drawer").hidden).toBe(true);
    expect(document.activeElement).toBe(button(".weletic-launcher-btn"));
  });
});
