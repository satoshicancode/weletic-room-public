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

export function createWeleticShopifyServiceAuthHeaders({
  timestamp = String(Date.now()),
  method,
  path,
  body = "",
  secret,
  requestId = crypto.randomUUID(),
}: {
  timestamp?: string;
  method: string;
  path: string;
  body?: string;
  secret: string;
  requestId?: string;
}): Record<string, string> {
  const signature = signWeleticShopifyRequest({
    timestamp,
    method,
    path,
    body,
    secret,
    requestId,
  });
  return {
    [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
    [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
    [WELETIC_SHOPIFY_REQUEST_ID_HEADER]: requestId,
  };
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

export interface KVNamespaceLike {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

export interface D1DatabaseLike {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

/**
 * Creates a RedisSetClient adapter backed by Cloudflare KV.
 * @deprecated Cloudflare KV lacks atomic write-if-absent guarantees and exhibits eventual consistency lag (SEC-R1-05).
 * Use createD1NonceClient (Cloudflare D1), createPrismaNonceClient (Prisma SQLite), or Redis for atomic replay deduplication.
 */
export function createKVNonceClient(kv: KVNamespaceLike): RedisSetClient {
  return {
    async set(
      key: string,
      value: string,
      opts?: { nx?: boolean; ex?: number },
    ) {
      if (opts?.nx) {
        const existing = await kv.get(key);
        if (existing !== null) {
          return null; // Replay detected
        }
      }
      await kv.put(key, value, {
        expirationTtl: opts?.ex ?? WELETIC_SHOPIFY_NONCE_TTL_SECONDS,
      });
      return "OK";
    },
  };
}

export interface PrismaNonceClientLike {
  serviceAuthNonce: {
    // expiresAt is a BigInt column (epoch ms). Prisma accepts number | bigint on
    // write and returns bigint on read.
    create(args: {
      data: { nonceKey: string; expiresAt: number | bigint };
    }): Promise<unknown>;
    findUnique?(args: {
      where: { nonceKey: string };
    }): Promise<{ expiresAt: number | bigint } | null>;
    update?(args: {
      where: { nonceKey: string };
      data: { expiresAt: number | bigint };
    }): Promise<unknown>;
  };
}

/** Creates a RedisSetClient adapter backed by Prisma (model ServiceAuthNonce) */
export function createPrismaNonceClient(
  client: PrismaNonceClientLike,
): RedisSetClient {
  return {
    async set(
      key: string,
      value: string,
      opts?: { nx?: boolean; ex?: number },
    ) {
      const nowMs = Date.now();
      const expiresAt =
        nowMs + (opts?.ex ?? WELETIC_SHOPIFY_NONCE_TTL_SECONDS) * 1000;
      try {
        await client.serviceAuthNonce.create({
          data: { nonceKey: key, expiresAt },
        });
        return "OK";
      } catch (err: any) {
        const msg = String(err?.message || err);
        const isConstraint =
          err?.code === "P2002" ||
          msg.includes("UNIQUE") ||
          msg.includes("constraint") ||
          msg.includes("Unique constraint");
        if (isConstraint) {
          if (
            client.serviceAuthNonce.findUnique &&
            client.serviceAuthNonce.update
          ) {
            try {
              const existing = await client.serviceAuthNonce.findUnique({
                where: { nonceKey: key },
              });
              if (existing && existing.expiresAt <= nowMs) {
                await client.serviceAuthNonce.update({
                  where: { nonceKey: key },
                  data: { expiresAt },
                });
                return "OK";
              }
            } catch {
              // Fail closed on error
            }
          }
          return null; // Active nonce collision -> replay detected
        }
        throw err;
      }
    },
  };
}

/** Creates a RedisSetClient adapter backed by Cloudflare D1 (SQLite) */
export function createD1NonceClient(db: D1DatabaseLike): RedisSetClient {
  return {
    async set(
      key: string,
      value: string,
      opts?: { nx?: boolean; ex?: number },
    ) {
      const nowMs = Date.now();
      const expiresAt =
        nowMs + (opts?.ex ?? WELETIC_SHOPIFY_NONCE_TTL_SECONDS) * 1000;
      try {
        const stmt = db
          .prepare(
            "INSERT INTO ServiceAuthNonce (nonceKey, expiresAt) VALUES (?, ?)",
          )
          .bind(key, expiresAt);
        const res = await stmt.run();
        if (res.success && (res.meta?.changes ?? 1) > 0) {
          return "OK";
        }
        return null;
      } catch (err: any) {
        const msg = String(err?.message || err);
        if (msg.includes("UNIQUE") || msg.includes("constraint")) {
          // Check if previously recorded nonce has expired
          try {
            const row = await db
              .prepare(
                "SELECT expiresAt FROM ServiceAuthNonce WHERE nonceKey = ?",
              )
              .bind(key)
              .first<{ expiresAt: number }>();
            if (row && row.expiresAt <= nowMs) {
              await db
                .prepare(
                  "UPDATE ServiceAuthNonce SET expiresAt = ? WHERE nonceKey = ?",
                )
                .bind(expiresAt, key)
                .run();
              return "OK";
            }
          } catch {
            // In error, fail closed
          }
          return null; // Active nonce collision -> replay detected
        }
        throw err;
      }
    },
  };
}

export function isServiceAuthFailClosed(): boolean {
  const mode = process.env.WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE;
  if (mode === "fail_closed") return true;
  if (mode === "fallback_memory" || mode === "fail_open") return false;
  // In production, default to fail-closed
  return process.env.NODE_ENV === "production";
}

let explicitRedisClient: RedisSetClient | null | undefined = undefined;
let redisProvider: (() => Promise<RedisSetClient | null>) | null = null;
let cachedRedisClient: RedisSetClient | null | undefined = undefined;
let redisClientPromise: Promise<RedisSetClient | null> | null = null;

export function setServiceAuthRedisClient(client: RedisSetClient | null): void {
  explicitRedisClient = client;
  cachedRedisClient = client;
}

export function registerServiceAuthRedisProvider(
  provider: () => Promise<RedisSetClient | null>,
): void {
  redisProvider = provider;
}

export function resetServiceAuthNonceCache(): void {
  inMemoryNonceCache.clear();
  cachedRedisClient = explicitRedisClient;
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

async function getRedisClient(
  overrideClient?: RedisSetClient | null,
): Promise<RedisSetClient | null> {
  if (overrideClient !== undefined) {
    return overrideClient;
  }
  if (cachedRedisClient !== undefined) {
    return cachedRedisClient;
  }
  if (!redisClientPromise) {
    redisClientPromise = (async () => {
      try {
        if (redisProvider) {
          return await redisProvider();
        }
        return null;
      } catch (err: any) {
        console.warn(
          "[service-auth] Failed to load Redis client, falling back to in-memory nonce cache:",
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
  redisClientOverride?: RedisSetClient | null,
): Promise<boolean> {
  const nonceKey = `${NONCE_KEY_PREFIX}${requestId}`;

  try {
    const redisClient = await getRedisClient(redisClientOverride);
    if (!redisClient) {
      if (isServiceAuthFailClosed()) {
        console.warn(
          "[service-auth] Distributed nonce provider unavailable in fail-closed mode. Rejecting request to prevent replay attack.",
        );
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
    if (isServiceAuthFailClosed()) {
      console.warn(
        "[service-auth] Error accessing distributed nonce provider in fail-closed mode:",
        error instanceof Error ? error.message : String(error),
      );
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
  redisClient,
}: {
  request: Request | any;
  body: string;
  now?: number;
  secret?: string;
  requireRequestId?: boolean;
  redisClient?: RedisSetClient | null;
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
      Math.ceil(
        (timestampMs + WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS - now) / 1000,
      ) + 60,
    );
    const isUnique = await verifyAndRecordNonce(
      requestId,
      now,
      dynamicTtlSeconds,
      redisClient,
    );
    if (!isUnique) {
      return false;
    }
  }

  return true;
}

export async function verifyWeleticShopifyServiceAuthHeaders({
  headers,
  method,
  path,
  body,
  now = Date.now(),
  secret,
  requireRequestId,
  redisClient,
}: {
  headers: Headers | Record<string, string | undefined | null>;
  method: string;
  path: string;
  body: string;
  now?: number;
  secret?: string;
  requireRequestId?: boolean;
  redisClient?: RedisSetClient | null;
}): Promise<boolean> {
  const getHeader = (name: string): string | null => {
    if (typeof (headers as Headers).get === "function") {
      return (headers as Headers).get(name);
    }
    const rec = headers as Record<string, string | undefined | null>;
    return rec[name] ?? rec[name.toLowerCase()] ?? null;
  };

  const reqHeaders = new Headers();
  const timestamp = getHeader(WELETIC_SHOPIFY_TIMESTAMP_HEADER);
  const signature = getHeader(WELETIC_SHOPIFY_SIGNATURE_HEADER);
  const requestId = getHeader(WELETIC_SHOPIFY_REQUEST_ID_HEADER);

  if (timestamp) reqHeaders.set(WELETIC_SHOPIFY_TIMESTAMP_HEADER, timestamp);
  if (signature) reqHeaders.set(WELETIC_SHOPIFY_SIGNATURE_HEADER, signature);
  if (requestId) reqHeaders.set(WELETIC_SHOPIFY_REQUEST_ID_HEADER, requestId);

  const request = new Request(`https://internal-service.local${path}`, {
    method,
    headers: reqHeaders,
    body:
      method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD"
        ? body
        : undefined,
  });

  return verifyWeleticShopifyRequest({
    request,
    body,
    now,
    secret,
    requireRequestId,
    redisClient,
  });
}
