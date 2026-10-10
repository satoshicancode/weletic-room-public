import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { NextRequest } from "next/server";

// Module imports under adversarial test
import { verifySlackSignature } from "../../lib/integrations/slack/verify-request";
import { POST as hubspotWebhookPOST } from "../../app/(ee)/api/hubspot/webhook/route";
import {
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../../lib/email/unsubscribe-token";
import {
  decrypt,
  decryptOrPassthrough,
  encrypt,
} from "../../lib/encryption";
import {
  createKVNonceClient,
  createD1NonceClient,
  verifyWeleticShopifyRequest,
  setServiceAuthRedisClient,
  resetServiceAuthNonceCache,
  type KVNamespaceLike,
  type D1DatabaseLike,
  type RedisSetClient,
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_REQUEST_ID_HEADER,
} from "@weletic/contracts/shopify/service-auth";

// Mocks for Next.js route testing
vi.mock("server-only", () => ({}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((cb) => {
      try {
        if (typeof cb === "function") cb();
      } catch {}
    }),
  };
});

vi.mock("@/lib/axiom/server", () => ({
  withAxiom: (fn: any) => fn,
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("@/lib/cron/enqueue-batch-jobs", () => ({
  enqueueBatchJobs: vi.fn().mockResolvedValue([]),
}));

describe("M2 Adversarial Challenge Suite: TimingSafeEqual, Replay & Crypto Stress", () => {
  // =========================================================================
  // 1. TIMING-SAFE EQUAL & SLACK CLOCK SKEW FUZZING
  // =========================================================================
  describe("1. Slack Request Verification Timing & Clock Skew Stress", () => {
    const signingSecret = "slack-secret-adversarial-probe-key-12345";
    const body = JSON.stringify({ event: "message", text: "probe" });
    const fixedNowMs = 1700000000000;
    const fixedNowSec = Math.floor(fixedNowMs / 1000); // 1700000000

    function makeSlackRequest(timestamp: string | number, signature: string) {
      const headers = new Headers();
      if (timestamp !== undefined && timestamp !== null) {
        headers.set("x-slack-request-timestamp", String(timestamp));
      }
      if (signature !== undefined && signature !== null) {
        headers.set("x-slack-signature", signature);
      }
      return new Request("https://app.dub.co/api/slack/events", {
        method: "POST",
        headers,
        body,
      });
    }

    function computeSlackSignature(
      secret: string,
      timestampSec: number,
      bodyPayload: string,
    ) {
      const hmac = crypto.createHmac("sha256", secret);
      hmac.update(`v0:${timestampSec}:${bodyPayload}`);
      return `v0=${hmac.digest("hex")}`;
    }

    beforeEach(() => {
      vi.stubEnv("SLACK_SIGNING_SECRET", signingSecret);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    describe("Slack Clock Skew Boundary Probing (300s window)", () => {
      it("accepts timestamp at exactly -300s boundary", async () => {
        const ts = fixedNowSec - 300;
        const sig = computeSlackSignature(signingSecret, ts, body);
        const req = makeSlackRequest(ts, sig);
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).resolves.toBeUndefined();
      });

      it("accepts timestamp at -299s boundary", async () => {
        const ts = fixedNowSec - 299;
        const sig = computeSlackSignature(signingSecret, ts, body);
        const req = makeSlackRequest(ts, sig);
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).resolves.toBeUndefined();
      });

      it("rejects timestamp at -301s boundary (stale request)", async () => {
        const ts = fixedNowSec - 301;
        const sig = computeSlackSignature(signingSecret, ts, body);
        const req = makeSlackRequest(ts, sig);
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).rejects.toThrow(/must differ from system time by no more than 5 minutes/);
      });

      it("accepts future timestamp at exactly +300s boundary", async () => {
        const ts = fixedNowSec + 300;
        const sig = computeSlackSignature(signingSecret, ts, body);
        const req = makeSlackRequest(ts, sig);
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).resolves.toBeUndefined();
      });

      it("accepts future timestamp at +299s boundary", async () => {
        const ts = fixedNowSec + 299;
        const sig = computeSlackSignature(signingSecret, ts, body);
        const req = makeSlackRequest(ts, sig);
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).resolves.toBeUndefined();
      });

      it("accepts future timestamp at +10s (minor forward clock skew)", async () => {
        const ts = fixedNowSec + 10;
        const sig = computeSlackSignature(signingSecret, ts, body);
        const req = makeSlackRequest(ts, sig);
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).resolves.toBeUndefined();
      });

      it("rejects future timestamp at +301s boundary (future replay)", async () => {
        const ts = fixedNowSec + 301;
        const sig = computeSlackSignature(signingSecret, ts, body);
        const req = makeSlackRequest(ts, sig);
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).rejects.toThrow(/must differ from system time by no more than 5 minutes/);
      });
    });

    describe("Slack Timestamp Header String Fuzzing", () => {
      const nonNumericCases = [
        { label: "alpha string", value: "abc", errorPattern: /header x-slack-request-timestamp did not have the expected type \(NaN\)/ },
        { label: "literal NaN", value: "NaN", errorPattern: /header x-slack-request-timestamp did not have the expected type \(NaN\)/ },
        { label: "positive Infinity", value: "Infinity", errorPattern: /must differ from system time by no more than 5 minutes/ },
        { label: "negative Infinity", value: "-Infinity", errorPattern: /must differ from system time by no more than 5 minutes/ },
        { label: "negative integer -1", value: "-1", errorPattern: /must differ from system time by no more than 5 minutes/ },
        { label: "extreme future 1e10", value: "1e10", errorPattern: /must differ from system time by no more than 5 minutes/ },
        { label: "empty string", value: "", errorPattern: /must differ from system time by no more than 5 minutes/ },
        { label: "symbol string", value: "???$$$***", errorPattern: /header x-slack-request-timestamp did not have the expected type \(NaN\)/ },
        { label: "boolean string true", value: "true", errorPattern: /header x-slack-request-timestamp did not have the expected type \(NaN\)/ },
      ];

      for (const { label, value, errorPattern } of nonNumericCases) {
        it(`rejects non-numeric timestamp string: ${label}`, async () => {
          const req = makeSlackRequest(value, "v0=anyhash");
          await expect(
            verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
          ).rejects.toThrow(errorPattern);
        });
      }

      it("rejects missing timestamp header without unhandled crash", async () => {
        const headers = new Headers({
          "x-slack-signature": "v0=anyhash",
        });
        const req = new Request("https://app.dub.co/api/slack/events", {
          method: "POST",
          headers,
          body,
        });
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).rejects.toThrow(/must differ from system time by no more than 5 minutes/);
      });
    });

    describe("Slack TimingSafeEqual & Signature Buffer Stress", () => {
      it("rejects 1MB massive signature without RangeError", async () => {
        const massiveSig = `v0=${"a".repeat(1024 * 1024)}`;
        const req = makeSlackRequest(fixedNowSec, massiveSig);
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).rejects.toThrow(/signature mismatch/);
      });

      it("rejects signature with empty hash: 'v0='", async () => {
        const req = makeSlackRequest(fixedNowSec, "v0=");
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).rejects.toThrow(/signature mismatch/);
      });

      it("rejects signature lacking '=' delimiter: 'v0'", async () => {
        const req = makeSlackRequest(fixedNowSec, "v0");
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).rejects.toThrow(/signature mismatch/);
      });

      it("rejects signature with empty string: ''", async () => {
        const req = makeSlackRequest(fixedNowSec, "");
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).rejects.toThrow(/unknown signature version/);
      });

      it("rejects signature with unknown version prefix: 'v1=...'", async () => {
        const req = makeSlackRequest(fixedNowSec, "v1=0123456789abcdef");
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).rejects.toThrow(/unknown signature version/);
      });

      it("rejects 63-byte signature (1 byte short) without RangeError", async () => {
        const validSig = computeSlackSignature(signingSecret, fixedNowSec, body);
        const shortSig = validSig.slice(0, -1);
        const req = makeSlackRequest(fixedNowSec, shortSig);
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).rejects.toThrow(/signature mismatch/);
      });

      it("rejects 65-byte signature (1 byte long) without RangeError", async () => {
        const validSig = computeSlackSignature(signingSecret, fixedNowSec, body);
        const longSig = validSig + "f";
        const req = makeSlackRequest(fixedNowSec, longSig);
        await expect(
          verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
        ).rejects.toThrow(/signature mismatch/);
      });

      it("rejects exact-length 64-byte signature with single-bit flips across multiple offsets", async () => {
        const validSig = computeSlackSignature(signingSecret, fixedNowSec, body);
        const [, hash] = validSig.split("=");

        for (const offset of [0, 1, 15, 31, 48, 63]) {
          const flippedChar = hash[offset] === "0" ? "1" : "0";
          const corruptedHash =
            hash.slice(0, offset) + flippedChar + hash.slice(offset + 1);
          const req = makeSlackRequest(fixedNowSec, `v0=${corruptedHash}`);
          await expect(
            verifySlackSignature(req, body, { nowMilliseconds: fixedNowMs }),
          ).rejects.toThrow(/signature mismatch/);
        }
      });

      it("handles large 512KB payload correctly with timingSafeEqual", async () => {
        const largeBody = "x".repeat(512 * 1024);
        const sig = computeSlackSignature(signingSecret, fixedNowSec, largeBody);
        const req = makeSlackRequest(fixedNowSec, sig);
        await expect(
          verifySlackSignature(req, largeBody, { nowMilliseconds: fixedNowMs }),
        ).resolves.toBeUndefined();
      });
    });
  });

  // =========================================================================
  // 2. HUBSPOT WEBHOOK VERIFICATION FUZZING & TIMING-SAFE EQUAL
  // =========================================================================
  describe("2. HubSpot Webhook Verification Fuzzing & Timing-Safe Equal", () => {
    const hubspotSecret = "hubspot-secret-adversarial-test-token-789";
    const validPayload = JSON.stringify([
      { eventId: 42, subscriptionType: "contact.propertyChange" },
    ]);

    function computeHubSpotSig(secret: string, bodyText: string) {
      return crypto
        .createHash("sha256")
        .update(secret + bodyText)
        .digest("hex");
    }

    function makeHubspotRequest({
      signature,
      body = validPayload,
    }: {
      signature?: string | null;
      body?: string;
    }) {
      const headers = new Headers({
        "Content-Type": "application/json",
      });
      if (signature !== undefined && signature !== null) {
        headers.set("X-HubSpot-Signature", signature);
      }
      return new NextRequest("https://app.dub.co/api/hubspot/webhook", {
        method: "POST",
        headers,
        body,
      });
    }

    beforeEach(() => {
      vi.stubEnv("HUBSPOT_CLIENT_SECRET", hubspotSecret);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("accepts valid request and returns HTTP 200", async () => {
      const sig = computeHubSpotSig(hubspotSecret, validPayload);
      const req = makeHubspotRequest({ signature: sig });
      const res = await hubspotWebhookPOST(req, {} as any);
      expect(res.status).toBe(200);
    });

    it("returns 400 Bad Request when X-HubSpot-Signature header is missing", async () => {
      const req = makeHubspotRequest({ signature: null });
      const res = await hubspotWebhookPOST(req, {} as any);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error.code).toBe("bad_request");
    });

    it("returns 400 Bad Request when X-HubSpot-Signature header is empty string", async () => {
      const req = makeHubspotRequest({ signature: "" });
      const res = await hubspotWebhookPOST(req, {} as any);
      expect(res.status).toBe(400);
    });

    it("returns 500 Internal Server Error when HUBSPOT_CLIENT_SECRET is missing", async () => {
      vi.stubEnv("HUBSPOT_CLIENT_SECRET", "");
      const sig = computeHubSpotSig(hubspotSecret, validPayload);
      const req = makeHubspotRequest({ signature: sig });
      const res = await hubspotWebhookPOST(req, {} as any);
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error.code).toBe("internal_server_error");
    });

    it("returns 401 when signature includes unwanted 'v1=' prefix (length mismatch)", async () => {
      const sig = computeHubSpotSig(hubspotSecret, validPayload);
      const req = makeHubspotRequest({ signature: `v1=${sig}` });
      const res = await hubspotWebhookPOST(req, {} as any);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe("unauthorized");
    });

    it("returns 401 on 1MB massive signature without throwing RangeError", async () => {
      const massiveSig = "b".repeat(1024 * 1024);
      const req = makeHubspotRequest({ signature: massiveSig });
      const res = await hubspotWebhookPOST(req, {} as any);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error.code).toBe("unauthorized");
    });

    it("returns 401 on 1-byte truncated signature without RangeError", async () => {
      const req = makeHubspotRequest({ signature: "a" });
      const res = await hubspotWebhookPOST(req, {} as any);
      expect(res.status).toBe(401);
    });

    it("returns 401 when secret does not match", async () => {
      const wrongSecretSig = computeHubSpotSig("wrong-secret", validPayload);
      const req = makeHubspotRequest({ signature: wrongSecretSig });
      const res = await hubspotWebhookPOST(req, {} as any);
      expect(res.status).toBe(401);
    });

    it("returns 401 when request body is tampered by even a trailing space", async () => {
      const sig = computeHubSpotSig(hubspotSecret, validPayload);
      const req = makeHubspotRequest({ signature: sig, body: validPayload + " " });
      const res = await hubspotWebhookPOST(req, {} as any);
      expect(res.status).toBe(401);
    });

    it("handles empty payload: rejects mismatched signature with 401", async () => {
      const req = makeHubspotRequest({ signature: "any-64-character-signature-0123456789abcdef0123456789abcdef012345", body: "" });
      const res = await hubspotWebhookPOST(req, {} as any);
      expect(res.status).toBe(401);
    });

    it("handles empty body with matching signature: fails gracefully on JSON parse error without unhandled crash", async () => {
      const emptySig = computeHubSpotSig(hubspotSecret, "");
      const req = makeHubspotRequest({ signature: emptySig, body: "" });
      const res = await hubspotWebhookPOST(req, {} as any);
      // SyntaxError from JSON.parse("") is caught and returned as internal_server_error 500
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error.code).toBe("internal_server_error");
    });
  });

  // =========================================================================
  // 3. UNSUBSCRIBE TOKEN TIMING-SAFE EQUAL & FUZZING
  // =========================================================================
  describe("3. Unsubscribe Token TimingSafeEqual & Buffer Stress", () => {
    const tokenSecret = "synthetic-token-secret-adversarial-probe-42";
    const testEmail = "adversary@attack-vector.example.org";

    beforeEach(() => {
      vi.stubEnv("UNSUBSCRIBE_TOKEN_SECRET", tokenSecret);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("round-trips uppercase and mixed characters safely", () => {
      const token = generateUnsubscribeToken("AdVersary+Tagged@Example.COM");
      const decoded = verifyUnsubscribeToken(token);
      expect(decoded).toBe("adversary+tagged@example.com");
    });

    it("returns null on 1MB massive signature without RangeError", async () => {
      const encodedEmail = Buffer.from(testEmail).toString("base64url");
      const massiveSig = "c".repeat(1024 * 1024);
      const tamperedToken = `${encodedEmail}.${massiveSig}`;

      expect(() => verifyUnsubscribeToken(tamperedToken)).not.toThrow();
      expect(verifyUnsubscribeToken(tamperedToken)).toBeNull();
    });

    it("returns null on 0-char signature without RangeError", () => {
      const encodedEmail = Buffer.from(testEmail).toString("base64url");
      expect(verifyUnsubscribeToken(`${encodedEmail}.`)).toBeNull();
    });

    it("returns null on 23-char signature (1 char short) without RangeError", () => {
      const token = generateUnsubscribeToken(testEmail);
      const [encodedEmail, sig] = token.split(".");
      expect(verifyUnsubscribeToken(`${encodedEmail}.${sig.slice(0, 23)}`)).toBeNull();
    });

    it("returns null on 25-char signature (1 char long) without RangeError", () => {
      const token = generateUnsubscribeToken(testEmail);
      const [encodedEmail, sig] = token.split(".");
      expect(verifyUnsubscribeToken(`${encodedEmail}.${sig}a`)).toBeNull();
    });

    it("returns null on single-bit flip across all positions in the 24-char signature", () => {
      const token = generateUnsubscribeToken(testEmail);
      const [encodedEmail, sig] = token.split(".");

      for (let i = 0; i < sig.length; i++) {
        const flippedChar = sig[i] === "a" ? "b" : "a";
        const corruptedSig = sig.slice(0, i) + flippedChar + sig.slice(i + 1);
        expect(verifyUnsubscribeToken(`${encodedEmail}.${corruptedSig}`)).toBeNull();
      }
    });

    it("returns null on malformed token formats (multiple dots, null bytes)", () => {
      expect(verifyUnsubscribeToken("")).toBeNull();
      expect(verifyUnsubscribeToken("no-dots-at-all")).toBeNull();
      expect(verifyUnsubscribeToken("part1.part2.part3")).toBeNull();
      expect(verifyUnsubscribeToken("part1.part2.part3.part4")).toBeNull();
      expect(verifyUnsubscribeToken("\x00\x00.\x00\x00")).toBeNull();
    });

    it("returns null when UNSUBSCRIBE_TOKEN_SECRET and NEXTAUTH_SECRET are missing", async () => {
      vi.resetModules();
      vi.stubEnv("UNSUBSCRIBE_TOKEN_SECRET", "");
      vi.stubEnv("NEXTAUTH_SECRET", "");
      const { generateUnsubscribeToken: freshGen, verifyUnsubscribeToken: freshVerify } =
        await import("../../lib/email/unsubscribe-token");
      expect(() => freshGen(testEmail)).toThrow(/UNSUBSCRIBE_TOKEN_SECRET is not set/);
      expect(freshVerify("any.token")).toBeNull();
    });
  });

  // =========================================================================
  // 4. SERVICE AUTH REPLAY PROTECTION & DISTRIBUTED NONCE RESILIENCE
  // =========================================================================
  describe("4. Service Auth Replay Protection & Distributed Nonce Resilience", () => {
    const serviceSecret = "a".repeat(32);
    const fixedNow = Date.now();

    function makeServiceAuthRequest({
      timestamp = String(fixedNow),
      method = "POST",
      path = "/api/internal/test",
      body = "{}",
      requestId = crypto.randomUUID(),
      secret = serviceSecret,
    }: {
      timestamp?: string;
      method?: string;
      path?: string;
      body?: string;
      requestId?: string;
      secret?: string;
    }) {
      const signature = crypto
        .createHmac("sha256", secret)
        .update(`${timestamp}\n${method.toUpperCase()}\n${path}\n${body}\n${requestId}`)
        .digest("hex");

      const headers = new Headers({
        [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
        [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
        [WELETIC_SHOPIFY_REQUEST_ID_HEADER]: requestId,
      });

      return new Request(`https://internal-service.local${path}`, {
        method,
        headers,
        body,
      });
    }

    beforeEach(() => {
      resetServiceAuthNonceCache();
      setServiceAuthRedisClient(null);
      vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", serviceSecret);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      resetServiceAuthNonceCache();
      setServiceAuthRedisClient(null);
    });

    describe("Replay Protection Across Storage Adapters", () => {
      it("prevents replay within window via Cloudflare KV adapter", async () => {
        const kvMap = new Map<string, string>();
        const mockKV: KVNamespaceLike = {
          async get(key: string) {
            return kvMap.get(key) ?? null;
          },
          async put(key: string, value: string) {
            kvMap.set(key, value);
          },
        };
        const kvClient = createKVNonceClient(mockKV);
        setServiceAuthRedisClient(kvClient);

        const requestId = crypto.randomUUID();
        const req1 = makeServiceAuthRequest({ requestId });
        const valid1 = await verifyWeleticShopifyRequest({
          request: req1,
          body: "{}",
          now: fixedNow,
          secret: serviceSecret,
        });
        expect(valid1).toBe(true);

        // Immediate replay of exact same request: must be rejected!
        const req2 = makeServiceAuthRequest({ requestId });
        const valid2 = await verifyWeleticShopifyRequest({
          request: req2,
          body: "{}",
          now: fixedNow,
          secret: serviceSecret,
        });
        expect(valid2).toBe(false);
      });

      it("prevents replay within window via Cloudflare D1 SQLite adapter", async () => {
        const d1Db = new Map<string, number>();
        const mockD1: D1DatabaseLike = {
          prepare(_query: string) {
            return {
              bind(...values: unknown[]) {
                return {
                  async run() {
                    const [key, expiresAt] = values as [string, number];
                    if (d1Db.has(key)) {
                      throw new Error("UNIQUE constraint failed: ServiceAuthNonce.nonceKey");
                    }
                    d1Db.set(key, expiresAt);
                    return { success: true, meta: { changes: 1 } };
                  },
                  async first<T = unknown>() {
                    const key = values[0] as string;
                    const expiresAt = d1Db.get(key);
                    return expiresAt ? ({ expiresAt } as T) : null;
                  },
                };
              },
            };
          },
        };
        const d1Client = createD1NonceClient(mockD1);
        setServiceAuthRedisClient(d1Client);

        const requestId = crypto.randomUUID();
        const req1 = makeServiceAuthRequest({ requestId });
        const valid1 = await verifyWeleticShopifyRequest({
          request: req1,
          body: "{}",
          now: fixedNow,
          secret: serviceSecret,
        });
        expect(valid1).toBe(true);

        // Replay attempt collides with active D1 nonce
        const req2 = makeServiceAuthRequest({ requestId });
        const valid2 = await verifyWeleticShopifyRequest({
          request: req2,
          body: "{}",
          now: fixedNow,
          secret: serviceSecret,
        });
        expect(valid2).toBe(false);
      });

      it("allows D1 nonce reuse after expiration window (expiresAt <= nowMs)", async () => {
        const d1Db = new Map<string, number>();
        let dbQueries: string[] = [];
        const mockD1: D1DatabaseLike = {
          prepare(query: string) {
            dbQueries.push(query);
            return {
              bind(...values: unknown[]) {
                return {
                  async run() {
                    const [p1, p2] = values as [any, any];
                    if (query.includes("INSERT")) {
                      if (d1Db.has(p1)) {
                        throw new Error("UNIQUE constraint failed: ServiceAuthNonce.nonceKey");
                      }
                      d1Db.set(p1, p2);
                    } else if (query.includes("UPDATE")) {
                      d1Db.set(p2, p1);
                    }
                    return { success: true, meta: { changes: 1 } };
                  },
                  async first<T = unknown>() {
                    const key = values[0] as string;
                    const expiresAt = d1Db.get(key);
                    return expiresAt !== undefined ? ({ expiresAt } as T) : null;
                  },
                };
              },
            };
          },
        };
        const d1Client = createD1NonceClient(mockD1);

        const nonceKey = "test:expired-nonce-key";
        // Simulate a previously recorded nonce that has expired (e.g. 1 hour ago)
        d1Db.set(nonceKey, Date.now() - 3600 * 1000);

        // Attempting to set an expired nonce should update and succeed
        const res = await d1Client.set(nonceKey, "1", { nx: true, ex: 720 });
        expect(res).toBe("OK");
        expect(d1Db.get(nonceKey)).toBeGreaterThan(Date.now());
      });
    });

    describe("Fail-Closed Mode on Store Failures", () => {
      it("fails closed when Redis throws an unexpected network error in fail-closed mode", async () => {
        vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", "fail_closed");

        const faultyRedis: RedisSetClient = {
          async set() {
            throw new Error("ECONNREFUSED: Redis cluster unreachable");
          },
        };
        setServiceAuthRedisClient(faultyRedis);

        const req = makeServiceAuthRequest({});
        const valid = await verifyWeleticShopifyRequest({
          request: req,
          body: "{}",
          now: fixedNow,
          secret: serviceSecret,
        });
        expect(valid).toBe(false);
      });

      it("fails closed when D1 database throws unexpected disk/SQL error in fail-closed mode", async () => {
        vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", "fail_closed");

        const faultyD1: D1DatabaseLike = {
          prepare() {
            return {
              bind() {
                return {
                  async run() {
                    throw new Error("SQLITE_IOERR: disk I/O error");
                  },
                  async first() {
                    throw new Error("SQLITE_IOERR: disk I/O error");
                  },
                };
              },
            };
          },
        };
        const d1Client = createD1NonceClient(faultyD1);
        setServiceAuthRedisClient(d1Client);

        const req = makeServiceAuthRequest({});
        const valid = await verifyWeleticShopifyRequest({
          request: req,
          body: "{}",
          now: fixedNow,
          secret: serviceSecret,
        });
        expect(valid).toBe(false);
      });

      it("fails closed when KV throws network error in fail-closed mode", async () => {
        vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", "fail_closed");

        const faultyKV: KVNamespaceLike = {
          async get() {
            throw new Error("Cloudflare KV gateway timeout");
          },
          async put() {
            throw new Error("Cloudflare KV gateway timeout");
          },
        };
        const kvClient = createKVNonceClient(faultyKV);
        setServiceAuthRedisClient(kvClient);

        const req = makeServiceAuthRequest({});
        const valid = await verifyWeleticShopifyRequest({
          request: req,
          body: "{}",
          now: fixedNow,
          secret: serviceSecret,
        });
        expect(valid).toBe(false);
      });

      it("fails closed when no distributed client is available in production", async () => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", "");
        setServiceAuthRedisClient(null);

        const req = makeServiceAuthRequest({});
        const valid = await verifyWeleticShopifyRequest({
          request: req,
          body: "{}",
          now: fixedNow,
          secret: serviceSecret,
        });
        expect(valid).toBe(false);
      });
    });

    describe("Service Auth Clock Skew Boundaries", () => {
      it("accepts timestamp within 5-minute skew (-300,000 ms)", async () => {
        const ts = String(fixedNow - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS);
        const req = makeServiceAuthRequest({ timestamp: ts });
        const valid = await verifyWeleticShopifyRequest({
          request: req,
          body: "{}",
          now: fixedNow,
          secret: serviceSecret,
        });
        expect(valid).toBe(true);
      });

      it("rejects timestamp exceeding 5-minute skew (-300,001 ms)", async () => {
        const ts = String(fixedNow - WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS - 1);
        const req = makeServiceAuthRequest({ timestamp: ts });
        const valid = await verifyWeleticShopifyRequest({
          request: req,
          body: "{}",
          now: fixedNow,
          secret: serviceSecret,
        });
        expect(valid).toBe(false);
      });

      it("rejects future timestamp exceeding 5-minute skew (+300,001 ms)", async () => {
        const ts = String(fixedNow + WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 1);
        const req = makeServiceAuthRequest({ timestamp: ts });
        const valid = await verifyWeleticShopifyRequest({
          request: req,
          body: "{}",
          now: fixedNow,
          secret: serviceSecret,
        });
        expect(valid).toBe(false);
      });
    });
  });

  // =========================================================================
  // 5. AES-256-GCM SLICING & TAMPERING STRESS
  // =========================================================================
  describe("5. AES-256-GCM Slicing, Buffer Hardening & Tampering Stress", () => {
    const rawKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    beforeEach(() => {
      process.env.ENCRYPTION_KEY = rawKey;
    });

    afterEach(() => {
      delete process.env.ENCRYPTION_KEY;
    });

    describe("Short and Truncated Buffer Edge Cases (< 28 bytes)", () => {
      const truncatedLengths = [0, 1, 5, 11, 12, 16, 20, 27];

      for (const len of truncatedLengths) {
        it(`cleanly rejects ${len}-byte ciphertext buffer without unhandled slicing error`, () => {
          const buf = Buffer.alloc(len, 0x42);
          const base64 = buf.toString("base64");

          if (len === 0) {
            expect(() => decrypt("")).toThrow(/must be a non-empty string/);
            expect(() => decryptOrPassthrough("")).toThrow(/must be a non-empty string/);
          } else {
            expect(() => decrypt(base64)).toThrow(/less than minimum 28 bytes/);
            // decryptOrPassthrough must fail closed on truncated buffer
            expect(() => decryptOrPassthrough(base64)).toThrow();
          }
        });
      }

      it("handles 28-byte boundary cleanly: decrypts valid empty plaintext", () => {
        const encryptedEmpty = encrypt("");
        const decodedBuf = Buffer.from(encryptedEmpty, "base64");
        // Exactly 12 IV + 16 Tag = 28 bytes
        expect(decodedBuf.length).toBe(28);

        // Decrypting valid 28-byte payload yields empty string
        expect(decrypt(encryptedEmpty)).toBe("");
        expect(decryptOrPassthrough(encryptedEmpty)).toBe("");
      });

      it("rejects 28-byte payload with corrupted tag", () => {
        const encryptedEmpty = encrypt("");
        const buf = Buffer.from(encryptedEmpty, "base64");
        buf[20] ^= 0xff; // Corrupt a byte in the 16-byte auth tag
        const corrupted = buf.toString("base64");

        expect(() => decrypt(corrupted)).toThrow();
        expect(() => decryptOrPassthrough(corrupted)).toThrow(
          /Security validation failed: ciphertext authentication error/,
        );
      });
    });

    describe("Tampering Probing: IV, Auth Tag, and Ciphertext Bits", () => {
      const samplePlaintext = "shpat_critical_merchant_shopify_access_token_12345";

      it("rejects tampering at every single byte of the 12-byte IV (bytes 0-11)", () => {
        const ciphertext = encrypt(samplePlaintext);
        const rawBuf = Buffer.from(ciphertext, "base64");

        for (let ivIndex = 0; ivIndex < 12; ivIndex++) {
          const tamperedBuf = Buffer.from(rawBuf);
          tamperedBuf[ivIndex] ^= 0x01; // 1-bit flip
          const tamperedBase64 = tamperedBuf.toString("base64");

          expect(() => decrypt(tamperedBase64)).toThrow();
          expect(() => decryptOrPassthrough(tamperedBase64)).toThrow(
            /Security validation failed: ciphertext authentication error/,
          );
        }
      });

      it("rejects tampering at every single byte of the 16-byte Auth Tag (bytes 12-27)", () => {
        const ciphertext = encrypt(samplePlaintext);
        const rawBuf = Buffer.from(ciphertext, "base64");

        for (let tagIndex = 12; tagIndex < 28; tagIndex++) {
          const tamperedBuf = Buffer.from(rawBuf);
          tamperedBuf[tagIndex] ^= 0x01; // 1-bit flip
          const tamperedBase64 = tamperedBuf.toString("base64");

          expect(() => decrypt(tamperedBase64)).toThrow();
          expect(() => decryptOrPassthrough(tamperedBase64)).toThrow(
            /Security validation failed: ciphertext authentication error/,
          );
        }
      });

      it("rejects tampering at first, middle, and last byte of ciphertext body (bytes 28+)", () => {
        const ciphertext = encrypt(samplePlaintext);
        const rawBuf = Buffer.from(ciphertext, "base64");

        const targetIndices = [28, 28 + Math.floor((rawBuf.length - 28) / 2), rawBuf.length - 1];

        for (const idx of targetIndices) {
          const tamperedBuf = Buffer.from(rawBuf);
          tamperedBuf[idx] ^= 0x01; // 1-bit flip
          const tamperedBase64 = tamperedBuf.toString("base64");

          expect(() => decrypt(tamperedBase64)).toThrow();
          expect(() => decryptOrPassthrough(tamperedBase64)).toThrow(
            /Security validation failed: ciphertext authentication error/,
          );
        }
      });
    });

    describe("decryptOrPassthrough Security Boundary & Invariant Validation", () => {
      it("fails closed on non-ciphertext and non-legacy attacker strings", () => {
        const evilInputs = [
          "eval(process.exit(1))",
          "SELECT * FROM users WHERE admin = 1",
          "bearer_eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
          "ghp_githubPersonalAccessToken1234567890",
          "AAAA".repeat(20), // 80 'A' characters, valid base64 but invalid ciphertext tag
        ];

        for (const input of evilInputs) {
          expect(() => decryptOrPassthrough(input)).toThrow();
        }
      });

      it("preserves recognized legacy token formats with migration warning", () => {
        const shopifyLegacy = "shpat_test1234567890abcdef1234567890";
        const shopifyCustom = "shpua_test1234567890abcdef1234567890";
        const shopifyPublic = "shpca_test1234567890abcdef1234567890";
        const slackBot = "xoxb-123456789-1234567890123-abcdef";
        const hubspotPat = "pat-na1-12345678-abcdef";

        expect(decryptOrPassthrough(shopifyLegacy)).toBe(shopifyLegacy);
        expect(decryptOrPassthrough(shopifyCustom)).toBe(shopifyCustom);
        expect(decryptOrPassthrough(shopifyPublic)).toBe(shopifyPublic);
        expect(decryptOrPassthrough(slackBot)).toBe(slackBot);
        expect(decryptOrPassthrough(hubspotPat)).toBe(hubspotPat);
      });

      it("fails closed when ENCRYPTION_KEY is missing, even for valid ciphertext", () => {
        const validCiphertext = encrypt("secret");
        delete process.env.ENCRYPTION_KEY;

        expect(() => decrypt(validCiphertext)).toThrow(/ENCRYPTION_KEY is not set/);
        expect(() => decryptOrPassthrough(validCiphertext)).toThrow(/ENCRYPTION_KEY is not set/);
      });

      it("supports key rotation / key formats: base64 (32-byte) and hex (32-byte)", () => {
        // 32-byte base64 key
        const b64Key = crypto.randomBytes(32).toString("base64");
        process.env.ENCRYPTION_KEY = b64Key;
        const msg1 = "token-protected-by-base64-key";
        const c1 = encrypt(msg1);
        expect(decrypt(c1)).toBe(msg1);

        // 32-byte hex key (64 chars)
        const hexKey = crypto.randomBytes(32).toString("hex");
        process.env.ENCRYPTION_KEY = hexKey;
        const msg2 = "token-protected-by-hex-key";
        const c2 = encrypt(msg2);
        expect(decrypt(c2)).toBe(msg2);
      });
    });
  });
});
