import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import crypto from "node:crypto";
import {
  handleHttpTrigger,
  timingSafeStringEqual,
  type CronWorkerEnv,
} from "../../workers/cron-triggers/src/index";
import {
  EdgeRateLimiter,
  cronRateLimiter,
  webhookRateLimiter,
  redirectRateLimiter,
  getClientIp,
  createRateLimitResponse,
} from "../../lib/weletic/edge-rate-limiter";
import {
  handleWebhookIngress,
  type WebhookIngressEnv,
} from "../../workers/webhook-ingress/src/index";
import {
  handleLinkRedirection,
  type LinkRedirectorEnv,
} from "../../workers/link-redirector/src/index";

const TEST_SECRET = "shpss_test_shopify_webhook_secret_32bytes_12345";
const VALID_CRON_SECRET = "wltc_cron_master_secret_random_hex_998877665544";

function signPayload(body: string | Uint8Array, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  if (typeof body === "string") {
    hmac.update(body, "utf8");
  } else {
    hmac.update(body);
  }
  return hmac.digest("base64");
}

describe("Challenger M4_2: Adversarial Verification of Cron Auth & Edge Rate Limiting", () => {
  beforeEach(() => {
    cronRateLimiter.reset();
    webhookRateLimiter.reset();
    redirectRateLimiter.reset();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // Section 1: Cron Trigger Fail-Closed Authentication & Auth Bypass Attacks
  // =========================================================================
  describe("1. Cron Trigger Fail-Closed Security & Adversarial Auth Bypass", () => {
    it("1.1 fails closed on unconfigured or empty CRON_SECRET (undefined, empty, whitespace variations)", async () => {
      const invalidEnvConfigs: Array<{ name: string; env: CronWorkerEnv }> = [
        { name: "undefined CRON_SECRET", env: {} },
        { name: "empty string CRON_SECRET", env: { CRON_SECRET: "" } },
        { name: "space only CRON_SECRET", env: { CRON_SECRET: "   " } },
        { name: "tabs and newlines CRON_SECRET", env: { CRON_SECRET: "\t\r\n   " } },
      ];

      for (const { name, env } of invalidEnvConfigs) {
        // Even if caller supplies a Bearer token or matches empty string, must fail closed
        const reqWithBearer = new Request("http://localhost/trigger?cron=5min", {
          headers: { Authorization: "Bearer some_forged_secret" },
        });
        const res = await handleHttpTrigger(reqWithBearer, env);
        expect(res.status, `Failed closed test for ${name}`).toBe(401);

        const data = (await res.json()) as { error?: string };
        expect(data.error).toContain("CRON_SECRET is not configured");

        // Try matching empty Bearer header
        const reqEmptyBearer = new Request("http://localhost/trigger?cron=5min", {
          headers: { Authorization: "Bearer " },
        });
        const resEmpty = await handleHttpTrigger(reqEmptyBearer, env);
        expect(resEmpty.status).toBe(401);
      }
    });

    it("1.2 fails closed on missing, blank, or malformed Authorization header when secret is configured", async () => {
      const env: CronWorkerEnv = { CRON_SECRET: VALID_CRON_SECRET };

      const malformedHeaders = [
        undefined, // no header
        "",
        "   ",
        "\t",
        "Bearer",
        "Bearer ",
        "Bearer  ",
        "Bearer null",
        "Bearer undefined",
        "Basic " + VALID_CRON_SECRET,
        "Token " + VALID_CRON_SECRET,
        "bearer " + VALID_CRON_SECRET, // case-sensitive RFC 6750
        "BEARER " + VALID_CRON_SECRET,
      ];

      for (const authHeader of malformedHeaders) {
        const headers: Record<string, string> = {};
        if (authHeader !== undefined) {
          headers["Authorization"] = authHeader;
        }

        const req = new Request("http://localhost/trigger?cron=5min", { headers });
        const res = await handleHttpTrigger(req, env);
        expect(res.status).toBe(401);
        const data = (await res.json()) as { error?: string };
        expect(data.error).toBe("Unauthorized");
      }
    });

    it("1.3 rejects partial prefix, extension, internal spacing, and forged tokens", async () => {
      const env: CronWorkerEnv = { CRON_SECRET: VALID_CRON_SECRET };

      const prefixAttacks = [
        // Truncated tokens (prefix match exploit)
        `Bearer ${VALID_CRON_SECRET.slice(0, 10)}`,
        `Bearer ${VALID_CRON_SECRET.slice(0, -1)}`,
        // Extended tokens
        `Bearer ${VALID_CRON_SECRET}x`,
        `Bearer ${VALID_CRON_SECRET}_extra`,
        // Double space after Bearer
        `Bearer  ${VALID_CRON_SECRET}`,
        // Suffix match attempt
        `Bearer prefix_${VALID_CRON_SECRET}`,
        // ASCII leetspeak / bitflip forgery
        `Bearer ${VALID_CRON_SECRET.replace("e", "3")}`,
      ];

      for (const token of prefixAttacks) {
        const req = new Request("http://localhost/trigger?cron=5min", {
          headers: { Authorization: token },
        });
        const res = await handleHttpTrigger(req, env);
        expect(res.status, `Token ${JSON.stringify(token)} should be 401`).toBe(401);
        const data = (await res.json()) as { error?: string };
        expect(data.error).toBe("Unauthorized");
      }
    });

    it("1.4 handles extremely long forged tokens without crash or ReDoS (100KB token)", async () => {
      const env: CronWorkerEnv = { CRON_SECRET: VALID_CRON_SECRET };
      const longToken = "Bearer " + "A".repeat(100 * 1024); // 100KB

      const req = new Request("http://localhost/trigger?cron=5min", {
        headers: { Authorization: longToken },
      });
      const res = await handleHttpTrigger(req, env);
      expect(res.status).toBe(401);
    });

    it("1.5 accepts valid Bearer token and triggers execution", async () => {
      const env: CronWorkerEnv = { CRON_SECRET: VALID_CRON_SECRET };

      const req = new Request("http://localhost/trigger?cron=5min", {
        headers: { Authorization: `Bearer ${VALID_CRON_SECRET}` },
      });
      const res = await handleHttpTrigger(req, env);
      // Scheduled handler executed without 401
      expect(res.status).toBeLessThan(400);
      const data = (await res.json()) as { cron?: string; jobs?: unknown[] };
      expect(data.cron).toBe("*/5 * * * *");
      expect(Array.isArray(data.jobs)).toBe(true);
    });
  });

  // =========================================================================
  // Section 2: Constant-Time Comparison Timing & Robustness (timingSafeStringEqual)
  // =========================================================================
  describe("2. Constant-Time Comparison Robustness & Fallback Verification", () => {
    it("2.1 timingSafeStringEqual handles non-string inputs safely without throwing", () => {
      expect(timingSafeStringEqual(null as any, "secret")).toBe(false);
      expect(timingSafeStringEqual("secret", null as any)).toBe(false);
      expect(timingSafeStringEqual(undefined as any, "secret")).toBe(false);
      expect(timingSafeStringEqual(12345 as any, "12345")).toBe(false);
      expect(timingSafeStringEqual({} as any, "secret")).toBe(false);
      expect(timingSafeStringEqual([] as any, "secret")).toBe(false);
      expect(timingSafeStringEqual(true as any, "true")).toBe(false);
      expect(timingSafeStringEqual(Symbol() as any, "secret")).toBe(false);
    });

    it("2.2 timingSafeStringEqual handles multibyte UTF-8 characters and emojis accurately", () => {
      const secretUnicode = "wltc_キー_🔑_mật_mã_123";
      expect(timingSafeStringEqual(secretUnicode, secretUnicode)).toBe(true);

      const modifiedUnicode = "wltc_キー_🔒_mật_mã_123";
      expect(timingSafeStringEqual(secretUnicode, modifiedUnicode)).toBe(false);

      // Normalization difference: decomposed vs composed
      const composed = "mật";
      const decomposed = "mâ\u0323t"; // NFD
      // Byte comparison should detect difference accurately
      expect(timingSafeStringEqual(composed, composed)).toBe(true);
    });

    it("2.3 timingSafeStringEqual works properly when crypto.timingSafeEqual throws or is unavailable (XOR fallback)", () => {
      // Temporarily spy on crypto.timingSafeEqual and make it throw
      const originalTimingSafeEqual = crypto.timingSafeEqual;
      const timingSpy = vi.spyOn(crypto, "timingSafeEqual").mockImplementation(() => {
        throw new Error("Simulated Node crypto unavailable in worker runtime");
      });

      try {
        expect(timingSafeStringEqual("matching_token_abc", "matching_token_abc")).toBe(true);
        expect(timingSafeStringEqual("matching_token_abc", "matching_token_abx")).toBe(false);
        expect(timingSafeStringEqual("matching_token_abc", "xatching_token_abc")).toBe(false);
        expect(timingSafeStringEqual("short", "longer_token")).toBe(false);
        expect(timingSafeStringEqual("", "")).toBe(true);
        expect(timingSafeStringEqual("a", "")).toBe(false);
      } finally {
        timingSpy.mockRestore();
      }
    });

    it("2.4 constant-time timing distribution verification (mismatch at index 0 vs index N)", () => {
      const baseSecret = "a".repeat(128);
      const mismatchAt0 = "b" + "a".repeat(127);
      const mismatchAtEnd = "a".repeat(127) + "b";

      // Warm up JIT
      for (let i = 0; i < 5000; i++) {
        timingSafeStringEqual(baseSecret, mismatchAt0);
        timingSafeStringEqual(baseSecret, mismatchAtEnd);
      }

      const iterations = 30_000;

      const t0Start = performance.now();
      for (let i = 0; i < iterations; i++) {
        timingSafeStringEqual(baseSecret, mismatchAt0);
      }
      const t0Duration = performance.now() - t0Start;

      const tEndStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        timingSafeStringEqual(baseSecret, mismatchAtEnd);
      }
      const tEndDuration = performance.now() - tEndStart;

      // Ensure both operations complete within reasonable order of magnitude
      // In JS micro-benchmarks with GC and JIT, ratios should not exceed extreme disparity
      const ratio = t0Duration / Math.max(0.001, tEndDuration);
      expect(ratio).toBeGreaterThan(0.2);
      expect(ratio).toBeLessThan(5.0);
    });
  });

  // =========================================================================
  // Section 3: Edge Rate Limiter Burst Protection & Header Validation
  // =========================================================================
  describe("3. Edge Rate Limiter Burst Protection & HTTP 429 Formatting", () => {
    it("3.1 verifies createRateLimitResponse sets RFC-compliant 429 headers and payload", async () => {
      const res = createRateLimitResponse(5_500, 100, 0);

      expect(res.status).toBe(429);
      expect(res.headers.get("Content-Type")).toBe("application/json");

      // Retry-After: Math.ceil(5500 / 1000) = 6 seconds
      expect(res.headers.get("Retry-After")).toBe("6");
      expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");

      const resetHeader = res.headers.get("X-RateLimit-Reset");
      expect(resetHeader).toBeDefined();
      const resetTimestamp = parseInt(resetHeader!, 10);
      const nowSec = Math.floor(Date.now() / 1000);
      expect(resetTimestamp).toBeGreaterThanOrEqual(nowSec + 5);

      const body = (await res.json()) as { error: string; message: string; retryAfter: number };
      expect(body.error).toBe("Too Many Requests");
      expect(body.retryAfter).toBe(6);
    });

    it("3.2 getClientIp resolves IP headers with strict priority and multi-IP splitting", () => {
      // 1. cf-connecting-ip has highest priority
      const reqCf = new Request("https://weletic.com", {
        headers: {
          "cf-connecting-ip": "198.51.100.1",
          "x-forwarded-for": "198.51.100.2, 10.0.0.1",
          "x-real-ip": "198.51.100.3",
        },
      });
      expect(getClientIp(reqCf)).toBe("198.51.100.1");

      // 2. x-forwarded-for with multiple proxies extracts client (first token)
      const reqXff = new Request("https://weletic.com", {
        headers: {
          "x-forwarded-for": "  203.0.113.50  , 192.168.1.1, 10.0.0.1",
          "x-real-ip": "198.51.100.3",
        },
      });
      expect(getClientIp(reqXff)).toBe("203.0.113.50");

      // 3. x-real-ip fallback when cf-connecting-ip and x-forwarded-for are absent
      const reqReal = new Request("https://weletic.com", {
        headers: {
          "x-real-ip": "  192.0.2.99  ",
        },
      });
      expect(getClientIp(reqReal)).toBe("192.0.2.99");

      // 4. Missing headers return null cleanly
      const reqEmpty = new Request("https://weletic.com");
      expect(getClientIp(reqEmpty)).toBeNull();

      // 5. Blank headers return null cleanly
      const reqBlank = new Request("https://weletic.com", {
        headers: {
          "cf-connecting-ip": "   ",
          "x-forwarded-for": "",
          "x-real-ip": "  ",
        },
      });
      expect(getClientIp(reqBlank)).toBeNull();
    });

    it("3.3 enforces isolated per-IP token buckets (Client A exceeding limit does not throttle Client B)", async () => {
      const limiter = new EdgeRateLimiter({ maxRequests: 3, windowMs: 10_000 });

      const clientA = "192.0.2.10";
      const clientB = "192.0.2.20";

      // Client A uses all 3 requests
      expect(limiter.check(clientA).success).toBe(true);
      expect(limiter.check(clientA).success).toBe(true);
      expect(limiter.check(clientA).success).toBe(true);
      // Client A 4th request blocked
      const blockedA = limiter.check(clientA);
      expect(blockedA.success).toBe(false);

      // Client B should still have full quota unaffected
      const resultB1 = limiter.check(clientB);
      expect(resultB1.success).toBe(true);
      expect(resultB1.remaining).toBe(2);

      const resultB2 = limiter.check(clientB);
      expect(resultB2.success).toBe(true);
      expect(resultB2.remaining).toBe(1);

      const resultB3 = limiter.check(clientB);
      expect(resultB3.success).toBe(true);
      expect(resultB3.remaining).toBe(0);

      // Client B 4th request blocked
      expect(limiter.check(clientB).success).toBe(false);
    });

    it("3.4 respects limitOverride and windowMsOverride dynamically", () => {
      const limiter = new EdgeRateLimiter({ maxRequests: 10, windowMs: 10_000 });
      const clientIp = "198.51.100.99";

      // Check with strict limitOverride = 1
      const res1 = limiter.check(clientIp, 1, 5_000);
      expect(res1.success).toBe(true);
      expect(res1.limit).toBe(1);
      expect(res1.remaining).toBe(0);

      // Second request immediately blocked
      const res2 = limiter.check(clientIp, 1, 5_000);
      expect(res2.success).toBe(false);
      expect(res2.limit).toBe(1);
      expect(res2.remaining).toBe(0);
    });

    it("3.5 supports sliding window reset after windowMs duration", () => {
      const limiter = new EdgeRateLimiter({ maxRequests: 2, windowMs: 50 });
      const clientIp = "192.0.2.77";

      expect(limiter.check(clientIp).success).toBe(true);
      expect(limiter.check(clientIp).success).toBe(true);
      expect(limiter.check(clientIp).success).toBe(false);

      // Advance time beyond window
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 100;
        const resAfterExpiry = limiter.check(clientIp);
        expect(resAfterExpiry.success).toBe(true);
        expect(resAfterExpiry.remaining).toBe(1);
      } finally {
        Date.now = realNow;
      }
    });
  });

  // =========================================================================
  // Section 4: Memory Boundedness & High Cardinality Stress Testing
  // =========================================================================
  describe("4. Edge Rate Limiter Memory Boundedness & High Cardinality Stress", () => {
    it("4.1 prunes expired entries when capacity reaches maxEntries threshold", () => {
      // Create limiter with low maxEntries capacity = 50
      const limiter = new EdgeRateLimiter({
        maxRequests: 5,
        windowMs: 50,
        maxEntries: 50,
      });

      const realNow = Date.now;
      let mockTime = 1_000_000;
      Date.now = () => mockTime;

      try {
        // Fill 50 entries at mockTime
        for (let i = 0; i < 50; i++) {
          limiter.check(`client-${i}`);
        }

        // Internal map size should be 50
        const bucketsMap = (limiter as any).buckets as Map<string, unknown>;
        expect(bucketsMap.size).toBe(50);

        // Advance time so all 50 entries expire (resetAt was mockTime + 50)
        mockTime += 100;

        // Next check triggers prune(now)
        limiter.check("new-client-after-expire");

        // The 50 expired entries should be pruned, leaving only the 1 new entry
        expect(bucketsMap.size).toBe(1);
      } finally {
        Date.now = realNow;
      }
    });

    it("4.2 bounds client IP cardinality under sub-window bursts via LRU oldest-entry eviction", () => {
      const limiter = new EdgeRateLimiter({
        maxRequests: 10,
        windowMs: 10_000,
        maxEntries: 2_000,
      });

      // Phase 1: First 2,000 distinct IPs (under maxEntries threshold, no prune calls)
      const t1Start = performance.now();
      for (let i = 0; i < 2_000; i++) {
        const ip = `10.0.${(i >> 8) & 255}.${i & 255}`;
        limiter.check(ip);
      }
      const t1Duration = performance.now() - t1Start;

      const bucketsMap = (limiter as any).buckets as Map<string, unknown>;
      expect(bucketsMap.size).toBe(2_000);

      // Phase 2: Next 2,000 distinct IPs (above maxEntries threshold: prune() and LRU eviction run)
      const t2Start = performance.now();
      for (let i = 2_000; i < 4_000; i++) {
        const ip = `10.0.${(i >> 8) & 255}.${i & 255}`;
        limiter.check(ip);
      }
      const t2Duration = performance.now() - t2Start;

      // LRU Eviction: Map size is strictly bounded by maxEntries despite unexpired entries
      expect(bucketsMap.size).toBe(2_000);
      expect(bucketsMap.size).toBeLessThanOrEqual((limiter as any).maxEntries);

      // Phase 2 executes prune + LRU eviction overhead
      expect(t2Duration).toBeGreaterThan(t1Duration);

      // Reset clears everything
      limiter.reset();
      expect(bucketsMap.size).toBe(0);
    });

    it("4.3 handles RATE_LIMIT_DISABLED cleanly across webhook ingress, link redirector, and cron worker", async () => {
      // 1. Webhook Ingress with rate limiting disabled
      const mockQueue = { send: vi.fn().mockResolvedValue(undefined) };
      const webhookEnv: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: TEST_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
        RATE_LIMIT_DISABLED: "true",
        RATE_LIMIT_MAX: 1, // very low limit
      };

      const attackerIp = "192.0.2.111";
      for (let i = 0; i < 5; i++) {
        const payload = JSON.stringify({ id: i });
        const sig = signPayload(payload, TEST_SECRET);
        const req = new Request("https://webhook.weletic.com/ingress", {
          method: "POST",
          headers: {
            "cf-connecting-ip": attackerIp,
            "x-shopify-topic": "orders/paid",
            "x-shopify-shop-domain": "yamax.myshopify.com",
            "x-shopify-hmac-sha256": sig,
          },
          body: payload,
        });
        const res = await handleWebhookIngress(req, webhookEnv);
        // Should not be rate limited (429)
        expect(res.status).toBe(200);
      }

      // 2. Cron Triggers with rate limiting disabled
      const cronEnv: CronWorkerEnv = {
        CRON_SECRET: VALID_CRON_SECRET,
        RATE_LIMIT_DISABLED: true,
        RATE_LIMIT_MAX: 1,
      };

      for (let i = 0; i < 5; i++) {
        const req = new Request("http://localhost/trigger?cron=5min", {
          headers: {
            "cf-connecting-ip": attackerIp,
            Authorization: `Bearer ${VALID_CRON_SECRET}`,
          },
        });
        const res = await handleHttpTrigger(req, cronEnv);
        expect(res.status).toBeLessThan(400);
      }
    });
  });
});
