import {
  assertPublicShopifyRuntime,
  PUBLIC_LOYALTY_API_ORIGIN,
  PUBLIC_LOYALTY_APP_ORIGIN,
  PUBLIC_LOYALTY_CLIENT_ID,
} from "../../packages/shopify-app/app/public-runtime-policy.mjs";

const fail = () => {
  throw new Error("Cloudflare runtime admission rejected");
};
const secret = (value) => {
  if (typeof value !== "string" || value.trim().length < 32) fail();
  return value.trim();
};

// Each process receives only its own environment. Cross-process comparisons
// still require paired ingress preflight; never distribute the paired secrets.
export function assertCloudflareRuntime(role, env) {
  if (
    !["web", "shopify", "outbox"].includes(role) ||
    !env ||
    typeof env !== "object" ||
    Array.isArray(env) ||
    env.NODE_ENV !== "production" ||
    env.SHOPIFY_API_KEY !== PUBLIC_LOYALTY_CLIENT_ID ||
    env.SHOPIFY_APP_URL !== PUBLIC_LOYALTY_APP_ORIGIN
  )
    fail();
  if (env.WELETIC_SHOPIFY_BUILD_TARGET !== undefined) fail();
  if (env.WELETIC_WEB_BUILD_PROFILE !== undefined) fail();
  if (
    role === "outbox" &&
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(
      env.WELETIC_OUTBOX_STORE_DOMAIN ?? "",
    )
  )
    fail();
  for (const key of [
    "WELETIC_ISOLATED_DEVELOPMENT",
    "NEXT_PUBLIC_WELETIC_ISOLATED_DEVELOPMENT",
    "WELETIC_LOCAL_CONTAINER_BUILD",
  ]) {
    if (env[key] !== undefined && env[key] !== "0") fail();
  }
  const service = secret(env.WELETIC_SHOPIFY_SERVICE_SECRET);
  // Only a memory limit is supported. Preloads/loaders can change the admitted
  // environment before application code starts; debug flags expose the process.
  if (
    env.NODE_OPTIONS !== undefined &&
    !/^--max-old-space-size=[1-9][0-9]{0,4}$/.test(env.NODE_OPTIONS)
  )
    fail();
  if (role === "shopify") {
    try {
      assertPublicShopifyRuntime(env);
    } catch {
      fail();
    }
  } else {
    if (
      env.WELETIC_ENFORCE_CRON_AUTH !== "1" ||
      !!env.DEV_WEBHOOK_URL ||
      env.NEXTAUTH_URL !== PUBLIC_LOYALTY_API_ORIGIN ||
      env.NEXT_PUBLIC_APP_DOMAIN !== PUBLIC_LOYALTY_API_ORIGIN ||
      env.SHOPIFY_WEBHOOK_URL !==
        `${PUBLIC_LOYALTY_API_ORIGIN}/api/shopify/integration/webhook` ||
      env.WELETIC_SHOPIFY_SERVICE_SECRET !== service
    )
      fail();
    const secrets = [
      service,
      secret(env.NEXTAUTH_SECRET),
      secret(env.CRON_SECRET),
      secret(env.SHOPIFY_WEBHOOK_SECRET),
    ];
    if (env.SHOPIFY_WEBHOOK_SECRET !== secret(env.SHOPIFY_WEBHOOK_SECRET))
      fail();
    if (new Set(secrets).size !== secrets.length) fail();
  }
}
