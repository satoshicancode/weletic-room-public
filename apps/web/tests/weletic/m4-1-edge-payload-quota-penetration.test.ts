import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import crypto from "node:crypto";
import {
  handleWebhookIngress,
  readLimitedBody,
  WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
  type WebhookIngressEnv,
} from "../../workers/webhook-ingress/src/index";
import {
  handleLinkRedirection,
  buildKvKey,
  KV_NEGATIVE_CACHE_TTL_SECONDS,
  type LinkRedirectorEnv,
  type LinkRecord,
  type NegativeCacheSentinel,
} from "../../workers/link-redirector/src/index";
import {
  webhookRateLimiter,
  redirectRateLimiter,
} from "../../lib/weletic/edge-rate-limiter";

const TEST_SECRET = "shpss_test_shopify_webhook_secret_32bytes_12345";

function signPayload(body: string | Uint8Array, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  if (typeof body === "string") {
    hmac.update(body, "utf8");
  } else {
    hmac.update(body);
  }
  return hmac.digest("base64");
}

describe("Empirical Challenger M4_1: Edge Payload Limits & D1 Quota Penetration", () => {
  beforeEach(() => {
    webhookRateLimiter.reset();
    redirectRateLimiter.reset();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // SUITE 1: Webhook Ingress Payload Limits & Streaming Penetration
  // =========================================================================
  describe("Suite 1: Webhook Ingress Payload Limits & Streaming Penetration", () => {
    it("1.1 Boundary Pass: Exactly 131,072 bytes (128KB) payload with matching Content-Length is accepted and enqueued", async () => {
      const mockQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      const exactPayload = new Uint8Array(WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES);
      exactPayload.fill(0x57); // 'W'
      const signature = signPayload(exactPayload, TEST_SECRET);

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "x-shopify-hmac-sha256": signature,
          "content-length": "131072",
        },
        body: exactPayload,
      });

      const res = await handleWebhookIngress(req, env);
      expect(res.status).toBe(200);

      const json = (await res.json()) as { ok: boolean; queuedId: string };
      expect(json.ok).toBe(true);
      expect(json.queuedId).toBeDefined();

      expect(mockQueue.send).toHaveBeenCalledTimes(1);
      const enqueued = mockQueue.send.mock.calls[0][0];
      expect(enqueued.topic).toBe("orders/paid");
      expect(enqueued.shopDomain).toBe("yamax.myshopify.com");
      expect(enqueued.rawPayload.length).toBe(131072);
    });

    it("1.2 Boundary Rejection: Exactly 131,073 bytes (128KB + 1 byte) with Content-Length is rejected upfront with HTTP 413", async () => {
      const mockQueue = { send: vi.fn() };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      const oversizedPayload = new Uint8Array(WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES + 1);
      oversizedPayload.fill(0x58); // 'X'
      const signature = signPayload(oversizedPayload, TEST_SECRET);

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "x-shopify-hmac-sha256": signature,
          "content-length": "131073",
        },
        body: oversizedPayload,
      });

      const res = await handleWebhookIngress(req, env);
      expect(res.status).toBe(413);
      const bodyText = await res.text();
      expect(bodyText).toContain("Webhook payload is too large or invalid.");
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("1.3 Chunked Streaming Boundary Rejection: 131,073 bytes without Content-Length is aborted mid-stream with HTTP 413", async () => {
      const mockQueue = { send: vi.fn() };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      // Create streaming body without Content-Length header
      // Delivering: 64KB + 64KB + 1 byte = 131,073 bytes
      const chunk64K = new Uint8Array(64 * 1024);
      chunk64K.fill(0x41);
      const chunk1B = new Uint8Array([0x42]);

      let chunkIndex = 0;
      const chunks = [chunk64K, chunk64K, chunk1B];

      const stream = new ReadableStream({
        pull(controller) {
          if (chunkIndex < chunks.length) {
            controller.enqueue(chunks[chunkIndex++]);
          } else {
            controller.close();
          }
        },
      });

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "x-shopify-hmac-sha256": "any_signature",
          // Notice: NO content-length header provided (simulating chunked transfer)
        },
        body: stream,
        duplex: "half",
      } as any);

      const res = await handleWebhookIngress(req, env);
      expect(res.status).toBe(413);
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("1.4 Streaming Cancellation: readLimitedBody cancels stream reader immediately when 128KB threshold is crossed", async () => {
      let pullCount = 0;
      let cancelledReason: unknown = null;

      const chunk32K = new Uint8Array(32 * 1024);
      chunk32K.fill(0x5a);

      const stream = new ReadableStream({
        pull(controller) {
          pullCount++;
          // Emits chunks indefinitely if not cancelled
          controller.enqueue(chunk32K);
        },
        cancel(reason) {
          cancelledReason = reason;
        },
      });

      const mockRequest = {
        body: stream,
      } as unknown as Request;

      const result = await readLimitedBody(mockRequest, WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES);

      expect(result.exceeded).toBe(true);
      expect(result.bytes.byteLength).toBe(0);
      expect(cancelledReason).toBe("payload_too_large");
      // 32KB * 4 = 128KB. On 5th pull (160KB), accumulated > 128KB, so pullCount must not run away
      expect(pullCount).toBeLessThanOrEqual(6);
    });

    it("1.5 Adversarial Negative Content-Length headers return HTTP 413 immediately", async () => {
      const mockQueue = { send: vi.fn() };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      const adversarialLengths = [
        "-1",
        "-128",
        "-131072",
        "-999999999999",
        "-9223372036854775808",
      ];

      for (const negLen of adversarialLengths) {
        const req = new Request("https://webhook.weletic.com/ingress", {
          method: "POST",
          headers: {
            "x-shopify-topic": "orders/paid",
            "x-shopify-shop-domain": "yamax.myshopify.com",
            "content-length": negLen,
          },
          body: "{}",
        });

        const res = await handleWebhookIngress(req, env);
        expect(res.status).toBe(413);
        expect(mockQueue.send).not.toHaveBeenCalled();
      }
    });

    it("1.6 Malformed & Non-Numeric Content-Length headers return HTTP 413", async () => {
      const mockQueue = { send: vi.fn() };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      const malformedHeaders = [
        "NaN",
        "invalid_length",
        "",
        "   ",
        "Infinity",
        "-Infinity",
        "null",
        "undefined",
      ];

      for (const malformed of malformedHeaders) {
        const req = new Request("https://webhook.weletic.com/ingress", {
          method: "POST",
          headers: {
            "x-shopify-topic": "orders/paid",
            "x-shopify-shop-domain": "yamax.myshopify.com",
            "content-length": malformed,
          },
          body: "{}",
        });

        const res = await handleWebhookIngress(req, env);
        expect(res.status).toBe(413);
        expect(mockQueue.send).not.toHaveBeenCalled();
      }
    });

    it("1.7 Header Suffix / Suffix Attacks with oversized body: streaming reader catches payload and returns 413", async () => {
      const mockQueue = { send: vi.fn() };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      // When an attacker supplies a Content-Length with units like "128KB" (parseInt returns 128)
      // or "-0.5" (parseInt returns -0), but sends an oversized body of 140KB:
      const oversizedBody = new Uint8Array(140 * 1024);
      oversizedBody.fill(0x61);

      for (const trickHeader of ["128KB", "-0.5", "50_bytes"]) {
        const req = new Request("https://webhook.weletic.com/ingress", {
          method: "POST",
          headers: {
            "x-shopify-topic": "orders/paid",
            "x-shopify-shop-domain": "yamax.myshopify.com",
            "content-length": trickHeader,
          },
          body: oversizedBody,
        });

        const res = await handleWebhookIngress(req, env);
        // Must be rejected with 413 by streaming reader
        expect(res.status).toBe(413);
        expect(mockQueue.send).not.toHaveBeenCalled();
      }
    });

    it("1.8 Spoofed Small Content-Length Attack: Header says 50 bytes, streaming body sends 150KB -> Rejected with HTTP 413", async () => {
      const mockQueue = { send: vi.fn() };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      const largeBuffer = new Uint8Array(150 * 1024);
      largeBuffer.fill(0x61);

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "content-length": "50", // Spoofed small header
          "x-shopify-hmac-sha256": "fake_sig",
        },
        body: largeBuffer,
      });

      const res = await handleWebhookIngress(req, env);
      expect(res.status).toBe(413);
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("1.9 Zero-byte Body (Content-Length: 0) behavior under valid vs invalid signature", async () => {
      const mockQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      // 1. Invalid signature on empty body -> 401
      const reqInvalid = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "content-length": "0",
          "x-shopify-hmac-sha256": "invalid_sig",
        },
        body: "",
      });
      const resInvalid = await handleWebhookIngress(reqInvalid, env);
      expect(resInvalid.status).toBe(401);
      expect(mockQueue.send).not.toHaveBeenCalled();

      // 2. Valid signature on empty body -> 200
      const emptySig = signPayload(new Uint8Array(0), TEST_SECRET);
      const reqValid = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "content-length": "0",
          "x-shopify-hmac-sha256": emptySig,
        },
        body: "",
      });
      const resValid = await handleWebhookIngress(reqValid, env);
      expect(resValid.status).toBe(200);
      expect(mockQueue.send).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // SUITE 2: Link Redirector KV Negative Caching & D1 Quota Penetration
  // =========================================================================
  describe("Suite 2: Link Redirector KV Negative Caching & D1 Quota Defense", () => {
    // In-memory KV simulator
    function createMockKvStore() {
      const store = new Map<string, { value: string; expiresAt?: number }>();
      return {
        store,
        get: vi.fn(async (key: string, format?: string) => {
          const entry = store.get(key);
          if (!entry) return null;
          if (entry.expiresAt && Date.now() > entry.expiresAt) {
            store.delete(key);
            return null;
          }
          if (format === "json") {
            try {
              return JSON.parse(entry.value);
            } catch {
              return null;
            }
          }
          return entry.value;
        }),
        put: vi.fn(async (key: string, value: string, options?: { expirationTtl?: number }) => {
          const expiresAt = options?.expirationTtl
            ? Date.now() + options.expirationTtl * 1000
            : undefined;
          store.set(key, { value, expiresAt });
        }),
      };
    }

    it("2.1 Sequential 100-request penetration: 100 queries to non-existent slug yields EXACTLY 1 D1 query", async () => {
      const kv = createMockKvStore();
      const d1PrepareSpy = vi.fn();
      const d1FirstSpy = vi.fn().mockResolvedValue(null); // non-existent in D1

      d1PrepareSpy.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: d1FirstSpy,
        }),
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: kv as any,
        DB: { prepare: d1PrepareSpy } as any,
      };

      const slug = "adversarial-probe-404";
      const targetUrl = `https://yamax.com/${slug}`;

      // Simulate 100 consecutive requests to the same non-existent slug
      for (let i = 0; i < 100; i++) {
        const req = new Request(targetUrl);
        const res = await handleLinkRedirection(req, env);
        expect(res.status).toBe(404);
      }

      // Empirical assertion: D1 was accessed ONLY ONCE!
      expect(d1PrepareSpy).toHaveBeenCalledTimes(1);
      expect(d1FirstSpy).toHaveBeenCalledTimes(1);

      // KV was checked 100 times
      expect(kv.get).toHaveBeenCalledTimes(100);

      // Negative cache sentinel was written once with TTL 60
      expect(kv.put).toHaveBeenCalledTimes(1);
      const [putKey, putVal, putOpts] = kv.put.mock.calls[0];
      expect(putKey).toBe(buildKvKey("yamax.com", slug));
      const parsedSentinel = JSON.parse(putVal) as NegativeCacheSentinel;
      expect(parsedSentinel.notFound).toBe(true);
      expect(putOpts?.expirationTtl).toBe(KV_NEGATIVE_CACHE_TTL_SECONDS);
    });

    it("2.2 Multi-slug dictionary penetration: 10 distinct missing slugs x 10 requests = 10 D1 queries total", async () => {
      const kv = createMockKvStore();
      const d1PrepareSpy = vi.fn();
      const d1FirstSpy = vi.fn().mockResolvedValue(null);

      d1PrepareSpy.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: d1FirstSpy,
        }),
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: kv as any,
        DB: { prepare: d1PrepareSpy } as any,
      };

      const slugs = [
        "admin",
        "wp-login",
        "checkout-fake",
        "cart-missing",
        "test-slug",
        "staging-promo",
        "invalid-ref-1",
        "invalid-ref-2",
        "non-existent-campaign",
        "dead-partner-link",
      ];

      // 10 distinct slugs queried 10 times each = 100 requests
      for (const slug of slugs) {
        for (let i = 0; i < 10; i++) {
          const req = new Request(`https://yamax.com/${slug}`);
          const res = await handleLinkRedirection(req, env);
          expect(res.status).toBe(404);
        }
      }

      // Exactly 10 D1 calls (one for each unique slug)
      expect(d1PrepareSpy).toHaveBeenCalledTimes(10);
      expect(d1FirstSpy).toHaveBeenCalledTimes(10);

      // KV absorbed all 90 subsequent requests
      expect(kv.get).toHaveBeenCalledTimes(100);
      expect(kv.put).toHaveBeenCalledTimes(10);
    });

    it("2.3 Negative Cache TTL Expiry: Queries D1 again after 60-second TTL expires", async () => {
      const kv = createMockKvStore();
      const d1PrepareSpy = vi.fn();
      const d1FirstSpy = vi.fn().mockResolvedValue(null);

      d1PrepareSpy.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: d1FirstSpy,
        }),
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: kv as any,
        DB: { prepare: d1PrepareSpy } as any,
      };

      const slug = "expiring-negative-slug";
      const reqUrl = `https://yamax.com/${slug}`;

      // Request 1: KV miss -> D1 query 1 -> Negative cache written
      const res1 = await handleLinkRedirection(new Request(reqUrl), env);
      expect(res1.status).toBe(404);
      expect(d1PrepareSpy).toHaveBeenCalledTimes(1);

      // Request 2 (within TTL): KV hit -> 0 new D1 queries
      const res2 = await handleLinkRedirection(new Request(reqUrl), env);
      expect(res2.status).toBe(404);
      expect(d1PrepareSpy).toHaveBeenCalledTimes(1);

      // Simulate 61 seconds passing: key expires in KV
      const kvKey = buildKvKey("yamax.com", slug);
      const entry = kv.store.get(kvKey);
      if (entry) {
        entry.expiresAt = Date.now() - 1000; // Expired!
      }

      // Request 3 (after TTL expiration): KV miss -> D1 query 2
      const res3 = await handleLinkRedirection(new Request(reqUrl), env);
      expect(res3.status).toBe(404);
      expect(d1PrepareSpy).toHaveBeenCalledTimes(2);
    });

    it("2.4 Valid Slug Non-Interference: Existing valid link redirects (302) and is NEVER masked by negative caching", async () => {
      const kv = createMockKvStore();
      const d1PrepareSpy = vi.fn();

      const validRecord: LinkRecord = {
        id: "lnk_yamax_summer_2026",
        projectId: "prj_yamax_main",
        partnerId: "ptn_athlete_jenny",
        url: "https://yamax.com/products/yenergy-leggings",
        disabledAt: null,
        archived: false,
      };

      d1PrepareSpy.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(validRecord),
        }),
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: kv as any,
        DB: { prepare: d1PrepareSpy } as any,
      };

      const slug = "summer-vip";
      const reqUrl = `https://yamax.com/${slug}?ref=insta`;

      // Request 1: Initial load (queries D1, populates positive cache)
      const res1 = await handleLinkRedirection(new Request(reqUrl), env);
      expect(res1.status).toBe(302);
      expect(res1.headers.get("Location")).toContain("/products/yenergy-leggings");
      expect(res1.headers.get("Location")).toContain("currency=USD");
      expect(res1.headers.get("Location")).toContain("via=summer-vip");
      expect(d1PrepareSpy).toHaveBeenCalledTimes(1);

      // Verify positive record was written to KV with 24-hour TTL (86400)
      const kvKey = buildKvKey("yamax.com", slug);
      const cached = await kv.get(kvKey, "json");
      expect(cached).not.toBeNull();
      expect(cached.notFound).toBeUndefined();
      expect(cached.id).toBe("lnk_yamax_summer_2026");

      // Requests 2 through 50: All served from KV positive cache with 302, 0 additional D1 calls
      for (let i = 2; i <= 50; i++) {
        const res = await handleLinkRedirection(new Request(reqUrl), env);
        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toContain("/products/yenergy-leggings");
      }
      expect(d1PrepareSpy).toHaveBeenCalledTimes(1); // STILL 1!
    });

    it("2.5 Negative Cache Isolation: Probing non-existent slug does NOT contaminate adjacent valid slug", async () => {
      const kv = createMockKvStore();

      const validRecord: LinkRecord = {
        id: "lnk_valid",
        projectId: "prj_1",
        url: "https://yamax.com/promo",
        disabledAt: null,
        archived: false,
      };

      const d1PrepareSpy = vi.fn().mockImplementation((_query: string) => ({
        bind: vi.fn().mockImplementation((_domain: string, key: string) => ({
          first: vi.fn().mockImplementation(async () => {
            if (key.toLowerCase() === "valid-slug") {
              return validRecord;
            }
            return null; // missing
          }),
        })),
      }));

      const env: LinkRedirectorEnv = {
        LINKS_KV: kv as any,
        DB: { prepare: d1PrepareSpy } as any,
      };

      // 1. Probe non-existent slug
      const resMissing = await handleLinkRedirection(new Request("https://yamax.com/missing-slug"), env);
      expect(resMissing.status).toBe(404);

      // 2. Query valid slug immediately after
      const resValid = await handleLinkRedirection(new Request("https://yamax.com/valid-slug"), env);
      expect(resValid.status).toBe(302);
      expect(resValid.headers.get("Location")).toContain("https://yamax.com/promo");

      // Verify KV stores both distinct keys accurately
      const missingSentinel = await kv.get(buildKvKey("yamax.com", "missing-slug"), "json");
      expect(missingSentinel.notFound).toBe(true);

      const validCache = await kv.get(buildKvKey("yamax.com", "valid-slug"), "json");
      expect(validCache.notFound).toBeUndefined();
      expect(validCache.id).toBe("lnk_valid");
    });

    it("2.6 Soft-Deleted Link (Invariant 2): Soft-deleted link is absorbed by negative cache and never redirected", async () => {
      const kv = createMockKvStore();
      const d1PrepareSpy = vi.fn();

      // D1 query: WHERE disabledAt IS NULL. Since it's soft-deleted, D1 returns null!
      d1PrepareSpy.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: kv as any,
        DB: { prepare: d1PrepareSpy } as any,
      };

      const slug = "soft-deleted-campaign";

      // 20 requests to soft-deleted link
      for (let i = 0; i < 20; i++) {
        const res = await handleLinkRedirection(new Request(`https://yamax.com/${slug}`), env);
        expect(res.status).toBe(404);
      }

      // D1 called only once, KV absorbed the other 19
      expect(d1PrepareSpy).toHaveBeenCalledTimes(1);
    });

    it("2.7 Archived Link Protection: Archived link is absorbed by negative cache and never redirected", async () => {
      const kv = createMockKvStore();
      const d1PrepareSpy = vi.fn();

      // D1 query: WHERE (archived = 0 OR archived IS FALSE). Returns null
      d1PrepareSpy.mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: kv as any,
        DB: { prepare: d1PrepareSpy } as any,
      };

      const slug = "archived-campaign-2024";

      for (let i = 0; i < 20; i++) {
        const res = await handleLinkRedirection(new Request(`https://yamax.com/${slug}`), env);
        expect(res.status).toBe(404);
      }

      expect(d1PrepareSpy).toHaveBeenCalledTimes(1);
    });

    it("2.8 KV Write Error Resilience: Negative cache put rejection does not throw or return 500", async () => {
      const failingKv = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockRejectedValue(new Error("KV quota write failed")),
      };

      const d1PrepareSpy = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: failingKv as any,
        DB: { prepare: d1PrepareSpy } as any,
      };

      const res = await handleLinkRedirection(new Request("https://yamax.com/error-prone-slug"), env);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Not Found");
    });
  });
});
