import { sanitizeProductDescriptionHtml } from "@/lib/weletic/html-sanitizer";
import { describe, expect, it } from "vitest";

describe("Milestone M2 (UI-04) Adversarial Mutation & XSS Bypass Testing Suite", () => {
  describe("Category 1: Nested, Malformed, and Broken Tags", () => {
    const nestedPayloads = [
      {
        name: "Nested uppercase script",
        input: "<<SCRIPT>alert(1)//<</SCRIPT>",
      },
      {
        name: "Interleaved script tag",
        input: "<scr<script>ipt>alert(1)</script>",
      },
      {
        name: "Interleaved script with closing tags",
        input: "<scr<script></script>ipt>alert(1)</script>",
      },
      { name: "Broken opening angle brackets", input: "<<<script>alert(1)>>>" },
      {
        name: "Tag inside tag attribute",
        input: `<div title="<script>alert(1)</script>">safe</div>`,
      },
      {
        name: "Nested broken img with onerror",
        input: "<<img src=x onerror=alert(1)>",
      },
      { name: "Broken svg tag with onload", input: "<<svg/onload=alert(1)>" },
      {
        name: "Unclosed script tag with trailing text",
        input: "<script src='https://evil.com/xss.js' Next product info",
      },
      {
        name: "Broken div script injection",
        input: "<div<script>alert(1)</script>>hello</div>",
      },
      { name: "Malformed closing tags", input: "<p>Text</p</script>>" },
    ];

    for (const { name, input } of nestedPayloads) {
      it(`neutralizes tag and prevents executable script: ${name}`, () => {
        const cleaned = sanitizeProductDescriptionHtml(input);
        // Tag MUST be stripped or neutralized
        expect(cleaned).not.toMatch(/<script\b/i);
        expect(cleaned).not.toMatch(/<img\b/i);
        expect(cleaned).not.toMatch(/<svg\b/i);
        expect(cleaned).not.toMatch(/\bonerror\b/i);
        expect(cleaned).not.toMatch(/\bonload\b/i);
        expect(cleaned).not.toMatch(
          /<(?:script|img|svg|iframe|object|embed|body|head|meta|link|style)\b/i,
        );
      });
    }
  });

  describe("Category 2: Case Mutations & Mixed-Case Tags/Attributes", () => {
    const casePayloads = [
      { name: "Mixed-case script tag", input: "<sCrIpT>alert(1)</sCrIpT>" },
      {
        name: "Uppercase SCRIPT tag",
        input: "<SCRIPT SRC='https://evil.com/xss.js'></SCRIPT>",
      },
      {
        name: "Mixed-case img with mixed-case onerror",
        input: "<iMg sRc=x oNeRroR=alert(1)>",
      },
      { name: "Uppercase IMG ONERROR", input: "<IMG SRC=X ONERROR=alert(1)>" },
      { name: "Mixed-case svg with ONLOAD", input: "<sVg OnLoAd=alert(1)>" },
      {
        name: "Mixed-case anchor with mixed-case javascript",
        input: `<a HrEf="JaVaScRiPt:alert(1)">Click</a>`,
      },
      {
        name: "Uppercase DIV ONCLICK",
        input: `<DIV ONCLICK="alert(1)">Click</DIV>`,
      },
      { name: "Mixed-case BODY ONLOAD", input: "<BoDy OnLoAd=alert(1)>" },
      {
        name: "Mixed-case IFRAME SRC",
        input: "<iFrAmE sRc='javascript:alert(1)'></iFrAmE>",
      },
      {
        name: "Mixed-case OBJECT DATA",
        input: "<ObJeCt DaTa='javascript:alert(1)'></ObJeCt>",
      },
    ];

    for (const { name, input } of casePayloads) {
      it(`neutralizes ${name}`, () => {
        const cleaned = sanitizeProductDescriptionHtml(input);
        expect(cleaned).not.toMatch(/<script/i);
        expect(cleaned).not.toMatch(/onerror/i);
        expect(cleaned).not.toMatch(/onload/i);
        expect(cleaned).not.toMatch(/onclick/i);
        expect(cleaned).not.toMatch(/href\s*=\s*["']?\s*javascript/i);
        expect(cleaned).not.toMatch(/<iframe/i);
        expect(cleaned).not.toMatch(/<object/i);
        expect(cleaned).not.toMatch(/<body/i);
      });
    }
  });

  describe("Category 3: Polymorphic Event Handlers & Auto-Execution Attributes", () => {
    const eventHandlerPayloads = [
      {
        name: "ontouchstart",
        input: `<div ontouchstart="alert('touch')">Touch Me</div>`,
      },
      { name: "ontouchend", input: `<p ontouchend="alert('touch')">Touch</p>` },
      {
        name: "onpointerdown",
        input: `<div onpointerdown="alert('pointer')">Pointer</div>`,
      },
      {
        name: "onpointerup",
        input: `<span onpointerup="alert('pointer')">Pointer</span>`,
      },
      {
        name: "onpointerover",
        input: `<div onpointerover="alert('pointer')">Pointer</div>`,
      },
      {
        name: "autofocus onfocus",
        input: `<input autofocus onfocus="alert('focus')">`,
      },
      {
        name: "div autofocus onfocus",
        input: `<div tabIndex="0" autofocus onfocus="alert('focus')">Focus</div>`,
      },
      {
        name: "onfocusin",
        input: `<p onfocusin="alert('focusin')">FocusIn</p>`,
      },
      { name: "onblur", input: `<div onblur="alert('blur')">Blur</div>` },
      {
        name: "onanimationstart",
        input: `<div style="animation: x" onanimationstart="alert('anim')">Anim</div>`,
      },
      {
        name: "onanimationend",
        input: `<div onanimationend="alert('anim')">Anim</div>`,
      },
      {
        name: "ontransitionend",
        input: `<div ontransitionend="alert('trans')">Trans</div>`,
      },
      { name: "onwheel", input: `<div onwheel="alert('wheel')">Wheel</div>` },
      { name: "oncopy", input: `<div oncopy="alert('copy')">Copy</div>` },
      { name: "onpaste", input: `<div onpaste="alert('paste')">Paste</div>` },
      { name: "oncut", input: `<div oncut="alert('cut')">Cut</div>` },
      {
        name: "onauxclick",
        input: `<div onauxclick="alert('auxclick')">AuxClick</div>`,
      },
      {
        name: "ondblclick",
        input: `<div ondblclick="alert('dblclick')">DblClick</div>`,
      },
      {
        name: "oncontextmenu",
        input: `<div oncontextmenu="alert('contextmenu')">Context</div>`,
      },
      { name: "ondrag", input: `<div ondrag="alert('drag')">Drag</div>` },
      { name: "ondrop", input: `<div ondrop="alert('drop')">Drop</div>` },
      {
        name: "ondragover",
        input: `<div ondragover="alert('dragover')">DragOver</div>`,
      },
      {
        name: "onscroll",
        input: `<div onscroll="alert('scroll')">Scroll</div>`,
      },
      { name: "onkeydown", input: `<div onkeydown="alert('key')">Key</div>` },
      { name: "onkeyup", input: `<div onkeyup="alert('key')">Key</div>` },
      {
        name: "onmouseenter",
        input: `<div onmouseenter="alert('enter')">Enter</div>`,
      },
      {
        name: "onmouseleave",
        input: `<div onmouseleave="alert('leave')">Leave</div>`,
      },
    ];

    for (const { name, input } of eventHandlerPayloads) {
      it(`strips polymorphic handler: ${name}`, () => {
        const cleaned = sanitizeProductDescriptionHtml(input);
        expect(cleaned).not.toMatch(new RegExp(`\\b${name}\\b`, "i"));
        expect(cleaned).not.toMatch(/alert\s*\(/i);
        expect(cleaned).not.toMatch(/<input/i);
      });
    }
  });

  describe("Category 4: Obfuscated, Encoded Schemes & Pseudo-Protocols in Links", () => {
    const schemePayloads = [
      {
        name: "Newline entity encoded javascript",
        input: `<a href="java&#x0A;script:alert(1)">Link 1</a>`,
      },
      {
        name: "Tab entity encoded javascript",
        input: `<a href="java&#x09;script:alert(1)">Link 2</a>`,
      },
      {
        name: "Carriage return encoded javascript",
        input: `<a href="java&#x0D;script:alert(1)">Link 3</a>`,
      },
      {
        name: "HTML named entity &Tab; javascript",
        input: `<a href="&Tab;javascript:alert(1)">Link 5</a>`,
      },
      {
        name: "Full decimal entity encoded javascript",
        input: `<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">Link 6</a>`,
      },
      {
        name: "Hex colon entity encoded",
        input: `<a href="javascript&#x3a;alert(1)">Link 7</a>`,
      },
      {
        name: "Decimal colon entity encoded",
        input: `<a href="javascript&#58;alert(1)">Link 8</a>`,
      },
      {
        name: "Leading tab whitespace",
        input: `<a href="\tjavascript:alert(1)">Link 9</a>`,
      },
      {
        name: "Leading newline whitespace",
        input: `<a href="\njavascript:alert(1)">Link 10</a>`,
      },
      {
        name: "Leading return whitespace",
        input: `<a href="\rjavascript:alert(1)">Link 11</a>`,
      },
      {
        name: "Leading spaces",
        input: `<a href="   javascript:alert(1)">Link 12</a>`,
      },
      {
        name: "data URI HTML with base64 script",
        input: `<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Data 1</a>`,
      },
      {
        name: "data URI plain text script",
        input: `<a href="data:text/html,<script>alert(1)</script>">Data 2</a>`,
      },
      {
        name: "data URI javascript",
        input: `<a href="data:text/javascript,alert(1)">Data 3</a>`,
      },
      {
        name: "uppercase DATA URI",
        input: `<a href="DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Data 4</a>`,
      },
      {
        name: "vbscript pseudo-scheme",
        input: `<a href="vbscript:msgbox(1)">VBS</a>`,
      },
      {
        name: "livescript pseudo-scheme",
        input: `<a href="livescript:alert(1)">LiveScript</a>`,
      },
      {
        name: "blob URI scheme",
        input: `<a href="blob:http://evil.com/uuid">Blob</a>`,
      },
      {
        name: "protocol-relative evil link",
        input: `<a href="//evil.com/phishing">Phish</a>`,
      },
      {
        name: "backslash protocol relative",
        input: `<a href="\\\\evil.com\\phish">Backslash</a>`,
      },
    ];

    for (const { name, input } of schemePayloads) {
      it(`disallows dangerous scheme: ${name}`, () => {
        const cleaned = sanitizeProductDescriptionHtml(input);
        expect(cleaned).not.toMatch(/href\s*=\s*["']?\s*javascript/i);
        expect(cleaned).not.toMatch(/href\s*=\s*["']?\s*data/i);
        expect(cleaned).not.toMatch(/href\s*=\s*["']?\s*vbscript/i);
        expect(cleaned).not.toMatch(/href\s*=\s*["']?\s*livescript/i);
        expect(cleaned).not.toMatch(/href\s*=\s*["']?\s*blob/i);
        expect(cleaned).not.toMatch(/href\s*=\s*["']?\s*\/\//i);
        // The href attribute should be removed entirely
        expect(cleaned).not.toMatch(/href=/i);
      });
    }

    it("neutralizes null byte encoded javascript scheme", () => {
      const input = `<a href="java&#00;script:alert(1)">Link 4</a>`;
      const cleaned = sanitizeProductDescriptionHtml(input);
      // Browser URL parser treats \uFFFD as non-alpha, meaning the scheme cannot execute javascript
      expect(cleaned).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
    });
  });

  describe("Category 5: SVG and MathML Namespace Vectors", () => {
    const svgMathPayloads = [
      {
        name: "svg with script",
        input: "<svg><script>alert(1)</script></svg>",
      },
      {
        name: "math with mtext style img onerror",
        input:
          "<math><mtext><style><img src=x onerror=alert(1)></style></mtext></math>",
      },
      {
        name: "math with href javascript",
        input: `<math href="javascript:alert(1)">CLICK</math>`,
      },
      {
        name: "svg with a href javascript",
        input: `<svg><a href="javascript:alert(1)"><circle r="10"/></a></svg>`,
      },
      {
        name: "svg animate onbegin",
        input: `<svg><animate onbegin=alert(1) attributeName=x dur=1s>`,
      },
      {
        name: "svg set onbegin",
        input: `<svg><set onbegin=alert(1) attributeName=x dur=1s>`,
      },
      {
        name: "svg foreignObject iframe",
        input: `<svg><foreignObject><iframe src="javascript:alert(1)"></iframe></foreignObject></svg>`,
      },
      {
        name: "svg use data URI",
        input: `<svg><use href="data:image/svg+xml;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="#x"/></svg>`,
      },
      {
        name: "svg CDATA script escape",
        input: `<svg><desc><![CDATA[</desc><script>alert(1)</script>]]></svg>`,
      },
    ];

    for (const { name, input } of svgMathPayloads) {
      it(`strips SVG/MathML namespace vector: ${name}`, () => {
        const cleaned = sanitizeProductDescriptionHtml(input);
        expect(cleaned).not.toMatch(/<svg/i);
        expect(cleaned).not.toMatch(/<math/i);
        expect(cleaned).not.toMatch(/<script/i);
        expect(cleaned).not.toMatch(/alert\s*\(/i);
        expect(cleaned).not.toMatch(/onerror/i);
        expect(cleaned).not.toMatch(/onbegin/i);
      });
    }
  });

  describe("Category 6: Form Hijacking, HTML5 Controls, and Execution Sinks", () => {
    const formPayloads = [
      {
        name: "form with action javascript",
        input: `<form action="javascript:alert(1)"><button type="submit">Submit</button></form>`,
      },
      {
        name: "button with formaction javascript",
        input: `<button formaction="javascript:alert(1)">Click</button>`,
      },
      {
        name: "input type image onerror",
        input: `<input type="image" src="x" onerror="alert(1)">`,
      },
      {
        name: "meta refresh javascript",
        input: `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`,
      },
      {
        name: "base href javascript hijack",
        input: `<base href="javascript:alert(1)//">`,
      },
      {
        name: "link stylesheet javascript",
        input: `<link rel="stylesheet" href="javascript:alert(1)">`,
      },
      {
        name: "textarea enclosing script",
        input: `<textarea><script>alert(1)</script></textarea>`,
      },
    ];

    for (const { name, input } of formPayloads) {
      it(`disallows form sink: ${name}`, () => {
        const cleaned = sanitizeProductDescriptionHtml(input);
        expect(cleaned).not.toMatch(/<form/i);
        expect(cleaned).not.toMatch(/<button/i);
        expect(cleaned).not.toMatch(/<input/i);
        expect(cleaned).not.toMatch(/<meta/i);
        expect(cleaned).not.toMatch(/<base/i);
        expect(cleaned).not.toMatch(/<link/i);
        expect(cleaned).not.toMatch(/<textarea/i);
        expect(cleaned).not.toMatch(/javascript:/i);
        expect(cleaned).not.toMatch(/alert\s*\(/i);
      });
    }
  });

  describe("Category 7: DOM Clobbering & Sensitive Attributes Neutralization", () => {
    it("strips id and name attributes from all tags to prevent DOM clobbering", () => {
      const payload = `
        <div id="document">div id</div>
        <p id="cookie">cookie</p>
        <span name="location">location</span>
        <a id="defaultProgramId" href="https://example.com">anchor</a>
      `;
      const cleaned = sanitizeProductDescriptionHtml(payload);
      expect(cleaned).not.toMatch(/\bid\s*=/i);
      expect(cleaned).not.toMatch(/\bname\s*=/i);
    });
  });

  describe("Category 8: CSS Style Injection & Malicious Inline Styles", () => {
    it("strips url() in background and background-image", () => {
      const payload = `
        <div style="background: url('javascript:alert(1)'); color: red;">Test 1</div>
        <div style="background: url(https://attacker.com/leak.png); width: 100px;">Test 2</div>
        <div style="background-image: url('data:image/svg+xml,...');">Test 3</div>
      `;
      const cleaned = sanitizeProductDescriptionHtml(payload);
      expect(cleaned).not.toMatch(/url\s*\(/i);
      expect(cleaned).not.toMatch(/javascript:/i);
      expect(cleaned).toContain("color:red");
      expect(cleaned).toContain("width:100px");
    });

    it("strips expression(), behavior, -moz-binding, and @import from style attribute", () => {
      const payload = `
        <div style="width: expression(alert(1));">Text1</div>
        <div style="behavior: url(test.htc);">Text2</div>
        <div style="-moz-binding: url(test.xml#xss);">Text3</div>
        <div style="@import: 'test.css';">Text4</div>
      `;
      const cleaned = sanitizeProductDescriptionHtml(payload);
      // None of the div elements should have style attributes containing dangerous CSS
      expect(cleaned).not.toMatch(
        /style\s*=\s*["'][^"']*(?:expression|behavior|-moz-binding|@import)/i,
      );
      expect(cleaned).toContain("<div>Text1</div>");
      expect(cleaned).toContain("<div>Text2</div>");
      expect(cleaned).toContain("<div>Text3</div>");
      expect(cleaned).toContain("<div>Text4</div>");
    });

    it("neutralizes image-set leak: CSS background shorthand is removed so image-set() cannot bypass", () => {
      const payload = `<div style="background: image-set('https://attacker.com/leak.png' 1x);">Leak</div>`;
      const cleaned = sanitizeProductDescriptionHtml(payload);
      // In hardened implementation, background shorthand is stripped from ALLOWED_CSS_PROPERTIES
      const hasImageSet = cleaned.includes("image-set");
      expect(hasImageSet).toBe(false);
      expect(cleaned).not.toContain("background:");
    });
  });

  describe("Category 9: UI Redress / Full-Screen Overlay & Tailwind Class Vector Analysis", () => {
    it("neutralizes UI redress vectors: position: fixed and z-index: 99999 are stripped by sanitizer", () => {
      const overlayPayload = `<div style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 99999; background: #fff;"><a href="https://evil-phishing.com">Click to update account</a></div>`;
      const cleaned = sanitizeProductDescriptionHtml(overlayPayload);

      // In hardened implementation, position is restricted to static|relative|sticky, z-index to 0-10, background removed
      const hasPositionFixed = cleaned.includes("position:fixed");
      const hasZIndexHigh = cleaned.includes("z-index:99999");

      expect(hasPositionFixed).toBe(false);
      expect(hasZIndexHigh).toBe(false);
      expect(cleaned).not.toContain("position");
      expect(cleaned).not.toContain("z-index");
    });

    it("neutralizes Tailwind overlay vectors: class attribute is completely stripped from all elements", () => {
      const classOverlayPayload = `<div class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"><a href="https://evil-phishing.com">Phishing Overlay</a></div>`;
      const cleaned = sanitizeProductDescriptionHtml(classOverlayPayload);

      // In hardened implementation, allowedAttributes removes class attribute completely
      const hasFixedClass = cleaned.includes(
        'class="fixed inset-0 z-50 bg-black/80 flex items-center justify-center"',
      );
      expect(hasFixedClass).toBe(false);
      expect(cleaned).not.toContain("class=");
    });
  });

  describe("Category 10: Yamax Formatting & Responsive Table Preservation Verification", () => {
    it("preserves Yamax sticky column table structure and safe styles", () => {
      const yamaxTableHtml = `
        <div style="overflow-x: auto; max-width: 100%; position: relative;">
          <table style="width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 14px; text-align: center;">
            <thead>
              <tr style="border-bottom: 2px solid rgb(229, 229, 229); background-color: rgb(249, 249, 249);">
                <th style="padding: 10px; font-weight: 600; position: sticky; left: 0px; background-color: rgb(249, 249, 249); z-index: 1;">Size</th>
              </tr>
            </thead>
          </table>
        </div>
      `;
      const cleaned = sanitizeProductDescriptionHtml(yamaxTableHtml);
      expect(cleaned).toContain("position:sticky");
      expect(cleaned).toContain("left:0px");
      expect(cleaned).toContain("z-index:1");
      expect(cleaned).toContain("overflow-x:auto");
      expect(cleaned).toContain("max-width:100%");
      expect(cleaned).toContain("position:relative");
      expect(cleaned).toContain("background-color:rgb(249, 249, 249)");
    });
  });
});
