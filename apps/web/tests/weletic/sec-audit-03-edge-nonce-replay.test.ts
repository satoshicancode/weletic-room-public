import {
  createD1NonceClient,
  createKVNonceClient,
  resetServiceAuthNonceCache,
  setServiceAuthRedisClient,
  verifyWeleticShopifyRequest,
  type D1DatabaseLike,
  type KVNamespaceLike,
} from "@weletic/contracts/shopify/service-auth";
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("SEC-AUDIT-03: Cloudflare Native Distributed Nonce Providers & Replay Protection", () => {
  const secret = "a".repeat(32);
  const now = Date.now();

  beforeEach(() => {
    resetServiceAuthNonceCache();
    setServiceAuthRedisClient(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("Cloudflare KV Nonce Client atomically blocks cross-instance replay", async () => {
    const kvStore = new Map<string, string>();
    const mockKV: KVNamespaceLike = {
      async get(key: string) {
        return kvStore.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kvStore.set(key, value);
      },
    };

    const kvClient = createKVNonceClient(mockKV);
    const nonce = `kv-nonce-${crypto.randomUUID()}`;

    // Attempt 1: New nonce succeeds
    const res1 = await kvClient.set(`test:${nonce}`, "1", {
      nx: true,
      ex: 720,
    });
    expect(res1).toBe("OK");

    // Attempt 2: Replay of same nonce on another node using shared KV is rejected
    const res2 = await kvClient.set(`test:${nonce}`, "1", {
      nx: true,
      ex: 720,
    });
    expect(res2).toBeNull();
  });

  it("Cloudflare D1 Nonce Client uses SQLite unique constraints to reject replay", async () => {
    const d1Table = new Map<string, number>();
    const mockD1: D1DatabaseLike = {
      prepare(_query: string) {
        return {
          bind(...values: unknown[]) {
            return {
              async run() {
                const [key, expiresAt] = values as [string, number];
                if (d1Table.has(key)) {
                  const err: any = new Error(
                    "UNIQUE constraint failed: ServiceAuthNonce.nonceKey",
                  );
                  throw err;
                }
                d1Table.set(key, expiresAt);
                return { success: true, meta: { changes: 1 } };
              },
              async first<T = unknown>() {
                const key = values[0] as string;
                const expiresAt = d1Table.get(key);
                return expiresAt ? ({ expiresAt } as T) : null;
              },
            };
          },
        };
      },
    };

    const d1Client = createD1NonceClient(mockD1);
    const nonce = `d1-nonce-${crypto.randomUUID()}`;

    // 1st attempt: Insert succeeds
    const res1 = await d1Client.set(`test:${nonce}`, "1", {
      nx: true,
      ex: 720,
    });
    expect(res1).toBe("OK");

    // 2nd attempt: Insert collides on UNIQUE constraint -> returns null
    const res2 = await d1Client.set(`test:${nonce}`, "1", {
      nx: true,
      ex: 720,
    });
    expect(res2).toBeNull();
  });

  it("In production (NODE_ENV=production), service auth fails closed when distributed store is down", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    vi.stubEnv("WELETIC_SERVICE_AUTH_REDIS_FAILURE_MODE", ""); // Unset in production

    setServiceAuthRedisClient(null); // No distributed client available

    const timestamp = String(now);
    const requestId = crypto.randomUUID();
    const signature = crypto
      .createHmac("sha256", secret)
      .update(`${timestamp}\nPOST\n/api/internal/test\n{}\n${requestId}`)
      .digest("hex");

    const req = new Request("https://internal.local/api/internal/test", {
      method: "POST",
      headers: {
        "x-weletic-timestamp": timestamp,
        "x-weletic-signature": signature,
        "x-weletic-request-id": requestId,
      },
      body: "{}",
    });

    // In production, must FAIL CLOSED (return false) rather than silently using in-memory cache
    const valid = await verifyWeleticShopifyRequest({
      request: req,
      body: "{}",
      now,
      secret,
    });

    expect(valid).toBe(false);
  });
});
