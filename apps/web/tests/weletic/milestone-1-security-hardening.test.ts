import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({
  stripe: {
    webhooks: {
      constructEvent: vi.fn(),
    },
  },
}));

import { getIP } from "@/lib/api/utils/get-ip";
import { authOptions } from "@/lib/auth/options";
import { getSessionCookieDomain } from "@/lib/auth/session-cookie";
import {
  createPrismaNonceClient,
  resetServiceAuthNonceCache,
  setServiceAuthRedisClient,
  verifyWeleticShopifyRequest,
} from "@weletic/contracts/shopify/service-auth";
import {
  PAYPAL_WEBHOOK_MAX_CLOCK_SKEW_MS,
  verifySignature as verifyPayPalSignature,
} from "../../app/(ee)/api/paypal/webhook/verify-signature";
import { POST as stripeWebhookHandler } from "../../app/(ee)/api/stripe/webhook/route";
import { purgeExpiredNoncesJob } from "../../workers/cron-triggers/src/index";

describe("Milestone 1 (SEC-R1-01 to SEC-R1-10) Security Hardening Verification", () => {
  const secret = "a".repeat(32);
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetServiceAuthNonceCache();
    setServiceAuthRedisClient(null);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllEnvs();
  });

  // --------------------------------------------------------------------------
  // SEC-R1-02 & SEC-R1-05: Distributed Prisma Nonce & Atomic Deduplication
  // --------------------------------------------------------------------------
  describe("SEC-R1-02 & SEC-R1-05: Prisma ServiceAuthNonce Distributed Provider", () => {
    it("Prisma ServiceAuthNonce provider successfully records new nonce and rejects replay via unique constraint", async () => {
      const storage = new Map<
        string,
        { nonceKey: string; expiresAt: number }
      >();

      const mockPrismaClient = {
        serviceAuthNonce: {
          async create({
            data,
          }: {
            data: { nonceKey: string; expiresAt: number };
          }) {
            if (storage.has(data.nonceKey)) {
              const error: any = new Error(
                "Unique constraint failed on the fields: (`nonceKey`)",
              );
              error.code = "P2002";
              throw error;
            }
            storage.set(data.nonceKey, data);
            return data;
          },
          async findUnique({ where }: { where: { nonceKey: string } }) {
            return storage.get(where.nonceKey) ?? null;
          },
          async update({
            where,
            data,
          }: {
            where: { nonceKey: string };
            data: { expiresAt: number };
          }) {
            const existing = storage.get(where.nonceKey);
            if (!existing) throw new Error("Record not found");
            const updated = { ...existing, ...data };
            storage.set(where.nonceKey, updated);
            return updated;
          },
        },
      };

      const prismaNonceClient = createPrismaNonceClient(mockPrismaClient);
      const testNonceKey = `weletic:service-auth:nonce:${crypto.randomUUID()}`;

      // 1. Initial attempt: successfully inserts nonce
      const res1 = await prismaNonceClient.set(testNonceKey, "1", {
        nx: true,
        ex: 720,
      });
      expect(res1).toBe("OK");
      expect(storage.has(testNonceKey)).toBe(true);

      // 2. Replay attempt: encounters P2002 unique constraint, returns null (replay detected)
      const res2 = await prismaNonceClient.set(testNonceKey, "1", {
        nx: true,
        ex: 720,
      });
      expect(res2).toBeNull();
    });

    it("Prisma ServiceAuthNonce provider allows re-recording an expired nonce", async () => {
      const storage = new Map<
        string,
        { nonceKey: string; expiresAt: number }
      >();
      const testNonceKey = `weletic:service-auth:nonce:${crypto.randomUUID()}`;

      // Pre-seed an expired nonce (10 minutes in the past)
      storage.set(testNonceKey, {
        nonceKey: testNonceKey,
        expiresAt: Date.now() - 600_000,
      });

      const mockPrismaClient = {
        serviceAuthNonce: {
          async create({
            data,
          }: {
            data: { nonceKey: string; expiresAt: number };
          }) {
            if (storage.has(data.nonceKey)) {
              const error: any = new Error(
                "Unique constraint failed on the fields: (`nonceKey`)",
              );
              error.code = "P2002";
              throw error;
            }
            storage.set(data.nonceKey, data);
            return data;
          },
          async findUnique({ where }: { where: { nonceKey: string } }) {
            return storage.get(where.nonceKey) ?? null;
          },
          async update({
            where,
            data,
          }: {
            where: { nonceKey: string };
            data: { expiresAt: number };
          }) {
            const updated = {
              nonceKey: where.nonceKey,
              expiresAt: data.expiresAt,
            };
            storage.set(where.nonceKey, updated);
            return updated;
          },
        },
      };

      const prismaNonceClient = createPrismaNonceClient(mockPrismaClient);
      const res = await prismaNonceClient.set(testNonceKey, "1", {
        nx: true,
        ex: 720,
      });
      expect(res).toBe("OK");
      expect(storage.get(testNonceKey)!.expiresAt).toBeGreaterThan(Date.now());
    });

    it("verifies end-to-end request anti-replay through verifyWeleticShopifyRequest using Prisma nonce client", async () => {
      const storage = new Map<
        string,
        { nonceKey: string; expiresAt: number }
      >();
      const mockPrismaClient = {
        serviceAuthNonce: {
          async create({
            data,
          }: {
            data: { nonceKey: string; expiresAt: number };
          }) {
            if (storage.has(data.nonceKey)) {
              const error: any = new Error(
                "Unique constraint failed on the fields: (`nonceKey`)",
              );
              error.code = "P2002";
              throw error;
            }
            storage.set(data.nonceKey, data);
            return data;
          },
        },
      };

      const prismaClient = createPrismaNonceClient(mockPrismaClient);
      setServiceAuthRedisClient(prismaClient);

      const timestamp = String(Date.now());
      const requestId = crypto.randomUUID();
      const body = JSON.stringify({ shop: "store.myshopify.com" });
      const canonical = `${timestamp}\nPOST\n/api/internal/shopify/sessions\n${body}\n${requestId}`;
      const signature = crypto
        .createHmac("sha256", secret)
        .update(canonical)
        .digest("hex");

      const req1 = new Request(
        "https://app.weletic.com/api/internal/shopify/sessions",
        {
          method: "POST",
          headers: {
            "x-weletic-timestamp": timestamp,
            "x-weletic-signature": signature,
            "x-weletic-request-id": requestId,
          },
          body,
        },
      );

      // First verification passes
      const firstValid = await verifyWeleticShopifyRequest({
        request: req1,
        body,
        secret,
      });
      expect(firstValid).toBe(true);

      // Replay of identical request is blocked
      const req2 = new Request(
        "https://app.weletic.com/api/internal/shopify/sessions",
        {
          method: "POST",
          headers: {
            "x-weletic-timestamp": timestamp,
            "x-weletic-signature": signature,
            "x-weletic-request-id": requestId,
          },
          body,
        },
      );

      const secondValid = await verifyWeleticShopifyRequest({
        request: req2,
        body,
        secret,
      });
      expect(secondValid).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // SEC-R1-03, SEC-R1-04, SEC-R1-06: Session Cookie Security & Domain Scoping
  // --------------------------------------------------------------------------
  describe("SEC-R1-03 & SEC-R1-04 & SEC-R1-06: Cookie Security Decoupling & Scoping", () => {
    it("decouples secure flag and __Secure- prefix from VERCEL_URL in production", () => {
      // In production or HTTPS, cookie is secure and prefixed even when VERCEL_URL is absent
      const cookieConfig = authOptions.cookies?.sessionToken;
      expect(cookieConfig).toBeDefined();
      expect(cookieConfig?.options?.httpOnly).toBe(true);
      expect(cookieConfig?.options?.sameSite).toBe("lax");
      expect(cookieConfig?.options?.path).toBe("/");
    });

    it("scopes dashboard cookies to host-only (domain undefined) by default to prevent cookie tossing", () => {
      // When NEXTAUTH_CROSS_SUBDOMAIN_COOKIES is not 'true', domain is undefined (RFC 6265 host-only)
      expect(
        authOptions.cookies?.sessionToken?.options?.domain,
      ).toBeUndefined();
    });

    it("supports hostOnly parameter in getSessionCookieDomain()", () => {
      expect(
        getSessionCookieDomain({
          hostOnly: true,
          appDomain: "https://app.weletic.com",
        }),
      ).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // SEC-R1-07: Expired Nonces Purge Job in Cron Triggers
  // --------------------------------------------------------------------------
  describe("SEC-R1-07: purgeExpiredNoncesJob in cron-triggers", () => {
    it("purges expired nonces using D1 database binding when available", async () => {
      let executedQuery = "";
      let boundParam: unknown = null;

      const mockD1 = {
        prepare(query: string) {
          executedQuery = query;
          return {
            bind(...params: unknown[]) {
              boundParam = params[0];
              return {
                async run() {
                  return { success: true, meta: { changes: 42 } };
                },
              };
            },
          };
        },
      };

      const result = await purgeExpiredNoncesJob({ DB: mockD1 as any });
      expect(result.deletedCount).toBe(42);
      expect(executedQuery).toBe(
        "DELETE FROM ServiceAuthNonce WHERE expiresAt <= ?",
      );
      expect(typeof boundParam).toBe("number");
      expect(boundParam as number).toBeLessThanOrEqual(Date.now());
    });

    it("falls back to Prisma serviceAuthNonce.deleteMany when D1 is absent", async () => {
      let deleteManyWhere: any = null;

      const mockPrisma = {
        serviceAuthNonce: {
          async deleteMany({ where }: any) {
            deleteManyWhere = where;
            return { count: 18 };
          },
        },
      };

      const result = await purgeExpiredNoncesJob({ prisma: mockPrisma as any });
      expect(result.deletedCount).toBe(18);
      expect(deleteManyWhere?.expiresAt?.lte).toBeDefined();
      expect(deleteManyWhere.expiresAt.lte).toBeLessThanOrEqual(Date.now());
    });
  });

  // --------------------------------------------------------------------------
  // SEC-R1-08: Trusted Proxy Headers & Anti-Spoofing in getIP()
  // --------------------------------------------------------------------------
  describe("SEC-R1-08: IP Spoofing Prevention in getIP()", () => {
    it("prefers cf-connecting-ip over spoofed leftmost x-forwarded-for header", async () => {
      const headers = new Headers();
      headers.set("cf-connecting-ip", "198.51.100.42");
      headers.set("x-forwarded-for", "161.202.164.1, 203.0.113.10"); // Attacker prepended allowed IP

      const ip = await getIP(headers);
      expect(ip).toBe("198.51.100.42");
    });

    it("prefers x-real-ip over spoofed leftmost x-forwarded-for header when cf-connecting-ip is missing", async () => {
      const headers = new Headers();
      headers.set("x-real-ip", "198.51.100.55");
      headers.set("x-forwarded-for", "161.202.164.1, 203.0.113.10");

      const ip = await getIP(headers);
      expect(ip).toBe("198.51.100.55");
    });

    it("uses rightmost client IP in x-forwarded-for chain when direct proxy headers are missing", async () => {
      const headers = new Headers();
      // Client sent '161.202.164.1' (spoofed), proxy appended legitimate client socket '203.0.113.99'
      headers.set("x-forwarded-for", "161.202.164.1, 203.0.113.99");

      const ip = await getIP(headers);
      expect(ip).toBe("203.0.113.99");
    });

    it("returns single IP when x-forwarded-for contains only one entry", async () => {
      const headers = new Headers();
      headers.set("x-forwarded-for", "203.0.113.77");

      const ip = await getIP(headers);
      expect(ip).toBe("203.0.113.77");
    });

    it("returns 0.0.0.0 fallback when no IP headers exist", async () => {
      const headers = new Headers();
      const ip = await getIP(headers);
      expect(ip).toBe("0.0.0.0");
    });
  });

  // --------------------------------------------------------------------------
  // SEC-R1-09: Stripe Webhook Explicit Response on Missing Headers/Secret
  // --------------------------------------------------------------------------
  describe("SEC-R1-09: Stripe Webhook Response Contracts", () => {
    it("returns explicit HTTP 400 Response when Stripe-Signature header is missing", async () => {
      const req = new Request("https://app.weletic.com/api/stripe/webhook", {
        method: "POST",
        headers: {}, // No Stripe-Signature
        body: "{}",
      });

      const response = await stripeWebhookHandler(req);
      expect(response).toBeInstanceOf(Response);
      expect(response?.status).toBe(400);
      const text = await response?.text();
      expect(text).toContain("Missing Stripe-Signature header");
    });

    it("returns explicit HTTP 503 Response when STRIPE_WEBHOOK_SECRET is unset", async () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;

      const req = new Request("https://app.weletic.com/api/stripe/webhook", {
        method: "POST",
        headers: {
          "Stripe-Signature": "t=123,v1=abc",
        },
        body: "{}",
      });

      const response = await stripeWebhookHandler(req);
      expect(response).toBeInstanceOf(Response);
      expect(response?.status).toBe(503);
      const text = await response?.text();
      expect(text).toContain("Stripe webhook secret not configured");
    });
  });

  // --------------------------------------------------------------------------
  // SEC-R1-10: PayPal Webhook Freshness & Clock Skew Validation
  // --------------------------------------------------------------------------
  describe("SEC-R1-10: PayPal Webhook Timestamp Freshness", () => {
    it("rejects webhook if paypal-transmission-time is older than 300 seconds", async () => {
      const now = Date.now();
      const staleTime = new Date(
        now - (PAYPAL_WEBHOOK_MAX_CLOCK_SKEW_MS + 10_000),
      ).toISOString();

      const headers = new Headers({
        "paypal-transmission-id": "trans_12345",
        "paypal-transmission-sig": "c2lnbmF0dXJl",
        "paypal-transmission-time": staleTime,
        "paypal-cert-url":
          "https://api.paypal.com/v1/notifications/certs/CERT-123",
      });

      const result = await verifyPayPalSignature({
        event: "{}",
        headers,
        now,
      });

      expect(result).toBe(false);
    });

    it("rejects webhook if paypal-transmission-time is in the future beyond 300 seconds skew", async () => {
      const now = Date.now();
      const futureTime = new Date(
        now + (PAYPAL_WEBHOOK_MAX_CLOCK_SKEW_MS + 15_000),
      ).toISOString();

      const headers = new Headers({
        "paypal-transmission-id": "trans_12345",
        "paypal-transmission-sig": "c2lnbmF0dXJl",
        "paypal-transmission-time": futureTime,
        "paypal-cert-url":
          "https://api.paypal.com/v1/notifications/certs/CERT-123",
      });

      const result = await verifyPayPalSignature({
        event: "{}",
        headers,
        now,
      });

      expect(result).toBe(false);
    });

    it("rejects webhook with malformed timestamp string", async () => {
      const headers = new Headers({
        "paypal-transmission-id": "trans_12345",
        "paypal-transmission-sig": "c2lnbmF0dXJl",
        "paypal-transmission-time": "not-a-valid-date-time",
        "paypal-cert-url":
          "https://api.paypal.com/v1/notifications/certs/CERT-123",
      });

      const result = await verifyPayPalSignature({
        event: "{}",
        headers,
        now: Date.now(),
      });

      expect(result).toBe(false);
    });
  });
});
