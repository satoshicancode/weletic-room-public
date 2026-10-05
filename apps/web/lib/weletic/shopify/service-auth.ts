import {
  registerServiceAuthRedisProvider,
} from "@weletic/contracts/shopify/service-auth";

registerServiceAuthRedisProvider(async () => {
  try {
    const mod = (await import("../../upstash/redis")) as {
      redis?: import("@weletic/contracts/shopify/service-auth").RedisSetClient;
    };
    return mod?.redis ?? null;
  } catch (err: any) {
    console.warn(
      "[service-auth] Failed to load Upstash Redis client, falling back to in-memory nonce cache:",
      err?.message || String(err),
    );
    return null;
  }
});

export * from "@weletic/contracts/shopify/service-auth";
