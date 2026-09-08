import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const databaseName = "weletic_loyalty_dev";
export const buckets = [
  "weletic-loyalty-dev-private",
  "weletic-loyalty-dev-public",
];
export const secretDirectory = ".env.loyalty-secrets.local";
export const hasRetainedEnvironment = (root) =>
  ["", "apps/web", "packages/shopify-app"].some((directory) =>
    [
      ".env",
      ".env.local",
      ".env.development",
      ".env.development.local",
      ".env.production",
      ".env.production.local",
    ].some((name) => existsSync(join(root, directory, name))),
  );

/** Generate new local credentials only. Never rotate or overwrite existing files. */
export function initializeLocalServices(root) {
  const directory = join(root, secretDirectory);
  const webPath = join(root, "apps/web/.env.loyalty.local");
  const shopifyPath = join(root, "packages/shopify-app/.env.loyalty.local");
  if ([directory, webPath, shopifyPath].some(existsSync)) {
    throw new Error(
      "Local configuration already exists; automatic rotation is refused.",
    );
  }
  if (
    !existsSync(join(root, "apps/web/package.json")) ||
    !existsSync(join(root, "packages/shopify-app/package.json")) ||
    hasRetainedEnvironment(root)
  ) {
    throw new Error("Run from the separate Weletic development checkout.");
  }
  mkdirSync(directory, { mode: 0o700 });
  const secret = () => randomBytes(32).toString("hex");
  const databasePassword = secret();
  const redisToken = secret();
  const mediaAccessKey = `loyalty_${randomBytes(8).toString("hex")}`;
  const mediaSecret = secret();
  const serviceSecret = secret();
  const writeSecret = (path, value) =>
    writeFileSync(path, value, { mode: 0o600, flag: "wx" });
  writeSecret(join(directory, "mysql-root"), secret());
  writeSecret(join(directory, "mysql-app"), databasePassword);
  writeSecret(
    join(directory, "redis-tokens.json"),
    JSON.stringify({
      [redisToken]: {
        srh_id: "weletic-loyalty-dev",
        connection_string: "redis://redis:6379",
        max_connections: 3,
      },
    }),
  );
  const mediaAdmin = {
    accessKey: `bootstrap_${randomBytes(8).toString("hex")}`,
    secretKey: secret(),
  };
  writeSecret(join(directory, "s3-admin.json"), JSON.stringify(mediaAdmin));
  writeSecret(
    join(directory, "s3-config.json"),
    JSON.stringify({
      identities: [
        {
          name: "weletic-local-bootstrap",
          credentials: [mediaAdmin],
          actions: ["Admin", "Read", "Write", "List", "Tagging"],
        },
        {
          name: "weletic-local-runtime",
          credentials: [{ accessKey: mediaAccessKey, secretKey: mediaSecret }],
          actions: buckets.flatMap((bucket) =>
            ["Read", "Write", "List", "Tagging"].map(
              (action) => `${action}:${bucket}`,
            ),
          ),
        },
      ],
    }),
  );
  const web = {
    DATABASE_URL: `mysql://loyalty_dev:${databasePassword}@127.0.0.1:3307/${databaseName}`,
    PLANETSCALE_DATABASE_URL: `http://loyalty_dev:${databasePassword}@127.0.0.1:3902/${databaseName}`,
    ENCRYPTION_KEY: secret(),
    NEXTAUTH_SECRET: secret(),
    CRON_SECRET: secret(),
    WELETIC_SHOPIFY_SERVICE_SECRET: serviceSecret,
    WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS: `loyalty-dev-v1:${randomBytes(32).toString("base64")}`,
    SHOPIFY_WEBHOOK_SECRET: "",
    NEXTAUTH_URL: "http://app.localhost:8890",
    NEXT_PUBLIC_APP_DOMAIN: "http://app.localhost:8890",
    SHOPIFY_APP_URL: "http://127.0.0.1:3002",
    SHOPIFY_WEBHOOK_URL:
      "http://app.localhost:8890/api/shopify/integration/webhook",
    WELETIC_ENFORCE_CRON_AUTH: "1",
    UPSTASH_REDIS_REST_URL: "http://127.0.0.1:8079",
    UPSTASH_REDIS_REST_TOKEN: redisToken,
    UPSTASH_GLOBAL_REDIS_REST_URL: "",
    UPSTASH_GLOBAL_REDIS_REST_TOKEN: "",
    STORAGE_ENDPOINT: "http://127.0.0.1:9002",
    STORAGE_BASE_URL: `http://127.0.0.1:9002/${buckets[1]}`,
    STORAGE_ACCESS_KEY_ID: mediaAccessKey,
    STORAGE_SECRET_ACCESS_KEY: mediaSecret,
    STORAGE_PRIVATE_BUCKET: buckets[0],
    STORAGE_PUBLIC_BUCKET: buckets[1],
    RESEND_API_KEY: "",
    RESEND_WEBHOOK_SECRET: "",
    SMTP_HOST: "",
    SMTP_USER: "",
    SMTP_PASSWORD: "",
    QSTASH_TOKEN: "",
    QSTASH_CURRENT_SIGNING_KEY: "",
    QSTASH_NEXT_SIGNING_KEY: "",
    CLOUDFLARE_TUNNEL_TOKEN: "",
    CLOUDFLARE_TUNNEL_NAME: "",
  };
  const shopify = {
    SHOPIFY_API_KEY: "c7d49cebb06e445db345bb200f966a03",
    // Shopify owns this secret. Never manufacture a replacement locally.
    SHOPIFY_API_SECRET: "",
    SHOPIFY_APP_DISTRIBUTION: "app_store",
    SHOPIFY_APP_URL: web.SHOPIFY_APP_URL,
    WELETIC_API_URL: web.NEXTAUTH_URL,
    WELETIC_SHOPIFY_SERVICE_SECRET: serviceSecret,
    PORT: "3002",
    SCOPES:
      "read_products,write_products,read_markets,read_orders,read_translations,read_discounts,write_discounts,read_price_rules,write_price_rules,read_customers,write_customers,read_gift_cards,write_gift_cards,read_store_credit_accounts,write_store_credit_account_transactions,write_app_proxy",
  };
  const dotenv = (values) =>
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n";
  writeSecret(webPath, dotenv(web));
  writeSecret(shopifyPath, dotenv(shopify));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    if (process.argv.slice(2).join(" ") !== "--confirm-local-provisioning") {
      throw new Error("Explicit local provisioning confirmation required.");
    }
    initializeLocalServices(
      resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
    );
    console.log(
      "Created private local configuration. No services started; Shopify secret remains unset.",
    );
  } catch {
    console.error(
      "Local initialization refused or incomplete. Inspect file existence and permissions; no secret values are printed. Never delete existing credentials to retry.",
    );
    process.exitCode = 1;
  }
}
