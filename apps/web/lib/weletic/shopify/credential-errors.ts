/** A known credential/lifecycle rejection, never a storage/network failure.
 * Adapters translate this into their established reconnect-required contract. */
export class ShopifyCredentialUnavailableError extends Error {}
