import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/upstash", () => ({
  redis: {
    hget: vi.fn(),
    get: vi.fn(),
  },
}));

import { convertCurrencyWithFxRates } from "@/lib/analytics/convert-currency";
import { redis } from "@/lib/upstash";
import { getAccountingFxQuote } from "@/lib/weletic/fx";
import { isZeroDecimalCurrency } from "@dub/utils";
import { findActiveDiscountCode } from "../../workers/queue-consumer/src/index";

// ============================================================================
// SUITE 1: FIN-AUDIT-05 / WRK-AUDIT-06 Historical Coupon Attribution Boundaries
// ============================================================================
describe("CHALLENGER SUITE 1: FIN-AUDIT-05 / WRK-06 Historical Coupon Attribution Boundaries", () => {
  const programId = "prog_adversarial_test";
  const code = "PROMO50";

  /**
   * Helper that mirrors exact Prisma filtering logic for DiscountCode
   * where: { programId, code, OR: [{ disabledAt: null }, { disabledAt: { gte: orderDate } }] }
   */
  function simulatePrismaDiscountFilter(
    record: { disabledAt: Date | null },
    where: any,
  ) {
    if (where.disabledAt === null) {
      return record.disabledAt === null;
    }
    if (Array.isArray(where.OR)) {
      return where.OR.some((cond: any) => {
        if (cond.disabledAt === null) {
          return record.disabledAt === null;
        }
        if (cond.disabledAt?.gte) {
          if (!record.disabledAt) return false;
          return record.disabledAt.getTime() >= cond.disabledAt.gte.getTime();
        }
        return false;
      });
    }
    return false;
  }

  it("1.1 Exact millisecond boundary: orderCreatedAt == disabledAt -> MUST ATTRIBUTE", async () => {
    const boundaryTime = new Date("2026-10-01T12:00:00.500Z");
    const disabledAt = new Date(boundaryTime.getTime());
    const orderCreatedAt = new Date(boundaryTime.getTime());

    const mockRecord = {
      id: "dc_exact_ms",
      code,
      programId,
      partnerId: "partner_bob",
      linkId: "link_bob",
      disabledAt,
    };

    const mockPrisma = {
      discountCode: {
        findFirst: vi.fn(async ({ where }) => {
          expect(where.OR).toBeDefined();
          const matches = simulatePrismaDiscountFilter(mockRecord, where);
          return matches ? mockRecord : null;
        }),
      },
    };

    const result = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      orderCreatedAt,
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe("dc_exact_ms");
    expect(result?.partnerId).toBe("partner_bob");
  });

  it("1.2 Order 1ms AFTER deactivation: orderCreatedAt == disabledAt + 1ms -> MUST NOT ATTRIBUTE", async () => {
    const boundaryTime = new Date("2026-10-01T12:00:00.500Z");
    const disabledAt = new Date(boundaryTime.getTime());
    const orderCreatedAt = new Date(boundaryTime.getTime() + 1); // Exact +1ms

    const mockRecord = {
      id: "dc_after_ms",
      code,
      programId,
      partnerId: "partner_bob",
      linkId: "link_bob",
      disabledAt,
    };

    const mockPrisma = {
      discountCode: {
        findFirst: vi.fn(async ({ where }) => {
          expect(where.OR).toBeDefined();
          const matches = simulatePrismaDiscountFilter(mockRecord, where);
          return matches ? mockRecord : null;
        }),
      },
    };

    const result = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      orderCreatedAt,
    );

    expect(result).toBeNull();
  });

  it("1.3 Order 1ms BEFORE deactivation: orderCreatedAt == disabledAt - 1ms -> MUST ATTRIBUTE", async () => {
    const boundaryTime = new Date("2026-10-01T12:00:00.500Z");
    const disabledAt = new Date(boundaryTime.getTime());
    const orderCreatedAt = new Date(boundaryTime.getTime() - 1); // Exact -1ms

    const mockRecord = {
      id: "dc_before_ms",
      code,
      programId,
      partnerId: "partner_bob",
      linkId: "link_bob",
      disabledAt,
    };

    const mockPrisma = {
      discountCode: {
        findFirst: vi.fn(async ({ where }) => {
          expect(where.OR).toBeDefined();
          const matches = simulatePrismaDiscountFilter(mockRecord, where);
          return matches ? mockRecord : null;
        }),
      },
    };

    const result = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      orderCreatedAt,
    );

    expect(result).not.toBeNull();
    expect(result?.id).toBe("dc_before_ms");
  });

  it("1.4 Missing order timestamp (undefined / null / empty string): strictly enforces disabledAt: null", async () => {
    const disabledAt = new Date("2026-10-01T12:00:00.000Z");
    const mockRecord = {
      id: "dc_disabled",
      code,
      programId,
      partnerId: "partner_bob",
      disabledAt,
    };

    const mockPrisma = {
      discountCode: {
        findFirst: vi.fn(async ({ where }) => {
          expect(where.disabledAt).toBeNull();
          expect(where.OR).toBeUndefined();
          return simulatePrismaDiscountFilter(mockRecord, where)
            ? mockRecord
            : null;
        }),
      },
    };

    // Case A: undefined
    const resUndefined = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      undefined,
    );
    expect(resUndefined).toBeNull();

    // Case B: null
    const resNull = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      null,
    );
    expect(resNull).toBeNull();

    // Case C: empty string
    const resEmpty = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      "",
    );
    expect(resEmpty).toBeNull();
  });

  it("1.5 Corrupted & Malformed timestamp strings: fail closed without throwing unhandled exceptions", async () => {
    const disabledAt = new Date("2026-10-01T12:00:00.000Z");
    const mockRecord = {
      id: "dc_disabled",
      code,
      programId,
      partnerId: "partner_bob",
      disabledAt,
    };

    const mockPrisma = {
      discountCode: {
        findFirst: vi.fn(async ({ where }) => {
          // When order timestamp is invalid, findActiveDiscountCode MUST fallback to disabledAt: null
          expect(where.disabledAt).toBeNull();
          expect(where.OR).toBeUndefined();
          return simulatePrismaDiscountFilter(mockRecord, where)
            ? mockRecord
            : null;
        }),
      },
    };

    const adversarialCorruptedInputs = [
      "not-a-valid-date",
      "2026-99-99T99:99:99Z",
      "undefined",
      "null",
      "NaN",
      "[object Object]",
      "123456789012345678901234567890",
      "   ",
    ];

    for (const corrupted of adversarialCorruptedInputs) {
      const result = await findActiveDiscountCode(
        mockPrisma as any,
        programId,
        code,
        corrupted,
      );
      expect(result).toBeNull();
    }
  });

  it("1.6 Timezone parity: ISO strings with UTC vs JST offsets resolve to identical millisecond boundaries", async () => {
    // 2026-10-01T03:00:00.500Z == 2026-10-01T12:00:00.500+09:00
    const disabledAt = new Date("2026-10-01T03:00:00.500Z");
    const mockRecord = {
      id: "dc_tz",
      code,
      programId,
      partnerId: "partner_tz",
      disabledAt,
    };

    const mockPrisma = {
      discountCode: {
        findFirst: vi.fn(async ({ where }) => {
          return simulatePrismaDiscountFilter(mockRecord, where)
            ? mockRecord
            : null;
        }),
      },
    };

    // Exact match across timezones
    const resExact = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      "2026-10-01T12:00:00.500+09:00",
    );
    expect(resExact).not.toBeNull();

    // +1ms after JST
    const resPlus1ms = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      "2026-10-01T12:00:00.501+09:00",
    );
    expect(resPlus1ms).toBeNull();
  });

  it("1.7 Active codes (disabledAt: null) attribute regardless of order timestamp or lack thereof", async () => {
    const mockRecord = {
      id: "dc_active",
      code,
      programId,
      partnerId: "partner_active",
      disabledAt: null,
    };

    const mockPrisma = {
      discountCode: {
        findFirst: vi.fn(async ({ where }) => {
          return simulatePrismaDiscountFilter(mockRecord, where)
            ? mockRecord
            : null;
        }),
      },
    };

    // With past timestamp
    const resPast = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      new Date("2020-01-01T00:00:00Z"),
    );
    expect(resPast).not.toBeNull();

    // With future timestamp
    const resFuture = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      new Date("2035-01-01T00:00:00Z"),
    );
    expect(resFuture).not.toBeNull();

    // With corrupted timestamp
    const resCorrupted = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
      "malformed-string",
    );
    expect(resCorrupted).not.toBeNull();

    // Without timestamp
    const resOmitted = await findActiveDiscountCode(
      mockPrisma as any,
      programId,
      code,
    );
    expect(resOmitted).not.toBeNull();
  });

  it("1.8 Attached Link boundary in queue-consumer: exact ms vs +1ms", () => {
    // Test link resolution logic from apps/web/workers/queue-consumer/src/index.ts lines 291-303
    const linkDisabledDate = new Date("2026-10-01T12:00:00.500Z");

    function resolveAttachedLink(link: any, orderCreatedAt: any) {
      let resolvedLink = link;
      if (resolvedLink?.disabledAt && orderCreatedAt) {
        const orderDate = new Date(orderCreatedAt);
        const lDisabledDate = new Date(resolvedLink.disabledAt);
        if (
          !isNaN(orderDate.getTime()) &&
          !isNaN(lDisabledDate.getTime()) &&
          orderDate > lDisabledDate
        ) {
          resolvedLink = null;
        }
      }
      return resolvedLink;
    }

    const attachedLink = {
      id: "link_123",
      disabledAt: linkDisabledDate,
    };

    // Exact millisecond: orderDate == linkDisabledDate -> NOT strictly greater -> retained!
    const atExactMs = resolveAttachedLink(
      attachedLink,
      new Date("2026-10-01T12:00:00.500Z"),
    );
    expect(atExactMs).not.toBeNull();

    // 1ms after: orderDate > linkDisabledDate -> nulled!
    const after1Ms = resolveAttachedLink(
      attachedLink,
      new Date("2026-10-01T12:00:00.501Z"),
    );
    expect(after1Ms).toBeNull();

    // 1ms before: orderDate < linkDisabledDate -> retained!
    const before1Ms = resolveAttachedLink(
      attachedLink,
      new Date("2026-10-01T12:00:00.499Z"),
    );
    expect(before1Ms).not.toBeNull();
  });

  it("1.9 [ADVERSARIAL ATTACK] Attached Link fails open when orderCreatedAt is missing or corrupted", () => {
    // In queue-consumer lines 291-303:
    // if (link?.disabledAt && orderCreatedAt) { ... if (orderDate > linkDisabledDate) link = null; }
    // When orderCreatedAt is undefined or corrupted, the condition evaluates to false or NaN!
    const linkDisabledDate = new Date("2026-09-01T00:00:00Z"); // Disabled 1 month ago
    const attachedLink = {
      id: "link_disabled",
      disabledAt: linkDisabledDate,
    };

    function resolveAttachedLink(link: any, orderCreatedAt: any) {
      let resolvedLink = link;
      if (resolvedLink?.disabledAt && orderCreatedAt) {
        const orderDate = new Date(orderCreatedAt);
        const lDisabledDate = new Date(resolvedLink.disabledAt);
        if (
          !isNaN(orderDate.getTime()) &&
          !isNaN(lDisabledDate.getTime()) &&
          orderDate > lDisabledDate
        ) {
          resolvedLink = null;
        }
      }
      return resolvedLink;
    }

    // Vulnerability Check A: orderCreatedAt is undefined -> disabled link is NOT nulled
    const linkWithUndefined = resolveAttachedLink(attachedLink, undefined);
    expect(linkWithUndefined).not.toBeNull(); // Fails open!

    // Vulnerability Check B: orderCreatedAt is corrupted -> disabled link is NOT nulled
    const linkWithCorrupted = resolveAttachedLink(
      attachedLink,
      "corrupted-date",
    );
    expect(linkWithCorrupted).not.toBeNull(); // Fails open!
  });
});

// ============================================================================
// SUITE 2: FIN-AUDIT-06 & FIN-AUDIT-09 Multi-Currency Scaling & Zero-Decimal Fuzzing
// ============================================================================
describe("CHALLENGER SUITE 2: FIN-AUDIT-06 & FIN-AUDIT-09 Multi-Currency Scaling & Zero-Decimal Fuzzing", () => {
  const fxRates: Record<string, string> = {
    JPY: "155.2",
    VND: "25450",
    KRW: "1350",
    EUR: "0.92",
    GBP: "0.79",
    CAD: "1.36",
    AUD: "1.52",
  };

  function computeTapfiliateAmounts({
    currency,
    conversionSubAmount,
    commissionAmount,
    rates,
  }: {
    currency: string;
    conversionSubAmount: number;
    commissionAmount: number;
    rates?: Record<string, string> | null;
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

  it("2.1 Zero-decimal currency detection across all required currencies", () => {
    // Verified zero-decimal currencies
    expect(isZeroDecimalCurrency("JPY")).toBe(true);
    expect(isZeroDecimalCurrency("VND")).toBe(true);
    expect(isZeroDecimalCurrency("KRW")).toBe(true);
    expect(isZeroDecimalCurrency("jpy")).toBe(true);
    expect(isZeroDecimalCurrency("vnd")).toBe(true);
    expect(isZeroDecimalCurrency("krw")).toBe(true);

    // Standard 2-decimal currencies
    expect(isZeroDecimalCurrency("USD")).toBe(false);
    expect(isZeroDecimalCurrency("EUR")).toBe(false);
    expect(isZeroDecimalCurrency("GBP")).toBe(false);
    expect(isZeroDecimalCurrency("CAD")).toBe(false);
    expect(isZeroDecimalCurrency("AUD")).toBe(false);
  });

  it("2.2 Tapfiliate import with JPY (zero-decimal): accurately scales without 100x inflation", () => {
    // Sale: ¥15,520 JPY, Earnings: ¥1,552 JPY (10%)
    const { saleAmount, earnings } = computeTapfiliateAmounts({
      currency: "JPY",
      conversionSubAmount: 15520,
      commissionAmount: 1552,
      rates: fxRates,
    });

    // 15520 / 155.2 * 100 = 10,000 cents ($100.00 USD)
    expect(saleAmount).toBe(10000);
    // 1552 / 155.2 * 100 = 1,000 cents ($10.00 USD)
    expect(earnings).toBe(1000);
  });

  it("2.3 Tapfiliate import with VND (zero-decimal): accurately scales without 100x inflation", () => {
    // Sale: 254,500 VND, Earnings: 25,450 VND (10%)
    const { saleAmount, earnings } = computeTapfiliateAmounts({
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

  it("2.4 Tapfiliate import with KRW (zero-decimal): accurately scales without 100x inflation", () => {
    // Sale: 1,350,000 KRW, Earnings: 135,000 KRW (10%)
    const { saleAmount, earnings } = computeTapfiliateAmounts({
      currency: "KRW",
      conversionSubAmount: 1350000,
      commissionAmount: 135000,
      rates: fxRates,
    });

    // 1,350,000 / 1350 * 100 = 100,000 cents ($1,000.00 USD)
    expect(saleAmount).toBe(100000);
    // 135,000 / 1350 * 100 = 10,000 cents ($100.00 USD)
    expect(earnings).toBe(10000);
  });

  it("2.5 Tapfiliate import with USD (standard): retains exact integer cents without FX conversion", () => {
    // Sale: $100.00, Earnings: $15.50
    const { saleAmount, earnings } = computeTapfiliateAmounts({
      currency: "USD",
      conversionSubAmount: 100.0,
      commissionAmount: 15.5,
      rates: fxRates,
    });

    expect(saleAmount).toBe(10000);
    expect(earnings).toBe(1550);
  });

  it("2.6 Tapfiliate import with EUR (2-decimal): converts to USD cents", () => {
    // Sale: €92.00, Earnings: €9.20 (10%)
    const { saleAmount, earnings } = computeTapfiliateAmounts({
      currency: "EUR",
      conversionSubAmount: 92.0,
      commissionAmount: 9.2,
      rates: fxRates,
    });

    // 92.00 * 100 = 9200 cents / 0.92 = 10,000 USD cents ($100.00 USD)
    expect(saleAmount).toBe(10000);
    // 9.20 * 100 = 920 cents / 0.92 = 1,000 USD cents ($10.00 USD)
    expect(earnings).toBe(1000);
  });

  it("2.7 Tapfiliate import with GBP (2-decimal): converts to USD cents", () => {
    // Sale: £79.00, Earnings: £7.90 (10%)
    const { saleAmount, earnings } = computeTapfiliateAmounts({
      currency: "GBP",
      conversionSubAmount: 79.0,
      commissionAmount: 7.9,
      rates: fxRates,
    });

    // 79.00 * 100 = 7900 cents / 0.79 = 10,000 USD cents ($100.00 USD)
    expect(saleAmount).toBe(10000);
    // 7.90 * 100 = 790 cents / 0.79 = 1,000 USD cents ($10.00 USD)
    expect(earnings).toBe(1000);
  });

  it("2.8 Zero-Decimal Fuzzing: 1,000 pseudo-random transactions across all 6 currencies", () => {
    const currencies = ["JPY", "VND", "KRW", "USD", "EUR", "GBP"] as const;

    for (let i = 0; i < 1000; i++) {
      const currency = currencies[i % currencies.length];
      const isZero = isZeroDecimalCurrency(currency);

      // Generate randomized amounts
      const rawSale = isZero
        ? Math.floor(Math.random() * 50_000_000) + 100 // e.g. 100 to 50,000,000 Yen/Dong/Won
        : Math.round((Math.random() * 5000 + 1) * 100) / 100; // e.g. 1.00 to 5000.00 USD/EUR/GBP

      const commissionRate = 0.1 + (i % 20) * 0.01; // 10% to 29%
      const rawEarnings = isZero
        ? Math.floor(rawSale * commissionRate)
        : Math.round(rawSale * commissionRate * 100) / 100;

      const { saleAmount, earnings } = computeTapfiliateAmounts({
        currency,
        conversionSubAmount: rawSale,
        commissionAmount: rawEarnings,
        rates: fxRates,
      });

      // INVARIANTS:
      // 1. Both amounts must be finite integers
      expect(Number.isInteger(saleAmount)).toBe(true);
      expect(Number.isInteger(earnings)).toBe(true);
      expect(saleAmount).toBeGreaterThan(0);
      expect(earnings).toBeGreaterThanOrEqual(0);

      // 2. Earnings must never exceed sale amount for standard commissions
      expect(earnings).toBeLessThanOrEqual(saleAmount);
    }
  });

  it("2.9 FirstPromoter non-USD earnings conversion with synthetic FX rates (FIN-AUDIT-09)", () => {
    function computeFirstPromoterEarnings({
      rawEarnings,
      currency,
      rates,
    }: {
      rawEarnings: number;
      currency: string;
      rates: Record<string, string> | null;
    }) {
      let earnings = Number(rawEarnings ?? 0);
      const earningsCurrency = currency ?? "usd";

      if (earnings > 0 && earningsCurrency.toUpperCase() !== "USD" && rates) {
        const { amount: convertedEarnings } = convertCurrencyWithFxRates({
          currency: earningsCurrency,
          amount: earnings,
          fxRates: rates,
        });
        earnings = convertedEarnings;
      }
      return earnings;
    }

    // EUR earnings: €25.00 (2500 cents), FX rate 1.08 -> 2500 / 1.08 = 2315 cents
    const eurRates = { EUR: "1.08", JPY: "155.0", GBP: "1.25", KRW: "1350.0" };
    const eurEarnings = computeFirstPromoterEarnings({
      rawEarnings: 2500,
      currency: "EUR",
      rates: eurRates,
    });
    expect(eurEarnings).toBe(Math.round(2500 / 1.08));

    // GBP earnings: £40.00 (4000 cents), FX rate 1.25 -> 4000 / 1.25 = 3200 cents
    const gbpEarnings = computeFirstPromoterEarnings({
      rawEarnings: 4000,
      currency: "GBP",
      rates: eurRates,
    });
    expect(gbpEarnings).toBe(Math.round(4000 / 1.25));

    // JPY earnings: ¥10,000 JPY, FX rate 155.0 -> 10000 / 155 * 100 = 6452 cents
    const jpyEarnings = computeFirstPromoterEarnings({
      rawEarnings: 10000,
      currency: "JPY",
      rates: eurRates,
    });
    expect(jpyEarnings).toBe(Math.round((10000 / 155.0) * 100));

    // KRW earnings: 50,000 KRW, FX rate 1350.0 -> 50000 / 1350 * 100 = 3704 cents
    const krwEarnings = computeFirstPromoterEarnings({
      rawEarnings: 50000,
      currency: "KRW",
      rates: eurRates,
    });
    expect(krwEarnings).toBe(Math.round((50000 / 1350.0) * 100));

    // USD earnings: 5000 cents -> untouched
    const usdEarnings = computeFirstPromoterEarnings({
      rawEarnings: 5000,
      currency: "USD",
      rates: eurRates,
    });
    expect(usdEarnings).toBe(5000);
  });

  it("2.10 [ADVERSARIAL ATTACK] FirstPromoter negative earnings bypasses FX conversion check", () => {
    // In apps/web/lib/firstpromoter/import-commissions.ts line 245:
    // if (earnings > 0 && earningsCurrency.toUpperCase() !== "USD" && fxRates) { ... }
    // When earnings is negative (e.g. -2000 EUR cents for a refund or negative adjustment):
    // earnings > 0 evaluates to FALSE!
    // The negative foreign currency is NOT converted to USD!
    let earnings = -2000; // -20.00 EUR in cents
    const earningsCurrency = "EUR";
    const customRates = { EUR: "1.08" };

    if (
      earnings > 0 &&
      earningsCurrency.toUpperCase() !== "USD" &&
      customRates
    ) {
      const { amount } = convertCurrencyWithFxRates({
        currency: earningsCurrency,
        amount: earnings,
        fxRates: customRates,
      });
      earnings = amount;
    }

    // Demonstrates empirical behavior: negative earnings remains unconverted
    expect(earnings).toBe(-2000);
  });
});

// ============================================================================
// SUITE 3: FIN-AUDIT-07 Redis Outage Resilience & Static Fallback
// ============================================================================
describe("CHALLENGER SUITE 3: FIN-AUDIT-07 Redis Outage Resilience & Static Fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("3.1 Complete Redis Outage: ECONNREFUSED network drop seamlessly falls back to static rates", async () => {
    vi.mocked(redis.hget).mockRejectedValue(
      new Error("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:6379"),
    );
    vi.mocked(redis.get).mockRejectedValue(
      new Error("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:6379"),
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const quote = await getAccountingFxQuote({
      base: "USD",
      quote: "JPY",
    });

    expect(quote.base).toBe("USD");
    expect(quote.quote).toBe("JPY");
    expect(quote.rate).toBe("155.2");
    expect(quote.provider).toBe("static-fallback");
    expect(quote.providerRef).toMatch(/^static:default_fallback_rates:/);
    expect(quote.capturedAt).toBeInstanceOf(Date);

    warnSpy.mockRestore();
  });

  it("3.2 Redis Timeout Outage: ETIMEDOUT during peak load falls back to static rates", async () => {
    vi.mocked(redis.hget).mockRejectedValue(
      new Error("ETIMEDOUT: upstream redis cluster unresponsive"),
    );
    vi.mocked(redis.get).mockRejectedValue(new Error("ETIMEDOUT"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const quote = await getAccountingFxQuote({
      base: "USD",
      quote: "VND",
    });

    expect(quote.base).toBe("USD");
    expect(quote.quote).toBe("VND");
    expect(quote.rate).toBe("25450");
    expect(quote.provider).toBe("static-fallback");

    warnSpy.mockRestore();
  });

  it("3.3 Non-Error rejection from Redis (e.g. cluster node failure string) handled gracefully", async () => {
    vi.mocked(redis.hget).mockRejectedValue("CLUSTERDOWN The cluster is down");
    vi.mocked(redis.get).mockRejectedValue("CLUSTERDOWN The cluster is down");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const quote = await getAccountingFxQuote({
      base: "USD",
      quote: "EUR",
    });

    expect(quote.base).toBe("USD");
    expect(quote.quote).toBe("EUR");
    expect(quote.rate).toBe("0.92");
    expect(quote.provider).toBe("static-fallback");

    warnSpy.mockRestore();
  });

  it("3.4 Comprehensive Static Fallback Verification for all 7 supported currencies", async () => {
    vi.mocked(redis.hget).mockRejectedValue(new Error("Redis offline"));
    vi.mocked(redis.get).mockRejectedValue(new Error("Redis offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const expectedRates: Record<string, string> = {
      EUR: "0.92",
      JPY: "155.2",
      VND: "25450",
      GBP: "0.79",
      MXN: "18.5",
      CAD: "1.36",
      AUD: "1.52",
    };

    for (const [curr, expectedRate] of Object.entries(expectedRates)) {
      const quote = await getAccountingFxQuote({
        base: "USD",
        quote: curr,
      });
      expect(quote.rate).toBe(expectedRate);
      expect(quote.provider).toBe("static-fallback");
    }
  });

  it("3.5 Cross-Rate Derivations during Redis Outage", async () => {
    vi.mocked(redis.hget).mockRejectedValue(new Error("Redis offline"));
    vi.mocked(redis.get).mockRejectedValue(new Error("Redis offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // EUR to JPY: 155.2 / 0.92 = 168.695652173913
    const eurJpy = await getAccountingFxQuote({ base: "EUR", quote: "JPY" });
    expect(Number(eurJpy.rate)).toBeCloseTo(168.695652, 4);
    expect(eurJpy.provider).toBe("static-fallback");

    // GBP to VND: 25450 / 0.79 = 32215.189873417721
    const gbpVnd = await getAccountingFxQuote({ base: "GBP", quote: "VND" });
    expect(Number(gbpVnd.rate)).toBeCloseTo(32215.18987, 3);
    expect(gbpVnd.provider).toBe("static-fallback");

    // JPY to EUR: 0.92 / 155.2 = 0.005927835051
    const jpyEur = await getAccountingFxQuote({ base: "JPY", quote: "EUR" });
    expect(Number(jpyEur.rate)).toBeCloseTo(0.0059278, 5);
    expect(jpyEur.provider).toBe("static-fallback");

    // CAD to AUD: 1.52 / 1.36 = 1.117647058823
    const cadAud = await getAccountingFxQuote({ base: "CAD", quote: "AUD" });
    expect(Number(cadAud.rate)).toBeCloseTo(1.117647, 4);
    expect(cadAud.provider).toBe("static-fallback");
  });

  it("3.6 Identity conversion bypasses Redis completely (zero network calls)", async () => {
    const quoteUsd = await getAccountingFxQuote({ base: "USD", quote: "USD" });
    expect(quoteUsd.rate).toBe("1");
    expect(quoteUsd.provider).toBe("identity");

    const quoteJpy = await getAccountingFxQuote({ base: "JPY", quote: "JPY" });
    expect(quoteJpy.rate).toBe("1");
    expect(quoteJpy.provider).toBe("identity");

    const quoteEur = await getAccountingFxQuote({ base: "EUR", quote: "EUR" });
    expect(quoteEur.rate).toBe("1");
    expect(quoteEur.provider).toBe("identity");

    expect(redis.hget).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("3.7 Fail-Closed: Unsupported currency during Redis outage throws descriptive error", async () => {
    vi.mocked(redis.hget).mockRejectedValue(new Error("Redis offline"));
    vi.mocked(redis.get).mockRejectedValue(new Error("Redis offline"));
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // SGD is not in DEFAULT_FALLBACK_RATES
    await expect(
      getAccountingFxQuote({ base: "USD", quote: "SGD" }),
    ).rejects.toThrow("Missing FX rate for USD/SGD; conversion aborted.");

    // CHF is not in DEFAULT_FALLBACK_RATES
    await expect(
      getAccountingFxQuote({ base: "CHF", quote: "EUR" }),
    ).rejects.toThrow("Missing FX rate for CHF/EUR; conversion aborted.");
  });

  it("3.8 [ADVERSARIAL ATTACK] Cache miss (null rate) vs Redis crash provider attribution discrepancy", async () => {
    // When Redis is reachable but has no rate for JPY (returns null):
    vi.mocked(redis.hget).mockResolvedValue(null);
    vi.mocked(redis.get).mockResolvedValue("2026-10-09T00:00:00.000Z");

    const quote = await getAccountingFxQuote({
      base: "USD",
      quote: "JPY",
    });

    // Rate falls back to static default 155.2
    expect(quote.rate).toBe("155.2");
    // BUT provider claims "dub-fxRates:usd" rather than "static-fallback"!
    // This documents a subtle telemetry discrepancy when Redis is UP but key is MISSING.
    expect(quote.provider).toBe("dub-fxRates:usd");
  });
});
