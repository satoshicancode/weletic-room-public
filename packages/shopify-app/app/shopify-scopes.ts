// Keep the fallback aligned with the reviewed CLI manifest. Requested scopes
// are not proof of granted access or store-specific capability.
const defaultScopes = [
  "read_products",
  "write_products",
  "read_markets",
  "read_orders",
  "read_translations",
  "read_discounts",
  "write_discounts",
  "read_price_rules",
  "write_price_rules",
  "read_customers",
  "write_customers",
  "read_gift_cards",
  "write_gift_cards",
  "read_store_credit_accounts",
  "write_store_credit_account_transactions",
  "write_app_proxy",
];

export function getShopifyRequestedScopes(configured: string | undefined) {
  // Preserve explicit deployment configuration, including an empty value. Never
  // silently expand a narrower override to the fallback's permissions.
  return configured?.split(",") ?? [...defaultScopes];
}
