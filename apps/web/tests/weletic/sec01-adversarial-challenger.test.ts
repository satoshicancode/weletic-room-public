import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
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
import { POST as catalogPostHandler } from "../../app/api/internal/shopify/catalog/route";

// Hoisted Redis mock state
const redisStore = new Map<string, number>();
const mockRedisSet = vi.fn(
  async (
    key: string,
    value: string,
    opts?: { nx?: boolean; ex?: number },
  ) => {
    const now = Date.now();
    const existingExpiry = redisStore.get(key);
    if (opts?.nx && existingExpiry !== undefined && existingExpiry > now) {
      return null;
    }
    const ttlSeconds = opts?.ex ?? 720;
    redisStore.set(key, now + ttlSeconds * 1000);
    return "OK";
  },
);

vi.mock("@/lib/upstash/redis", () => ({
  redis: {
    set: (...args: any[]) => (mockRedisSet as any)(...args),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: {
      findUnique: vi.fn().mockResolvedValue({
        id: "ws_test_adversarial",
        defaultProgramId: "prog_test_adversarial",
        weleticShopifyStore: {
          syncStatus: "synced",
          lastFullSyncAt: new Date(),
          markets: [{ id: "mkt_1" }],
          _count: { products: 10 },
        },
      }),
    },
  },
}));

vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  resolveShopifyStoreByDomain: vi.fn().mockResolvedValue({
    workspaceId: "ws_test_adversarial",
    shop: "test-store.myshopify.com",
  }),
}));

vi.mock("@/lib/weletic/shopify/catalog-sync", () => ({
  syncWeleticShopifyCatalog: vi.fn().mockResolvedValue({
    runId: "run_test_adversarial",
    stats: { processed: 10 },
  }),
}));

const TEST_SECRET = "test-shopify-service-secret-with-32-characters";
const BASE_NOW = Date.parse("2026-10-04T12:00:00.000Z");
const BASE_PATH = "/api/internal/shopify/catalog?shop=test-store.myshopify.com";
const BASE_URL = `https://app.weletic.com${BASE_PATH}`;
const BASE_BODY = "{}";

function buildSignedRequest(options: {
  timestamp?: number;
  requestId?: string;
  body?: string;
  path?: string;
  method?: string;
  secret?: string;
  headers?: Record<string, string>;
  omitRequestIdHeader?: boolean;
  tamperedRequestIdHeader?: string;
} = {}) {
  const reqTimestamp = String(options.timestamp ?? BASE_NOW);
  const reqId = options.requestId ?? `req-${crypto.randomUUID()}`;
  const reqBody = options.body ?? BASE_BODY;
  const reqPath = options.path ?? BASE_PATH;
  const reqMethod = options.method ?? "POST";
  const reqSecret = options.secret ?? TEST_SECRET;

  const signature = signWeleticShopifyRequest({
    timestamp: reqTimestamp,
    method: reqMethod,
    path: reqPath,
    body: reqBody,
    requestId: reqId,
    secret: reqSecret,
  });

  const headers = new Headers(options.headers);
  headers.set(WELETIC_SHOPIFY_TIMESTAMP_HEADER, reqTimestamp);
  headers.set(WELETIC_SHOPIFY_SIGNATURE_HEADER, signature);

  if (!options.omitRequestIdHeader) {
    headers.set(
      WELETIC_SHOPIFY_REQUEST_ID_HEADER,
      options.tamperedRequestIdHeader !== undefined
        ? options.tamperedRequestIdHeader
        : reqId,
    );
  }

  const request = new Request(`https://app.weletic.com${reqPath}`, {
    method: reqMethod,
    headers,
    body: reqBody,
  });

  return { request, body: reqBody, signature, requestId: reqId, timestamp: reqTimestamp };
}

describe("SEC-01 Adversarial Challenger Attack & Bypass Suite", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BASE_NOW);
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", TEST_SECRET);
    redisStore.clear();
    mockRedisSet.mockReset();
    mockRedisSet.mockImplementation(
      async (
        key: string,
        value: string,
        opts?: { nx?: boolean; ex?: number },
      ) => {
        const now = Date.now();
        const existingExpiry = redisStore.get(key);
        if (opts?.nx && existingExpiry !== undefined && existingExpiry > now) {
          return null;
        }
        const ttlSeconds = opts?.ex ?? 720;
        redisStore.set(key, now + ttlSeconds * 1000);
        return "OK";
      },
    );
    resetServiceAuthNonceCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    resetServiceAuthNonceCache();
  });

  // =========================================================================
  // TASK 1: REPLAY & TAMPERING ATTACKS
  // =========================================================================

  describe("Task 1: Replay & Tampering Attacks", () => {
    test("Direct replay attack: 10 consecutive requests with identical timestamp & requestId -> only 1st succeeds, 9 return 401 / false", async () => {
      const fixedRequestId = `replay-seq-${crypto.randomUUID()}`;
      const { request: initialReq, body: reqBody } = buildSignedRequest({
        requestId: fixedRequestId,
        timestamp: BASE_NOW,
      });

      // 1. Verification function level: test 10 consecutive verify attempts
      const verifyResults: boolean[] = [];
      for (let i = 0; i < 10; i++) {
        const req = buildSignedRequest({
          requestId: fixedRequestId,
          timestamp: BASE_NOW,
        });
        const result = await verifyWeleticShopifyRequest({
          request: req.request,
          body: req.body,
          now: BASE_NOW,
        });
        verifyResults.push(result);
      }

      // Exactly the first attempt succeeds
      expect(verifyResults[0]).toBe(true);
      // All subsequent 9 attempts are rejected
      for (let i = 1; i < 10; i++) {
        expect(verifyResults[i]).toBe(false);
      }
      expect(verifyResults.filter(Boolean).length).toBe(1);

      // 2. Route handler level: verifies actual HTTP 401 response on replayed requests
      resetServiceAuthNonceCache();
      redisStore.clear();

      const routeStatuses: number[] = [];
      for (let i = 0; i < 10; i++) {
        const req = buildSignedRequest({
          requestId: fixedRequestId,
          timestamp: BASE_NOW,
        });
        const response = await catalogPostHandler(req.request);
        routeStatuses.push(response.status);
      }

      // First request passes authentication (reaches business logic -> 200 OK)
      expect(routeStatuses[0]).toBe(200);
      // All subsequent 9 requests are rejected with 401 Unauthorized
      for (let i = 1; i < 10; i++) {
        expect(routeStatuses[i]).toBe(401);
      }
      expect(routeStatuses.filter((s) => s === 401).length).toBe(9);
    });

    test("Header tampering: valid signature preserved, but x-weletic-request-id altered -> HMAC verification rejects immediately", async () => {
      const originalRequestId = "legitimate-req-id-uuid-v4-123456";
      const tamperedRequestId = "attacker-altered-req-id-999999";

      // Attacker copies valid signature from originalRequestId but substitutes tamperedRequestId in header
      const { request, body: reqBody } = buildSignedRequest({
        requestId: originalRequestId,
        tamperedRequestIdHeader: tamperedRequestId,
        timestamp: BASE_NOW,
      });

      // Verification fails immediately due to constant-time HMAC mismatch
      const isValid = await verifyWeleticShopifyRequest({
        request,
        body: reqBody,
        now: BASE_NOW,
      });
      expect(isValid).toBe(false);

      // Route handler returns 401 Unauthorized
      const routeRes = await catalogPostHandler(request.clone());
      expect(routeRes.status).toBe(401);
      const json = await routeRes.json();
      expect(json).toEqual({ error: "Unauthorized" });

      // Ensure the tampered request ID was never recorded in Redis (attack failed prior to storage)
      expect(mockRedisSet).not.toHaveBeenCalledWith(
        expect.stringContaining(tamperedRequestId),
        expect.anything(),
        expect.anything(),
      );
    });

    test("Header stripping: x-weletic-request-id removed in strict mode -> rejected immediately with 401", async () => {
      vi.stubEnv("WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID", "true");

      // Build a request without x-weletic-request-id header
      const { request, body: reqBody } = buildSignedRequest({
        omitRequestIdHeader: true,
        timestamp: BASE_NOW,
      });

      expect(request.headers.get(WELETIC_SHOPIFY_REQUEST_ID_HEADER)).toBeNull();

      const isValid = await verifyWeleticShopifyRequest({
        request,
        body: reqBody,
        now: BASE_NOW,
      });
      expect(isValid).toBe(false);

      // Route handler returns 401
      const routeRes = await catalogPostHandler(request.clone());
      expect(routeRes.status).toBe(401);
      const json = await routeRes.json();
      expect(json).toEqual({ error: "Unauthorized" });
    });

    test("Header stripping: x-weletic-request-id removed in default mode (process.env unset) -> defaults to strict, rejected", async () => {
      // Per line 229: process.env.WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID !== "false"
      // If unset, it defaults to strict (true)
      vi.stubEnv("WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID", "");

      const { request, body: reqBody } = buildSignedRequest({
        omitRequestIdHeader: true,
        timestamp: BASE_NOW,
      });

      const isValid = await verifyWeleticShopifyRequest({
        request,
        body: reqBody,
        now: BASE_NOW,
      });
      expect(isValid).toBe(false);
    });

    test("Canonical injection / Newline injection: requestId with newlines or special chars cannot break canonical format", async () => {
      // 1. Layer 1 (HTTP Parser / Headers spec): Verify that newline injection is rejected at transport/Headers layer
      const rawNewlineIds = [
        "abc\nPOST\n/api/internal/shopify/catalog\n{}",
        "abc\r\nPOST\r\n/fake",
        "req\nid\nattack",
        "req\0nullbyte",
      ];

      for (const rawId of rawNewlineIds) {
        // Headers.set rejects newline/nullbyte per HTTP specification
        expect(() => {
          const h = new Headers();
          h.set(WELETIC_SHOPIFY_REQUEST_ID_HEADER, rawId);
        }).toThrow();

        // Layer 2 (Application layer): Even if an adversary bypasses Headers via a mock request object,
        // verifyWeleticShopifyRequest strictly enforces /^[A-Za-z0-9_-]{1,128}$/
        const mockHeaders = {
          get: (name: string) => {
            if (name.toLowerCase() === WELETIC_SHOPIFY_REQUEST_ID_HEADER) return rawId;
            if (name.toLowerCase() === WELETIC_SHOPIFY_TIMESTAMP_HEADER) return String(BASE_NOW);
            if (name.toLowerCase() === WELETIC_SHOPIFY_SIGNATURE_HEADER) return "a".repeat(64);
            return null;
          },
        };

        const mockReq = {
          method: "POST",
          url: BASE_URL,
          headers: mockHeaders,
        } as unknown as Request;

        const isValid = await verifyWeleticShopifyRequest({
          request: mockReq,
          body: BASE_BODY,
          now: BASE_NOW,
        });

        // Rejected at regex check before canonical generation or Redis check
        expect(isValid).toBe(false);
      }

      // 2. Test special character injections that pass Headers.set but violate /^[A-Za-z0-9_-]{1,128}$/
      const specialCharIds = [
        "req id with spaces",
        "req;drop_database",
        "<script>alert(1)</script>",
        "../../../etc/passwd",
        "req@domain.com",
        "req#hash",
        "req$var",
        "a".repeat(129), // Exceeds 128 char limit
      ];

      for (const badId of specialCharIds) {
        const { request, body: reqBody } = buildSignedRequest({
          requestId: badId,
          timestamp: BASE_NOW,
        });

        const isValid = await verifyWeleticShopifyRequest({
          request,
          body: reqBody,
          now: BASE_NOW,
        });

        // Must reject due to strict character whitelist /^[A-Za-z0-9_-]{1,128}$/
        expect(isValid).toBe(false);

        // Route handler returns 401
        const routeRes = await catalogPostHandler(request.clone());
        expect(routeRes.status).toBe(401);

        // Redis must never be touched for invalid character IDs
        expect(mockRedisSet).not.toHaveBeenCalledWith(
          expect.stringContaining(badId),
          expect.anything(),
          expect.anything(),
        );
      }
    });

    test("Canonical injection: verified that valid requestId chars strictly conform to [A-Za-z0-9_-]", () => {
      const validIds = [
        "valid-uuid-4b6a-9892-0b70c910385b",
        "valid_underscore_id_12345",
        "UPPERCASE-LOWERCASE-0123456789",
        "a", // 1 char
        "a".repeat(128), // 128 chars boundary
      ];

      for (const id of validIds) {
        const canonical = createWeleticShopifyCanonicalRequest({
          timestamp: String(BASE_NOW),
          method: "POST",
          path: BASE_PATH,
          body: BASE_BODY,
          requestId: id,
        });
        expect(canonical).toBe(
          `${BASE_NOW}\nPOST\n${BASE_PATH}\n${BASE_BODY}\n${id}`,
        );
      }
    });
  });

  // =========================================================================
  // TASK 2: REDIS FAILURE MODES (FAIL_CLOSED & SCOPED FAIL_OPEN)
  // =========================================================================

  describe("Task 2: Redis Failure Modes", () => {
    test("Redis outage in fail_closed mode -> rejects safely (returns false / 401)", async () => {
      vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", "fail_closed");

      // Mock Redis throwing various network/service exceptions
      const redisErrors = [
        new Error("ECONNREFUSED 127.0.0.1:6379"),
        new Error("ETIMEDOUT: Connection to Upstash timed out after 3000ms"),
        new Error("ClusterDown: Redis cluster is down or partitioned"),
      ];

      for (const err of redisErrors) {
        mockRedisSet.mockRejectedValueOnce(err);

        const { request, body: reqBody } = buildSignedRequest({
          timestamp: BASE_NOW,
          requestId: `fail-closed-${crypto.randomUUID()}`,
        });

        // Verification function returns false without throwing uncaught exceptions
        const isValid = await verifyWeleticShopifyRequest({
          request,
          body: reqBody,
          now: BASE_NOW,
        });
        expect(isValid).toBe(false);

        // Route handler returns 401 safely
        mockRedisSet.mockRejectedValueOnce(err);
        const routeRes = await catalogPostHandler(request.clone());
        expect(routeRes.status).toBe(401);
      }
    });

    test("Redis outage in default mode (scoped fail-open) -> in-memory fallback allows 1st request but blocks local replays", async () => {
      // Default mode: process.env.WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE is unset or not "fail_closed"
      vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", "");

      // Force Redis to throw error on every set attempt
      mockRedisSet.mockRejectedValue(new Error("Upstash REST service outage"));

      const uniqueReqId = `redis-outage-fallback-${crypto.randomUUID()}`;
      const { request: initialReq, body: reqBody } = buildSignedRequest({
        requestId: uniqueReqId,
        timestamp: BASE_NOW,
      });

      // 1st attempt: In-memory fallback allows the legitimate request
      const firstResult = await verifyWeleticShopifyRequest({
        request: initialReq.clone(),
        body: reqBody,
        now: BASE_NOW,
      });
      expect(firstResult).toBe(true);

      // Next 9 replay attempts on the same instance:
      // Even though Redis is completely down, in-memory cache actively catches and rejects all 9 replays!
      for (let i = 0; i < 9; i++) {
        const replayResult = await verifyWeleticShopifyRequest({
          request: initialReq.clone(),
          body: reqBody,
          now: BASE_NOW,
        });
        expect(replayResult).toBe(false);
      }

      // Route handler under Redis outage:
      resetServiceAuthNonceCache();
      const freshReqId = `redis-outage-route-${crypto.randomUUID()}`;
      const { request: routeReq } = buildSignedRequest({
        requestId: freshReqId,
        timestamp: BASE_NOW,
      });

      // First route call succeeds (200 OK)
      const res1 = await catalogPostHandler(routeReq.clone());
      expect(res1.status).toBe(200);

      // Replay route call fails (401 Unauthorized)
      const res2 = await catalogPostHandler(routeReq.clone());
      expect(res2.status).toBe(401);
    });

    test("Redis client unavailable in fail_closed mode -> rejects immediately without exception", async () => {
      vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", "fail_closed");

      mockRedisSet.mockRejectedValue(new Error("Redis client connection failed"));

      const { request, body: reqBody } = buildSignedRequest({
        timestamp: BASE_NOW,
        requestId: `redis-down-${crypto.randomUUID()}`,
      });

      const isValid = await verifyWeleticShopifyRequest({
        request,
        body: reqBody,
        now: BASE_NOW,
      });
      // In fail_closed, redis failure returns false safely
      expect(isValid).toBe(false);
    });
  });

  // =========================================================================
  // ADDITIONAL ADVERSARIAL STRESS VECTORS
  // =========================================================================

  describe("Additional Adversarial Stress Vectors", () => {
    test("Future clock-skew replay boundary: request at T0 + 299s cannot be replayed after 6 minutes", async () => {
      const t0 = BASE_NOW;
      const futureSkewMs = 4 * 60 * 1000 + 59 * 1000; // +299s
      const futureTimestamp = t0 + futureSkewMs;
      const nonce = `future-skew-replay-${crypto.randomUUID()}`;

      const { request, body: reqBody } = buildSignedRequest({
        timestamp: futureTimestamp,
        requestId: nonce,
      });

      // T0: First attempt accepted within the 5-minute future skew boundary
      expect(
        await verifyWeleticShopifyRequest({
          request: request.clone(),
          body: reqBody,
          now: t0,
        }),
      ).toBe(true);

      // Fast-forward 6 minutes (360s later)
      const t6 = t0 + 6 * 60 * 1000;
      // At t6, timestamp is (t6 - (t0 + 299s)) = 61s in the past (well within ±300s window)
      // Adversary replays the request -> MUST be rejected because nonce is still retained!
      expect(
        await verifyWeleticShopifyRequest({
          request: request.clone(),
          body: reqBody,
          now: t6,
        }),
      ).toBe(false);
    });

    test("Clock skew strict rejection beyond ±300,000ms boundaries", async () => {
      // Exact boundary - 300,000ms -> accepted
      const reqPastBoundary = buildSignedRequest({
        timestamp: BASE_NOW - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
      });
      expect(
        await verifyWeleticShopifyRequest({
          request: reqPastBoundary.request,
          body: reqPastBoundary.body,
          now: BASE_NOW,
        }),
      ).toBe(true);

      // Past expired - 300,001ms -> rejected
      const reqPastExpired = buildSignedRequest({
        timestamp: BASE_NOW - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS - 1,
      });
      expect(
        await verifyWeleticShopifyRequest({
          request: reqPastExpired.request,
          body: reqPastExpired.body,
          now: BASE_NOW,
        }),
      ).toBe(false);

      // Future expired + 300,001ms -> rejected
      const reqFutureExpired = buildSignedRequest({
        timestamp: BASE_NOW + WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 1,
      });
      expect(
        await verifyWeleticShopifyRequest({
          request: reqFutureExpired.request,
          body: reqFutureExpired.body,
          now: BASE_NOW,
        }),
      ).toBe(false);
    });

    test("Cross-store replay prevention: eavesdropped request for Store A cannot be replayed against Store B", async () => {
      const storeAPath = "/api/internal/shopify/catalog?shop=store-a.myshopify.com";
      const storeBPath = "/api/internal/shopify/catalog?shop=store-b.myshopify.com";

      const storeAReq = buildSignedRequest({
        path: storeAPath,
        timestamp: BASE_NOW,
      });

      // First, Store A request passes
      expect(
        await verifyWeleticShopifyRequest({
          request: storeAReq.request.clone(),
          body: storeAReq.body,
          now: BASE_NOW,
        }),
      ).toBe(true);

      // Attacker takes Store A's signature and headers, but sends it to Store B's endpoint URL
      const tamperedUrlReq = new Request(`https://app.weletic.com${storeBPath}`, {
        method: "POST",
        headers: storeAReq.request.headers,
        body: storeAReq.body,
      });

      // Signature verification fails because canonical request binds the URL path & search query
      expect(
        await verifyWeleticShopifyRequest({
          request: tamperedUrlReq,
          body: storeAReq.body,
          now: BASE_NOW,
        }),
      ).toBe(false);
    });

    test("Transition mode vs Strict mode: legacy caller without requestId works in transition, fails in strict", async () => {
      // Transition mode: WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID=false
      vi.stubEnv("WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID", "false");

      // Legacy caller signs WITHOUT requestId
      const legacySig = signWeleticShopifyRequest({
        timestamp: String(BASE_NOW),
        method: "POST",
        path: BASE_PATH,
        body: BASE_BODY,
        secret: TEST_SECRET,
      });
      const legacyHeaders = new Headers({
        [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: String(BASE_NOW),
        [WELETIC_SHOPIFY_SIGNATURE_HEADER]: legacySig,
      });
      const legacyReq = new Request(BASE_URL, {
        method: "POST",
        headers: legacyHeaders,
        body: BASE_BODY,
      });

      // In transition mode: legacy request is ACCEPTED
      expect(
        await verifyWeleticShopifyRequest({
          request: legacyReq.clone(),
          body: BASE_BODY,
          now: BASE_NOW,
        }),
      ).toBe(true);

      // Switch to Strict mode: WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID=true
      vi.stubEnv("WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID", "true");

      // In strict mode: legacy request is REJECTED
      expect(
        await verifyWeleticShopifyRequest({
          request: legacyReq.clone(),
          body: BASE_BODY,
          now: BASE_NOW,
        }),
      ).toBe(false);
    });
  });
});
