// Pure configuration checks. No SDK, filesystem, network or secret logging.
export const PUBLIC_LOYALTY_CLIENT_ID = "c7d49cebb06e445db345bb200f966a03";
export const PUBLIC_LOYALTY_SCOPES = Object.freeze([
  "read_products",
  "read_markets",
  "read_orders",
  "read_translations",
  "write_discounts",
  "write_customers",
  "write_app_proxy",
]);
export const PUBLIC_LOYALTY_APP_ORIGIN =
  "https://loyalty-shopify-dev.weletic.com";
export const PUBLIC_LOYALTY_API_ORIGIN = "https://loyalty-api-dev.weletic.com";

/** @param {string | undefined} configured */
export function hasPublicLoyaltyScopes(configured) {
  // The SDK resolver preserves explicit entries; do not validate a normalized
  // list that differs from the actual permissions passed to Shopify.
  const scopes = configured?.split(",") ?? [];
  return (
    scopes.length === PUBLIC_LOYALTY_SCOPES.length &&
    PUBLIC_LOYALTY_SCOPES.every((scope) => scopes.includes(scope))
  );
}

/** @param {string | undefined} value */
function isPublicOrigin(value) {
  try {
    const url = new URL(value || "");
    return [
      new URL(PUBLIC_LOYALTY_APP_ORIGIN).hostname,
      new URL(PUBLIC_LOYALTY_API_ORIGIN).hostname,
    ].includes(url.hostname.replace(/\.+$/, ""));
  } catch {
    return false;
  }
}

/**
 * The registered identity OR a reserved public endpoint selects this policy.
 * There is no opt-out flag that can downgrade a public app to legacy defaults.
 * Loopback execution remains possible only through the explicit isolated mode.
 * Backend namespace and retained-secret comparison are the paired launcher's
 * responsibility; these checks alone are not deployment or installation proof.
 * @param {Readonly<Record<string, string | undefined>>} env
 */
export function assertPublicShopifyRuntime(env) {
  if (
    env.SHOPIFY_API_KEY?.trim() !== PUBLIC_LOYALTY_CLIENT_ID &&
    !isPublicOrigin(env.SHOPIFY_APP_URL) &&
    !isPublicOrigin(env.WELETIC_API_URL)
  )
    return;

  const isolated = env.WELETIC_ISOLATED_DEVELOPMENT === "1";
  const appUrl = isolated ? "http://127.0.0.1:3002" : PUBLIC_LOYALTY_APP_ORIGIN;
  const apiUrl = isolated
    ? "http://app.localhost:8890"
    : PUBLIC_LOYALTY_API_ORIGIN;
  // Match requireEnv's effective values, not padded input representations.
  const appSecret = env.SHOPIFY_API_SECRET?.trim() || "";
  const serviceSecret = env.WELETIC_SHOPIFY_SERVICE_SECRET?.trim() || "";
  if (
    env.SHOPIFY_API_KEY !== PUBLIC_LOYALTY_CLIENT_ID ||
    env.SHOPIFY_APP_DISTRIBUTION !== "app_store" ||
    !hasPublicLoyaltyScopes(env.SCOPES) ||
    env.SHOPIFY_APP_URL !== appUrl ||
    env.WELETIC_API_URL !== apiUrl ||
    (isolated && (env.NODE_ENV !== "development" || env.PORT !== "3002")) ||
    (!isolated &&
      !!env.WELETIC_ISOLATED_DEVELOPMENT &&
      env.WELETIC_ISOLATED_DEVELOPMENT !== "0") ||
    appSecret.length < 32 ||
    serviceSecret.length < 32 ||
    appSecret === serviceSecret
  ) {
    // Never include the failed value, URL userinfo or a credential in this error.
    throw new Error("Unsafe public Shopify runtime configuration");
  }
}
