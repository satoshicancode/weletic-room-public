import { Prisma } from "@prisma/client";
import type { LoyaltyMaintenancePermit } from "../loyalty/maintenance-write-fence";
import { hasShopifyCustomerRedactionTombstone } from "../loyalty/shopper-privacy";
import {
  canonicalizeShopifyCustomerId,
  parseShopifyCustomerPrivacyPseudonym,
  type ShopifyPrivacyHmacKeyring,
} from "../shopify/privacy-identity";
import { assertShopifyStoreAcceptsOperationalWrites } from "../shopify/store-compliance-state";
import { buildReviewPrivacyOwnerProjection } from "./privacy-owner-contract";

/** Only authoritative redaction evidence may be contained by a backfill.
 * Missing ownership, invalid keys and database failures must still abort it.
 */
export class ReviewOwnerPrivacySuppressedError extends Error {
  constructor() {
    super("Review privacy source suppressed");
    this.name = "ReviewOwnerPrivacySuppressedError";
  }
}

/** Internal transaction primitive for identity ingestion and bounded backfill.
 * Locks store before shopper, reads persisted identity, and never enrolls or
 * publishes. The caller must commit this with its source identity mutation.
 */
export async function lockReviewOwnerPrivacySource({
  tx,
  storeId,
  shopperId,
  installationGeneration,
  keyring,
  loyaltyMaintenancePermit,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  shopperId: string;
  installationGeneration: string;
  keyring?: ShopifyPrivacyHmacKeyring;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  if (!installationGeneration || !storeId || !shopperId)
    throw new Error("Review privacy owner scope unavailable");
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId,
    action: "review_privacy_projection",
    expectedInstallationGeneration: installationGeneration,
    loyaltyMaintenancePermit,
  });
  // Every source/privacy read must be a current read: the caller may have
  // established an older Repeatable Read snapshot before acquiring this lock.
  const locked = await tx.$queryRaw<
    Array<{
      id: string;
      storeId: string;
      shopifyCustomerId: string;
      email: string | null;
    }>
  >`
    SELECT id, storeId, shopifyCustomerId, email FROM WeleticShopper
    WHERE storeId = ${storeId} AND id = ${shopperId} FOR UPDATE
  `;
  if (locked.length !== 1 || locked[0].id !== shopperId)
    throw new Error("Owned review privacy source unavailable");
  const shopper = locked[0];
  const accounts = await tx.$queryRaw<Array<{ metadata: Prisma.JsonValue }>>`
    SELECT metadata FROM WeleticLoyaltyAccount
    WHERE storeId = ${storeId} AND shopperId = ${shopperId} FOR UPDATE
  `;
  if (
    !shopper ||
    shopper.id !== shopperId ||
    shopper.storeId !== storeId ||
    accounts.length > 1
  )
    throw new Error("Review privacy source unavailable");
  const customerId = canonicalizeShopifyCustomerId(shopper.shopifyCustomerId);
  if (/^redacted:/i.test(customerId)) {
    if (!parseShopifyCustomerPrivacyPseudonym(customerId, keyring))
      throw new Error("Review privacy pseudonym invalid");
    throw new ReviewOwnerPrivacySuppressedError();
  }
  if (hasShopifyCustomerRedactionTombstone(accounts[0]?.metadata))
    throw new ReviewOwnerPrivacySuppressedError();
  const projection = buildReviewPrivacyOwnerProjection({
    storeId,
    shopperId,
    installationGeneration,
    shopifyCustomerId: shopper.shopifyCustomerId,
    email: shopper.email,
    keyring,
  });
  const existing = await tx.$queryRaw<
    Array<{ state: string; identityCount: number }>
  >`
    SELECT state, identityCount FROM WeleticReviewOwnerPrivacyCoverage
    WHERE storeId = ${storeId} AND shopperId = ${shopperId} FOR UPDATE
  `;
  const previousIdentities = await tx.$queryRaw<
    Array<{
      identityKind: string;
      identityKeyId: string;
      customerDigest: string;
    }>
  >`
    SELECT identityKind, identityKeyId, customerDigest FROM WeleticReviewOwnerPrivacyIdentity
    WHERE storeId = ${storeId} AND shopperId = ${shopperId}
    FOR UPDATE
  `;
  const identityMatch = Prisma.join(
    [...projection.identities, ...previousIdentities].map(
      (identity) =>
        Prisma.sql`(identityKind = ${identity.identityKind}
      AND identityKeyId = ${identity.identityKeyId}
      AND customerDigest = ${identity.customerDigest})`,
    ),
    " OR ",
  );
  const tombstones = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyCustomerPrivacyTombstone
    WHERE storeId = ${storeId}
      AND (shopperId = ${shopperId} OR (${identityMatch}))
    LIMIT 1 FOR UPDATE
  `);
  if (existing.some((row) => row.state === "redacted") || tombstones.length)
    throw new ReviewOwnerPrivacySuppressedError();
  if (existing.some((row) => row.state !== "active"))
    throw new Error("Review privacy coverage state unavailable");
  // A retained key ID cannot silently acquire different key material. Compare
  // the stable customer identity before replacing proofs; email may legitimately
  // change during ingestion, but a same-key customer digest mismatch is unknown.
  const anchoredKeys = new Set(
    previousIdentities
      .filter((row) => row.identityKind === "customer_id")
      .map((row) => row.identityKeyId),
  );
  if (
    (existing.length > 0 && anchoredKeys.size === 0) ||
    previousIdentities.some((row) => !anchoredKeys.has(row.identityKeyId))
  )
    throw new Error("Review privacy retained identity anchors unavailable");
  if (existing.some((row) => row.identityCount !== previousIdentities.length))
    throw new Error("Review privacy retained identity count mismatch");
  for (const identity of previousIdentities) {
    const current = projection.identities.find(
      (row) =>
        row.identityKind === "customer_id" &&
        row.identityKeyId === identity.identityKeyId,
    );
    if (
      !current ||
      (identity.identityKind === "customer_id" &&
        current.customerDigest !== identity.customerDigest) ||
      !["customer_id", "customer_email"].includes(identity.identityKind)
    )
      throw new Error("Review privacy retained identity proof mismatch");
  }
  return projection;
}

/** Validate the old source before rewriting identity, then replace from the
 * final persisted source using the same retained-tombstone locking predicate.
 */
export async function replaceReviewOwnerPrivacyProjection(
  input: Parameters<typeof lockReviewOwnerPrivacySource>[0],
) {
  const projection = await lockReviewOwnerPrivacySource(input);
  const { tx, storeId, shopperId, installationGeneration } = input;
  const scope = { storeId, shopperId };
  const coverage = {
    installationGeneration,
    state: "active" as const,
    keySetDigest: projection.keySetDigest,
    sourceDigest: projection.sourceDigest,
    identityCount: projection.identities.length,
    redactedAt: null,
  };
  await tx.weleticReviewOwnerPrivacyCoverage.upsert({
    where: { storeId_shopperId: scope },
    create: { ...scope, ...coverage },
    update: coverage,
  });
  await tx.weleticReviewOwnerPrivacyIdentity.deleteMany({ where: scope });
  await tx.weleticReviewOwnerPrivacyIdentity.createMany({
    data: projection.identities.map((identity) => ({ ...scope, ...identity })),
  });
  // Count only: no identity proof or customer data escapes this primitive.
  return { identityCount: projection.identities.length };
}
