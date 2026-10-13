import { convertCurrencyWithFxRates } from "@/lib/analytics/convert-currency";
import { isZeroDecimalCurrency } from "@dub/utils";
import { describe, expect, it } from "vitest";

describe("FIN-AUDIT-06: Tapfiliate Commission Zero-Decimal Scaling", () => {
  const fxRates = {
    JPY: "155.2",
    VND: "25450",
    EUR: "0.92",
    GBP: "0.79",
  };

  function computeImportAmounts({
    currency,
    conversionSubAmount,
    commissionAmount,
    rates,
  }: {
    currency: string;
    conversionSubAmount: number;
    commissionAmount: number;
    rates: Record<string, string>;
  }) {
    const isZeroDecimal = isZeroDecimalCurrency(currency);
    let saleAmount = isZeroDecimal
      ? Math.round(conversionSubAmount)
      : Math.round(conversionSubAmount * 100);
    let earnings = isZeroDecimal
      ? Math.round(commissionAmount)
      : Math.round(commissionAmount * 100);

    if (currency.toUpperCase() !== "USD" && rates) {
      const { amount: convertedSale } = convertCurrencyWithFxRates({
        currency,
        amount: saleAmount,
        fxRates: rates,
      });
      const { amount: convertedEarnings } = convertCurrencyWithFxRates({
        currency,
        amount: earnings,
        fxRates: rates,
      });
      saleAmount = convertedSale;
      earnings = convertedEarnings;
    }

    return { saleAmount, earnings };
  }

  it("1. Converts JPY major units accurately without 100x overstatement", () => {
    // ¥1,000 JPY sale, ¥100 JPY earnings
    const { saleAmount, earnings } = computeImportAmounts({
      currency: "JPY",
      conversionSubAmount: 1000,
      commissionAmount: 100,
      rates: fxRates,
    });

    // 1000 / 155.2 * 100 = 644.33 -> 644 cents ($6.44 USD)
    expect(saleAmount).toBe(644);
    // 100 / 155.2 * 100 = 64.43 -> 64 cents ($0.64 USD)
    expect(earnings).toBe(64);
  });

  it("2. Converts VND major units accurately without 100x overstatement", () => {
    // 254,500 VND sale, 25,450 VND earnings
    const { saleAmount, earnings } = computeImportAmounts({
      currency: "VND",
      conversionSubAmount: 254500,
      commissionAmount: 25450,
      rates: fxRates,
    });

    // 254,500 / 25450 * 100 = 1,000 cents ($10.00 USD)
    expect(saleAmount).toBe(1000);
    // 25,450 / 25450 * 100 = 100 cents ($1.00 USD)
    expect(earnings).toBe(100);
  });

  it("3. Accurately converts 2-decimal currencies (EUR) to USD cents", () => {
    // €50.00 EUR sale, €5.00 EUR earnings
    const { saleAmount, earnings } = computeImportAmounts({
      currency: "EUR",
      conversionSubAmount: 50.0,
      commissionAmount: 5.0,
      rates: fxRates,
    });

    // 5000 cents / 0.92 = 5434.78 -> 5435 cents ($54.35 USD)
    expect(saleAmount).toBe(5435);
    expect(earnings).toBe(543);
  });

  it("4. Accurately handles USD without conversion", () => {
    // $100.00 USD sale, $15.00 USD earnings
    const { saleAmount, earnings } = computeImportAmounts({
      currency: "USD",
      conversionSubAmount: 100.0,
      commissionAmount: 15.0,
      rates: fxRates,
    });

    expect(saleAmount).toBe(10000);
    expect(earnings).toBe(1500);
  });
});
