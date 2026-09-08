import { isZeroDecimalCurrency } from "@dub/utils";

export type CurrencyCode = string & { readonly __currencyCode: unique symbol };

export interface Money {
  amount: bigint;
  currency: CurrencyCode;
}

export interface FxQuote {
  base: CurrencyCode;
  quote: CurrencyCode;
  /** Quote-currency major units for one base-currency major unit. */
  rate: string;
  provider: string;
  capturedAt: Date;
  providerRef?: string;
}

function powerOfTen(exponent: number) {
  let result = BigInt(1);
  for (let index = 0; index < exponent; index += 1) result *= BigInt(10);
  return result;
}

export function normalizeCurrency(value: string): CurrencyCode {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Invalid ISO 4217 currency code: ${value}`);
  }
  return currency as CurrencyCode;
}

export function currencyMinorUnits(currency: string): number {
  const code = normalizeCurrency(currency);
  if (isZeroDecimalCurrency(code)) return 0;

  try {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency: code,
    }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

export function decimalToMinorUnits(value: string, currency: string): bigint {
  const normalized = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
    throw new Error(`Invalid decimal money value: ${value}`);
  }

  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  const digits = currencyMinorUnits(currency);
  const padded = `${fraction}${"0".repeat(digits + 1)}`;
  const kept = padded.slice(0, digits);
  const roundDigit = Number(padded[digits] ?? "0");
  let amount = BigInt(whole) * powerOfTen(digits) + BigInt(kept || "0");
  if (roundDigit >= 5) amount += BigInt(1);
  return negative ? -amount : amount;
}

export function minorUnitsToDecimal(value: bigint, currency: string): string {
  const digits = currencyMinorUnits(currency);
  if (digits === 0) return value.toString();
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  const raw = absolute.toString().padStart(digits + 1, "0");
  const whole = raw.slice(0, -digits);
  const fraction = raw.slice(-digits);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function decimalRatio(value: string): {
  numerator: bigint;
  denominator: bigint;
} {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid positive FX rate: ${value}`);
  }
  const [whole, fraction = ""] = value.split(".");
  const denominator = powerOfTen(fraction.length);
  return {
    numerator: BigInt(`${whole}${fraction}`),
    denominator,
  };
}

function divideAndRound(numerator: bigint, denominator: bigint) {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * BigInt(2) >= denominator ? quotient + BigInt(1) : quotient;
}

export function convertMoney(input: Money, fx: FxQuote): Money {
  if (input.currency !== fx.base) {
    throw new Error(
      `FX base ${fx.base} does not match money currency ${input.currency}`,
    );
  }
  if (fx.base === fx.quote) return { ...input, currency: fx.quote };

  const { numerator, denominator } = decimalRatio(fx.rate);
  if (numerator <= BigInt(0))
    throw new Error("FX rate must be greater than zero");

  const sourceScale = powerOfTen(currencyMinorUnits(fx.base));
  const targetScale = powerOfTen(currencyMinorUnits(fx.quote));
  const negative = input.amount < BigInt(0);
  const absolute = negative ? -input.amount : input.amount;
  const converted = divideAndRound(
    absolute * numerator * targetScale,
    denominator * sourceScale,
  );

  return {
    amount: negative ? -converted : converted,
    currency: fx.quote,
  };
}

export function formatMoney(
  money: Money,
  locale: string,
  options?: Intl.NumberFormatOptions,
) {
  const digits = currencyMinorUnits(money.currency);
  const divisor = 10 ** digits;
  const numericAmount = Number(money.amount) / divisor;
  if (!Number.isSafeInteger(Number(money.amount))) {
    return `${money.currency} ${money.amount.toString()} (minor units)`;
  }

  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: money.currency,
    ...options,
  }).format(numericAmount);
}

/**
 * Checks whether compare-at amount represents a valid promotional discount
 * over the selling price amount.
 */
export function hasDiscount(
  amount: string | bigint | number | null | undefined,
  compareAtAmount: string | bigint | number | null | undefined,
): boolean {
  if (amount == null || compareAtAmount == null || compareAtAmount === "") {
    return false;
  }
  try {
    const amountBig =
      typeof amount === "bigint" ? amount : BigInt(String(amount).trim());
    const compareBig =
      typeof compareAtAmount === "bigint"
        ? compareAtAmount
        : BigInt(String(compareAtAmount).trim());
    return compareBig > amountBig && amountBig >= BigInt(0);
  } catch {
    return false;
  }
}

/**
 * Calculates the integer discount percentage (e.g. 35 for 35% off).
 * Returns 0 if there is no valid discount or if compareAtAmount <= 0.
 */
export function discountPercent(
  amount: string | bigint | number | null | undefined,
  compareAtAmount: string | bigint | number | null | undefined,
): number {
  if (!hasDiscount(amount, compareAtAmount)) return 0;
  const numAmount = Number(amount);
  const numCompare = Number(compareAtAmount);
  if (
    !Number.isFinite(numAmount) ||
    !Number.isFinite(numCompare) ||
    numCompare <= 0
  ) {
    return 0;
  }
  const percent = Math.round(((numCompare - numAmount) / numCompare) * 100);
  return percent > 0 ? percent : 0;
}

/**
 * Formats a catalog price in minor units using the currency minor unit scale and locale.
 */
export function formatCatalogPrice(
  amount: string | bigint | number,
  currency: string,
  locale = "en",
): string {
  const amountBig =
    typeof amount === "bigint" ? amount : BigInt(String(amount).trim());
  return formatMoney(
    {
      amount: amountBig,
      currency: normalizeCurrency(currency),
    },
    locale,
  );
}

/**
 * Formats a compare-at price in minor units. Returns null if compare-at is missing or empty.
 */
export function formatCompareAtPrice(
  compareAtAmount: string | bigint | number | null | undefined,
  currency: string,
  locale = "en",
): string | null {
  if (compareAtAmount == null || compareAtAmount === "") return null;
  try {
    const amountBig =
      typeof compareAtAmount === "bigint"
        ? compareAtAmount
        : BigInt(String(compareAtAmount).trim());
    return formatMoney(
      {
        amount: amountBig,
        currency: normalizeCurrency(currency),
      },
      locale,
    );
  } catch {
    return null;
  }
}

export interface CatalogPricing {
  hasDiscount: boolean;
  discountPercent: number;
  formattedPrice: string;
  formattedCompareAtPrice: string | null;
  badgeText: string | null;
}

/**
 * Evaluates catalog pricing structure for a product/variant with strikethrough compare-at & sale badges.
 */
export function getCatalogPricing({
  amount,
  compareAtAmount,
  currency,
  locale = "en",
}: {
  amount: string | bigint | number;
  compareAtAmount: string | bigint | number | null | undefined;
  currency: string;
  locale?: string;
}): CatalogPricing {
  const isDiscounted = hasDiscount(amount, compareAtAmount);
  const percent = isDiscounted ? discountPercent(amount, compareAtAmount) : 0;
  const formattedPrice = formatCatalogPrice(amount, currency, locale);
  const formattedCompareAtPrice = isDiscounted
    ? formatCompareAtPrice(compareAtAmount, currency, locale)
    : null;
  const badgeText = isDiscounted && percent > 0 ? `-${percent}%` : null;

  return {
    hasDiscount: isDiscounted,
    discountPercent: percent,
    formattedPrice,
    formattedCompareAtPrice,
    badgeText,
  };
}
