import { createHash, createHmac } from "node:crypto";
import {
  canonicalizeShopifyCustomerId,
  deriveAllShopifyCustomerPrivacyIdentities,
  loadShopifyPrivacyHmacKeyring,
  type ShopifyPrivacyHmacKeyring,
} from "../shopify/privacy-identity";

const CONTEXT = "weletic-review-owner-coverage-v1";

function ownedId(value: string, maximum: number) {
  if (!value || value !== value.trim() || value.length > maximum)
    throw new Error("Review privacy owner scope is invalid");
  return value;
}

/** Private readiness proof: includes retained key material, not just names, so a
 * mistakenly replaced secret cannot certify old projections as current. Never
 * expose this value, identity digests or owner mappings in shopper responses.
 */
export function reviewPrivacyKeySetDigest(
  keyring: ShopifyPrivacyHmacKeyring = loadShopifyPrivacyHmacKeyring(),
) {
  const seen = new Set<string>();
  if (!keyring.all.length) throw new Error("Review privacy keys unavailable");
  const proofs = keyring.all.map(({ identityKeyId, secret }) => {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(identityKeyId) ||
      seen.has(identityKeyId) ||
      !Buffer.isBuffer(secret) ||
      secret.length !== 32
    )
      throw new Error("Review privacy keys invalid");
    seen.add(identityKeyId);
    return [
      identityKeyId,
      createHmac("sha256", secret).update(CONTEXT).digest("hex"),
    ];
  });
  if (
    !keyring.all.some(
      (key) =>
        key.identityKeyId === keyring.current.identityKeyId &&
        key.secret.equals(keyring.current.secret),
    )
  )
    throw new Error("Review privacy current key unavailable");
  proofs.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return createHash("sha256")
    .update(JSON.stringify([CONTEXT, proofs]))
    .digest("hex");
}

/** Build from the persisted shopper row, never a partial webhook payload.
 * Callers must atomically persist all rows and this coverage with the source
 * mutation. This pure contract alone does not certify database readiness.
 */
export function buildReviewPrivacyOwnerProjection({
  storeId,
  shopperId,
  installationGeneration,
  shopifyCustomerId,
  email,
  keyring = loadShopifyPrivacyHmacKeyring(),
}: {
  storeId: string;
  shopperId: string;
  installationGeneration: string;
  shopifyCustomerId: string;
  email: string | null;
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  ownedId(storeId, 191);
  ownedId(shopperId, 191);
  ownedId(installationGeneration, 64);
  const keySetDigest = reviewPrivacyKeySetDigest(keyring);
  if (/^redacted:/i.test(canonicalizeShopifyCustomerId(shopifyCustomerId)))
    throw new Error("Redacted review owner cannot receive active coverage");
  const identities = deriveAllShopifyCustomerPrivacyIdentities({
    storeId,
    shopifyCustomerId,
    email,
    keyring,
  }).sort((left, right) => {
    const a = `${left.identityKind}:${left.identityKeyId}`;
    const b = `${right.identityKind}:${right.identityKeyId}`;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const sourceDigest = createHash("sha256")
    .update(JSON.stringify([CONTEXT, storeId, shopperId, identities]))
    .digest("hex");
  return {
    storeId,
    shopperId,
    installationGeneration,
    keySetDigest,
    sourceDigest,
    identities,
  };
}
