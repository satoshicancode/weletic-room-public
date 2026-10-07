import { describe, expect, it } from "vitest";
import {
  DEFAULT_YAMAX_ACCORDIONS,
  DEFAULT_YAMAX_HERO,
  YAMAX_UNDER_CHECKOUT,
  generateYamaxHeroHtml,
  generateYamaxMaterialCareHtml,
  generateYamaxSizeGuideHtml,
  validateYamaxSupplierSizeRun,
  type YamaxSupplierVariant,
} from "../../ui/weletic/yamax-product-description-editor";

describe("Yamax Shopify Product Description Standards & Size Run Integrity", () => {
  describe("1. Supplier Size Run Completeness Validation", () => {
    it("approves colors having full size runs (S, M, L, XL)", () => {
      const variants: YamaxSupplierVariant[] = [
        { color: "Midnight Black", size: "S", inStock: true },
        { color: "Midnight Black", size: "M", inStock: true },
        { color: "Midnight Black", size: "L", inStock: true },
        { color: "Midnight Black", size: "XL", inStock: true },
        { color: "Sage Green", size: "S", inStock: true },
        { color: "Sage Green", size: "M", inStock: true },
        { color: "Sage Green", size: "L", inStock: true },
        { color: "Sage Green", size: "XL", inStock: true },
      ];

      const result = validateYamaxSupplierSizeRun(variants);
      expect(result.valid).toBe(true);
      expect(result.discontinuedColors).toHaveLength(0);
      expect(result.eligibleVariants).toHaveLength(8);
      expect(result.colorStatus["Midnight Black"].complete).toBe(true);
      expect(result.colorStatus["Sage Green"].complete).toBe(true);
    });

    it("detects discontinued colors when any size is missing/sold out", () => {
      const variants: YamaxSupplierVariant[] = [
        // Midnight Black is missing S
        { color: "Midnight Black", size: "M", inStock: true },
        { color: "Midnight Black", size: "L", inStock: true },
        { color: "Midnight Black", size: "XL", inStock: true },
        // Sage Green is complete
        { color: "Sage Green", size: "S", inStock: true },
        { color: "Sage Green", size: "M", inStock: true },
        { color: "Sage Green", size: "L", inStock: true },
        { color: "Sage Green", size: "XL", inStock: true },
      ];

      const result = validateYamaxSupplierSizeRun(variants);
      expect(result.valid).toBe(false);
      expect(result.discontinuedColors).toContain("Midnight Black");
      expect(result.colorStatus["Midnight Black"].complete).toBe(false);
      expect(result.colorStatus["Midnight Black"].missingSizes).toEqual(["S"]);
      // Only Sage Green variants are eligible
      expect(result.eligibleVariants).toHaveLength(4);
      expect(
        result.eligibleVariants.every((v) => v.color === "Sage Green"),
      ).toBe(true);
    });

    it("marks out-of-stock sizes as missing", () => {
      const variants: YamaxSupplierVariant[] = [
        { color: "Sky Blue", size: "S", inStock: true },
        { color: "Sky Blue", size: "M", inStock: true },
        { color: "Sky Blue", size: "L", inStock: false }, // out of stock
        { color: "Sky Blue", size: "XL", inStock: true },
      ];

      const result = validateYamaxSupplierSizeRun(variants);
      expect(result.valid).toBe(false);
      expect(result.discontinuedColors).toContain("Sky Blue");
      expect(result.colorStatus["Sky Blue"].missingSizes).toEqual(["L"]);
      expect(result.eligibleVariants).toHaveLength(0);
    });
  });

  describe("2. Under-Checkout Tabs Standards", () => {
    it("defines exact standard shipping and return texts", () => {
      expect(YAMAX_UNDER_CHECKOUT.shippingAndDelivery).toBe(
        "Free shipping on orders over ¥6,000. For orders under ¥6,000, a flat shipping rate of ¥800 applies. Delivered via air cargo in 3–7 business days with end-to-end tracking.",
      );
      expect(YAMAX_UNDER_CHECKOUT.easyReturns).toBe(
        "We stand behind our craftsmanship. We accept returns within 30 days of delivery for any manufacturing or quality defects. Please ensure items are unworn and in original packaging.",
      );
    });
  });

  describe("3. HTML Generation Standards", () => {
    it("generates hero section with tagline and 3 strong bullet points", () => {
      const html = generateYamaxHeroHtml(DEFAULT_YAMAX_HERO);
      expect(html).toContain(`<p>${DEFAULT_YAMAX_HERO.tagline}</p>`);
      expect(html).toContain("<ul>");
      expect(html).toContain(
        `<li><strong>${DEFAULT_YAMAX_HERO.bullet1Title}</strong>: ${DEFAULT_YAMAX_HERO.bullet1Desc}</li>`,
      );
      expect(html).toContain(
        `<li><strong>${DEFAULT_YAMAX_HERO.bullet2Title}</strong>: ${DEFAULT_YAMAX_HERO.bullet2Desc}</li>`,
      );
      expect(html).toContain(
        `<li><strong>${DEFAULT_YAMAX_HERO.bullet3Title}</strong>: ${DEFAULT_YAMAX_HERO.bullet3Desc}</li>`,
      );
    });

    it("generates size guide with sticky first column and responsive overflow wrapper", () => {
      const html = generateYamaxSizeGuideHtml(DEFAULT_YAMAX_ACCORDIONS.fitTip);
      expect(html).toContain(
        `<strong>Fit Tip:</strong> ${DEFAULT_YAMAX_ACCORDIONS.fitTip}`,
      );
      expect(html).toContain("overflow-x: auto; max-width: 100%");
      expect(html).toContain(
        "position: sticky; left: 0px; background-color: rgb(249, 249, 249); z-index: 1;",
      );
      expect(html).toContain(
        "position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;",
      );
      expect(html).toContain('href="/pages/contact"');
    });

    it("generates Material & Care without nested lists (flat structure)", () => {
      const html = generateYamaxMaterialCareHtml(DEFAULT_YAMAX_ACCORDIONS);
      expect(html).toContain(
        "60% Premium Nylon, 40% Spandex (Yenergy™ Series)",
      );
      expect(html).toContain("190g");
      expect(html).toContain("<li><strong>Wash:</strong>");
      expect(html).toContain("<li><strong>Dry:</strong>");
      expect(html).toContain("<li><strong>Care:</strong>");
      // Critical check: ensure no nested <ul> within <li>
      expect(html).not.toMatch(/<li>[^<]*<ul>/);
    });
  });
});
