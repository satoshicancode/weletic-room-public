import {
  PUBLIC_LOYALTY_API_ORIGIN,
  PUBLIC_LOYALTY_APP_ORIGIN,
  PUBLIC_LOYALTY_CLIENT_ID,
} from "../../../../../packages/shopify-app/app/public-runtime-policy.mjs";

type Environment = Readonly<Record<string, string | undefined>>;
const callback = `${PUBLIC_LOYALTY_API_ORIGIN}/api/shopify/integration/webhook`;
const publicHosts = new Set([
  new URL(PUBLIC_LOYALTY_API_ORIGIN).hostname,
  new URL(PUBLIC_LOYALTY_APP_ORIGIN).hostname,
]);

function hasPublicHost(value: string | undefined) {
  try {
    return publicHosts.has(new URL(value || "").hostname.replace(/\.+$/, ""));
  } catch {
    return false;
  }
}

/** Null preserves legacy routing; a public target never uses legacy fallbacks. */
export function resolvePublicShopifyWebhookCallback(
  env: Environment,
  explicitCallback?: string,
): string | null {
  const publicContext =
    env.SHOPIFY_API_KEY?.trim() === PUBLIC_LOYALTY_CLIENT_ID ||
    [
      env.SHOPIFY_APP_URL,
      env.SHOPIFY_WEBHOOK_URL,
      env.NEXT_PUBLIC_APP_DOMAIN,
      env.DEV_WEBHOOK_URL,
      explicitCallback,
    ].some(hasPublicHost);
  if (!publicContext) return null;

  if (
    env.SHOPIFY_API_KEY !== PUBLIC_LOYALTY_CLIENT_ID ||
    env.SHOPIFY_APP_URL !== PUBLIC_LOYALTY_APP_ORIGIN ||
    env.NEXT_PUBLIC_APP_DOMAIN !== PUBLIC_LOYALTY_API_ORIGIN ||
    env.SHOPIFY_WEBHOOK_URL !== callback ||
    (explicitCallback !== undefined && explicitCallback !== callback) ||
    !!env.DEV_WEBHOOK_URL ||
    (!!env.WELETIC_ISOLATED_DEVELOPMENT &&
      env.WELETIC_ISOLATED_DEVELOPMENT !== "0")
  ) {
    // Provisioning must stop before GraphQL. Never echo a URL or secret.
    throw new Error("Unsafe public Shopify webhook configuration");
  }
  return callback;
}
