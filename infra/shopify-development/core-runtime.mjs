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
  const allKeys = Object.values(roleKeys).flat();
  const setupOnly = config?.mode === "setup-only";
  const planKeys = [
    "WELETIC_SHOPIFY_PUBLIC_PLAN_HANDLE",
    "WELETIC_SHOPIFY_PRIVATE_PLAN_HANDLE",
  ];
  const keys = setupOnly
    ? [...allKeys.filter((key) => !planKeys.includes(key)), "mode"]
    : allKeys;
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
    Object.fromEntries(
      roleKeys[target]
        .filter((key) => !setupOnly || !planKeys.includes(key))
        .map((key) => [key, config[key]]),
    );
  // Validate the complete pair before either process starts.
  if (setupOnly) {
    const web = pick("web");
    if (
      !/^gid:\/\/shopify\/App\/[1-9][0-9]*$/.test(web.SHOPIFY_PARTNER_APP_ID) ||
      !/^[1-9][0-9]*$/.test(web.SHOPIFY_PARTNER_ORGANIZATION_ID) ||
      web.SHOPIFY_PARTNER_API_TOKEN.trim().length < 16
    )
      throw new Error("Invalid setup-only identity configuration");
  } else assertCoreBillingEnvironment("web", pick("web"));
  assertCoreBillingEnvironment("shopify", pick("shopify"));
  const env = { ...isolated };
  for (const key of [...allKeys, "WELETIC_SETUP_ONLY"]) delete env[key];
  return {
    ...env,
    ...pick(role),
    ...(setupOnly ? { WELETIC_SETUP_ONLY: "1" } : {}),
    WELETIC_FEATURE_PROFILE: "core-v1",
    WELETIC_RELEASE_PROFILE: "loyalty-only",
  };
}
