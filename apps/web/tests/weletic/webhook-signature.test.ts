import { verifyShopifyWebhookSignature } from "@/lib/weletic/shopify/webhook-signature";
import crypto from "crypto";
import { describe, expect, test } from "vitest";

describe("Weletic Shopify webhook signatures", () => {
  const body = JSON.stringify({ id: 123, topic: "orders/paid" });
  const secret = "test-webhook-secret";
  const signature = crypto
    .createHmac("sha256", secret)
    .update(body, "utf8")
    .digest("base64");

  test("accepts an authentic body", () => {
    expect(verifyShopifyWebhookSignature({ body, signature, secret })).toBe(
      true,
    );
  });

  test("rejects tampered content and malformed signatures", () => {
    expect(
      verifyShopifyWebhookSignature({
        body: `${body} `,
        signature,
        secret,
      }),
    ).toBe(false);
    expect(
      verifyShopifyWebhookSignature({ body, signature: "invalid", secret }),
    ).toBe(false);
  });
});
