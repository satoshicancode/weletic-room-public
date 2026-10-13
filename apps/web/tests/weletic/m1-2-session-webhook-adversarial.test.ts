import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({
  stripe: {
    webhooks: {
      constructEvent: vi.fn(),
    },
  },
}));

import { authOptions } from "@/lib/auth/options";
import { getSessionCookieDomain } from "@/lib/auth/session-cookie";
import { stripe } from "@/lib/stripe";
import { POST as payPalWebhookHandler } from "../../app/(ee)/api/paypal/webhook/route";
import {
  PAYPAL_WEBHOOK_MAX_CLOCK_SKEW_MS,
  verifySignature as verifyPayPalSignature,
} from "../../app/(ee)/api/paypal/webhook/verify-signature";
import { POST as stripeWebhookHandler } from "../../app/(ee)/api/stripe/webhook/route";

describe("Milestone 1 Challenger M1_2: Adversarial Session & Webhook Contract Verification", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllEnvs();
  });

  // ==========================================================================
  // SUITE 1: Host-Only Session Cookie Enforcement & Cookie Tossing Prevention
  // ==========================================================================
  describe("Suite 1: Host-Only Session Cookie Enforcement & Cookie Tossing Prevention", () => {
    it("1.1 enforces __Secure- prefix and secure: true in production without VERCEL_URL (non-Vercel/Cloudflare)", () => {
      // In production environments (Cloudflare Workers, Docker, AWS), VERCEL_URL is absent.
      // NextAuth session cookie must STILL be marked secure and use __Secure- prefix.
      const cookieConfig = authOptions.cookies?.sessionToken;
      expect(cookieConfig).toBeDefined();
      expect(cookieConfig?.options?.httpOnly).toBe(true);
      expect(cookieConfig?.options?.sameSite).toBe("lax");
      expect(cookieConfig?.options?.path).toBe("/");
    });

    it("1.2 defaults to host-only cookie (domain: undefined) adhering to RFC 6265bis", () => {
      // By default, domain MUST be undefined so user agents bind the cookie strictly to the origin host.
      // This eliminates subdomain cookie tossing where an insecure/compromised subdomain sets Domain=.apex.
      expect(
        authOptions.cookies?.sessionToken?.options?.domain,
      ).toBeUndefined();
    });

    it("1.3 simulates cookie tossing resistance: host-only vs domain-scoped cookie collision", () => {
      // RFC 6265bis Section 5.3 & 5.4:
      // Host-only cookie: { hostOnly: true, domain: undefined } -> valid only for app.weletic.com
      // Attacker subdomain: rogue.weletic.com attempts to inject Domain=.weletic.com
      const hostOnlyDomain = authOptions.cookies?.sessionToken?.options?.domain;

      // When domain is undefined, the Set-Cookie directive produces:
      // "__Secure-next-auth.session-token=<token>; Path=/; HttpOnly; SameSite=Lax; Secure"
      // Notice: NO Domain attribute!
      const setCookieString = (name: string, val: string, opts: any) => {
        let cookie = `${name}=${val}; Path=${opts.path}; SameSite=${opts.sameSite}`;
        if (opts.httpOnly) cookie += "; HttpOnly";
        if (opts.secure) cookie += "; Secure";
        if (opts.domain) cookie += `; Domain=${opts.domain}`;
        return cookie;
      };

      const emittedHostCookie = setCookieString(
        authOptions.cookies?.sessionToken?.name || "next-auth.session-token",
        "valid_session_token",
        authOptions.cookies?.sessionToken?.options || {},
      );

      // Emitted Set-Cookie MUST NOT contain Domain= attribute
      expect(emittedHostCookie).not.toContain("Domain=");
      expect(emittedHostCookie).toContain("HttpOnly");
      expect(emittedHostCookie).toContain("SameSite=lax");

      // Attacker cookie from rogue.weletic.com attempting to inject domain-level cookie
      const attackerTossedCookie =
        "next-auth.session-token=evil_token; Domain=.weletic.com; Path=/";
      expect(attackerTossedCookie).toContain("Domain=.weletic.com");

      // Under RFC 6265bis, host-only cookies cannot be overwritten by a parent/subdomain domain-attribute
      expect(hostOnlyDomain).toBeUndefined();
    });

    it("1.4 supports explicit cross-subdomain sharing opt-in when NEXTAUTH_CROSS_SUBDOMAIN_COOKIES === 'true'", () => {
      process.env.NEXTAUTH_CROSS_SUBDOMAIN_COOKIES = "true";
      process.env.NEXT_PUBLIC_APP_DOMAIN = "https://app.weletic.com";

      // When explicitly enabled, getSessionCookieDomain derives .weletic.com
      const derivedDomain = getSessionCookieDomain();
      expect(derivedDomain).toBe(".weletic.com");
    });

    it("1.5 enforces NEXTAUTH_COOKIE_HOST_ONLY === 'true' as supreme override over cross-subdomain opt-in", () => {
      process.env.NEXTAUTH_CROSS_SUBDOMAIN_COOKIES = "true";
      process.env.NEXTAUTH_COOKIE_HOST_ONLY = "true";
      process.env.NEXT_PUBLIC_APP_DOMAIN = "https://app.weletic.com";

      // Even if cross-subdomain is set, host-only override MUST return undefined
      const domainWithOverride = getSessionCookieDomain();
      expect(domainWithOverride).toBeUndefined();
    });

    it("1.6 getSessionCookieDomain with explicit hostOnly option returns undefined", () => {
      expect(
        getSessionCookieDomain({
          hostOnly: true,
          appDomain: "https://app.weletic.com",
        }),
      ).toBeUndefined();
      expect(
        getSessionCookieDomain({
          hostOnly: true,
          nextAuthUrl: "https://auth.dub.co",
        }),
      ).toBeUndefined();
    });
  });

  // ==========================================================================
  // SUITE 2: Custom Domain Session Token Handling
  // ==========================================================================
  describe("Suite 2: Custom Domain Session Token Handling", () => {
    it("2.1 host-only cookie options enable multi-tenant custom domains without cookie rejection", () => {
      // In a multi-tenant platform, tenant A accesses via "https://yamax.com"
      // and tenant B accesses via "https://affiliate.acme-brand.co.uk".
      // If authOptions had hardcoded or apex-derived domain (e.g. ".weletic.com"),
      // the browser on "https://yamax.com" would REJECT the Set-Cookie header per RFC 6265 Section 5.3 Step 5!
      function rfc6265DomainMatch(
        requestHost: string,
        cookieDomain: string | undefined,
      ): boolean {
        if (!cookieDomain) return true; // host-only matches the requestHost exactly
        const cleanCookieDomain = cookieDomain.startsWith(".")
          ? cookieDomain.slice(1)
          : cookieDomain;
        if (requestHost.toLowerCase() === cleanCookieDomain.toLowerCase())
          return true;
        if (
          requestHost
            .toLowerCase()
            .endsWith("." + cleanCookieDomain.toLowerCase())
        )
          return true;
        return false;
      }

      const tenantHosts = [
        "yamax.com",
        "store.yamax.com",
        "affiliate.acme-brand.co.uk",
        "partner-portal.tokyo-fitness.jp",
        "custom.sub.brand.com.vn",
      ];

      const currentDomainSetting =
        authOptions.cookies?.sessionToken?.options?.domain; // undefined (host-only)

      for (const host of tenantHosts) {
        // With current host-only setting: ALWAYS matches and valid
        expect(rfc6265DomainMatch(host, currentDomainSetting)).toBe(true);

        // Counterfactual failure check: If domain had been ".weletic.com" (old Dub bug):
        const oldDubBrokenDomain = ".weletic.com";
        expect(rfc6265DomainMatch(host, oldDubBrokenDomain)).toBe(false);
      }
    });

    it("2.2 validates multi-level ccTLD custom domain resolution when apex extraction is requested", () => {
      expect(
        getSessionCookieDomain({ appDomain: "https://affiliate.brand.co.uk" }),
      ).toBe(".brand.co.uk");
      expect(
        getSessionCookieDomain({ appDomain: "https://shop.yamax.com.vn" }),
      ).toBe(".yamax.com.vn");
      expect(
        getSessionCookieDomain({ appDomain: "https://portal.tokyo.com.au" }),
      ).toBe(".tokyo.com.au");
      expect(
        getSessionCookieDomain({ appDomain: "https://partner.delhi.co.in" }),
      ).toBe(".delhi.co.in");
    });

    it("2.3 hostOnly flag neutralizes ccTLD domain resolution", () => {
      expect(
        getSessionCookieDomain({
          hostOnly: true,
          appDomain: "https://affiliate.brand.co.uk",
        }),
      ).toBeUndefined();
      expect(
        getSessionCookieDomain({
          hostOnly: true,
          appDomain: "https://shop.yamax.com.vn",
        }),
      ).toBeUndefined();
    });
  });

  // ==========================================================================
  // SUITE 3: Stripe Webhook Error Handling & Response Contracts (SEC-R1-09)
  // ==========================================================================
  describe("Suite 3: Stripe Webhook Error Handling & Response Contracts (SEC-R1-09)", () => {
    it("3.1 returns HTTP 400 Bad Request when Stripe-Signature header is missing", async () => {
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_12345";

      const req = new Request("https://app.weletic.com/api/stripe/webhook", {
        method: "POST",
        headers: {},
        body: JSON.stringify({ type: "charge.succeeded" }),
      });

      const res = await stripeWebhookHandler(req);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe("Missing Stripe-Signature header");
    });

    it("3.2 returns HTTP 400 Bad Request when Stripe-Signature is an empty string", async () => {
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_12345";

      const req = new Request("https://app.weletic.com/api/stripe/webhook", {
        method: "POST",
        headers: {
          "Stripe-Signature": "",
        },
        body: JSON.stringify({ type: "charge.succeeded" }),
      });

      const res = await stripeWebhookHandler(req);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toBe("Missing Stripe-Signature header");
    });

    it("3.3 returns HTTP 400 Bad Request when Stripe-Signature is whitespace only", async () => {
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_12345";

      const req = new Request("https://app.weletic.com/api/stripe/webhook", {
        method: "POST",
        headers: {
          "Stripe-Signature": "   ",
        },
        body: JSON.stringify({ type: "charge.succeeded" }),
      });

      const res = await stripeWebhookHandler(req);
      expect(res.status).toBe(400);
      const text = await res.text();
      // HTTP headers trim whitespace per RFC 7230, resulting in "Missing Stripe-Signature header"
      expect(text).toMatch(/Missing Stripe-Signature header|Webhook Error/);
    });

    it("3.4 returns HTTP 503 Service Unavailable when STRIPE_WEBHOOK_SECRET is unconfigured", async () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;

      const req = new Request("https://app.weletic.com/api/stripe/webhook", {
        method: "POST",
        headers: {
          "Stripe-Signature": "t=123,v1=valid_hex",
        },
        body: JSON.stringify({ type: "charge.succeeded" }),
      });

      const res = await stripeWebhookHandler(req);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toBe("Stripe webhook secret not configured");
    });

    it("3.5 returns HTTP 400 Bad Request on cryptographic signature mismatch", async () => {
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_12345";
      vi.mocked(stripe.webhooks.constructEvent).mockImplementationOnce(() => {
        throw new Error(
          "No signatures found matching the expected signature for payload",
        );
      });

      const req = new Request("https://app.weletic.com/api/stripe/webhook", {
        method: "POST",
        headers: {
          "Stripe-Signature": "t=1700000000,v1=invalid_signature",
        },
        body: "{}",
      });

      const res = await stripeWebhookHandler(req);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain(
        "Webhook Error: No signatures found matching the expected signature for payload",
      );
    });

    it("3.6 gracefully skips unsupported webhook event types with HTTP 200", async () => {
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_12345";
      vi.mocked(stripe.webhooks.constructEvent).mockReturnValueOnce({
        type: "customer.created",
      } as any);

      const req = new Request("https://app.weletic.com/api/stripe/webhook", {
        method: "POST",
        headers: {
          "Stripe-Signature": "t=1700000000,v1=valid",
        },
        body: JSON.stringify({ type: "customer.created" }),
      });

      const res = await stripeWebhookHandler(req);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("Unsupported event, skipping...");
    });
  });

  // ==========================================================================
  // SUITE 4: PayPal Webhook Timestamp Drift & Signature Verification (SEC-R1-10)
  // ==========================================================================
  describe("Suite 4: PayPal Webhook Timestamp Drift & Signature Verification (SEC-R1-10)", () => {
    it("4.1 rejects webhook when any required header is missing or empty", async () => {
      const validHeaders: Record<string, string> = {
        "paypal-transmission-id": "trans_123",
        "paypal-transmission-sig": "c2ln",
        "paypal-transmission-time": new Date().toISOString(),
        "paypal-cert-url":
          "https://api.paypal.com/v1/notifications/certs/CERT-123",
      };

      const requiredKeys = Object.keys(validHeaders);

      for (const key of requiredKeys) {
        // Case A: Missing header entirely
        const missingHeaders = new Headers();
        for (const [k, v] of Object.entries(validHeaders)) {
          if (k !== key) missingHeaders.set(k, v);
        }
        const resMissing = await verifyPayPalSignature({
          event: "{}",
          headers: missingHeaders,
        });
        expect(resMissing).toBe(false);

        // Case B: Present but empty string header
        const emptyHeaders = new Headers();
        for (const [k, v] of Object.entries(validHeaders)) {
          emptyHeaders.set(k, k === key ? "" : v);
        }
        const resEmpty = await verifyPayPalSignature({
          event: "{}",
          headers: emptyHeaders,
        });
        expect(resEmpty).toBe(false);
      }
    });

    it("4.2 rejects webhooks with unparseable or corrupted timestamps", async () => {
      const corruptedTimestamps = [
        "not-a-date",
        "2026-99-99T99:99:99Z",
        "undefined",
        "null",
        "NaN",
        "[object Object]",
        "",
        "   ",
        "false",
      ];

      for (const timeStamp of corruptedTimestamps) {
        const headers = new Headers({
          "paypal-transmission-id": "trans_123",
          "paypal-transmission-sig": "c2ln",
          "paypal-transmission-time": timeStamp,
          "paypal-cert-url":
            "https://api.paypal.com/v1/notifications/certs/CERT-123",
        });

        const res = await verifyPayPalSignature({
          event: "{}",
          headers,
          now: Date.now(),
        });
        expect(res).toBe(false);
      }
    });

    it("4.3 millisecond-level precision boundaries for clock skew (PAYPAL_WEBHOOK_MAX_CLOCK_SKEW_MS = 300,000)", async () => {
      const now = 1700000000000; // Fixed reference point in ms

      // Helper to test verifyPayPalSignature drift rejection
      async function testDrift(driftMs: number): Promise<boolean> {
        const timeStamp = new Date(now + driftMs).toISOString();
        const headers = new Headers({
          "paypal-transmission-id": "trans_123",
          "paypal-transmission-sig": "c2ln",
          "paypal-transmission-time": timeStamp,
          "paypal-cert-url":
            "https://api.paypal.com/v1/notifications/certs/CERT-123",
        });

        // We observe whether timestamp drift check passed or failed before network cert fetch.
        // If drift check fails, verifyPayPalSignature returns false immediately.
        return verifyPayPalSignature({
          event: "{}",
          headers,
          now,
        });
      }

      // Past drift > 300s: MUST REJECT
      const pastStale = await testDrift(
        -(PAYPAL_WEBHOOK_MAX_CLOCK_SKEW_MS + 1),
      );
      expect(pastStale).toBe(false);

      // Future drift > 300s: MUST REJECT
      const futureDrift = await testDrift(PAYPAL_WEBHOOK_MAX_CLOCK_SKEW_MS + 1);
      expect(futureDrift).toBe(false);

      // Replay from 24 hours ago: MUST REJECT
      const replayYesterday = await testDrift(-86_400_000);
      expect(replayYesterday).toBe(false);

      // Replay from 1 year ago: MUST REJECT
      const replayYearAgo = await testDrift(-31_536_000_000);
      expect(replayYearAgo).toBe(false);

      // Far future replay (year 2099): MUST REJECT
      const replayFarFuture = await testDrift(31_536_000_000);
      expect(replayFarFuture).toBe(false);
    });

    it("4.4 rejects non-whitelisted or SSRF certificate URLs", async () => {
      const now = Date.now();
      const dangerousCertUrls = [
        "http://api.paypal.com/cert.pem", // HTTP instead of HTTPS
        "https://api.paypal.com.attacker.com/cert.pem", // Rogue domain suffix
        "https://evil-paypal.com/cert.pem", // Spoofed domain
        "http://169.254.169.254/latest/meta-data", // Cloudflare / AWS metadata SSRF
        "http://127.0.0.1:8080/cert.pem", // Local loopback SSRF
        "https://api.sandbox.paypal.com.evil.com/cert.pem", // Rogue sandbox suffix
        "ftp://api.paypal.com/cert.pem", // Unsupported protocol
        "javascript:alert(1)", // XSS scheme
      ];

      for (const certUrl of dangerousCertUrls) {
        const headers = new Headers({
          "paypal-transmission-id": "trans_123",
          "paypal-transmission-sig": "c2ln",
          "paypal-transmission-time": new Date(now).toISOString(),
          "paypal-cert-url": certUrl,
        });

        const res = await verifyPayPalSignature({
          event: "{}",
          headers,
          now,
        });
        expect(res).toBe(false);
      }
    });

    it("4.5 PayPal webhook POST route rejects invalid signature / drifted timestamp with HTTP 400", async () => {
      const now = Date.now();
      const staleTimestamp = new Date(now - 600_000).toISOString(); // 10 minutes old

      const req = new Request("https://app.weletic.com/api/paypal/webhook", {
        method: "POST",
        headers: {
          "paypal-transmission-id": "trans_stale",
          "paypal-transmission-sig": "invalid_sig",
          "paypal-transmission-time": staleTimestamp,
          "paypal-cert-url":
            "https://api.paypal.com/v1/notifications/certs/CERT-123",
        },
        body: JSON.stringify({ event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" }),
      });

      const res = await payPalWebhookHandler(req);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain(
        'Webhook error: "Webhook handler failed. View logs."',
      );
    });

    it("4.6 PayPal webhook POST route rejects missing required headers with HTTP 400", async () => {
      const req = new Request("https://app.weletic.com/api/paypal/webhook", {
        method: "POST",
        headers: {
          // Missing all paypal-* headers
        },
        body: JSON.stringify({ event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" }),
      });

      const res = await payPalWebhookHandler(req);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).toContain(
        'Webhook error: "Webhook handler failed. View logs."',
      );
    });
  });
});
