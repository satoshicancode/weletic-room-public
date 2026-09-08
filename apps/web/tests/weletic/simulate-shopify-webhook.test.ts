import { verifyShopifyWebhookSignature } from "@/lib/weletic/shopify/webhook-signature";
import { describe, expect, it, vi } from "vitest";
import {
  buildMockPayload,
  computeShopifyHmac,
  dispatchShopifyWebhook,
  dispatchShopifyWebhookDeliveries,
  parseCliArgs,
} from "../../scripts/dev/simulate-shopify-webhook";

describe("Shopify Webhook Simulator (simulate-shopify-webhook.ts)", () => {
  const secret = "shpss_test_secret_12345";

  describe("HMAC Computation", () => {
    it("computes a Shopify-compatible Base64 body HMAC verified by the ingress verifier", () => {
      const payload = { test: "data", value: 123 };
      const rawBody = JSON.stringify(payload);
      const signature = computeShopifyHmac(rawBody, secret);

      expect(typeof signature).toBe("string");
      expect(signature.length).toBeGreaterThan(0);

      const isValid = verifyShopifyWebhookSignature({
        body: rawBody,
        signature,
        secret,
      });
      expect(isValid).toBe(true);
    });

    it("rejects a tampered body against its original body signature", () => {
      const payload = { test: "data", amount: "120.00" };
      const rawBody = JSON.stringify(payload);
      const signature = computeShopifyHmac(rawBody, secret);

      const tamperedBody = JSON.stringify({ test: "data", amount: "999.00" });
      const isValid = verifyShopifyWebhookSignature({
        body: tamperedBody,
        signature,
        secret,
      });
      expect(isValid).toBe(false);
    });
  });

  describe("Payload Generator by Topic", () => {
    it("builds a synthetic Shopify-shaped orders/paid payload for signed dispatch", () => {
      const payload = buildMockPayload("orders/paid", {
        code: "HIRO",
        amount: "120.00",
        currency: "USD",
        orderId: 589283748234,
      });

      expect(payload.id).toBe(589283748234);
      expect(payload.financial_status).toBe("paid");
      expect(payload.currency).toBe("USD");
      expect(payload.discount_codes).toEqual([{ code: "HIRO" }]);
      expect(payload.current_subtotal_price_set.shop_money.amount).toBe(
        "120.00",
      );
      expect(payload.line_items).toHaveLength(2);
      expect(payload.line_items[0].sku).toBe("YMX-FLOW-BLK-M");
      expect(payload.line_items[1].sku).toBe("YMX-AGILE-BLK-S");
    });

    it("formats zero-decimal currency amounts properly for JPY and VND", () => {
      const jpyPayload = buildMockPayload("orders/paid", {
        amount: "19999",
        currency: "JPY",
      });

      expect(jpyPayload.currency).toBe("JPY");
      expect(jpyPayload.current_subtotal_price_set.shop_money.amount).toBe(
        "19999",
      );
      expect(
        jpyPayload.current_subtotal_price_set.shop_money.amount,
      ).not.toContain(".");
    });

    it("builds a synthetic Shopify-shaped refunds/create payload for signed dispatch", () => {
      const payload = buildMockPayload("refunds/create", {
        orderId: 589283748234,
        refundId: 883746282,
        amount: "72.00",
        currency: "USD",
      });

      expect(payload.id).toBe(883746282);
      expect(payload.order_id).toBe(589283748234);
      expect(payload.refund_line_items).toHaveLength(1);
      expect(payload.refund_line_items[0].subtotal_set.shop_money.amount).toBe(
        "72.00",
      );
    });

    it("builds a synthetic Shopify-shaped discounts/delete payload for signed dispatch", () => {
      const payload = buildMockPayload("discounts/delete", { code: "HIRO" });

      expect(payload.code).toBe("HIRO");
      expect(payload.admin_graphql_api_id).toContain(
        "gid://shopify/DiscountCodeNode/",
      );
      expect(payload.title).toContain("HIRO");
    });

    it("builds a synthetic Shopify-shaped discounts/update payload for signed dispatch", () => {
      const payload = buildMockPayload("discounts/update", { code: "HIRO" });

      expect(payload.status).toBe("EXPIRED");
      expect(payload.codes).toEqual([{ id: 1122334455, code: "HIRO" }]);
    });

    it("builds synthetic Shopify-shaped product payloads for signed dispatch", () => {
      const updatePayload = buildMockPayload("products/update", {
        productId: 87654321,
        amount: "80.00",
      });
      expect(updatePayload.id).toBe(87654321);
      expect(updatePayload.title).toBe("Yamax Flow™ High-Rise Leggings");
      expect(updatePayload.variants).toHaveLength(2);

      const deletePayload = buildMockPayload("products/delete", {
        productId: 87654321,
      });
      expect(deletePayload.id).toBe(87654321);
    });

    it("builds synthetic Shopify-shaped compliance payloads for signed dispatch", () => {
      const uninstalled = buildMockPayload("app/uninstalled", {
        shop: "yamaxdev.myshopify.com",
      });
      expect(uninstalled.myshopify_domain).toBe("yamaxdev.myshopify.com");

      const dataRequest = buildMockPayload("customers/data_request", {
        shop: "yamaxdev.myshopify.com",
        orderId: 589283748234,
      });
      expect(dataRequest.orders_requested).toContain(589283748234);

      const customerRedact = buildMockPayload("customers/redact", {
        shop: "yamaxdev.myshopify.com",
      });
      expect(customerRedact.customer.email).toBe("hiro@weletic.com");

      const shopRedact = buildMockPayload("shop/redact", {
        shop: "yamaxdev.myshopify.com",
      });
      expect(shopRedact.shop_domain).toBe("yamaxdev.myshopify.com");
    });
  });

  describe("CLI Flags Parser", () => {
    it("parses long and short flags correctly", () => {
      const args = [
        "-t",
        "refunds/create",
        "-c",
        "DEMO20",
        "-a",
        "50.00",
        "--currency",
        "EUR",
        "--order-id",
        "998877",
        "--refund-id",
        "665544",
        "-s",
        "teststore.myshopify.com",
        "-u",
        "http://localhost:3000/webhook",
        "--secret",
        "custom_secret_key",
        "--duplicate",
        "--tamper",
        "--no-verify-db",
        "--json",
      ];

      const options = parseCliArgs(args);

      expect(options.topic).toBe("refunds/create");
      expect(options.code).toBe("DEMO20");
      expect(options.amount).toBe("50.00");
      expect(options.currency).toBe("EUR");
      expect(options.orderId).toBe("998877");
      expect(options.refundId).toBe("665544");
      expect(options.shop).toBe("teststore.myshopify.com");
      expect(options.target).toBe("http://localhost:3000/webhook");
      expect(options.secret).toBe("custom_secret_key");
      expect(options.duplicate).toBe(true);
      expect(options.tamper).toBe(true);
      expect(options.verifyDb).toBe(false);
      expect(options.json).toBe(true);
    });

    it("parses --topic=val and --code=val syntax", () => {
      const args = [
        "--topic=discounts/delete",
        "--code=SUMMER",
        "--amount=99.00",
      ];
      const options = parseCliArgs(args);

      expect(options.topic).toBe("discounts/delete");
      expect(options.code).toBe("SUMMER");
      expect(options.amount).toBe("99.00");
    });
  });

  describe("Webhook Dispatch Function", () => {
    it("sends the maintenance owner credential privately without returning it", async () => {
      const maintenanceOwnerToken = "a1-owner-token-that-must-stay-private";
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("OK", { status: 200 }));

      try {
        const result = await dispatchShopifyWebhook({
          topic: "orders/paid",
          payload: { id: 123 },
          url: "https://weletic.test/webhook",
          secret,
          maintenanceOwnerToken,
        });

        const requestHeaders = new Headers(
          fetchSpy.mock.calls[0]?.[1]?.headers,
        );
        expect(requestHeaders.get("x-weletic-loyalty-maintenance-token")).toBe(
          maintenanceOwnerToken,
        );
        expect(
          result.headers["x-weletic-loyalty-maintenance-token"],
        ).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain(maintenanceOwnerToken);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("handles connection failure gracefully and returns structured result", async () => {
      const result = await dispatchShopifyWebhook({
        topic: "orders/paid",
        payload: { id: 123 },
        url: "http://127.0.0.1:59999/unreachable-endpoint",
        secret,
      });

      expect(result.status).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.response).toContain("Network error");
      expect(result.signature).toBe(
        computeShopifyHmac(JSON.stringify({ id: 123 }), secret),
      );
      expect(result.headers["x-shopify-topic"]).toBe("orders/paid");
      expect(
        Number.isNaN(
          Date.parse(result.headers["x-shopify-triggered-at"] || ""),
        ),
      ).toBe(false);
    });

    it("uses one generated delivery timestamp across the duplicate-dispatch path used by main", async () => {
      const webhookId = "wh_duplicate_timestamp";
      const [first, second] = await dispatchShopifyWebhookDeliveries({
        topic: "app/uninstalled",
        payload: { id: 123, myshopify_domain: "test.myshopify.com" },
        shopDomain: "test.myshopify.com",
        url: "http://127.0.0.1:59999/unreachable-endpoint",
        secret,
        webhookId,
        duplicate: true,
      });

      expect(first.webhookId).toBe(webhookId);
      expect(second.webhookId).toBe(webhookId);
      const firstTimestamp = first.headers["x-shopify-triggered-at"];
      expect(Number.isNaN(Date.parse(firstTimestamp))).toBe(false);
      expect(second.headers["x-shopify-triggered-at"]).toBe(firstTimestamp);
    });
  });
});
