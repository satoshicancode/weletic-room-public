import {
  persistShopifyFlowLifecycleEvent,
  ShopifyFlowLifecyclePayloadSchema,
} from "@/lib/weletic/loyalty/flow-lifecycle";
import { readWeleticShopifyRequestBodyBytes } from "@/lib/weletic/shopify/service-auth";
import { verifyShopifyWebhookSignature } from "@/lib/weletic/shopify/webhook-signature";

const FLOW_LIFECYCLE_MAX_BODY_BYTES = 64 * 1024;
const SHOPIFY_HMAC_HEADER = "x-shopify-hmac-sha256";

export async function POST(request: Request) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret || secret.length < 32) {
    return Response.json(
      { error: "Shopify lifecycle verification is unavailable." },
      { status: 503 },
    );
  }

  const signature = request.headers.get(SHOPIFY_HMAC_HEADER) ?? "";
  const rawBodyBytes = await readWeleticShopifyRequestBodyBytes(request, {
    maxBytes: FLOW_LIFECYCLE_MAX_BODY_BYTES,
  });
  if (!rawBodyBytes) {
    return Response.json({ error: "Invalid request body." }, { status: 413 });
  }
  if (
    !verifyShopifyWebhookSignature({
      body: rawBodyBytes,
      signature,
      secret,
      rotationSecret: process.env.SHOPIFY_WEBHOOK_SECRET_NEXT,
    })
  ) {
    return Response.json({ error: "Invalid signature." }, { status: 401 });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder().decode(rawBodyBytes));
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const payload = ShopifyFlowLifecyclePayloadSchema.safeParse(parsedJson);
  if (!payload.success) {
    return Response.json(
      { error: "Invalid lifecycle payload." },
      { status: 400 },
    );
  }

  try {
    const result = await persistShopifyFlowLifecycleEvent(payload.data);
    return Response.json({ ok: true, status: result.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missingStore = message.startsWith(
      "No connected Weletic Shopify store",
    );
    return Response.json(
      {
        error: missingStore
          ? "Shopify store is not connected."
          : "Lifecycle state could not be stored.",
      },
      { status: missingStore ? 404 : 500 },
    );
  }
}
