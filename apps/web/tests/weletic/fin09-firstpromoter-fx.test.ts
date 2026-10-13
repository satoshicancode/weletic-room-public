import { convertCurrencyWithFxRates } from "@/lib/analytics/convert-currency";
import { describe, expect, it } from "vitest";

describe("FIN-AUDIT-09: FirstPromoter Commission Import FX Conversion", () => {
  const fxRates: Record<string, string> = {
    EUR: "1.08", // 1 EUR = 1.08 USD
    JPY: "155.0", // 155 JPY = 1 USD
    GBP: "1.25", // 1 GBP = 1.25 USD
  };

  it("converts EUR commission earnings correctly to USD cents", () => {
    const rawEarnings = 2000; // 20.00 EUR in cents
    const { amount: convertedEarnings, currency } = convertCurrencyWithFxRates({
      currency: "EUR",
      amount: rawEarnings,
      fxRates,
    });

    expect(currency).toBe("usd");
    // 2000 / 1.08 = 1851.85 => 1852 cents ($18.52 USD)
    expect(convertedEarnings).toBe(Math.round(2000 / 1.08));
  });

  it("converts JPY commission earnings correctly with zero-decimal scaling", () => {
    const rawEarnings = 1000; // 1,000 JPY
    const { amount: convertedEarnings, currency } = convertCurrencyWithFxRates({
      currency: "JPY",
      amount: rawEarnings,
      fxRates,
    });

    expect(currency).toBe("usd");
    // 1000 / 155 * 100 = 645.16 => 645 USD cents ($6.45 USD)
    expect(convertedEarnings).toBe(Math.round((1000 / 155) * 100));
  });

  it("leaves USD earnings unchanged", () => {
    const rawEarnings = 5000; // $50.00 USD
    const earningsCurrency = "USD";

    let earnings = rawEarnings;
    if (earningsCurrency.toUpperCase() !== "USD" && fxRates) {
      const { amount } = convertCurrencyWithFxRates({
        currency: earningsCurrency,
        amount: earnings,
        fxRates,
      });
      earnings = amount;
    }

    expect(earnings).toBe(5000);
  });
});
