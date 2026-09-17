// Pure shared policy: no filesystem, network or implicit environment reads.
export function previewOrigin(value) {
  if (
    typeof value !== "string" ||
    !/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/.test(value)
  )
    throw new Error("Invalid development preview origin");
  return value;
}

export function previewOrigins(env) {
  const keys = [
    "WELETIC_SHOPIFY_PREVIEW",
    "WELETIC_PREVIEW_APP_ORIGIN",
    "WELETIC_PREVIEW_API_ORIGIN",
  ];
  if (!keys.some((key) => !!env[key])) return null;
  if (
    env.WELETIC_SHOPIFY_PREVIEW !== "1" ||
    env.WELETIC_ISOLATED_DEVELOPMENT !== "1" ||
    env.NODE_ENV !== "development"
  )
    throw new Error("Unsafe development preview mode");
  const app = previewOrigin(env.WELETIC_PREVIEW_APP_ORIGIN);
  const api = previewOrigin(env.WELETIC_PREVIEW_API_ORIGIN);
  if (app === api) throw new Error("Preview origins must be separate");
  return { app, api };
}
