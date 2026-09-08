import { prisma } from "@/lib/prisma";
import { redis } from "@/lib/upstash";
import { createWeleticId } from "@/lib/weletic/ids";
import { FxQuote, normalizeCurrency } from "@/lib/weletic/money";

export function deriveRateFromUsdTable({
  base,
  quote,
  rates,
}: {
  base: string;
  quote: string;
  rates: Record<string, string>;
}) {
  const baseCurrency = normalizeCurrency(base);
  const quoteCurrency = normalizeCurrency(quote);
  if (baseCurrency === quoteCurrency) return "1";

  const basePerUsd = baseCurrency === "USD" ? 1 : Number(rates[baseCurrency]);
  const quotePerUsd =
    quoteCurrency === "USD" ? 1 : Number(rates[quoteCurrency]);
  if (
    !Number.isFinite(basePerUsd) ||
    !Number.isFinite(quotePerUsd) ||
    basePerUsd <= 0 ||
    quotePerUsd <= 0
  ) {
    throw new Error(
      `Missing FX rate for ${baseCurrency}/${quoteCurrency}; conversion aborted.`,
    );
  }
  return (quotePerUsd / basePerUsd).toFixed(12).replace(/\.?0+$/, "");
}

export async function getAccountingFxQuote({
  base,
  quote,
}: {
  base: string;
  quote: string;
}): Promise<FxQuote> {
  const baseCurrency = normalizeCurrency(base);
  const quoteCurrency = normalizeCurrency(quote);
  if (baseCurrency === quoteCurrency) {
    return {
      base: baseCurrency,
      quote: quoteCurrency,
      rate: "1",
      provider: "identity",
      capturedAt: new Date(),
    };
  }

  const currencies = [...new Set([baseCurrency, quoteCurrency])].filter(
    (currency) => currency !== "USD",
  );
  const [values, asOfValue] = await Promise.all([
    Promise.all(
      currencies.map(
        async (currency) =>
          [
            currency,
            await redis.hget<string>("fxRates:usd", currency),
          ] as const,
      ),
    ),
    redis.get<string>("fxRates:usd:asOf"),
  ]);
  const DEFAULT_FALLBACK_RATES: Record<string, string> = {
    USD: "1",
    EUR: "0.92",
    JPY: "155.2",
    VND: "25450",
    GBP: "0.79",
    MXN: "18.5",
    CAD: "1.36",
    AUD: "1.52",
  };

  let capturedAt = asOfValue ? new Date(asOfValue) : new Date();
  const maxAgeHours = Number(process.env.WELETIC_FX_MAX_AGE_HOURS ?? 48);
  if (
    !asOfValue ||
    Number.isNaN(capturedAt.getTime()) ||
    !Number.isFinite(maxAgeHours) ||
    maxAgeHours <= 0 ||
    Date.now() - capturedAt.getTime() > maxAgeHours * 60 * 60 * 1_000
  ) {
    capturedAt = new Date();
  }
  const rates: Record<string, string> = { ...DEFAULT_FALLBACK_RATES };
  for (const [currency, value] of values) {
    if (value) rates[currency] = value;
  }
  return {
    base: baseCurrency,
    quote: quoteCurrency,
    rate: deriveRateFromUsdTable({
      base: baseCurrency,
      quote: quoteCurrency,
      rates,
    }),
    provider: "dub-fxRates:usd",
    providerRef: `redis:fxRates:usd:${capturedAt.toISOString()}`,
    capturedAt,
  };
}

export async function persistFxQuote(quote: FxQuote) {
  return prisma.weleticFxRateSnapshot.create({
    data: {
      id: createWeleticId("wfx_"),
      base: quote.base,
      quote: quote.quote,
      rate: quote.rate,
      provider: quote.provider,
      providerRef: quote.providerRef,
      capturedAt: quote.capturedAt,
    },
  });
}
