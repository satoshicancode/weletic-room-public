import { shopifyApi } from "@shopify/shopify-api";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-remix/server";
import { CoordinatedWeleticSessionStorage } from "./coordinated-session-storage.server";
import { createMerchantAuthenticator } from "./merchant-authentication.server";
import { verifyShopifyMerchantIdentity } from "./merchant-identity.server";
import { assertPublicShopifyRuntime } from "./public-runtime-policy.mjs";
import { getShopifyRequestedScopes } from "./shopify-scopes";
import { requireEnv, requireUrlEnv } from "./weletic-api.server";

assertPublicShopifyRuntime(process.env);
const coordinatedStorage = new CoordinatedWeleticSessionStorage();
// This is the SDK's supported transport adapter, not a replacement of global
// fetch. Ownership remains in MySQL; async context only carries its proof.
setAbstractFetchFunc((input, init) => {
  const url = new URL(
    typeof input === "string" || input instanceof URL ? input : input.url,
  );
  return url.pathname === "/admin/oauth/access_token"
    ? coordinatedStorage.tokenRequest(input, init, globalThis.fetch)
    : globalThis.fetch(input, init);
});

const appDistribution =
  process.env.SHOPIFY_APP_DISTRIBUTION?.trim().toLowerCase() ===
  "single_merchant"
    ? AppDistribution.SingleMerchant
    : AppDistribution.AppStore;

const shopify = shopifyApp({
  apiKey: requireEnv("SHOPIFY_API_KEY"),
  apiSecretKey: requireEnv("SHOPIFY_API_SECRET"),
  apiVersion: ApiVersion.July26,
  sessionStorage: coordinatedStorage,
  scopes: getShopifyRequestedScopes(process.env.SCOPES),
  appUrl: requireUrlEnv("SHOPIFY_APP_URL").toString(),
  authPathPrefix: "/auth",
  distribution: appDistribution,
  future: {
    expiringOfflineAccessTokens: true,
    unstable_newEmbeddedAuthStrategy: true,
  },
});

export default shopify;
const merchantSdk = shopifyApi({
  apiKey: requireEnv("SHOPIFY_API_KEY"),
  apiSecretKey: requireEnv("SHOPIFY_API_SECRET"),
  apiVersion: ApiVersion.July26,
  hostName: requireUrlEnv("SHOPIFY_APP_URL").host,
  isEmbeddedApp: true,
  scopes: [],
});
// Minimal identity read only. No token exchange, online session, data access or
// owner/staff authority is granted by this function.
export const verifyInstallationIdentity = (request: Request) =>
  verifyShopifyMerchantIdentity(request, merchantSdk);
// This separate SDK entry point performs only explicit ONLINE token exchange.
// Effective scopes come from the validated response, not this SDK configuration.
// Existing offline install/renewal and authenticate.admin behavior stay intact.
export const withAuthenticatedMerchant = createMerchantAuthenticator({
  storage: coordinatedStorage,
  sdk: merchantSdk,
});
export const authenticate = {
  ...shopify.authenticate,
  admin: (...args: Parameters<typeof shopify.authenticate.admin>) =>
    coordinatedStorage.runOperation(() => shopify.authenticate.admin(...args)),
  public: {
    ...shopify.authenticate.public,
    appProxy: (
      ...args: Parameters<typeof shopify.authenticate.public.appProxy>
    ) =>
      coordinatedStorage.runOperation(() =>
        shopify.authenticate.public.appProxy(...args),
      ),
  },
};
export const unauthenticated = {
  ...shopify.unauthenticated,
  admin: (...args: Parameters<typeof shopify.unauthenticated.admin>) =>
    coordinatedStorage.runOperation(() =>
      shopify.unauthenticated.admin(...args),
    ),
};
export const login = shopify.login;
export const installedUnauthenticated = {
  admin: (shop: string, generation: string) =>
    coordinatedStorage.runInstalledOperation(shop, generation, () =>
      shopify.unauthenticated.admin(shop),
    ),
};
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
