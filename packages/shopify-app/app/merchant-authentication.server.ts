import {
  RequestedTokenType,
  type Session,
  type Shopify,
} from "@shopify/shopify-api";
import type { ShopifyMerchantActorEnvelope } from "../../../apps/web/lib/weletic/shopify/staff-contract";
import type { CoordinatedWeleticSessionStorage } from "./coordinated-session-storage.server";
import { verifyShopifyMerchantIdentity } from "./merchant-identity.server";
import { WeleticGatewayError } from "./weletic-api.server";

/** SDK-verifies the browser bearer token, then performs a fresh online exchange
 * for that exact shop/user. No cookie/query-token or offline fallback. Keeping
 * the callback in the original operation preserves the lease until dispatch.
 */
export function createMerchantAuthenticator({
  sdk,
  storage,
}: {
  sdk: Pick<Shopify, "session" | "auth">;
  storage: CoordinatedWeleticSessionStorage;
}) {
  return async function withAuthenticatedMerchant<T>(
    request: Request,
    operation: (context: {
      actor: ShopifyMerchantActorEnvelope;
      session: Session;
    }) => Promise<T>,
  ): Promise<T> {
    const identity = await verifyShopifyMerchantIdentity(request, sdk);
    const { token } = identity;
    return storage.runOperation(async () => {
      let session: Session;
      try {
        ({ session } = await sdk.auth.tokenExchange({
          shop: identity.shop,
          sessionToken: token,
          requestedTokenType: RequestedTokenType.OnlineAccessToken,
        }));
      } catch {
        throw new WeleticGatewayError(
          "Shopify authentication exchange unavailable",
          503,
        );
      }
      if (
        !session.isOnline ||
        session.shop !== identity.shop ||
        session.id !== `${identity.shop}_${identity.userId}` ||
        String(session.onlineAccessInfo?.associated_user.id) !== identity.userId
      )
        throw new WeleticGatewayError(
          "Shopify identity changed during authentication",
          401,
        );
      await storage.storeSession(session);
      const actor = await storage.mintMerchantActor(session);
      if (actor.shop !== identity.shop || actor.userId !== identity.userId)
        throw new WeleticGatewayError(
          "Shopify identity changed during authentication",
          401,
        );
      return operation({ actor, session });
    });
  };
}
