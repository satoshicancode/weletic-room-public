import {
  ApiVersion,
  LogSeverity,
  RequestedTokenType,
  shopifyApi,
} from "@shopify/shopify-api";
import "@shopify/shopify-api/adapters/node";
import { setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import type { CoordinatedWeleticSessionStorage } from "../app/coordinated-session-storage.server";

/** Test-only SDK entry point. Credentials and provider responses are synthetic. */
export function onlineTokenExchangeFixture({
  storage,
  apiKey,
  apiSecretKey,
  transport,
}: {
  storage: CoordinatedWeleticSessionStorage;
  apiKey: string;
  apiSecretKey: string;
  transport: typeof fetch;
}) {
  const sdk = shopifyApi({
    apiKey,
    apiSecretKey,
    apiVersion: ApiVersion.July26,
    hostName: "sdk-fixture.invalid",
    isEmbeddedApp: true,
    scopes: ["read_products", "write_discounts"],
    logger: { level: LogSeverity.Error },
  });
  setAbstractFetchFunc((input, init) =>
    storage.tokenRequest(input, init, transport),
  );
  return {
    sdk,
    exchange: (shop: string, sessionToken: string) =>
      sdk.auth.tokenExchange({
        shop,
        sessionToken,
        requestedTokenType: RequestedTokenType.OnlineAccessToken,
      }),
    restoreTransport: () => setAbstractFetchFunc(globalThis.fetch),
  };
}
