import { isLocalServiceTarget } from "./verify.mjs";

const WEB_KEYS = [
  "DATABASE_URL",
  "PLANETSCALE_DATABASE_URL",
  "ENCRYPTION_KEY",
  "NEXTAUTH_SECRET",
  "CRON_SECRET",
  "WELETIC_SHOPIFY_SERVICE_SECRET",
  "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
  "SHOPIFY_WEBHOOK_SECRET",
  "NEXTAUTH_URL",
  "NEXT_PUBLIC_APP_DOMAIN",
  "SHOPIFY_APP_URL",
  "SHOPIFY_WEBHOOK_URL",
  "WELETIC_ENFORCE_CRON_AUTH",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "STORAGE_ENDPOINT",
  "STORAGE_BASE_URL",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_SECRET_ACCESS_KEY",
  "STORAGE_PRIVATE_BUCKET",
  "STORAGE_PUBLIC_BUCKET",
];
const SHOPIFY_KEYS = [
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_DISTRIBUTION",
  "SHOPIFY_APP_URL",
  "WELETIC_API_URL",
  "WELETIC_SHOPIFY_SERVICE_SECRET",
  "PORT",
  "SCOPES",
];
// Empty disabled fields may exist in the generated files. Nonempty unknown
// fields (including delivery credentials) must be explicitly reviewed first.
function pickConfiguration(source, keys) {
  if (
    Object.entries(source).some(([key, value]) => value && !keys.includes(key))
  ) {
    throw new Error("Unreviewed runtime configuration");
  }
  return Object.fromEntries(keys.map((key) => [key, source[key] || ""]));
}

/** @returns {Record<string, string>} */
export function buildRuntimeEnvironment(app, web, shopify, ambient) {
  if (
    !["web", "shopify"].includes(app) ||
    !isLocalServiceTarget(web) ||
    web.NEXTAUTH_URL !== "http://app.localhost:8890" ||
    web.NEXT_PUBLIC_APP_DOMAIN !== web.NEXTAUTH_URL ||
    shopify.WELETIC_API_URL !== web.NEXTAUTH_URL ||
    web.SHOPIFY_APP_URL !== "http://127.0.0.1:3002" ||
    shopify.SHOPIFY_APP_URL !== web.SHOPIFY_APP_URL ||
    shopify.PORT !== "3002" ||
    shopify.SHOPIFY_API_KEY !== "c7d49cebb06e445db345bb200f966a03" ||
    web.WELETIC_ENFORCE_CRON_AUTH !== "1"
  )
    throw new Error("Unsafe runtime target");
  const webConfig = pickConfiguration(web, WEB_KEYS);
  const shopifyConfig = pickConfiguration(shopify, SHOPIFY_KEYS);
  const privacy = webConfig.WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS;
  if (
    !/^loyalty-dev-v1:[A-Za-z0-9+/]{43}=$/.test(privacy) ||
    Buffer.from(privacy.split(":")[1], "base64").toString("base64") !==
      privacy.split(":")[1]
  )
    throw new Error(
      "Isolated Shopify privacy key is missing or invalid; never rotate an existing key implicitly",
    );
  // Never inherit NODE_OPTIONS, cloud credentials, delivery configuration or
  // public URL overrides. HOME/PATH are trusted local OS facilities, not an
  // assertion that the machine itself is sandboxed against hostile processes.
  const os = Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "LANG", "TZ"]
      .filter((key) => ambient[key])
      .map((key) => [key, ambient[key]]),
  );
  return {
    ...os,
    ...(app === "web" ? webConfig : shopifyConfig),
    NODE_ENV: "development",
    NODE_OPTIONS: "--max-old-space-size=8192",
    NEXT_TELEMETRY_DISABLED: "1",
    SHOPIFY_CLI_NO_ANALYTICS: "1",
    WELETIC_ISOLATED_DEVELOPMENT: "1",
    ...(app === "web"
      ? {
          // One reviewed Shopify app identity for both halves of the signed
          // session boundary. Never inherit an ambient app key.
          SHOPIFY_API_KEY: shopifyConfig.SHOPIFY_API_KEY,
          NEXT_DIST_DIR: ".next-dev",
          NEXT_PUBLIC_API_DOMAIN: "http://api.localhost:8890",
          NEXT_PUBLIC_PARTNERS_DOMAIN: "http://partners.localhost:8890",
          NEXT_PUBLIC_ADMIN_DOMAIN: "http://admin.localhost:8890",
          NEXT_PUBLIC_WELETIC_ISOLATED_DEVELOPMENT: "1",
        }
      : {}),
  };
}

export function runtimeArguments(app) {
  if (app === "web")
    return ["dev", "--turbopack", "--hostname", "127.0.0.1", "--port", "8890"];
  if (app === "shopify")
    return [
      "vite:dev",
      "--host",
      "127.0.0.1",
      "--port",
      "3002",
      "--strictPort",
    ];
  throw new Error("Unknown application");
}

/** Redact complete lines so a credential split across chunks cannot leak. */
export function createRuntimeLogSink(environments, emit) {
  const secrets = new Set();
  for (const environment of environments) {
    for (const [key, value] of Object.entries(environment)) {
      if (!value) continue;
      if (
        /(SECRET|TOKEN|PASSWORD|ENCRYPTION_KEY|ACCESS_KEY|HMAC_KEYS)/.test(key)
      )
        secrets.add(value);
      try {
        const url = new URL(value);
        if (url.password) {
          secrets.add(value);
          secrets.add(url.password);
          secrets.add(decodeURIComponent(url.password));
        }
      } catch {
        /* Most configuration values are not URLs. */
      }
    }
  }
  const values = [...secrets]
    .filter((value) => value.length >= 8)
    .sort((a, b) => b.length - a.length);
  const redact = (line) => {
    let safe = line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    for (const value of values) safe = safe.replaceAll(value, "[REDACTED]");
    return safe;
  };
  let pending = "";
  let discarded = false;
  return {
    write(chunk) {
      for (const [index, part] of chunk
        .toString("utf8")
        .split("\n")
        .entries()) {
        if (index > 0) {
          emit(
            discarded
              ? "[Oversize runtime log line omitted]\n"
              : `${redact(pending)}\n`,
          );
          pending = "";
          discarded = false;
        }
        if (!discarded) {
          pending += part;
          if (pending.length > 65536) {
            pending = "";
            discarded = true;
          }
        }
      }
    },
    end() {
      if (discarded) emit("[Oversize runtime log line omitted]\n");
      else if (pending) emit(redact(pending));
      pending = "";
      discarded = false;
    },
  };
}
