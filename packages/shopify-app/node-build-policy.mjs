/** @param {Record<string, string | undefined>} env */
export function useNodeShopifyBuild(env) {
  const target = env.WELETIC_SHOPIFY_BUILD_TARGET;
  if (target !== undefined && target !== "node" && target !== "vercel") {
    throw new Error("Unsupported Shopify build target");
  }
  if (target === "vercel" && env.WELETIC_LOCAL_CONTAINER_BUILD === "1") {
    throw new Error("Conflicting Shopify build targets");
  }
  return target === "node" || env.WELETIC_LOCAL_CONTAINER_BUILD === "1";
}
