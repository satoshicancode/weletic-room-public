import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  currencyFractionDigits,
  currencyInputStep,
  formatCurrency,
  formatPoints,
  isZeroDecimalCurrency,
  majorUnitsToMinorUnits,
  minorUnitsToMajorUnits,
} from "../../app/app.dub.co/(dashboard)/[slug]/(ee)/program/loyalty/currency-helpers";

function getAllKeys(obj: Record<string, any>, prefix: string = ""): string[] {
  let keys: string[] = [];
  for (const [key, val] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      keys = keys.concat(getAllKeys(val, fullPath));
    } else {
      keys.push(fullPath);
    }
  }
  return keys;
}

describe("Milestone 5: Universal i18n Localization & Dynamic Currency Test Suite", () => {
  const analyticsLocalesDir = path.resolve(
    __dirname,
    "../../../../packages/shopify-app/extensions/weletic-analytics/locales",
  );

  const customerAccountLocalesDir = path.resolve(
    __dirname,
    "../../../../packages/shopify-app/extensions/weletic-customer-account/locales",
  );

  describe("Theme Extension (weletic-analytics) Locale Bundles", () => {
    const enPath = path.join(analyticsLocalesDir, "en.default.json");
    const viPath = path.join(analyticsLocalesDir, "vi.json");
    const jaPath = path.join(analyticsLocalesDir, "ja.json");

    it("verifies all locale files exist and are valid JSON", () => {
      expect(fs.existsSync(enPath)).toBe(true);
      expect(fs.existsSync(viPath)).toBe(true);
      expect(fs.existsSync(jaPath)).toBe(true);

      expect(() => JSON.parse(fs.readFileSync(enPath, "utf-8"))).not.toThrow();
      expect(() => JSON.parse(fs.readFileSync(viPath, "utf-8"))).not.toThrow();
      expect(() => JSON.parse(fs.readFileSync(jaPath, "utf-8"))).not.toThrow();
    });

    it("verifies 100% key parity across English, Vietnamese, and Japanese", () => {
      const en = JSON.parse(fs.readFileSync(enPath, "utf-8"));
      const vi = JSON.parse(fs.readFileSync(viPath, "utf-8"));
      const ja = JSON.parse(fs.readFileSync(jaPath, "utf-8"));

      const enKeys = getAllKeys(en).sort();
      const viKeys = getAllKeys(vi).sort();
      const jaKeys = getAllKeys(ja).sort();

      expect(viKeys).toEqual(enKeys);
      expect(jaKeys).toEqual(enKeys);
    });

    it("ensures zero Yamax and smile_ref references in locale files", () => {
      [enPath, viPath, jaPath].forEach((file) => {
        const raw = fs.readFileSync(file, "utf-8").toLowerCase();
        expect(raw).not.toContain("yamax");
        expect(raw).not.toContain("smile_ref");
      });
    });
  });

  describe("Customer Account Extension (weletic-customer-account) Locale Bundles", () => {
    const enPath = path.join(customerAccountLocalesDir, "en.default.json");
    const viPath = path.join(customerAccountLocalesDir, "vi.json");
    const jaPath = path.join(customerAccountLocalesDir, "ja.json");

    it("verifies all customer account locale files exist and are valid JSON", () => {
      expect(fs.existsSync(enPath)).toBe(true);
      expect(fs.existsSync(viPath)).toBe(true);
      expect(fs.existsSync(jaPath)).toBe(true);

      expect(() => JSON.parse(fs.readFileSync(enPath, "utf-8"))).not.toThrow();
      expect(() => JSON.parse(fs.readFileSync(viPath, "utf-8"))).not.toThrow();
      expect(() => JSON.parse(fs.readFileSync(jaPath, "utf-8"))).not.toThrow();
    });

    it("verifies 100% key parity across Customer Account locales", () => {
      const en = JSON.parse(fs.readFileSync(enPath, "utf-8"));
      const vi = JSON.parse(fs.readFileSync(viPath, "utf-8"));
      const ja = JSON.parse(fs.readFileSync(jaPath, "utf-8"));

      const enKeys = getAllKeys(en).sort();
      const viKeys = getAllKeys(vi).sort();
      const jaKeys = getAllKeys(ja).sort();

      expect(viKeys).toEqual(enKeys);
      expect(jaKeys).toEqual(enKeys);
    });

    it("ensures zero Yamax and smile_ref references in customer account locales", () => {
      [enPath, viPath, jaPath].forEach((file) => {
        const raw = fs.readFileSync(file, "utf-8").toLowerCase();
        expect(raw).not.toContain("yamax");
        expect(raw).not.toContain("smile_ref");
      });
    });
  });

  describe("Dynamic Currency Formatting Engine", () => {
    it("formats zero-decimal currencies with 0 fraction digits and minor unit preservation", () => {
      // JPY: ¥1,500
      expect(isZeroDecimalCurrency("JPY")).toBe(true);
      const jpyFormatted = formatCurrency(1500, "JPY", {
        isMinorUnits: true,
        locale: "ja-JP",
      });
      expect(jpyFormatted).toContain("1,500");
      expect(jpyFormatted).not.toContain(".00");

      // VND: 50.000 ₫
      expect(isZeroDecimalCurrency("VND")).toBe(true);
      const vndFormatted = formatCurrency(50000, "VND", {
        isMinorUnits: true,
        locale: "vi-VN",
      });
      expect(vndFormatted).toMatch(/50\.000|50,000/);

      // KRW: ₩10,000
      expect(isZeroDecimalCurrency("KRW")).toBe(true);
      const krwFormatted = formatCurrency(10000, "KRW", {
        isMinorUnits: true,
        locale: "ko-KR",
      });
      expect(krwFormatted).toContain("10,000");
    });

    it("formats standard decimal currencies with 2 decimal digits", () => {
      // USD: 2550 cents = $25.50
      expect(isZeroDecimalCurrency("USD")).toBe(false);
      const usdFormatted = formatCurrency(2550, "USD", {
        isMinorUnits: true,
        locale: "en-US",
      });
      expect(usdFormatted).toBe("$25.50");

      // EUR: 1999 cents = €19.99
      expect(isZeroDecimalCurrency("EUR")).toBe(false);
      const eurFormatted = formatCurrency(1999, "EUR", {
        isMinorUnits: true,
        locale: "en-US",
      });
      expect(eurFormatted).toContain("19.99");

      // GBP: 10000 cents = £100.00
      expect(isZeroDecimalCurrency("GBP")).toBe(false);
      const gbpFormatted = formatCurrency(10000, "GBP", {
        isMinorUnits: true,
        locale: "en-US",
      });
      expect(gbpFormatted).toBe("£100.00");
    });

    it("round-trips three-decimal KWD amounts without losing a minor unit", () => {
      expect(currencyFractionDigits("KWD")).toBe(3);
      expect(currencyInputStep("KWD")).toBe("0.001");
      expect(minorUnitsToMajorUnits(5001, "KWD")).toBe("5.001");
      expect(majorUnitsToMinorUnits("5.001", "KWD")).toBe(5001);
      expect(
        formatCurrency(5001, "KWD", {
          isMinorUnits: true,
          locale: "en-US",
        }),
      ).toContain("5.001");
    });

    it("formats integer points values consistently", () => {
      expect(formatPoints(0)).toBe("0");
      expect(formatPoints(100)).toBe("100");
      expect(formatPoints(25000)).toBe("25,000");
      expect(formatPoints(BigInt(999999))).toBe("999,999");
      expect(formatPoints("9007199254740993")).toBe("9,007,199,254,740,993");
    });
  });
});
