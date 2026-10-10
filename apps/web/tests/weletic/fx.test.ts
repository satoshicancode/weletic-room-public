import { deriveRateFromUsdTable, getAccountingFxQuote } from "@/lib/weletic/fx";
import { redis } from "@/lib/upstash";
import { describe, expect, test, vi, beforeEach } from "vitest";

vi.mock("@/lib/upstash", () => ({
  redis: {
    hget: vi.fn(),
    get: vi.fn(),
  },
}));

describe("Weletic FX derivation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  test("FIN-AUDIT-07: Successfully returns static fallback quote when Redis throws network error", async () => {
    vi.mocked(redis.hget).mockRejectedValue(new Error("Redis connection timed out"));
    vi.mocked(redis.get).mockRejectedValue(new Error("Redis connection timed out"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const quote = await getAccountingFxQuote({
      base: "USD",
      quote: "JPY",
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[getAccountingFxQuote] Redis lookup failed"),
      expect.stringContaining("Redis connection timed out"),
    );

    expect(quote.base).toBe("USD");
    expect(quote.quote).toBe("JPY");
    expect(quote.rate).toBe("155.2");
    expect(quote.provider).toBe("static-fallback");
    expect(quote.providerRef).toContain("static:default_fallback_rates");
    expect(quote.capturedAt).toBeInstanceOf(Date);

    warnSpy.mockRestore();
  });

  test("FIN-AUDIT-07: Successfully returns static fallback quote for cross rate (EUR to JPY) on Redis failure", async () => {
    vi.mocked(redis.hget).mockRejectedValue(new Error("ECONNREFUSED"));
    vi.mocked(redis.get).mockRejectedValue(new Error("ECONNREFUSED"));

    const quote = await getAccountingFxQuote({
      base: "EUR",
      quote: "JPY",
    });

    // EUR rate 0.92, JPY rate 155.2 -> 155.2 / 0.92 = 168.695652173913
    expect(quote.base).toBe("EUR");
    expect(quote.quote).toBe("JPY");
    expect(Number(quote.rate)).toBeCloseTo(168.69565, 3);
    expect(quote.provider).toBe("static-fallback");
  });

  test("FIN-AUDIT-07: Uses Redis live rates when Redis responds successfully", async () => {
    vi.mocked(redis.hget).mockImplementation(async (_key: string, field: string) => {
      if (field === "JPY") return "160.5";
      return null;
    });
    vi.mocked(redis.get).mockResolvedValue("2026-10-09T00:00:00.000Z");

    const quote = await getAccountingFxQuote({
      base: "USD",
      quote: "JPY",
    });

    expect(quote.rate).toBe("160.5");
    expect(quote.provider).toBe("dub-fxRates:usd");
    expect(quote.providerRef).toContain("redis:fxRates:usd:2026-10-09");
  });

  test("FIN-AUDIT-07: Returns identity quote for identical currencies without calling Redis", async () => {
    const quote = await getAccountingFxQuote({
      base: "USD",
      quote: "USD",
    });

    expect(quote.rate).toBe("1");
    expect(quote.provider).toBe("identity");
    expect(redis.hget).not.toHaveBeenCalled();
  });
});
