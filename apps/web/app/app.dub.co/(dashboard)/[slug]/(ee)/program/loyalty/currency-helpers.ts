/**
 * Universal Currency & Points Formatting Engine for Weletic Loyalty.
 * Currency exponents come from the runtime's ISO 4217 data so zero-, two-,
 * and three-decimal currencies all share the same conversion contract.
 */

export const ZERO_DECIMAL_CURRENCIES = new Set([
  "JPY",
  "VND",
  "KRW",
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "KMF",
  "PYG",
  "RWF",
  "UGX",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

export function currencyFractionDigits(currency: string = "USD"): number {
  const curr = (currency || "USD").toUpperCase();

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: curr,
    }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

export function isZeroDecimalCurrency(currency: string = "USD"): boolean {
  return currencyFractionDigits(currency) === 0;
}

export function currencyInputStep(currency: string = "USD"): string {
  const fractionDigits = currencyFractionDigits(currency);
  return fractionDigits === 0 ? "1" : `0.${"0".repeat(fractionDigits - 1)}1`;
}

export function minorUnitsToMajorUnits(
  amount: number | string | bigint,
  currency: string = "USD",
): string {
  const fractionDigits = currencyFractionDigits(currency);
  const normalized = String(amount).trim();

  if (!/^-?\d+$/.test(normalized)) {
    return "0";
  }

  const negative = normalized.startsWith("-");
  const digits = negative ? normalized.slice(1) : normalized;
  if (fractionDigits === 0) {
    return `${negative ? "-" : ""}${digits}`;
  }

  const padded = digits.padStart(fractionDigits + 1, "0");
  const whole = padded.slice(0, -fractionDigits);
  const fraction = padded.slice(-fractionDigits).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function majorUnitsToMinorUnits(
  amount: number | string,
  currency: string = "USD",
): number {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) return 0;

  return Math.round(numericAmount * 10 ** currencyFractionDigits(currency));
}

/**
 * Format integer points into standard locale string (e.g. 1,250 pts)
 */
export function formatPoints(
  points: number | string | bigint | undefined | null,
): string {
  if (points === undefined || points === null) return "0";
  if (typeof points === "bigint") {
    return new Intl.NumberFormat("en-US").format(points);
  }
  if (typeof points === "string" && /^-?\d+$/.test(points.trim())) {
    return new Intl.NumberFormat("en-US").format(BigInt(points.trim()));
  }
  const num = Number(points);
  if (isNaN(num)) return "0";
  return new Intl.NumberFormat("en-US").format(Math.floor(num));
}

/**
 * Format currency amounts supporting minor integer units or major units
 */
export function formatCurrency(
  amount: number | string | bigint | undefined | null,
  currency: string = "USD",
  options?: { isMinorUnits?: boolean; locale?: string },
): string {
  if (amount === undefined || amount === null) return "—";
  const curr = (currency || "USD").toUpperCase();
  const fractionDigits = currencyFractionDigits(curr);
  const minorUnitScale = 10 ** fractionDigits;
  const locale =
    options?.locale ||
    (curr === "VND" ? "vi-VN" : curr === "JPY" ? "ja-JP" : "en-US");

  let value = typeof amount === "bigint" ? Number(amount) : Number(amount);
  if (isNaN(value)) return "—";

  // Convert from minor units if applicable
  if (options?.isMinorUnits) {
    value /= minorUnitScale;
  }

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: curr,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  } catch {
    // Fallback if currency formatting fails
    const symbol =
      curr === "USD"
        ? "$"
        : curr === "EUR"
          ? "€"
          : curr === "GBP"
            ? "£"
            : curr === "JPY"
              ? "¥"
              : curr === "VND"
                ? "₫"
                : `${curr} `;
    return `${symbol}${value.toLocaleString(undefined, { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;
  }
}
