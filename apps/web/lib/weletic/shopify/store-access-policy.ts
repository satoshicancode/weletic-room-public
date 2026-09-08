export type ShopifyStoreAccessState =
  | "pending_approval"
  | "active"
  | "suspended";

export function isShopifyStoreAccessActive(state: unknown) {
  return state === "active";
}
