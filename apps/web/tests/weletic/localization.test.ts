import {
  getWeleticMessage,
  getWeleticMessages,
  resolveLocaleFromAcceptLanguage,
  resolveWeleticLocale,
  resolveWeleticLocaleHierarchy,
  WELETIC_LOCALES,
} from "@/lib/weletic/localization";
import { describe, expect, test } from "vitest";

describe("Weletic localization", () => {
  test.each([
    ["en-US", "en"],
    ["en-GB", "en"],
    ["en-AU", "en"],
    ["vi-VN", "vi"],
    ["ja-JP", "ja"],
    ["fr-FR", "en"],
  ])("resolves %s to %s", (input, expected) => {
    expect(resolveWeleticLocale(input)).toBe(expected);
  });

  test("returns localized catalog messages", () => {
    expect(getWeleticMessage("vi", "catalog.title")).toBe("Sản phẩm");
    expect(getWeleticMessage("ja", "catalog.title")).toBe("商品");
    expect(getWeleticMessage("en", "catalog.title")).toBe("Products");
  });

  test("ensures EN, VI, and JA message catalogs have complete matching keys and non-empty values", () => {
    const enMessages = getWeleticMessages("en");
    const enKeys = Object.keys(enMessages).sort();

    for (const locale of WELETIC_LOCALES) {
      const messages = getWeleticMessages(locale);
      const keys = Object.keys(messages).sort();

      // Check all keys match EN exactly
      expect(keys).toEqual(enKeys);

      // Check no message is an empty string
      for (const [key, value] of Object.entries(messages)) {
        expect(
          value.trim().length,
          `Key "${key}" in locale "${locale}" should not be empty`,
        ).toBeGreaterThan(0);
      }
    }
  });

  test("resolves locale from Accept-Language header correctly", () => {
    expect(
      resolveLocaleFromAcceptLanguage("vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"),
    ).toBe("vi");
    expect(resolveLocaleFromAcceptLanguage("ja-JP,ja;q=0.9,en;q=0.8")).toBe(
      "ja",
    );
    expect(resolveLocaleFromAcceptLanguage("fr-FR,fr;q=0.9,de;q=0.8")).toBe(
      "en",
    );
    expect(resolveLocaleFromAcceptLanguage(null)).toBe("en");
  });

  test("resolves locale through the hierarchy: explicit -> partner -> cookie -> header -> default", () => {
    // Explicit takes highest precedence
    expect(
      resolveWeleticLocaleHierarchy({
        explicitLocale: "ja",
        partnerLocale: "vi",
        cookieLocale: "en",
        acceptLanguageHeader: "vi-VN",
      }),
    ).toBe("ja");

    // Partner preference takes precedence over cookie and header
    expect(
      resolveWeleticLocaleHierarchy({
        partnerLocale: "vi",
        cookieLocale: "en",
        acceptLanguageHeader: "ja-JP",
      }),
    ).toBe("vi");

    // Cookie takes precedence over header
    expect(
      resolveWeleticLocaleHierarchy({
        cookieLocale: "ja",
        acceptLanguageHeader: "vi-VN",
      }),
    ).toBe("ja");

    // Accept-language header is used when cookie is missing
    expect(
      resolveWeleticLocaleHierarchy({
        acceptLanguageHeader: "vi-VN,vi;q=0.9",
      }),
    ).toBe("vi");

    // Default fallback to English
    expect(resolveWeleticLocaleHierarchy({})).toBe("en");
  });
});
