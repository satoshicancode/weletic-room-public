import { readVerifiedShopifyWebhook } from "@/lib/weletic/shopify/webhook-request";
import { verifyShopifyWebhookSignature } from "@/lib/weletic/shopify/webhook-signature";
import crypto from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";

const oldSecret = "rotation-test-old-secret-".repeat(2);
const nextSecret = "rotation-test-next-secret-".repeat(2);
const body = '{"message":"日本語 tiếng Việt"}';
const sign = (secret: string, input = body) =>
  crypto.createHmac("sha256", secret).update(input).digest("base64");

afterEach(() => vi.unstubAllEnvs());

describe("Shopify webhook secret rotation", () => {
  test.each([oldSecret, nextSecret])(
    "accepts either overlap key (%#)",
    (key) => {
      for (const input of [body, new TextEncoder().encode(body)]) {
        expect(
          verifyShopifyWebhookSignature({
            body: input,
            signature: sign(key),
            secret: oldSecret,
            rotationSecret: nextSecret,
          }),
        ).toBe(true);
      }
    },
  );

  test("new-only configuration retires old signatures", () => {
    expect(
      verifyShopifyWebhookSignature({
        body,
        signature: sign(oldSecret),
        secret: nextSecret,
      }),
    ).toBe(false);
    expect(
      verifyShopifyWebhookSignature({
        body,
        signature: sign(nextSecret),
        secret: nextSecret,
      }),
    ).toBe(true);
  });

  test.each([oldSecret, nextSecret])(
    "rejects tampering for either key (%#)",
    (key) => {
      expect(
        verifyShopifyWebhookSignature({
          body: body + " ",
          signature: sign(key),
          secret: oldSecret,
          rotationSecret: nextSecret,
        }),
      ).toBe(false);
    },
  );

  test("rejects missing primary, malformed rotation key, and unrelated signatures", () => {
    expect(
      verifyShopifyWebhookSignature({
        body,
        signature: sign(nextSecret),
        secret: "",
        rotationSecret: nextSecret,
      }),
    ).toBe(false);
    expect(
      verifyShopifyWebhookSignature({
        body,
        signature: sign(oldSecret),
        secret: oldSecret,
        rotationSecret: "short",
      }),
    ).toBe(false);
    expect(
      verifyShopifyWebhookSignature({
        body,
        signature: sign("unrelated"),
        secret: oldSecret,
        rotationSecret: nextSecret,
      }),
    ).toBe(false);
    expect(
      verifyShopifyWebhookSignature({
        body,
        signature: "invalid",
        secret: oldSecret,
        rotationSecret: nextSecret,
      }),
    ).toBe(false);
  });

  test("empty optional env preserves single-secret behavior", () => {
    expect(
      verifyShopifyWebhookSignature({
        body,
        signature: sign(oldSecret),
        secret: oldSecret,
        rotationSecret: "",
      }),
    ).toBe(true);
    expect(
      verifyShopifyWebhookSignature({
        body,
        signature: sign(nextSecret),
        secret: oldSecret,
        rotationSecret: "",
      }),
    ).toBe(false);
  });

  test.each([oldSecret, nextSecret])(
    "production compliance reader accepts overlap (%#)",
    async (key) => {
      vi.stubEnv("SHOPIFY_WEBHOOK_SECRET", oldSecret);
      vi.stubEnv("SHOPIFY_WEBHOOK_SECRET_NEXT", nextSecret);
      const request = new Request("https://example.invalid/webhook", {
        method: "POST",
        body,
        headers: {
          "x-shopify-topic": "customers/data_request",
          "x-shopify-hmac-sha256": sign(key),
        },
      });
      const result = await readVerifiedShopifyWebhook({
        request,
        expectedTopic: "customers/data_request",
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.rawBody).toBe(body);
    },
  );

  test("rotation does not bypass topic checks", async () => {
    vi.stubEnv("SHOPIFY_WEBHOOK_SECRET", oldSecret);
    vi.stubEnv("SHOPIFY_WEBHOOK_SECRET_NEXT", nextSecret);
    const request = new Request("https://example.invalid/webhook", {
      method: "POST",
      body,
      headers: {
        "x-shopify-topic": "wrong",
        "x-shopify-hmac-sha256": sign(nextSecret),
      },
    });
    const result = await readVerifiedShopifyWebhook({
      request,
      expectedTopic: "customers/data_request",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
  });
});
