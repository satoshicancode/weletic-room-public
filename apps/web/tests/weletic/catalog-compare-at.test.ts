import type {
  WeleticCatalogProduct,
  WeleticCatalogVariant,
} from "@/lib/swr/use-weletic-products";
import {
  discountPercent,
  formatCatalogPrice,
  formatCompareAtPrice,
  getCatalogPricing,
  hasDiscount,
} from "@/lib/weletic/money";
import { describe, expect, it } from "vitest";

describe("Catalog Compare-At Strikethrough Pricing & Sale Badges Suite", () => {
  describe("1. Discount Detection (hasDiscount)", () => {
    it("returns true when compareAtAmount is strictly greater than amount", () => {
      expect(hasDiscount("3222", "5000")).toBe(true);
      expect(hasDiscount(BigInt(841000), BigInt(1000000))).toBe(true);
      expect(hasDiscount(1500, 2000)).toBe(true);
    });

    it("returns false when compareAtAmount is null, undefined, or empty", () => {
      expect(hasDiscount("3222", null)).toBe(false);
      expect(hasDiscount("3222", undefined)).toBe(false);
      expect(hasDiscount("3222", "")).toBe(false);
      expect(hasDiscount(null, "5000")).toBe(false);
      expect(hasDiscount(undefined, "5000")).toBe(false);
    });

    it("returns false when compareAtAmount is less than or equal to amount", () => {
      expect(hasDiscount("5000", "5000")).toBe(false);
      expect(hasDiscount("6000", "5000")).toBe(false);
      expect(hasDiscount(BigInt(1000), BigInt(1000))).toBe(false);
      expect(hasDiscount(BigInt(2000), BigInt(1000))).toBe(false);
    });

    it("returns false for zero, negative, or invalid amounts", () => {
      expect(hasDiscount("1000", "0")).toBe(false);
      expect(hasDiscount("1000", "-500")).toBe(false);
      expect(hasDiscount("-100", "500")).toBe(false);
      expect(hasDiscount("invalid", "5000")).toBe(false);
      expect(hasDiscount("1000", "invalid")).toBe(false);
    });
  });

  describe("2. Discount Percentage Calculation (discountPercent)", () => {
    it("accurately calculates rounded integer discount percentages", () => {
      // 50.00 -> 32.22: (5000 - 3222) / 5000 = 1778 / 5000 = 35.56% -> 36%
      expect(discountPercent("3222", "5000")).toBe(36);

      // 100.00 -> 65.00: (10000 - 6500) / 10000 = 35%
      expect(discountPercent("6500", "10000")).toBe(35);

      // 1,000,000 VND -> 841,000 VND: (1000000 - 841000) / 1000000 = 159000 / 1000000 = 15.9% -> 16%
      expect(discountPercent("841000", "1000000")).toBe(16);

      // 10,000 JPY -> 7,500 JPY: 25%
      expect(discountPercent("7500", "10000")).toBe(25);
    });

    it("returns 0 for non-discounted or edge case pricing", () => {
      expect(discountPercent("5000", "5000")).toBe(0);
      expect(discountPercent("6000", "5000")).toBe(0);
      expect(discountPercent("5000", null)).toBe(0);
      expect(discountPercent("5000", undefined)).toBe(0);
      expect(discountPercent("5000", "0")).toBe(0);
      expect(discountPercent("5000", "-100")).toBe(0);
    });
  });

  describe("3. Multi-Currency Price Formatting", () => {
    it("formats 2-decimal currencies (USD, EUR) with minor unit divisor 100", () => {
      const formattedUsd = formatCatalogPrice("3222", "USD", "en");
      expect(formattedUsd).toContain("32.22");

      const compareAtUsd = formatCompareAtPrice("5000", "USD", "en");
      expect(compareAtUsd).toContain("50.00");
    });

    it("formats 0-decimal currencies (VND, JPY) with minor unit divisor 1", () => {
      const formattedVnd = formatCatalogPrice("841000", "VND", "vi");
      // 841.000 ₫ in Vietnamese locale
      expect(formattedVnd).toMatch(/841[.,]000/);

      const compareAtVnd = formatCompareAtPrice("1000000", "VND", "vi");
      expect(compareAtVnd).toMatch(/1[.,]000[.,]000/);

      const formattedJpy = formatCatalogPrice("5000", "JPY", "ja");
      expect(formattedJpy).toMatch(/5[,.]000/);
    });

    it("handles null/missing compare-at formatting gracefully", () => {
      expect(formatCompareAtPrice(null, "USD")).toBeNull();
      expect(formatCompareAtPrice(undefined, "USD")).toBeNull();
      expect(formatCompareAtPrice("", "USD")).toBeNull();
    });
  });

  describe("4. Composite Catalog Pricing (getCatalogPricing)", () => {
    it("returns full promotional bundle with strikethrough price and badge when discounted", () => {
      const pricing = getCatalogPricing({
        amount: "3222",
        compareAtAmount: "5000",
        currency: "USD",
        locale: "en",
      });

      expect(pricing.hasDiscount).toBe(true);
      expect(pricing.discountPercent).toBe(36);
      expect(pricing.badgeText).toBe("-36%");
      expect(pricing.formattedPrice).toContain("32.22");
      expect(pricing.formattedCompareAtPrice).toContain("50.00");
    });

    it("returns clean standard pricing when not discounted", () => {
      const pricing = getCatalogPricing({
        amount: "5000",
        compareAtAmount: null,
        currency: "USD",
        locale: "en",
      });

      expect(pricing.hasDiscount).toBe(false);
      expect(pricing.discountPercent).toBe(0);
      expect(pricing.badgeText).toBeNull();
      expect(pricing.formattedPrice).toContain("50.00");
      expect(pricing.formattedCompareAtPrice).toBeNull();
    });

    it("returns clean standard pricing when compare-at is lower or equal to selling price", () => {
      const pricing = getCatalogPricing({
        amount: "5000",
        compareAtAmount: "4000",
        currency: "USD",
        locale: "en",
      });

      expect(pricing.hasDiscount).toBe(false);
      expect(pricing.discountPercent).toBe(0);
      expect(pricing.badgeText).toBeNull();
      expect(pricing.formattedCompareAtPrice).toBeNull();
    });

    it("processes 0-decimal VND promotional pricing correctly", () => {
      const pricing = getCatalogPricing({
        amount: "841000",
        compareAtAmount: "1000000",
        currency: "VND",
        locale: "vi",
      });

      expect(pricing.hasDiscount).toBe(true);
      expect(pricing.discountPercent).toBe(16);
      expect(pricing.badgeText).toBe("-16%");
      expect(pricing.formattedPrice).toMatch(/841[.,]000/);
      expect(pricing.formattedCompareAtPrice).toMatch(/1[.,]000[.,]000/);
    });
  });

  describe("5. TypeScript Type Conformance & Model Invariants", () => {
    it("supports WeleticCatalogVariant and WeleticCatalogProduct structures", () => {
      const variant: WeleticCatalogVariant = {
        id: "gid://shopify/ProductVariant/101",
        title: "Default Title",
        sku: "SKU-101",
        imageUrl: "https://cdn.shopify.com/image.jpg",
        amount: "3222",
        compareAtAmount: "5000",
        currency: "USD",
      };

      const product: WeleticCatalogProduct = {
        id: "gid://shopify/Product/1",
        externalId: "1",
        handle: "yamax-leggings",
        title: "Yamax Agile™ High Support Leggings",
        descriptionHtml: "<p>Premium activewear</p>",
        imageUrl: "https://cdn.shopify.com/image.jpg",
        vendor: "Yamax",
        productType: "Leggings",
        variants: [variant],
        commission: {
          ruleId: "comm_1",
          type: "percentage",
          basisPoints: 1500,
          fixedAmount: null,
          currency: null,
          minOrderAmount: null,
        },
      };

      expect(product.variants).toHaveLength(1);
      expect(product.variants[0].compareAtAmount).toBe("5000");

      const pricing = getCatalogPricing({
        amount: product.variants[0].amount,
        compareAtAmount: product.variants[0].compareAtAmount,
        currency: product.variants[0].currency,
      });

      expect(pricing.hasDiscount).toBe(true);
      expect(pricing.badgeText).toBe("-36%");
    });
  });
});
