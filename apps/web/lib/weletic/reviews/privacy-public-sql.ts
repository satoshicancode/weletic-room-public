import { Prisma } from "@prisma/client";
import {
  loadShopifyPrivacyHmacKeyring,
  type ShopifyPrivacyHmacKeyring,
} from "../shopify/privacy-identity";
import { reviewPrivacyKeySetDigest } from "./privacy-owner-contract";

/** Shared SQL fragments; aliases are fixed, never supplied by a caller.
 * Consumers must use one repeatable-read transaction for readiness, aggregate
 * and page queries. Missing coverage is unknown, not a zero-review result.
 * Source freshness relies on atomic ingestion/backfill, not shopper updatedAt.
 */
function buildReviewPrivacySql({
  storeId,
  productId,
  installationGeneration,
  subject = "product",
  keyring = loadShopifyPrivacyHmacKeyring(),
}: {
  storeId: string;
  productId?: string;
  installationGeneration: string;
  subject?: "product" | "store";
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  for (const value of [
    storeId,
    ...(productId === undefined ? [] : [productId]),
    installationGeneration,
  ]) {
    if (!value || value !== value.trim() || value.length > 191)
      throw new Error("Review public privacy scope unavailable");
  }
  if (installationGeneration.length > 64)
    throw new Error("Review public privacy generation invalid");
  const keySetDigest = reviewPrivacyKeySetDigest(keyring);
  const keys = Prisma.join(keyring.all.map((key) => key.identityKeyId));
  const from =
    subject === "store"
      ? Prisma.sql`WeleticStoreReview r`
      : Prisma.sql`WeleticProductReview r`;
  const productScope =
    productId === undefined
      ? Prisma.empty
      : Prisma.sql`AND r.productId = ${productId}`;
  const base = Prisma.sql`r.storeId = ${storeId} ${productScope}
    AND r.status = 'published' AND r.redactedAt IS NULL
    ${
      subject === "product"
        ? Prisma.sql`AND EXISTS (SELECT 1 FROM WeleticShopifyProduct p
      WHERE p.id = r.productId AND p.storeId = r.storeId AND p.status = 'active')
    `
        : Prisma.sql`AND EXISTS (SELECT 1 FROM WeleticStoreReviewSettings srs
      WHERE srs.storeId = r.storeId AND srs.enabled = 1)`
    }
    AND EXISTS (SELECT 1 FROM WeleticShopifyStore st
      JOIN WeleticReviewSettings rs ON rs.storeId = st.id
      WHERE st.id = r.storeId AND st.complianceState = 'active'
        AND st.storeAccessState = 'active' AND rs.enabled = 1
        AND st.installationGeneration = ${installationGeneration})`;
  const suppressed = Prisma.sql`(
    EXISTS (SELECT 1 FROM WeleticReviewOwnerPrivacyCoverage c
      WHERE c.storeId = r.storeId AND c.shopperId = r.shopperId AND c.state = 'redacted')
    OR EXISTS (SELECT 1 FROM WeleticShopper s
      WHERE s.storeId = r.storeId AND s.id = r.shopperId
        AND LOWER(s.shopifyCustomerId) LIKE '%redacted:%')
    OR EXISTS (SELECT 1 FROM WeleticLoyaltyAccount a
      WHERE a.storeId = r.storeId AND a.shopperId = r.shopperId
        AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.shopifyCustomerRedaction.status')) = 'redacted'
        AND JSON_UNQUOTE(JSON_EXTRACT(a.metadata, '$.shopifyCustomerRedaction.source')) = 'shopify_customers_redact'
        AND JSON_TYPE(JSON_EXTRACT(a.metadata, '$.shopifyCustomerRedaction.redactedAt')) = 'STRING')
    OR EXISTS (SELECT 1 FROM WeleticShopifyCustomerPrivacyTombstone t
      WHERE t.storeId = r.storeId AND t.shopperId = r.shopperId)
    OR EXISTS (SELECT 1 FROM WeleticReviewOwnerPrivacyIdentity i
      JOIN WeleticShopifyCustomerPrivacyTombstone t
        ON t.storeId = i.storeId AND t.identityKind = i.identityKind
        AND t.identityKeyId = i.identityKeyId AND t.customerDigest = i.customerDigest
      WHERE i.storeId = r.storeId AND i.shopperId = r.shopperId)
  )`;
  const ready = Prisma.sql`EXISTS (
    SELECT 1 FROM WeleticReviewOwnerPrivacyCoverage c
    JOIN WeleticShopper s ON s.storeId = c.storeId AND s.id = c.shopperId
    WHERE c.storeId = r.storeId AND c.shopperId = r.shopperId
      AND c.state = 'active' AND c.redactedAt IS NULL
      AND c.installationGeneration = ${installationGeneration}
      AND c.keySetDigest = ${keySetDigest} AND LENGTH(c.sourceDigest) = 64
      AND c.identityCount = ${keyring.all.length} * IF(NULLIF(TRIM(s.email), '') IS NULL, 1, 2)
      AND c.identityCount = (SELECT COUNT(*) FROM WeleticReviewOwnerPrivacyIdentity i
        WHERE i.storeId = c.storeId AND i.shopperId = c.shopperId)
      AND ${keyring.all.length} = (SELECT COUNT(*) FROM WeleticReviewOwnerPrivacyIdentity i
        WHERE i.storeId = c.storeId AND i.shopperId = c.shopperId
          AND i.identityKind = 'customer_id' AND i.identityKeyId IN (${keys}))
      AND ${keyring.all.length} * IF(NULLIF(TRIM(s.email), '') IS NULL, 0, 1) =
        (SELECT COUNT(*) FROM WeleticReviewOwnerPrivacyIdentity i
          WHERE i.storeId = c.storeId AND i.shopperId = c.shopperId
            AND i.identityKind = 'customer_email' AND i.identityKeyId IN (${keys}))
  )`;
  return {
    from,
    base,
    suppressed: Prisma.sql`(${base}) AND (${suppressed})`,
    eligible: Prisma.sql`(${base}) AND (${ready}) AND NOT (${suppressed})`,
    unknown: Prisma.sql`(${base}) AND NOT (${ready}) AND NOT (${suppressed})`,
  };
}

/** Product readers must always name the exact product. */
export function buildReviewPublicPrivacySql(input: {
  storeId: string;
  productId: string;
  installationGeneration: string;
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  if (!input.productId)
    throw new Error("Review public privacy scope unavailable");
  return buildReviewPrivacySql(input);
}

/** Internal whole-store inspection, never a public cross-product list API. */
export function buildReviewStorePrivacySql(input: {
  storeId: string;
  installationGeneration: string;
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  return buildReviewPrivacySql(input);
}

/** Store-experience feedback uses the same owner predicate for rows and totals.
 * This is distinct from the cross-product inspection helper above. Unowned
 * imported content remains unknown until an approved owner contract exists.
 */
export function buildStoreReviewPublicPrivacySql(input: {
  storeId: string;
  installationGeneration: string;
  keyring?: ShopifyPrivacyHmacKeyring;
}) {
  return buildReviewPrivacySql({
    storeId: input.storeId,
    installationGeneration: input.installationGeneration,
    keyring: input.keyring,
    subject: "store",
  });
}
