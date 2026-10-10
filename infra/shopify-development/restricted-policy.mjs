export function getRestrictedDevelopmentConfig(env = process.env) {
  const shop = (
    env.WELETIC_RESTRICTED_DEV_SHOP ||
    env.SHOPIFY_RESTRICTED_DEV_STORES ||
    ""
  ).trim();
  const appId = (
    env.WELETIC_RESTRICTED_DEV_APP_ID ||
    env.SHOPIFY_API_KEY ||
    ""
  ).trim();
  const partnerAppId = (
    env.WELETIC_RESTRICTED_DEV_PARTNER_APP_ID ||
    env.SHOPIFY_PARTNER_APP_ID ||
    ""
  ).trim();
  const shopId = (env.WELETIC_RESTRICTED_DEV_SHOP_ID || "").trim();

  return Object.freeze({
    appId,
    partnerAppId,
    shopId,
    shop,
  });
}

export function getRestrictedDevelopmentStores(env = process.env) {
  const raw =
    env.SHOPIFY_RESTRICTED_DEV_STORES ||
    env.WELETIC_RESTRICTED_DEV_SHOP ||
    "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Dynamic proxy providing zero-hardcoding backwards compatibility */
export const RESTRICTED_DEVELOPMENT = new Proxy(
  {},
  {
    get(_target, prop) {
      const config = getRestrictedDevelopmentConfig(process.env);
      return config[prop];
    },
  },
);

export const RESTRICTED_KEYS = [
  "WELETIC_RESTRICTED_DEVELOPMENT",
  "WELETIC_RESTRICTED_DEVELOPMENT_GENERATION",
  "WELETIC_RESTRICTED_DEV_SHOP",
  "SHOPIFY_RESTRICTED_DEV_STORES",
  "WELETIC_RESTRICTED_DEV_SHOP_ID",
  "WELETIC_RESTRICTED_DEV_APP_ID",
  "WELETIC_RESTRICTED_DEV_PARTNER_APP_ID",
];

export function hasRestrictedDevelopmentConfiguration(env = process.env) {
  return RESTRICTED_KEYS.some((key) => env[key] !== undefined);
}

export function isRestrictedDevelopmentEnvironment(env = process.env) {
  const cfg = getRestrictedDevelopmentConfig(env);
  const targetDevStore =
    env.WELETIC_RESTRICTED_DEV_STORE ??
    process.env.WELETIC_RESTRICTED_DEV_STORE ??
    "dev-store";
  const matchesRestrictedDevelopment =
    env.WELETIC_RESTRICTED_DEVELOPMENT === targetDevStore ||
    env.WELETIC_RESTRICTED_DEVELOPMENT === `${targetDevStore}-v1` ||
    (!env.WELETIC_RESTRICTED_DEV_STORE &&
      !process.env.WELETIC_RESTRICTED_DEV_STORE &&
      env.WELETIC_RESTRICTED_DEVELOPMENT === "yamaxdev-v1");

  if (
    !matchesRestrictedDevelopment ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      env.WELETIC_RESTRICTED_DEVELOPMENT_GENERATION ?? "",
    ) ||
    env.NODE_ENV !== "development" ||
    env.WELETIC_ISOLATED_DEVELOPMENT !== "1" ||
    env.WELETIC_FEATURE_PROFILE !== "core-v1" ||
    env.WELETIC_SETUP_ONLY !== undefined ||
    !cfg.appId ||
    !cfg.partnerAppId ||
    env.SHOPIFY_API_KEY !== cfg.appId ||
    env.SHOPIFY_PARTNER_APP_ID !== cfg.partnerAppId
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
