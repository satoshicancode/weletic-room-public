import type { ShopifySessionProperty } from "./session-contract";

export const ONLINE_USER_SCOPE_PROPERTY = "associatedUserScope";
export const SHOPIFY_SESSION_PROPERTY_KEYS = [
  "id",
  "shop",
  "state",
  "isOnline",
  "scope",
  "accessToken",
  "expires",
  "refreshToken",
  "refreshTokenExpires",
  "userId",
  "firstName",
  "lastName",
  "email",
  "locale",
  "emailVerified",
  "accountOwner",
  "collaborator",
  ONLINE_USER_SCOPE_PROPERTY,
] as const;
const propertyKeys = new Set<string>(SHOPIFY_SESSION_PROPERTY_KEYS);

/** Validate original wire types before the SDK can coerce them. */
export function validShopifySessionIdentityProperties(
  properties: ShopifySessionProperty[],
) {
  if (new Set(properties.map(([key]) => key)).size !== properties.length)
    return false;
  return properties.every(([key, value]) => {
    if (!propertyKeys.has(key)) return false;
    if (
      ["isOnline", "accountOwner", "collaborator", "emailVerified"].includes(
        key,
      )
    )
      return typeof value === "boolean";
    if (key === "userId")
      return (
        typeof value === "number" && Number.isSafeInteger(value) && value > 0
      );
    if (key === ONLINE_USER_SCOPE_PROPERTY)
      return (
        typeof value === "string" &&
        value.length <= 8192 &&
        (value === "" ||
          value.split(",").every((scope) => /^[a-z][a-z0-9_]*$/.test(scope)))
      );
    return true;
  });
}

/** Persistence evidence only: this does not authorize an operation or a store. */
export function readOnlineSessionEvidence(
  properties: ShopifySessionProperty[],
) {
  if (!validShopifySessionIdentityProperties(properties)) return null;
  const values = Object.fromEntries(properties);
  if (
    values.isOnline !== true ||
    typeof values.userId !== "number" ||
    typeof values.accountOwner !== "boolean" ||
    typeof values.collaborator !== "boolean" ||
    typeof values[ONLINE_USER_SCOPE_PROPERTY] !== "string"
  )
    return null;
  return {
    userId: values.userId,
    accountOwner: values.accountOwner,
    collaborator: values.collaborator,
    associatedUserScope: values[ONLINE_USER_SCOPE_PROPERTY],
  };
}
