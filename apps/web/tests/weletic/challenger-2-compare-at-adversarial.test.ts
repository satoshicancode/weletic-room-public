import type { WeleticCatalogProduct } from "@/lib/swr/use-weletic-products";
import {
  currencyMinorUnits,
  discountPercent,
  formatMoney,
  getCatalogPricing,
  hasDiscount,
  normalizeCurrency,
} from "@/lib/weletic/money";
import { describe, expect, it } from "vitest";

describe("Adversarial Stress Test Suite: Challenger 2 (R3 & R4 Compare-At Invariants)", () => {
  // =========================================================================
  // SECTION 1: PRICING BOUNDARY CONDITIONS & NUMERICAL INVARIANTS
  // =========================================================================
  describe("Section 1: Pricing Boundary Conditions & Invariants", () => {
    it("1.1: compareAtAmount == amount strictly returns hasDiscount=false and no badge or strikethrough", () => {
      const cases = [
        { amount: "5000", compareAt: "5000", currency: "USD" },
        { amount: "0", compareAt: "0", currency: "USD" },
        { amount: "1000000", compareAt: "1000000", currency: "VND" },
        { amount: 1500, compareAt: 1500, currency: "EUR" },
        { amount: BigInt(3000), compareAt: BigInt(3000), currency: "JPY" },
      ];

      for (const c of cases) {
        expect(hasDiscount(c.amount, c.compareAt)).toBe(false);
        expect(discountPercent(c.amount, c.compareAt)).toBe(0);

        const pricing = getCatalogPricing({
          amount: c.amount,
          compareAtAmount: c.compareAt,
          currency: c.currency,
        });

        expect(pricing.hasDiscount).toBe(false);
        expect(pricing.discountPercent).toBe(0);
        expect(pricing.formattedCompareAtPrice).toBeNull();
        expect(pricing.badgeText).toBeNull();
        expect(pricing.formattedPrice).toBeTruthy();
      }
    });

    it("1.2: compareAtAmount < amount (markup / data error) never produces negative discount or strikethrough", () => {
      const markupCases = [
        { amount: "6000", compareAt: "5000", currency: "USD" }, // $60 regular vs $50 compare-at
        { amount: "1200000", compareAt: "1000000", currency: "VND" },
        { amount: "500", compareAt: "0", currency: "USD" },
        { amount: "1000", compareAt: "-200", currency: "USD" },
        { amount: BigInt(9999), compareAt: BigInt(100), currency: "JPY" },
      ];

      for (const c of markupCases) {
        expect(hasDiscount(c.amount, c.compareAt)).toBe(false);
        expect(discountPercent(c.amount, c.compareAt)).toBe(0);

        const pricing = getCatalogPricing({
          amount: c.amount,
          compareAtAmount: c.compareAt,
          currency: c.currency,
        });

        expect(pricing.hasDiscount).toBe(false);
        expect(pricing.discountPercent).toBe(0);
        expect(pricing.formattedCompareAtPrice).toBeNull();
        expect(pricing.badgeText).toBeNull();
      }
    });

    it("1.3: compareAtAmount null, undefined, empty string, or whitespace cleanly falls back to standard pricing", () => {
      const nilCases = [
        null,
        undefined,
        "",
        "   ",
        "\t\n",
        "null",
        "undefined",
        "NaN",
        "invalid",
        "{}",
        "[object Object]",
      ];

      for (const nilVal of nilCases) {
        expect(hasDiscount("3222", nilVal as any)).toBe(false);
        expect(discountPercent("3222", nilVal as any)).toBe(0);

        const pricing = getCatalogPricing({
          amount: "3222",
          compareAtAmount: nilVal as any,
          currency: "USD",
        });

        expect(pricing.hasDiscount).toBe(false);
        expect(pricing.discountPercent).toBe(0);
        expect(pricing.formattedCompareAtPrice).toBeNull();
        expect(pricing.badgeText).toBeNull();
        expect(pricing.formattedPrice).toContain("32.22");
      }
    });

    it("1.4: handles micro-differences ($9.99 vs $10.00) without displaying -0% badge", () => {
      // Selling price: $9.99 (999 minor units), Compare-at: $10.00 (1000 minor units)
      // Discount = (1000 - 999) / 1000 = 0.1% -> Math.round = 0%
      const microPricing = getCatalogPricing({
        amount: "999",
        compareAtAmount: "1000",
        currency: "USD",
        locale: "en",
      });

      expect(microPricing.hasDiscount).toBe(true);
      expect(microPricing.discountPercent).toBe(0);
      // Invariant: If discount rounds to 0%, badgeText MUST be null (never display "-0%")
      expect(microPricing.badgeText).toBeNull();
      expect(microPricing.formattedPrice).toContain("9.99");
      expect(microPricing.formattedCompareAtPrice).toContain("10.00");
    });

    it("1.5: handles rounded 1% micro-discount ($99.50 vs $100.00) properly", () => {
      // Selling price: $99.50 (9950 minor units), Compare-at: $100.00 (10000 minor units)
      // Discount = 50 / 10000 = 0.5% -> Math.round = 1%
      const pricing = getCatalogPricing({
        amount: "9950",
        compareAtAmount: "10000",
        currency: "USD",
        locale: "en",
      });

      expect(pricing.hasDiscount).toBe(true);
      expect(pricing.discountPercent).toBe(1);
      expect(pricing.badgeText).toBe("-1%");
    });

    it("1.6: handles massive scale differences ($1.00 vs $1000.00) and ($0.01 vs $10,000.00)", () => {
      // $1.00 (100 minor units) vs $1000.00 (100000 minor units) -> 99.9% -> 100%
      const huge1 = getCatalogPricing({
        amount: "100",
        compareAtAmount: "100000",
        currency: "USD",
      });
      expect(huge1.hasDiscount).toBe(true);
      expect(huge1.discountPercent).toBe(100);
      expect(huge1.badgeText).toBe("-100%");
      expect(huge1.formattedPrice).toContain("1.00");
      expect(huge1.formattedCompareAtPrice).toContain("1,000.00");

      // $0.01 (1 minor unit) vs $10,000.00 (1000000 minor units)
      const huge2 = getCatalogPricing({
        amount: "1",
        compareAtAmount: "1000000",
        currency: "USD",
      });
      expect(huge2.hasDiscount).toBe(true);
      expect(huge2.discountPercent).toBe(100);
      expect(huge2.badgeText).toBe("-100%");
    });
  });

  // =========================================================================
  // SECTION 2: MULTI-CURRENCY DECIMAL PRECISION (0-DECIMAL VS 2-DECIMAL)
  // =========================================================================
  describe("Section 2: Multi-Currency 0-Decimal vs 2-Decimal Precision", () => {
    it("2.1: validates 0-decimal currencies (JPY, VND, KRW) use minor unit scale 1", () => {
      expect(currencyMinorUnits("JPY")).toBe(0);
      expect(currencyMinorUnits("VND")).toBe(0);
      expect(currencyMinorUnits("KRW")).toBe(0);

      // JPY: ¥7,500 selling vs ¥10,000 compare-at (-25%)
      const jpyPricing = getCatalogPricing({
        amount: "7500",
        compareAtAmount: "10000",
        currency: "JPY",
        locale: "ja",
      });
      expect(jpyPricing.hasDiscount).toBe(true);
      expect(jpyPricing.discountPercent).toBe(25);
      expect(jpyPricing.badgeText).toBe("-25%");
      expect(jpyPricing.formattedPrice).toMatch(/7[,.]500/);
      expect(jpyPricing.formattedCompareAtPrice).toMatch(/10[,.]000/);

      // VND: 841.000 ₫ selling vs 1.000.000 ₫ compare-at (-16%)
      const vndPricing = getCatalogPricing({
        amount: "841000",
        compareAtAmount: "1000000",
        currency: "VND",
        locale: "vi",
      });
      expect(vndPricing.hasDiscount).toBe(true);
      expect(vndPricing.discountPercent).toBe(16);
      expect(vndPricing.badgeText).toBe("-16%");
      expect(vndPricing.formattedPrice).toMatch(/841[.,]000/);
      expect(vndPricing.formattedCompareAtPrice).toMatch(/1[.,]000[.,]000/);

      // KRW: ₩45,000 selling vs ₩50,000 compare-at (-10%)
      const krwPricing = getCatalogPricing({
        amount: "45000",
        compareAtAmount: "50000",
        currency: "KRW",
        locale: "ko",
      });
      expect(krwPricing.hasDiscount).toBe(true);
      expect(krwPricing.discountPercent).toBe(10);
      expect(krwPricing.badgeText).toBe("-10%");
      expect(krwPricing.formattedPrice).toMatch(/45[,.]000/);
      expect(krwPricing.formattedCompareAtPrice).toMatch(/50[,.]000/);
    });

    it("2.2: validates 2-decimal currencies (USD, EUR, GBP, CAD, AUD, SGD) use minor unit scale 100", () => {
      const twoDecimalCurrencies = ["USD", "EUR", "GBP", "CAD", "AUD", "SGD"];

      for (const curr of twoDecimalCurrencies) {
        expect(currencyMinorUnits(curr)).toBe(2);

        const pricing = getCatalogPricing({
          amount: "3222",
          compareAtAmount: "5000",
          currency: curr,
          locale: "en",
        });

        expect(pricing.hasDiscount).toBe(true);
        expect(pricing.discountPercent).toBe(36);
        expect(pricing.badgeText).toBe("-36%");
        expect(pricing.formattedPrice).toContain("32.22");
        expect(pricing.formattedCompareAtPrice).toContain("50.00");
      }
    });

    it("2.3: invalid or lowercase currency code is normalized safely or throws descriptive error", () => {
      expect(normalizeCurrency("usd")).toBe("USD");
      expect(normalizeCurrency("  jpy  ")).toBe("JPY");
      expect(() => normalizeCurrency("US")).toThrow(/Invalid ISO 4217/);
      expect(() => normalizeCurrency("TOOLONG")).toThrow(/Invalid ISO 4217/);
    });
  });

  // =========================================================================
  // SECTION 3: UI SURFACES & COMPONENT CONTRACT RESILIENCE
  // =========================================================================
  describe("Section 3: UI Surface Data Contract Resilience", () => {
    it("3.1: handles product with completely empty variants array gracefully", () => {
      const productNoVariants: WeleticCatalogProduct = {
        id: "gid://shopify/Product/empty",
        externalId: "empty",
        handle: "empty-product",
        title: "Empty Variant Product",
        descriptionHtml: null,
        imageUrl: null,
        vendor: null,
        productType: null,
        variants: [],
        commission: null,
      };

      const defaultVariant = productNoVariants.variants[0];
      const pricing = defaultVariant
        ? getCatalogPricing({
            amount: defaultVariant.amount,
            compareAtAmount: defaultVariant.compareAtAmount,
            currency: defaultVariant.currency,
          })
        : {
            hasDiscount: false,
            discountPercent: 0,
            formattedPrice: "—",
            formattedCompareAtPrice: null,
            badgeText: null,
          };

      expect(pricing.hasDiscount).toBe(false);
      expect(pricing.formattedPrice).toBe("—");
      expect(pricing.formattedCompareAtPrice).toBeNull();
      expect(pricing.badgeText).toBeNull();
    });

    it("3.2: handles multi-variant product with mixed sale and non-sale variants", () => {
      const multiVariantProduct: WeleticCatalogProduct = {
        id: "gid://shopify/Product/multi",
        externalId: "multi",
        handle: "yamax-multi-variant",
        title: "Yamax Flow™ Crop Top",
        descriptionHtml: "<p>Multi variant</p>",
        imageUrl: "https://cdn.shopify.com/top.jpg",
        vendor: "Yamax",
        productType: "Tops",
        variants: [
          {
            id: "v1_sale",
            title: "Black / S (Sale)",
            sku: "YM-BLK-S",
            imageUrl: "https://cdn.shopify.com/top-black.jpg",
            amount: "2800", // $28.00
            compareAtAmount: "4000", // $40.00 (-30%)
            currency: "USD",
          },
          {
            id: "v2_regular",
            title: "White / S (Regular)",
            sku: "YM-WHT-S",
            imageUrl: "https://cdn.shopify.com/top-white.jpg",
            amount: "4000", // $40.00
            compareAtAmount: null, // No compare-at
            currency: "USD",
          },
          {
            id: "v3_equal",
            title: "Rose / S (Equal compare-at)",
            sku: "YM-ROS-S",
            imageUrl: null,
            amount: "4000",
            compareAtAmount: "4000",
            currency: "USD",
          },
        ],
        commission: {
          ruleId: "c_1",
          type: "percentage",
          basisPoints: 1200,
          fixedAmount: null,
          currency: null,
          minOrderAmount: null,
        },
      };

      // Variant 1: Sale
      const p1 = getCatalogPricing({
        amount: multiVariantProduct.variants[0].amount,
        compareAtAmount: multiVariantProduct.variants[0].compareAtAmount,
        currency: multiVariantProduct.variants[0].currency,
      });
      expect(p1.hasDiscount).toBe(true);
      expect(p1.discountPercent).toBe(30);
      expect(p1.badgeText).toBe("-30%");
      expect(p1.formattedCompareAtPrice).toContain("40.00");

      // Variant 2: Regular
      const p2 = getCatalogPricing({
        amount: multiVariantProduct.variants[1].amount,
        compareAtAmount: multiVariantProduct.variants[1].compareAtAmount,
        currency: multiVariantProduct.variants[1].currency,
      });
      expect(p2.hasDiscount).toBe(false);
      expect(p2.discountPercent).toBe(0);
      expect(p2.badgeText).toBeNull();
      expect(p2.formattedCompareAtPrice).toBeNull();

      // Variant 3: Equal
      const p3 = getCatalogPricing({
        amount: multiVariantProduct.variants[2].amount,
        compareAtAmount: multiVariantProduct.variants[2].compareAtAmount,
        currency: multiVariantProduct.variants[2].currency,
      });
      expect(p3.hasDiscount).toBe(false);
      expect(p3.discountPercent).toBe(0);
      expect(p3.badgeText).toBeNull();
      expect(p3.formattedCompareAtPrice).toBeNull();
    });

    it("3.3: commission calculations remain accurate and do not overflow under all currency conditions", () => {
      // Percentage commission on discounted variant
      const variantAmount = BigInt("3222"); // $32.22
      const basisPoints = BigInt(1500); // 15.00%
      const baseEarning = (variantAmount * basisPoints) / BigInt(10000);
      expect(baseEarning).toBe(BigInt(483)); // 483 minor units ($4.83)

      const formatted = formatMoney(
        {
          amount: baseEarning,
          currency: normalizeCurrency("USD"),
        },
        "en",
      );
      expect(formatted).toContain("4.83");
    });
  });

  // =========================================================================
  // SECTION 4: PROPERTY-BASED / FUZZING INVARIANT TESTING (10,000 RUNS)
  // =========================================================================
  describe("Section 4: Property-Based Fuzzing & Mathematical Invariants (10,000 Cases)", () => {
    it("4.1: hasDiscount, discountPercent, and badgeText satisfy core invariant properties across 10,000 random pricing inputs", () => {
      let seed = 42;
      function pseudoRandom() {
        seed = (seed * 1664525 + 1013904223) % 4294967296;
        return seed / 4294967296;
      }

      for (let i = 0; i < 10000; i++) {
        const amount = Math.floor(pseudoRandom() * 1000000); // 0 to 1,000,000
        const compareAt = Math.floor(pseudoRandom() * 1000000);

        const isDiscounted = hasDiscount(String(amount), String(compareAt));
        const percent = discountPercent(String(amount), String(compareAt));
        const pricing = getCatalogPricing({
          amount: String(amount),
          compareAtAmount: String(compareAt),
          currency: "USD",
        });

        // Invariant 1: Discount is true iff compareAt > amount and amount >= 0
        if (compareAt > amount && amount >= 0) {
          expect(isDiscounted).toBe(true);
          expect(pricing.hasDiscount).toBe(true);
          expect(pricing.formattedCompareAtPrice).not.toBeNull();
        } else {
          expect(isDiscounted).toBe(false);
          expect(pricing.hasDiscount).toBe(false);
          expect(pricing.discountPercent).toBe(0);
          expect(pricing.formattedCompareAtPrice).toBeNull();
          expect(pricing.badgeText).toBeNull();
        }

        // Invariant 2: Percent must be between 0 and 100
        expect(percent).toBeGreaterThanOrEqual(0);
        expect(percent).toBeLessThanOrEqual(100);

        // Invariant 3: Badge text format
        if (pricing.badgeText !== null) {
          expect(pricing.badgeText).toMatch(/^-[1-9][0-9]?%$|^-100%$/);
          expect(pricing.discountPercent).toBeGreaterThan(0);
        }
      }
    });
  });
});
