import crypto from "node:crypto";

export const WELETIC_SHOPIFY_TIMESTAMP_HEADER = "x-weletic-timestamp";
export const WELETIC_SHOPIFY_SIGNATURE_HEADER = "x-weletic-signature";
export const WELETIC_SHOPIFY_REQUEST_ID_HEADER = "x-weletic-request-id";
export const WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const WELETIC_SHOPIFY_MAX_BODY_BYTES = 256 * 1024;
// Shopify's external REST webhook payloads can legitimately contain full
// order/customer histories. Keep the internal service default at 256 KiB,
// while bounding the public Shopify ingress at a host-aligned 4 MiB (below
// Vercel Functions' 4.5 MB request limit).
export const WELETIC_SHOPIFY_MAX_WEBHOOK_BODY_BYTES = 4 * 1024 * 1024;

interface SignatureInput {
  timestamp: string;
  method: string;
  path: string;
  body: string;
  secret: string;
}

export function createWeleticShopifyCanonicalRequest({
  timestamp,
  method,
  path,
  body,
}: Omit<SignatureInput, "secret">) {
  return `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}`;
}

export function signWeleticShopifyRequest(input: SignatureInput) {
  return crypto
    .createHmac("sha256", input.secret)
    .update(createWeleticShopifyCanonicalRequest(input))
    .digest("hex");
}

function getServiceSecret() {
  const secret = process.env.WELETIC_SHOPIFY_SERVICE_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "WELETIC_SHOPIFY_SERVICE_SECRET must be at least 32 characters",
    );
  }
  return secret;
}

export async function readWeleticShopifyRequestBodyBytes(
  request: Request,
  { maxBytes = WELETIC_SHOPIFY_MAX_BODY_BYTES }: { maxBytes?: number } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return null;
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      return null;
    }
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes < 0 ||
      declaredBytes > maxBytes
    ) {
      return null;
    }
  }

  if (!request.body) {
    return new Uint8Array();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }

    const body = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    reader.releaseLock();
  }
}

export async function readWeleticShopifyRequestBody(request: Request) {
  const body = await readWeleticShopifyRequestBodyBytes(request);
  return body === null ? null : new TextDecoder().decode(body);
}

export function verifyWeleticShopifyRequest({
  request,
  body,
  now = Date.now(),
  secret,
}: {
  request: Request;
  body: string;
  now?: number;
  secret?: string;
}) {
  const timestamp = request.headers.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER);
  const signature = request.headers.get(WELETIC_SHOPIFY_SIGNATURE_HEADER);

  if (!timestamp || !signature || !/^[a-f0-9]{64}$/.test(signature)) {
    return false;
  }

  const timestampMs = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(now - timestampMs) > WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS
  ) {
    return false;
  }

  const url = new URL(request.url);
  const expected = signWeleticShopifyRequest({
    timestamp,
    method: request.method,
    path: `${url.pathname}${url.search}`,
    body,
    secret: secret || getServiceSecret(),
  });

  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expected, "hex"),
  );
}
