import type { Prisma } from "@prisma/client";

/** Nested beneath an owned review in the existing private shopper export.
 * Three supported locales and one retained row per locale bound each relation.
 * Never include source hashes, staff authority or action receipts.
 */
export function reviewTranslationExportSelection(storeId: string) {
  return {
    where: { storeId, locale: { in: ["en", "ja", "vi"] } },
    orderBy: { locale: "asc" },
    take: 3,
    select: {
      locale: true,
      revision: true,
      status: true,
      sourceLocale: true,
      sourceReviewVersion: true,
      title: true,
      body: true,
      createdAt: true,
      updatedAt: true,
      redactedAt: true,
    },
  } satisfies Prisma.WeleticProductReview$translationsArgs;
}
