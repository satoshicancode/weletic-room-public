import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { authOptions } from "@/lib/auth/options";
import { getSessionCookieDomain } from "@/lib/auth/session-cookie";

describe("SEC-04: Dynamic Session Cookie Domain in NextAuth", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clean environment variables before each test
    delete process.env.VERCEL_ENV;
    delete process.env.NEXT_PUBLIC_VERCEL_ENV;
    delete process.env.VERCEL_URL;
    delete process.env.NEXT_PUBLIC_APP_DOMAIN;
    delete process.env.NEXTAUTH_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("Preview Environments (Host-Only Cookie per RFC 6265)", () => {
    it("returns undefined when VERCEL_ENV is 'preview'", () => {
      process.env.VERCEL_ENV = "preview";
      process.env.NEXT_PUBLIC_APP_DOMAIN = "https://app.weletic.com";

      expect(getSessionCookieDomain()).toBeUndefined();
    });

    it("returns undefined when NEXT_PUBLIC_VERCEL_ENV is 'preview'", () => {
      process.env.NEXT_PUBLIC_VERCEL_ENV = "preview";
      process.env.NEXT_PUBLIC_APP_DOMAIN = "https://app.weletic.com";

      expect(getSessionCookieDomain()).toBeUndefined();
    });

    it("returns undefined when VERCEL_URL contains a preview vercel.app domain", () => {
      process.env.VERCEL_URL = "weletic-preview-git-branch-team.vercel.app";
      process.env.NEXT_PUBLIC_APP_DOMAIN = "https://weletic-preview.vercel.app";

      expect(getSessionCookieDomain()).toBeUndefined();
    });

    it("returns undefined when VERCEL_URL contains preview pattern and VERCEL_ENV is not production", () => {
      process.env.VERCEL_URL = "dub-git-feat-preview-dub.vercel.app";

      expect(getSessionCookieDomain()).toBeUndefined();
    });

    it("returns undefined when customEnv specifies preview", () => {
      expect(
        getSessionCookieDomain({
          vercelEnv: "preview",
          appDomain: "https://app.weletic.com",
        }),
      ).toBeUndefined();
    });
  });

  describe("Localhost, Loopback, and IP Addresses (RFC 6265 Host-Only)", () => {
    it("returns undefined for http://localhost:3000", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "http://localhost:3000";
      expect(getSessionCookieDomain()).toBeUndefined();
    });

    it("returns undefined for raw 'localhost'", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "localhost";
      expect(getSessionCookieDomain()).toBeUndefined();
    });

    it("returns undefined for subdomains on localhost (app.localhost:8890)", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "http://app.localhost:8890";
      expect(getSessionCookieDomain()).toBeUndefined();
    });

    it("returns undefined for IPv4 addresses (127.0.0.1:3000)", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "http://127.0.0.1:3000";
      expect(getSessionCookieDomain()).toBeUndefined();
    });

    it("returns undefined for private network IPv4 addresses (192.168.1.100)", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "http://192.168.1.100:8888";
      expect(getSessionCookieDomain()).toBeUndefined();
    });

    it("returns undefined for IPv6 loopback (::1)", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "http://[::1]:3000";
      expect(getSessionCookieDomain()).toBeUndefined();
    });
  });

  describe("Production Custom Domains (Apex Domain Extraction with Leading Dot)", () => {
    it("extracts apex domain from https://app.weletic.com -> .weletic.com", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "https://app.weletic.com";
      expect(getSessionCookieDomain()).toBe(".weletic.com");
    });

    it("extracts apex domain from protocol-less app.weletic.com -> .weletic.com", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "app.weletic.com";
      expect(getSessionCookieDomain()).toBe(".weletic.com");
    });

    it("extracts apex domain from https://app.dub.co -> .dub.co", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "https://app.dub.co";
      expect(getSessionCookieDomain()).toBe(".dub.co");
    });

    it("extracts apex domain from app.dub.co -> .dub.co", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "app.dub.co";
      expect(getSessionCookieDomain()).toBe(".dub.co");
    });

    it("extracts apex domain from room.yamax.com -> .yamax.com", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "https://room.yamax.com";
      expect(getSessionCookieDomain()).toBe(".yamax.com");
    });

    it("extracts apex domain from admin.weletic.com -> .weletic.com", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "https://admin.weletic.com";
      expect(getSessionCookieDomain()).toBe(".weletic.com");
    });

    it("extracts apex domain from root apex domain https://weletic.com -> .weletic.com", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "https://weletic.com";
      expect(getSessionCookieDomain()).toBe(".weletic.com");
    });

    it("supports customEnv parameter override", () => {
      expect(
        getSessionCookieDomain({
          appDomain: "https://partners.weletic.com",
        }),
      ).toBe(".weletic.com");
    });
  });

  describe("Fallback & Resilience Handling", () => {
    it("falls back to NEXTAUTH_URL when NEXT_PUBLIC_APP_DOMAIN is not provided", () => {
      process.env.NEXTAUTH_URL = "https://app.weletic.com";
      expect(getSessionCookieDomain()).toBe(".weletic.com");
    });

    it("returns undefined when neither NEXT_PUBLIC_APP_DOMAIN nor NEXTAUTH_URL is set", () => {
      expect(getSessionCookieDomain()).toBeUndefined();
    });

    it("returns undefined when domain is empty string", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "";
      expect(getSessionCookieDomain()).toBeUndefined();
    });

    it("returns undefined gracefully for malformed input without throwing", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = ":::invalid-url:::";
      expect(getSessionCookieDomain()).toBeUndefined();
    });

    it("returns undefined for single-part hostnames without dots (e.g. internal docker service)", () => {
      process.env.NEXT_PUBLIC_APP_DOMAIN = "http://internal-web:3000";
      expect(getSessionCookieDomain()).toBeUndefined();
    });
  });

  describe("NextAuth authOptions Integration", () => {
    it("configures sessionToken cookie options with dynamic domain resolver", () => {
      expect(authOptions.cookies?.sessionToken?.options).toBeDefined();
      expect(authOptions.cookies?.sessionToken?.options?.httpOnly).toBe(true);
      expect(authOptions.cookies?.sessionToken?.options?.sameSite).toBe("lax");
      expect(authOptions.cookies?.sessionToken?.options?.path).toBe("/");
    });
  });
});
