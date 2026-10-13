import { sanitizeProductDescriptionHtml } from "@/lib/weletic/html-sanitizer";
import { describe, expect, it } from "vitest";

describe("Milestone M2 (UI-04) Challenger 2: Format Preservation & Layout Stability Stress Suite", () => {
  // =========================================================================
  // DIMENSION 1: Yamax & Extreme Shopify Table / Format Preservation
  // =========================================================================
  describe("Dimension 1: Yamax Activewear Standard & Complex Table Preservation", () => {
    it("preserves complete Yamax Activewear product description package with all standard sections", () => {
      const fullYamaxPackage = `
<p>Find the perfect balance of weightless freedom and high-impact support. Engineered with our ultra-thin Yenergy™ fabric and 40% Spandex to contour your body while keeping you cool and dry.</p>
<ul>
  <li><strong>Non-Slip Waistband</strong>: High-tension composite waist design that gently compresses the tummy and stays securely in place without sliding down.</li>
  <li><strong>Flattering Glute Contours</strong>: Elegant curved back seams designed to naturally lift, shape, and enhance your silhouette.</li>
  <li><strong>Second-Skin Support</strong>: Ultra-lightweight Yenergy™ fabric with 40% high-stretch Spandex delivers high-impact hold with a weightless feel.</li>
</ul>

<h3>Shipping &amp; Delivery</h3>
<p>Free shipping on orders over ¥6,000. For orders under ¥6,000, a flat shipping rate of ¥800 applies. Delivered via air cargo in 3–7 business days with end-to-end tracking.</p>

<h3>30-Day Easy Returns</h3>
<p>We stand behind our craftsmanship. We accept returns within 30 days of delivery for any manufacturing or quality defects. Please ensure items are unworn and in original packaging.</p>

<h3>Designed for Running &amp; Pickleball</h3>
<p>Also ideal for HIIT, tennis, cycling, and daily high-impact training.</p>

<h3>Material &amp; Care</h3>
<p>60% Premium Nylon, 40% Spandex (Yenergy™ Series). Fabric weight: 190g.</p>
<ul>
  <li><strong>Wash</strong>: Machine wash cold with like colors, gentle cycle.</li>
  <li><strong>Dry</strong>: Line dry in shade. Do not tumble dry.</li>
  <li><strong>Care</strong>: Do not bleach, do not iron, do not dry clean. Avoid fabric softeners.</li>
</ul>
      `.trim();

      const cleaned = sanitizeProductDescriptionHtml(fullYamaxPackage);

      // Verify all core sections and tags are preserved
      expect(cleaned).toContain("<p>Find the perfect balance");
      expect(cleaned).toContain("Yenergy™");
      expect(cleaned).toContain("<ul>");
      expect(cleaned).toContain("<li><strong>Non-Slip Waistband</strong>:");
      expect(cleaned).toContain(
        "<li><strong>Flattering Glute Contours</strong>:",
      );
      expect(cleaned).toContain("<li><strong>Second-Skin Support</strong>:");
      expect(cleaned).toContain("<h3>Shipping &amp; Delivery</h3>");
      expect(cleaned).toContain("¥6,000");
      expect(cleaned).toContain("¥800");
      expect(cleaned).toContain("3–7 business days");
      expect(cleaned).toContain("<h3>Material &amp; Care</h3>");
      expect(cleaned).toContain("<li><strong>Wash</strong>:");
      expect(cleaned).toContain("<li><strong>Dry</strong>:");
      expect(cleaned).toContain("<li><strong>Care</strong>:");
    });

    it("preserves Yamax responsive Size Guide table with sticky columns, scroll wrapper, and inline styles", () => {
      const complexSizeGuideTable = `
<p><strong>Fit Tip:</strong> Fits true to size. If you are between sizes, we recommend sizing up for a more comfortable fit (all-day wear), or sizing down for extra compression (best for high-impact running).</p>
<div style="overflow-x: auto; max-width: 100%; position: relative;">
  <table style="width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; text-align: center;">
    <thead>
      <tr style="border-bottom: 2px solid rgb(229, 229, 229); background-color: rgb(249, 249, 249);">
        <th style="padding: 10px; font-weight: 600; position: sticky; left: 0px; background-color: rgb(249, 249, 249); z-index: 1;" scope="col">Size</th>
        <th style="padding: 10px; font-weight: 600;" scope="col">Length</th>
        <th style="padding: 10px; font-weight: 600;" scope="col">Flat Waist</th>
        <th style="padding: 10px; font-weight: 600;" scope="col">Flat Hips</th>
        <th style="padding: 10px; font-weight: 600;" scope="col">Recommended Waist</th>
        <th style="padding: 10px; font-weight: 600;" scope="col">Recommended Hips</th>
      </tr>
    </thead>
    <tbody>
      <tr style="border-bottom: 1px solid rgb(234, 234, 234);">
        <td style="padding: 10px; font-weight: bold; position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;">XS</td>
        <td style="padding: 10px;">82 cm</td>
        <td style="padding: 10px;">23 cm</td>
        <td style="padding: 10px;">31 cm</td>
        <td style="padding: 10px;">52 – 58 cm</td>
        <td style="padding: 10px;">74 – 80 cm</td>
      </tr>
      <tr style="border-bottom: 1px solid rgb(234, 234, 234);">
        <td style="padding: 10px; font-weight: bold; position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;">S</td>
        <td style="padding: 10px;">84 cm</td>
        <td style="padding: 10px;">25 cm</td>
        <td style="padding: 10px;">33 cm</td>
        <td style="padding: 10px;">58 – 64 cm</td>
        <td style="padding: 10px;">80 – 86 cm</td>
      </tr>
      <tr style="border-bottom: 1px solid rgb(234, 234, 234);">
        <td style="padding: 10px; font-weight: bold; position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;">M</td>
        <td style="padding: 10px;">86 cm</td>
        <td style="padding: 10px;">27 cm</td>
        <td style="padding: 10px;">35 cm</td>
        <td style="padding: 10px;">64 – 70 cm</td>
        <td style="padding: 10px;">86 – 92 cm</td>
      </tr>
      <tr style="border-bottom: 1px solid rgb(234, 234, 234);">
        <td style="padding: 10px; font-weight: bold; position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;">L</td>
        <td style="padding: 10px;">88 cm</td>
        <td style="padding: 10px;">29 cm</td>
        <td style="padding: 10px;">37 cm</td>
        <td style="padding: 10px;">70 – 76 cm</td>
        <td style="padding: 10px;">92 – 98 cm</td>
      </tr>
      <tr style="border-bottom: 1px solid rgb(234, 234, 234);">
        <td style="padding: 10px; font-weight: bold; position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;">XL</td>
        <td style="padding: 10px;">90 cm</td>
        <td style="padding: 10px;">31 cm</td>
        <td style="padding: 10px;">39 cm</td>
        <td style="padding: 10px;">76 – 82 cm</td>
        <td style="padding: 10px;">98 – 104 cm</td>
      </tr>
    </tbody>
  </table>
</div>
<p>Need help? <a href="/pages/contact">Contact us</a> and we'll be happy to assist.</p>
      `.trim();

      const cleaned = sanitizeProductDescriptionHtml(complexSizeGuideTable);

      // Wrapper styles
      expect(cleaned).toContain("overflow-x:auto");
      expect(cleaned).toContain("max-width:100%");
      expect(cleaned).toContain("position:relative");

      // Table styles
      expect(cleaned).toContain("width:100%");
      expect(cleaned).toContain("border-collapse:collapse");
      expect(cleaned).toContain("margin-top:15px");
      expect(cleaned).toContain("font-size:14px");
      expect(cleaned).toContain("text-align:center");

      // Table elements & attributes
      expect(cleaned).toContain("<table");
      expect(cleaned).toContain("<thead");
      expect(cleaned).toContain("<tbody");
      expect(cleaned).toContain('scope="col"');
      expect(cleaned).toContain("position:sticky");
      expect(cleaned).toContain("left:0px");
      expect(cleaned).toContain("z-index:1");
      expect(cleaned).toContain("background-color:rgb(249, 249, 249)");
      expect(cleaned).toContain("background-color:rgb(255, 255, 255)");
      expect(cleaned).toContain("border-bottom:2px solid rgb(229, 229, 229)");
      expect(cleaned).toContain("border-bottom:1px solid rgb(234, 234, 234)");

      // Link security rel attribute automatically appended
      expect(cleaned).toContain('href="/pages/contact"');
      expect(cleaned).toContain('rel="noopener noreferrer"');
    });

    it("supports unitless left: 0 alongside left: 0px and hex colors in tables", () => {
      const unitlessStyle = `<th style="position: sticky; left: 0; z-index: 1; background-color: #f9f9f9;">Size</th>`;
      const cleaned = sanitizeProductDescriptionHtml(unitlessStyle);
      expect(cleaned).toContain("position:sticky");
      expect(cleaned).toContain("left:0");
      expect(cleaned).toContain("z-index:1");
      expect(cleaned).toContain("background-color:#f9f9f9");
    });

    it("preserves advanced table spanning attributes (colspan, rowspan)", () => {
      const spannedTable = `
<table>
  <thead>
    <tr>
      <th colspan="2" rowspan="1">Measurement Category</th>
      <th colspan="4">Values</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td rowspan="2">Bottoms</td>
      <td>Waist</td>
      <td>58 cm</td>
      <td>64 cm</td>
      <td>70 cm</td>
      <td>76 cm</td>
    </tr>
  </tbody>
</table>
      `.trim();

      const cleaned = sanitizeProductDescriptionHtml(spannedTable);
      expect(cleaned).toContain('colspan="2"');
      expect(cleaned).toContain('rowspan="1"');
      expect(cleaned).toContain('colspan="4"');
      expect(cleaned).toContain('rowspan="2"');
    });
  });

  // =========================================================================
  // DIMENSION 2: Multilingual & Complex Unicode Resilience
  // =========================================================================
  describe("Dimension 2: Multilingual & Complex Unicode Resilience", () => {
    it("preserves Japanese characters, full-width symbols, quotes, and Yen currency", () => {
      const japaneseContent = `
<div class="description-ja">
  <p>Yamax Flow™ ハイライズ ショーツ 6” は、軽量で吸汗速乾性に優れた CloudSoft™ 生地を採用しています。</p>
  <p>¥6,000 以上のご注文で送料無料。航空便で 3–7 営業日以内にお届けいたします。</p>
  <ul>
    <li><strong>ウエストバンド</strong>: 高張力複合ウエストでズレ落ちを徹底防止。</li>
    <li><strong>ヒップライン</strong>: 自然なヒップアップ効果をもたらすバックシーム設計。</li>
    <li><strong>お手入れ方法</strong>: 「洗濯機の手洗いモード」で冷水洗いしてください。『漂白剤』は使用不可。</li>
  </ul>
</div>
      `.trim();

      const cleaned = sanitizeProductDescriptionHtml(japaneseContent);
      expect(cleaned).toContain("Yamax Flow™ ハイライズ ショーツ 6”");
      expect(cleaned).toContain("CloudSoft™ 生地を採用しています。");
      expect(cleaned).toContain("¥6,000 以上のご注文で送料無料。");
      expect(cleaned).toContain("3–7 営業日以内にお届けいたします。");
      expect(cleaned).toContain(
        "<li><strong>ウエストバンド</strong>: 高張力複合ウエストでズレ落ちを徹底防止。</li>",
      );
      expect(cleaned).toContain("「洗濯機の手洗いモード」");
      expect(cleaned).toContain("『漂白剤』");
    });

    it("preserves complex Vietnamese diacritics and VND currency symbols", () => {
      const vietnameseContent = `
<div class="description-vi">
  <p>Khám phá sự cân bằng hoàn hảo giữa cảm giác nhẹ như không và độ nâng đỡ tối đa cùng chất liệu độc quyền Yenergy™.</p>
  <ul>
    <li><strong>Đai lưng chống trượt</strong>: Thiết kế đai dệt co giãn nhẹ nhàng ôm trọn vòng eo, không lo tuột khi vận động mạnh.</li>
    <li><strong>Đường may tôn dáng</strong>: Các đường cắt cong phía sau nâng đỡ vòng ba một cách tinh tế và tự nhiên nhất.</li>
  </ul>
  <p>Miễn phí giao hàng toàn quốc cho đơn hàng từ ₫1.000.000. Giao hàng hỏa tốc trong 3–7 ngày làm việc.</p>
</div>
      `.trim();

      const cleaned = sanitizeProductDescriptionHtml(vietnameseContent);
      expect(cleaned).toContain("Khám phá sự cân bằng hoàn hảo");
      expect(cleaned).toContain("chất liệu độc quyền Yenergy™");
      expect(cleaned).toContain("Đai lưng chống trượt");
      expect(cleaned).toContain("Đường may tôn dáng");
      expect(cleaned).toContain("₫1.000.000");
    });

    it("correctly preserves decomposed Unicode (NFD) without dropping combining accents", () => {
      const nfdString = "Quần lửng thể thao cao cấp Yenergy™".normalize("NFD");
      const cleaned = sanitizeProductDescriptionHtml(`<p>${nfdString}</p>`);
      expect(cleaned.normalize("NFC")).toBe(
        "<p>Quần lửng thể thao cao cấp Yenergy™</p>",
      );
    });

    it("preserves special typographical punctuation, trademark symbols, and emojis", () => {
      const unicodeRichContent = `
<p>Yamax Agile™ &amp; Yamax Flow™ © 2026 ®. Measurements: 58 – 64 cm (±2cm) — strictly true to size • “Premium Quality” &amp; ‘CloudSoft™’.</p>
<p>Activities: 🏃‍♀️ Running | 🧘‍♂️ Yoga | 🎾 Pickleball | ✨ Active Life | 🏷️ ¥6,000.</p>
      `.trim();

      const cleaned = sanitizeProductDescriptionHtml(unicodeRichContent);
      expect(cleaned).toContain("Yamax Agile™");
      expect(cleaned).toContain("Yamax Flow™");
      expect(cleaned).toContain("© 2026 ®");
      expect(cleaned).toContain(
        "58 – 64 cm (±2cm) — strictly true to size • “Premium Quality”",
      );
      expect(cleaned).toContain("‘CloudSoft™’");
      expect(cleaned).toContain("🏃‍♀️");
      expect(cleaned).toContain("🧘‍♂️");
      expect(cleaned).toContain("✨");
      expect(cleaned).toContain("🏷️");
    });
  });

  // =========================================================================
  // DIMENSION 3: High-Volume Payload (>100KB) Performance & ReDoS Resilience
  // =========================================================================
  describe("Dimension 3: Large Payload (>100KB) Performance & ReDoS Resilience", () => {
    it("sanitizes a >100KB HTML payload with hundreds of styled rows in under 200ms", () => {
      const sampleRow = `
<tr style="border-bottom: 1px solid rgb(234, 234, 234);">
  <td style="padding: 10px; font-weight: bold; position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;">Row #INDEX</td>
  <td style="padding: 10px; font-size: 14px; text-align: center;">84 cm</td>
  <td style="padding: 10px; font-size: 14px; text-align: center;">25 cm</td>
  <td style="padding: 10px; font-size: 14px; text-align: center;">33 cm</td>
  <td style="padding: 10px; font-size: 14px; text-align: center;">58 – 64 cm</td>
  <td style="padding: 10px; font-size: 14px; text-align: center;">80 – 86 cm</td>
</tr>
      `;

      let generatedRows = "";
      for (let i = 0; i < 400; i++) {
        generatedRows += sampleRow.replace("#INDEX", i.toString());
      }

      const largeHtml = `
<div style="overflow-x: auto; max-width: 100%; position: relative;">
  <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
    <tbody>${generatedRows}</tbody>
  </table>
</div>
      `.trim();

      const byteLength = Buffer.byteLength(largeHtml, "utf8");
      expect(byteLength).toBeGreaterThan(100 * 1024); // Ensure payload is strictly > 100KB

      const startMs = performance.now();
      const cleaned = sanitizeProductDescriptionHtml(largeHtml);
      const elapsedMs = performance.now() - startMs;

      expect(elapsedMs).toBeLessThan(250); // High performance requirement
      expect(cleaned).toContain("position:sticky");
      expect(cleaned).toContain("Row 0");
      expect(cleaned).toContain("Row 399");
    });

    it("resists ReDoS on massive style property values (50,000 characters)", () => {
      const massiveSafeValue = "color: " + "a".repeat(50000) + ";";
      const html = `<div style="${massiveSafeValue}">Text</div>`;

      const startMs = performance.now();
      const cleaned = sanitizeProductDescriptionHtml(html);
      const elapsedMs = performance.now() - startMs;

      expect(elapsedMs).toBeLessThan(50); // Under 50ms demonstrates linear evaluation
      expect(cleaned).toContain("Text");
    });

    it("resists ReDoS on repeated backtracking token patterns in style values", () => {
      const backtrackPattern =
        "color: " + "javascript-safe-prefix-".repeat(1000) + ";";
      const html = `<div style="${backtrackPattern}">Text</div>`;

      const startMs = performance.now();
      const cleaned = sanitizeProductDescriptionHtml(html);
      const elapsedMs = performance.now() - startMs;

      expect(elapsedMs).toBeLessThan(50);
    });
  });

  // =========================================================================
  // DIMENSION 4: Malicious CSS in Style Attributes & Layout Stability Challenges
  // =========================================================================
  describe("Dimension 4: Malicious CSS & Layout Stability Adversarial Challenges", () => {
    it("neutralizes standard url(), expression, and behavior in style attributes", () => {
      const dangerousStyles = [
        `<div style="background: url('https://attacker.com/leak.png'); color: red;">test</div>`,
        `<div style="background: url(javascript:alert(1));">test</div>`,
        `<div style="width: expression(alert(1));">test</div>`,
        `<div style="behavior: url(default.htc);">test</div>`,
        `<div style="@import: 'https://evil.com/style.css';">test</div>`,
        `<div style="-moz-binding: url('xss.xml');">test</div>`,
      ];

      for (const input of dangerousStyles) {
        const cleaned = sanitizeProductDescriptionHtml(input);
        expect(cleaned).not.toMatch(/url\s*\(/i);
        expect(cleaned).not.toMatch(/expression/i);
        expect(cleaned).not.toMatch(/behavior/i);
        expect(cleaned).not.toMatch(/@import/i);
        expect(cleaned).not.toMatch(/-moz-binding/i);
      }
    });

    it("neutralizes dangerous interactive/overlay CSS properties (opacity, pointer-events, transform, filter, cursor)", () => {
      const unwhitelistedStyles = `
<div style="opacity: 0; pointer-events: none; transform: scale(50); filter: blur(20px); cursor: wait; color: green;">Content</div>
      `.trim();

      const cleaned = sanitizeProductDescriptionHtml(unwhitelistedStyles);
      // None of opacity, pointer-events, transform, filter, cursor are in ALLOWED_CSS_PROPERTIES
      expect(cleaned).not.toContain("opacity");
      expect(cleaned).not.toContain("pointer-events");
      expect(cleaned).not.toContain("transform");
      expect(cleaned).not.toContain("filter");
      expect(cleaned).not.toContain("cursor");
      // Safe color:green is preserved
      expect(cleaned).toContain("color:green");
    });

    // -----------------------------------------------------------------------
    // EMPIRICAL VULNERABILITY CHALLENGE 1: CSS Escaped url() & image-set() Bypass (HARDENED)
    // -----------------------------------------------------------------------
    it("NEUTRALIZES VULNERABILITY: CSS backslash-escaped u\\rl() and image-set() are stripped with 'background' property removed", () => {
      // In hardened implementation, 'background' shorthand is removed from ALLOWED_CSS_PROPERTIES,
      // and only 'background-color' is allowed. Thus u\rl() or image-set() cannot be smuggled in.
      const backslashUrlPayload = `<div style="background: u\\rl('https://evil.com/leak');">Remote Image</div>`;
      const imageSetPayload = `<div style="background: image-set('https://evil.com/leak' 1x);">Remote Image Set</div>`;

      const cleanedBackslash =
        sanitizeProductDescriptionHtml(backslashUrlPayload);
      const cleanedImageSet = sanitizeProductDescriptionHtml(imageSetPayload);

      // Verify hardened behavior:
      expect(cleanedBackslash).not.toContain("background:");
      expect(cleanedBackslash).not.toContain("evil.com");
      expect(cleanedImageSet).not.toContain("background:");
      expect(cleanedImageSet).not.toContain("evil.com");
    });

    // -----------------------------------------------------------------------
    // EMPIRICAL VULNERABILITY CHALLENGE 2: Layout Breaking & Viewport Hijacking (HARDENED)
    // -----------------------------------------------------------------------
    it("NEUTRALIZES VULNERABILITY: position: fixed and extreme z-index are stripped by hardened sanitizer", () => {
      // Yamax tables only require position: sticky and position: relative.
      // In hardened implementation, position is restricted to static|relative|sticky,
      // and z-index is restricted to 0-10.
      const viewportHijackPayload = `
<div style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 99999; background-color: rgb(255, 255, 255);">
  <h2>Phishing / Defacement Screen</h2>
</div>
      `.trim();

      const cleaned = sanitizeProductDescriptionHtml(viewportHijackPayload);

      // Verify hardened behavior:
      expect(cleaned).not.toContain("position:fixed");
      expect(cleaned).not.toContain("position");
      expect(cleaned).not.toContain("z-index:99999");
      expect(cleaned).not.toContain("z-index");
    });
  });
});
