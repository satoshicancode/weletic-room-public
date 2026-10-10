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

import dnsCallback, { promises as dns } from "dns";
import {
  assertSafeIp as assertSafeMetatagsIp,
  assertSafeFetchUrl,
  getHtml,
  pinnedMetatagsDnsMap,
} from "../../app/api/links/metatags/utils";
import {
  assertSafeIp as assertSafeDomainIp,
  assertSafeUrl,
  hasSiteConfigured,
  pinnedDnsMap,
} from "../../app/api/domains/[domain]/validate/utils";
import {
  assertSafeWebhookUrl,
  validateWebhook,
} from "@/lib/webhook/validate-webhook";
import { DubApiError } from "@/lib/api/errors";

describe("Adversarial Challenger M3: SSRF & DNS Rebinding Stress Test", () => {
  describe("Suite 1: Robustly Defended Vectors (Pass Verification)", () => {
    it("1.1 blocks octal, hex, dword, and shorthand IPv4 bypasses across all validators", async () => {
      const bypasses = [
        "http://0177.0.0.1",
        "http://0x7f.0.0.1",
        "http://2130706433",
        "http://0x7f000001",
        "http://127.1",
        "http://012.0.0.1",
        "http://0xa.0.0.1",
        "http://167772161",
        "http://2852039166",
        "http://0251.0376.0251.0376",
        "http://0xa9.0xfe.0xa9.0xfe",
        "http://3232235521",
        "http://2886729729",
      ];

      for (const url of bypasses) {
        await expect(assertSafeFetchUrl(url), `assertSafeFetchUrl failed to block ${url}`).rejects.toThrow();
        await expect(assertSafeUrl(url), `assertSafeUrl failed to block ${url}`).rejects.toThrow();
        await expect(assertSafeWebhookUrl(url), `assertSafeWebhookUrl failed to block ${url}`).rejects.toThrow();
      }
    });

    it("1.2 blocks direct bracketed standard IPv6 formats", async () => {
      const ipv6List = [
        "http://[::1]",
        "http://[::]",
        "http://[::ffff:127.0.0.1]",
        "http://[::ffff:7f00:1]",
        "http://[::ffff:169.254.169.254]",
        "http://[::ffff:a9fe:a9fe]",
        "http://[fd00:ec2::254]",
        "http://[fe80::1]",
        "http://[fc00::1]",
      ];

      for (const url of ipv6List) {
        await expect(assertSafeFetchUrl(url), `assertSafeFetchUrl failed to block ${url}`).rejects.toThrow();
        await expect(assertSafeUrl(url), `assertSafeUrl failed to block ${url}`).rejects.toThrow();
        await expect(assertSafeWebhookUrl(url), `assertSafeWebhookUrl failed to block ${url}`).rejects.toThrow();
      }
    });

    it("1.3 blocks cloud metadata domains, internal TLDs, and non-http schemes", async () => {
      const invalidUrls = [
        "http://metadata.google.internal/computeMetadata/v1/",
        "http://instance-data/latest/meta-data",
        "http://aws.internal/secret",
        "http://server.local/admin",
        "http://nas.home.arpa/keys",
        "ftp://example.com/file",
        "file:///etc/passwd",
        "gopher://evil.com",
      ];

      for (const url of invalidUrls) {
        await expect(assertSafeFetchUrl(url), `assertSafeFetchUrl failed to block ${url}`).rejects.toThrow();
        await expect(assertSafeUrl(url), `assertSafeUrl failed to block ${url}`).rejects.toThrow();
        await expect(assertSafeWebhookUrl(url), `assertSafeWebhookUrl failed to block ${url}`).rejects.toThrow();
      }
    });

    it("1.4 blocks multi-record DNS lookups containing private IPs alongside public IPs", async () => {
      const mixedLookups = [
        [
          { address: "93.184.216.34", family: 4 },
          { address: "127.0.0.1", family: 4 },
        ],
        [
          { address: "93.184.216.34", family: 4 },
          { address: "169.254.169.254", family: 4 },
        ],
        [
          { address: "93.184.216.34", family: 4 },
          { address: "::1", family: 6 },
        ],
      ];

      for (const records of mixedLookups) {
        const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValue(records as any);

        await expect(assertSafeFetchUrl("http://mixed-dns.com")).rejects.toThrow();
        await expect(assertSafeUrl("http://mixed-dns.com")).rejects.toThrow();
        await expect(assertSafeWebhookUrl("http://mixed-dns.com")).rejects.toThrow();

        lookupSpy.mockRestore();
      }
    });

    it("1.5 pins outbound socket to safe IP and prevents TTL=0 rebinding during fetch", async () => {
      let lookupCount = 0;
      const lookupSpy = vi.spyOn(dns, "lookup").mockImplementation(async () => {
        lookupCount++;
        if (lookupCount === 1) return [{ address: "93.184.216.34", family: 4 }] as any;
        return [{ address: "127.0.0.1", family: 4 }] as any;
      });

      const { hostname, safeIp } = await assertSafeFetchUrl("http://rebinding-test.com");
      expect(hostname).toBe("rebinding-test.com");
      expect(safeIp).toBe("93.184.216.34");

      pinnedMetatagsDnsMap.set(hostname, safeIp);

      await new Promise<void>((resolve, reject) => {
        dnsCallback.lookup("rebinding-test.com", (err, address) => {
          if (err) return reject(err);
          try {
            expect(address).toBe("93.184.216.34");
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });

      pinnedMetatagsDnsMap.delete(hostname);
      lookupSpy.mockRestore();
    });
  });

  describe("Suite 2: HTTP 301/302 Redirect SSRF Defense in getHtml", () => {
    it("blocks HTTP 302 redirects targeting 169.254.169.254 and internal resources", async () => {
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as any);

      let followedRedirectToInternal = false;

      // Intercept fetch to inspect options passed by fetchWithTimeout in getHtml
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
        const targetUrl = typeof input === "string" ? input : input.url;

        if (targetUrl === "http://legitimate-attacker.com/preview") {
          const redirectMode = init?.redirect;
          if (redirectMode !== "manual") {
            followedRedirectToInternal = true;
            return new Response("ami-id: ami-0123456789abcdef0\ninstance-type: t3.large", {
              status: 200,
              headers: { "content-type": "text/html" },
            });
          } else {
            return new Response("", {
              status: 302,
              headers: { Location: "http://169.254.169.254/latest/meta-data" },
            });
          }
        }

        if (targetUrl.includes("169.254.169.254")) {
          followedRedirectToInternal = true;
          return new Response("ami-id: ami-0123456789abcdef0", { status: 200 });
        }

        return new Response("OK", { status: 200 });
      });

      // Fetching url that redirects to metadata should throw DubApiError (bad_request) fail-closed
      await expect(getHtml("http://legitimate-attacker.com/preview")).rejects.toThrow(DubApiError);

      lookupSpy.mockRestore();
      fetchSpy.mockRestore();

      // Ensure fetch never connected to the internal metadata service
      expect(followedRedirectToInternal).toBe(false);
    });

    it("blocks HTTP 302 redirects targeting loopback 127.0.0.1", async () => {
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
      ] as any);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
        const targetUrl = typeof input === "string" ? input : input.url;
        if (targetUrl === "http://legitimate-attacker.com/redirect-to-loopback") {
          return new Response("", {
            status: 302,
            headers: { Location: "http://127.0.0.1:8080/internal-secrets" },
          });
        }
        return new Response("OK", { status: 200 });
      });

      await expect(
        getHtml("http://legitimate-attacker.com/redirect-to-loopback"),
      ).rejects.toThrow(DubApiError);

      lookupSpy.mockRestore();
      fetchSpy.mockRestore();
    });
  });

  describe("Suite 3: Canonical & Alternative IPv6 Formats Defense in assertSafeIp", () => {
    it("rejects uncompressed IPv6 loopback (0:0:0:0:0:0:0:1) and uncompressed IPv4-mapped addresses", () => {
      const bypassIps = [
        { ip: "0:0:0:0:0:0:0:1", desc: "uncompressed IPv6 loopback" },
        { ip: "0000:0000:0000:0000:0000:0000:0000:0001", desc: "full 32-char IPv6 loopback" },
        { ip: "0:0:0:0:0:ffff:127.0.0.1", desc: "uncompressed IPv4-mapped loopback" },
        { ip: "0:0:0:0:0:ffff:169.254.169.254", desc: "uncompressed IPv4-mapped AWS metadata" },
      ];

      for (const { ip, desc } of bypassIps) {
        let metatagsThrew = false;
        try {
          assertSafeMetatagsIp(ip);
        } catch {
          metatagsThrew = true;
        }

        let domainThrew = false;
        try {
          assertSafeDomainIp(ip);
        } catch {
          domainThrew = true;
        }

        expect(
          metatagsThrew,
          `Expected ${desc} (${ip}) to throw DubApiError in assertSafeMetatagsIp`,
        ).toBe(true);
        expect(
          domainThrew,
          `Expected ${desc} (${ip}) to throw Error in assertSafeDomainIp`,
        ).toBe(true);
      }
    });
  });
});
