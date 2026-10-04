import crypto from "node:crypto";
import { redis } from "@/lib/upstash/redis";
import {
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_NONCE_TTL_SECONDS,
  WELETIC_SHOPIFY_REQUEST_ID_HEADER,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
  createWeleticShopifyCanonicalRequest,
  resetServiceAuthNonceCache,
  signWeleticShopifyRequest,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  weleticApiRequest,
  WeleticGatewayError,
} from "../../../../packages/shopify-app/app/weletic-api.server";

const TEST_SECRET = "challenger-test-secret-at-least-32-chars-long";
const BASE_NOW = Date.parse("2026-10-04T12:00:00.000Z");
const BASE_TIMESTAMP = String(BASE_NOW);
const BASE_PATH = "/api/internal/shopify/sessions?shop=test.myshopify.com";
const BASE_BODY = JSON.stringify({ shop: "test.myshopify.com", session: "sess_123" });

// Simulated Redis storage with TTL tracking
const redisStore = new Map<string, number>();

const mockRedisSet = vi.fn(
  async (
    key: string,
    value: string,
    opts?: { nx?: boolean; ex?: number },
  ) => {
    const currentNow = Date.now();
    const existingExpiry = redisStore.get(key);
    if (opts?.nx && existingExpiry !== undefined && existingExpiry > currentNow) {
      return null;
    }
    const ttlSeconds = opts?.ex ?? WELETIC_SHOPIFY_NONCE_TTL_SECONDS;
    redisStore.set(key, currentNow + ttlSeconds * 1000);
    return "OK";
  },
);

vi.mock("@/lib/upstash/redis", () => ({
  redis: {
    set: (...args: any[]) => (mockRedisSet as any)(...args),
  },
}));

function createSignedRequestHelper(options: {
  requestBody?: string;
  signedBody?: string;
  requestTimestamp?: string;
  requestPath?: string;
  requestMethod?: string;
  requestId?: string;
  signedRequestId?: string;
  includeRequestIdHeader?: boolean;
  secret?: string;
} = {}) {
  const {
    requestBody = BASE_BODY,
    signedBody = requestBody,
    requestTimestamp = BASE_TIMESTAMP,
    requestPath = BASE_PATH,
    requestMethod = "POST",
    requestId = crypto.randomUUID(),
    includeRequestIdHeader = true,
    secret = TEST_SECRET,
  } = options;

  const effectiveSignedRequestId =
    "signedRequestId" in options ? options.signedRequestId : requestId;

  const signature = signWeleticShopifyRequest({
    timestamp: requestTimestamp,
    method: requestMethod,
    path: requestPath,
    body: signedBody,
    requestId: effectiveSignedRequestId,
    secret,
  });

  const headers: Record<string, string> = {
    [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: requestTimestamp,
    [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
  };
  if (includeRequestIdHeader && requestId) {
    headers[WELETIC_SHOPIFY_REQUEST_ID_HEADER] = requestId;
  }

  return {
    request: new Request(`https://app.weletic.com${requestPath}`, {
      method: requestMethod,
      headers,
      body: requestBody,
    }),
    body: requestBody,
    requestId,
    timestamp: requestTimestamp,
    signature,
  };
}

describe("Milestone M4: SEC-01 Empirical Challenge & Boundary Tests (Challenger 1)", () => {
  beforeEach(() => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", TEST_SECRET);
    redisStore.clear();
    mockRedisSet.mockReset();
    mockRedisSet.mockImplementation(
      async (
        key: string,
        value: string,
        opts?: { nx?: boolean; ex?: number },
      ) => {
        const currentNow = Date.now();
        const existingExpiry = redisStore.get(key);
        if (opts?.nx && existingExpiry !== undefined && existingExpiry > currentNow) {
          return null;
        }
        const ttlSeconds = opts?.ex ?? WELETIC_SHOPIFY_NONCE_TTL_SECONDS;
        redisStore.set(key, currentNow + ttlSeconds * 1000);
        return "OK";
      },
    );
    resetServiceAuthNonceCache();
  });

  afterEach(() => {
    redisStore.clear();
    resetServiceAuthNonceCache();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // TASK 1: MILLISECOND-EXACT CLOCK SKEW BOUNDARY TESTS
  // =========================================================================
  describe("1. Millisecond-Exact Clock Skew Boundary Tests", () => {
    test("Boundary 1.1: timestamp = now - 300_000 (exact 5 min past) -> PASS", async () => {
      const now = BASE_NOW;
      const exactPastTimestamp = String(now - 300_000);

      const req = createSignedRequestHelper({
        requestTimestamp: exactPastTimestamp,
        requestId: `boundary-past-exact-${crypto.randomUUID()}`,
      });

      const result = await verifyWeleticShopifyRequest({
        request: req.request,
        body: req.body,
        now,
      });

      expect(result).toBe(true);
    });

    test("Boundary 1.2: timestamp = now - 300_001 (1ms beyond 5 min past) -> FAIL", async () => {
      const now = BASE_NOW;
      const expiredPastTimestamp = String(now - 300_001);

      const req = createSignedRequestHelper({
        requestTimestamp: expiredPastTimestamp,
        requestId: `boundary-past-expired-${crypto.randomUUID()}`,
      });

      const result = await verifyWeleticShopifyRequest({
        request: req.request,
        body: req.body,
        now,
      });

      expect(result).toBe(false);
    });

    test("Boundary 1.3: timestamp = now + 300_000 (exact 5 min future) -> PASS", async () => {
      const now = BASE_NOW;
      const exactFutureTimestamp = String(now + 300_000);

      const req = createSignedRequestHelper({
        requestTimestamp: exactFutureTimestamp,
        requestId: `boundary-future-exact-${crypto.randomUUID()}`,
      });

      const result = await verifyWeleticShopifyRequest({
        request: req.request,
        body: req.body,
        now,
      });

      expect(result).toBe(true);
    });

    test("Boundary 1.4: timestamp = now + 300_001 (1ms beyond 5 min future) -> FAIL", async () => {
      const now = BASE_NOW;
      const expiredFutureTimestamp = String(now + 300_001);

      const req = createSignedRequestHelper({
        requestTimestamp: expiredFutureTimestamp,
        requestId: `boundary-future-expired-${crypto.randomUUID()}`,
      });

      const result = await verifyWeleticShopifyRequest({
        request: req.request,
        body: req.body,
        now,
      });

      expect(result).toBe(false);
    });

    test("Non-integer and invalid timestamps are immediately rejected", async () => {
      const now = BASE_NOW;
      const invalidTimestamps = [
        "not-a-number",
        "1.23456",
        "",
        "Infinity",
        "-Infinity",
        "NaN",
        String(Number.MAX_SAFE_INTEGER + 10),
      ];

      for (const badTs of invalidTimestamps) {
        const req = createSignedRequestHelper({
          requestTimestamp: badTs,
          requestId: `bad-ts-${crypto.randomUUID()}`,
        });

        const result = await verifyWeleticShopifyRequest({
          request: req.request,
          body: req.body,
          now,
        });

        expect(result).toBe(false);
      }
    });
  });

  // =========================================================================
  // TASK 2: FUTURE-SKEW REPLAY WINDOW & NONCE TTL
  // =========================================================================
  describe("2. Future-Skew Replay Window & Nonce TTL Formulation", () => {
    test("Request signed at T0 with timestamp = now + 299s: 1st verify passes, replay at T0 + 360s is BLOCKED", async () => {
      const t0 = BASE_NOW;
      // Future-skew: 299 seconds (4 minutes 59 seconds ahead)
      const futureSkewMs = 299 * 1000;
      const futureTimestamp = String(t0 + futureSkewMs);
      const fixedRequestId = `future-skew-${crypto.randomUUID()}`;

      // Mock Redis storage tracking timestamps accurately
      let simulatedTime = t0;
      mockRedisSet.mockImplementation(
        async (
          key: string,
          value: string,
          opts?: { nx?: boolean; ex?: number },
        ) => {
          const existingExpiry = redisStore.get(key);
          if (opts?.nx && existingExpiry !== undefined && existingExpiry > simulatedTime) {
            return null; // Key still exists and hasn't expired
          }
          const ttlSeconds = opts?.ex ?? WELETIC_SHOPIFY_NONCE_TTL_SECONDS;
          redisStore.set(key, simulatedTime + ttlSeconds * 1000);
          return "OK";
        },
      );

      const signedReq = createSignedRequestHelper({
        requestTimestamp: futureTimestamp,
        requestId: fixedRequestId,
      });

      // 1. First verification at T0: within +5m clock skew (299,000ms <= 300,000ms)
      const firstResult = await verifyWeleticShopifyRequest({
        request: signedReq.request.clone(),
        body: signedReq.body,
        now: t0,
      });
      expect(firstResult).toBe(true);

      // Verify that Redis SET NX EX was called with dynamic TTL >= 720s
      expect(mockRedisSet).toHaveBeenCalledTimes(1);
      const lastCallOpts = mockRedisSet.mock.calls[0][2];
      expect(lastCallOpts?.nx).toBe(true);
      expect(lastCallOpts?.ex).toBeGreaterThanOrEqual(720);

      // 2. Fast-forward simulated time to T6 = T0 + 6 minutes (360,000ms)
      const t6 = t0 + 360 * 1000;
      simulatedTime = t6;

      // At T6, the request's timestamp (T0 + 299s) is now 61 seconds in the past:
      // (T6 - (T0 + 299s)) = 360s - 299s = 61s <= 300s.
      // Clock skew alone would STILL consider this request fresh!
      // If nonce TTL had been 360s (6 min), it would have expired in Redis, allowing replay!
      // But Worker's 720s dynamic TTL keeps it alive until at least T0 + 720s.

      const replayResultAtT6 = await verifyWeleticShopifyRequest({
        request: signedReq.request.clone(),
        body: signedReq.body,
        now: t6,
      });

      // MUST be rejected because nonce is still retained!
      expect(replayResultAtT6).toBe(false);

      // 3. What happens much later at T13 = T0 + 780s (13 minutes, after 720s TTL expires)?
      const t13 = t0 + 780 * 1000;
      simulatedTime = t13;
      // At T13, the request timestamp (T0 + 299s) is 481s in the past: 481s > 300s.
      // Clock skew check rejects it!
      const replayResultAtT13 = await verifyWeleticShopifyRequest({
        request: signedReq.request.clone(),
        body: signedReq.body,
        now: t13,
      });
      expect(replayResultAtT13).toBe(false);
    });

    test("In-memory fallback cache also blocks future-skew replay across the 6-minute window", async () => {
      // Simulate Redis unavailable with in-memory fallback
      mockRedisSet.mockRejectedValue(new Error("Redis offline"));

      const t0 = BASE_NOW;
      const futureTimestamp = String(t0 + 299 * 1000);
      const nonce = `inmem-future-skew-${crypto.randomUUID()}`;

      const signedReq = createSignedRequestHelper({
        requestTimestamp: futureTimestamp,
        requestId: nonce,
      });

      // First verification at T0 passes via in-memory cache
      const firstResult = await verifyWeleticShopifyRequest({
        request: signedReq.request.clone(),
        body: signedReq.body,
        now: t0,
      });
      expect(firstResult).toBe(true);

      // Replay at T0 + 360s is blocked by in-memory cache
      const t6 = t0 + 360 * 1000;
      const replayResult = await verifyWeleticShopifyRequest({
        request: signedReq.request.clone(),
        body: signedReq.body,
        now: t6,
      });
      expect(replayResult).toBe(false);
    });
  });

  // =========================================================================
  // TASK 3: RETRY LOOP OF weleticApiRequest (HTTP 503 THEN 200)
  // =========================================================================
  describe("3. Caller Retry Loop with weleticApiRequest (503 then 200)", () => {
    test("Upstream returns 503 then 200: each retry transmits a fresh requestId and succeeds verification", async () => {
      vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
      vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", TEST_SECRET);
      vi.stubEnv("WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID", "true");

      const capturedRequestIds: string[] = [];
      const capturedTimestamps: string[] = [];
      const capturedSignatures: string[] = [];
      let serverCallCount = 0;

      // Mock global fetch simulating upstream server that returns 503 on 1st call, 200 on 2nd
      const mockFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        serverCallCount++;
        const request = new Request(input, init);
        const reqId = request.headers.get(WELETIC_SHOPIFY_REQUEST_ID_HEADER)!;
        const reqTs = request.headers.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER)!;
        const reqSig = request.headers.get(WELETIC_SHOPIFY_SIGNATURE_HEADER)!;
        const reqBody = String(init?.body ?? "");

        capturedRequestIds.push(reqId);
        capturedTimestamps.push(reqTs);
        capturedSignatures.push(reqSig);

        // Server-side verification using verifyWeleticShopifyRequest
        const isValid = await verifyWeleticShopifyRequest({
          request,
          body: reqBody,
          now: Number(reqTs),
        });

        // The request MUST be cryptographically valid and nonce must be unique
        expect(isValid).toBe(true);

        if (serverCallCount === 1) {
          // Upstream is overloaded: return 503 Service Unavailable
          return new Response(
            JSON.stringify({ error: "temporarily_unavailable" }),
            {
              status: 503,
              statusText: "Service Unavailable",
              headers: { "Content-Type": "application/json" },
            },
          );
        }

        // Upstream recovered: return 200 OK
        return new Response(
          JSON.stringify({ success: true, attempt: serverCallCount }),
          {
            status: 200,
            statusText: "OK",
            headers: { "Content-Type": "application/json" },
          },
        );
      });

      vi.stubGlobal("fetch", mockFetch);

      // Caller retry loop pattern:
      const maxRetries = 2;
      let finalResponse: Response | null = null;
      let attemptsMade = 0;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        attemptsMade++;
        try {
          finalResponse = await weleticApiRequest("/api/internal/shopify/sessions", {
            method: "POST",
            body: JSON.stringify({ action: "coordinate" }),
          });
          break; // Success!
        } catch (error: any) {
          if (
            attempt < maxRetries &&
            error instanceof WeleticGatewayError &&
            error.status === 503
          ) {
            // Transient 503 error: proceed to next retry attempt
            continue;
          }
          throw error;
        }
      }

      // Assertions on the retry loop outcome:
      expect(attemptsMade).toBe(2);
      expect(serverCallCount).toBe(2);
      expect(finalResponse).not.toBeNull();
      expect(finalResponse!.status).toBe(200);

      const responseJson = await finalResponse!.json();
      expect(responseJson).toEqual({ success: true, attempt: 2 });

      // Empirical proof: each attempt generated a UNIQUE requestId and unique signature
      expect(capturedRequestIds).toHaveLength(2);
      expect(capturedRequestIds[0]).toBeTruthy();
      expect(capturedRequestIds[1]).toBeTruthy();
      expect(capturedRequestIds[0]).not.toBe(capturedRequestIds[1]);

      // Both are valid UUIDs
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(capturedRequestIds[0]).toMatch(uuidRegex);
      expect(capturedRequestIds[1]).toMatch(uuidRegex);

      // Signatures are distinct because canonical string binds the fresh requestId
      expect(capturedSignatures[0]).not.toBe(capturedSignatures[1]);
    });

    test("Adversary replaying 1st attempt during retry is rejected, while legitimate 2nd attempt succeeds", async () => {
      vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
      vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", TEST_SECRET);

      let firstRequestHeaders: Headers | null = null;
      let firstRequestBody: string = "";
      let callCount = 0;

      const mockFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        callCount++;
        const request = new Request(input, init);
        if (callCount === 1) {
          firstRequestHeaders = request.headers;
          firstRequestBody = String(init?.body ?? "");
          // Verify first request
          const ok = await verifyWeleticShopifyRequest({
            request: request.clone(),
            body: firstRequestBody,
            now: Number(request.headers.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER)),
          });
          expect(ok).toBe(true);
          return new Response(JSON.stringify({ error: "busy" }), { status: 503 });
        }
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      });

      vi.stubGlobal("fetch", mockFetch);

      // 1. Initial attempt fails with 503
      await expect(
        weleticApiRequest("/api/internal/shopify/sessions", {
          method: "POST",
          body: JSON.stringify({ step: 1 }),
        }),
      ).rejects.toThrow(WeleticGatewayError);

      expect(firstRequestHeaders).not.toBeNull();

      // 2. Adversary intercepts Attempt 1 and attempts to replay it to the verifier
      const replayedReq = new Request("https://app.weletic.com/api/internal/shopify/sessions", {
        method: "POST",
        headers: firstRequestHeaders!,
        body: firstRequestBody,
      });
      const replayVerification = await verifyWeleticShopifyRequest({
        request: replayedReq,
        body: firstRequestBody,
        now: Number(firstRequestHeaders!.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER)),
      });
      // Adversary replay MUST FAIL
      expect(replayVerification).toBe(false);

      // 3. Legitimate caller retries -> generates fresh requestId and succeeds
      const retryResponse = await weleticApiRequest("/api/internal/shopify/sessions", {
        method: "POST",
        body: JSON.stringify({ step: 1 }),
      });
      expect(retryResponse.status).toBe(200);
    });
  });

  // =========================================================================
  // TASK 4: ADVERSARIAL INTEGRITY & TAMPERING ATTACK VECTORS
  // =========================================================================
  describe("4. Adversarial Integrity & Attack Vectors", () => {
    test("Altering x-weletic-request-id in transit invalidates HMAC signature", async () => {
      const originalReqId = crypto.randomUUID();
      const tamperedReqId = crypto.randomUUID();

      const signedReq = createSignedRequestHelper({
        requestId: originalReqId,
      });

      // Attacker intercepts request and swaps x-weletic-request-id with tamperedReqId
      const tamperedHeaders = new Headers(signedReq.request.headers);
      tamperedHeaders.set(WELETIC_SHOPIFY_REQUEST_ID_HEADER, tamperedReqId);

      const tamperedReq = new Request(signedReq.request.url, {
        method: "POST",
        headers: tamperedHeaders,
        body: signedReq.body,
      });

      const result = await verifyWeleticShopifyRequest({
        request: tamperedReq,
        body: signedReq.body,
        now: BASE_NOW,
      });

      // HMAC mismatch -> false
      expect(result).toBe(false);
    });

    test("Modifying URL query parameters invalidates signature", async () => {
      const signedReq = createSignedRequestHelper({
        requestPath: "/api/internal/shopify/catalog?shop=victim.myshopify.com",
      });

      // Attacker modifies query param to target attacker store
      const tamperedUrl = "https://app.weletic.com/api/internal/shopify/catalog?shop=attacker.myshopify.com";
      const tamperedReq = new Request(tamperedUrl, {
        method: "POST",
        headers: signedReq.request.headers,
        body: signedReq.body,
      });

      const result = await verifyWeleticShopifyRequest({
        request: tamperedReq,
        body: signedReq.body,
        now: BASE_NOW,
      });

      expect(result).toBe(false);
    });

    test("RequestId format bounds: 128 chars allowed, 129 chars rejected, invalid chars rejected", async () => {
      // 128 chars allowed
      const maxLenId = "a".repeat(128);
      const req128 = createSignedRequestHelper({ requestId: maxLenId });
      expect(
        await verifyWeleticShopifyRequest({
          request: req128.request,
          body: req128.body,
          now: BASE_NOW,
        }),
      ).toBe(true);

      // 129 chars rejected
      const overLenId = "a".repeat(129);
      const req129 = createSignedRequestHelper({ requestId: overLenId });
      expect(
        await verifyWeleticShopifyRequest({
          request: req129.request,
          body: req129.body,
          now: BASE_NOW,
        }),
      ).toBe(false);

      // Special characters rejected by regex whitelist /^[A-Za-z0-9_-]{1,128}$/
      const invalidCharIds = [
        "req.with.periods",
        "req:with:colons",
        "req@special!symbols",
        "req#hash",
        "req~tilde",
        "req/slash",
      ];
      for (const badId of invalidCharIds) {
        const reqBad = createSignedRequestHelper({ requestId: badId });
        expect(
          await verifyWeleticShopifyRequest({
            request: reqBad.request,
            body: reqBad.body,
            now: BASE_NOW,
          }),
        ).toBe(false);
      }
    });
  });

  // =========================================================================
  // TASK 5: DUAL-MODE ROLLOUT TRANSITION & REDIS POLICY VERIFICATION
  // =========================================================================
  describe("5. Dual-Mode Rollout & Redis Resilience Policies", () => {
    test("Dual-mode rollout: transition mode accepts legacy caller; strict mode rejects legacy caller", async () => {
      // 1. Transition mode: WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID=false
      vi.stubEnv("WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID", "false");

      const legacySig = signWeleticShopifyRequest({
        timestamp: BASE_TIMESTAMP,
        method: "POST",
        path: BASE_PATH,
        body: BASE_BODY,
        secret: TEST_SECRET,
      });

      const legacyReq = new Request(`https://app.weletic.com${BASE_PATH}`, {
        method: "POST",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: BASE_TIMESTAMP,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: legacySig,
        },
        body: BASE_BODY,
      });

      // Legacy caller without requestId passes in transition mode
      expect(
        await verifyWeleticShopifyRequest({
          request: legacyReq.clone(),
          body: BASE_BODY,
          now: BASE_NOW,
        }),
      ).toBe(true);

      // New caller with requestId also passes in transition mode and is recorded in anti-replay
      const newReq = createSignedRequestHelper();
      expect(
        await verifyWeleticShopifyRequest({
          request: newReq.request.clone(),
          body: newReq.body,
          now: BASE_NOW,
        }),
      ).toBe(true);

      // Replay of new caller is blocked even in transition mode
      expect(
        await verifyWeleticShopifyRequest({
          request: newReq.request.clone(),
          body: newReq.body,
          now: BASE_NOW,
        }),
      ).toBe(false);

      // 2. Strict mode: WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID=true
      vi.stubEnv("WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID", "true");

      // Legacy caller without requestId is REJECTED in strict mode
      expect(
        await verifyWeleticShopifyRequest({
          request: legacyReq.clone(),
          body: BASE_BODY,
          now: BASE_NOW,
        }),
      ).toBe(false);
    });

    test("Redis failure mode fail_closed rejects requests immediately", async () => {
      vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", "fail_closed");
      mockRedisSet.mockRejectedValue(new Error("Redis cluster partitioned"));

      const req = createSignedRequestHelper();
      const result = await verifyWeleticShopifyRequest({
        request: req.request,
        body: req.body,
        now: BASE_NOW,
      });

      expect(result).toBe(false);
    });

    test("Redis failure mode default (scoped fail-open) falls back to memory cache and prevents local replay", async () => {
      vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", "");
      mockRedisSet.mockRejectedValue(new Error("Redis connection timeout"));

      const req = createSignedRequestHelper();

      // First attempt succeeds via local memory fallback
      expect(
        await verifyWeleticShopifyRequest({
          request: req.request.clone(),
          body: req.body,
          now: BASE_NOW,
        }),
      ).toBe(true);

      // Subsequent replay on same instance is blocked by memory fallback
      expect(
        await verifyWeleticShopifyRequest({
          request: req.request.clone(),
          body: req.body,
          now: BASE_NOW,
        }),
      ).toBe(false);
    });

    test("Multi-attempt retry loop: 503 -> 503 -> 200 sends 3 distinct requestIds, all verified", async () => {
      vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
      vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", TEST_SECRET);

      const requestIds: string[] = [];
      let attemptCount = 0;

      const mockFetch = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        attemptCount++;
        const request = new Request(input, init);
        const reqId = request.headers.get(WELETIC_SHOPIFY_REQUEST_ID_HEADER)!;
        requestIds.push(reqId);

        const ok = await verifyWeleticShopifyRequest({
          request,
          body: String(init?.body ?? ""),
          now: Number(request.headers.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER)),
        });
        expect(ok).toBe(true);

        if (attemptCount < 3) {
          return new Response(JSON.stringify({ error: "busy" }), { status: 503 });
        }
        return new Response(JSON.stringify({ success: true, attempts: attemptCount }), { status: 200 });
      });

      vi.stubGlobal("fetch", mockFetch);

      let finalRes: Response | null = null;
      for (let i = 0; i < 3; i++) {
        try {
          finalRes = await weleticApiRequest("/api/internal/shopify/sessions", {
            method: "POST",
            body: "{}",
          });
          break;
        } catch (e: any) {
          if (i < 2 && e instanceof WeleticGatewayError && e.status === 503) {
            continue;
          }
          throw e;
        }
      }

      expect(finalRes).not.toBeNull();
      expect(finalRes!.status).toBe(200);
      expect(requestIds).toHaveLength(3);
      // All 3 IDs must be unique
      const uniqueIds = new Set(requestIds);
      expect(uniqueIds.size).toBe(3);
    });
  });
});
