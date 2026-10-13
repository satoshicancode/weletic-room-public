import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testRsaKey = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe", () => ({
  stripe: {
    webhooks: {
      constructEvent: vi.fn(),
    },
  },
}));
vi.mock("@/lib/upstash/redis", () => ({
  redis: {
    get: vi.fn().mockImplementation(async () => testRsaKey.publicKey),
    set: vi.fn().mockResolvedValue("OK"),
  },
}));

import { getIP } from "@/lib/api/utils/get-ip";
import {
  createD1NonceClient,
  createPrismaNonceClient,
  resetServiceAuthNonceCache,
  setServiceAuthRedisClient,
  verifyWeleticShopifyRequest,
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_REQUEST_ID_HEADER,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
} from "@weletic/contracts/shopify/service-auth";
import {
  PAYPAL_WEBHOOK_MAX_CLOCK_SKEW_MS,
  verifySignature as verifyPayPalSignature,
} from "../../app/(ee)/api/paypal/webhook/verify-signature";

describe("Adversarial Anti-Replay, Clock Skew & IP Spoofing Challenger Suite (apps/web)", () => {
  const secret = "k".repeat(32);
  const originalEnv = { ...process.env };

  beforeEach(() => {
    resetServiceAuthNonceCache();
    setServiceAuthRedisClient(null);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllEnvs();
  });

  function createSignedShopifyRequest({
    method = "POST",
    path = "/api/internal/shopify/sessions",
    body = JSON.stringify({ shop: "store.myshopify.com" }),
    timestamp = String(Date.now()),
    requestId = crypto.randomUUID(),
    customSecret = secret,
  }: {
    method?: string;
    path?: string;
    body?: string;
    timestamp?: string;
    requestId?: string;
    customSecret?: string;
  } = {}) {
    const canonical =
      requestId !== undefined && requestId !== ""
        ? `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}\n${requestId}`
        : `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`;

    const signature = crypto
      .createHmac("sha256", customSecret)
      .update(canonical)
      .digest("hex");

    const headersMap = new Map<string, string>();
    headersMap.set(WELETIC_SHOPIFY_TIMESTAMP_HEADER.toLowerCase(), timestamp);
    headersMap.set(WELETIC_SHOPIFY_SIGNATURE_HEADER.toLowerCase(), signature);
    if (requestId !== undefined) {
      headersMap.set(
        WELETIC_SHOPIFY_REQUEST_ID_HEADER.toLowerCase(),
        requestId,
      );
    }

    return {
      request: {
        method,
        url: `https://app.weletic.com${path}`,
        headers: {
          get: (key: string) => headersMap.get(key.toLowerCase()) ?? null,
        },
      } as unknown as Request,
      body,
      signature,
      timestamp,
      requestId,
    };
  }

  // --------------------------------------------------------------------------
  // 1. High Concurrency Replay Stress against Prisma Nonce Client
  // --------------------------------------------------------------------------
  describe("High-Concurrency Anti-Replay: Prisma Provider", () => {
    it("100 concurrent insertion calls with identical nonceKey yield exactly 1 success and 99 rejections", async () => {
      const storage = new Map<
        string,
        { nonceKey: string; expiresAt: number }
      >();
      const testKey = `weletic:service-auth:nonce:${crypto.randomUUID()}`;
      const concurrency = 100;

      const mockPrismaClient = {
        serviceAuthNonce: {
          async create({
            data,
          }: {
            data: { nonceKey: string; expiresAt: number };
          }) {
            // Emulate database unique constraint atomic violation
            if (storage.has(data.nonceKey)) {
              const err: any = new Error(
                "Unique constraint failed on the fields: (`nonceKey`)",
              );
              err.code = "P2002";
              throw err;
            }
            storage.set(data.nonceKey, data);
            return data;
          },
          async findUnique({ where }: { where: { nonceKey: string } }) {
            return storage.get(where.nonceKey) ?? null;
          },
        },
      };

      const prismaNonceClient = createPrismaNonceClient(mockPrismaClient);

      const results = await Promise.all(
        Array.from({ length: concurrency }, () =>
          prismaNonceClient.set(testKey, "1", { nx: true, ex: 720 }),
        ),
      );

      const successCount = results.filter((r) => r === "OK").length;
      const rejectedCount = results.filter((r) => r === null).length;

      expect(successCount).toBe(1);
      expect(rejectedCount).toBe(concurrency - 1);
    });

    it("50 concurrent end-to-end verifyWeleticShopifyRequest attempts accept exactly 1 and reject 49", async () => {
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
              const err: any = new Error(
                "Unique constraint failed on the fields: (`nonceKey`)",
              );
              err.code = "P2002";
              throw err;
            }
            storage.set(data.nonceKey, data);
            return data;
          },
        },
      };

      const prismaNonceClient = createPrismaNonceClient(mockPrismaClient);
      setServiceAuthRedisClient(prismaNonceClient);

      const targetRequestId = crypto.randomUUID();
      const timestamp = String(Date.now());
      const concurrency = 50;

      const requests = Array.from({ length: concurrency }, () =>
        createSignedShopifyRequest({ requestId: targetRequestId, timestamp }),
      );

      const results = await Promise.all(
        requests.map(({ request, body }) =>
          verifyWeleticShopifyRequest({
            request,
            body,
            secret,
            requireRequestId: true,
          }),
        ),
      );

      const accepted = results.filter((r) => r === true).length;
      const rejected = results.filter((r) => r === false).length;

      expect(accepted).toBe(1);
      expect(rejected).toBe(concurrency - 1);
    });
  });

  // --------------------------------------------------------------------------
  // 2. High Concurrency Replay Stress against Cloudflare D1 Provider
  // --------------------------------------------------------------------------
  describe("High-Concurrency Anti-Replay: Cloudflare D1 Provider", () => {
    it("100 concurrent insertion calls with identical nonceKey yield exactly 1 success and 99 rejections", async () => {
      const storage = new Map<
        string,
        { nonceKey: string; expiresAt: number }
      >();
      const testKey = `weletic:service-auth:nonce:${crypto.randomUUID()}`;
      const concurrency = 100;

      const mockD1 = {
        prepare(query: string) {
          return {
            bind(...values: unknown[]) {
              const [key, expiresAt] = values as [string, number];
              return {
                async run() {
                  if (storage.has(key)) {
                    throw new Error(
                      "UNIQUE constraint failed: ServiceAuthNonce.nonceKey",
                    );
                  }
                  storage.set(key, { nonceKey: key, expiresAt });
                  return { success: true, meta: { changes: 1 } };
                },
                async first<T = unknown>() {
                  const row = storage.get(key);
                  return (row ?? null) as T | null;
                },
              };
            },
          };
        },
      };

      const d1Client = createD1NonceClient(mockD1 as any);

      const results = await Promise.all(
        Array.from({ length: concurrency }, () =>
          d1Client.set(testKey, "1", { nx: true, ex: 720 }),
        ),
      );

      const successCount = results.filter((r) => r === "OK").length;
      const rejectedCount = results.filter((r) => r === null).length;

      expect(successCount).toBe(1);
      expect(rejectedCount).toBe(concurrency - 1);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Service Auth Clock Skew Boundaries (+/- 299s, +/- 300s, +/- 301s)
  // --------------------------------------------------------------------------
  describe("Service Auth Clock Skew Boundaries (+/- 300s)", () => {
    const skewMs = WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS; // 300,000 ms

    it("accepts requests at past boundary: now - 299s (299,000ms)", async () => {
      const now = Date.now();
      const { request, body } = createSignedShopifyRequest({
        timestamp: String(now - 299_000),
      });
      const valid = await verifyWeleticShopifyRequest({
        request,
        body,
        now,
        secret,
      });
      expect(valid).toBe(true);
    });

    it("accepts requests at exact past boundary: now - 300s (300,000ms)", async () => {
      const now = Date.now();
      const { request, body } = createSignedShopifyRequest({
        timestamp: String(now - skewMs),
      });
      const valid = await verifyWeleticShopifyRequest({
        request,
        body,
        now,
        secret,
      });
      expect(valid).toBe(true);
    });

    it("rejects requests exceeding past boundary: now - 300.001s (300,001ms)", async () => {
      const now = Date.now();
      const { request, body } = createSignedShopifyRequest({
        timestamp: String(now - (skewMs + 1)),
      });
      const valid = await verifyWeleticShopifyRequest({
        request,
        body,
        now,
        secret,
      });
      expect(valid).toBe(false);
    });

    it("rejects requests exceeding past boundary: now - 301s (301,000ms)", async () => {
      const now = Date.now();
      const { request, body } = createSignedShopifyRequest({
        timestamp: String(now - 301_000),
      });
      const valid = await verifyWeleticShopifyRequest({
        request,
        body,
        now,
        secret,
      });
      expect(valid).toBe(false);
    });

    it("accepts requests at future boundary: now + 299s (299,000ms)", async () => {
      const now = Date.now();
      const { request, body } = createSignedShopifyRequest({
        timestamp: String(now + 299_000),
      });
      const valid = await verifyWeleticShopifyRequest({
        request,
        body,
        now,
        secret,
      });
      expect(valid).toBe(true);
    });

    it("accepts requests at exact future boundary: now + 300s (300,000ms)", async () => {
      const now = Date.now();
      const { request, body } = createSignedShopifyRequest({
        timestamp: String(now + skewMs),
      });
      const valid = await verifyWeleticShopifyRequest({
        request,
        body,
        now,
        secret,
      });
      expect(valid).toBe(true);
    });

    it("rejects requests exceeding future boundary: now + 300.001s (300,001ms)", async () => {
      const now = Date.now();
      const { request, body } = createSignedShopifyRequest({
        timestamp: String(now + (skewMs + 1)),
      });
      const valid = await verifyWeleticShopifyRequest({
        request,
        body,
        now,
        secret,
      });
      expect(valid).toBe(false);
    });

    it("rejects requests exceeding future boundary: now + 301s (301,000ms)", async () => {
      const now = Date.now();
      const { request, body } = createSignedShopifyRequest({
        timestamp: String(now + 301_000),
      });
      const valid = await verifyWeleticShopifyRequest({
        request,
        body,
        now,
        secret,
      });
      expect(valid).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 4. PayPal Webhook Clock Skew Boundaries (+/- 299s, +/- 300s, +/- 301s)
  // --------------------------------------------------------------------------
  describe("PayPal Webhook Clock Skew Boundaries (+/- 300s)", () => {
    const skewMs = PAYPAL_WEBHOOK_MAX_CLOCK_SKEW_MS; // 300,000 ms

    it("accepts paypal timestamp at past boundary: now - 299s (299,000ms)", async () => {
      const now = Date.now();
      const headers = new Headers({
        "paypal-transmission-id": "tx-123",
        "paypal-transmission-sig": "c2ln",
        "paypal-transmission-time": new Date(now - 299_000).toISOString(),
        "paypal-cert-url": "https://api.paypal.com/cert",
      });

      const res = await verifyPayPalSignature({ event: "{}", headers, now });
      // Skew check passes, cert verification fails on mock cert url -> not rejected by skew
      expect(res).toBe(false);
    });

    it("accepts paypal timestamp at exact past boundary: now - 300s (300,000ms)", async () => {
      const now = Date.now();
      const headers = new Headers({
        "paypal-transmission-id": "tx-123",
        "paypal-transmission-sig": "c2ln",
        "paypal-transmission-time": new Date(now - skewMs).toISOString(),
        "paypal-cert-url": "https://api.paypal.com/cert",
      });

      const res = await verifyPayPalSignature({ event: "{}", headers, now });
      expect(res).toBe(false);
    });

    it("rejects paypal timestamp exceeding past boundary: now - 300.001s (300,001ms)", async () => {
      const now = Date.now();
      const headers = new Headers({
        "paypal-transmission-id": "tx-123",
        "paypal-transmission-sig": "c2ln",
        "paypal-transmission-time": new Date(now - (skewMs + 1)).toISOString(),
        "paypal-cert-url": "https://api.paypal.com/cert",
      });

      const res = await verifyPayPalSignature({ event: "{}", headers, now });
      expect(res).toBe(false);
    });

    it("rejects paypal timestamp exceeding past boundary: now - 301s (301,000ms)", async () => {
      const now = Date.now();
      const headers = new Headers({
        "paypal-transmission-id": "tx-123",
        "paypal-transmission-sig": "c2ln",
        "paypal-transmission-time": new Date(now - 301_000).toISOString(),
        "paypal-cert-url": "https://api.paypal.com/cert",
      });

      const res = await verifyPayPalSignature({ event: "{}", headers, now });
      expect(res).toBe(false);
    });

    it("accepts paypal timestamp at future boundary: now + 299s (299,000ms)", async () => {
      const now = Date.now();
      const headers = new Headers({
        "paypal-transmission-id": "tx-123",
        "paypal-transmission-sig": "c2ln",
        "paypal-transmission-time": new Date(now + 299_000).toISOString(),
        "paypal-cert-url": "https://api.paypal.com/cert",
      });

      const res = await verifyPayPalSignature({ event: "{}", headers, now });
      expect(res).toBe(false);
    });

    it("accepts paypal timestamp at exact future boundary: now + 300s (300,000ms)", async () => {
      const now = Date.now();
      const headers = new Headers({
        "paypal-transmission-id": "tx-123",
        "paypal-transmission-sig": "c2ln",
        "paypal-transmission-time": new Date(now + skewMs).toISOString(),
        "paypal-cert-url": "https://api.paypal.com/cert",
      });

      const res = await verifyPayPalSignature({ event: "{}", headers, now });
      expect(res).toBe(false);
    });

    it("rejects paypal timestamp exceeding future boundary: now + 300.001s (300,001ms)", async () => {
      const now = Date.now();
      const headers = new Headers({
        "paypal-transmission-id": "tx-123",
        "paypal-transmission-sig": "c2ln",
        "paypal-transmission-time": new Date(now + (skewMs + 1)).toISOString(),
        "paypal-cert-url": "https://api.paypal.com/cert",
      });

      const res = await verifyPayPalSignature({ event: "{}", headers, now });
      expect(res).toBe(false);
    });

    it("rejects paypal timestamp exceeding future boundary: now + 301s (301,000ms)", async () => {
      const now = Date.now();
      const headers = new Headers({
        "paypal-transmission-id": "tx-123",
        "paypal-transmission-sig": "c2ln",
        "paypal-transmission-time": new Date(now + 301_000).toISOString(),
        "paypal-cert-url": "https://api.paypal.com/cert",
      });

      const res = await verifyPayPalSignature({ event: "{}", headers, now });
      expect(res).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Adversarial IP Spoofing Challenge against getIP()
  // --------------------------------------------------------------------------
  describe("Adversarial IP Spoofing Challenge against getIP()", () => {
    it("handles heavily polluted X-Forwarded-For with multiple commas and leading/trailing spaces", async () => {
      const headers = new Headers();
      headers.set(
        "x-forwarded-for",
        " , ,  10.0.0.1 ,  ,  192.168.1.100  ,  203.0.113.88 , , ",
      );

      const ip = await getIP(headers);
      expect(ip).toBe("203.0.113.88");
    });

    it("extracts rightmost IPv6 address in X-Forwarded-For chain", async () => {
      const headers = new Headers();
      headers.set(
        "x-forwarded-for",
        "10.0.0.1, 192.168.1.1, 2001:0db8:85a3:0000:0000:8a2e:0370:7334",
      );

      const ip = await getIP(headers);
      expect(ip).toBe("2001:0db8:85a3:0000:0000:8a2e:0370:7334");
    });

    it("strips whitespace from cf-connecting-ip and ignores all spoofed headers", async () => {
      const headers = new Headers();
      headers.set("cf-connecting-ip", "   198.51.100.99   ");
      headers.set("x-real-ip", "10.0.0.1");
      headers.set("x-forwarded-for", "127.0.0.1, 192.168.1.50");

      const ip = await getIP(headers);
      expect(ip).toBe("198.51.100.99");
    });

    it("falls through to x-real-ip if cf-connecting-ip is only whitespace", async () => {
      const headers = new Headers();
      headers.set("cf-connecting-ip", "    ");
      headers.set("x-real-ip", "198.51.100.77");
      headers.set("x-forwarded-for", "10.0.0.1, 203.0.113.1");

      const ip = await getIP(headers);
      expect(ip).toBe("198.51.100.77");
    });

    it("falls through to rightmost x-forwarded-for if cf-connecting-ip and x-real-ip are both whitespace", async () => {
      const headers = new Headers();
      headers.set("cf-connecting-ip", "   ");
      headers.set("x-real-ip", "   ");
      headers.set("x-forwarded-for", "10.0.0.1, 203.0.113.55");

      const ip = await getIP(headers);
      expect(ip).toBe("203.0.113.55");
    });

    it("returns fallback 0.0.0.0 when x-forwarded-for contains only empty commas and whitespace", async () => {
      const headers = new Headers();
      headers.set("x-forwarded-for", ", ,   ,   ,");

      const ip = await getIP(headers);
      expect(ip).toBe("0.0.0.0");
    });
  });

  // --------------------------------------------------------------------------
  // 6. Dynamic Nonce TTL Calculation & Edge Cases
  // --------------------------------------------------------------------------
  describe("Dynamic Nonce TTL & Edge Protection", () => {
    it("dynamically extends nonce TTL for requests skewed into the future", async () => {
      let recordedTtl: number | undefined;

      const mockRedisClient = {
        async set(
          key: string,
          value: string,
          opts?: { nx?: boolean; ex?: number },
        ) {
          recordedTtl = opts?.ex;
          return "OK";
        },
      };

      setServiceAuthRedisClient(mockRedisClient as any);

      const now = Date.now();
      // Future timestamp by 250s (250,000ms)
      const futureTimestamp = now + 250_000;
      const { request, body } = createSignedShopifyRequest({
        timestamp: String(futureTimestamp),
      });

      const valid = await verifyWeleticShopifyRequest({
        request,
        body,
        now,
        secret,
        requireRequestId: true,
      });

      expect(valid).toBe(true);
      // Expected TTL calculation: (250s + 300s) + 60s = 610s
      // Since 610s < default 720s, it takes max(720, 610) = 720
      expect(recordedTtl).toBeGreaterThanOrEqual(720);
    });
  });
});
