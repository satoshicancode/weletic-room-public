import {
  readWeleticShopifyRequestBodyBytes,
  WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
} from "./service-auth";
import { verifyShopifyWebhookSignature } from "./webhook-signature";

export const SHOPIFY_WEBHOOK_HMAC_HEADER = "x-shopify-hmac-sha256";
export const SHOPIFY_WEBHOOK_TOPIC_HEADER = "x-shopify-topic";
export const SHOPIFY_WEBHOOK_MIN_SECRET_LENGTH = 32;

type VerifiedShopifyWebhook<T> =
  | { ok: true; body: T; rawBody: string; rawBodyBytes: Uint8Array }
  | { ok: false; response: Response };

function verificationUnavailable() {
  return new Response("[Shopify] Webhook verification is unavailable.", {
    status: 503,
  });
}

function unauthorizedWebhook() {
  return new Response("[Shopify] Invalid webhook signature.", {
    status: 401,
  });
}

function invalidWebhookBody() {
  return new Response("[Shopify] Webhook payload is too large or invalid.", {
    status: 413,
  });
}

/**
 * Reads the request body exactly once, verifies Shopify's HMAC against those
 * raw bytes, and only then parses the JSON payload. This helper intentionally
 * has no local-development bypass because compliance endpoints are public and
 * destructive.
 */
export async function readVerifiedShopifyWebhook<T>({
  request,
  expectedTopic,
}: {
  request: Request;
  expectedTopic: string;
}): Promise<VerifiedShopifyWebhook<T>> {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!secret || secret.length < SHOPIFY_WEBHOOK_MIN_SECRET_LENGTH) {
    return { ok: false, response: verificationUnavailable() };
  }

  const signature = request.headers.get(SHOPIFY_WEBHOOK_HMAC_HEADER) || "";
  const topic = request.headers.get(SHOPIFY_WEBHOOK_TOPIC_HEADER) || "";
  if (topic !== expectedTopic || !/^[A-Za-z0-9+/]{43}=$/.test(signature)) {
    return { ok: false, response: unauthorizedWebhook() };
  }

  const rawBodyBytes = await readWeleticShopifyRequestBodyBytes(request, {
    maxBytes: WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
  });
  if (rawBodyBytes === null) {
    return { ok: false, response: invalidWebhookBody() };
  }

  if (
    !verifyShopifyWebhookSignature({
      body: rawBodyBytes,
      signature,
      secret,
      rotationSecret: process.env.SHOPIFY_WEBHOOK_SECRET_NEXT,
    })
  ) {
    return { ok: false, response: unauthorizedWebhook() };
  }

  const rawBody = new TextDecoder().decode(rawBodyBytes);
  try {
    return {
      ok: true,
      body: JSON.parse(rawBody) as T,
      rawBody,
      rawBodyBytes,
    };
  } catch {
    return {
      ok: false,
      response: new Response("[Shopify] Invalid JSON webhook payload.", {
        status: 400,
      }),
    };
  }
}
