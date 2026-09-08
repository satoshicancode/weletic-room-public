// @vitest-environment jsdom

import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoyaltyAdminApi } from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/api-client";
import { TabOnsite } from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/modules/tab-onsite";
import {
  LoyaltyWidget,
  resolveLoyaltyPanelSubtitle,
} from "../../components/weletic/loyalty/LoyaltyWidget";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const loadedBranding = {
  launcherText: "Loaded Rewards",
  launcherPosition: "bottom_left" as const,
  launcherIcon: "crown" as const,
  primaryColor: "#112233",
  headerTextColor: "#ffffff",
  panelTitle: "Loaded Loyalty Club",
  panelWelcomeSubtitle: "The saved server configuration.",
  heroImageUrl: null,
  enableFloatingLauncher: false,
};

describe("merchant on-site branding load safety", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const renderOnsite = (props: ComponentProps<typeof TabOnsite>) => {
    act(() => {
      root.render(createElement(TabOnsite, props));
    });
  };

  it("shows the load error, disables saving, and retries safely", () => {
    const onRefresh = vi.fn();
    renderOnsite({
      branding: null,
      brandingLoaded: false,
      brandingLoadError:
        "Saved on-site branding could not be loaded. Request failed.",
      onRefresh,
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Saved on-site branding could not be loaded",
    );
    expect(container.querySelector("fieldset")?.hasAttribute("disabled")).toBe(
      true,
    );
    const saveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Save On-Site Customization"),
    );
    expect(saveButton?.hasAttribute("disabled")).toBe(true);

    const retryButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent?.includes("Retry"),
    );
    act(() => retryButton?.click());
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("synchronizes loaded branding before editing and submits the saved contract", async () => {
    const onRefresh = vi.fn();
    const updateBranding = vi
      .spyOn(LoyaltyAdminApi, "updateBranding")
      .mockResolvedValue({ success: true, branding: loadedBranding });

    renderOnsite({
      branding: null,
      brandingLoaded: false,
      brandingLoadError: null,
      onRefresh,
    });
    expect(container.querySelector("fieldset")?.hasAttribute("disabled")).toBe(
      true,
    );

    renderOnsite({
      branding: loadedBranding,
      brandingLoaded: true,
      brandingLoadError: null,
      onRefresh,
    });

    const launcherInput =
      container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(launcherInput?.value).toBe("Loaded Rewards");
    expect(container.querySelector("fieldset")?.hasAttribute("disabled")).toBe(
      false,
    );

    act(() => {
      if (!launcherInput) throw new Error("Launcher input not rendered.");
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(launcherInput, "Edited Rewards");
      launcherInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      container
        .querySelector("form")
        ?.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });

    expect(updateBranding).toHaveBeenCalledWith({
      ...loadedBranding,
      launcherText: "Edited Rewards",
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("preserves an intentionally empty subtitle in the live dashboard preview", () => {
    renderOnsite({
      branding: { ...loadedBranding, panelWelcomeSubtitle: "" },
      brandingLoaded: true,
      brandingLoadError: null,
      onRefresh: vi.fn(),
    });

    expect(
      container.querySelector("[data-loyalty-panel-subtitle]")?.textContent,
    ).toBe("");
    expect(resolveLoyaltyPanelSubtitle("")).toBe("");
  });

  it("renders shopper-safe online catalog, currency, tier, and referral economics in the real preview", () => {
    renderOnsite({
      branding: loadedBranding,
      brandingLoaded: true,
      brandingLoadError: null,
      currency: "EUR",
      pointNameSingular: "Coin",
      pointNamePlural: "Coins",
      rewards: [
        {
          id: "friend-coupon",
          name: "Friend welcome coupon",
          status: "active",
          salesChannel: "online_store",
          exchangeType: "fixed",
          rewardType: "amount_off",
          pointsCost: "500",
          discountValue: "700",
          minOrderAmount: "3000",
        },
        {
          id: "both-reward",
          name: "Both-channel reward",
          status: "active",
          salesChannel: "both",
          exchangeType: "fixed",
          rewardType: "amount_off",
          pointsCost: "9007199254740993",
          discountValue: "500",
          minOrderAmount: "9007199254740993",
        },
        {
          id: "pos-reward",
          name: "POS-only reward",
          status: "active",
          salesChannel: "pos",
          exchangeType: "fixed",
          rewardType: "amount_off",
          pointsCost: "100",
          discountValue: "100",
        },
        {
          id: "inactive-reward",
          name: "Inactive online reward",
          status: "inactive",
          salesChannel: "online_store",
          exchangeType: "fixed",
          rewardType: "amount_off",
          pointsCost: "100",
          discountValue: "100",
        },
      ],
      tiers: [
        {
          id: "gold",
          name: "Gold",
          minSpendThreshold: "12345",
          pointsMultiplier: "1.5",
          perks: [],
        },
      ],
      referralRule: {
        isActive: true,
        refereeRewardKind: "coupon",
        refereeRewardDefinitionId: "friend-coupon",
        refereePointsReward: "0",
        advocateRewardKind: "points",
        advocatePointsReward: "750",
      },
      onRefresh: vi.fn(),
    });

    expect(container.textContent).toContain(
      "Give Friend welcome coupon, get 750 Coins",
    );
    expect(container.textContent).not.toContain("Give $10, Get 100");

    const clickTab = (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (candidate) => candidate.textContent?.trim() === label,
      );
      expect(button).toBeDefined();
      act(() => button?.click());
    };

    clickTab("Redeem");
    expect(container.textContent).toContain("Friend welcome coupon");
    expect(container.textContent).toContain("Both-channel reward");
    expect(container.textContent).toContain("Min €30.00");
    expect(container.textContent).toContain("Min €90,071,992,547,409.93");
    expect(container.textContent).toContain("9,007,199,254,740,993 Coins");
    expect(container.textContent).not.toContain("POS-only reward");
    expect(container.textContent).not.toContain("Inactive online reward");

    clickTab("VIP Tiers");
    expect(container.textContent).toContain("Spend: €123.45");
    expect(container.textContent).not.toContain("¥12,345");

    clickTab("Referrals");
    expect(container.textContent).toContain(
      "Give Friend welcome coupon, Get 750 Coins",
    );
  });

  it.each([
    { label: "wrapped", wrap: (data: any) => ({ data }) },
    { label: "unwrapped", wrap: (data: any) => data },
  ])(
    "loads and redeems through the $label live API payload",
    async ({ wrap }) => {
      const summary = {
        shopper: { firstName: "Ada" },
        account: {
          pointsBalance: "9007199254740993",
          pendingPoints: "2",
        },
        program: {
          currency: "USD",
          pointNameSingular: "Coin",
          pointNamePlural: "Coins",
        },
        tier: {
          currentTier: { name: "Gold", pointsMultiplier: "1.5" },
          nextTier: null,
          allTiers: [],
          progress: null,
        },
        referral: { offer: null, referralShareUrl: null },
        waysToEarn: [],
        rewards: [
          {
            id: "exact-reward",
            name: "Exact reward",
            salesChannel: "online_store",
            exchangeType: "fixed",
            rewardType: "amount_off",
            pointsCost: "9007199254740992",
            minOrderAmount: null,
            canRedeem: true,
          },
        ],
        recentActivity: [],
      };
      const fetchMock = vi.fn(
        async (_url: string, init?: RequestInit): Promise<Response> => {
          if (init?.method === "POST") {
            return new Response(
              JSON.stringify(
                wrap({
                  artifactKind: "discount_code",
                  artifactCode: "SAVE-EXACT",
                  discountCode: "SAVE-EXACT",
                }),
              ),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify(wrap(summary)), { status: 200 });
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("alert", vi.fn());
      vi.stubGlobal("crypto", { randomUUID: () => "intent-key" });

      act(() => {
        root.render(
          createElement(LoyaltyWidget, {
            apiBaseUrl: "https://app.example",
            isOpenDefault: true,
            shopDomain: "store.myshopify.com",
            shopifyCustomerId: "123",
          }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      await vi.waitFor(() => {
        expect(container.textContent).toContain("Hi, Ada");
        expect(container.textContent).toContain("9,007,199,254,740,993");
      });

      const redeemTab = [...container.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === "Redeem",
      );
      act(() => redeemTab?.click());
      const redeemButtons = [...container.querySelectorAll("button")].filter(
        (button) => button.textContent?.trim() === "Redeem",
      );
      expect(redeemButtons).toHaveLength(2);
      await act(async () => {
        redeemButtons.at(-1)?.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(container.textContent).toContain("SAVE-EXACT");
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://app.example/apps/weletic/customer/redeem",
        expect.objectContaining({ method: "POST" }),
      );
    },
  );
});
