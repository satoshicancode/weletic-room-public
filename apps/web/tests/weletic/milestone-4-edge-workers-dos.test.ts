import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import crypto from "node:crypto";
import {
  cronRateLimiter,
  EdgeRateLimiter,
  getClientIp,
  redirectRateLimiter,
  webhookRateLimiter,
} from "../../lib/weletic/edge-rate-limiter";
import {
  handleHttpTrigger,
  timingSafeStringEqual,
  type CronWorkerEnv,
} from "../../workers/cron-triggers/src/index";
import {
  handleLinkRedirection,
  KV_NEGATIVE_CACHE_TTL_SECONDS,
  type LinkRedirectorEnv,
  type NegativeCacheSentinel,
} from "../../workers/link-redirector/src/index";
import {
  handleWebhookIngress,
  WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
  type WebhookIngressEnv,
} from "../../workers/webhook-ingress/src/index";

const TEST_SECRET = "shpss_test_shopify_webhook_secret_32bytes_12345";
const TEST_CRON_SECRET = "wltc_cron_secret_high_entropy_token_999";

function signPayload(body: string | Uint8Array, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  if (typeof body === "string") {
    hmac.update(body, "utf8");
  } else {
    hmac.update(body);
  }
  return hmac.digest("base64");
}

describe("Milestone 4: Cloudflare Edge Workers DoS Resilience & Quota Protection (SEC-R4-01 - SEC-R4-04)", () => {
  beforeEach(() => {
    webhookRateLimiter.reset();
    redirectRateLimiter.reset();
    cronRateLimiter.reset();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. SEC-R4-01: Webhook Ingress Payload Bounds & Cloudflare Queue Alignment
  // =========================================================================
  describe("1. SEC-R4-01: Webhook Ingress 128KB Queue Alignment & Early Size Checks", () => {
    it("1.1 enforces WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES exactly at 128KB (131,072 bytes)", () => {
      // Cloudflare Queue limit is 128 KB
      expect(WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES).toBe(128 * 1024);
      expect(WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES).toBe(131_072);
    });

    it("1.2 rejects payloads exceeding 128KB via upfront Content-Length check with HTTP 413", async () => {
      const mockQueue = { send: vi.fn() };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      // Exceeding 128KB by 1 byte via Content-Length
      const oversizedBytes = WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES + 1;
      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "content-length": String(oversizedBytes),
        },
        body: "x",
      });

      const res = await handleWebhookIngress(req, env);
      expect(res.status).toBe(413);
      const text = await res.text();
      expect(text).toContain("Webhook payload is too large or invalid.");
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("1.3 rejects the legacy 10MB limit payload with HTTP 413", async () => {
      const mockQueue = { send: vi.fn() };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      const tenMbBytes = 10 * 1024 * 1024;
      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "content-length": String(tenMbBytes),
        },
        body: "x",
      });

      const res = await handleWebhookIngress(req, env);
      expect(res.status).toBe(413);
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("1.4 rejects negative or invalid Content-Length header with HTTP 413", async () => {
      const mockQueue = { send: vi.fn() };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      for (const invalidLength of ["-100", "invalid_number", "NaN"]) {
        const req = new Request("https://webhook.weletic.com/ingress", {
          method: "POST",
          headers: {
            "x-shopify-topic": "orders/paid",
            "x-shopify-shop-domain": "yamax.myshopify.com",
            "content-length": invalidLength,
          },
          body: "{}",
        });

        const res = await handleWebhookIngress(req, env);
        expect(res.status).toBe(413);
        expect(mockQueue.send).not.toHaveBeenCalled();
      }
    });

    it("1.5 enforces streaming chunk accumulation limit and aborts with HTTP 413 when spoofed or chunked", async () => {
      const mockQueue = { send: vi.fn() };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      // Buffer of 128KB + 10 bytes
      const oversizedBuffer = new Uint8Array(
        WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES + 10,
      );
      oversizedBuffer.fill(65);

      // Request with spoofed smaller Content-Length (100 bytes) but actual streaming body > 128KB
      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "content-length": "100", // spoofed small header
        },
        body: oversizedBuffer,
      });

      const res = await handleWebhookIngress(req, env);
      expect(res.status).toBe(413);
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("1.6 accepts payload within exact 128KB limit when authentic signature is provided", async () => {
      const mockQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      // Payload exactly at 128KB boundary
      const exact128KbBuffer = new Uint8Array(
        WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
      );
      exact128KbBuffer.fill(66);
      const signature = signPayload(exact128KbBuffer, TEST_SECRET);

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "x-shopify-hmac-sha256": signature,
          "content-length": String(WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES),
        },
        body: exact128KbBuffer,
      });

      const res = await handleWebhookIngress(req, env);
      expect(res.status).toBe(200);
      expect(mockQueue.send).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // 2. SEC-R4-02: Link Redirector Negative Caching & D1 Quota Protection
  // =========================================================================
  describe("2. SEC-R4-02: Link Redirector Negative Caching in KV & D1 Exhaustion Defense", () => {
    it("2.1 defines KV_NEGATIVE_CACHE_TTL_SECONDS as 60 seconds", () => {
      expect(KV_NEGATIVE_CACHE_TTL_SECONDS).toBe(60);
    });

    it("2.2 writes negative cache sentinel to KV with expirationTtl: 60 when D1 returns null", async () => {
      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const mockKvGet = vi.fn().mockResolvedValue(null);
      const mockD1First = vi.fn().mockResolvedValue(null); // non-existent slug
      const mockD1Prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: mockD1First,
        }),
      });

      const env: LinkRedirectorEnv = {
        LINKS_KV: {
          get: mockKvGet,
          put: mockKvPut,
        } as any,
        DB: {
          prepare: mockD1Prepare,
        } as any,
      };

      const req = new Request("https://yamax.com/non-existent-slug");
      const res = await handleLinkRedirection(req, env);

      expect(res.status).toBe(404);
      // Verify D1 was queried once on initial cache miss
      expect(mockD1Prepare).toHaveBeenCalledTimes(1);

      // Verify negative cache sentinel was written to KV with TTL 60
      expect(mockKvPut).toHaveBeenCalledTimes(1);
      const [calledKey, calledValue, calledOptions] = mockKvPut.mock.calls[0];
      expect(calledKey).toBe("link:yamax.com:non-existent-slug");
      const parsedSentinel = JSON.parse(calledValue) as NegativeCacheSentinel;
      expect(parsedSentinel.notFound).toBe(true);
      expect(typeof parsedSentinel.cachedAt).toBe("number");
      expect(calledOptions).toEqual({ expirationTtl: 60 });
    });

    it("2.3 intercepts repeated 404 requests from KV negative cache and completely bypasses D1", async () => {
      const mockKvPut = vi.fn();
      const mockKvGet = vi.fn().mockResolvedValue({
        notFound: true,
        cachedAt: Date.now() - 5000,
      });
      const mockD1Prepare = vi.fn();

      const env: LinkRedirectorEnv = {
        LINKS_KV: {
          get: mockKvGet,
          put: mockKvPut,
        } as any,
        DB: {
          prepare: mockD1Prepare,
        } as any,
      };

      // Attacker sending 20 repeated requests for non-existent slug
      for (let i = 0; i < 20; i++) {
        const req = new Request("https://yamax.com/non-existent-slug");
        const res = await handleLinkRedirection(req, env);
        expect(res.status).toBe(404);
      }

      // KV fast-path served all 20 requests
      expect(mockKvGet).toHaveBeenCalledTimes(20);
      // D1 was NEVER called, protecting against daily quota exhaustion
      expect(mockD1Prepare).not.toHaveBeenCalled();
      expect(mockKvPut).not.toHaveBeenCalled();
    });

    it("2.4 handles ExecutionContext.waitUntil for non-blocking negative cache writes", async () => {
      const mockKvPut = vi.fn().mockResolvedValue(undefined);
      const mockD1Prepare = vi.fn().mockReturnValue({
        bind: vi.fn().mockReturnValue({
          first: vi.fn().mockResolvedValue(null),
        }),
      });
      const mockWaitUntil = vi.fn();

      const env: LinkRedirectorEnv = {
        LINKS_KV: {
          get: vi.fn().mockResolvedValue(null),
          put: mockKvPut,
        } as any,
        DB: {
          prepare: mockD1Prepare,
        } as any,
      };

      const ctx = { waitUntil: mockWaitUntil } as any;
      const req = new Request("https://yamax.com/missing-link");
      const res = await handleLinkRedirection(req, env, ctx);

      expect(res.status).toBe(404);
      expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // 3. SEC-R4-03: Cron Triggers Fail-Closed Authentication & Constant Time Compare
  // =========================================================================
  describe("3. SEC-R4-03: Cron Triggers Fail-Closed Auth & Constant-Time Security", () => {
    it("3.1 fails closed and rejects /trigger with 401 when CRON_SECRET is unconfigured", async () => {
      const envWithoutSecret: CronWorkerEnv = {};

      const endpoints = [
        "http://localhost/trigger",
        "http://localhost/api/trigger",
        "http://localhost/api/cron/weletic/loyalty/tier-sweep",
      ];

      for (const endpoint of endpoints) {
        const req = new Request(endpoint);
        const res = await handleHttpTrigger(req, envWithoutSecret);

        expect(res.status).toBe(401);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toContain("CRON_SECRET is not configured");
      }
    });

    it("3.2 fails closed when CRON_SECRET is whitespace or empty string", async () => {
      const emptySecretEnv: CronWorkerEnv = { CRON_SECRET: "   " };
      const req = new Request("http://localhost/trigger");
      const res = await handleHttpTrigger(req, emptySecretEnv);

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain("CRON_SECRET is not configured");
    });

    it("3.3 rejects missing Authorization header when CRON_SECRET is configured", async () => {
      const securedEnv: CronWorkerEnv = { CRON_SECRET: TEST_CRON_SECRET };
      const req = new Request("http://localhost/trigger");
      const res = await handleHttpTrigger(req, securedEnv);

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toBe("Unauthorized");
    });

    it("3.4 rejects invalid schemes and tampered bearer tokens with 401", async () => {
      const securedEnv: CronWorkerEnv = { CRON_SECRET: TEST_CRON_SECRET };
      const adversarialHeaders = [
        "Bearer",
        "Bearer ",
        "Basic " + TEST_CRON_SECRET,
        "Token " + TEST_CRON_SECRET,
        "Bearer wrong_token_value",
        "Bearer " + TEST_CRON_SECRET + "_extra",
        "Bearer " + TEST_CRON_SECRET.slice(0, -1),
      ];

      for (const header of adversarialHeaders) {
        const req = new Request("http://localhost/trigger", {
          headers: { Authorization: header },
        });
        const res = await handleHttpTrigger(req, securedEnv);
        expect(res.status).toBe(401);
      }
    });

    it("3.5 timingSafeStringEqual performs constant-time equality check without throwing on length mismatch", () => {
      expect(timingSafeStringEqual("exact_match_123", "exact_match_123")).toBe(
        true,
      );
      expect(timingSafeStringEqual("exact_match_123", "exact_match_124")).toBe(
        false,
      );
      expect(
        timingSafeStringEqual("short", "much_longer_string_that_differs"),
      ).toBe(false);
      expect(timingSafeStringEqual("", "")).toBe(true);
      expect(timingSafeStringEqual("a", "")).toBe(false);
      expect(timingSafeStringEqual(null as any, "test")).toBe(false);
    });

    it("3.6 allows valid Bearer token and executes health check freely", async () => {
      // 1. Health check is unauthenticated
      const healthReq = new Request("http://localhost/health");
      const healthRes = await handleHttpTrigger(healthReq, {});
      expect(healthRes.status).toBe(200);

      // 2. Valid authenticated trigger
      const securedEnv: CronWorkerEnv = { CRON_SECRET: TEST_CRON_SECRET };
      const validReq = new Request("http://localhost/trigger?cron=5min", {
        headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` },
      });

      const triggerRes = await handleHttpTrigger(validReq, securedEnv);
      // Returns 200 or 207 based on job executions, never 401
      expect(triggerRes.status).toBeLessThan(400);
    });
  });

  // =========================================================================
  // 4. SEC-R4-04: Edge Burst Rate Limiting on Public Endpoints
  // =========================================================================
  describe("4. SEC-R4-04: Edge Rate Limiting & Burst Protection", () => {
    it("4.1 EdgeRateLimiter enforces burst limit and returns remaining tokens", () => {
      const limiter = new EdgeRateLimiter({ maxRequests: 5, windowMs: 10_000 });
      const clientIp = "192.0.2.1";

      for (let i = 1; i <= 5; i++) {
        const result = limiter.check(clientIp);
        expect(result.success).toBe(true);
        expect(result.limit).toBe(5);
        expect(result.remaining).toBe(5 - i);
      }

      // 6th request should be blocked
      const blocked = limiter.check(clientIp);
      expect(blocked.success).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.resetMs).toBeGreaterThan(0);
    });

    it("4.2 getClientIp correctly extracts edge IP headers", () => {
      const reqCf = new Request("https://weletic.com", {
        headers: { "cf-connecting-ip": "203.0.113.10" },
      });
      expect(getClientIp(reqCf)).toBe("203.0.113.10");

      const reqXff = new Request("https://weletic.com", {
        headers: { "x-forwarded-for": "198.51.100.22, 10.0.0.1" },
      });
      expect(getClientIp(reqXff)).toBe("198.51.100.22");

      const reqPlain = new Request("https://weletic.com");
      expect(getClientIp(reqPlain)).toBeNull();
    });

    it("4.3 webhook ingress blocks rapid client bursts exceeding rate limit with HTTP 429", async () => {
      const mockQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
        RATE_LIMIT_MAX: 3, // Low limit for test
        RATE_LIMIT_WINDOW_MS: 10_000,
      };

      const attackerIp = "198.51.100.77";

      for (let i = 0; i < 3; i++) {
        const payload = JSON.stringify({ id: i });
        const signature = signPayload(payload, TEST_SECRET);
        const req = new Request("https://webhook.weletic.com/ingress", {
          method: "POST",
          headers: {
            "cf-connecting-ip": attackerIp,
            "x-shopify-topic": "orders/paid",
            "x-shopify-shop-domain": "yamax.myshopify.com",
            "x-shopify-hmac-sha256": signature,
          },
          body: payload,
        });
        const res = await handleWebhookIngress(req, env);
        expect(res.status).toBe(200);
      }

      // 4th request from same IP exceeds rate limit
      const burstPayload = JSON.stringify({ id: 999 });
      const burstSig = signPayload(burstPayload, TEST_SECRET);
      const burstReq = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "cf-connecting-ip": attackerIp,
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "x-shopify-hmac-sha256": burstSig,
        },
        body: burstPayload,
      });

      const burstRes = await handleWebhookIngress(burstReq, env);
      expect(burstRes.status).toBe(429);
      expect(burstRes.headers.get("Retry-After")).toBeDefined();
      expect(burstRes.headers.get("X-RateLimit-Limit")).toBe("3");
      expect(burstRes.headers.get("X-RateLimit-Remaining")).toBe("0");

      const body = (await burstRes.json()) as { error?: string };
      expect(body.error).toBe("Too Many Requests");
    });

    it("4.4 link redirector blocks aggressive crawlers exceeding rate limit with HTTP 429", async () => {
      const env: LinkRedirectorEnv = {
        RATE_LIMIT_MAX: 2,
        RATE_LIMIT_WINDOW_MS: 10_000,
      };

      const crawlerIp = "192.0.2.88";

      for (let i = 0; i < 2; i++) {
        const req = new Request("https://yamax.com/item-" + i, {
          headers: { "cf-connecting-ip": crawlerIp },
        });
        const res = await handleLinkRedirection(req, env);
        expect(res.status).toBe(404);
      }

      // 3rd request blocked by rate limiter
      const blockedReq = new Request("https://yamax.com/item-blocked", {
        headers: { "cf-connecting-ip": crawlerIp },
      });
      const blockedRes = await handleLinkRedirection(blockedReq, env);
      expect(blockedRes.status).toBe(429);
      expect(blockedRes.headers.get("Retry-After")).toBeDefined();
    });

    it("4.5 cron HTTP trigger blocks burst trigger requests with HTTP 429", async () => {
      const env: CronWorkerEnv = {
        CRON_SECRET: TEST_CRON_SECRET,
        RATE_LIMIT_MAX: 2,
        RATE_LIMIT_WINDOW_MS: 10_000,
      };

      const triggerIp = "203.0.113.55";

      for (let i = 0; i < 2; i++) {
        const req = new Request("http://localhost/trigger?cron=5min", {
          headers: {
            "cf-connecting-ip": triggerIp,
            Authorization: `Bearer ${TEST_CRON_SECRET}`,
          },
        });
        const res = await handleHttpTrigger(req, env);
        expect(res.status).toBeLessThan(400);
      }

      // 3rd request blocked
      const burstReq = new Request("http://localhost/trigger?cron=5min", {
        headers: {
          "cf-connecting-ip": triggerIp,
          Authorization: `Bearer ${TEST_CRON_SECRET}`,
        },
      });
      const burstRes = await handleHttpTrigger(burstReq, env);
      expect(burstRes.status).toBe(429);
    });

    it("4.6 EdgeRateLimiter evicts oldest entries (LRU) when capacity reaches maxEntries threshold", () => {
      const limiter = new EdgeRateLimiter({
        maxRequests: 5,
        windowMs: 10_000,
        maxEntries: 10,
      });

      // Fill 10 entries (client-0 to client-9)
      for (let i = 0; i < 10; i++) {
        limiter.check(`client-${i}`);
      }

      const bucketsMap = (limiter as any).buckets as Map<string, unknown>;
      expect(bucketsMap.size).toBe(10);
      expect(bucketsMap.has("client-0")).toBe(true);

      // Check an 11th distinct client: triggers LRU eviction of client-0
      limiter.check("client-10");
      expect(bucketsMap.size).toBe(10);
      expect(bucketsMap.has("client-0")).toBe(false);
      expect(bucketsMap.has("client-10")).toBe(true);
    });
  });
});
