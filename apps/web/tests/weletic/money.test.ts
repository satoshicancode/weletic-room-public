import {
  convertMoney,
  decimalToMinorUnits,
  minorUnitsToDecimal,
  normalizeCurrency,
} from "@/lib/weletic/money";
import { describe, expect, test } from "vitest";

describe("Weletic money", () => {
  test("normalizes ISO currency codes", () => {
    expect(normalizeCurrency(" usd ")).toBe("USD");
    expect(() => normalizeCurrency("USDT")).toThrow("Invalid ISO 4217");
  });

  test("parses decimal amounts using the currency minor unit", () => {
    expect(decimalToMinorUnits("12.345", "USD")).toBe(BigInt(1235));
    expect(decimalToMinorUnits("1200.5", "JPY")).toBe(BigInt(1201));
    expect(decimalToMinorUnits("-1.005", "USD")).toBe(BigInt(-101));
  });

  test("serializes minor units without floating-point loss", () => {
    expect(minorUnitsToDecimal(BigInt(12_345), "USD")).toBe("123.45");
    expect(minorUnitsToDecimal(BigInt(12_345), "JPY")).toBe("12345");
    expect(minorUnitsToDecimal(BigInt(-5), "VND")).toBe("-5");
  });

  test("converts between currencies with explicit FX semantics", () => {
    expect(
      convertMoney(
        { amount: BigInt(1000), currency: normalizeCurrency("EUR") },
        {
          base: normalizeCurrency("EUR"),
          quote: normalizeCurrency("USD"),
          rate: "1.125",
          provider: "test",
          capturedAt: new Date("2026-01-01T00:00:00Z"),
        },
      ),
    ).toEqual({ amount: BigInt(1125), currency: "USD" });
  });

  test("does not silently convert with a mismatched quote", () => {
    expect(() =>
      convertMoney(
        { amount: BigInt(1000), currency: normalizeCurrency("EUR") },
        {
          base: normalizeCurrency("JPY"),
          quote: normalizeCurrency("USD"),
          rate: "0.01",
          provider: "test",
          capturedAt: new Date(),
        },
      ),
    ).toThrow("does not match");
  });
});
