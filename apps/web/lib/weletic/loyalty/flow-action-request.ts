import { readWeleticShopifyRequestBodyBytes } from "../shopify/service-auth";
import { verifyShopifyWebhookSignature } from "../shopify/webhook-signature";
import {
  FlowPointsActionSchema,
  type FlowPointsAction,
} from "./flow-action-contract";

export const FLOW_ACTION_MAX_BODY_BYTES = 16 * 1024;

type Result =
  | { ok: true; action: FlowPointsAction }
  | { ok: false; status: 400 | 401 | 405 | 413 | 503 };

/** Server supplies only the isolated public registration's secret. Authentication
 * does not grant authority: the executor must still check shop/domain, admission,
 * generation, grant, privacy and durable run identity. No staff session is inferred.
 */
export async function readAuthenticatedFlowPointsAction({
  request,
  publicAppSecret,
  rotationSecret,
}: {
  request: Request;
  publicAppSecret: string | undefined;
  rotationSecret?: string;
}): Promise<Result> {
  if (request.method !== "POST") return { ok: false, status: 405 };
  if (
    !publicAppSecret ||
    publicAppSecret.length < 32 ||
    (rotationSecret && rotationSecret.length < 32)
  ) {
    return { ok: false, status: 503 };
  }
  const signature = request.headers.get("x-shopify-hmac-sha256") ?? "";
  if (!/^[A-Za-z0-9+/]{43}=$/.test(signature))
    return { ok: false, status: 401 };
  let bytes: Uint8Array | null;
  try {
    bytes = await readWeleticShopifyRequestBodyBytes(request, {
      maxBytes: FLOW_ACTION_MAX_BODY_BYTES,
    });
  } catch {
    return { ok: false, status: 400 };
  }
  if (bytes === null) return { ok: false, status: 413 };
  if (
    !verifyShopifyWebhookSignature({
      body: bytes,
      signature,
      secret: publicAppSecret,
      rotationSecret,
    })
  )
    return { ok: false, status: 401 };
  try {
    const body = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    const result = FlowPointsActionSchema.safeParse(body);
    return result.success
      ? { ok: true, action: result.data }
      : { ok: false, status: 400 };
  } catch {
    return { ok: false, status: 400 };
  }
}
