import { lstatSync, readFileSync } from "node:fs";
import { assertCoreBillingEnvironment } from "../cloudflare-release/billing-policy.mjs";

const roleKeys = {
  web: [
    "SHOPIFY_PARTNER_APP_ID",
    "SHOPIFY_PARTNER_ORGANIZATION_ID",
    "SHOPIFY_PARTNER_API_TOKEN",
    "WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE",
    "WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE",
  ],
  shopify: ["SHOPIFY_APP_HANDLE", "WELETIC_SUPPORT_EMAIL"],
};

export function readCoreRuntimeConfiguration(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 8192)
    throw new Error("Unsafe core configuration file");
  return JSON.parse(readFileSync(path, "utf8"));
}

// Apply only after the existing isolated/preview builder has validated its
// resources. Never take billing authority or feature switches from ambient env.
export function applyCoreRuntimeConfiguration(role, isolated, config) {
  const keys = Object.values(roleKeys).flat();
  if (
    !Object.hasOwn(roleKeys, role) ||
    isolated.WELETIC_ISOLATED_DEVELOPMENT !== "1" ||
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).sort().join(",") !== keys.sort().join(",") ||
    keys.some((key) => typeof config[key] !== "string")
  )
    throw new Error("Invalid core runtime configuration");
  const pick = (target) =>
    Object.fromEntries(roleKeys[target].map((key) => [key, config[key]]));
  // Validate the complete pair before either process starts.
  assertCoreBillingEnvironment("web", pick("web"));
  assertCoreBillingEnvironment("shopify", pick("shopify"));
  const env = { ...isolated };
  for (const key of keys) delete env[key];
  return {
    ...env,
    ...pick(role),
    WELETIC_FEATURE_PROFILE: "core-v1",
    WELETIC_RELEASE_PROFILE: "loyalty-only",
  };
}
