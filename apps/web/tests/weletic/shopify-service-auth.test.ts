import {
  SHOPIFY_ADMIN_API_VERSION,
  getShopifyAdminGraphqlUrl,
} from "@/lib/integrations/shopify/admin-graphql";
import { redis } from "@/lib/upstash/redis";
import {
  WELETIC_SHOPIFY_MAX_BODY_BYTES,
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_REQUEST_ID_HEADER,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
  createWeleticShopifyCanonicalRequest,
  readWeleticShopifyRequestBody,
  resetServiceAuthNonceCache,
  signWeleticShopifyRequest,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_WELETIC_API_TIMEOUT_MS,
  weleticApiRequest,
} from "../../../../packages/shopify-app/app/weletic-api.server";
import {
  WeleticSessionStorage,
  fetchCurrentAppInstallationScopes,
} from "../../../../packages/shopify-app/app/weletic-session-storage.server";

const secret = "test-shopify-service-secret-with-32-characters";
const now = Date.parse("2026-08-17T00:00:00.000Z");
const timestamp = String(now);
const path = "/api/internal/shopify/catalog?shop=store.myshopify.com";
const body = "{}";

function createSignedRequest(options: {
  requestBody?: string;
  signedBody?: string;
  requestTimestamp?: string;
  requestPath?: string;
  requestId?: string;
  signedRequestId?: string;
  includeRequestIdHeader?: boolean;
} = {}) {
  const {
    requestBody = body,
    signedBody = requestBody,
    requestTimestamp = timestamp,
    requestPath = path,
    requestId = crypto.randomUUID(),
    includeRequestIdHeader = true,
  } = options;
  const effectiveSignedRequestId =
    "signedRequestId" in options ? options.signedRequestId : requestId;

  const signature = signWeleticShopifyRequest({
    timestamp: requestTimestamp,
    method: "POST",
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
      method: "POST",
      headers,
      body: requestBody,
    }),
    body: requestBody,
    requestId,
  };
}

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

vi.mock("../../lib/upstash/redis", () => ({
  redis: {
    set: (...args: any[]) => (mockRedisSet as any)(...args),
  },
}));

vi.mock("@/lib/upstash/redis", () => ({
  redis: {
    set: (...args: any[]) => (mockRedisSet as any)(...args),
  },
}));

afterEach(() => {
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
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Weletic Shopify service authentication", () => {
  test.each([
    [
      "lease_busy",
      409,
      "/api/internal/shopify/sessions/coordination",
      "lease_busy",
    ],
    [
      "stale_session",
      409,
      "/api/internal/shopify/sessions/coordination",
      "stale_session",
    ],
    [
      "installation_blocked",
      409,
      "/api/internal/shopify/sessions/coordination",
      "installation_blocked",
    ],
    ["unknown", 409, "/api/internal/shopify/sessions/coordination", undefined],
    [
      "lease_busy",
      503,
      "/api/internal/shopify/sessions/coordination",
      undefined,
    ],
    [
      "lease_busy",
      409,
      "/api/internal/shopify/merchant/loyalty-configuration",
      undefined,
    ],
  ])(
    "classifies only known coordination conflicts: %s %s %s",
    async (error, status, requestPath, code) => {
      vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
      vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ error }, { status: Number(status) })),
      );
      await expect(
        weleticApiRequest(String(requestPath), { method: "POST", body: "{}" }),
      ).rejects.toMatchObject({ status, coordinationCode: code });
    },
  );
  test("uses the documented canonical request format with requestId", () => {
    expect(
      createWeleticShopifyCanonicalRequest({
        timestamp,
        method: "post",
        path,
        body,
        requestId: "req_12345",
      }),
    ).toBe(`${timestamp}\nPOST\n${path}\n{}\nreq_12345`);
  });

  test("supports legacy canonical format without requestId during transition", () => {
    expect(
      createWeleticShopifyCanonicalRequest({
        timestamp,
        method: "post",
        path,
        body,
      }),
    ).toBe(`${timestamp}\nPOST\n${path}\n{}`);
  });

  test("accepts an intact request inside the clock window", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const input = createSignedRequest();
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(true);
  });

  test("detects and rejects replay attacks on subsequent requests with identical requestId", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
    const nonce = `replay-nonce-${crypto.randomUUID()}`;
    const input = createSignedRequest({ requestId: nonce });
    // First attempt: valid request passes
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(true);
    // Second attempt: identical request is rejected due to replay
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(false);
  });

  test("records and checks nonce in Redis via SET NX EX", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://mock-redis.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "mock-token");

    const nonce = `redis-nonce-${crypto.randomUUID()}`;
    const input = createSignedRequest({ requestId: nonce });

    // 1st request -> Redis SET NX succeeds -> accepted
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(true);
    expect(mockRedisSet).toHaveBeenCalledWith(
      `weletic:service-auth:nonce:${nonce}`,
      "1",
      { nx: true, ex: 720 },
    );

    // 2nd request -> Redis SET NX returns null (already exists) -> rejected
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(false);
  });

  test("resolves mocked Redis client successfully without emitting fallback warning", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const nonce = `clean-redis-resolve-${crypto.randomUUID()}`;
    const input = createSignedRequest({ requestId: nonce });

    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(true);
    expect(mockRedisSet).toHaveBeenCalledWith(
      `weletic:service-auth:nonce:${nonce}`,
      "1",
      { nx: true, ex: 720 },
    );
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test("rejects request missing x-weletic-request-id in strict mode", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID", "true");
    const input = createSignedRequest({ includeRequestIdHeader: false });
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(false);
  });

  test("accepts legacy request missing x-weletic-request-id in transition mode", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID", "false");
    const input = createSignedRequest({
      signedRequestId: undefined,
      includeRequestIdHeader: false,
    });
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(true);
  });

  test("rejects request with tampered x-weletic-request-id", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const input = createSignedRequest({
      requestId: "tampered-request-id",
      signedRequestId: "original-request-id",
    });
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(false);
  });

  test("rejects a body changed after signing", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const input = createSignedRequest({
      requestBody: '{"operation":"delete"}',
      signedBody: body,
    });
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(false);
  });

  test("rejects a path or query changed after signing", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const input = createSignedRequest({
      requestPath:
        "/api/internal/shopify/catalog?shop=other-store.myshopify.com",
    });
    input.request.headers.set(
      WELETIC_SHOPIFY_SIGNATURE_HEADER,
      signWeleticShopifyRequest({
        timestamp,
        method: "POST",
        path,
        body,
        requestId: input.requestId,
        secret,
      }),
    );
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(false);
  });

  test("enforces clock skew boundaries (5 min = 300,000ms)", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);

    // Exact past boundary (now - 300,000ms) -> accepted
    const pastBoundary = createSignedRequest({
      requestTimestamp: String(now - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS),
      requestId: `boundary-past-exact-${crypto.randomUUID()}`,
    });
    expect(await verifyWeleticShopifyRequest({ ...pastBoundary, now })).toBe(
      true,
    );

    // Exact future boundary (now + 300,000ms) -> accepted
    const futureBoundary = createSignedRequest({
      requestTimestamp: String(now + WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS),
      requestId: `boundary-future-exact-${crypto.randomUUID()}`,
    });
    expect(await verifyWeleticShopifyRequest({ ...futureBoundary, now })).toBe(
      true,
    );

    // Past boundary + 1ms (now - 300,001ms) -> rejected
    const pastExpired = createSignedRequest({
      requestTimestamp: String(now - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS - 1),
      requestId: `boundary-past-expired-${crypto.randomUUID()}`,
    });
    expect(await verifyWeleticShopifyRequest({ ...pastExpired, now })).toBe(
      false,
    );

    // Future boundary + 1ms (now + 300,001ms) -> rejected
    const futureExpired = createSignedRequest({
      requestTimestamp: String(now + WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 1),
      requestId: `boundary-future-expired-${crypto.randomUUID()}`,
    });
    expect(await verifyWeleticShopifyRequest({ ...futureExpired, now })).toBe(
      false,
    );
  });

  test("prevents replay of future-skewed requests across the 6-minute window", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);

    const t0 = now;
    // Skewed into the future: now + 4m59s (299,000ms)
    const futureSkewMs = 4 * 60 * 1000 + 59 * 1000;
    const futureTimestamp = String(t0 + futureSkewMs);
    const nonce = `future-skew-${crypto.randomUUID()}`;
    const input = createSignedRequest({
      requestTimestamp: futureTimestamp,
      requestId: nonce,
    });

    // T0: First attempt at T0 is valid (within +5 min clock skew)
    expect(await verifyWeleticShopifyRequest({ ...input, now: t0 })).toBe(true);

    // T6: Fast-forward 6 minutes (360,000ms later)
    const t6 = t0 + 6 * 60 * 1000;
    // At T6, the request timestamp (t0 + 299s) is now in the past: (t6 - (t0 + 299s)) = 61s in the past.
    // That is STILL inside the [-5min, +5min] acceptance window (Math.abs(t6 - timestamp) = 61,000 <= 300,000).
    // An attacker attempts replay with the same signed request.
    // It MUST be rejected because nonce TTL is 720s (> 600s acceptance window)!
    expect(await verifyWeleticShopifyRequest({ ...input, now: t6 })).toBe(false);
  });

  test("handles Redis connection failure with scoped fail-open in-memory fallback", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://mock-redis.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "mock-token");
    vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", "fallback_memory");

    mockRedisSet.mockRejectedValue(new Error("Redis connection timeout"));

    const input = createSignedRequest({
      requestId: `scoped-failopen-${crypto.randomUUID()}`,
    });
    // First attempt falls back to in-memory cache and passes
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(true);
    // Second attempt with same nonce on same instance is blocked by in-memory cache
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(false);
  });

  test("emits observable warning log when Redis is unavailable and fallback occurs", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", "fallback_memory");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockRedisSet.mockRejectedValueOnce(new Error("Redis connection refused"));

    const input = createSignedRequest({
      requestId: `fallback-warn-${crypto.randomUUID()}`,
    });

    const result = await verifyWeleticShopifyRequest({ ...input, now });
    expect(result).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(
      "[service-auth] Redis client unavailable, falling back to in-memory nonce cache...",
    );
    warnSpy.mockRestore();
  });

  test("strictly requires 'OK' response from redis.set", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    mockRedisSet.mockResolvedValueOnce(null);

    const input = createSignedRequest({
      requestId: `strict-ok-${crypto.randomUUID()}`,
    });

    const result = await verifyWeleticShopifyRequest({ ...input, now });
    expect(result).toBe(false);
  });

  test("handles Redis connection failure with fail-closed mode", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://mock-redis.upstash.io");
    vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "mock-token");
    vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", "fail_closed");

    mockRedisSet.mockRejectedValue(new Error("Redis network partition"));

    const input = createSignedRequest({
      requestId: `fail-closed-${crypto.randomUUID()}`,
    });
    // In fail_closed mode, request is immediately rejected if Redis is down
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(false);
  });

  test("allows legitimate retries by resigning with new requestId while rejecting adversary replay", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);

    // Attempt 1
    const attempt1 = createSignedRequest({
      requestId: `retry-attempt-1-${crypto.randomUUID()}`,
    });
    expect(await verifyWeleticShopifyRequest({ ...attempt1, now })).toBe(true);

    // Adversary attempts replay of attempt 1 -> rejected!
    expect(
      await verifyWeleticShopifyRequest({ ...attempt1, now: now + 2000 }),
    ).toBe(false);

    // Legitimate caller retries with fresh requestId and timestamp -> accepted!
    const attempt2 = createSignedRequest({
      requestId: `retry-attempt-2-${crypto.randomUUID()}`,
      requestTimestamp: String(now + 2000),
    });
    expect(
      await verifyWeleticShopifyRequest({ ...attempt2, now: now + 2000 }),
    ).toBe(true);
  });

  test("e2e integration: packages/shopify-app caller communicates with verifyWeleticShopifyRequest across dual modes", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);

    // Strict mode
    vi.stubEnv("WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID", "true");
    let verifiedHeaders: Headers | null = null;
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        verifiedHeaders = request.headers;
        const requestBody = String(init?.body ?? "");
        const requestTime = Number(
          request.headers.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER),
        );
        const isValid = await verifyWeleticShopifyRequest({
          request,
          body: requestBody,
          now: requestTime,
        });
        expect(isValid).toBe(true);
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await weleticApiRequest(path, { method: "POST", body });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(
      verifiedHeaders!.get(WELETIC_SHOPIFY_REQUEST_ID_HEADER),
    ).toBeTruthy();

    // Transition mode (WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID=false)
    vi.stubEnv("WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID", "false");
    await weleticApiRequest(path, { method: "POST", body });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("static analysis: ensures 100% of verifyWeleticShopifyRequest call sites in production routes use await", async () => {
    const fs = await import("node:fs");
    const pathMod = await import("node:path");

    function findSourceFiles(dir: string): string[] {
      const results: string[] = [];
      if (!fs.existsSync(dir)) return results;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = pathMod.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...findSourceFiles(fullPath));
        } else if (
          entry.isFile() &&
          (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
        ) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const targetDirs = [
      pathMod.resolve(__dirname, "../../app/api/internal/shopify"),
      pathMod.resolve(__dirname, "../../lib/weletic"),
    ];

    const sourceFiles = targetDirs.flatMap(findSourceFiles);
    expect(sourceFiles.length).toBeGreaterThan(50);

    const violations: string[] = [];
    let checkedCallSites = 0;

    for (const filePath of sourceFiles) {
      const content = fs.readFileSync(filePath, "utf8");
      if (!content.includes("verifyWeleticShopifyRequest")) continue;

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (
          line.includes("import ") ||
          line.includes("export ") ||
          line.includes("function verifyWeleticShopifyRequest") ||
          line.includes("typeof verifyWeleticShopifyRequest")
        ) {
          continue;
        }
        if (line.includes("verifyWeleticShopifyRequest(")) {
          checkedCallSites++;
          if (!line.includes("await verifyWeleticShopifyRequest(")) {
            const prevLine = i > 0 ? lines[i - 1] : "";
            if (!prevLine.includes("await")) {
              violations.push(
                `${pathMod.relative(process.cwd(), filePath)}:${i + 1}: ${line.trim()}`,
              );
            }
          }
        }
      }
    }

    expect(checkedCallSites).toBeGreaterThan(40);
    expect(violations).toEqual([]);
  });

  test("rejects stale requests", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const staleTimestamp = String(now - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS - 1);
    const input = createSignedRequest({ requestTimestamp: staleTimestamp });
    expect(await verifyWeleticShopifyRequest({ ...input, now })).toBe(false);
  });

  test("rejects requests without a valid signature", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const request = new Request(`https://app.weletic.com${path}`, {
      method: "POST",
      headers: {
        [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
        [WELETIC_SHOPIFY_REQUEST_ID_HEADER]: "req_without_sig",
      },
      body,
    });
    expect(await verifyWeleticShopifyRequest({ request, body, now })).toBe(
      false,
    );
  });

  test("fails closed when the dedicated service secret is missing", async () => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", "");
    vi.stubEnv(
      "ENCRYPTION_KEY",
      "test-encryption-key-that-must-not-sign-requests",
    );
    const input = createSignedRequest();

    await expect(
      verifyWeleticShopifyRequest({ ...input, now }),
    ).rejects.toThrow(
      "WELETIC_SHOPIFY_SERVICE_SECRET must be at least 32 characters",
    );
  });

  test("bounds request bodies before signature verification", async () => {
    const validRequest = new Request("https://app.weletic.com/internal", {
      method: "POST",
      body,
    });
    await expect(readWeleticShopifyRequestBody(validRequest)).resolves.toBe(
      body,
    );

    const oversizedRequest = new Request("https://app.weletic.com/internal", {
      method: "POST",
      body: "x".repeat(WELETIC_SHOPIFY_MAX_BODY_BYTES + 1),
    });
    await expect(readWeleticShopifyRequestBody(oversizedRequest)).resolves.toBe(
      null,
    );
  });

  test("accepts the standalone Shopify app signer", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        const requestBody = String(init?.body ?? "");
        const requestTime = Number(
          request.headers.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER),
        );
        expect(
          await verifyWeleticShopifyRequest({
            request,
            body: requestBody,
            now: requestTime,
          }),
        ).toBe(true);
        return new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await weleticApiRequest(path, { method: "POST", body });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  test("rejects normalized paths outside the Shopify internal API", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      weleticApiRequest("/api/internal/shopify/../../external"),
    ).rejects.toThrow("Normalized path must stay inside");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("aborts a stalled core request with a bounded gateway error", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("WELETIC_API_TIMEOUT_MS", "100");
    const fetchMock = vi.fn(
      (_input: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = weleticApiRequest(path);
    const rejection = expect(pending).rejects.toMatchObject({
      status: 504,
      message: "Weletic service took too long to respond",
    });
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(DEFAULT_WELETIC_API_TIMEOUT_MS).toBe(8_000);
  });

  test("keeps the read deadline active while the response body is streaming", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("WELETIC_API_TIMEOUT_MS", "100");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
        const body = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const pending = weleticApiRequest(path);
    const rejection = expect(pending).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(100);

    await rejection;
  });

  test("does not impose a read timeout on mutation outcomes", async () => {
    vi.useFakeTimers();
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("WELETIC_API_TIMEOUT_MS", "100");
    let requestSignal: AbortSignal | null | undefined;
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_input: URL | RequestInfo, init?: RequestInit) =>
          new Promise<Response>((resolve) => {
            requestSignal = init?.signal;
            resolveFetch = resolve;
          }),
      ),
    );

    const pending = weleticApiRequest(path, { method: "POST", body });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(requestSignal?.aborted).toBe(false);
    resolveFetch(Response.json({ ok: true }));
    await expect(pending).resolves.toBeInstanceOf(Response);
  });

  test("sets Shopify iframe protection on document responses", async () => {
    vi.stubEnv("SHOPIFY_API_KEY", "test-api-key");
    vi.stubEnv("SHOPIFY_API_SECRET", "test-api-secret");
    vi.stubEnv("SHOPIFY_APP_URL", "https://shopify.weletic.com");
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);

    const { setDocumentResponseHeaders } = await import(
      "../../../../packages/shopify-app/app/entry.server"
    );
    const headers = new Headers();
    setDocumentResponseHeaders(
      new Request(
        "https://shopify.weletic.com/?shop=store.myshopify.com&host=test",
      ),
      headers,
    );

    expect(headers.get("Content-Security-Policy")).toBe(
      "frame-ancestors https://store.myshopify.com https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;",
    );
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");

    const missingShopHeaders = new Headers();
    setDocumentResponseHeaders(
      new Request("https://shopify.weletic.com/"),
      missingShopHeaders,
    );
    expect(missingShopHeaders.get("Content-Security-Policy")).toBe(
      "frame-ancestors 'none';",
    );
  });

  test("round-trips expiring offline token fields through remote storage", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);

    const expires = Date.parse("2026-08-18T00:00:00.000Z");
    const refreshTokenExpires = Date.parse("2026-09-17T00:00:00.000Z");
    const properties: [string, string | number | boolean][] = [
      ["id", "offline_store.myshopify.com"],
      ["shop", "store.myshopify.com"],
      ["state", "oauth-state"],
      ["isOnline", false],
      ["scope", "read_products"],
      ["accessToken", "access-token"],
      ["expires", expires],
      ["refreshToken", "refresh-token"],
      ["refreshTokenExpires", refreshTokenExpires],
    ];
    let persistedProperties: typeof properties | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "store.myshopify.com") {
          expect(request.headers.get("X-Shopify-Access-Token")).toBe(
            "access-token",
          );
          return Response.json({
            data: {
              currentAppInstallation: {
                accessScopes: [
                  { handle: "read_products" },
                  { handle: "read_store_credit_accounts" },
                ],
              },
            },
          });
        }
        const requestBody = String(init?.body ?? "");
        const requestTime = Number(
          request.headers.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER),
        );
        expect(
          await verifyWeleticShopifyRequest({
            request,
            body: requestBody,
            now: requestTime,
          }),
        ).toBe(true);

        if (request.method === "POST") {
          persistedProperties = JSON.parse(requestBody).properties;
          return Response.json({ stored: true });
        }

        return Response.json({
          sessions: persistedProperties
            ? [{ properties: persistedProperties }]
            : [],
        });
      }),
    );

    const storage = new WeleticSessionStorage();
    const sessionToStore = {
      shop: "store.myshopify.com",
      isOnline: false,
      accessToken: "access-token",
      toPropertyArray: () => properties,
    } as Parameters<WeleticSessionStorage["storeSession"]>[0];

    await storage.storeSession(sessionToStore);
    const restored = await storage.loadSession("offline_store.myshopify.com");

    expect(restored).toMatchObject({
      refreshToken: "refresh-token",
      shop: "store.myshopify.com",
      scope: "read_products,read_store_credit_accounts",
    });
    expect(restored?.expires?.getTime()).toBe(expires);
    expect(restored?.refreshTokenExpires?.getTime()).toBe(refreshTokenExpires);
  });

  test("sends the exact prior offline token digest for refresh CAS", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    const sessionId = "offline_store.myshopify.com";
    const previousToken = "previous-offline-token";
    const nextToken = "next-offline-token";
    const previousProperties: [string, string | number | boolean][] = [
      ["id", sessionId],
      ["shop", "store.myshopify.com"],
      ["state", "oauth-state"],
      ["isOnline", false],
      ["scope", "read_products"],
      ["accessToken", previousToken],
    ];
    let postedBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).hostname === "store.myshopify.com") {
          return Response.json({
            data: {
              currentAppInstallation: {
                accessScopes: [
                  { handle: "read_products" },
                  { handle: "read_store_credit_accounts" },
                ],
              },
            },
          });
        }
        if (request.method === "GET") {
          return Response.json({
            sessions: [{ properties: previousProperties }],
          });
        }
        postedBody = JSON.parse(String(init?.body || "{}"));
        return Response.json({ stored: true });
      }),
    );
    const nextProperties = previousProperties.map(([key, value]) =>
      key === "accessToken"
        ? ([key, nextToken] as const)
        : ([key, value] as const),
    );
    const storage = new WeleticSessionStorage();

    await storage.storeSession({
      id: sessionId,
      shop: "store.myshopify.com",
      isOnline: false,
      accessToken: nextToken,
      toPropertyArray: () => nextProperties,
    } as Parameters<WeleticSessionStorage["storeSession"]>[0]);

    expect(postedBody).toEqual(
      expect.objectContaining({
        expectedCredentialTokenHash: createHash("sha256")
          .update(previousToken)
          .digest("hex"),
        properties: expect.arrayContaining([
          ["accessToken", nextToken],
          ["scope", "read_products,read_store_credit_accounts"],
        ]),
      }),
    );
  });

  test("normalizes Shopify's authoritative app installation scopes", async () => {
    const customFetch = vi.fn(async () =>
      Response.json({
        data: {
          currentAppInstallation: {
            accessScopes: [
              { handle: "write_gift_cards" },
              { handle: "read_store_credit_accounts" },
              { handle: "write_gift_cards" },
            ],
          },
        },
      }),
    );

    await expect(
      fetchCurrentAppInstallationScopes({
        shop: "Store.myshopify.com",
        accessToken: "access-token",
        customFetch: customFetch as typeof fetch,
      }),
    ).resolves.toEqual(["read_store_credit_accounts", "write_gift_cards"]);
  });
});

describe("Shopify Admin GraphQL destination", () => {
  test("uses the validated Shopify shop and stable API version", () => {
    expect(getShopifyAdminGraphqlUrl("Store.myshopify.com")).toBe(
      `https://store.myshopify.com/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
    );
  });

  test("rejects non-Shopify destinations", () => {
    expect(() => getShopifyAdminGraphqlUrl("169.254.169.254")).toThrow(
      "valid myshopify.com hostname",
    );
    expect(() =>
      getShopifyAdminGraphqlUrl("shop.myshopify.com.evil.test"),
    ).toThrow("valid myshopify.com hostname");
  });

  test("uses an explicit proxy only in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv(
      "SHOPIFY_ADMIN_GRAPHQL_PROXY_URL",
      "http://127.0.0.1:3457/graphiql/graphql.json?key=test",
    );
    expect(getShopifyAdminGraphqlUrl("store.myshopify.com")).toBe(
      `http://127.0.0.1:3457/graphiql/graphql.json?key=test&api_version=${SHOPIFY_ADMIN_API_VERSION}`,
    );

    vi.stubEnv("NODE_ENV", "production");
    expect(getShopifyAdminGraphqlUrl("store.myshopify.com")).toBe(
      `https://store.myshopify.com/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
    );
  });
});
