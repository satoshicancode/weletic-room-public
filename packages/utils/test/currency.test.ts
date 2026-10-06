import { describe, expect, it } from "vitest";
import {
  currencyFormatter,
  isZeroDecimalCurrency,
  toCentsNumber,
} from "../src/functions";

describe("currencyFormatter", () => {
  it("formats standard USD amounts from numbers in cents", () => {
    expect(currencyFormatter(1050)).toBe("$10.50");
    expect(currencyFormatter(100)).toBe("$1.00");
    expect(currencyFormatter(0)).toBe("$0.00");
  });

  it("formats USD amounts from BigInt in cents", () => {
    expect(currencyFormatter(250000n)).toBe("$2,500.00");
    expect(currencyFormatter(1050n)).toBe("$10.50");
    expect(currencyFormatter(0n)).toBe("$0.00");
  });

  it("formats negative currency values", () => {
    expect(currencyFormatter(-1050)).toBe("-$10.50");
    expect(currencyFormatter(-250000n)).toBe("-$2,500.00");
  });

  it("formats zero-decimal currencies without decimal division", () => {
    // JPY tests
    expect(currencyFormatter(1000, { currency: "JPY" })).toBe("¥1,000");
    expect(currencyFormatter(25000000n, { currency: "JPY" })).toBe("¥25,000,000");

    // VND tests
    expect(currencyFormatter(500000, { currency: "VND" })).toBe("₫500,000");
    expect(currencyFormatter(2500000000n, { currency: "VND" })).toBe("₫2,500,000,000");

    // KRW tests
    expect(currencyFormatter(50000, { currency: "KRW" })).toBe("₩50,000");
  });

  it("handles null and undefined gracefully via toCentsNumber fallback", () => {
    expect(currencyFormatter(null as any)).toBe("$0.00");
    expect(currencyFormatter(undefined as any)).toBe("$0.00");
  });

  it("supports custom formatting options", () => {
    expect(
      currencyFormatter(1050, {
        currency: "EUR",
      }),
    ).toBe("€10.50");
  });
});

describe("isZeroDecimalCurrency", () => {
  it("correctly identifies all 16 zero-decimal currencies", () => {
    const zeroDecimalCurrencies = [
      "BIF",
      "CLP",
      "DJF",
      "GNF",
      "JPY",
      "KMF",
      "KRW",
      "MGA",
      "PYG",
      "RWF",
      "UGX",
      "VND",
      "VUV",
      "XAF",
      "XOF",
      "XPF",
    ];

    for (const code of zeroDecimalCurrencies) {
      expect(isZeroDecimalCurrency(code)).toBe(true);
    }
  });

  it("is case-insensitive", () => {
    expect(isZeroDecimalCurrency("jpy")).toBe(true);
    expect(isZeroDecimalCurrency("vnd")).toBe(true);
    expect(isZeroDecimalCurrency("Krw")).toBe(true);
    expect(isZeroDecimalCurrency("ClP")).toBe(true);
  });

  it("returns false for standard decimal currencies", () => {
    expect(isZeroDecimalCurrency("USD")).toBe(false);
    expect(isZeroDecimalCurrency("EUR")).toBe(false);
    expect(isZeroDecimalCurrency("GBP")).toBe(false);
    expect(isZeroDecimalCurrency("CAD")).toBe(false);
    expect(isZeroDecimalCurrency("AUD")).toBe(false);
    expect(isZeroDecimalCurrency("SGD")).toBe(false);
    expect(isZeroDecimalCurrency("unknown")).toBe(false);
  });
});

describe("toCentsNumber", () => {
  it("passes numbers through unchanged", () => {
    expect(toCentsNumber(500)).toBe(500);
    expect(toCentsNumber(0)).toBe(0);
    expect(toCentsNumber(-1250)).toBe(-1250);
  });

  it("converts BigInt values to JavaScript numbers", () => {
    expect(toCentsNumber(500n)).toBe(500);
    expect(toCentsNumber(0n)).toBe(0);
    expect(toCentsNumber(-100n)).toBe(-100);
  });

  it("handles numbers exceeding Int32 range (FIN-01)", () => {
    // 2^31 = 2,147,483,648 (exceeds signed 32-bit int max)
    const largeInt = 2147483648n;
    expect(toCentsNumber(largeInt)).toBe(2147483648);

    // 2.5 billion VND
    const b25 = 2500000000n;
    expect(toCentsNumber(b25)).toBe(2500000000);
  });

  it("normalizes null and undefined to 0", () => {
    expect(toCentsNumber(null)).toBe(0);
    expect(toCentsNumber(undefined)).toBe(0);
  });
});
