import {
  assertPublicShopifyRuntime,
  PUBLIC_LOYALTY_API_ORIGIN,
  PUBLIC_LOYALTY_APP_ORIGIN,
  PUBLIC_LOYALTY_CLIENT_ID,
} from "../../packages/shopify-app/app/public-runtime-policy.mjs";

// Static admission only. Never contacts providers, starts a process or logs input.
const fail = () => {
  throw new Error("Unsafe Cloudflare public ingress configuration");
};

function environment(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.values(value).some((entry) => typeof entry !== "string")
  )
    fail();
  return value;
}

function secret(value) {
  if (typeof value !== "string" || value.trim().length < 32) fail();
  return value.trim();
}

export function assertCloudflareIngressPair(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).length !== 2 ||
    !Object.hasOwn(input, "web") ||
    !Object.hasOwn(input, "shopify")
  )
    fail();
  const web = environment(input.web);
  const shopify = environment(input.shopify);
  for (const env of [web, shopify]) {
    if (
      env.NODE_ENV !== "production" ||
      env.SHOPIFY_API_KEY !== PUBLIC_LOYALTY_CLIENT_ID ||
      env.SHOPIFY_APP_URL !== PUBLIC_LOYALTY_APP_ORIGIN ||
      (env.WELETIC_ISOLATED_DEVELOPMENT !== undefined &&
        env.WELETIC_ISOLATED_DEVELOPMENT !== "0") ||
      (env.NEXT_PUBLIC_WELETIC_ISOLATED_DEVELOPMENT !== undefined &&
        env.NEXT_PUBLIC_WELETIC_ISOLATED_DEVELOPMENT !== "0")
    )
      fail();
  }
  // The shared policy owns registration, scope and paired backend validation.
  // Explicit client checks above prevent its legacy/custom-app early return.
  try {
    assertPublicShopifyRuntime(shopify);
  } catch {
    fail();
  }
  if (
    web.WELETIC_ENFORCE_CRON_AUTH !== "1" ||
    !!web.DEV_WEBHOOK_URL ||
    web.NEXTAUTH_URL !== PUBLIC_LOYALTY_API_ORIGIN ||
    web.NEXT_PUBLIC_APP_DOMAIN !== PUBLIC_LOYALTY_API_ORIGIN ||
    web.SHOPIFY_WEBHOOK_URL !==
      `${PUBLIC_LOYALTY_API_ORIGIN}/api/shopify/integration/webhook`
  )
    fail();
  const service = secret(web.WELETIC_SHOPIFY_SERVICE_SECRET);
  // Web HMAC uses raw bytes; Shopify's requireEnv trims. Never normalize away
  // a web mismatch that would be rejected by the actual signed gateway.
  if (web.WELETIC_SHOPIFY_SERVICE_SECRET !== service) fail();
  if (service !== secret(shopify.WELETIC_SHOPIFY_SERVICE_SECRET)) fail();
  const independentSecrets = [
    service,
    secret(shopify.SHOPIFY_API_SECRET),
    secret(web.NEXTAUTH_SECRET),
    secret(web.CRON_SECRET),
  ];
  if (new Set(independentSecrets).size !== independentSecrets.length) fail();

  // A passing static check is never a launch-ready result. Service ownership,
  // actual secret provenance and live authentication require separate evidence.
  return Object.freeze({
    status: "static_ingress_checks_passed",
    deploymentAuthorized: false,
    servicesVerified: false,
    liveAcceptanceVerified: false,
  });
}
