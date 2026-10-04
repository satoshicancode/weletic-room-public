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
export const WELETIC_SHOPIFY_NONCE_TTL_SECONDS = 720;
const NONCE_KEY_PREFIX = "weletic:service-auth:nonce:";

export interface SignatureInput {
  timestamp: string;
  method: string;
  path: string;
  body: string;
  secret: string;
  requestId?: string;
}

export function createWeleticShopifyCanonicalRequest({
  timestamp,
  method,
  path,
  body,
  requestId,
}: Omit<SignatureInput, "secret">) {
  if (requestId !== undefined && requestId !== "") {
    return `${timestamp}\n${method.toUpperCase()}\n${path}\n${body}\n${requestId}`;
  }
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
  request: Pick<Request, "headers" | "body">,
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

const inMemoryNonceCache = new Map<string, number>();

export interface RedisSetClient {
  set(
    key: string,
    value: string,
    opts?: { nx?: boolean; ex?: number },
  ): Promise<unknown>;
}

let cachedRedisClient: RedisSetClient | null | undefined = undefined;
let redisClientPromise: Promise<RedisSetClient | null> | null = null;

export function resetServiceAuthNonceCache(): void {
  inMemoryNonceCache.clear();
  cachedRedisClient = undefined;
  redisClientPromise = null;
}

function acquireMemoryNonce(
  requestId: string,
  now: number,
  ttlMs: number,
): boolean {
  if (inMemoryNonceCache.size > 5_000) {
    for (const [key, expiresAt] of inMemoryNonceCache.entries()) {
      if (expiresAt <= now) {
        inMemoryNonceCache.delete(key);
      }
    }
  }

  const existingExpiresAt = inMemoryNonceCache.get(requestId);
  if (existingExpiresAt !== undefined) {
    if (existingExpiresAt > now) {
      return false;
    }
    inMemoryNonceCache.delete(requestId);
  }

  inMemoryNonceCache.set(requestId, now + ttlMs);
  return true;
}

async function getRedisClient(): Promise<RedisSetClient | null> {
  if (cachedRedisClient !== undefined) {
    return cachedRedisClient;
  }
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      try {
        const mod = (await import("../../upstash/redis")) as {
          redis?: RedisSetClient;
        };
        return mod?.redis ?? null;
      } catch (err: any) {
        console.warn(
          "[service-auth] Failed to load Upstash Redis client, falling back to in-memory nonce cache:",
          err?.message || String(err),
        );
        return null;
      }
    })();
  }
  cachedRedisClient = await redisClientPromise;
  return cachedRedisClient;
}

async function verifyAndRecordNonce(
  requestId: string,
  now: number,
  ttlSeconds: number = WELETIC_SHOPIFY_NONCE_TTL_SECONDS,
): Promise<boolean> {
  const nonceKey = `${NONCE_KEY_PREFIX}${requestId}`;

  try {
    const redisClient = await getRedisClient();
    if (!redisClient) {
      if (process.env.WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE === "fail_closed") {
        return false;
      }
      console.warn(
        "[service-auth] Redis client unavailable, falling back to in-memory nonce cache...",
      );
      return acquireMemoryNonce(requestId, now, ttlSeconds * 1000);
    }

    const result = await redisClient.set(nonceKey, "1", {
      nx: true,
      ex: ttlSeconds,
    });
    if (result === "OK") {
      inMemoryNonceCache.set(requestId, now + ttlSeconds * 1000);
      return true;
    }
    return false;
  } catch (error) {
    if (process.env.WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE === "fail_closed") {
      return false;
    }
    console.warn(
      "[service-auth] Redis client unavailable, falling back to in-memory nonce cache...",
    );
    return acquireMemoryNonce(requestId, now, ttlSeconds * 1000);
  }
}

export async function verifyWeleticShopifyRequest({
  request,
  body,
  now = Date.now(),
  secret,
  requireRequestId,
}: {
  request: Request;
  body: string;
  now?: number;
  secret?: string;
  requireRequestId?: boolean;
}): Promise<boolean> {
  const timestamp = request.headers.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER);
  const signature = request.headers.get(WELETIC_SHOPIFY_SIGNATURE_HEADER);
  const requestId = request.headers.get(WELETIC_SHOPIFY_REQUEST_ID_HEADER);

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

  const isStrict =
    requireRequestId !== undefined
      ? requireRequestId
      : process.env.WELETIC_SERVICE_AUTH_REQUIRE_REQUEST_ID !== "false";

  if (!requestId) {
    if (isStrict) {
      return false;
    }
  } else if (!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
    return false;
  }

  const serviceSecret = secret || getServiceSecret();
  const url = new URL(request.url);
  const expected = signWeleticShopifyRequest({
    timestamp,
    method: request.method,
    path: `${url.pathname}${url.search}`,
    body,
    requestId: requestId || undefined,
    secret: serviceSecret,
  });

  const signatureBuffer = Buffer.from(signature, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return false;
  }

  if (requestId) {
    const dynamicTtlSeconds = Math.max(
      WELETIC_SHOPIFY_NONCE_TTL_SECONDS,
      Math.ceil((timestampMs + WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS - now) / 1000) + 60,
    );
    const isUnique = await verifyAndRecordNonce(requestId, now, dynamicTtlSeconds);
    if (!isUnique) {
      return false;
    }
  }

  return true;
}

