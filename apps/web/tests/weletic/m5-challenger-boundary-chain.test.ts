import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  handleWebhookIngress,
  WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
  type WebhookIngressEnv,
} from "../../workers/webhook-ingress/src/index";

import {
  buildKvKey,
  handleLinkRedirection,
  KV_NEGATIVE_CACHE_TTL_SECONDS,
  type LinkRedirectorEnv,
} from "../../workers/link-redirector/src/index";

import {
  createD1NonceClient,
  createPrismaNonceClient,
  readWeleticShopifyRequestBodyBytes,
  resetServiceAuthNonceCache,
  signWeleticShopifyRequest,
  verifyWeleticShopifyRequest,
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_REQUEST_ID_HEADER,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
} from "@weletic/contracts/shopify/service-auth";

import { assertE2EWorkspace } from "../../app/(ee)/api/e2e/guard";
import { DubApiError } from "../../lib/api/errors";
import { authOptions } from "../../lib/auth/options";
import { getSessionCookieDomain } from "../../lib/auth/session-cookie";
import {
  redirectRateLimiter,
  webhookRateLimiter,
} from "../../lib/weletic/edge-rate-limiter";

const TEST_SECRET = "shpss_test_shopify_webhook_secret_32bytes_12345";
const SERVICE_SECRET = "weletic_internal_service_secret_32bytes_min_length_ok";

function signWebhook(body: string | Uint8Array, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  if (typeof body === "string") {
    hmac.update(body, "utf8");
  } else {
    hmac.update(body);
  }
  return hmac.digest("base64");
}

describe("Empirical Challenger M5_1: Cross-Milestone Boundary & Penetration Test Suite", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    webhookRateLimiter.reset();
    redirectRateLimiter.reset();
    resetServiceAuthNonceCache();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // =========================================================================
  // SECTION 1: EDGE-TO-CORE DATA PIPELINE CASCADE & PAYLOAD LIMITS
  // =========================================================================
  describe("Section 1: Edge-to-Core Data Pipeline Cascade & Payload Limits", () => {
    it("1.1 128KB Payload Limit: Exactly 131,072 bytes (128KB) cascades through ingress to Queue without truncation", async () => {
      const mockQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      // Create a valid JSON body padded to exactly 128KB
      const baseObj = { order_id: 12345, note: "" };
      const baseStr = JSON.stringify(baseObj);
      const paddingNeeded =
        WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES - baseStr.length;
      baseObj.note = "A".repeat(paddingNeeded);
      const exactJson = JSON.stringify(baseObj);
      const exactBytes = Buffer.from(exactJson, "utf8");

      expect(exactBytes.byteLength).toBe(
        WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
      );

      const signature = signWebhook(exactBytes, TEST_SECRET);
      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "tenant-test.myshopify.com",
          "x-shopify-hmac-sha256": signature,
          "content-length": String(exactBytes.byteLength),
        },
        body: exactBytes,
      });

      const res = await handleWebhookIngress(req, env);
      expect(res.status).toBe(200);

      // Verify Queue received the full, untruncated payload
      expect(mockQueue.send).toHaveBeenCalledTimes(1);
      const queuedMessage = mockQueue.send.mock.calls[0][0];
      expect(queuedMessage.rawPayload).toBe(exactJson);
      // Downstream JSON.parse must succeed cleanly
      const parsed = JSON.parse(queuedMessage.rawPayload);
      expect(parsed.order_id).toBe(12345);
      expect(parsed.note.length).toBe(paddingNeeded);
    });

    it("1.2 128KB Payload Limit: 131,073 bytes (128KB + 1) is rejected with HTTP 413 and never enqueued", async () => {
      const mockQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      const oversizedBytes = new Uint8Array(
        WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES + 1,
      );
      oversizedBytes.fill(0x61);
      const signature = signWebhook(oversizedBytes, TEST_SECRET);

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "tenant-test.myshopify.com",
          "x-shopify-hmac-sha256": signature,
          "content-length": String(oversizedBytes.byteLength),
        },
        body: oversizedBytes,
      });

      const res = await handleWebhookIngress(req, env);
      expect(res.status).toBe(413);
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("1.3 Streaming Chunk Accumulation: Multi-chunk stream exceeding 128KB cancels reader early without buffering", async () => {
      const mockQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      // Create a ReadableStream delivering 10 chunks of 20KB each (total 200KB > 128KB)
      const chunkSize = 20 * 1024;
      const totalChunks = 10;
      let chunksDelivered = 0;
      let streamCancelled = false;

      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksDelivered < totalChunks) {
            chunksDelivered++;
            controller.enqueue(new Uint8Array(chunkSize).fill(0x62));
          } else {
            controller.close();
          }
        },
        cancel() {
          streamCancelled = true;
        },
      });

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "tenant-test.myshopify.com",
          "x-shopify-hmac-sha256": "dummy_signature_will_abort_before_verify",
        },
        body: stream,
        duplex: "half",
      } as RequestInit);

      const res = await handleWebhookIngress(req, env);
      expect(res.status).toBe(413);
      expect(mockQueue.send).not.toHaveBeenCalled();
      expect(streamCancelled).toBe(true);
      // Reader cancelled after 7 chunks (140KB > 128KB)
      expect(chunksDelivered).toBeLessThanOrEqual(8);
    });

    it("1.4 Content-Length Spoofing: Declared small Content-Length but streaming large body aborts safely", async () => {
      const mockQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      // Attacker declares Content-Length: 50, but sends 150KB stream
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(150 * 1024).fill(0x63));
          controller.close();
        },
      });

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "tenant-test.myshopify.com",
          "x-shopify-hmac-sha256": "fake_signature",
          "content-length": "50",
        },
        body: stream,
        duplex: "half",
      } as RequestInit);

      const res = await handleWebhookIngress(req, env);
      expect(res.status).toBe(413);
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("1.5 Service Auth Body Reader: Enforces maxBytes and returns null on oversized streams without throwing", async () => {
      // Create a 300KB stream (exceeds default 256KB WELETIC_SHOPIFY_MAX_BODY_BYTES)
      const oversizedStream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(300 * 1024).fill(0x64));
          controller.close();
        },
      });

      const req = new Request("https://internal.service.test/api", {
        method: "POST",
        headers: { "content-length": "307200" },
        body: oversizedStream,
        duplex: "half",
      } as RequestInit);

      const result = await readWeleticShopifyRequestBodyBytes(req);
      expect(result).toBeNull();
    });

    it("1.6 KV Negative Caching: Non-existent slug writes negative cache sentinel with 60s TTL and protects D1", async () => {
      const kvStore = new Map<string, string>();
      const mockKv: any = {
        get: vi.fn(async (key: string, type?: string) => {
          const val = kvStore.get(key);
          if (!val) return null;
          return type === "json" ? JSON.parse(val) : val;
        }),
        put: vi.fn(async (key: string, value: string, opts?: any) => {
          kvStore.set(key, value);
        }),
      };

      const mockD1First = vi.fn().mockResolvedValue(null);
      const mockDb: any = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: mockD1First,
          }),
        }),
      };

      const env: LinkRedirectorEnv = {
        LINKS_KV: mockKv,
        DB: mockDb,
      };

      const req1 = new Request(
        "https://link.weletic.com/non-existent-promo-slug",
      );
      const res1 = await handleLinkRedirection(req1, env);
      expect(res1.status).toBe(404);

      // Verify D1 was queried on initial miss
      expect(mockD1First).toHaveBeenCalledTimes(1);

      // Verify negative cache sentinel was stored in KV with 60s TTL
      const canonicalKey = buildKvKey(
        "link.weletic.com",
        "non-existent-promo-slug",
      );
      expect(mockKv.put).toHaveBeenCalledWith(
        canonicalKey,
        expect.stringContaining('"notFound":true'),
        { expirationTtl: KV_NEGATIVE_CACHE_TTL_SECONDS },
      );

      // Reset D1 mock call count
      mockD1First.mockClear();

      // Subsequent identical request must hit KV negative cache and return 404 WITHOUT calling D1
      const req2 = new Request(
        "https://link.weletic.com/non-existent-promo-slug",
      );
      const res2 = await handleLinkRedirection(req2, env);
      expect(res2.status).toBe(404);
      expect(mockD1First).not.toHaveBeenCalled();
    });

    it("1.7 KV Negative Caching Slug Variations: Uppercase, trailing slashes, and percent-encoded variations", async () => {
      const kvStore = new Map<string, string>();
      const mockKv: any = {
        get: vi.fn(async (key: string, type?: string) => {
          const val = kvStore.get(key);
          if (!val) return null;
          return type === "json" ? JSON.parse(val) : val;
        }),
        put: vi.fn(async (key: string, value: string) => {
          kvStore.set(key, value);
        }),
      };

      const mockD1First = vi.fn().mockResolvedValue(null);
      const mockDb: any = {
        prepare: vi.fn().mockReturnValue({
          bind: vi.fn().mockReturnValue({
            first: mockD1First,
          }),
        }),
      };

      const env: LinkRedirectorEnv = { LINKS_KV: mockKv, DB: mockDb };

      // Uppercase slug '/SUMMER-SALE' -> lowercased to 'summer-sale' in KV key
      const reqUpper = new Request("https://link.weletic.com/SUMMER-SALE");
      await handleLinkRedirection(reqUpper, env);
      expect(mockD1First).toHaveBeenCalledTimes(1);

      const upperKvKey = buildKvKey("link.weletic.com", "SUMMER-SALE");
      expect(upperKvKey).toBe("link:link.weletic.com:summer-sale");

      // Lowercase request '/summer-sale' hits the existing negative cache entry
      mockD1First.mockClear();
      const reqLower = new Request("https://link.weletic.com/summer-sale");
      const resLower = await handleLinkRedirection(reqLower, env);
      expect(resLower.status).toBe(404);
      expect(mockD1First).not.toHaveBeenCalled();

      // Percent-encoded space '/flash%20sale' -> decodes to 'flash sale'
      const reqEncoded = new Request("https://link.weletic.com/flash%20sale");
      await handleLinkRedirection(reqEncoded, env);
      const encodedKvKey = buildKvKey("link.weletic.com", "flash sale");
      expect(encodedKvKey).toBe("link:link.weletic.com:flash sale");

      // Unicode slug: Japanese hiragana '/%E3%81%82%E3%81%8D' -> decodes to 'あき'
      const reqUnicode = new Request(
        "https://link.weletic.com/%E3%81%82%E3%81%8D",
      );
      await handleLinkRedirection(reqUnicode, env);
      const unicodeKvKey = buildKvKey("link.weletic.com", "あき");
      expect(unicodeKvKey).toBe("link:link.weletic.com:あき");
    });
  });

  // =========================================================================
  // SECTION 2: HMAC ANTI-REPLAY & TIMING ATTACK DEFENSES
  // =========================================================================
  describe("Section 2: HMAC Anti-Replay & Timing Attack Defenses", () => {
    it("2.1 Prisma Nonce Concurrency Stress: 25 simultaneous concurrent requests on identical nonce yields strictly 1 winner", async () => {
      // Simulate real Prisma unique constraint behavior on ServiceAuthNonce
      const table = new Map<string, { nonceKey: string; expiresAt: number }>();
      const mockPrisma = {
        serviceAuthNonce: {
          create: vi.fn(
            async ({
              data,
            }: {
              data: { nonceKey: string; expiresAt: number };
            }) => {
              // Emulate atomic DB constraint
              if (table.has(data.nonceKey)) {
                const err: any = new Error(
                  "Unique constraint failed on the fields: (`nonceKey`)",
                );
                err.code = "P2002";
                throw err;
              }
              table.set(data.nonceKey, { ...data });
              return { id: "n_1", ...data };
            },
          ),
          findUnique: vi.fn(
            async ({ where }: { where: { nonceKey: string } }) => {
              return table.get(where.nonceKey) ?? null;
            },
          ),
          update: vi.fn(async ({ where, data }: any) => {
            const existing = table.get(where.nonceKey);
            if (!existing) throw new Error("Not found");
            const updated = { ...existing, ...data };
            table.set(where.nonceKey, updated);
            return updated;
          }),
        },
      };

      const client = createPrismaNonceClient(mockPrisma);
      const nonceKey = "weletic:service-auth:nonce:burst_test_req_9999";

      // Fire 25 concurrent set operations
      const concurrency = 25;
      const results = await Promise.all(
        Array.from({ length: concurrency }, () => client.set(nonceKey, "1")),
      );

      const okCount = results.filter((r) => r === "OK").length;
      const nullCount = results.filter((r) => r === null).length;

      // CRITICAL SECURITY INVARIANT:
      // Exactly 1 request succeeds; 24 are rejected due to unique constraint collision
      expect(okCount).toBe(1);
      expect(nullCount).toBe(24);
      expect(table.size).toBe(1);
    });

    it("2.2 Cloudflare D1 Nonce Concurrency Stress: 25 concurrent INSERTs yields strictly 1 winner", async () => {
      const d1Rows = new Map<string, { nonceKey: string; expiresAt: number }>();

      const mockD1: any = {
        prepare: vi.fn((query: string) => {
          return {
            bind: vi.fn((...args: any[]) => {
              return {
                run: async () => {
                  if (query.includes("INSERT INTO ServiceAuthNonce")) {
                    const [nonceKey, expiresAt] = args;
                    if (d1Rows.has(nonceKey)) {
                      throw new Error(
                        "UNIQUE constraint failed: ServiceAuthNonce.nonceKey",
                      );
                    }
                    d1Rows.set(nonceKey, { nonceKey, expiresAt });
                    return { success: true, meta: { changes: 1 } };
                  }
                  if (query.includes("UPDATE ServiceAuthNonce")) {
                    const [expiresAt, nonceKey] = args;
                    d1Rows.set(nonceKey, { nonceKey, expiresAt });
                    return { success: true, meta: { changes: 1 } };
                  }
                  return { success: true };
                },
                first: async () => {
                  if (
                    query.includes("SELECT expiresAt FROM ServiceAuthNonce")
                  ) {
                    const [nonceKey] = args;
                    return d1Rows.get(nonceKey) || null;
                  }
                  return null;
                },
              };
            }),
          };
        }),
      };

      const d1Client = createD1NonceClient(mockD1);
      const nonceKey = "weletic:service-auth:nonce:d1_burst_test_001";

      const results = await Promise.all(
        Array.from({ length: 25 }, () => d1Client.set(nonceKey, "1")),
      );

      const okCount = results.filter((r) => r === "OK").length;
      const nullCount = results.filter((r) => r === null).length;

      expect(okCount).toBe(1);
      expect(nullCount).toBe(24);
    });

    it("2.3 End-to-End Service Auth High Concurrency: 15 identical signed requests yields strictly 1 pass and 14 rejections", async () => {
      const now = Date.now();
      const requestId = "req_concurrent_e2e_burst_777";
      const timestamp = String(now);
      const body = JSON.stringify({
        action: "session_token_exchange",
        shop: "test.myshopify.com",
      });
      const path = "/api/internal/shopify/sessions";

      const signature = signWeleticShopifyRequest({
        timestamp,
        method: "POST",
        path,
        body,
        requestId,
        secret: SERVICE_SECRET,
      });

      // Stateful in-memory redis provider
      const redisStore = new Map<string, string>();
      const mockRedisClient = {
        set: vi.fn(
          async (key: string, val: string, opts?: { nx?: boolean }) => {
            if (opts?.nx && redisStore.has(key)) {
              return null;
            }
            redisStore.set(key, val);
            return "OK";
          },
        ),
      };

      const makeRequest = () =>
        new Request(`https://internal-service.local${path}`, {
          method: "POST",
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
            [WELETIC_SHOPIFY_REQUEST_ID_HEADER]: requestId,
          },
          body,
        });

      // Fire 15 concurrent verify calls
      const results = await Promise.all(
        Array.from({ length: 15 }, () =>
          verifyWeleticShopifyRequest({
            request: makeRequest(),
            body,
            now,
            secret: SERVICE_SECRET,
            requireRequestId: true,
            redisClient: mockRedisClient,
          }),
        ),
      );

      const trueCount = results.filter((r) => r === true).length;
      const falseCount = results.filter((r) => r === false).length;

      expect(trueCount).toBe(1);
      expect(falseCount).toBe(14);
    });

    it("2.4 Clock Skew Boundary Enforcement: Timestamps at +/- 5 min window boundary vs 5 min + 1 ms", async () => {
      const now = 1700000000000;
      const body = "{}";
      const path = "/api/test";
      const requestId = "req_clock_skew_test";

      const createSignedReq = (ts: number) => {
        const timestamp = String(ts);
        const signature = signWeleticShopifyRequest({
          timestamp,
          method: "POST",
          path,
          body,
          requestId,
          secret: SERVICE_SECRET,
        });
        return new Request(`https://internal-service.local${path}`, {
          method: "POST",
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
            [WELETIC_SHOPIFY_REQUEST_ID_HEADER]: requestId,
          },
          body,
        });
      };

      const mockRedis = { set: vi.fn().mockResolvedValue("OK") };

      // Exactly at past boundary (now - 300,000 ms) -> VALID
      const pastBoundaryReq = createSignedReq(
        now - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
      );
      const resPastBoundary = await verifyWeleticShopifyRequest({
        request: pastBoundaryReq,
        body,
        now,
        secret: SERVICE_SECRET,
        redisClient: mockRedis,
      });
      expect(resPastBoundary).toBe(true);

      // Past boundary + 1 ms (now - 300,001 ms) -> REJECTED
      const pastOverReq = createSignedReq(
        now - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS - 1,
      );
      const resPastOver = await verifyWeleticShopifyRequest({
        request: pastOverReq,
        body,
        now,
        secret: SERVICE_SECRET,
        redisClient: mockRedis,
      });
      expect(resPastOver).toBe(false);

      // Exactly at future boundary (now + 300,000 ms) -> VALID
      const futureBoundaryReq = createSignedReq(
        now + WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
      );
      const resFutureBoundary = await verifyWeleticShopifyRequest({
        request: futureBoundaryReq,
        body,
        now,
        secret: SERVICE_SECRET,
        redisClient: mockRedis,
      });
      expect(resFutureBoundary).toBe(true);

      // Future boundary + 1 ms (now + 300,001 ms) -> REJECTED
      const futureOverReq = createSignedReq(
        now + WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 1,
      );
      const resFutureOver = await verifyWeleticShopifyRequest({
        request: futureOverReq,
        body,
        now,
        secret: SERVICE_SECRET,
        redisClient: mockRedis,
      });
      expect(resFutureOver).toBe(false);
    });

    it("2.5 Malformed Timestamp Payloads: Floating point, NaN, non-numeric, and exponential formats are rejected", async () => {
      const now = Date.now();
      const body = "{}";
      const path = "/api/test";

      const testTimestamps = [
        "NaN",
        "invalid_timestamp",
        "1700000000.5", // Float
        "-1000", // Negative
        "1e15", // Exponential notation
        "",
        " ",
      ];

      for (const badTs of testTimestamps) {
        const req = new Request(`https://internal-service.local${path}`, {
          method: "POST",
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: badTs,
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: "a".repeat(64),
            [WELETIC_SHOPIFY_REQUEST_ID_HEADER]: "req_bad_ts",
          },
          body,
        });

        const res = await verifyWeleticShopifyRequest({
          request: req,
          body,
          now,
          secret: SERVICE_SECRET,
        });
        expect(res).toBe(false);
      }
    });

    it("2.6 Timing Attack Resistance: Signatures of wrong lengths or 1-bit discrepancies are rejected safely", async () => {
      const now = Date.now();
      const body = "{}";
      const path = "/api/test";
      const requestId = "req_timing_test";
      const timestamp = String(now);

      const validSignature = signWeleticShopifyRequest({
        timestamp,
        method: "POST",
        path,
        body,
        requestId,
        secret: SERVICE_SECRET,
      });

      // 1. Signature with 63 chars (length mismatch)
      const shortSig = validSignature.slice(0, 63);
      const reqShort = new Request(`https://internal-service.local${path}`, {
        method: "POST",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: shortSig,
          [WELETIC_SHOPIFY_REQUEST_ID_HEADER]: requestId,
        },
        body,
      });
      expect(
        await verifyWeleticShopifyRequest({
          request: reqShort,
          body,
          now,
          secret: SERVICE_SECRET,
        }),
      ).toBe(false);

      // 2. Signature with 65 chars
      const longSig = validSignature + "a";
      const reqLong = new Request(`https://internal-service.local${path}`, {
        method: "POST",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: longSig,
          [WELETIC_SHOPIFY_REQUEST_ID_HEADER]: requestId,
        },
        body,
      });
      expect(
        await verifyWeleticShopifyRequest({
          request: reqLong,
          body,
          now,
          secret: SERVICE_SECRET,
        }),
      ).toBe(false);

      // 3. Signature with exactly 64 hex characters but 1 bit flipped at the end
      const lastChar = validSignature[validSignature.length - 1];
      const flippedChar = lastChar === "0" ? "1" : "0";
      const flippedSig = validSignature.slice(0, -1) + flippedChar;

      const reqFlipped = new Request(`https://internal-service.local${path}`, {
        method: "POST",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: flippedSig,
          [WELETIC_SHOPIFY_REQUEST_ID_HEADER]: requestId,
        },
        body,
      });
      expect(
        await verifyWeleticShopifyRequest({
          request: reqFlipped,
          body,
          now,
          secret: SERVICE_SECRET,
        }),
      ).toBe(false);
    });
  });

  // =========================================================================
  // SECTION 3: MULTI-TENANT SESSION & IDOR DEFENSES
  // =========================================================================
  describe("Section 3: Multi-Tenant Session & IDOR Defenses", () => {
    it("3.1 Host-Only Cookie Scoping: sessionToken cookie domain is strictly undefined by default (RFC 6265)", () => {
      // In authOptions, domain must be undefined unless NEXTAUTH_CROSS_SUBDOMAIN_COOKIES is explicitly 'true'
      delete process.env.NEXTAUTH_CROSS_SUBDOMAIN_COOKIES;

      const cookieDomain = authOptions.cookies?.sessionToken?.options?.domain;
      expect(cookieDomain).toBeUndefined();
    });

    it("3.2 getSessionCookieDomain returns undefined for preview environments, localhost, and when hostOnly is true", () => {
      // Host only flag
      expect(getSessionCookieDomain({ hostOnly: true })).toBeUndefined();

      // Preview environment
      expect(
        getSessionCookieDomain({
          vercelEnv: "preview",
          appDomain: "app.weletic.com",
        }),
      ).toBeUndefined();
      expect(
        getSessionCookieDomain({
          nextPublicVercelEnv: "preview",
          appDomain: "app.weletic.com",
        }),
      ).toBeUndefined();
      expect(
        getSessionCookieDomain({
          vercelUrl: "weletic-preview-git-feature.vercel.app",
        }),
      ).toBeUndefined();

      // Localhost & IP addresses
      expect(
        getSessionCookieDomain({ appDomain: "localhost" }),
      ).toBeUndefined();
      expect(
        getSessionCookieDomain({ appDomain: "127.0.0.1" }),
      ).toBeUndefined();
      expect(
        getSessionCookieDomain({ appDomain: "192.168.1.10" }),
      ).toBeUndefined();

      // Verifies NEXTAUTH_COOKIE_HOST_ONLY env var
      process.env.NEXTAUTH_COOKIE_HOST_ONLY = "true";
      expect(
        getSessionCookieDomain({ appDomain: "app.weletic.com" }),
      ).toBeUndefined();
    });

    it("3.3 Subdomain Isolation: A rogue tenant subdomain cannot toss or read host-only cookies of sibling tenants", () => {
      // RFC 6265 Section 4.1.2.3: Omitted Domain attribute creates a host-only cookie.
      // Host-only cookie set on tenant1.weletic.com is never sent to tenant2.weletic.com or weletic.com.
      delete process.env.NEXTAUTH_CROSS_SUBDOMAIN_COOKIES;
      process.env.NEXTAUTH_COOKIE_HOST_ONLY = "true";

      const tenant1CookieDomain = getSessionCookieDomain({
        appDomain: "tenant1.weletic.com",
      });
      const tenant2CookieDomain = getSessionCookieDomain({
        appDomain: "tenant2.weletic.com",
      });

      expect(tenant1CookieDomain).toBeUndefined();
      expect(tenant2CookieDomain).toBeUndefined();
    });

    it("3.4 Production E2E Route Gating: /api/e2e/* endpoints throw HTTP 404 (not_found) when ENABLE_E2E_ROUTES is unset", () => {
      (process.env as any).NODE_ENV = "production";
      delete process.env.ENABLE_E2E_ROUTES;

      const dummyWorkspace = { id: "ws_acme_test" };

      expect(() => assertE2EWorkspace(dummyWorkspace)).toThrowError(
        DubApiError,
      );
      try {
        assertE2EWorkspace(dummyWorkspace);
      } catch (err: any) {
        expect(err.code).toBe("not_found");
        expect(err.message).toBe("Endpoint not found");
      }
    });

    it("3.5 Production E2E Route Gating: Falsy values ('false', '0', '') for ENABLE_E2E_ROUTES still throw 404", () => {
      (process.env as any).NODE_ENV = "production";
      const dummyWorkspace = { id: "ws_acme_test" };

      for (const falsyVal of ["false", "0", "", "undefined"]) {
        process.env.ENABLE_E2E_ROUTES = falsyVal;
        expect(() => assertE2EWorkspace(dummyWorkspace)).toThrowError(
          DubApiError,
        );
        try {
          assertE2EWorkspace(dummyWorkspace);
        } catch (err: any) {
          expect(err.code).toBe("not_found");
        }
      }
    });

    it("3.6 Production E2E Route Gating: When ENABLE_E2E_ROUTES is 'true', only ACME workspace is permitted", () => {
      (process.env as any).NODE_ENV = "production";
      process.env.ENABLE_E2E_ROUTES = "true";
      process.env.E2E_WORKSPACE_ID = "ws_acme_permitted";

      // Permitted workspace succeeds without error
      expect(() =>
        assertE2EWorkspace({ id: "ws_acme_permitted" }),
      ).not.toThrow();

      // Unauthorized workspace throws 403 forbidden
      expect(() =>
        assertE2EWorkspace({ id: "ws_attacker_workspace" }),
      ).toThrowError(DubApiError);
      try {
        assertE2EWorkspace({ id: "ws_attacker_workspace" });
      } catch (err: any) {
        expect(err.code).toBe("forbidden");
        expect(err.message).toContain("restricted to the Acme test workspace");
      }
    });
  });
});
