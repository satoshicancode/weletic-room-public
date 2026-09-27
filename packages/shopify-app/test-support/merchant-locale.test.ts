// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MerchantLocaleProvider,
  useMerchantLocale,
} from "../app/merchant-locale";
import { SubscriptionStatus } from "../app/subscription-status";

const mocks = vi.hoisted(() => ({
  bridge: { idToken: async () => "synthetic" },
  post: vi.fn(async () => {
    throw new Error("offline fixture");
  }),
  location: { key: "overview" },
}));
vi.mock("@shopify/app-bridge-react", () => ({
  useAppBridge: () => mocks.bridge,
}));
vi.mock("@remix-run/react", () => ({ useLocation: () => mocks.location }));
vi.mock("../app/staff-access-client", () => ({
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
