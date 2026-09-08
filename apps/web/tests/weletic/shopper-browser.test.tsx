// @vitest-environment jsdom

import type { MerchantShopperDirectory } from "@/lib/weletic/shoppers/directory";
import type { MerchantShopperProfile } from "@/lib/weletic/shoppers/profile";
import { emptyShopperSegment } from "@/lib/weletic/shoppers/segment-query";
import { shopperCopy } from "@/ui/weletic/shoppers/copy";
import {
  ShopperBrowser,
  ShopperBrowserSession,
  type ShopperBrowserTransport,
} from "@/ui/weletic/shoppers/shopper-browser";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SWRConfig, type State } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const timestamp = "2026-09-06T00:00:00.000Z";
const pagination = { limit: 20, hasMore: false, nextCursor: null };
const directory: MerchantShopperDirectory = {
  items: [
    {
      id: "shopper-a",
      shopifyCustomerId: "1234",
      firstName: "Controlled",
      lastName: "Shopper",
      email: "fixture@example.test",
      createdAt: timestamp,
      loyalty: null,
    },
  ],
  pagination,
};
const overview = {
  section: "overview",
  shopper: {
    id: "shopper-a",
    shopifyCustomerId: "1234",
    firstName: "Controlled",
    lastName: "Shopper",
    email: "fixture@example.test",
    phone: null,
    locale: "ja",
    acceptsMarketing: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  locale: { shopper: "ja", merchant: "en" },
  communicationPreferences: {
    shopifyAcceptsMarketing: true,
    consentEvidence: "unavailable",
    consentSource: null,
    consentRecordedAt: null,
    suppressionStatus: "unavailable",
  },
  modules: {
    loyalty: { status: "active", killSwitchActive: true },
    reviews: { enabled: false, requestEmailEnabled: false },
  },
  loyalty: {
    id: "account-a",
    status: "active",
    tier: null,
    pointsBalance: "-9007199254740993",
    pendingPoints: "9007199254740995",
    lifetimeEarned: "0",
    lifetimeRedeemed: "0",
    enrolledAt: timestamp,
  },
  coverage: {
    communications: "partial",
    communicationSources: ["review_requests", "referral_friend_emailed_at"],
    reason: "Not provider acceptance",
    reviews: "native_product_reviews_only",
    rewards: "account_and_direct_shopper_rewards",
    purchases: "locally_projected_orders_only",
  },
} satisfies MerchantShopperProfile;

describe("shared shopper browser", () => {
  let container: HTMLDivElement;
  let root: Root;
  let cache: Map<string, State<unknown, unknown>>;
  let transport: ShopperBrowserTransport;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    cache = new Map();
    transport = {
      scopeKey: "workspace-a",
      list: vi.fn().mockResolvedValue(directory),
      profile: vi.fn().mockResolvedValue(overview),
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  async function render(
    props: Partial<ComponentProps<typeof ShopperBrowser>> = {},
    isolated = false,
  ) {
    await act(async () =>
      root.render(
        createElement(
          SWRConfig,
          {
            value: {
              provider: () => cache,
              dedupingInterval: 0,
              shouldRetryOnError: false,
              keepPreviousData: true,
            },
          },
          createElement(isolated ? ShopperBrowserSession : ShopperBrowser, {
            transport,
            shopperId: null,
            onSelect: vi.fn(),
            ...props,
          }),
        ),
      ),
    );
  }
  async function click(label: string) {
    const button = [...container.querySelectorAll("button")].find(
      (row) => row.textContent?.trim() === label,
    );
    expect(button, label).toBeDefined();
    await act(async () => button!.click());
  }
  async function field(name: string, value: string) {
    const element = container.querySelector<
      HTMLInputElement | HTMLSelectElement
    >(`[name="${name}"]`)!;
    expect(element).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        element instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype,
        "value",
      )!.set!.call(element, value);
      element.dispatchEvent(
        new Event(element instanceof HTMLSelectElement ? "change" : "input", {
          bubbles: true,
        }),
      );
    });
  }
  it("applies segment criteria, resets pagination, and hides stale results while the new query loads", async () => {
    let resolveSegment!: (value: MerchantShopperDirectory) => void;
    transport.list = vi.fn<ShopperBrowserTransport["list"]>(async (query) =>
      query.loyalty
        ? new Promise((resolve) => {
            resolveSegment = resolve;
          })
        : {
            ...directory,
            pagination: { ...pagination, hasMore: true, nextCursor: "next" },
          },
    );
    await render();
    await click("Next page");
    await field("loyalty", "active");
    await field("minPoints", "9007199254740993");
    await click("Search customers");
    expect(transport.list).toHaveBeenLastCalledWith({
      ...emptyShopperSegment,
      search: "",
      cursor: "",
      loyalty: "active",
      minPoints: "9007199254740993",
    });
    expect(container.textContent).not.toContain("fixture@example.test");
    await act(async () => resolveSegment({ items: [], pagination }));
    expect(container.textContent).toContain(shopperCopy.en.empty);
    await click("Clear segment");
    expect(container.textContent).toContain("fixture@example.test");
    expect(
      container.querySelector<HTMLSelectElement>('[name="loyalty"]')?.value,
    ).toBe("any");
    expect(
      container.querySelector<HTMLInputElement>('[name="minPoints"]')?.value,
    ).toBe("");
  });
  it("rejects contradictory segment criteria before sending a request", async () => {
    await render();
    await field("loyalty", "not_enrolled");
    await field("minPoints", "0");
    await click("Search customers");
    expect(transport.list).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Check the segment",
    );
  });
  it("shows normal validation for invalid paired numeric bounds", async () => {
    await render();
    await field("minPoints", "1.5");
    await field("maxPoints", "10");
    await click("Search customers");
    expect(transport.list).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Check the segment",
    );
  });
  it("opens reviews-only shoppers and advances an empty privacy-filtered page", async () => {
    const onSelect = vi.fn();
    transport.list = vi
      .fn()
      .mockResolvedValueOnce({
        items: [],
        pagination: { ...pagination, hasMore: true, nextCursor: "opaque-next" },
      })
      .mockResolvedValue(directory);
    await render({ onSelect });
    expect(container.textContent).toContain(shopperCopy.en.empty);
    await click("Next page");
    expect(transport.list).toHaveBeenLastCalledWith({
      search: "",
      cursor: "opaque-next",
    });
    expect(container.textContent).toContain("Not enrolled in loyalty");
    await click("Open profile 1234");
    expect(onSelect).toHaveBeenCalledWith("shopper-a");
  });
  it("submits bounded search and resets pagination", async () => {
    transport.list = vi.fn().mockResolvedValue({
      ...directory,
      pagination: { ...pagination, hasMore: true, nextCursor: "next" },
    });
    await render();
    await click("Next page");
    const input = container.querySelector("input")!;
    expect(input.maxLength).toBe(100);
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "  Controlled  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Search customers");
    expect(transport.list).toHaveBeenLastCalledWith({
      search: "Controlled",
      cursor: "",
    });
  });
  it("renders exact balances, safety pause and consent qualifications", async () => {
    const back = vi.fn();
    await render({ shopperId: "shopper-a", onSelect: back });
    expect(container.textContent).toContain("-9,007,199,254,740,993");
    expect(container.textContent).toContain("9,007,199,254,740,995");
    expect(container.textContent).toContain(shopperCopy.en.paused);
    expect(container.textContent).toContain(shopperCopy.en.consentUnknown);
    await click("← All customers");
    expect(back).toHaveBeenCalledWith(null);
  });
  it("renders exact zero/three-decimal amounts and ledger pending deltas", async () => {
    transport.profile = vi.fn<ShopperBrowserTransport["profile"]>(
      async ({ section }) => {
        if (section === "purchases")
          return {
            section,
            pagination,
            items: [
              {
                id: "jpy",
                createdAt: timestamp,
                occurredAt: timestamp,
                orderName: "JPY fixture",
                status: "paid",
                accountingCurrency: "JPY",
                accountingNet: "9007199254740993",
                accountingTotal: "9007199254740993",
              },
              {
                id: "bhd",
                createdAt: timestamp,
                occurredAt: timestamp,
                orderName: "BHD fixture",
                status: "partially_refunded",
                accountingCurrency: "BHD",
                accountingNet: "-1234",
                accountingTotal: "1234",
              },
            ],
          };
        if (section === "points")
          return {
            section,
            pagination,
            items: [
              {
                id: "ledger",
                sequenceNumber: 1,
                createdAt: timestamp,
                entryType: "EARN_ORDER",
                pointsDelta: "0",
                pendingDelta: "9007199254740995",
                balanceAfter: "-5",
                sourceType: "order",
                sourceId: "order",
                reason: null,
              },
            ],
          };
        return overview;
      },
    );
    await render({ shopperId: "shopper-a" });
    await click("Purchases");
    expect(container.textContent).toContain("JPY 9007199254740993");
    expect(container.textContent).toContain("BHD -1.234");
    expect(container.textContent).toContain(shopperCopy.en.originalTotals);
    await click("Points");
    expect(container.textContent).toContain(
      "Pending change9,007,199,254,740,995",
    );
  });
  it.each(["en", "ja", "vi"] as const)(
    "covers %s copy and localized state labels",
    async (locale) => {
      expect(Object.keys(shopperCopy[locale]).sort()).toEqual(
        Object.keys(shopperCopy.en).sort(),
      );
      await render({ shopperId: "shopper-a", initialLocale: locale });
      expect(container.querySelector("section")?.lang).toBe(locale);
      expect(container.textContent).toContain(
        shopperCopy[locale].consentUnknown,
      );
      expect(container.textContent).toContain(shopperCopy[locale].paused);
    },
  );
  it("shows a generic error, retries, and never renders provider errors", async () => {
    transport.list = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret provider payload"))
      .mockResolvedValue(directory);
    await render();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.textContent).not.toContain("secret provider payload");
    await click("Try again");
    expect(container.textContent).toContain("fixture@example.test");
  });
  it("never inserts cached PII on a Shopify section revisit while authorization is held then denied", async () => {
    let rejectRead!: (error: Error) => void;
    let overviewReads = 0;
    transport.profile = vi.fn<ShopperBrowserTransport["profile"]>(
      async (query) => {
        if (query.section !== "overview")
          return { section: "purchases", items: [], pagination };
        if (++overviewReads === 1) return overview;
        return new Promise((_resolve, reject) => {
          rejectRead = reject;
        });
      },
    );
    await render({ shopperId: "shopper-a" }, true);
    expect(container.textContent).toContain("-9,007,199,254,740,993");
    await click("Purchases");
    const added: string[] = [];
    const observer = new MutationObserver((changes) =>
      changes.forEach((change) =>
        change.addedNodes.forEach((node) => added.push(node.textContent ?? "")),
      ),
    );
    observer.observe(container, { childList: true, subtree: true });
    try {
      await click("Overview");
      expect(overviewReads).toBe(2);
      expect(container.textContent).not.toContain("Controlled Shopper");
      expect(container.textContent).not.toContain("-9,007,199,254,740,993");
      expect(added.join(" ")).not.toContain("Controlled Shopper");
      await act(async () => rejectRead(new Error("access_denied")));
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(container.textContent).not.toContain("Controlled Shopper");
      expect(added.join(" ")).not.toContain("Controlled Shopper");
    } finally {
      observer.disconnect();
    }
  });

  it("does not reuse a cached Shopify directory after its component remounts", async () => {
    await render({}, true);
    expect(container.textContent).toContain("fixture@example.test");
    await render({ shopperId: "shopper-a" }, true);
    let rejectRead!: (error: Error) => void;
    transport.list = vi.fn<ShopperBrowserTransport["list"]>(
      () =>
        new Promise((_resolve, reject) => {
          rejectRead = reject;
        }),
    );
    const added: string[] = [];
    const observer = new MutationObserver((changes) =>
      changes.forEach((change) =>
        change.addedNodes.forEach((node) => added.push(node.textContent ?? "")),
      ),
    );
    observer.observe(container, { childList: true, subtree: true });
    try {
      await render({}, true);
      expect(transport.list).toHaveBeenCalledOnce();
      expect(container.textContent).not.toContain("fixture@example.test");
      expect(added.join(" ")).not.toContain("fixture@example.test");
      await act(async () => rejectRead(new Error("access_denied")));
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(added.join(" ")).not.toContain("fixture@example.test");
    } finally {
      observer.disconnect();
    }
  });

  it("removes old cached customer data on a scope switch and ignores a late response", async () => {
    let resolveOld!: (data: MerchantShopperDirectory) => void;
    transport.list = vi.fn<ShopperBrowserTransport["list"]>(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    await render();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    transport = {
      ...transport,
      scopeKey: "workspace-b",
      list: vi.fn().mockResolvedValue({ items: [], pagination }),
    };
    await render();
    await act(async () => resolveOld(directory));
    expect(container.textContent).not.toContain("fixture@example.test");
    expect(container.textContent).toContain(shopperCopy.en.empty);
  });
});
