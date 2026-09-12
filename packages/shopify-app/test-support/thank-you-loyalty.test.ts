// @vitest-environment jsdom
import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "../extensions/loyalty-checkout-slider/locales/en.default.json";
import ja from "../extensions/loyalty-checkout-slider/locales/ja.json";
import viLocale from "../extensions/loyalty-checkout-slider/locales/vi.json";
import extension, {
  parseThankYouSummary,
} from "../extensions/loyalty-checkout-slider/src/ThankYou";

const enrolled = (pointsBalance: unknown, pendingPoints: unknown = "0") => ({
  isEnrolled: true,
  account: { pointsBalance, pendingPoints, id: "private-account-fixture" },
  shopper: { firstName: "private-shopper-fixture" },
});

afterEach(() => {
  act(() => render(null, document.body));
  vi.unstubAllGlobals();
});

describe("thank-you loyalty balance", () => {
  it.each([
    "0",
    "9007199254740993",
    "9223372036854775807",
    "-9223372036854775808",
  ])(
    "retains exact signed database integer %s without identity fields",
    (value) => {
      expect(parseThankYouSummary({ data: enrolled(value, "123") })).toEqual({
        points: BigInt(value),
        pending: 123n,
      });
    },
  );

  it.each([
    null,
    undefined,
    true,
    42,
    9007199254740992,
    "",
    "1.5",
    "1e3",
    " 1",
    "01",
    "NaN",
    "9223372036854775808",
    "-9223372036854775809",
    "1".repeat(1000),
  ])("does not fabricate a balance for malformed input %s", (value) =>
    expect(parseThankYouSummary(enrolled(value))).toBeNull(),
  );

  it("hides unenrolled and malformed responses and keeps missing pending unknown", () => {
    for (const value of [
      null,
      {},
      { isEnrolled: "true" },
      { ...enrolled("1"), isEnrolled: false },
      { data: null },
    ])
      expect(parseThankYouSummary(value)).toBeNull();
    expect(
      parseThankYouSummary({
        isEnrolled: true,
        account: { pointsBalance: "1" },
      }),
    ).toEqual({ points: 1n, pending: null });
  });

  async function mount(
    locale: string,
    payload: unknown,
    ok = true,
    tokenFailure = false,
  ) {
    const catalog: Record<string, string> =
      locale === "ja" ? ja : locale === "vi" ? viLocale : en;
    const formatNumber = vi.fn((value: bigint) =>
      new Intl.NumberFormat(locale).format(value),
    );
    const get = tokenFailure
      ? vi.fn().mockRejectedValue(new Error("synthetic auth failure"))
      : vi.fn().mockResolvedValue("synthetic-session-token");
    vi.stubGlobal("shopify", {
      sessionToken: { get },
      i18n: {
        formatNumber,
        translate: (key: string, values: Record<string, string> = {}) => {
          if (!(key in catalog)) throw new Error("Missing translation: " + key);
          return catalog[key].replace(
            /{{(\w+)}}/g,
            (_: string, name: string) => values[name],
          );
        },
      },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok, json: async () => payload });
    vi.stubGlobal("fetch", fetcher);
    await act(async () => {
      extension();
    });
    // The effect starts the token/fetch chain after the initial render flush.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return { catalog, formatNumber, fetcher };
  }

  it.each(["en", "ja", "vi"])(
    "renders the actual component with %s translations and exact numbers",
    async (locale) => {
      const { catalog, formatNumber, fetcher } = await mount(locale, {
        data: enrolled("9007199254740993", "12345"),
      });
      expect(document.querySelector("s-section")?.getAttribute("heading")).toBe(
        catalog.balanceTitle,
      );
      expect(document.body.textContent).toContain(
        catalog.balanceAvailable.replace(
          "{{points}}",
          new Intl.NumberFormat(locale).format(9007199254740993n),
        ),
      );
      expect(document.body.textContent).toContain(
        catalog.balancePending.replace(
          "{{points}}",
          new Intl.NumberFormat(locale).format(12345n),
        ),
      );
      expect(formatNumber).toHaveBeenCalledWith(9007199254740993n);
      expect(fetcher).toHaveBeenCalledWith(
        "https://shopify.weletic.com/api/checkout/loyalty/customer",
        { headers: { Authorization: "Bearer synthetic-session-token" } },
      );
      expect(document.body.innerHTML).not.toMatch(
        /private-|synthetic-session-token/,
      );
    },
  );

  it.each(["0", null, "invalid"])(
    "does not invent a pending line for %s",
    async (pending) => {
      await mount("vi", enrolled("0", pending));
      expect(document.querySelectorAll("s-text")).toHaveLength(1);
    },
  );

  it("fails closed for HTTP errors even with an enrolled-looking body", async () => {
    await mount("en", enrolled("100"), false);
    expect(document.body.textContent).toBe("");
  });

  it("does not fetch without a session token", async () => {
    const { fetcher } = await mount("en", enrolled("100"), true, true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");
  });
});
