// Offline checks only: this module never imports a database, transport or SDK.
export {
  PUBLIC_LOYALTY_CLIENT_ID as DEVELOPMENT_SHOPIFY_CLIENT_ID,
  PUBLIC_LOYALTY_SCOPES as DEVELOPMENT_SHOPIFY_SCOPES,
} from "../../../../../packages/shopify-app/app/public-runtime-policy.mjs";
import {
  PUBLIC_LOYALTY_CLIENT_ID as DEVELOPMENT_SHOPIFY_CLIENT_ID,
  hasPublicLoyaltyScopes,
} from "../../../../../packages/shopify-app/app/public-runtime-policy.mjs";

type Environment = Readonly<Record<string, string | undefined>>;

export interface DevelopmentEnvironmentFiles {
  web: Environment;
  shopify: Environment;
  retainedWeb: Environment;
  retainedShopify: Environment;
}

function url(value: string | undefined) {
  try {
    return value ? new URL(value) : null;
  } catch {
    return null;
  }
}

function host(value: URL) {
  return ["localhost", "127.0.0.1", "[::1]", "app.localhost"].includes(
    value.hostname,
  )
    ? "loopback"
    : value.hostname;
}

function endpoint(value: string | undefined) {
  const parsed = url(value);
  return parsed
    ? `${parsed.protocol}//${host(parsed)}:${parsed.port}${parsed.pathname.replace(/\/$/, "")}`
    : null;
}

function localHttp(value: string | undefined, allowCredentials = false) {
  const parsed = url(value);
  return !!(
    parsed &&
    parsed.protocol === "http:" &&
    host(parsed) === "loopback" &&
    parsed.port &&
    (allowCredentials || (!parsed.username && !parsed.password)) &&
    !parsed.search &&
    !parsed.hash
  );
}

function encryptionKey(value: string | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[a-f0-9]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) return null;
  const bytes = Buffer.from(trimmed, "base64");
  return bytes.length === 32 ? bytes.toString("hex") : null;
}

/** Reports fixed check IDs, never environment values, URLs or credentials. */
export function checkDevelopmentEnvironment({
  web,
  shopify,
  retainedWeb,
  retainedShopify,
}: DevelopmentEnvironmentFiles) {
  const checks: Array<{ id: string; passed: boolean }> = [];
  const check = (id: string, passed: boolean) => checks.push({ id, passed });
  const retained = [retainedWeb, retainedShopify];
  const freshSecret = (value: string | undefined) =>
    !!value &&
    value.length >= 32 &&
    !/replace|change.?me|example|placeholder|\$\{/i.test(value) &&
    !retained.some((env) => Object.values(env).includes(value));

  check(
    "retained_baseline_present",
    !!retainedWeb.DATABASE_URL &&
      !!retainedWeb.UPSTASH_REDIS_REST_URL &&
      !!retainedWeb.STORAGE_PRIVATE_BUCKET &&
      !!retainedShopify.SHOPIFY_API_KEY &&
      !!retainedShopify.SHOPIFY_API_SECRET &&
      [
        "ENCRYPTION_KEY",
        "NEXTAUTH_SECRET",
        "CRON_SECRET",
        "WELETIC_SHOPIFY_SERVICE_SECRET",
      ].every((key) => !!retainedWeb[key]),
  );
  check(
    "separate_registered_app",
    shopify.SHOPIFY_API_KEY === DEVELOPMENT_SHOPIFY_CLIENT_ID &&
      shopify.SHOPIFY_API_KEY !== retainedShopify.SHOPIFY_API_KEY &&
      shopify.SHOPIFY_APP_DISTRIBUTION === "app_store",
  );
  check(
    "app_secret_and_webhook_authority",
    freshSecret(shopify.SHOPIFY_API_SECRET) &&
      web.SHOPIFY_WEBHOOK_SECRET === shopify.SHOPIFY_API_SECRET,
  );
  check(
    "separate_service_authority",
    freshSecret(web.WELETIC_SHOPIFY_SERVICE_SECRET) &&
      web.WELETIC_SHOPIFY_SERVICE_SECRET ===
        shopify.WELETIC_SHOPIFY_SERVICE_SECRET &&
      web.WELETIC_SHOPIFY_SERVICE_SECRET !== shopify.SHOPIFY_API_SECRET,
  );
  for (const key of ["NEXTAUTH_SECRET", "CRON_SECRET"]) {
    check(`separate_${key.toLowerCase()}`, freshSecret(web[key]));
  }
  check(
    "separate_encryption_key",
    !!encryptionKey(web.ENCRYPTION_KEY) &&
      !!encryptionKey(retainedWeb.ENCRYPTION_KEY) &&
      encryptionKey(web.ENCRYPTION_KEY) !==
        encryptionKey(retainedWeb.ENCRYPTION_KEY),
  );

  const database = url(web.DATABASE_URL);
  check(
    "dedicated_local_database",
    !!database &&
      database.protocol === "mysql:" &&
      host(database) === "loopback" &&
      /^\/weletic_loyalty_dev[a-z0-9_]*$/.test(database.pathname) &&
      !!database.username &&
      database.username !== "root" &&
      /^[a-zA-Z0-9_]+$/.test(database.username) &&
      !!database.password &&
      !database.search &&
      !database.hash &&
      endpoint(web.DATABASE_URL) !== endpoint(retainedWeb.DATABASE_URL) &&
      database.username !== url(retainedWeb.DATABASE_URL)?.username,
  );
  check(
    "dedicated_edge_database_proxy",
    localHttp(web.PLANETSCALE_DATABASE_URL, true) &&
      !!url(web.PLANETSCALE_DATABASE_URL)?.username &&
      !!url(web.PLANETSCALE_DATABASE_URL)?.password &&
      url(web.PLANETSCALE_DATABASE_URL)?.pathname === database?.pathname &&
      endpoint(web.PLANETSCALE_DATABASE_URL) !==
        endpoint(retainedWeb.PLANETSCALE_DATABASE_URL),
  );
  const redis = endpoint(web.UPSTASH_REDIS_REST_URL);
  check(
    "dedicated_local_redis",
    localHttp(web.UPSTASH_REDIS_REST_URL) &&
      freshSecret(web.UPSTASH_REDIS_REST_TOKEN) &&
      ![
        retainedWeb.UPSTASH_REDIS_REST_URL,
        retainedWeb.UPSTASH_GLOBAL_REDIS_REST_URL,
      ].some((value) => endpoint(value) === redis) &&
      !web.UPSTASH_GLOBAL_REDIS_REST_URL &&
      !web.UPSTASH_GLOBAL_REDIS_REST_TOKEN,
  );
  check(
    "dedicated_local_media",
    localHttp(web.STORAGE_ENDPOINT) &&
      !!web.STORAGE_ACCESS_KEY_ID &&
      freshSecret(web.STORAGE_SECRET_ACCESS_KEY) &&
      !!web.STORAGE_PRIVATE_BUCKET &&
      !!web.STORAGE_PUBLIC_BUCKET &&
      web.STORAGE_PRIVATE_BUCKET !== web.STORAGE_PUBLIC_BUCKET &&
      [web.STORAGE_PRIVATE_BUCKET, web.STORAGE_PUBLIC_BUCKET].every(
        (bucket) =>
          ![
            retainedWeb.STORAGE_PRIVATE_BUCKET,
            retainedWeb.STORAGE_PUBLIC_BUCKET,
          ].includes(bucket),
      ) &&
      endpoint(web.STORAGE_ENDPOINT) !==
        endpoint(retainedWeb.STORAGE_ENDPOINT) &&
      localHttp(web.STORAGE_BASE_URL) &&
      url(web.STORAGE_BASE_URL)?.origin === url(web.STORAGE_ENDPOINT)?.origin,
  );

  check(
    "loopback_service_urls",
    [
      web.NEXTAUTH_URL,
      web.SHOPIFY_APP_URL,
      shopify.SHOPIFY_APP_URL,
      shopify.WELETIC_API_URL,
    ].every((value) => localHttp(value) && url(value)?.pathname === "/") &&
      localHttp(web.SHOPIFY_WEBHOOK_URL) &&
      shopify.PORT === url(shopify.SHOPIFY_APP_URL)?.port &&
      shopify.PORT !== (retainedShopify.PORT || "3000") &&
      endpoint(web.SHOPIFY_APP_URL) === endpoint(shopify.SHOPIFY_APP_URL) &&
      endpoint(web.NEXTAUTH_URL) === endpoint(shopify.WELETIC_API_URL) &&
      url(web.NEXTAUTH_URL)?.port !== url(shopify.SHOPIFY_APP_URL)?.port &&
      url(web.SHOPIFY_WEBHOOK_URL)?.origin === url(web.NEXTAUTH_URL)?.origin &&
      url(web.SHOPIFY_WEBHOOK_URL)?.pathname ===
        "/api/shopify/integration/webhook" &&
      ![retainedWeb.NEXTAUTH_URL, retainedShopify.WELETIC_API_URL].some(
        (value) => endpoint(value) === endpoint(web.NEXTAUTH_URL),
      ) &&
      ![retainedWeb.SHOPIFY_APP_URL, retainedShopify.SHOPIFY_APP_URL].some(
        (value) => endpoint(value) === endpoint(shopify.SHOPIFY_APP_URL),
      ),
  );
  check(
    "local_customer_origin",
    localHttp(web.NEXT_PUBLIC_APP_DOMAIN) &&
      url(web.NEXT_PUBLIC_APP_DOMAIN)?.pathname === "/" &&
      url(web.NEXT_PUBLIC_APP_DOMAIN)?.origin === url(web.NEXTAUTH_URL)?.origin,
  );
  check("reviewed_scope_inventory", hasPublicLoyaltyScopes(shopify.SCOPES));
  check("cron_auth_enforced", web.WELETIC_ENFORCE_CRON_AUTH === "1");
  check(
    "email_and_scheduler_delivery_disabled",
    [web, shopify].every((env) =>
      [
        "RESEND_API_KEY",
        "SMTP_HOST",
        "SMTP_USER",
        "SMTP_PASSWORD",
        "QSTASH_TOKEN",
        "QSTASH_CURRENT_SIGNING_KEY",
        "QSTASH_NEXT_SIGNING_KEY",
        "CLOUDFLARE_TUNNEL_TOKEN",
        "CLOUDFLARE_TUNNEL_NAME",
      ].every((key) => !env[key]),
    ),
  );
  return {
    status: checks.every(({ passed }) => passed)
      ? "configuration_consistent"
      : "blocked",
    liveReady: false,
    checks,
  };
}
