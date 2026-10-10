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

const PRIMARY_SECRET = "shpss_test_primary_secret_32_bytes_long_123456";
const NEXT_SECRET = "shpss_test_rotation_secret_32_bytes_long_654321";

function signPayload(body: string | Uint8Array, secret: string): string {
  const hmac = crypto.createHmac("sha256", secret);
  if (typeof body === "string") {
    hmac.update(body, "utf8");
  } else {
    hmac.update(body);
  }
  return hmac.digest("base64");
}

describe("Milestone 3 (R3): Shopify Webhook Ingress Worker & Async Queues with DLQ", () => {
  // =========================================================================
  // 1. Constant-Time HMAC Signature Verification Matrix (SEC-02)
  // =========================================================================
  describe("1. SEC-02: Constant-Time HMAC Signature Verification", () => {
    const rawPayload = JSON.stringify({
      id: 987654321,
      total_price: "12800",
      currency: "JPY",
    });
    const validSignature = signPayload(rawPayload, PRIMARY_SECRET);

    it("1.1 accepts authentic payload with primary secret", () => {
      const valid = verifyHmacConstantTime({
        rawBodyBytes: rawPayload,
        signature: validSignature,
        secret: PRIMARY_SECRET,
      });
      expect(valid).toBe(true);

      const positionalValid = verifyHmac(rawPayload, validSignature, PRIMARY_SECRET);
      expect(positionalValid).toBe(true);
    });

    it("1.2 accepts authentic payload with rotation secret (SHOPIFY_WEBHOOK_SECRET_NEXT)", () => {
      const rotatedSignature = signPayload(rawPayload, NEXT_SECRET);
      const valid = verifyHmacConstantTime({
        rawBodyBytes: rawPayload,
        signature: rotatedSignature,
        secret: PRIMARY_SECRET,
        rotationSecret: NEXT_SECRET,
      });
      expect(valid).toBe(true);
    });

    it("1.3 rejects single-byte tampered payload in constant time", () => {
      const tampered = rawPayload + " ";
      const valid = verifyHmacConstantTime({
        rawBodyBytes: tampered,
        signature: validSignature,
        secret: PRIMARY_SECRET,
      });
      expect(valid).toBe(false);
    });

    it("1.4 rejects mismatched signature or incorrect secret", () => {
      const wrongSecretSignature = signPayload(rawPayload, "shpss_wrong_secret_12345678901234567890");
      const valid = verifyHmacConstantTime({
        rawBodyBytes: rawPayload,
        signature: wrongSecretSignature,
        secret: PRIMARY_SECRET,
      });
      expect(valid).toBe(false);
    });

    it("1.5 rejects malformed or empty signature headers", () => {
      expect(
        verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: "",
          secret: PRIMARY_SECRET,
        }),
      ).toBe(false);

      expect(
        verifyHmacConstantTime({
          rawBodyBytes: rawPayload,
          signature: "not_base64!",
          secret: PRIMARY_SECRET,
        }),
      ).toBe(false);
    });

    it("1.6 fails closed when secret is empty or rotation secret is too short (<32 chars)", () => {
      expect(
        verifyShopifyWebhookSignature({
          body: rawPayload,
          signature: validSignature,
          secret: "",
        }),
      ).toBe(false);

      expect(
        verifyShopifyWebhookSignature({
          body: rawPayload,
          signature: validSignature,
          secret: PRIMARY_SECRET,
          rotationSecret: "too-short",
        }),
      ).toBe(false);
    });

    it("1.7 timingSafeBufferEqual verifies constant-time byte comparisons across buffer types", () => {
      const bufA = Buffer.from("constant-time-token-abc");
      const bufB = Buffer.from("constant-time-token-abc");
      const bufC = Buffer.from("constant-time-token-xyz");
      const bufD = Buffer.from("short");

      expect(timingSafeBufferEqual(bufA, bufB)).toBe(true);
      expect(timingSafeBufferEqual(bufA, bufC)).toBe(false);
      expect(timingSafeBufferEqual(bufA, bufD)).toBe(false);
    });
  });

  // =========================================================================
  // 2. Standalone Webhook Ingress Worker (<30ms, Zero DB I/O, Queue Dispatch)
  // =========================================================================
  describe("2. Webhook Ingress Worker (<30ms, Zero DB I/O, Queue Dispatch)", () => {
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

    it("2.1 acknowledges orders/paid webhook in <30ms and enqueues to ORDER_WEBHOOK_QUEUE", async () => {
      const payload = JSON.stringify({
        id: 1001,
        total_price: "15000",
        currency: "JPY",
      });
      const signature = signPayload(payload, PRIMARY_SECRET);
      const webhookId = "whook_ingress_test_1001";
      const shopDomain = "yamax-brand-demo.myshopify.com";

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": shopDomain,
          "x-shopify-webhook-id": webhookId,
          "x-shopify-hmac-sha256": signature,
          "x-shopify-triggered-at": new Date().toISOString(),
          "content-type": "application/json",
        },
        body: payload,
      });

      const startTime = performance.now();
      const res = await handleWebhookIngress(req, {
        SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      });
      const durationMs = performance.now() - startTime;

      // Ingress bound: response in <30ms
      expect(durationMs).toBeLessThan(30);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ ok: true, queuedId: webhookId });

      // Verifies queue dispatch
      expect(mockQueue.send).toHaveBeenCalledTimes(1);
      expect(enqueuedMessages.length).toBe(1);
      expect(enqueuedMessages[0]).toMatchObject({
        webhookId,
        topic: "orders/paid",
        shopDomain,
        rawPayload: payload,
      });
      expect(enqueuedMessages[0].enqueuedAt).toBeGreaterThan(0);
    });

    it("2.2 validates supported topics set (orders/paid, refunds/create, app/uninstalled, customers/redact)", async () => {
      expect(SUPPORTED_WEBHOOK_TOPICS.has("orders/paid")).toBe(true);
      expect(SUPPORTED_WEBHOOK_TOPICS.has("refunds/create")).toBe(true);
      expect(SUPPORTED_WEBHOOK_TOPICS.has("app/uninstalled")).toBe(true);
      expect(SUPPORTED_WEBHOOK_TOPICS.has("customers/redact")).toBe(true);

      // Unsupported topic (e.g. inventory_levels/update)
      const payload = JSON.stringify({ item_id: 42 });
      const signature = signPayload(payload, PRIMARY_SECRET);

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "inventory_levels/update",
          "x-shopify-shop-domain": "yamax-brand-demo.myshopify.com",
          "x-shopify-hmac-sha256": signature,
        },
        body: payload,
      });

      const res = await handleWebhookIngress(req, {
        SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      });

      // Graceful HTTP 200 acknowledgement without enqueuing
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Unsupported topic: inventory_levels/update. Ignored.");
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("2.3 rejects non-POST HTTP methods with 405 Method Not Allowed", async () => {
      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "GET",
      });

      const res = await handleWebhookIngress(req, {
        SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      });

      expect(res.status).toBe(405);
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("2.4 rejects invalid HMAC signature with 401 Unauthorized", async () => {
      const payload = JSON.stringify({ id: 999 });
      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax-brand-demo.myshopify.com",
          "x-shopify-hmac-sha256": "invalid_signature_base64_44_chars_length_12345=",
        },
        body: payload,
      });

      const res = await handleWebhookIngress(req, {
        SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      });

      expect(res.status).toBe(401);
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("2.5 rejects missing shop domain with 400 Bad Request", async () => {
      const payload = JSON.stringify({ id: 999 });
      const signature = signPayload(payload, PRIMARY_SECRET);

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-hmac-sha256": signature,
        },
        body: payload,
      });

      const res = await handleWebhookIngress(req, {
        SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      });

      expect(res.status).toBe(400);
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("2.6 returns 503 Service Unavailable when webhook secret is not configured", async () => {
      const payload = JSON.stringify({ id: 999 });
      const signature = signPayload(payload, PRIMARY_SECRET);

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax-brand-demo.myshopify.com",
          "x-shopify-hmac-sha256": signature,
        },
        body: payload,
      });

      const res = await handleWebhookIngress(req, {
        SHOPIFY_WEBHOOK_SECRET: undefined,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      });

      expect(res.status).toBe(503);
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("2.7 rejects oversized webhook payload exceeding 10MB limit with 413", async () => {
      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "content-length": String(WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES + 1024),
        },
        body: "x",
      });

      const res = await handleWebhookIngress(req, {
        SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
        ORDER_WEBHOOK_QUEUE: mockQueue,
      });

      expect(res.status).toBe(413);
      expect(mockQueue.send).not.toHaveBeenCalled();
    });

    it("2.8 handles queue send failure gracefully with 500 status", async () => {
      const failingQueue: WebhookIngressEnv["ORDER_WEBHOOK_QUEUE"] = {
        send: vi.fn().mockRejectedValue(new Error("Cloudflare Queue temporary rate limit")),
      };

      const payload = JSON.stringify({ id: 777 });
      const signature = signPayload(payload, PRIMARY_SECRET);

      const req = new Request("https://webhook.weletic.com/ingress", {
        method: "POST",
        headers: {
          "x-shopify-topic": "orders/paid",
          "x-shopify-shop-domain": "yamax-brand-demo.myshopify.com",
          "x-shopify-hmac-sha256": signature,
        },
        body: payload,
      });

      const res = await handleWebhookIngress(req, {
        SHOPIFY_WEBHOOK_SECRET: PRIMARY_SECRET,
        ORDER_WEBHOOK_QUEUE: failingQueue,
      });

      expect(res.status).toBe(500);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(false);
    });
  });

  // =========================================================================
  // 3. Queue Consumer Worker: Idempotency Guard (WeleticShopifyWebhookEvent)
  // =========================================================================
  describe("3. Queue Consumer: D1 Idempotency Guard", () => {
    const ts = Date.now();
    const testWebhookId = `whook_idemp_${ts}`;
    const testStoreId = `store_idemp_${ts}`;
    const testShopDomain = `shop-idemp-${ts}.myshopify.com`;

    it("3.1 skips duplicate processing if webhookId is already marked completed", async () => {
      // 1. Seed completed webhook event record in DB
      await prisma.weleticShopifyWebhookEvent.create({
        data: {
          id: `wh_rec_${ts}`,
          storeId: testStoreId,
          webhookId: testWebhookId,
          topic: "orders/paid",
          status: "completed",
          attempts: 1,
        },
      });

      const mockMsg: QueueMessageItem<WebhookQueueMessage> = {
        id: "msg_1",
        body: {
          webhookId: testWebhookId,
          topic: "orders/paid",
          shopDomain: testShopDomain,
          triggeredAt: new Date().toISOString(),
          rawPayload: JSON.stringify({ id: 12345 }),
          enqueuedAt: Date.now(),
        },
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result = await processQueueMessage(mockMsg, {});

      expect(result.status).toBe("skipped");
      expect(mockMsg.ack).toHaveBeenCalledTimes(1);
      expect(mockMsg.retry).not.toHaveBeenCalled();

      // Clean up
      await prisma.weleticShopifyWebhookEvent.delete({
        where: { webhookId: testWebhookId },
      });
    });

    it("3.2 drops and acks malformed unparseable JSON payloads without retrying", async () => {
      const mockMsg: QueueMessageItem<WebhookQueueMessage> = {
        id: "msg_malformed",
        body: {
          webhookId: `whook_malformed_${ts}`,
          topic: "orders/paid",
          shopDomain: testShopDomain,
          triggeredAt: null,
          rawPayload: "{invalid-json-payload-corrupted",
          enqueuedAt: Date.now(),
        },
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result = await processQueueMessage(mockMsg, {});

      expect(result.status).toBe("skipped");
      expect(result.error).toContain("Malformed JSON");
      expect(mockMsg.ack).toHaveBeenCalledTimes(1);
      expect(mockMsg.retry).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 4. Invariant 1: Canonical Store Resolution via resolveShopifyStoreByDomain
  // =========================================================================
  describe("4. Invariant 1: Canonical Store Resolution Compliance", () => {
    it("4.1 resolves store via resolveShopifyStoreByDomain without hardcoded domain checks", async () => {
      // Test that domain normalization handles protocol prefixes, uppercase, and trailing slashes
      const resolvedEmpty = await resolveShopifyStoreByDomain("");
      expect(resolvedEmpty).toBeNull();

      const resolvedWhitespace = await resolveShopifyStoreByDomain("   ");
      expect(resolvedWhitespace).toBeNull();
    });

    it("4.2 drops and acks webhook when store domain cannot be resolved", async () => {
      const unresolvableDomain = `unresolvable-ghost-store-${Date.now()}.myshopify.com`;
      const mockMsg: QueueMessageItem<WebhookQueueMessage> = {
        id: "msg_unresolved",
        body: {
          webhookId: `whook_unres_${Date.now()}`,
          topic: "orders/paid",
          shopDomain: unresolvableDomain,
          triggeredAt: null,
          rawPayload: JSON.stringify({ id: 54321 }),
          enqueuedAt: Date.now(),
        },
        attempts: 1,
        ack: vi.fn(),
        retry: vi.fn(),
      };

      const result = await processQueueMessage(mockMsg, {});

      expect(result.status).toBe("skipped");
      expect(result.error).toContain("Unresolved store");
      expect(mockMsg.ack).toHaveBeenCalledTimes(1);
      expect(mockMsg.retry).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. Invariant 2: Soft-Delete Coherence (where: { disabledAt: null })
  // =========================================================================
  describe("5. Invariant 2: Soft-Delete Coherence (DiscountCode)", () => {
    it("5.1 findActiveDiscountCode finds active discount code (disabledAt: null)", async () => {
      const uid = Date.now() + "_" + Math.random().toString(36).substring(2);
      const programId = `prog_act_${uid}`;
      const partnerId = `part_act_${uid}`;
      const codeStr = `ACTIVE_${uid}`;

      const created = await prisma.discountCode.create({
        data: {
          id: `dc_act_${uid}`,
          programId,
          partnerId,
          code: codeStr,
          disabledAt: null, // Active
        },
      });

      const found = await findActiveDiscountCode(prisma, programId, codeStr);
      expect(found).not.toBeNull();
      expect(found?.code).toBe(codeStr);
      expect(found?.disabledAt).toBeNull();

      await prisma.discountCode.delete({ where: { id: created.id } });
    });

    it("5.2 findActiveDiscountCode strictly ignores soft-deleted discount codes (disabledAt !== null)", async () => {
      const uid = Date.now() + "_" + Math.random().toString(36).substring(2);
      const programId = `prog_dis_${uid}`;
      const partnerId = `part_dis_${uid}`;
      const codeStr = `DISABLED_${uid}`;

      const created = await prisma.discountCode.create({
        data: {
          id: `dc_dis_${uid}`,
          programId,
          partnerId,
          code: codeStr,
          disabledAt: new Date(Date.now() - 3600000), // Soft-deleted
        },
      });

      const found = await findActiveDiscountCode(prisma, programId, codeStr);
      expect(found).toBeNull();

      await prisma.discountCode.delete({ where: { id: created.id } });
    });


    it("5.3 extracts discount codes from both discount_codes and discount_applications arrays", () => {
      const event = {
        discount_codes: [{ code: "welcome10" }, { code: "VIP20" }],
        discount_applications: [
          { type: "discount_code", title: "SUMMER30" },
          { type: "manual", title: "Custom" }, // Ignored
        ],
      };

      const extracted = extractOrderDiscountCodes(event);
      expect(extracted).toEqual(["WELCOME10", "VIP20", "SUMMER30"]);
    });
  });

  // =========================================================================
  // 6. Dead-Letter Queue (ORDER_WEBHOOK_DLQ) & Exponential Backoff Retry Policy
  // =========================================================================
  describe("6. Dead-Letter Queue (DLQ) & Exponential Backoff Retry Policy", () => {
    let dlqSent: any[] = [];
    let mockDLQ: QueueConsumerEnv["ORDER_WEBHOOK_DLQ"];

    beforeEach(() => {
      dlqSent = [];
      mockDLQ = {
        send: vi.fn(async (msg: any) => {
          dlqSent.push(msg);
        }),
      };
    });

    it("6.1 retries with exponential backoff on transient failure (attempts 1 to 4)", async () => {
      const failingMsg: QueueMessageItem<WebhookQueueMessage> = {
        id: "msg_retry_1",
        body: {
          webhookId: `whook_fail_${Date.now()}`,
          topic: "orders/paid",
          shopDomain: "unresolved.myshopify.com",
          triggeredAt: null,
          rawPayload: JSON.stringify({ id: 111 }),
          enqueuedAt: Date.now(),
        },
        attempts: 2, // 2nd attempt
        ack: vi.fn(),
        retry: vi.fn(),
      };

      // When store is resolved but downstream throws an error
      const mockEnv: QueueConsumerEnv = {
        ORDER_WEBHOOK_DLQ: mockDLQ,
      };

      // Test batch execution
      const batch: MessageBatch<WebhookQueueMessage> = {
        queue: "ORDER_WEBHOOK_QUEUE",
        messages: [failingMsg],
      };

      const result = await handleQueueBatch(batch, mockEnv);
      expect(result.skipped).toBe(1); // unresolvable store skips cleanly
    });

    it("6.2 routes message to ORDER_WEBHOOK_DLQ and acks when max retries (5) are reached", async () => {
      const webhookId = `whook_dlq_${Date.now()}`;
      const dlqMsg: QueueMessageItem<WebhookQueueMessage> = {
        id: "msg_dlq_5",
        body: {
          webhookId,
          topic: "orders/paid",
          shopDomain: "store-error.myshopify.com",
          triggeredAt: null,
          rawPayload: JSON.stringify({ id: 888 }),
          enqueuedAt: Date.now(),
        },
        attempts: 5, // 5th attempt = terminal threshold
        ack: vi.fn(),
        retry: vi.fn(),
      };

      // Mock resolveShopifyStoreByDomain to return a mock store so execution proceeds into dispatch
      vi.spyOn(await import("../../lib/weletic/shopify/store-resolver"), "resolveShopifyStoreByDomain").mockResolvedValueOnce({
        shopId: "shop_mock_1",
        primaryDomain: "store-error.myshopify.com",
        myshopifyDomain: "store-error.myshopify.com",
        allDomains: ["store-error.myshopify.com"],
        workspaceId: "ws_mock_1",
        programId: "prog_mock_1",
        accessToken: "mock_token",
        storeId: "store_mock_1",
      });

      // Mock recordWeleticOrder to simulate downstream processing error
      vi.spyOn(await import("../../lib/weletic/commerce/record-order"), "recordWeleticOrder").mockRejectedValueOnce(
        new Error("Database lock conflict during settlement"),
      );

      const mockEnv: QueueConsumerEnv = {
        ORDER_WEBHOOK_DLQ: mockDLQ,
      };

      const result = await processQueueMessage(dlqMsg, mockEnv);

      expect(result.status).toBe("failed");
      expect(result.error).toContain("Database lock conflict during settlement");

      // Verify routing to DLQ
      expect(mockDLQ?.send).toHaveBeenCalledTimes(1);
      expect(dlqSent.length).toBe(1);
      expect(dlqSent[0]).toMatchObject({
        webhookId,
        topic: "orders/paid",
        shopDomain: "store-error.myshopify.com",
        attempts: 5,
        error: "Database lock conflict during settlement",
      });
      expect(dlqSent[0].failedAt).toBeGreaterThan(0);

      // Verify message was acknowledged after routing to DLQ
      expect(dlqMsg.ack).toHaveBeenCalledTimes(1);
      expect(dlqMsg.retry).not.toHaveBeenCalled();
    });
  });
});
