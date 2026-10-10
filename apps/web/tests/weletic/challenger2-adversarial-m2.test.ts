import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storage } from "../../lib/storage";
import {
  escapeHtml,
  generateYamaxHeroHtml,
  generateYamaxMaterialCareHtml,
  generateYamaxSizeGuideHtml,
  validateYamaxSupplierSizeRun,
  DEFAULT_YAMAX_ACCORDIONS,
  DEFAULT_YAMAX_HERO,
} from "../../ui/weletic/yamax-product-description-editor";
import {
  getRestrictedDevelopmentConfig,
  getRestrictedDevelopmentStores,
  isRestrictedDevelopmentEnvironment,
} from "../../../../infra/shopify-development/restricted-policy.mjs";
import { permitsRestrictedDevelopmentIdentity } from "@/lib/weletic/shopify/restricted-development";
import fs from "node:fs";
import path from "node:path";

describe("CHALLENGER 2: Milestone M2 Adversarial Stress Suite", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.STORAGE_ENDPOINT = `https://${"a".repeat(32)}.r2.cloudflarestorage.com`;
    process.env.STORAGE_PUBLIC_BUCKET = "public-test";
    process.env.STORAGE_ACCESS_KEY_ID = "test-key";
    process.env.STORAGE_SECRET_ACCESS_KEY = "test-secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  // ==========================================================================
  // SECTION 1: SSRF DEFENSE STRESS TESTING (apps/web/lib/storage.ts)
  // ==========================================================================
  describe("1. SSRF Defense & External Proxy Elimination", () => {
    it("1.1 never routes requests through wsrv.nl or any external proxy with image options", async () => {
      const fetchSpy = vi.fn().mockImplementation((url: string) => {
        if (typeof url === "string" && (url.includes("wsrv.nl") || url.includes("weserv"))) {
          throw new Error("CRITICAL VULNERABILITY: External proxy invoked!");
        }
        return Promise.resolve(
          new Response(new Uint8Array([137, 80, 78, 71]), {
            status: 200,
            headers: { "Content-Type": "image/png" },
          }),
        );
      });
      vi.stubGlobal("fetch", fetchSpy);

      const res = await storage.upload({
        key: "test-avatar.png",
        body: "https://images.unsplash.com/photo-sample",
        bucket: "public",
        opts: { width: 300, height: 300 },
      });

      expect(res.url).toBeDefined();
      for (const call of fetchSpy.mock.calls) {
        const calledUrl = typeof call[0] === "string" ? call[0] : call[0].url;
        expect(calledUrl).not.toContain("wsrv.nl");
      }
    });

    const cloudMetadataPayloads = [
      { url: "http://169.254.169.254/latest/meta-data/", name: "AWS/Azure/GCP IPv4 link-local" },
      { url: "http://169.254.169.254/computeMetadata/v1/", name: "GCP compute metadata" },
      { url: "http://[fd00:ec2::254]/", name: "AWS Nitro IPv6 metadata" },
      { url: "http://metadata.google.internal/computeMetadata/v1/", name: "GCP internal metadata domain" },
    ];

    for (const { url, name } of cloudMetadataPayloads) {
      it(`1.2 rejects cloud metadata target: ${name} (${url})`, async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);

        await expect(
          storage.upload({
            key: "test.png",
            body: url,
            bucket: "public",
          }),
        ).rejects.toThrow();

        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }

    const privateIpPayloads = [
      { url: "http://127.0.0.1:8080/admin", name: "127.0.0.1 loopback" },
      { url: "http://127.0.0.2:8080/admin", name: "127.0.0.2 loopback" },
      { url: "http://127.255.255.254:8080/admin", name: "127.255.255.254 loopback boundary" },
      { url: "http://0.0.0.0:8080/admin", name: "0.0.0.0 unspecified" },
      { url: "http://2130706433:8080/admin", name: "Decimal representation of 127.0.0.1" },
      { url: "http://0x7f000001:8080/admin", name: "Hex representation of 127.0.0.1" },
      { url: "http://017700000001:8080/admin", name: "Octal representation of 127.0.0.1" },
      { url: "http://127.1:8080/admin", name: "127.1 shorthand" },
      { url: "http://0x7f.1:8080/admin", name: "0x7f.1 hex shorthand" },
      { url: "http://10.0.0.1:8080/admin", name: "10.0.0.1 RFC 1918 Class A" },
      { url: "http://10.255.255.255:8080/admin", name: "10.255.255.255 RFC 1918 Class A boundary" },
      { url: "http://172.16.0.1:8080/admin", name: "172.16.0.1 RFC 1918 Class B" },
      { url: "http://172.31.255.255:8080/admin", name: "172.31.255.255 RFC 1918 Class B boundary" },
      { url: "http://192.168.0.1:8080/admin", name: "192.168.0.1 RFC 1918 Class C" },
      { url: "http://192.168.255.254:8080/admin", name: "192.168.255.254 RFC 1918 Class C boundary" },
      { url: "http://100.64.0.1:8080/admin", name: "100.64.0.1 Carrier-Grade NAT" },
      { url: "http://100.127.255.254:8080/admin", name: "100.127.255.254 Carrier-Grade NAT boundary" },
      { url: "http://198.18.0.1:8080/admin", name: "198.18.0.1 Benchmark range" },
      { url: "http://198.19.255.254:8080/admin", name: "198.19.255.254 Benchmark range boundary" },
      { url: "http://224.0.0.1:8080/admin", name: "224.0.0.1 Multicast" },
      { url: "http://240.0.0.1:8080/admin", name: "240.0.0.1 Reserved range" },
    ];

    for (const { url, name } of privateIpPayloads) {
      it(`1.3 rejects private IPv4 representation: ${name} (${url})`, async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);

        await expect(
          storage.upload({
            key: "test.png",
            body: url,
            bucket: "public",
          }),
        ).rejects.toThrow(/private or internal/);

        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }

    const ipv6Payloads = [
      { url: "http://[::1]:8080/admin", name: "IPv6 loopback [::1]" },
      { url: "http://[::]:8080/admin", name: "IPv6 unspecified [::]" },
      { url: "http://[::ffff:127.0.0.1]:8080/admin", name: "IPv4-mapped IPv6 loopback" },
      { url: "http://[::ffff:10.0.0.1]:8080/admin", name: "IPv4-mapped IPv6 private" },
      { url: "http://[0:0:0:0:0:ffff:127.0.0.1]:8080/admin", name: "Expanded IPv4-mapped IPv6" },
      { url: "http://[fc00::1]:8080/admin", name: "IPv6 ULA fc00::/7" },
      { url: "http://[fd00::1]:8080/admin", name: "IPv6 ULA fd00::/7" },
      { url: "http://[fe80::1]:8080/admin", name: "IPv6 link-local fe80::/10" },
    ];

    for (const { url, name } of ipv6Payloads) {
      it(`1.4 rejects IPv6 representation: ${name} (${url})`, async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);

        await expect(
          storage.upload({
            key: "test.png",
            body: url,
            bucket: "public",
          }),
        ).rejects.toThrow();

        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }

    const protocolPayloads = [
      { url: "file:///etc/passwd", name: "file://" },
      { url: "ftp://user:pass@ftp.example.com/data", name: "ftp://" },
      { url: "gopher://127.0.0.1:70/", name: "gopher://" },
      { url: "dict://127.0.0.1:2628/", name: "dict://" },
      { url: "javascript:alert(1)", name: "javascript:" },
    ];

    for (const { url, name } of protocolPayloads) {
      it(`1.5 rejects non-HTTP protocol: ${name}`, async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);

        await expect(
          storage.upload({
            key: "test.png",
            body: url,
            bucket: "public",
          }),
        ).rejects.toThrow();

        expect(fetchSpy).not.toHaveBeenCalled();
      });
    }

    it("1.6 blocks HTTP 302 redirect attempting to pivot to private IP 127.0.0.1", async () => {
      let callCount = 0;
      const fetchSpy = vi.fn().mockImplementation((input: any) => {
        callCount++;
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("93.184.216.34")) {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { Location: "http://127.0.0.1:8080/secret-token" },
            }),
          );
        }
        return Promise.resolve(new Response("PRIVATE DATA", { status: 200 }));
      });
      vi.stubGlobal("fetch", fetchSpy);

      await expect(
        storage["safeFetch"]("http://93.184.216.34/image.png"),
      ).rejects.toThrow(/private or internal IP address/);

      // Verify initial public fetch was called, but redirected hop to 127.0.0.1 was blocked before fetch
      expect(callCount).toBe(1);
    });

    it("1.7 blocks excessive redirect chains (>5 hops)", async () => {
      let hops = 0;
      const fetchSpy = vi.fn().mockImplementation(() => {
        hops++;
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { Location: `http://93.184.216.34/hop-${hops}` },
          }),
        );
      });
      vi.stubGlobal("fetch", fetchSpy);

      await expect(
        storage["safeFetch"]("http://93.184.216.34/hop-0"),
      ).rejects.toThrow(/Too many redirects/);

      expect(hops).toBe(6);
    });
  });

  // ==========================================================================
  // SECTION 2: DOM-XSS INJECTION STRESS TESTING
  // ==========================================================================
  describe("2. DOM-XSS Injection Stress Testing (Yamax Product Description Editor)", () => {
    const xssPayloads = [
      { name: "Standard <script>", payload: '<script>alert("XSS")</script>' },
      { name: "Mixed case <sCrIpT>", payload: '<sCrIpT>alert(document.cookie)</ScRiPt>' },
      { name: "Quoted <img onerror>", payload: '<img src="x" onerror="alert(1)">' },
      { name: "Unquoted <img onerror>", payload: '<img src=x onerror=alert(1)>' },
      { name: "SVG onload vector", payload: '<svg/onload=alert(1)>' },
      { name: "SVG nested script", payload: '<svg><script>alert(1)</script></svg>' },
      { name: "Iframe breakout", payload: '"><iframe src="javascript:alert(1)"></iframe>' },
      { name: "Single quote attribute breakout", payload: "' onfocus='alert(1)' autofocus='" },
      { name: "Double quote attribute breakout", payload: '" onmouseover="alert(1)" style="display:block"' },
      { name: "Body autofocus vector", payload: '<body autofocus onfocus=alert(1)>' },
      { name: "Anchor javascript href", payload: '<a href="javascript:alert(1)">Click</a>' },
      { name: "Video source error", payload: '<video><source onerror="alert(1)">' },
    ];

    it("2.1 escapeHtml rigorously escapes all 5 HTML special characters", () => {
      expect(escapeHtml("&")).toBe("&amp;");
      expect(escapeHtml("<")).toBe("&lt;");
      expect(escapeHtml(">")).toBe("&gt;");
      expect(escapeHtml('"')).toBe("&quot;");
      expect(escapeHtml("'")).toBe("&#39;");
      expect(escapeHtml("")).toBe("");
      expect(escapeHtml(null as any)).toBe("");
      expect(escapeHtml(undefined as any)).toBe("");
    });

    it("2.2 neutralizes all XSS payloads injected into Size Guide fitTip", () => {
      for (const { name, payload } of xssPayloads) {
        const html = generateYamaxSizeGuideHtml(payload);
        // Verify that unescaped tags cannot be injected into the output
        expect(html, `Failed on ${name}`).not.toMatch(/<script/i);
        expect(html, `Failed on ${name}`).not.toMatch(/<img/i);
        expect(html, `Failed on ${name}`).not.toMatch(/<svg/i);
        expect(html, `Failed on ${name}`).not.toMatch(/<iframe/i);
        expect(html, `Failed on ${name}`).not.toMatch(/<body/i);
        expect(html, `Failed on ${name}`).not.toMatch(/<video/i);
        // Verify payloads are neutralized as HTML entities
        expect(html).toContain(escapeHtml(payload));
      }
    });

    it("2.3 neutralizes all XSS payloads injected across Hero section fields", () => {
      for (const { name, payload } of xssPayloads) {
        const hero = {
          tagline: payload,
          bullet1Title: payload,
          bullet1Desc: payload,
          bullet2Title: payload,
          bullet2Desc: payload,
          bullet3Title: payload,
          bullet3Desc: payload,
        };
        const html = generateYamaxHeroHtml(hero);
        expect(html, `Hero failed on ${name}`).not.toMatch(/<script/i);
        expect(html, `Hero failed on ${name}`).not.toMatch(/<img/i);
        expect(html, `Hero failed on ${name}`).not.toMatch(/<svg/i);
        expect(html, `Hero failed on ${name}`).not.toMatch(/<iframe/i);
        expect(html, `Hero failed on ${name}`).not.toMatch(/<body/i);
        expect(html, `Hero failed on ${name}`).not.toMatch(/<video/i);
        expect(html).toContain(escapeHtml(payload));
      }
    });

    it("2.4 neutralizes all XSS payloads injected into Material & Care accordion", () => {
      for (const { name, payload } of xssPayloads) {
        const accordions = {
          ...DEFAULT_YAMAX_ACCORDIONS,
          fabricComposition: payload,
          fabricWeight: payload,
          washInstruction: payload,
          dryInstruction: payload,
          careInstruction: payload,
        };
        const html = generateYamaxMaterialCareHtml(accordions);
        expect(html, `Material failed on ${name}`).not.toMatch(/<script/i);
        expect(html, `Material failed on ${name}`).not.toMatch(/<img/i);
        expect(html, `Material failed on ${name}`).not.toMatch(/<svg/i);
        expect(html, `Material failed on ${name}`).not.toMatch(/<iframe/i);
        expect(html, `Material failed on ${name}`).not.toMatch(/<body/i);
        expect(html, `Material failed on ${name}`).not.toMatch(/<video/i);
        expect(html).toContain(escapeHtml(payload));
      }
    });

    it("2.5 validates 1688 supplier variant sizing completeness rule", () => {
      const completeRun = [
        { color: "Black", size: "S", inStock: true },
        { color: "Black", size: "M", inStock: true },
        { color: "Black", size: "L", inStock: true },
        { color: "Black", size: "XL", inStock: true },
      ];
      expect(validateYamaxSupplierSizeRun(completeRun).valid).toBe(true);

      const brokenRun = [
        { color: "Lilac", size: "S", inStock: false }, // Discontinued!
        { color: "Lilac", size: "M", inStock: true },
        { color: "Lilac", size: "L", inStock: true },
        { color: "Lilac", size: "XL", inStock: true },
      ];
      const res = validateYamaxSupplierSizeRun(brokenRun);
      expect(res.valid).toBe(false);
      expect(res.discontinuedColors).toContain("Lilac");
      expect(res.colorStatus["Lilac"].missingSizes).toContain("S");
      expect(res.eligibleVariants.length).toBe(0);
    });
  });

  // ==========================================================================
  // SECTION 3: ZERO-HARDCODING INVARIANT 4 GREP & AST AUDIT
  // ==========================================================================
  describe("3. Zero-Hardcoding Invariant 4 Compliance", () => {
    it("3.1 confirms zero occurrences of montdev.myshopify.com in production source files", () => {
      const rootDir = path.resolve(__dirname, "../../../..");
      const productionFiles = [
        "apps/web/lib/weletic/shopify/app-pricing-service.ts",
        "apps/web/lib/weletic/shopify/restricted-development.ts",
        "infra/shopify-development/restricted-policy.mjs",
      ];

      for (const rel of productionFiles) {
        const full = path.resolve(rootDir, rel);
        if (fs.existsSync(full)) {
          const content = fs.readFileSync(full, "utf8");
          expect(content).not.toContain("montdev.myshopify.com");
        }
      }
    });

    it("3.2 confirms zero occurrences of static public app ID c7d49cebb06e445db345bb200f966a03 in runtime files", () => {
      const rootDir = path.resolve(__dirname, "../../../..");
      const runtimeFiles = [
        "apps/web/lib/weletic/shopify/app-pricing-service.ts",
        "apps/web/lib/weletic/shopify/restricted-development.ts",
        "infra/shopify-development/restricted-policy.mjs",
      ];

      for (const rel of runtimeFiles) {
        const full = path.resolve(rootDir, rel);
        if (fs.existsSync(full)) {
          const content = fs.readFileSync(full, "utf8");
          expect(content).not.toContain("c7d49cebb06e445db345bb200f966a03");
        }
      }
    });

    it("3.3 dynamically parses arbitrary multi-tenant stores from environment variables", () => {
      const arbitraryStores = "alpha-store.myshopify.com, beta-store.myshopify.com, gamma-store.myshopify.com";
      const env = { SHOPIFY_RESTRICTED_DEV_STORES: arbitraryStores };
      const parsed = getRestrictedDevelopmentStores(env);
      expect(parsed).toEqual([
        "alpha-store.myshopify.com",
        "beta-store.myshopify.com",
        "gamma-store.myshopify.com",
      ]);
    });

    it("3.4 permitsRestrictedDevelopmentIdentity dynamically admits configured multi-tenant stores", () => {
      const gen = "33333333-3333-4333-8333-333333333333";
      const tenantStore = "brand-new-merchant.myshopify.com";
      const tenantAppId = "custom_app_id_888";

      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("WELETIC_ISOLATED_DEVELOPMENT", "1");
      vi.stubEnv("WELETIC_FEATURE_PROFILE", "core-v1");
      vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT", "yamaxdev-v1");
      vi.stubEnv("WELETIC_RESTRICTED_DEVELOPMENT_GENERATION", gen);
      vi.stubEnv("SHOPIFY_API_KEY", tenantAppId);
      vi.stubEnv("SHOPIFY_PARTNER_APP_ID", "gid://shopify/App/888");
      vi.stubEnv("SHOPIFY_RESTRICTED_DEV_STORES", tenantStore);
      vi.stubEnv("DATABASE_URL", "mysql://synthetic@127.0.0.1:60101/test");
      vi.stubEnv("PLANETSCALE_DATABASE_URL", "http://127.0.0.1:65367/test");
      vi.stubEnv("UPSTASH_REDIS_REST_URL", "http://127.0.0.1:8079");
      vi.stubEnv("STORAGE_ENDPOINT", "http://127.0.0.1:9002");

      expect(isRestrictedDevelopmentEnvironment(process.env)).toBe(true);

      const identity = {
        appId: tenantAppId,
        partnerAppId: "gid://shopify/App/888",
        shopId: "gid://shopify/Shop/888",
        shop: tenantStore,
        installationGeneration: gen,
      };

      expect(permitsRestrictedDevelopmentIdentity(identity)).toBe(true);
    });
  });
});
