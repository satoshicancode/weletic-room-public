import {
  RequestedTokenType,
  type Session,
  type Shopify,
} from "@shopify/shopify-api";
import type { ShopifyMerchantActorEnvelope } from "../../../apps/web/lib/weletic/shopify/staff-contract";
import { shopifyStaffUserIdSchema } from "../../../apps/web/lib/weletic/shopify/staff-contract";
import type { CoordinatedWeleticSessionStorage } from "./coordinated-session-storage.server";
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
    const header = request.headers.get("Authorization");
    const match =
      header && header.length <= 8192
        ? /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(
            header,
          )
        : null;
    if (!match)
      throw new WeleticGatewayError("Shopify authentication is required", 401);
    const token = match[1];
    let identity: { shop: string; userId: string };
    try {
      // This SDK method verifies HS256 and audience; it is not decode-only.
      const claims = await sdk.session.decodeSessionToken(token);
      const userId = shopifyStaffUserIdSchema.parse(claims.sub);
      const destination = new URL(claims.dest);
      const now = Math.floor(Date.now() / 1000);
      if (
        destination.protocol !== "https:" ||
        destination.port ||
        destination.username ||
        destination.password ||
        !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(destination.hostname) ||
        claims.dest !== destination.origin ||
        claims.iss !== `${destination.origin}/admin` ||
        ![claims.iat, claims.nbf, claims.exp].every(
          (time) => Number.isSafeInteger(time) && time > 0,
        ) ||
        claims.iat > now ||
        claims.nbf > now ||
        claims.exp <= now ||
        claims.iat >= claims.exp ||
        claims.nbf >= claims.exp
      )
        throw new Error("Invalid Shopify identity");
      identity = { shop: destination.hostname, userId };
    } catch {
      // InvalidJwtError embeds the original JWT. Never propagate or log it.
      throw new WeleticGatewayError("Invalid Shopify authentication", 401);
    }
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
