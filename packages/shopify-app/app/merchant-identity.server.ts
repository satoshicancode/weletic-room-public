import type { Shopify } from "@shopify/shopify-api";
import { shopifyStaffUserIdSchema } from "../../../apps/web/lib/weletic/shopify/staff-contract";
import { WeleticGatewayError } from "./weletic-api.server";

/** Identity only, not merchant permission or company-store approval. */
export async function verifyShopifyMerchantIdentity(
  request: Request,
  sdk: Pick<Shopify, "session">,
) {
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
  try {
    // The SDK verifies HS256 and audience; this is not decode-only.
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
    return {
      token,
      shop: destination.hostname,
      userId,
      issuedAt: claims.iat,
      expiresAt: claims.exp,
    };
  } catch {
    // SDK errors may embed the original JWT. Never return or log them.
    throw new WeleticGatewayError("Invalid Shopify authentication", 401);
  }
}
