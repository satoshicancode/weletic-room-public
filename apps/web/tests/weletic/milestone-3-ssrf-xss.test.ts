import { describe, expect, it, vi } from "vitest";

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
  assertSafeWebhookUrl,
  validateWebhook,
} from "@/lib/webhook/validate-webhook";
import { sanitizeProductDescriptionHtml } from "@/lib/weletic/html-sanitizer";
import dnsCallback, { promises as dns } from "dns";
import { NextRequest } from "next/server";
import {
  assertSafeUrl,
  hasSiteConfigured,
  pinnedDnsMap,
} from "../../app/api/domains/[domain]/validate/utils";
import { GET as getMetatagsRoute } from "../../app/api/links/metatags/route";
import { assertSafeFetchUrl } from "../../app/api/links/metatags/utils";

describe("Milestone 3: SSRF Fail-Closed Defense, TOCTOU DNS Rebinding & Stored XSS Hygiene", () => {
  describe("SEC-R3-01: Metatags SSRF Fail-Closed Defense (/api/links/metatags)", () => {
    it("rejects loopback addresses (127.0.0.1, localhost, [::1], 0.0.0.0)", async () => {
      const loopbacks = [
        "http://127.0.0.1:8080",
        "http://127.0.0.2:3000",
        "http://localhost:3000",
        "http://[::1]:8080",
        "http://0.0.0.0:8000",
      ];

      for (const url of loopbacks) {
        await expect(assertSafeFetchUrl(url)).rejects.toThrow(DubApiError);
      }
    });

    it("rejects RFC 1918 private subnets (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)", async () => {
      const rfc1918Urls = [
        "http://10.0.0.1/admin",
        "http://10.254.254.1:8080",
        "http://172.16.0.1/status",
        "http://172.31.255.255:443",
        "http://192.168.1.1/router",
        "http://192.168.0.254:80",
      ];

      for (const url of rfc1918Urls) {
        await expect(assertSafeFetchUrl(url)).rejects.toThrow(DubApiError);
      }
    });

    it("rejects link-local, AWS/Cloud metadata (169.254.169.254) and CGNAT addresses", async () => {
      const metadataUrls = [
        "http://169.254.169.254/latest/meta-data",
        "http://169.254.1.1:80",
        "http://100.64.0.1:80",
        "http://100.127.255.255:80",
      ];

      for (const url of metadataUrls) {
        await expect(assertSafeFetchUrl(url)).rejects.toThrow(DubApiError);
      }
    });

    it("rejects IPv6 link-local (fe80::) and unique local (fc00::/fd00::) addresses", async () => {
      const ipv6Private = [
        "http://[fe80::1]/status",
        "http://[fc00::1]/admin",
        "http://[fd00::1]/internal",
        "http://[::]/zero",
      ];

      for (const url of ipv6Private) {
        await expect(assertSafeFetchUrl(url)).rejects.toThrow(DubApiError);
      }
    });

    it("rejects internal domains and non-routable TLDs without DNS lookup", async () => {
      const internalHosts = [
        "http://server.internal/secrets",
        "http://printer.local/admin",
        "http://nas.home.arpa/data",
        "http://test.localhost:8080",
      ];

      for (const url of internalHosts) {
        await expect(assertSafeFetchUrl(url)).rejects.toThrow(DubApiError);
      }
    });

    it("rejects non-http/https protocols", async () => {
      const nonHttp = [
        "ftp://example.com/files",
        "file:///etc/passwd",
        "gopher://evil.com",
      ];

      for (const url of nonHttp) {
        await expect(assertSafeFetchUrl(url)).rejects.toThrow(DubApiError);
      }
    });

    it("fails closed when hostname cannot be resolved via DNS", async () => {
      const lookupSpy = vi
        .spyOn(dns, "lookup")
        .mockRejectedValueOnce(new Error("ENOTFOUND"));

      await expect(
        assertSafeFetchUrl("http://nonexistent-host-domain.test"),
      ).rejects.toThrow(DubApiError);
      lookupSpy.mockRestore();
    });

    it("rejects domains that resolve via DNS to loopback or metadata IP", async () => {
      const lookupSpy = vi
        .spyOn(dns, "lookup")
        .mockResolvedValueOnce([
          { address: "169.254.169.254", family: 4 },
        ] as any);

      await expect(
        assertSafeFetchUrl("http://attacker-rebinding.com"),
      ).rejects.toThrow(DubApiError);
      lookupSpy.mockRestore();
    });

    it("allows safe public URLs and pins the resolved IP", async () => {
      const lookupSpy = vi
        .spyOn(dns, "lookup")
        .mockResolvedValueOnce([
          { address: "93.184.216.34", family: 4 },
        ] as any);

      const result = await assertSafeFetchUrl("https://example.com/blog");
      expect(result.hostname).toBe("example.com");
      expect(result.safeIp).toBe("93.184.216.34");
      lookupSpy.mockRestore();
    });

    it("route handler returns HTTP 400 Bad Request when private IP is targeted", async () => {
      const req = new NextRequest(
        "https://dub.co/api/links/metatags?url=http://127.0.0.1:8080",
      );
      const res = await getMetatagsRoute(req);
      expect(res.status).toBe(400);

      const body = (await res.json()) as any;
      expect(body.error.code).toBe("bad_request");
    });
  });

  describe("SEC-R3-02: TOCTOU DNS Rebinding Pinning in Custom Domain Validator", () => {
    it("pins the outbound request to the validated safe IP to prevent DNS rebinding", async () => {
      let lookupCount = 0;
      // Simulate rebinding DNS: 1st lookup returns public IP, 2nd lookup returns 127.0.0.1
      const lookupSpy = vi.spyOn(dns, "lookup").mockImplementation(async () => {
        lookupCount++;
        if (lookupCount === 1) {
          return [{ address: "93.184.216.34", family: 4 }] as any;
        }
        return [{ address: "127.0.0.1", family: 4 }] as any;
      });

      // assertSafeUrl must pin example-rebind.com to 93.184.216.34
      await assertSafeUrl("https://example-rebind.com");
      expect(pinnedDnsMap.get("example-rebind.com")).toBe("93.184.216.34");

      // Verify that dnsCallback.lookup returns the pinned safe IP and never queries rebinding IP
      await new Promise<void>((resolve, reject) => {
        dnsCallback.lookup("example-rebind.com", (err, address) => {
          if (err) return reject(err);
          try {
            expect(address).toBe("93.184.216.34");
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });

      // Cleanup pin
      pinnedDnsMap.delete("example-rebind.com");
      lookupSpy.mockRestore();
    });

    it("hasSiteConfigured cleans up pinned DNS after completing checks", async () => {
      const lookupSpy = vi
        .spyOn(dns, "lookup")
        .mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as any);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        status: 200,
      } as any);

      const siteActive = await hasSiteConfigured("safe-tenant-domain.com");
      expect(siteActive).toBe(true);

      // Verify pin was deleted in finally block
      expect(pinnedDnsMap.has("safe-tenant-domain.com")).toBe(false);

      lookupSpy.mockRestore();
      fetchSpy.mockRestore();
    });

    it("rejects unpinned lookups if external DNS rebinds to internal IP", async () => {
      await new Promise<void>((resolve, reject) => {
        // Direct lookup of loopback through hook triggers assertSafeIp and rejects
        dnsCallback.lookup("127.0.0.1", (err) => {
          try {
            if (err) {
              expect(err.message).toContain("private or internal IP address");
              resolve();
            } else {
              reject(new Error("Should have blocked loopback IP"));
            }
          } catch (e) {
            reject(e);
          }
        });
      });
    });
  });

  describe("SEC-R3-03: Webhook URL SSRF Defense (validateWebhook)", () => {
    const dummyWorkspace = {
      id: "ws_test_123",
      defaultProgramId: "prog_test_123",
    };
    const dummyUser = { id: "usr_test_123" } as any;

    it("rejects loopback and localhost webhook URLs", async () => {
      const loopbacks = [
        "http://127.0.0.1:9000/webhook",
        "http://localhost:8080/events",
        "http://[::1]:3000/hook",
      ];

      for (const url of loopbacks) {
        await expect(assertSafeWebhookUrl(url)).rejects.toThrow(DubApiError);
        await expect(
          validateWebhook({
            input: { url },
            workspace: dummyWorkspace,
            user: dummyUser,
          }),
        ).rejects.toThrow(DubApiError);
      }
    });

    it("rejects RFC 1918 private subnets for webhook targets", async () => {
      const privateWebhooks = [
        "http://10.0.0.1/hook",
        "http://172.16.1.1/webhook",
        "http://192.168.1.50:8080/hook",
      ];

      for (const url of privateWebhooks) {
        await expect(assertSafeWebhookUrl(url)).rejects.toThrow(DubApiError);
      }
    });

    it("rejects AWS / Cloud metadata endpoint for webhook targets", async () => {
      const metadata = "http://169.254.169.254/latest/meta-data";
      await expect(assertSafeWebhookUrl(metadata)).rejects.toThrow(DubApiError);
    });

    it("rejects unresolvable domains for webhook targets", async () => {
      const lookupSpy = vi
        .spyOn(dns, "lookup")
        .mockRejectedValueOnce(new Error("ENOTFOUND"));

      await expect(
        assertSafeWebhookUrl("http://unresolvable-target.test/webhook"),
      ).rejects.toThrow(DubApiError);
      lookupSpy.mockRestore();
    });

    it("allows valid public webhook targets", async () => {
      const lookupSpy = vi
        .spyOn(dns, "lookup")
        .mockResolvedValueOnce([
          { address: "93.184.216.34", family: 4 },
        ] as any);

      await expect(
        assertSafeWebhookUrl(
          "https://webhook.site/00000000-0000-0000-0000-000000000000",
        ),
      ).resolves.toBeUndefined();
      lookupSpy.mockRestore();
    });
  });

  describe("SEC-R3-04: Stored XSS Hygiene in Shopify Catalog Sync", () => {
    it("strips malicious script tags from product descriptions", () => {
      const dirty =
        "<p>Product Intro</p><script>alert('XSS')</script><strong>Premium Quality</strong>";
      const cleaned = sanitizeProductDescriptionHtml(dirty);
      expect(cleaned).not.toContain("<script>");
      expect(cleaned).not.toContain("alert");
      expect(cleaned).toContain("<p>Product Intro</p>");
      expect(cleaned).toContain("<strong>Premium Quality</strong>");
    });

    it("strips event handlers (onerror, onload, onclick, onmouseover)", () => {
      const dirty =
        '<img src="x" onerror="alert(1)"><div onclick="steal()">Click me</div>';
      const cleaned = sanitizeProductDescriptionHtml(dirty);
      expect(cleaned).not.toContain("onerror");
      expect(cleaned).not.toContain("onclick");
      expect(cleaned).not.toContain("alert");
      expect(cleaned).toContain("Click me");
    });

    it("strips javascript: and data: pseudo-protocols on links", () => {
      const dirty =
        '<a href="javascript:alert(document.cookie)">Click for discount</a>';
      const cleaned = sanitizeProductDescriptionHtml(dirty);
      expect(cleaned).not.toContain("javascript:");
      expect(cleaned).not.toContain("alert");
    });

    it("neutralizes UI overlay phishing (position: fixed / absolute and high z-index)", () => {
      const overlayDirty =
        '<div style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 99999; background: red;">Overlay</div>';
      const cleaned = sanitizeProductDescriptionHtml(overlayDirty);
      expect(cleaned).not.toContain("position: fixed");
      expect(cleaned).not.toContain("position:fixed");
      expect(cleaned).not.toContain("z-index: 99999");
      expect(cleaned).not.toContain("z-index:99999");
    });

    it("strips Tailwind class overlay attributes", () => {
      const tailwindOverlay =
        '<div class="fixed inset-0 z-50 bg-black/80">Phishing Modal</div>';
      const cleaned = sanitizeProductDescriptionHtml(tailwindOverlay);
      expect(cleaned).not.toContain('class="fixed');
      expect(cleaned).not.toContain("fixed inset-0");
    });

    it("preserves standard Yamax activewear formatting and responsive Size Guide table", () => {
      const yamaxHero =
        "<p>Find the perfect balance of weightless freedom and high-impact support. Engineered with our ultra-thin Yenergy™ fabric.</p>" +
        "<ul>" +
        "<li><strong>Non-Slip Waistband</strong>: High-tension composite waist design.</li>" +
        "<li><strong>Flattering Glute Contours</strong>: Elegant curved back seams.</li>" +
        "</ul>";

      const cleanedHero = sanitizeProductDescriptionHtml(yamaxHero);
      expect(cleanedHero).toContain("Yenergy™ fabric");
      expect(cleanedHero).toContain("<strong>Non-Slip Waistband</strong>");
      expect(cleanedHero).toContain("<ul>");
      expect(cleanedHero).toContain("<li>");

      const yamaxSizeGuide =
        '<div style="overflow-x: auto; max-width: 100%; position: relative;">' +
        '<table style="width: 100%; border-collapse: collapse;">' +
        "<thead>" +
        "<tr>" +
        '<th style="padding: 10px; position: sticky; left: 0px; z-index: 1;">Size</th>' +
        '<th style="padding: 10px;">Length</th>' +
        "</tr>" +
        "</thead>" +
        "<tbody>" +
        "<tr>" +
        '<td style="padding: 10px; position: sticky; left: 0px; z-index: 1;">S</td>' +
        '<td style="padding: 10px;">84 cm</td>' +
        "</tr>" +
        "</tbody>" +
        "</table>" +
        "</div>";

      const cleanedGuide = sanitizeProductDescriptionHtml(yamaxSizeGuide);
      expect(cleanedGuide).toContain("position:sticky");
      expect(cleanedGuide).toContain("z-index:1");
      expect(cleanedGuide).toContain("overflow-x:auto");
      expect(cleanedGuide).toContain("<table");
      expect(cleanedGuide).toContain("84 cm");
    });

    it("handles null, undefined, and empty string gracefully", () => {
      expect(sanitizeProductDescriptionHtml(null)).toBe("");
      expect(sanitizeProductDescriptionHtml(undefined)).toBe("");
      expect(sanitizeProductDescriptionHtml("")).toBe("");
      expect(sanitizeProductDescriptionHtml("   \n\t  ")).toBe("");
    });
  });
});
