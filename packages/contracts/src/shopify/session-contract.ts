// Framework-neutral wire contract for the signed Shopify session service.
// Decimal strings preserve counter precision; no BigInt reaches JSON.
export type ShopifySessionProperty = [string, string | number | boolean];

export type ShopifySessionObservation = {
  epoch: string;
  revision: string;
  sessionDigest: string;
  installationGeneration: string | null;
  credentialTokenHash: string | null;
};

export type ShopifySessionLeaseProof = {
  token: string;
  epoch: string;
  revision: string;
};

export type ShopifySessionMutationFence = {
  lease: ShopifySessionLeaseProof;
  observed: ShopifySessionObservation;
};

export type ShopifySessionSnapshot = {
  observed: ShopifySessionObservation;
  properties: ShopifySessionProperty[] | null;
};
