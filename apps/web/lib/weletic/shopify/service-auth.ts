import {
  registerServiceAuthRedisProvider,
  createD1NonceClient,
  createPrismaNonceClient,
  type RedisSetClient,
} from "@weletic/contracts/shopify/service-auth";

registerServiceAuthRedisProvider(async (): Promise<RedisSetClient | null> => {
  // 1. Cloudflare D1 Native Database Binding (Cloudflare Worker environment)
  const d1 = (globalThis as any).DB;
  if (d1 && typeof d1.prepare === "function") {
    try {
      return createD1NonceClient(d1);
    } catch (err: any) {
      console.warn("[service-auth] Failed to initialize D1 nonce client:", err);
    }
  }

  // 2. Upstash Redis (if explicitly configured via env)
  if (process.env.UPSTASH_REDIS_REST_URL) {
    try {
      const mod = (await import("../../upstash/redis")) as {
        redis?: RedisSetClient;
      };
      if (mod?.redis) {
        return mod.redis;
      }
    } catch (err: any) {
      console.warn(
        "[service-auth] Failed to load Upstash Redis client:",
        err?.message || String(err),
      );
    }
  }

  // 3. Prisma ServiceAuthNonce Distributed Provider (Next.js Node.js runtime when D1/Redis absent)
  const globalPrisma = (globalThis as any).prisma;
  if (globalPrisma?.serviceAuthNonce) {
    try {
      return createPrismaNonceClient(globalPrisma);
    } catch (err: any) {
      console.warn(
        "[service-auth] Failed to initialize Prisma nonce client from globalThis:",
        err,
      );
    }
  }

  try {
    const { prisma } = (await import("../../prisma")) as {
      prisma?: { serviceAuthNonce?: any };
    };
    if (prisma?.serviceAuthNonce) {
      return createPrismaNonceClient(prisma as any);
    }
  } catch (err: any) {
    // Graceful fallback if dynamic prisma import is not resolvable
  }

  return null;
});

export * from "@weletic/contracts/shopify/service-auth";
