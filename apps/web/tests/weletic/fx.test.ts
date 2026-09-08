import { deriveRateFromUsdTable } from "@/lib/weletic/fx";
import { describe, expect, test } from "vitest";

describe("Weletic FX derivation", () => {
  test("derives direct and cross rates from the USD table", () => {
    const rates = { EUR: "0.8", JPY: "160" };
    expect(deriveRateFromUsdTable({ base: "EUR", quote: "USD", rates })).toBe(
      "1.25",
    );
    expect(deriveRateFromUsdTable({ base: "EUR", quote: "JPY", rates })).toBe(
      "200",
    );
  });

  test("fails closed when a rate is missing", () => {
    expect(() =>
      deriveRateFromUsdTable({ base: "EUR", quote: "USD", rates: {} }),
    ).toThrow("conversion aborted");
  });
});
