// @vitest-environment jsdom
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../extensions/weletic-customer-account-blocks/locales/en.default.json";
import ja from "../extensions/weletic-customer-account-blocks/locales/ja.json";
import viLocale from "../extensions/weletic-customer-account-blocks/locales/vi.json";
import extension, {
  parseProfilePoints,
  ProfileLoyaltySummaryView,
} from "../extensions/weletic-customer-account-blocks/src/CustomerAccountLoyaltyBlocks";

const summary = {
  isEnrolled: true,
  account: { pointsBalance: "9007199254740993", id: "private-account-fixture" },
  tier: { currentTier: { name: "<img src=x onerror=alert(1)>" } },
  rewardWallet: [{ status: "available" }, { status: "used" }],
};

function host(locale: string) {
  const catalog: Record<string, string> =
    locale === "ja" ? ja : locale === "vi" ? viLocale : en;
  const i18n = {
    formatNumber: vi.fn((value: number | bigint) =>
      new Intl.NumberFormat(locale).format(value),
    ),
    translate: (key: string, values: Record<string, string | number> = {}) => {
      if (!(key in catalog))
        throw new Error("Missing profile translation: " + key);
      return catalog[key].replace(/{{(\w+)}}/g, (_, name) =>
        String(values[name]),
      );
    },
  };
  const get = vi.fn().mockResolvedValue("synthetic-profile-token");
  vi.stubGlobal("shopify", { i18n, sessionToken: { get } });
  return { catalog, i18n, get };
}

async function flushRequests() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  act(() => render(null, document.body));
  vi.unstubAllGlobals();
});

describe("profile loyalty locales", () => {
  it.each([
    "0",
    "9007199254740993",
    "9223372036854775807",
    "-9223372036854775808",
  ])("preserves signed exact points %s", (value) => {
    expect(parseProfilePoints(value)).toBe(BigInt(value));
  });
  it.each([
    null,
    undefined,
    123,
    true,
    "",
    "1.1",
    "1e2",
    "01",
    " 1",
    "9223372036854775808",
    "-9223372036854775809",
  ])("rejects invalid/lossy points %s", (value) => {
    expect(parseProfilePoints(value)).toBeNull();
  });

  it.each(["en", "ja", "vi"])(
    "renders exact balances, labels and escaped tier copy in %s",
    (locale) => {
      const { catalog, i18n } = host(locale);
      act(() =>
        render(h(ProfileLoyaltySummaryView, { summary }), document.body),
      );
      expect(document.querySelector("s-section")?.getAttribute("heading")).toBe(
        catalog.rewards,
      );
      expect(document.querySelector("s-button")?.getAttribute("href")).toBe(
        "extension:weletic-loyalty-customer-account-hub/",
      );
      expect(document.querySelector("s-button")?.textContent).toBe(
        catalog.viewHub,
      );
      expect(document.body.textContent).toContain(
        catalog.points.replace(
          "{{points}}",
          new Intl.NumberFormat(locale).format(9007199254740993n),
        ),
      );
      expect(document.body.textContent).toContain(
        catalog.rewardOne.replace("{{formattedCount}}", "1"),
      );
      expect(i18n.formatNumber).toHaveBeenCalledWith(9007199254740993n);
      expect(document.querySelector("img")).toBeNull();
      expect(document.body.innerHTML).not.toMatch(
        /private-account-fixture|synthetic-profile-token/,
      );
    },
  );

  it.each(["en", "ja", "vi"])(
    "localizes unavailable points and default member in %s",
    (locale) => {
      const { catalog } = host(locale);
      act(() =>
        render(
          h(ProfileLoyaltySummaryView, {
            summary: { isEnrolled: true, account: { pointsBalance: "bad" } },
          }),
          document.body,
        ),
      );
      expect(document.body.textContent).toContain(catalog.pointsUnavailable);
      expect(document.body.textContent).toContain(catalog.member);
      expect(document.body.textContent).toContain(
        catalog.rewardMany.replace("{{formattedCount}}", "0"),
      );
    },
  );

  it.each(["en", "ja", "vi"])(
    "localizes loading, error, retry and enrollment states in %s",
    async (locale) => {
      const { catalog } = host(locale);
      let resolveResponse!: (value: unknown) => void;
      const fetcher = vi.fn().mockReturnValueOnce(
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
      );
      vi.stubGlobal("fetch", fetcher);
      await act(async () => {
        extension();
      });
      expect(
        document.querySelector("s-skeleton-paragraph")?.getAttribute("content"),
      ).toBe(catalog.loading);
      resolveResponse({
        ok: false,
        json: async () => ({ error: { message: "private-server-error" } }),
      });
      await flushRequests();
      expect(document.body.textContent).toContain(catalog.unavailable);
      expect(document.body.textContent).not.toContain("private-server-error");
      const retry = [...document.querySelectorAll("s-button")].find(
        (element) => element.textContent === catalog.retry,
      )!;
      expect(retry).toBeTruthy();
      fetcher.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { isEnrolled: false } }),
      });
      await act(async () => {
        retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await flushRequests();
      expect(document.body.textContent).toContain(catalog.join);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenLastCalledWith(
        "https://shopify.weletic.com/api/customer-account/loyalty/customer",
        expect.objectContaining({
          headers: {
            Authorization: "Bearer synthetic-profile-token",
            "Content-Type": "application/json",
          },
        }),
      );
    },
  );

  it("does not fetch when authentication fails", async () => {
    const { get, catalog } = host("vi");
    get.mockRejectedValueOnce(new Error("synthetic failure"));
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await act(async () => {
      extension();
    });
    await flushRequests();
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(catalog.unavailable);
  });
});
