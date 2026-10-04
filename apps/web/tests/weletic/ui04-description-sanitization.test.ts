import {
  ALLOWED_CSS_PROPERTIES,
  ALLOWED_PRODUCT_DESCRIPTION_TAGS,
  sanitizeProductDescriptionHtml,
} from "@/lib/weletic/html-sanitizer";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// Mock auth and dependencies for API route testing
vi.mock("@/lib/auth/partner", () => ({
  withPartnerProfile: (handler: any) => {
    return async (req: NextRequest, ctx: { params?: Promise<Record<string, string>> }) => {
      const params = (await ctx?.params) || {};
      const url = new URL(req.url, "http://localhost");
      const searchParams = Object.fromEntries(url.searchParams.entries());
      return handler({
        req,
        params,
        searchParams,
        partner: { id: "partner_test_123" },
        session: {},
        partnerUser: { userId: "user_123", role: "member" },
      });
    };
  },
}));

const mockProductWithXss = {
  id: "prod_xss_123",
  externalId: "shopify_prod_999",
  handle: "yamax-agile-leggings",
  title: "Yamax Agile™ High Support Leggings",
  descriptionHtml: `<p>Find the perfect balance of weightless freedom and high-impact support.</p>
<script>alert("stored-xss")</script>
<img src="x" onerror="alert(document.cookie)">
<svg onload="alert('svg-xss')"><circle r="10"/></svg>
<a href="javascript:stealTokens()">Malicious Link</a>
<div onclick="alert('click-xss')">Clickable Container</div>
<iframe src="https://evil-attacker.com/exploit"></iframe>
<object data="https://evil-attacker.com/exploit.swf"></object>
<embed src="https://evil-attacker.com/exploit.swf">`,
  featuredImageUrl: "https://example.com/yamax-leggings.jpg",
  vendor: "Yamax",
  productType: "Leggings",
  collectionExternalIds: [],
  tags: ["leggings", "yenergy"],
  translations: [],
  variants: [
    {
      id: "var_123",
      externalId: "var_ext_123",
      title: "Black / S",
      sku: "YMX-AGL-BLK-S",
      imageUrl: null,
      shopPrice: BigInt(8800),
      shopCompareAtPrice: BigInt(11000),
      shopCurrency: "USD",
      availableForSale: true,
      marketPrices: [],
      createdAt: new Date(),
    },
  ],
};

const mockEnrollment = {
  id: "enr_123",
  partnerId: "partner_test_123",
  programId: "prog_123",
  program: {
    id: "prog_123",
    accountingCurrency: "USD",
  },
  links: [],
  partnerGroup: null,
};

vi.mock("@/lib/api/programs/get-program-enrollment-or-throw", () => ({
  getProgramEnrollmentOrThrow: vi.fn(async () => mockEnrollment),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyProduct: {
      findFirst: vi.fn(async () => mockProductWithXss),
      findMany: vi.fn(async () => [mockProductWithXss]),
      count: vi.fn(async () => 1),
    },
    weleticShopifyMarket: {
      findMany: vi.fn(async () => []),
    },
    weleticCommissionRule: {
      findMany: vi.fn(async () => []),
    },
  },
}));

// Import routes after mocks are configured
import { GET as getSingleProduct } from "../../app/(ee)/api/partner-profile/programs/[programId]/products/[productId]/route";
import { GET as getProductsList } from "../../app/(ee)/api/partner-profile/programs/[programId]/products/route";

describe("Milestone M2: UI-04 Product Description Sanitization Suite", () => {
  describe("Test Case 1: Malicious XSS Payload Neutralization", () => {
    it("strips executable <script> tags completely", () => {
      const payload = `<p>Introduction</p><script>alert("xss")</script><script src="https://evil.com/payload.js"></script>`;
      const cleaned = sanitizeProductDescriptionHtml(payload);
      expect(cleaned).not.toContain("<script>");
      expect(cleaned).not.toContain("alert(");
      expect(cleaned).not.toContain("evil.com");
      expect(cleaned).toContain("<p>Introduction</p>");
    });

    it("strips event handlers (onerror, onload, onclick, onmouseover)", () => {
      const payload = `<div onclick="alert(1)" onmouseover="steal()"><img src="x" onerror="alert('onerror')"><svg onload="alert('svg')">test</svg></div>`;
      const cleaned = sanitizeProductDescriptionHtml(payload);
      expect(cleaned).not.toContain("onclick");
      expect(cleaned).not.toContain("onmouseover");
      expect(cleaned).not.toContain("onerror");
      expect(cleaned).not.toContain("onload");
      expect(cleaned).not.toContain("<img");
      expect(cleaned).not.toContain("<svg");
      expect(cleaned).toContain("<div>");
    });

    it("strips dangerous URI schemes (javascript:, data:, vbscript:) on links", () => {
      const payload = `
        <a href="javascript:alert(1)">JS Link</a>
        <a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Data Link</a>
        <a href="vbscript:msgbox(1)">VBScript Link</a>
        <a href="//evil.com/phishing">Protocol Relative</a>
      `;
      const cleaned = sanitizeProductDescriptionHtml(payload);
      expect(cleaned).not.toContain("javascript:");
      expect(cleaned).not.toContain("data:");
      expect(cleaned).not.toContain("vbscript:");
      expect(cleaned).not.toContain("//evil.com");
      // Anchor tags remain, but dangerous href attributes are completely removed
      expect(cleaned).toContain("JS Link");
      expect(cleaned).toContain("Data Link");
    });

    it("strips dangerous embedding tags (<iframe, <object, <embed>)", () => {
      const payload = `
        <iframe src="https://evil.com/embed"></iframe>
        <object data="malicious.swf"></object>
        <embed src="malicious.swf">
      `;
      const cleaned = sanitizeProductDescriptionHtml(payload);
      expect(cleaned).not.toContain("<iframe");
      expect(cleaned).not.toContain("<object");
      expect(cleaned).not.toContain("<embed");
    });

    it("strips malicious CSS expressions and javascript: URLs in inline styles", () => {
      const payload = `
        <div style="background-image: url(javascript:alert(1)); position: sticky; color: red;">Test</div>
        <div style="behavior: url(xss.htc); width: 100%;">HTC Test</div>
        <div style="expression: alert(1); border: 1px solid black;">Expression Test</div>
      `;
      const cleaned = sanitizeProductDescriptionHtml(payload);
      expect(cleaned).not.toContain("javascript:alert(1)");
      expect(cleaned).not.toContain("behavior");
      expect(cleaned).not.toContain("expression");
      // Safe CSS properties should be preserved
      expect(cleaned).toContain("position:sticky");
      expect(cleaned).toContain("color:red");
      expect(cleaned).toContain("width:100%");
      expect(cleaned).toContain("border:1px solid black");
    });

    it("handles null, undefined, empty, and whitespace strings gracefully", () => {
      expect(sanitizeProductDescriptionHtml(null)).toBe("");
      expect(sanitizeProductDescriptionHtml(undefined)).toBe("");
      expect(sanitizeProductDescriptionHtml("")).toBe("");
      expect(sanitizeProductDescriptionHtml("   \n\t  ")).toBe("");
    });
  });

  describe("Test Case 2: Yamax Activewear Standard Formatting Preservation", () => {
    it("preserves Yamax Hero tagline and bulleted feature list", () => {
      const yamaxHero = `<p>Find the perfect balance of weightless freedom and high-impact support. Engineered with our ultra-thin Yenergy™ fabric and 40% Spandex to contour your body while keeping you cool and dry.</p>
<ul>
  <li><strong>Non-Slip Waistband</strong>: High-tension composite waist design that gently compresses the tummy and stays securely in place without sliding down.</li>
  <li><strong>Flattering Glute Contours</strong>: Elegant curved back seams designed to naturally lift, shape, and enhance your silhouette.</li>
  <li><strong>Second-Skin Support</strong>: Ultra-lightweight Yenergy™ fabric with 40% high-stretch Spandex delivers high-impact hold with a weightless feel.</li>
</ul>`;

      const cleaned = sanitizeProductDescriptionHtml(yamaxHero);
      expect(cleaned).toContain("<p>Find the perfect balance");
      expect(cleaned).toContain("<ul>");
      expect(cleaned).toContain("<li><strong>Non-Slip Waistband</strong>:");
      expect(cleaned).toContain("<li><strong>Flattering Glute Contours</strong>:");
      expect(cleaned).toContain("<li><strong>Second-Skin Support</strong>:");
      expect(cleaned).toContain("Yenergy™");
    });

    it("preserves Yamax responsive Size Guide table with sticky columns and scroll wrapper", () => {
      const yamaxSizeGuide = `<p><strong>Fit Tip:</strong> Fits true to size. If you are between sizes, we recommend sizing up for a more comfortable fit (all-day wear), or sizing down for extra compression (best for high-impact running).</p>
<div style="overflow-x: auto; max-width: 100%; position: relative;">
  <table style="width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; text-align: center;">
    <thead>
      <tr style="border-bottom: 2px solid rgb(229, 229, 229); background-color: rgb(249, 249, 249);">
        <th style="padding: 10px; font-weight: 600; position: sticky; left: 0px; background-color: rgb(249, 249, 249); z-index: 1;">Size</th>
        <th style="padding: 10px; font-weight: 600;">Length</th>
        <th style="padding: 10px; font-weight: 600;">Flat Waist</th>
        <th style="padding: 10px; font-weight: 600;">Flat Hips</th>
        <th style="padding: 10px; font-weight: 600;">Recommended Waist</th>
        <th style="padding: 10px; font-weight: 600;">Recommended Hips</th>
      </tr>
    </thead>
    <tbody>
      <tr style="border-bottom: 1px solid rgb(234, 234, 234);">
        <td style="padding: 10px; font-weight: bold; position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;">S</td>
        <td style="padding: 10px;">84 cm</td>
        <td style="padding: 10px;">25 cm</td>
        <td style="padding: 10px;">33 cm</td>
        <td style="padding: 10px;">58 – 64 cm</td>
        <td style="padding: 10px;">80 – 86 cm</td>
      </tr>
    </tbody>
  </table>
</div>
<p>Need help? <a href="/pages/contact">Contact us</a> and we'll be happy to assist.</p>`;

      const cleaned = sanitizeProductDescriptionHtml(yamaxSizeGuide);

      // Verify wrapper styles preserved
      expect(cleaned).toContain("overflow-x:auto");
      expect(cleaned).toContain("max-width:100%");
      expect(cleaned).toContain("position:relative");

      // Verify table styles preserved
      expect(cleaned).toContain("width:100%");
      expect(cleaned).toContain("border-collapse:collapse");
      expect(cleaned).toContain("text-align:center");

      // Verify sticky header and cell styles preserved
      expect(cleaned).toContain("position:sticky");
      expect(cleaned).toContain("left:0px");
      expect(cleaned).toContain("z-index:1");
      expect(cleaned).toContain("background-color:rgb(249, 249, 249)");
      expect(cleaned).toContain("background-color:rgb(255, 255, 255)");

      // Verify safe relative link preserved and augmented with security rel
      expect(cleaned).toContain('href="/pages/contact"');
      expect(cleaned).toContain('rel="noopener noreferrer"');
    });

    it("automatically adds rel='noopener noreferrer' to external links", () => {
      const linkHtml = `<p>Visit <a href="https://yamax.com/pages/about" target="_blank">Yamax</a> for details.</p>`;
      const cleaned = sanitizeProductDescriptionHtml(linkHtml);
      expect(cleaned).toContain('href="https://yamax.com/pages/about"');
      expect(cleaned).toContain('rel="noopener noreferrer"');
      expect(cleaned).toContain('target="_blank"');
    });
  });

  describe("Test Case 3: API Route Protection Against Stored XSS", () => {
    it("cleans descriptionHtml in single product API route (/api/partner-profile/programs/[programId]/products/[productId])", async () => {
      const req = new NextRequest(
        "http://localhost/api/partner-profile/programs/prog_123/products/prod_xss_123",
      );
      const res = await getSingleProduct(req, {
        params: Promise.resolve({
          programId: "prog_123",
          productId: "prod_xss_123",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.product).toBeDefined();

      const html = data.product.descriptionHtml;
      // MUST NOT contain any malicious script or payload
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("alert(");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("onerror");
      expect(html).not.toContain("<svg");
      expect(html).not.toContain("onload");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("onclick");
      expect(html).not.toContain("<iframe");
      expect(html).not.toContain("<object");
      expect(html).not.toContain("<embed");

      // MUST preserve safe intro text
      expect(html).toContain(
        "<p>Find the perfect balance of weightless freedom and high-impact support.</p>",
      );
    });

    it("cleans descriptionHtml across products list API route (/api/partner-profile/programs/[programId]/products)", async () => {
      const req = new NextRequest(
        "http://localhost/api/partner-profile/programs/prog_123/products?page=1&pageSize=10",
      );
      const res = await getProductsList(req, {
        params: Promise.resolve({
          programId: "prog_123",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.products).toBeDefined();
      expect(data.products.length).toBeGreaterThan(0);

      const html = data.products[0].descriptionHtml;
      // MUST NOT contain any malicious script or payload
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("alert(");
      expect(html).not.toContain("<img");
      expect(html).not.toContain("onerror");
      expect(html).not.toContain("<svg");
      expect(html).not.toContain("onload");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("onclick");
      expect(html).not.toContain("<iframe");
      expect(html).not.toContain("<object");
      expect(html).not.toContain("<embed");

      // MUST preserve safe intro text
      expect(html).toContain(
        "<p>Find the perfect balance of weightless freedom and high-impact support.</p>",
      );
    });

    it("cleans translation descriptionHtml when translation has stored XSS", async () => {
      const productWithTranslationXss = {
        ...mockProductWithXss,
        translations: [
          {
            id: "trans_ja_1",
            locale: "ja",
            marketId: null,
            title: "ヤマックス レギンス",
            descriptionHtml: "<p>最高のサポート</p><script>alert('ja-xss')</script><a href='javascript:steal()'>Link</a>",
          },
        ],
      };

      const { prisma } = await import("@/lib/prisma");
      vi.mocked(prisma.weleticShopifyProduct.findFirst).mockResolvedValueOnce(
        productWithTranslationXss as any,
      );

      const req = new NextRequest(
        "http://localhost/api/partner-profile/programs/prog_123/products/prod_xss_123?locale=ja",
      );
      const res = await getSingleProduct(req, {
        params: Promise.resolve({
          programId: "prog_123",
          productId: "prod_xss_123",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.product.descriptionHtml).not.toContain("<script>");
      expect(data.product.descriptionHtml).not.toContain("javascript:");
      expect(data.product.descriptionHtml).toContain("<p>最高のサポート</p>");
      expect(data.product.title).toBe("ヤマックス レギンス");
    });
  });

  describe("Test Case 4: UI Redress, Overlay Phishing & CSS Exfiltration Hardening", () => {
    it("strips position: fixed, position: absolute, and extreme z-index styles while preserving safe positioning", () => {
      const fixedOverlayPayload = `<div style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 99999; background-color: #fff;"><a href="https://evil-phishing.com">Click to update account</a></div>`;
      const absoluteOverlayPayload = `<div style="position: absolute; top: -100px; left: 0; z-index: 999; display: block;">Overlay</div>`;
      const safePositionPayload = `<div style="position: sticky; left: 0px; z-index: 1; position: relative;">Safe sticky</div>`;

      const cleanedFixed = sanitizeProductDescriptionHtml(fixedOverlayPayload);
      expect(cleanedFixed).not.toContain("position:fixed");
      expect(cleanedFixed).not.toContain("position");
      expect(cleanedFixed).not.toContain("z-index:99999");
      expect(cleanedFixed).not.toContain("z-index");
      expect(cleanedFixed).toContain('href="https://evil-phishing.com"');

      const cleanedAbsolute = sanitizeProductDescriptionHtml(absoluteOverlayPayload);
      expect(cleanedAbsolute).not.toContain("position:absolute");
      expect(cleanedAbsolute).not.toContain("position");
      expect(cleanedAbsolute).not.toContain("z-index:999");
      expect(cleanedAbsolute).not.toContain("z-index");

      const cleanedSafe = sanitizeProductDescriptionHtml(safePositionPayload);
      expect(cleanedSafe).toContain("position:sticky");
      expect(cleanedSafe).toContain("z-index:1");
      expect(cleanedSafe).toContain("left:0px");
    });

    it("strips class attributes completely to neutralize Tailwind overlay phishing vectors", () => {
      const classOverlayPayload = `<div class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"><p class="text-white text-lg">Phishing Modal</p></div>`;
      const cleaned = sanitizeProductDescriptionHtml(classOverlayPayload);
      expect(cleaned).not.toContain("class=");
      expect(cleaned).not.toContain("fixed");
      expect(cleaned).not.toContain("inset-0");
      expect(cleaned).not.toContain("z-50");
      expect(cleaned).toContain("<div><p>Phishing Modal</p></div>");
    });

    it("strips background shorthand property and blocks outbound asset tracking via image-set() or escaped url()", () => {
      const imageSetPayload = `<div style="background: image-set('https://attacker.com/leak.png' 1x); color: red;">Leak</div>`;
      const backslashUrlPayload = `<div style="background: u\\rl('https://evil.com/leak'); color: blue;">Leak 2</div>`;
      const safeBackgroundColorPayload = `<div style="background-color: rgb(249, 249, 249); color: #333;">Safe Background</div>`;

      const cleanedImageSet = sanitizeProductDescriptionHtml(imageSetPayload);
      expect(cleanedImageSet).not.toContain("background:");
      expect(cleanedImageSet).not.toContain("image-set");
      expect(cleanedImageSet).not.toContain("attacker.com");
      expect(cleanedImageSet).toContain("color:red");

      const cleanedBackslash = sanitizeProductDescriptionHtml(backslashUrlPayload);
      expect(cleanedBackslash).not.toContain("background:");
      expect(cleanedBackslash).not.toContain("evil.com");
      expect(cleanedBackslash).toContain("color:blue");

      const cleanedSafe = sanitizeProductDescriptionHtml(safeBackgroundColorPayload);
      expect(cleanedSafe).toContain("background-color:rgb(249, 249, 249)");
      expect(cleanedSafe).toContain("color:#333");
    });

    it("preserves z-index between 0 and 10 and rejects z-index > 10 or negative z-index", () => {
      expect(sanitizeProductDescriptionHtml(`<div style="z-index: 0;">0</div>`)).toContain("z-index:0");
      expect(sanitizeProductDescriptionHtml(`<div style="z-index: 1;">1</div>`)).toContain("z-index:1");
      expect(sanitizeProductDescriptionHtml(`<div style="z-index: 10;">10</div>`)).toContain("z-index:10");
      expect(sanitizeProductDescriptionHtml(`<div style="z-index: 11;">11</div>`)).not.toContain("z-index");
      expect(sanitizeProductDescriptionHtml(`<div style="z-index: 99999;">99999</div>`)).not.toContain("z-index");
      expect(sanitizeProductDescriptionHtml(`<div style="z-index: -1;">-1</div>`)).not.toContain("z-index");
    });
  });
});
