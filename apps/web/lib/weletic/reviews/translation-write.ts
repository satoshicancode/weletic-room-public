import type { Prisma } from "@prisma/client";
import { createWeleticId } from "../ids";
import { hasShopifyCustomerPrivacyTombstone } from "../shopify/privacy-identity";
import { ReviewError } from "./contracts";
import { reviewModerationActorSchema } from "./moderation-contract";
import { manualReviewTranslationInputSchema } from "./translation-contract";
import { assertReviewTranslationOwnerAvailable } from "./translation-owner";
import { reviewTranslationSourceDigest } from "./translation-source";

/** Internal transaction helper. Caller uses SERIALIZABLE isolation, holds the
 * store mutation fence and has
 * authorized a current Shopify staff action on this same transaction. Audit
 * failure must roll back the content write and staff action receipt together.
 */
export async function writeReviewTranslationInTransaction({
  tx,
  storeId,
  generation,
  actor: actorInput,
  input,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  generation: string | null;
  actor: unknown;
  input: unknown;
}) {
  const patch = manualReviewTranslationInputSchema.parse(input);
  const actor = reviewModerationActorSchema.parse(actorInput);
  if (
    actor.kind !== "shopify" ||
    generation !== actor.installationGeneration ||
    generation !== patch.expectedInstallationGeneration
  )
    throw new ReviewError(
      "conflict",
      "Installation changed before translation",
    );

  await tx.$queryRaw`SELECT id FROM WeleticProductReview WHERE storeId = ${storeId} AND id = ${patch.reviewId} FOR UPDATE`;
  const source = await tx.weleticProductReview.findFirst({
    where: {
      storeId,
      id: patch.reviewId,
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
      shopper: { select: { shopifyCustomerId: true, email: true } },
    },
  });
  if (!source) throw new ReviewError("not_found", "Review unavailable");
  if (
    await hasShopifyCustomerPrivacyTombstone({
      tx,
      storeId,
      shopifyCustomerId: source.shopper.shopifyCustomerId,
      email: source.shopper.email,
    })
  )
    throw new ReviewError("not_found", "Review unavailable");
  await assertReviewTranslationOwnerAvailable({
    tx,
    storeId,
    shopperId: source.shopperId,
    installationGeneration: patch.expectedInstallationGeneration,
  });
  if (source.version !== patch.expectedReviewVersion)
    throw new ReviewError(
      "conflict",
      "Review changed; reload before translating",
    );

  const previous = await tx.weleticProductReviewTranslation.findUnique({
    where: {
      storeId_reviewId_locale: {
        storeId,
        reviewId: source.id,
        locale: patch.locale,
      },
    },
  });
  if (previous && (previous.redactedAt || previous.status === "redacted"))
    throw new ReviewError("not_found", "Translation unavailable");
  if ((previous?.revision ?? 0) !== patch.expectedTranslationRevision)
    throw new ReviewError(
      "conflict",
      "Translation changed; reload before editing",
    );

  const revision = patch.expectedTranslationRevision + 1;
  const id = previous?.id ?? createWeleticId("wrevtr_");
  const data = {
    revision,
    sourceReviewVersion: source.version,
    status: patch.action === "save" ? "active" : "removed",
    sourceDigest:
      patch.action === "save"
        ? reviewTranslationSourceDigest({
            storeId,
            reviewId: source.id,
            title: source.title,
            body: source.body,
          })
        : null,
    sourceLocale: patch.action === "save" ? patch.sourceLocale : null,
    title: patch.action === "save" ? patch.title : null,
    body: patch.action === "save" ? patch.body : null,
  };
  if (previous) {
    const updated = await tx.weleticProductReviewTranslation.updateMany({
      where: {
        id,
        storeId,
        reviewId: source.id,
        locale: patch.locale,
        revision: patch.expectedTranslationRevision,
        redactedAt: null,
        status: { not: "redacted" },
      },
      data,
    });
    if (updated.count !== 1)
      throw new ReviewError(
        "conflict",
        "Translation changed; reload before editing",
      );
  } else {
    // A remove of an absent locale still creates a revision tombstone, fencing
    // an earlier save based on revision zero.
    await tx.weleticProductReviewTranslation.create({
      data: { id, storeId, reviewId: source.id, locale: patch.locale, ...data },
    });
  }
  await tx.weleticReviewTranslationAudit.create({
    data: {
      id: createWeleticId("wrevtraudit_"),
      storeId,
      translationId: id,
      fromRevision: patch.expectedTranslationRevision,
      toRevision: revision,
      action: patch.action,
      sourceReviewVersion: source.version,
      appId: actor.appId,
      installationGeneration: actor.installationGeneration,
      actorShopifyUserId: actor.userId,
      merchantActionId: actor.merchantActionId,
    },
  });
  return {
    reviewId: source.id,
    locale: patch.locale,
    revision,
    status: data.status,
  };
}
