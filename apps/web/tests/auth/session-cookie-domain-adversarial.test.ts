import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getSessionCookieDomain } from "@/lib/auth/session-cookie";

describe("Adversarial Stress-Testing: getSessionCookieDomain()", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.VERCEL_ENV;
    delete process.env.NEXT_PUBLIC_VERCEL_ENV;
    delete process.env.VERCEL_URL;
    delete process.env.NEXT_PUBLIC_APP_DOMAIN;
    delete process.env.NEXTAUTH_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("1. Preview Environments & Vercel Branch Invariants", () => {
    it("returns undefined when VERCEL_ENV='preview' regardless of custom domain", () => {
      expect(
        getSessionCookieDomain({
          vercelEnv: "preview",
          appDomain: "https://app.weletic.com",
        }),
      ).toBeUndefined();
      expect(
        getSessionCookieDomain({
          vercelEnv: "preview",
          appDomain: "https://store.example.com.vn",
        }),
      ).toBeUndefined();
      expect(
        getSessionCookieDomain({
          vercelEnv: "preview",
          nextAuthUrl: "https://auth.weletic.co.uk",
        }),
      ).toBeUndefined();
    });

    it.fails(
      "demonstrates defect: uppercase VERCEL_ENV ('Preview' or 'PREVIEW') bypasses preview check",
      () => {
        // VercelEnv is checked strictly via === "preview" rather than .toLowerCase() === "preview"
        expect(
          getSessionCookieDomain({
            vercelEnv: "Preview",
            appDomain: "https://app.weletic.com",
          }),
        ).toBeUndefined();
      },
    );

    it("returns undefined when NEXT_PUBLIC_VERCEL_ENV='preview'", () => {
      expect(
        getSessionCookieDomain({
          nextPublicVercelEnv: "preview",
          appDomain: "https://app.weletic.com",
        }),
      ).toBeUndefined();
    });

    it("returns undefined for various VERCEL_URL preview patterns", () => {
      const previewVercelUrls = [
        "weletic-git-codex-review-p0-fixes.vercel.app",
        "weletic-web-preview-git-feature.vercel.app",
        "project-pr-1234.vercel.app",
        "my-branch-preview.vercel.app",
        "team-project-abc1234.vercel.app",
      ];

      for (const vercelUrl of previewVercelUrls) {
        expect(
          getSessionCookieDomain({
            vercelUrl,
            appDomain: "https://app.weletic.com",
          }),
        ).toBeUndefined();
      }
    });

    it("returns undefined when appDomain itself is on *.vercel.app even if vercelEnv is not set", () => {
      const vercelDomains = [
        "https://weletic-git-main.vercel.app",
        "https://weletic.vercel.app",
        "weletic.vercel.app",
        "subdomain.preview.vercel.app",
        "http://staging.vercel.app:3000",
      ];

      for (const domain of vercelDomains) {
        expect(
          getSessionCookieDomain({
            appDomain: domain,
          }),
        ).toBeUndefined();
      }
    });

    it("guarantees preview never produces a leading-dot apex domain", () => {
      const domains = [
        "https://app.weletic.com",
        "https://weletic.co.uk",
        "https://store.example.com.vn",
        "https://preview.weletic.com",
      ];
      for (const appDomain of domains) {
        const result = getSessionCookieDomain({
          vercelEnv: "preview",
          appDomain,
        });
        expect(result).toBeUndefined();
        expect(typeof result).not.toBe("string");
      }
    });
  });

  describe("2. Localhost, Loopback, Docker, and IP Address Literals", () => {
    it("returns undefined for all localhost variations and ports", () => {
      const localhostVariants = [
        "localhost",
        "localhost:3000",
        "http://localhost",
        "http://localhost:3000",
        "https://localhost:8888",
        "http://app.localhost:8888",
        "http://admin.localhost:3000",
        "nested.sub.localhost:8080",
        "http://localhost/login",
      ];

      for (const variant of localhostVariants) {
        expect(
          getSessionCookieDomain({ appDomain: variant }),
          `Failed on variant: ${variant}`,
        ).toBeUndefined();
      }
    });

    it("returns undefined for IPv4 addresses (public, private, loopback)", () => {
      const ipv4Variants = [
        "127.0.0.1",
        "http://127.0.0.1",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:8888",
        "192.168.1.1",
        "http://192.168.1.100:8000",
        "10.0.0.1",
        "http://10.0.0.1:3000",
        "172.16.0.1",
        "http://172.20.0.5:4000",
        "0.0.0.0",
        "http://0.0.0.0:3000",
      ];

      for (const variant of ipv4Variants) {
        expect(
          getSessionCookieDomain({ appDomain: variant }),
          `Failed on IPv4: ${variant}`,
        ).toBeUndefined();
      }
    });

    it("returns undefined for IPv6 addresses", () => {
      const ipv6Variants = [
        "http://[::1]:3000",
        "[::1]",
        "http://[2001:db8::1]:8080",
        "[fe80::1]",
      ];

      for (const variant of ipv6Variants) {
        expect(
          getSessionCookieDomain({ appDomain: variant }),
          `Failed on IPv6: ${variant}`,
        ).toBeUndefined();
      }
    });

    it("returns undefined for internal Docker/K8s service names without dots", () => {
      const internalServices = [
        "web",
        "http://web:3000",
        "api-service",
        "http://auth-backend:8080",
        "weletic-app",
      ];

      for (const service of internalServices) {
        expect(
          getSessionCookieDomain({ appDomain: service }),
          `Failed on internal service: ${service}`,
        ).toBeUndefined();
      }
    });
  });

  describe("3. Multi-level ccTLD Domain Parsing", () => {
    it("handles .co.uk domains correctly", () => {
      expect(
        getSessionCookieDomain({ appDomain: "https://app.weletic.co.uk" }),
      ).toBe(".weletic.co.uk");
      expect(getSessionCookieDomain({ appDomain: "app.weletic.co.uk" })).toBe(
        ".weletic.co.uk",
      );
      expect(
        getSessionCookieDomain({
          appDomain: "https://deep.nested.sub.weletic.co.uk",
        }),
      ).toBe(".weletic.co.uk");
      expect(
        getSessionCookieDomain({ appDomain: "https://weletic.co.uk" }),
      ).toBe(".weletic.co.uk");
    });

    it("handles .com.vn domains correctly", () => {
      expect(
        getSessionCookieDomain({ appDomain: "store.example.com.vn" }),
      ).toBe(".example.com.vn");
      expect(
        getSessionCookieDomain({
          appDomain: "https://store.example.com.vn:8080",
        }),
      ).toBe(".example.com.vn");
      expect(
        getSessionCookieDomain({ appDomain: "https://example.com.vn" }),
      ).toBe(".example.com.vn");
    });

    it("handles other standard second-level ccTLD combinations (.com.au, .org.uk, .net.au, .edu.au, .gov.uk, .co.in)", () => {
      expect(
        getSessionCookieDomain({ appDomain: "https://portal.yamax.com.au" }),
      ).toBe(".yamax.com.au");
      expect(
        getSessionCookieDomain({
          appDomain: "https://admin.partner.weletic.org.uk",
        }),
      ).toBe(".weletic.org.uk");
      expect(
        getSessionCookieDomain({ appDomain: "https://app.weletic.net.au" }),
      ).toBe(".weletic.net.au");
      expect(
        getSessionCookieDomain({ appDomain: "https://store.yamax.edu.au" }),
      ).toBe(".yamax.edu.au");
      expect(
        getSessionCookieDomain({ appDomain: "https://service.corp.gov.uk" }),
      ).toBe(".corp.gov.uk");
      expect(
        getSessionCookieDomain({ appDomain: "https://app.weletic.co.in" }),
      ).toBe(".weletic.co.in");
    });

    it.fails(
      "demonstrates defect: non-whitelisted ccTLD second level 'ac.uk' leaks registry suffix '.ac.uk'",
      () => {
        // Because SECOND_LEVEL_DOMAINS does not contain "ac", extractApexDomain slices -2
        // returning "ac.uk" instead of "oxford.ac.uk", resulting in invalid cookie domain ".ac.uk".
        expect(
          getSessionCookieDomain({ appDomain: "https://app.oxford.ac.uk" }),
        ).toBe(".oxford.ac.uk");
      },
    );

    it.fails(
      "demonstrates defect: non-whitelisted ccTLD second level 'ne.jp' leaks registry suffix '.ne.jp'",
      () => {
        // Because SECOND_LEVEL_DOMAINS does not contain "ne", extractApexDomain slices -2
        // returning "ne.jp" instead of "service.ne.jp", resulting in invalid cookie domain ".ne.jp".
        expect(
          getSessionCookieDomain({ appDomain: "https://app.service.ne.jp" }),
        ).toBe(".service.ne.jp");
      },
    );

    it("distinguishes single-level ccTLDs (.in, .io, .co) from second-level combinations", () => {
      // .in is single-level ccTLD
      expect(
        getSessionCookieDomain({ appDomain: "https://dashboard.weletic.in" }),
      ).toBe(".weletic.in");
      // .co is single-level ccTLD
      expect(getSessionCookieDomain({ appDomain: "https://app.dub.co" })).toBe(
        ".dub.co",
      );
      // .io is single-level ccTLD
      expect(
        getSessionCookieDomain({ appDomain: "https://app.weletic.io" }),
      ).toBe(".weletic.io");
    });

    it("handles standard gTLDs with deep subdomains", () => {
      expect(
        getSessionCookieDomain({
          appDomain: "https://deep.staging.app.weletic.com",
        }),
      ).toBe(".weletic.com");
      expect(
        getSessionCookieDomain({ appDomain: "https://room.yamax.com" }),
      ).toBe(".yamax.com");
      expect(getSessionCookieDomain({ appDomain: "https://weletic.com" })).toBe(
        ".weletic.com",
      );
    });
  });

  describe("4. Ports, Paths, and Protocol Permutations", () => {
    it("strips port from domain and extracts apex with leading dot", () => {
      expect(
        getSessionCookieDomain({ appDomain: "https://app.weletic.com:8080" }),
      ).toBe(".weletic.com");
      expect(
        getSessionCookieDomain({ appDomain: "http://app.weletic.com:3000" }),
      ).toBe(".weletic.com");
      expect(
        getSessionCookieDomain({ appDomain: "app.weletic.com:8443" }),
      ).toBe(".weletic.com");
      expect(
        getSessionCookieDomain({
          appDomain: "https://app.weletic.co.uk:443",
        }),
      ).toBe(".weletic.co.uk");
      expect(
        getSessionCookieDomain({
          appDomain: "store.example.com.vn:8000",
        }),
      ).toBe(".example.com.vn");
    });

    it("strips paths, query strings, and hashes from NEXTAUTH_URL", () => {
      expect(
        getSessionCookieDomain({
          nextAuthUrl: "https://app.weletic.com/api/auth",
        }),
      ).toBe(".weletic.com");
      expect(
        getSessionCookieDomain({
          nextAuthUrl: "https://app.weletic.com/login?callbackUrl=%2Fdashboard",
        }),
      ).toBe(".weletic.com");
      expect(
        getSessionCookieDomain({
          nextAuthUrl: "https://app.weletic.com/#section",
        }),
      ).toBe(".weletic.com");
    });
  });

  describe("5. Case Sensitivity and Whitespace Resilience", () => {
    it("handles uppercase and mixed-case domain names", () => {
      expect(getSessionCookieDomain({ appDomain: "APP.WELETIC.COM" })).toBe(
        ".weletic.com",
      );
      expect(
        getSessionCookieDomain({ appDomain: "https://APP.WELETIC.COM" }),
      ).toBe(".weletic.com");
      expect(
        getSessionCookieDomain({
          appDomain: "https://Store.Example.COM.VN:8080",
        }),
      ).toBe(".example.com.vn");
      expect(getSessionCookieDomain({ appDomain: "ROOM.YAMAX.COM" })).toBe(
        ".yamax.com",
      );
    });

    it.fails(
      "demonstrates defect: fails on leading whitespace due to untrimmed string in URL constructor",
      () => {
        // Because rawDomain is not trimmed, rawDomain.startsWith("http") is false,
        // creating "https://  app.weletic.com  ", which throws TypeError in URL parser
        // and silently falls back to undefined instead of the expected ".weletic.com".
        expect(
          getSessionCookieDomain({ appDomain: "  app.weletic.com  " }),
        ).toBe(".weletic.com");
      },
    );

    it("handles trailing whitespace and trailing slashes", () => {
      expect(
        getSessionCookieDomain({ appDomain: "https://app.weletic.com/ " }),
      ).toBe(".weletic.com");
    });
  });

  describe("6. Edge Cases, Missing Variables, and Malformed Inputs", () => {
    it("returns undefined when no environment variables or options are provided", () => {
      expect(getSessionCookieDomain()).toBeUndefined();
      expect(getSessionCookieDomain({})).toBeUndefined();
    });

    it("returns undefined for standard invalid strings", () => {
      expect(getSessionCookieDomain({ appDomain: "" })).toBeUndefined();
      expect(getSessionCookieDomain({ appDomain: "   " })).toBeUndefined();
      expect(
        getSessionCookieDomain({ appDomain: ":::bad-url:::" }),
      ).toBeUndefined();
      expect(
        getSessionCookieDomain({ appDomain: "invalid_domain" }),
      ).toBeUndefined();
    });

    it.fails(
      "demonstrates defect: malformed dot string '.' produces invalid cookie domain '..'",
      () => {
        // Due to missing DNS label validation in extractApexDomain, "." splits into ["", ""]
        // and returns ".." which is an illegal RFC 6265 cookie domain.
        expect(getSessionCookieDomain({ appDomain: "." })).toBeUndefined();
      },
    );

    it.fails(
      "demonstrates defect: double-dot string '..' produces invalid cookie domain '..'",
      () => {
        expect(getSessionCookieDomain({ appDomain: ".." })).toBeUndefined();
      },
    );

    it.fails(
      "demonstrates defect: public suffix 'co.uk' returns '.co.uk' without apex label",
      () => {
        expect(getSessionCookieDomain({ appDomain: "co.uk" })).toBeUndefined();
      },
    );

    it("falls back through NEXT_PUBLIC_APP_DOMAIN -> NEXTAUTH_URL", () => {
      process.env.NEXTAUTH_URL = "https://app.weletic.com";
      expect(getSessionCookieDomain()).toBe(".weletic.com");

      process.env.NEXT_PUBLIC_APP_DOMAIN = "https://app.override.com";
      expect(getSessionCookieDomain()).toBe(".override.com");
    });
  });
});
