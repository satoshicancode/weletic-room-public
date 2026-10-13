import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalNonceCacheForTest,
  recordInternalNonce,
  verifyWeleticInternalRequest,
  WELETIC_INTERNAL_MAX_CLOCK_SKEW_MS,
  WELETIC_INTERNAL_NONCE_TTL_SECONDS,
  WELETIC_INTERNAL_SIGNATURE_HEADER,
  WELETIC_INTERNAL_TIMESTAMP_HEADER,
  WELETIC_REQUEST_ID_HEADER,
} from "../app/weletic-api.server";

describe("Adversarial Anti-Replay & Boundary Verification (@weletic/shopify-app)", () => {
  const secret = "s".repeat(32);
  const shop = "adversarial-store.myshopify.com";

  beforeEach(() => {
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    clearInternalNonceCacheForTest();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function createSignedRequest({
    path = `/api/internal/admin-session?shop=${shop}`,
    method = "GET",
    body = "",
    timestamp = String(Date.now()),
    requestId = crypto.randomUUID(),
    customSecret = secret,
  }: {
    path?: string;
    method?: string;
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
    headersMap.set(WELETIC_INTERNAL_TIMESTAMP_HEADER.toLowerCase(), timestamp);
    headersMap.set(WELETIC_INTERNAL_SIGNATURE_HEADER.toLowerCase(), signature);
    if (requestId !== undefined) {
      headersMap.set(WELETIC_REQUEST_ID_HEADER.toLowerCase(), requestId);
    }

    return {
      method,
      url: `https://shopify.weletic.com${path}`,
      headers: {
        get: (key: string) => headersMap.get(key.toLowerCase()) ?? null,
      },
    } as unknown as Request;
  }

  // --------------------------------------------------------------------------
  // 1. High-Concurrency Race Conditions against recordInternalNonce
  // --------------------------------------------------------------------------
  describe("High-Concurrency Anti-Replay Stress", () => {
    it("100 concurrent attempts with the exact same requestId yield exactly 1 success and 99 rejections", async () => {
      const targetRequestId = crypto.randomUUID();
      const concurrency = 100;
      const now = Date.now();

      // Launch 100 concurrent recordInternalNonce calls simultaneously
      const results = await Promise.all(
        Array.from({ length: concurrency }, () =>
          Promise.resolve().then(() =>
            recordInternalNonce(targetRequestId, now),
          ),
        ),
      );

      const successCount = results.filter((r) => r === true).length;
      const rejectedCount = results.filter((r) => r === false).length;

      expect(successCount).toBe(1);
      expect(rejectedCount).toBe(concurrency - 1);
    });

    it("100 concurrent verifyWeleticInternalRequest calls with the same requestId accept exactly 1 and reject 99", async () => {
      const targetRequestId = crypto.randomUUID();
      const timestamp = String(Date.now());
      const concurrency = 100;

      const requests = Array.from({ length: concurrency }, () =>
        createSignedRequest({ requestId: targetRequestId, timestamp }),
      );

      const results = await Promise.all(
        requests.map((req) =>
          Promise.resolve().then(() =>
            verifyWeleticInternalRequest({
              request: req,
              requireRequestId: true,
              secret,
            }),
          ),
        ),
      );

      const accepted = results.filter((r) => r === true).length;
      const rejected = results.filter((r) => r === false).length;

      expect(accepted).toBe(1);
      expect(rejected).toBe(concurrency - 1);
    });
  });

  // --------------------------------------------------------------------------
  // 2. Clock Skew Boundaries (+/- 299s, +/- 300s, +/- 301s)
  // --------------------------------------------------------------------------
  describe("Clock Skew Boundaries (+/- 300s)", () => {
    const skewMs = WELETIC_INTERNAL_MAX_CLOCK_SKEW_MS; // 300,000 ms

    it("accepts requests at past boundary: now - 299s (299,000ms)", () => {
      const now = Date.now();
      const timestamp = String(now - 299_000);
      const req = createSignedRequest({ timestamp });

      const isValid = verifyWeleticInternalRequest({
        request: req,
        now,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(true);
    });

    it("accepts requests at exact past boundary: now - 300s (300,000ms)", () => {
      const now = Date.now();
      const timestamp = String(now - skewMs);
      const req = createSignedRequest({ timestamp });

      const isValid = verifyWeleticInternalRequest({
        request: req,
        now,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(true);
    });

    it("rejects requests exceeding past boundary: now - 300.001s (300,001ms)", () => {
      const now = Date.now();
      const timestamp = String(now - (skewMs + 1));
      const req = createSignedRequest({ timestamp });

      const isValid = verifyWeleticInternalRequest({
        request: req,
        now,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects requests exceeding past boundary: now - 301s (301,000ms)", () => {
      const now = Date.now();
      const timestamp = String(now - 301_000);
      const req = createSignedRequest({ timestamp });

      const isValid = verifyWeleticInternalRequest({
        request: req,
        now,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("accepts requests at future boundary: now + 299s (299,000ms)", () => {
      const now = Date.now();
      const timestamp = String(now + 299_000);
      const req = createSignedRequest({ timestamp });

      const isValid = verifyWeleticInternalRequest({
        request: req,
        now,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(true);
    });

    it("accepts requests at exact future boundary: now + 300s (300,000ms)", () => {
      const now = Date.now();
      const timestamp = String(now + skewMs);
      const req = createSignedRequest({ timestamp });

      const isValid = verifyWeleticInternalRequest({
        request: req,
        now,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(true);
    });

    it("rejects requests exceeding future boundary: now + 300.001s (300,001ms)", () => {
      const now = Date.now();
      const timestamp = String(now + (skewMs + 1));
      const req = createSignedRequest({ timestamp });

      const isValid = verifyWeleticInternalRequest({
        request: req,
        now,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects requests exceeding future boundary: now + 301s (301,000ms)", () => {
      const now = Date.now();
      const timestamp = String(now + 301_000);
      const req = createSignedRequest({ timestamp });

      const isValid = verifyWeleticInternalRequest({
        request: req,
        now,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Malformed Request ID & Injection Vectors
  // --------------------------------------------------------------------------
  describe("Malformed RequestId & Injection Vectors", () => {
    it("accepts boundary length 1 requestId", () => {
      const req = createSignedRequest({ requestId: "a" });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(true);
    });

    it("accepts boundary length 128 requestId", () => {
      const req = createSignedRequest({ requestId: "a".repeat(128) });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(true);
    });

    it("rejects overflow requestId of length 129", () => {
      const req = createSignedRequest({ requestId: "a".repeat(129) });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects SQL injection in requestId: \"' OR '1'='1\"", () => {
      const req = createSignedRequest({ requestId: "' OR '1'='1" });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects directory traversal in requestId: ../../etc/passwd", () => {
      const req = createSignedRequest({ requestId: "../../etc/passwd" });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects XSS payload in requestId: <script>alert(1)</script>", () => {
      const req = createSignedRequest({
        requestId: "<script>alert(1)</script>",
      });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects CRLF header injection in requestId: req-123\\r\\nEvil: True", () => {
      const req = createSignedRequest({ requestId: "req-123\r\nEvil: True" });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects null byte in requestId: req-123\\0extra", () => {
      const req = createSignedRequest({ requestId: "req-123\x00extra" });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects Unicode / emoji in requestId: req-🚀-123", () => {
      const req = createSignedRequest({ requestId: "req-🚀-123" });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects whitespace-padded requestId: '  req-123  '", () => {
      const req = createSignedRequest({ requestId: "  req-123  " });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 4. Timestamp Forgery and Parsing Quirks
  // --------------------------------------------------------------------------
  describe("Timestamp Forgery & String Parsing Quirks", () => {
    it("rejects NaN timestamp", () => {
      const req = createSignedRequest({ timestamp: "NaN" });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects Infinity timestamp", () => {
      const req = createSignedRequest({ timestamp: "Infinity" });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects floating-point timestamp", () => {
      const req = createSignedRequest({ timestamp: `${Date.now()}.5432` });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects empty timestamp header", () => {
      const req = createSignedRequest({ timestamp: "" });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });

    it("rejects integer overflow timestamp exceeding Number.MAX_SAFE_INTEGER", () => {
      const req = createSignedRequest({
        timestamp: "99999999999999999999999999",
      });
      const isValid = verifyWeleticInternalRequest({
        request: req,
        secret,
        requireRequestId: true,
      });
      expect(isValid).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // 5. Expiration & Nonce Eviction
  // --------------------------------------------------------------------------
  describe("Expiration & Nonce Eviction", () => {
    it("allows reuse of nonce after TTL has elapsed", () => {
      const targetRequestId = crypto.randomUUID();
      const startTime = Date.now();

      // First record at t0
      const first = recordInternalNonce(
        targetRequestId,
        startTime,
        WELETIC_INTERNAL_NONCE_TTL_SECONDS,
      );
      expect(first).toBe(true);

      // Attempt replay at t0 + 10s: blocked
      const replayDuringTtl = recordInternalNonce(
        targetRequestId,
        startTime + 10_000,
        WELETIC_INTERNAL_NONCE_TTL_SECONDS,
      );
      expect(replayDuringTtl).toBe(false);

      // Attempt record after TTL has elapsed: t0 + 721s (721,000ms)
      const afterTtl = recordInternalNonce(
        targetRequestId,
        startTime + 721_000,
        WELETIC_INTERNAL_NONCE_TTL_SECONDS,
      );
      expect(afterTtl).toBe(true);
    });
  });
});
