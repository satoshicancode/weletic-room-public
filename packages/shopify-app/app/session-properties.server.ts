import { Session } from "@shopify/shopify-api";
import type { ShopifySessionProperty } from "../../../apps/web/lib/weletic/shopify/session-contract";
import {
  ONLINE_USER_SCOPE_PROPERTY,
  readOnlineSessionEvidence,
  validShopifySessionIdentityProperties,
} from "../../../apps/web/lib/weletic/shopify/session-online-evidence";

export function serializeShopifySession(
  session: Session,
): ShopifySessionProperty[] {
  const properties = session.toPropertyArray(true);
  if (session.isOnline) {
    const scope = session.onlineAccessInfo?.associated_user_scope;
    if (typeof scope !== "string")
      throw new Error("Online session permission evidence is missing");
    properties.push([ONLINE_USER_SCOPE_PROPERTY, scope]);
    if (!readOnlineSessionEvidence(properties))
      throw new Error("Online session permission evidence is invalid");
  }
  if (!validShopifySessionIdentityProperties(properties))
    throw new Error("Shopify session identity properties are invalid");
  return properties;
}

export function deserializeShopifySession(
  properties: ShopifySessionProperty[],
): Session | undefined {
  if (!validShopifySessionIdentityProperties(properties)) return undefined;
  const online = properties.find(([key]) => key === "isOnline")?.[1];
  if (typeof online !== "boolean") return undefined;
  const evidence = online ? readOnlineSessionEvidence(properties) : null;
  // Older online payloads cannot establish owner or effective-scope authority.
  // Return a cache miss so the SDK reauthenticates instead of hydrating guesses.
  if (online && !evidence) return undefined;
  const session = Session.fromPropertyArray(
    properties.filter(([key]) => key !== ONLINE_USER_SCOPE_PROPERTY),
    true,
  );
  if (evidence && session.onlineAccessInfo)
    session.onlineAccessInfo.associated_user_scope =
      evidence.associatedUserScope;
  return session;
}
