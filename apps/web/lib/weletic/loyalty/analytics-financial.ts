import {
  currencyMinorUnits,
  minorUnitsToDecimal,
  normalizeCurrency,
} from "@/lib/weletic/money";

export interface LiabilityValuation {
  currency: string;
  minorUnitsNumerator: bigint;
  pointsDenominator: bigint;
}

export type FinancialMetricStatus =
  | "available"
  | "temporarily_unavailable"
  | "data_quality_error";

export interface FinancialDataQuality {
  status: FinancialMetricStatus;
  reason: string | null;
  accountingCurrency: string;
  observedOrderCurrencies: string[];
  mismatchedOrderCount: number;
  missingOrderCount: number;
}

export interface LoyaltyFinancialConfiguration {
  status: "configured" | "unconfigured" | "invalid";
  reason: string | null;
  accountingCurrency: string;
  valuation: LiabilityValuation | null;
}

type BigIntCompatible = bigint | number | string | { toString(): string };

function parsePositiveBigInt(
  value: BigIntCompatible | null | undefined,
): bigint | null {
  if (value === null || value === undefined) return null;
  try {
    const parsed = BigInt(value.toString());
    return parsed > BigInt(0) ? parsed : null;
  } catch {
    return null;
  }
}

export function resolveLoyaltyFinancialConfiguration(input: {
  accountingCurrency: string;
  liabilityValuationCurrency?: string | null;
  liabilityMinorUnitsNumerator?: BigIntCompatible | null;
  liabilityPointsDenominator?: BigIntCompatible | null;
}): LoyaltyFinancialConfiguration {
  const accountingCurrency = normalizeCurrency(input.accountingCurrency);
  const hasConfiguredCurrency =
    input.liabilityValuationCurrency !== null &&
    input.liabilityValuationCurrency !== undefined;
  const hasConfiguredNumerator =
    input.liabilityMinorUnitsNumerator !== null &&
    input.liabilityMinorUnitsNumerator !== undefined;
  const hasConfiguredDenominator =
    input.liabilityPointsDenominator !== null &&
    input.liabilityPointsDenominator !== undefined;

  if (
    !hasConfiguredCurrency &&
    !hasConfiguredNumerator &&
    !hasConfiguredDenominator
  ) {
    return {
      status: "unconfigured",
      reason:
        "Configure liabilityValuationCurrency, liabilityMinorUnitsNumerator, and liabilityPointsDenominator before using monetary loyalty analytics.",
      accountingCurrency,
      valuation: null,
    };
  }

  let configuredCurrency: string | null = null;
  try {
    configuredCurrency = input.liabilityValuationCurrency
      ? normalizeCurrency(input.liabilityValuationCurrency)
      : null;
  } catch {
    configuredCurrency = null;
  }
  const minorUnitsNumerator = parsePositiveBigInt(
    input.liabilityMinorUnitsNumerator,
  );
  const pointsDenominator = parsePositiveBigInt(
    input.liabilityPointsDenominator,
  );

  if (!configuredCurrency || !minorUnitsNumerator || !pointsDenominator) {
    return {
      status: "invalid",
      reason:
        "Liability valuation is partially configured or contains a non-positive value.",
      accountingCurrency,
      valuation: null,
    };
  }

  if (configuredCurrency !== accountingCurrency) {
    return {
      status: "invalid",
      reason: `Liability valuation currency ${configuredCurrency} does not match program accounting currency ${accountingCurrency}.`,
      accountingCurrency,
      valuation: null,
    };
  }

  return {
    status: "configured",
    reason: null,
    accountingCurrency,
    valuation: {
      currency: accountingCurrency,
      minorUnitsNumerator,
      pointsDenominator,
    },
  };
}

export function divideRationalUp(
  numerator: bigint,
  denominator: bigint,
): bigint {
  if (denominator <= BigInt(0)) {
    throw new Error("Rational denominator must be greater than zero.");
  }
  if (numerator < BigInt(0)) {
    throw new Error(
      "Conservative rational division requires a non-negative value.",
    );
  }
  if (numerator === BigInt(0)) return BigInt(0);
  return (numerator + denominator - BigInt(1)) / denominator;
}

export function valuePointsConservatively(
  points: bigint,
  valuation: LiabilityValuation,
): bigint {
  if (points < BigInt(0)) {
    throw new Error("Liability valuation requires non-negative points.");
  }
  if (valuation.minorUnitsNumerator <= BigInt(0)) {
    throw new Error("Liability valuation numerator must be greater than zero.");
  }
  return divideRationalUp(
    points * valuation.minorUnitsNumerator,
    valuation.pointsDenominator,
  );
}

function powerOfTen(exponent: number): bigint {
  let value = BigInt(1);
  for (let index = 0; index < exponent; index += 1) value *= BigInt(10);
  return value;
}

export function formatRationalDecimal(input: {
  numerator: bigint;
  denominator: bigint;
  fractionDigits?: number;
  minimumFractionDigits?: number;
}): string {
  const {
    numerator,
    denominator,
    fractionDigits = 6,
    minimumFractionDigits = 0,
  } = input;
  if (denominator <= BigInt(0)) {
    throw new Error("Rational denominator must be greater than zero.");
  }
  if (
    !Number.isSafeInteger(fractionDigits) ||
    fractionDigits < 0 ||
    fractionDigits > 18 ||
    !Number.isSafeInteger(minimumFractionDigits) ||
    minimumFractionDigits < 0 ||
    minimumFractionDigits > fractionDigits
  ) {
    throw new Error("Decimal precision must be between 0 and 18 digits.");
  }

  const negative = numerator < BigInt(0);
  const absoluteNumerator = negative ? -numerator : numerator;
  const scale = powerOfTen(fractionDigits);
  let scaled = (absoluteNumerator * scale) / denominator;
  const remainder = (absoluteNumerator * scale) % denominator;
  if (remainder * BigInt(2) >= denominator) scaled += BigInt(1);

  if (fractionDigits === 0) {
    return `${negative && scaled !== BigInt(0) ? "-" : ""}${scaled}`;
  }

  const raw = scaled.toString().padStart(fractionDigits + 1, "0");
  const whole = raw.slice(0, -fractionDigits);
  let fraction = raw.slice(-fractionDigits);
  while (fraction.length > minimumFractionDigits && fraction.endsWith("0")) {
    fraction = fraction.slice(0, -1);
  }
  return `${negative && scaled !== BigInt(0) ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function rationalMoneyDecimal(input: {
  numeratorMinorUnits: bigint;
  denominator: bigint;
  currency: string;
  extraFractionDigits?: number;
}): string {
  const currencyDigits = currencyMinorUnits(input.currency);
  return formatRationalDecimal({
    numerator: input.numeratorMinorUnits,
    denominator: input.denominator * powerOfTen(currencyDigits),
    fractionDigits: currencyDigits + (input.extraFractionDigits ?? 6),
    minimumFractionDigits: currencyDigits,
  });
}

export function finiteCompatibilityNumber(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function availableFinancialDataQuality(
  accountingCurrency: string,
): FinancialDataQuality {
  return {
    status: "available",
    reason: null,
    accountingCurrency: normalizeCurrency(accountingCurrency),
    observedOrderCurrencies: [],
    mismatchedOrderCount: 0,
    missingOrderCount: 0,
  };
}

export function evaluateOrderCurrencyDataQuality(
  orders: Array<{ accountingCurrency?: string | null }>,
  accountingCurrency: string,
): FinancialDataQuality {
  const expected = normalizeCurrency(accountingCurrency);
  const observed = new Set<string>();
  let mismatchedOrderCount = 0;

  for (const order of orders) {
    let currency = "MISSING";
    try {
      currency = order.accountingCurrency
        ? normalizeCurrency(order.accountingCurrency)
        : "MISSING";
    } catch {
      currency = String(order.accountingCurrency || "INVALID").toUpperCase();
    }
    observed.add(currency);
    if (currency !== expected) mismatchedOrderCount += 1;
  }

  if (mismatchedOrderCount > 0) {
    const observedOrderCurrencies = [...observed].sort();
    return {
      status: "data_quality_error",
      reason: `${mismatchedOrderCount} order(s) do not use configured accounting currency ${expected}.`,
      accountingCurrency: expected,
      observedOrderCurrencies,
      mismatchedOrderCount,
      missingOrderCount: 0,
    };
  }

  return availableFinancialDataQuality(expected);
}

export function formatMinorUnits(value: bigint, currency: string): string {
  return minorUnitsToDecimal(value, normalizeCurrency(currency));
}
