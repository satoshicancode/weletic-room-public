export const RESTRICTED_DEVELOPMENT = Object.freeze({
  appId: "c7d49cebb06e445db345bb200f966a03",
  partnerAppId: "gid://shopify/App/419628580865",
  shopId: "gid://shopify/Shop/73236414690",
  shop: "montdev.myshopify.com",
});
export const RESTRICTED_KEYS = [
  "WELETIC_RESTRICTED_DEVELOPMENT",
  "WELETIC_RESTRICTED_DEVELOPMENT_GENERATION",
];
export function hasRestrictedDevelopmentConfiguration(env) {
  return RESTRICTED_KEYS.some((key) => env[key] !== undefined);
}
export function isRestrictedDevelopmentEnvironment(env) {
  if (
    env.WELETIC_RESTRICTED_DEVELOPMENT !== "yamaxdev-v1" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      env.WELETIC_RESTRICTED_DEVELOPMENT_GENERATION ?? "",
    ) ||
    env.NODE_ENV !== "development" ||
    env.WELETIC_ISOLATED_DEVELOPMENT !== "1" ||
    env.WELETIC_FEATURE_PROFILE !== "core-v1" ||
    env.WELETIC_SETUP_ONLY !== undefined ||
    env.SHOPIFY_API_KEY !== RESTRICTED_DEVELOPMENT.appId ||
    env.SHOPIFY_PARTNER_APP_ID !== RESTRICTED_DEVELOPMENT.partnerAppId
  )
    return false;
  return [
    "DATABASE_URL",
    "PLANETSCALE_DATABASE_URL",
    "UPSTASH_REDIS_REST_URL",
    "STORAGE_ENDPOINT",
  ].every((key) => {
    try {
      const url = new URL(env[key]);
      return (
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
        (key === "DATABASE_URL"
          ? url.protocol === "mysql:"
          : url.protocol === "http:")
      );
    } catch {
      return false;
    }
  });
}
