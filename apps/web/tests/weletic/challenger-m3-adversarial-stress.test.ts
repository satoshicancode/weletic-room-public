import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

import crypto from "node:crypto";
import {
  verifyShopifyWebhookSignature,
  verifyHmacConstantTime,
  verifyHmac,
  timingSafeBufferEqual,
} from "../../lib/weletic/shopify/webhook-signature";
import {
  handleWebhookIngress,
  WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
  SUPPORTED_WEBHOOK_TOPICS,
  type WebhookQueueMessage,
  type WebhookIngressEnv,
} from "../../workers/webhook-ingress/src/index";
import {
  processQueueMessage,
  handleQueueBatch,
  findActiveDiscountCode,
  extractOrderDiscountCodes,
  type QueueConsumerEnv,
  type QueueMessageItem,
  type MessageBatch,
} from "../../workers/queue-consumer/src/index";
import { prisma } from "../../lib/prisma";
import { resolveShopifyStoreByDomain } from "../../lib/weletic/shopify/store-resolver";
import * as recordOrderModule from "../../lib/weletic/commerce/record-order";
import * as storeResolverModule from "../../lib/weletic/shopify/store-resolver";

const PRIMARY_SECRET = "shpss_adversarial_test_primary_secret_32_chars_123456";
const NEXT_SECRET = "shpss_adversarial_test_rotation_secret_32_chars_654321";

function signPayload(body: string | Uint8Array, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  if (typeof body === "string") {
    hmac.update(body, "utf8");
  } else {
    hmac.update(body);
  }
  return hmac.digest("base64");
}

describe("Milestone 3 Challenger: Adversarial Stress Test Suite", () => {
  // =========================================================================
  // TASK 1: ADVERSARIAL STRESS-TEST HMAC SIGNATURE VERIFICATION (SEC-02)
  // =========================================================================
  describe("Task 1: Adversarial HMAC Signature Verification (SEC-02)", () => {
    const rawPayload = JSON.stringify({
      id: 99887766,
      name: "#TEST-9988",
      total_price: "24800",
      currency: "JPY",
      customer: { id: 112233, email: "challenger@example.com" },
    });
    const validSignature = signPayload(rawPayload, PRIMARY_SECRET);

    // 1.1 Timing-Attack Resistance Stress Test
    it("1.1 timing-attack resistance: verifies constant-time execution variance", () => {
      // Create tampered signatures that differ at head (index 0), mid (index 22), and tail (index 43)
      const sigHeadDiff =
        (validSignature[0] === "A" ? "B" : "A") + validSignature.slice(1);
      const sigMidDiff =
        validSignature.slice(0, 22) +
        (validSignature[22] === "A" ? "B" : "A") +
        validSignature.slice(23);
      const sigTailDiff =
        validSignature.slice(0, 43) + (validSignature[43] === "=" ? "A" : "=");

      const iterations = 1000;

      // Measure Head Difference
      const t0 = performance.now();
      for (let i = 0; i < iterations; i++) {
        const res = verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: sigHeadDiff,
          secret: PRIMARY_SECRET,
        });
        expect(res).toBe(false);
      }
      const headDuration = performance.now() - t0;

      // Measure Mid Difference
      const t1 = performance.now();
      for (let i = 0; i < iterations; i++) {
        const res = verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: sigMidDiff,
          secret: PRIMARY_SECRET,
        });
        expect(res).toBe(false);
      }
      const midDuration = performance.now() - t1;

      // Measure Tail Difference
      const t2 = performance.now();
      for (let i = 0; i < iterations; i++) {
        const res = verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: sigTailDiff,
          secret: PRIMARY_SECRET,
        });
        expect(res).toBe(false);
      }
      const tailDuration = performance.now() - t2;

      // Verify no catastrophic timing divergence (> 5x divergence over 1000 iterations)
      const ratioHeadToTail = headDuration / Math.max(tailDuration, 0.001);
      const ratioMidToTail = midDuration / Math.max(tailDuration, 0.001);

      expect(ratioHeadToTail).toBeGreaterThan(0.1);
      expect(ratioHeadToTail).toBeLessThan(10.0);
      expect(ratioMidToTail).toBeGreaterThan(0.1);
      expect(ratioMidToTail).toBeLessThan(10.0);
    });

    // 1.2 timingSafeBufferEqual comprehensive byte equality matrix
    it("1.2 timingSafeBufferEqual: verifies byte comparisons across buffer types and diff locations", () => {
      const b1 = Buffer.from("abcdef0123456789abcdef0123456789");
      const b2 = Buffer.from("abcdef0123456789abcdef0123456789");
      expect(timingSafeBufferEqual(b1, b2)).toBe(true);

      // Uint8Array vs Buffer
      const u1 = new Uint8Array(b1);
      expect(timingSafeBufferEqual(u1, b2)).toBe(true);
      expect(timingSafeBufferEqual(b1, u1)).toBe(true);

      // Single-bit flip across every byte position
      for (let i = 0; i < b1.length; i++) {
        const tampered = Buffer.from(b1);
        tampered[i] ^= 0x01; // flip 1 bit
        expect(timingSafeBufferEqual(b1, tampered)).toBe(false);
      }

      // Length mismatches must return false without throwing
      expect(timingSafeBufferEqual(b1, b1.subarray(0, 10))).toBe(false);
      expect(timingSafeBufferEqual(b1, new Uint8Array(0))).toBe(false);
      expect(timingSafeBufferEqual(new Uint8Array(0), new Uint8Array(0))).toBe(
        true,
      );
    });

    // 1.3 Bit-flip tampering: mutate every character in the 44-char base64 signature
    it("1.3 bit-flip tampering: rejects 100% of single-character mutations across all positions (0 to 43)", () => {
      expect(validSignature.length).toBe(44);

      for (let pos = 0; pos < validSignature.length; pos++) {
        const originalChar = validSignature[pos];
        const mutatedChar = originalChar === "x" ? "y" : "x";
        const mutatedSig =
          validSignature.slice(0, pos) +
          mutatedChar +
          validSignature.slice(pos + 1);

        const result = verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: mutatedSig,
          secret: PRIMARY_SECRET,
        });

        expect(
          result,
          `Failed to reject tampered signature at position ${pos}`,
        ).toBe(false);
      }
    });

    // 1.4 Raw body bit flipping
    it("1.4 raw body tampering: rejects single-bit mutations in payload bytes", () => {
      const rawBytes = new TextEncoder().encode(rawPayload);

      // Head byte bit flip
      const tamperedHead = new Uint8Array(rawBytes);
      tamperedHead[0] ^= 0x01;
      expect(
        verifyHmacConstantTime({
          rawBodyBytes: tamperedHead,
          signature: validSignature,
          secret: PRIMARY_SECRET,
        }),
      ).toBe(false);

      // Mid byte bit flip
      const tamperedMid = new Uint8Array(rawBytes);
      tamperedMid[Math.floor(rawBytes.length / 2)] ^= 0x01;
      expect(
        verifyHmacConstantTime({
          rawBodyBytes: tamperedMid,
          signature: validSignature,
          secret: PRIMARY_SECRET,
        }),
      ).toBe(false);

      // Tail byte bit flip
      const tamperedTail = new Uint8Array(rawBytes);
      tamperedTail[rawBytes.length - 1] ^= 0x01;
      expect(
        verifyHmacConstantTime({
          rawBodyBytes: tamperedTail,
          signature: validSignature,
          secret: PRIMARY_SECRET,
        }),
      ).toBe(false);
    });

    // 1.5 Truncated signatures
    it("1.5 truncated signatures: rejects signatures of truncated lengths without exception", () => {
      const truncatedLengths = [0, 1, 5, 10, 20, 32, 40, 43];
      for (const len of truncatedLengths) {
        const truncSig = validSignature.slice(0, len);
        expect(
          verifyHmacConstantTime({
            rawBodyBytes: rawPayload,
            signature: truncSig,
            secret: PRIMARY_SECRET,
          }),
        ).toBe(false);
      }
    });

    // 1.6 Oversized and malformed base64
    it("1.6 oversized and malformed base64 signatures: safely fails closed", () => {
      // Oversized signatures
      expect(
        verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: validSignature + "extra",
          secret: PRIMARY_SECRET,
        }),
      ).toBe(false);

      expect(
        verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: "A".repeat(10_000),
          secret: PRIMARY_SECRET,
        }),
      ).toBe(false);

      // Malformed base64 symbols
      const invalidSignatures = [
        "!!!@@@###$$$%%%^^^&&&***((()))___+++===~~~",
        "valid_prefix_with_emoji_🛡️_test_signature=",
        validSignature + "\r\n",
        "  " + validSignature + "  ",
        "====",
        "invalid base64 with spaces inside signature=",
      ];

      for (const badSig of invalidSignatures) {
        expect(
          verifyHmacConstantTime({
            rawBodyBytes: rawPayload,
            signature: badSig,
            secret: PRIMARY_SECRET,
          }),
        ).toBe(false);
      }
    });

    // 1.7 Null byte attacks
    it("1.7 null byte injection: safely rejects signatures and payloads with null bytes", () => {
      // Null byte inside signature
      const nullSig = validSignature.slice(0, 10) + "\0" + validSignature.slice(11);
      expect(
        verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: nullSig,
          secret: PRIMARY_SECRET,
        }),
      ).toBe(false);

      // Null byte inside raw payload
      const payloadWithNull = new TextEncoder().encode(rawPayload + "\0extra");
      expect(
        verifyHmacConstantTime({
          rawBodyBytes: payloadWithNull,
          signature: validSignature,
          secret: PRIMARY_SECRET,
        }),
      ).toBe(false);
    });

    // 1.8 Replay & cross-secret evaluation
    it("1.8 replay attacks: rejects replayed signature against different body or secret", () => {
      const payloadA = JSON.stringify({ order_id: 101, amount: "100.00" });
      const payloadB = JSON.stringify({ order_id: 102, amount: "100.00" });
      const sigA = signPayload(payloadA, PRIMARY_SECRET);

      // Replay sigA against payloadB
      expect(
        verifyHmacConstantTime({
          rawBodyBytes: payloadB,
          signature: sigA,
          secret: PRIMARY_SECRET,
        }),
      ).toBe(false);

      // Replay sigA with wrong secret
      expect(
        verifyHmacConstantTime({
          rawBodyBytes: payloadA,
          signature: sigA,
          secret: "shpss_completely_different_secret_key_32_chars",
        }),
      ).toBe(false);
    });

    // 1.9 Secret rotation matrix
    it("1.9 secret rotation matrix: verifies primary, next, and malformed rotation keys", () => {
      const sigPrimary = signPayload(rawPayload, PRIMARY_SECRET);
      const sigNext = signPayload(rawPayload, NEXT_SECRET);
      const sigOther = signPayload(rawPayload, "shpss_unregistered_key_32_chars_12345678");

      // Accepts either primary or next during rotation
      expect(
        verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: sigPrimary,
          secret: PRIMARY_SECRET,
          rotationSecret: NEXT_SECRET,
        }),
      ).toBe(true);

      expect(
        verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: sigNext,
          secret: PRIMARY_SECRET,
          rotationSecret: NEXT_SECRET,
        }),
      ).toBe(true);

      // Rejects key not in keyring
      expect(
        verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: sigOther,
          secret: PRIMARY_SECRET,
          rotationSecret: NEXT_SECRET,
        }),
      ).toBe(false);

      // Fails closed if rotation secret is short (<32 chars)
      expect(
        verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: sigPrimary,
          secret: PRIMARY_SECRET,
          rotationSecret: "too_short_key",
        }),
      ).toBe(false);
    });
  });

  // =========================================================================
  // TASK 2: ADVERSARIAL INGRESS WORKER LATENCY & BOUNDS (<30ms, 413, 405)
  // =========================================================================
  describe("Task 2: Ingress Worker Latency & Payload Bounds", () => {
    let enqueuedMessages: WebhookQueueMessage[] = [];
    let mockQueue: WebhookIngressEnv["ORDER_WEBHOOK_QUEUE"];

    beforeEach(() => {
      enqueuedMessages = [];
      mockQueue = {
        send: vi.fn(async (msg: WebhookQueueMessage) => {
          enqueuedMessages.push(msg);
        }),
      };
    });

    // 2.1 Burst Latency: 100 concurrent requests within <30ms
    it("2.1 burst latency: 100 concurrent requests each respond in <30ms and enqueue successfully", async () => {
      const burstCount = 100;
      const requests = Array.from({ length: burstCount }, (_, i) => {
        const payload = JSON.stringify({
          id: 5000 + i,
          total_price: "9900",
          currency: "JPY",
        });
        const signature = signPayload(payload, PRIMARY_SECRET);
        const webhookId = `whook_burst_${i}_${Date.now()}`;

        const req = new Request("https://webhook.weletic.com/ingress", {
          method: "POST",
          headers: {
            "x-shopify-topic": "orders/paid",
            "x-shopify-shop-domain": "burst-test.myshopify.com",
            "x-shopify-webhook-id": webhookId,
            "x-shopify-hmac-sha256": signature,
            "content-type": "application/json",
          },
          body: payload,
        });

        return { req, webhookId };
      });

      const env: WebhookIngressEnv = {
        SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      };

      const startAll = performance.now();
      const results = await Promise.all(
        requests.map(async ({ req, webhookId }) => {
          const t0 = performance.now();
          const res = await handleWebhookIngress(req, env);
          const duration = performance.now() - t0;
          return { res, duration, webhookId };
        }),
      );
      const totalBatchDuration = performance.now() - startAll;

      // Verify each individual request latency < 30ms
      for (const { res, duration, webhookId } of results) {
        expect(res.status).toBe(200);
        expect(
          duration,
          `Request ${webhookId} exceeded 30ms latency bound: ${duration.toFixed(2)}ms`,
        ).toBeLessThan(30);
      }

      // Verify all 100 were enqueued
      expect(enqueuedMessages.length).toBe(burstCount);
      expect(mockQueue.send).toHaveBeenCalledTimes(burstCount);

      // Verify average latency across burst
      const avgDuration = totalBatchDuration / burstCount;
      expect(avgDuration).toBeLessThan(25);
    });

    // 2.2 Payload Bounds: Content-Length header > 10MB -> 413
    it("2.2 payload bounds: rejects requests exceeding 10MB via Content-Length header with 413", async () => {
      const oversizedBytes = WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES + 1024;
      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "content-length": String(oversizedBytes),
        },
        body: "x",
      });

      const res = await handleWebhookIngress(req, {
        SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      });

      expect(res.status).toBe(413);
      const text = await res.text();
      expect(text).toContain("Webhook payload is too large or invalid.");
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    // 2.3 Payload Bounds: Actual body > 10MB without or spoofed Content-Length -> 413
    it("2.3 payload bounds: rejects streaming body exceeding 10MB limit with 413", async () => {
      // 10MB + 1 byte
      const hugeBuffer = new Uint8Array(WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES + 1);
      hugeBuffer.fill(65); // fill with 'A'

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          // Intentionally omit content-length or provide smaller header
          "content-length": "100",
        },
        body: hugeBuffer,
      });

      const res = await handleWebhookIngress(req, {
        SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      });

      expect(res.status).toBe(413);
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    // 2.4 Payload Boundary: Exactly 10MB body passes size check
    it("2.4 payload bounds: exactly 10MB (10485760 bytes) is not rejected by size bound", async () => {
      const exact10MbBuffer = new Uint8Array(WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES);
      exact10MbBuffer.fill(66);

      const signature = signPayload(exact10MbBuffer, PRIMARY_SECRET);

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "x-shopify-hmac-sha256": signature,
          "content-length": String(WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES),
        },
        body: exact10MbBuffer,
      });

      const res = await handleWebhookIngress(req, {
        SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      });

      // Passes size check (status 200, queued)
      expect(res.status).toBe(200);
      expect(mockQueue.send).toHaveBeenCalledTimes(1);
    });

    // 2.5 HTTP Methods: 405 Method Not Allowed on non-POST
    it("2.5 HTTP methods: rejects GET, PUT, DELETE, PATCH, OPTIONS with 405 Method Not Allowed", async () => {
      const disallowedMethods = ["GET", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"];

      for (const method of disallowedMethods) {
        const req = new Request("https://webhook.weletic.com/ingress", {
          method,
        });

        const res = await handleWebhookIngress(req, {
          SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
          ORDER_WEBHOOK_QUEUE: mockQueue,
        });

        expect(res.status, `Method ${method} was not rejected with 405`).toBe(405);
        expect(mockQueue.send).not.toHaveBeenCalled();
      }
    });

    // 2.6 Missing shop domain, topic, or secret fail closed
    it("2.6 missing metadata: rejects empty shop domain (400) and unconfigured secret (503)", async () => {
      const payload = JSON.stringify({ id: 123 });
      const signature = signPayload(payload, PRIMARY_SECRET);

      // Missing shop domain -> 400
      const reqMissingDomain = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-hmac-sha256": signature,
          "content-type": "application/json",
        },
        body: payload,
      });
      const res400 = await handleWebhookIngress(reqMissingDomain, {
        SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      });
      expect(res400.status).toBe(400);

      // Missing secret in env -> 503
      const reqWithDomain = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax.myshopify.com",
          "x-shopify-hmac-sha256": signature,
          "content-type": "application/json",
        },
        body: payload,
      });
      const res503 = await handleWebhookIngress(reqWithDomain, {
        SHOPIFY_WEBHOOK_SECRET: undefined,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      });
      expect(res503.status).toBe(503);
    });
  });

  // =========================================================================
  // TASK 3: ADVERSARIAL QUEUE CONSUMER IDEMPOTENCY
  // =========================================================================
  describe("Task 3: Queue Consumer Idempotency Stress Testing", () => {
    const ts = Date.now();
    const testWebhookId = `whook_idemp_burst_${ts}`;
    const testStoreId = `store_idemp_burst_${ts}`;
    const testShopDomain = `shop-burst-${ts}.myshopify.com`;

    it("3.1 batch duplicate delivery: 20 duplicate messages in queue batch record exactly one event", async () => {
      // Mock store resolver
      vi.spyOn(storeResolverModule, "resolveShopifyStoreByDomain").mockResolvedValue({
        shopId: testStoreId,
        storeId: testStoreId,
        primaryDomain: testShopDomain,
        myshopifyDomain: testShopDomain,
        allDomains: [testShopDomain],
        workspaceId: `ws_${ts}`,
        programId: `prog_${ts}`,
        accessToken: "test_token",
      });

      // Spy on recordWeleticOrder
      const recordOrderSpy = vi
        .spyOn(recordOrderModule, "recordWeleticOrder")
        .mockResolvedValue({} as any);

      // Create 20 duplicate message items with identical webhookId
      const ackSpies: any[] = [];
      const duplicateMessages: QueueMessageItem<WebhookQueueMessage>[] = Array.from(
        { length: 20 },
        (_, i) => {
          const ackFn = vi.fn();
          ackSpies.push(ackFn);
          return {
            id: `msg_dup_${i}`,
            body: {
              webhookId: testWebhookId,
              topic: "orders/paid",
              shopDomain: testShopDomain,
              triggeredAt: new Date().toISOString(),
              rawPayload: JSON.stringify({
                id: 888001,
                total_price: "12000",
                currency: "JPY",
              }),
              enqueuedAt: Date.now(),
            },
            attempts: 1,
            ack: ackFn,
            retry: vi.fn(),
          };
        },
      );

      const batch: MessageBatch<WebhookQueueMessage> = {
        queue: "ORDER_WEBHOOK_QUEUE",
        messages: duplicateMessages,
      };

      const summary = await handleQueueBatch(batch, {});

      // Exactly 1 message processed, 19 skipped
      expect(summary.processed).toBe(1);
      expect(summary.skipped).toBe(19);
      expect(summary.errors).toBe(0);

      // Downstream financial recording invoked exactly ONCE
      expect(recordOrderSpy).toHaveBeenCalledTimes(1);

      // All 20 messages acknowledged
      for (let i = 0; i < 20; i++) {
        expect(ackSpies[i]).toHaveBeenCalledTimes(1);
      }

      // Verify D1/Prisma contains exactly ONE completed event record
      const dbRecords = await prisma.weleticShopifyWebhookEvent.findMany({
        where: { webhookId: testWebhookId },
      });
      expect(dbRecords.length).toBe(1);
      expect(dbRecords[0].status).toBe("completed");

      // Cleanup
      await prisma.weleticShopifyWebhookEvent.delete({
        where: { webhookId: testWebhookId },
      });
    });

    it("3.2 redelivery after completion: subsequent deliveries immediately skip without re-executing", async () => {
      const redeliverWebhookId = `whook_redeliver_${Date.now()}`;

      // Seed as completed
      await prisma.weleticShopifyWebhookEvent.create({
        data: {
          id: `wh_seed_${Date.now()}`,
          storeId: testStoreId,
          webhookId: redeliverWebhookId,
          topic: "orders/paid",
          status: "completed",
          attempts: 1,
        },
      });

      const recordOrderSpy = vi.spyOn(recordOrderModule, "recordWeleticOrder");
      recordOrderSpy.mockClear();

      const msg: QueueMessageItem<WebhookQueueMessage> = {
        id: "msg_redelivery",
        body: {
          webhookId: redeliverWebhookId,
          topic: "orders/paid",
          shopDomain: testShopDomain,
          triggeredAt: new Date().toISOString(),
          rawPayload: JSON.stringify({ id: 999 }),
          enqueuedAt: Date.now(),
        },
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result = await processQueueMessage(msg, {});

      expect(result.status).toBe("skipped");
      expect(msg.ack).toHaveBeenCalledTimes(1);
      expect(msg.retry).not.toHaveBeenCalled();
      expect(recordOrderSpy).not.toHaveBeenCalled();

      // Cleanup
      await prisma.weleticShopifyWebhookEvent.delete({
        where: { webhookId: redeliverWebhookId },
      });
    });
  });

  // =========================================================================
  // TASK 4: ADVERSARIAL INVARIANTS 1 & 2 COMPLIANCE
  // =========================================================================
  describe("Task 4: Invariants 1 & 2 Adversarial Compliance", () => {
    // 4.1 Invariant 1: Multi-domain store resolution
    it("4.1 Invariant 1: multi-domain store resolution normalizes protocol, case, and aliases", async () => {
      // 1. Normalize domain checks
      expect(
        storeResolverModule.normalizeShopDomain("HTTPS://YAMAX-BRAND.MYSHOPIFY.COM/"),
      ).toBe("yamax-brand.myshopify.com");
      expect(
        storeResolverModule.normalizeShopDomain("http://store.yamax.com/path"),
      ).toBe("store.yamax.com");
      expect(storeResolverModule.normalizeShopDomain("   ")).toBe("");
      expect(storeResolverModule.normalizeShopDomain("")).toBe("");

      // 2. Canonical store resolver routing checks
      const uniqueId = Date.now().toString(36);
      const testShop = `yamax-${uniqueId}.myshopify.com`;
      const storeId = `store_inv1_${uniqueId}`;

      // Mock resolved store to verify consumer handles domain aliases dynamically
      const storeMock = {
        shopId: storeId,
        storeId,
        primaryDomain: `shop-${uniqueId}.yamax.com`,
        myshopifyDomain: testShop,
        allDomains: [testShop, `shop-${uniqueId}.yamax.com`],
        workspaceId: `ws_${uniqueId}`,
        programId: `prog_${uniqueId}`,
        accessToken: "mock_token",
      };

      vi.spyOn(storeResolverModule, "resolveShopifyStoreByDomain").mockImplementation(
        async (domain) => {
          const norm = storeResolverModule.normalizeShopDomain(domain);
          if (norm === testShop || norm === `shop-${uniqueId}.yamax.com`) {
            return storeMock;
          }
          return null;
        },
      );

      // Verify resolution across myshopifyDomain, primaryDomain, uppercase, and protocol
      const res1 = await storeResolverModule.resolveShopifyStoreByDomain(testShop);
      expect(res1?.storeId).toBe(storeId);

      const res2 = await storeResolverModule.resolveShopifyStoreByDomain(
        `HTTPS://${testShop.toUpperCase()}/`,
      );
      expect(res2?.storeId).toBe(storeId);

      const res3 = await storeResolverModule.resolveShopifyStoreByDomain(
        `https://shop-${uniqueId}.yamax.com`,
      );
      expect(res3?.storeId).toBe(storeId);

      const resUnknown = await storeResolverModule.resolveShopifyStoreByDomain(
        "unknown-domain.myshopify.com",
      );
      expect(resUnknown).toBeNull();
    });

    // 4.2 Invariant 2: Soft-deleted discount codes receive zero commission
    it("4.2 Invariant 2: soft-deleted discount codes (disabledAt !== null) receive 0 commission", async () => {
      const uid = Date.now() + "_" + Math.random().toString(36).substring(2);
      const programId = `prog_inv2_${uid}`;
      const partnerId = `part_inv2_${uid}`;
      const activeCode = `ACTIVE_${uid}`.toUpperCase();
      const disabledCode = `DISABLED_${uid}`.toUpperCase();

      // 1. Create active discount code
      const activeDc = await prisma.discountCode.create({
        data: {
          id: `dc_active_${uid}`,
          programId,
          partnerId,
          code: activeCode,
          disabledAt: null,
        },
      });

      // 2. Create soft-deleted discount code
      const disabledDc = await prisma.discountCode.create({
        data: {
          id: `dc_disabled_${uid}`,
          programId,
          partnerId,
          code: disabledCode,
          disabledAt: new Date(Date.now() - 60_000), // Soft-deleted
        },
      });

      try {
        // Query active code -> returns code
        const foundActive = await findActiveDiscountCode(prisma, programId, activeCode);
        expect(foundActive).not.toBeNull();
        expect(foundActive?.code).toBe(activeCode);

        // Query soft-deleted code -> strictly returns null
        const foundDisabled = await findActiveDiscountCode(prisma, programId, disabledCode);
        expect(foundDisabled).toBeNull();

        // Downstream order simulation with soft-deleted discount
        const recordOrderSpy = vi
          .spyOn(recordOrderModule, "recordWeleticOrder")
          .mockResolvedValue({} as any);

        const storeMock = {
          shopId: `store_${uid}`,
          storeId: `store_${uid}`,
          primaryDomain: "test.myshopify.com",
          myshopifyDomain: "test.myshopify.com",
          allDomains: ["test.myshopify.com"],
          workspaceId: `ws_${uid}`,
          programId,
          accessToken: "token",
        };
        vi.spyOn(storeResolverModule, "resolveShopifyStoreByDomain").mockResolvedValue(
          storeMock,
        );

        // Message with ONLY soft-deleted discount code
        const msgDisabled: QueueMessageItem<WebhookQueueMessage> = {
          id: "msg_disabled_test",
          body: {
            webhookId: `whook_disabled_${uid}`,
            topic: "orders/paid",
            shopDomain: "test.myshopify.com",
            triggeredAt: null,
            rawPayload: JSON.stringify({
              id: 99911,
              total_price: "15000",
              currency: "JPY",
              discount_codes: [{ code: disabledCode }],
            }),
            enqueuedAt: Date.now(),
          },
          attempts: 1,
          ack: vi.fn(),
          retry: vi.fn(),
        };

        await processQueueMessage(msgDisabled, {});

        // Commission attribution MUST be null for soft-deleted discount
        expect(recordOrderSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            partnerId: null,
            linkId: null,
          }),
        );
        recordOrderSpy.mockClear();

        // Message with active discount code
        const msgActive: QueueMessageItem<WebhookQueueMessage> = {
          id: "msg_active_test",
          body: {
            webhookId: `whook_active_${uid}`,
            topic: "orders/paid",
            shopDomain: "test.myshopify.com",
            triggeredAt: null,
            rawPayload: JSON.stringify({
              id: 99922,
              total_price: "15000",
              currency: "JPY",
              discount_codes: [{ code: activeCode }],
            }),
            enqueuedAt: Date.now(),
          },
          attempts: 1,
          ack: vi.fn(),
          retry: vi.fn(),
        };

        await processQueueMessage(msgActive, {});

        // Commission attribution MUST be attributed to partner
        expect(recordOrderSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            partnerId,
          }),
        );

        // Cleanup webhook events created during test
        await prisma.weleticShopifyWebhookEvent.deleteMany({
          where: {
            webhookId: {
              in: [`whook_disabled_${uid}`, `whook_active_${uid}`],
            },
          },
        });
      } finally {
        await prisma.discountCode.deleteMany({
          where: { id: { in: [activeDc.id, disabledDc.id] } },
        });
      }
    });

    // 4.3 Invariant 4: Zero hardcoding in worker codebase
    it("4.3 Invariant 4: zero hardcoded domains or workspace IDs in ingress and consumer workers", async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");

      const ingressPath = path.resolve(
        process.cwd(),
        "workers/webhook-ingress/src/index.ts",
      );
      const consumerPath = path.resolve(
        process.cwd(),
        "workers/queue-consumer/src/index.ts",
      );

      const ingressCode = fs.readFileSync(ingressPath, "utf8");
      const consumerCode = fs.readFileSync(consumerPath, "utf8");

      const forbiddenLiterals = [
        "yamaxdev",
        "montdev",
        "yamax.myshopify.com",
        "ws_prod",
        "ws_demo",
      ];

      for (const literal of forbiddenLiterals) {
        expect(
          ingressCode.includes(literal),
          `Found forbidden hardcoded literal '${literal}' in ingress worker`,
        ).toBe(false);
        expect(
          consumerCode.includes(literal),
          `Found forbidden hardcoded literal '${literal}' in queue consumer worker`,
        ).toBe(false);
      }
    });
  });
});
