import {
  addRetentionDays,
  getShopifyCustomerTombstoneRetentionDays,
  getShopifyFinancialRetentionDays,
} from "@/lib/weletic/shopify/compliance-config";
import {
  createAllShopifyDerivedPrivacyDigests,
  deriveAllShopifyCustomerPrivacyIdentities,
  loadShopifyPrivacyHmacKeyring,
  VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN,
  type ShopifyCustomerPrivacyIdentity,
} from "@/lib/weletic/shopify/privacy-identity";
import { z } from "zod";

const digestSchema = z.string().regex(VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN);
const snapshotSchema = z
  .object({
    version: z.literal(1),
    storeId: z.string().min(1).max(191),
    referralId: z.string().min(1).max(191),
    friendEmailDigest: digestSchema,
    capturedAt: z.string().datetime(),
    retainUntil: z.string().datetime(),
    customerEmailIdentities: z.array(digestSchema).min(1).max(32),
  })
  .strict();

/** Capture only while canonical email is available to an authorized producer.
 * Versioned identity strings remain visible to the existing recursive key audit.
 * Never copy this snapshot to a Flow payload or merchant response.
 */
export function createReferralPrivacySnapshot({
  storeId,
  referralId,
  friendEmailDigest,
  email,
  now = new Date(),
}: {
  storeId: string;
  referralId: string;
  friendEmailDigest: string;
  email: string;
  now?: Date;
}) {
  const keyring = loadShopifyPrivacyHmacKeyring();
  const ownerDigests = createAllShopifyDerivedPrivacyDigests({
    purpose: "referral_email",
    values: [storeId, email],
    keyring,
  });
  if (!ownerDigests.includes(friendEmailDigest))
    throw new Error("Referral privacy snapshot identity mismatch");
  const identities = deriveAllShopifyCustomerPrivacyIdentities({
    storeId,
    email,
    keyring,
  });
  const retentionDays = Math.min(
    getShopifyFinancialRetentionDays(),
    getShopifyCustomerTombstoneRetentionDays(),
  );
  return snapshotSchema.parse({
    version: 1,
    storeId,
    referralId,
    friendEmailDigest,
    capturedAt: now.toISOString(),
    retainUntil: addRetentionDays(now, retentionDays).toISOString(),
    customerEmailIdentities: identities.map(
      ({ identityKeyId, customerDigest }) =>
        `hmac:v1:${identityKeyId}:${customerDigest}`,
    ),
  });
}

/** Missing, expired, mismatched or retired-key evidence never authorizes dispatch.
 * Expiry invalidates use; physical erasure is separately required by retention.
 */
export function readReferralPrivacySnapshot({
  value,
  storeId,
  referralId,
  friendEmailDigest,
  now = new Date(),
}: {
  value: unknown;
  storeId: string;
  referralId: string;
  friendEmailDigest: string | null;
  now?: Date;
}) {
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success || !Number.isFinite(now.getTime())) return null;
  const snapshot = parsed.data;
  const capturedAt = new Date(snapshot.capturedAt).getTime();
  const retainUntil = Math.min(
    new Date(snapshot.retainUntil).getTime(),
    addRetentionDays(
      new Date(capturedAt),
      Math.min(
        getShopifyFinancialRetentionDays(),
        getShopifyCustomerTombstoneRetentionDays(),
      ),
    ).getTime(),
  );
  if (
    snapshot.storeId !== storeId ||
    snapshot.referralId !== referralId ||
    snapshot.friendEmailDigest !== friendEmailDigest ||
    capturedAt > now.getTime() ||
    retainUntil <= now.getTime() ||
    retainUntil <= capturedAt
  )
    return null;
  const available = new Set(
    loadShopifyPrivacyHmacKeyring().all.map((key) => key.identityKeyId),
  );
  const seen = new Set<string>();
  const identities: ShopifyCustomerPrivacyIdentity[] = [];
  for (const value of snapshot.customerEmailIdentities) {
    const match = value.match(VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN)!;
    if (!available.has(match[1]) || seen.has(match[1])) return null;
    seen.add(match[1]);
    identities.push({
      identityKind: "customer_email" as const,
      identityKeyId: match[1],
      customerDigest: match[2],
    });
  }
  return identities;
}
