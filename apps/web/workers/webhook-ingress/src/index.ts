/// <reference types="@cloudflare/workers-types" />
import {
  verifyShopifyWebhookSignature,
  verifyHmac,
} from "../../../lib/weletic/shopify/webhook-signature";
import {
  webhookRateLimiter,
  getClientIp,
  createRateLimitResponse,
} from "../../../lib/weletic/edge-rate-limiter";

export const WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES = 128 * 1024; // 128KB (131,072 bytes)

export const SUPPORTED_WEBHOOK_TOPICS = new Set([
  "orders/paid",
  "refunds/create",
  "app/uninstalled",
  "customers/redact",
]);

export interface WebhookQueueMessage {
  webhookId: string;
  topic: string;
  shopDomain: string;
  triggeredAt: string | null;
  rawPayload: string;
  enqueuedAt: number;
}

export interface QueueSender<T = any> {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
}

export interface WebhookIngressEnv {
  SHOPIFY_WEBHOOK_SECRET?: string;
  SHOPIFY_WEBHOOK_SECRET_NEXT?: string;
  ORDER_WEBHOOK_QUEUE: QueueSender<WebhookQueueMessage>;
  RATE_LIMIT_DISABLED?: string | boolean;
  RATE_LIMIT_MAX?: number;
  RATE_LIMIT_WINDOW_MS?: number;
}

/**
 * Safely reads request body with streaming chunk accumulation limit.
 * Aborts early if total bytes exceed maxBytes to prevent CPU & memory exhaustion.
 */
export async function readLimitedBody(
  request: Request,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (!request.body) {
    try {
      const rawBuffer = await request.arrayBuffer();
      if (rawBuffer.byteLength > maxBytes) {
        return { bytes: new Uint8Array(0), exceeded: true };
      }
      return { bytes: new Uint8Array(rawBuffer), exceeded: false };
    } catch {
      return { bytes: new Uint8Array(0), exceeded: false };
    }
  }

  // Stream reading with chunk accumulation limit
  if (typeof request.body.getReader === "function") {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let accumulatedBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          accumulatedBytes += value.byteLength;
          if (accumulatedBytes > maxBytes) {
            await reader.cancel("payload_too_large").catch(() => {});
            return { bytes: new Uint8Array(0), exceeded: true };
          }
          chunks.push(value);
        }
      }
    } catch (err) {
      if (accumulatedBytes > maxBytes) {
        return { bytes: new Uint8Array(0), exceeded: true };
      }
      throw err;
    }

    const combined = new Uint8Array(accumulatedBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes: combined, exceeded: false };
  }

  // Fallback if getReader is not available
  const rawBuffer = await request.arrayBuffer();
  if (rawBuffer.byteLength > maxBytes) {
    return { bytes: new Uint8Array(0), exceeded: true };
  }
  return { bytes: new Uint8Array(rawBuffer), exceeded: false };
}

export async function handleWebhookIngress(
  request: Request,
  env: WebhookIngressEnv,
): Promise<Response> {
  // 1. Method check: Shopify webhooks are strictly POST
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // 1.1 Edge Burst Rate Limiting (SEC-R4-04)
  if (env.RATE_LIMIT_DISABLED !== true && env.RATE_LIMIT_DISABLED !== "true") {
    const clientIp = getClientIp(request);
    if (clientIp) {
      const rlResult = webhookRateLimiter.check(
        clientIp,
        env.RATE_LIMIT_MAX,
        env.RATE_LIMIT_WINDOW_MS,
      );
      if (!rlResult.success) {
        return createRateLimitResponse(
          rlResult.resetMs,
          rlResult.limit,
          rlResult.remaining,
        );
      }
    }
  }

  // 2. Early Content-Length check to prevent memory exhaustion (SEC-R4-01)
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const rawLength = contentLength.trim();
    if (!/^\d+$/.test(rawLength)) {
      return new Response("[Shopify] Webhook payload is too large or invalid.", {
        status: 413,
      });
    }
    const parsedLength = Number(rawLength);
    if (
      parsedLength < 0 ||
      parsedLength > WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES
    ) {
      return new Response("[Shopify] Webhook payload is too large or invalid.", {
        status: 413,
      });
    }
  }

  // 2.1 Streaming chunk accumulation limit aborting if payload exceeds 128KB (SEC-R4-01)
  const { bytes: rawBytes, exceeded } = await readLimitedBody(
    request,
    WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES,
  );
  if (exceeded) {
    return new Response("[Shopify] Webhook payload is too large or invalid.", {
      status: 413,
    });
  }

  // 3. Extract and check webhook secret
  const secret = env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    return new Response("[Shopify] Webhook verification is unavailable.", {
      status: 503,
    });
  }

  // 4. Constant-time HMAC signature verification (SEC-02)
  const signature = request.headers.get("x-shopify-hmac-sha256") || "";
  if (!signature) {
    return new Response("[Shopify] Invalid webhook signature.", {
      status: 401,
    });
  }

  const isValid = verifyShopifyWebhookSignature({
    body: rawBytes,
    signature,
    secret,
    rotationSecret: env.SHOPIFY_WEBHOOK_SECRET_NEXT,
  });

  if (!isValid) {
    return new Response("[Shopify] Invalid webhook signature.", {
      status: 401,
    });
  }

  // 5. Extract metadata headers
  const topic = request.headers.get("x-shopify-topic") || "";
  const shopDomain = request.headers.get("x-shopify-shop-domain") || "";
  const webhookId =
    request.headers.get("x-shopify-webhook-id") ||
    (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : "whook_" + Math.random().toString(36).substring(2));
  const triggeredAt = request.headers.get("x-shopify-triggered-at");

  if (!shopDomain.trim()) {
    return new Response("[Shopify] Missing shop domain.", { status: 400 });
  }

  // 6. Topic filtering
  if (!SUPPORTED_WEBHOOK_TOPICS.has(topic)) {
    // Gracefully acknowledge unsupported topics so Shopify does not retry
    return new Response(
      `[Shopify] Unsupported topic: ${topic}. Ignored.`,
      { status: 200 },
    );
  }

  // 7. Enqueue to Cloudflare Queue (<5ms, zero synchronous database I/O)
  const rawPayload = new TextDecoder().decode(rawBytes);
  try {
    await env.ORDER_WEBHOOK_QUEUE.send({
      webhookId,
      topic,
      shopDomain,
      triggeredAt,
      rawPayload,
      enqueuedAt: Date.now(),
    });
  } catch (queueError) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: "Failed to enqueue webhook message.",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  // 8. Return HTTP 200 in <30ms
  return new Response(
    JSON.stringify({
      ok: true,
      queuedId: webhookId,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
}

const worker = {
  async fetch(
    request: Request,
    env: WebhookIngressEnv,
    _ctx?: ExecutionContext,
  ): Promise<Response> {
    return handleWebhookIngress(request, env);
  },
};

export default worker;

export { verifyHmac };

