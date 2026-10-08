// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MerchantLocaleProvider,
  useMerchantLocale,
} from "../app/merchant-locale";
import { StaffAccessClientError } from "../app/staff-access-client";
import { SubscriptionStatus } from "../app/subscription-status";

const mocks = vi.hoisted(() => ({
  bridge: { idToken: async () => "synthetic" },
  post: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {
    throw new Error("offline fixture");
  }),
  location: { key: "overview" },
}));
vi.mock("@shopify/app-bridge-react", () => ({
  useAppBridge: () => mocks.bridge,
  TitleBar: ({ title, children }: any) =>
    React.createElement("div", { "data-titlebar": title }, children),
  NavMenu: ({ children }: any) =>
    React.createElement("nav", { "data-navmenu": true }, children),
}));
vi.mock("@remix-run/react", () => ({ useLocation: () => mocks.location }));
vi.mock("../app/staff-access-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/staff-access-client")>()),
  createMerchantJsonPost: () => mocks.post,
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
function Page({ name }: { name: string }) {
  const [locale, setLocale] = useMerchantLocale();
  return React.createElement(
    "section",
    { lang: locale, "aria-label": name },
    ...(["en", "ja", "vi"] as const).map((value) =>
      React.createElement(
        "button",
        {
          key: value,
          onClick: () => setLocale(value),
        },
        value,
      ),
    ),
  );
}
function app(page: string) {
  return React.createElement(
    MerchantLocaleProvider,
    null,
    React.createElement(SubscriptionStatus, { setupOnly: true }),
    React.createElement(Page, { key: page, name: page }),
  );
}
beforeEach(() => {
  vi.spyOn(navigator, "language", "get").mockReturnValue("en-US");
  mocks.post.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("keeps the subscription notice and page language together across navigation", async () => {
  await act(async () => root.render(app("overview")));
  for (const [locale, title] of [
    ["ja", "Shopifyサブスクリプション"],
    ["vi", "Gói đăng ký Shopify"],
    ["en", "Shopify subscription"],
  ]) {
    await act(async () => {
      [...container.querySelectorAll("section button")]
        .find((button) => button.textContent === locale)
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector("section")?.lang).toBe(locale);
    expect(container.querySelector("aside")?.getAttribute("aria-label")).toBe(
      title,
    );
    await act(async () => root.render(app(`reviews-${locale}`)));
    expect(container.querySelector("section")?.lang).toBe(locale);
    expect(container.querySelector("aside")?.getAttribute("aria-label")).toBe(
      title,
    );
  }
  // Language changes must not trigger subscription refreshes or grant access.
  expect(mocks.post).toHaveBeenCalledTimes(1);
  expect(container.querySelector("a")).toBeNull();
});
it("uses the browser language consistently on first mount", async () => {
  vi.spyOn(navigator, "language", "get").mockReturnValue("vi-VN");
  await act(async () => root.render(app("reviews")));
  expect(container.querySelector("section")?.lang).toBe("vi");
  expect(container.querySelector("aside")?.getAttribute("aria-label")).toBe(
    "Gói đăng ký Shopify",
  );
});

it.each(["restricted_development", "unavailable", "paid"])(
  "labels restricted mode truthfully with backend status %s",
  async (status) => {
    mocks.post.mockResolvedValueOnce({
      status,
      validUntil: null,
      credentialsChanged: false,
      pricingUrl:
        "https://admin.shopify.com/store/synthetic/charges/app/pricing_plans",
      supportEmail: "support@example.test",
    });
    await act(async () =>
      root.render(
        React.createElement(
          MerchantLocaleProvider,
          null,
          React.createElement(SubscriptionStatus, {
            restrictedDevelopment: true,
          }),
        ),
      ),
    );
    expect(container.textContent).toContain(
      status === "restricted_development"
        ? "Restricted yamaxdev feature testing"
        : "Restricted testing access is paused",
    );
    expect(container.textContent).not.toContain("Subscription verified");
    expect(container.querySelector("a")).toBeNull();
  },
);

function restrictedApp() {
  return React.createElement(
    MerchantLocaleProvider,
    null,
    React.createElement(SubscriptionStatus, { restrictedDevelopment: true }),
  );
}

it("recovers one transient entry verification failure without claiming access early", async () => {
  vi.useFakeTimers();
  mocks.post
    .mockRejectedValueOnce(new StaffAccessClientError("unavailable"))
    .mockResolvedValueOnce({
      status: "restricted_development",
      validUntil: null,
      credentialsChanged: false,
      pricingUrl:
        "https://admin.shopify.com/store/synthetic/charges/app/pricing_plans",
      supportEmail: "support@example.test",
    });
  await act(async () => root.render(restrictedApp()));
  expect(container.textContent).toContain("Checking subscription");
  expect(container.textContent).not.toContain(
    "Restricted yamaxdev feature testing",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(750);
  });
  expect(mocks.post).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain(
    "Restricted yamaxdev feature testing",
  );
});

it.each(["unavailable", "denied", "reauthenticate"] as const)(
  "bounds retries for %s and stays paused",
  async (code) => {
    vi.useFakeTimers();
    mocks.post.mockRejectedValueOnce(new StaffAccessClientError(code));
    if (code === "unavailable")
      mocks.post.mockRejectedValueOnce(new StaffAccessClientError(code));
    await act(async () => root.render(restrictedApp()));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.post).toHaveBeenCalledTimes(code === "unavailable" ? 2 : 1);
    expect(container.textContent).toContain(
      "Restricted testing access is paused",
    );
  },
);

it("cancels a pending verification retry when the component leaves", async () => {
  vi.useFakeTimers();
  mocks.post.mockRejectedValueOnce(new StaffAccessClientError("unavailable"));
  await act(async () => root.render(restrictedApp()));
  await act(async () => root.render(null));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(mocks.post).toHaveBeenCalledTimes(1);
});
