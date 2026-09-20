import type { Prisma } from "@prisma/client";
import { hasShopifyCustomerPrivacyTombstone } from "../shopify/privacy-identity";
import { ReviewError } from "./contracts";
import { manualReviewTranslationReadResponseSchema } from "./translation-contract";
import { assertReviewTranslationOwnerAvailable } from "./translation-owner";
import { reviewTranslationSourceDigest } from "./translation-source";

/** Internal only: caller holds the current store/staff authorization fence in
 * a SERIALIZABLE transaction. Read hidden originals for merchant editing, never
 * use this private projection as the public storefront response.
 */
export async function readReviewTranslationsInTransaction({
  tx,
  storeId,
  reviewId,
  generation,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  reviewId: string;
  generation: string;
}) {
  const source = await tx.weleticProductReview.findFirst({
    where: {
      storeId,
      id: reviewId,
      redactedAt: null,
      status: { not: "redacted" },
      product: { storeId },
      shopper: { storeId, privacyTombstones: { none: {} } },
    },
    select: {
      id: true,
      shopperId: true,
      version: true,
      title: true,
      body: true,
      status: true,
      shopper: { select: { shopifyCustomerId: true, email: true } },
      translations: {
        where: { storeId, locale: { in: ["en", "ja", "vi"] } },
        orderBy: { locale: "asc" },
        take: 3,
        select: {
          locale: true,
          revision: true,
          status: true,
          sourceLocale: true,
          sourceDigest: true,
          sourceReviewVersion: true,
          redactedAt: true,
          title: true,
          body: true,
        },
      },
    },
  });
  if (
    !source ||
    (await hasShopifyCustomerPrivacyTombstone({
      tx,
      storeId,
      shopifyCustomerId: source.shopper.shopifyCustomerId,
      email: source.shopper.email,
    }))
  )
    throw new ReviewError("not_found", "Review unavailable");
  await assertReviewTranslationOwnerAvailable({
    tx,
    storeId,
    shopperId: source.shopperId,
    installationGeneration: generation,
  });
  const digest = reviewTranslationSourceDigest({
    storeId,
    reviewId: source.id,
    title: source.title,
    body: source.body,
  });
  return manualReviewTranslationReadResponseSchema.parse({
    reviewId: source.id,
    installationGeneration: generation,
    reviewVersion: source.version,
    original: { title: source.title, body: source.body, status: source.status },
    translations: source.translations.map((row) => {
      const redacted = row.redactedAt !== null || row.status === "redacted";
      const removed = row.status === "removed";
      if (
        !redacted &&
        row.status === "active" &&
        (typeof row.title !== "string" ||
          !row.title.trim() ||
          typeof row.body !== "string" ||
          !row.body.trim() ||
          row.sourceLocale === row.locale)
      )
        throw new ReviewError(
          "unavailable",
          "Translation requires reconciliation",
        );
      const stale =
        row.status === "active" &&
        (row.sourceDigest !== digest ||
          row.sourceReviewVersion < 1 ||
          row.sourceReviewVersion > source.version);
      return {
        locale: row.locale,
        revision: row.revision,
        status: redacted ? "redacted" : stale ? "stale" : row.status,
        sourceLocale: redacted || removed ? null : row.sourceLocale,
        title: redacted || removed ? null : row.title,
        body: redacted || removed ? null : row.body,
      };
    }),
  });
}
