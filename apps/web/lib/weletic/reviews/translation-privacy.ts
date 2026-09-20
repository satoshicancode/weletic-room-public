import type { Prisma } from "@prisma/client";

const PAGE_SIZE = 20;

export function reviewTranslationRedactionWhere(
  storeId: string,
  shopperId?: string,
) {
  return {
    storeId,
    review: { storeId, ...(shopperId ? { shopperId } : {}) },
    OR: [
      { status: { not: "redacted" } },
      { redactedAt: null },
      { title: { not: null } },
      { body: { not: null } },
      { sourceDigest: { not: null } },
      { sourceLocale: { not: null } },
    ],
  } satisfies Prisma.WeleticProductReviewTranslationWhereInput;
}

/** Caller holds the same store/customer privacy fences as native review erasure.
 * Do not filter by parent review status: a previous attempt may have erased the
 * original first. Keep revision identity and content-free audit history.
 */
export async function redactReviewTranslationsBatch(
  tx: Prisma.TransactionClient,
  storeId: string,
  shopperId?: string,
) {
  const where = reviewTranslationRedactionWhere(storeId, shopperId);
  const rows = await tx.weleticProductReviewTranslation.findMany({
    where,
    orderBy: { id: "asc" },
    take: PAGE_SIZE,
    select: { id: true },
  });
  if (rows.length)
    await tx.weleticProductReviewTranslation.updateMany({
      where: { ...where, id: { in: rows.map(({ id }) => id) } },
      data: {
        status: "redacted",
        title: null,
        body: null,
        sourceDigest: null,
        sourceLocale: null,
        redactedAt: new Date(),
      },
    });
}

/** Only frozen-shop final purge may delete translation history. Caller has
 * verified the lifecycle under the store lock. Customer erasure never calls it.
 */
export async function purgeReviewTranslationsBatch(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  const audits = await tx.weleticReviewTranslationAudit.findMany({
    where: { storeId },
    orderBy: { id: "asc" },
    take: PAGE_SIZE,
    select: { id: true },
  });
  if (audits.length) {
    await tx.weleticReviewTranslationAudit.deleteMany({
      where: { storeId, id: { in: audits.map(({ id }) => id) } },
    });
    return true;
  }
  const rows = await tx.weleticProductReviewTranslation.findMany({
    where: { storeId },
    orderBy: { id: "asc" },
    take: PAGE_SIZE,
    select: { id: true },
  });
  if (rows.length) {
    await tx.weleticProductReviewTranslation.deleteMany({
      where: { storeId, id: { in: rows.map(({ id }) => id) } },
    });
    return true;
  }
  return false;
}
