import { previewOrigins } from "../../packages/shopify-app/app/preview-origins.mjs";
import { assertPublicShopifyRuntime } from "../../packages/shopify-app/app/public-runtime-policy.mjs";
import { buildRuntimeEnvironment } from "./runtime-policy.mjs";

export function buildPreviewEnvironment(app, web, shopify, ambient, config) {
  if (!config || Object.keys(config).sort().join(",") !== "apiOrigin,appOrigin")
    throw new Error("Invalid preview configuration");
  // Start with all existing isolation checks. Never accept public origins or
  // credentials from ambient variables, or mutate the private base files.
  const env = buildRuntimeEnvironment(app, web, shopify, ambient);
  Object.assign(env, {
    WELETIC_SHOPIFY_PREVIEW: "1",
    WELETIC_PREVIEW_APP_ORIGIN: config.appOrigin,
    WELETIC_PREVIEW_API_ORIGIN: config.apiOrigin,
    SHOPIFY_APP_URL: config.appOrigin,
  });
  const origins = previewOrigins(env);
  if (app === "web")
    env.SHOPIFY_WEBHOOK_URL = `${origins.api}/api/shopify/integration/webhook`;
  else assertPublicShopifyRuntime(env);
  return env;
}
