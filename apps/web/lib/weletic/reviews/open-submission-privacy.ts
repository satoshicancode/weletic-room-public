import type { Prisma } from "@prisma/client";

/** Safe metadata only, nested under an authorized owned-review export. Never
 * expose operation/content digests, installation authority or internal owners.
 */
export function openReviewProvenanceExportSelection(storeId: string) {
  return {
    where: { storeId },
    select: {
      source: true,
      settingsRevision: true,
      disclosureRevision: true,
      locale: true,
      createdAt: true,
      redactedAt: true,
    },
  } satisfies Prisma.WeleticProductReview$openSubmissionArgs;
}

export function openReviewProvenanceRedactionWhere(
  storeId: string,
  shopperId?: string,
) {
  return {
    storeId,
    // Privacy ownership is inclusive, not submission authorization. Either the
    // source owner or its same-store original can reveal the erasing shopper.
    // No original is required: relationMode=prisma permits orphaned provenance.
    ...(shopperId
      ? {
          AND: [{ OR: [{ shopperId }, { review: { storeId, shopperId } }] }],
        }
      : {}),
    OR: [{ redactedAt: null }, { contentDigest: { not: null } }],
  } satisfies Prisma.WeleticOpenReviewSubmissionWhereInput;
}

/** Same store/customer privacy fence as original-content erasure. Keep an
 * immutable, content-free retry tombstone; privacy is never a reward reversal.
 */
export async function redactOpenReviewProvenanceBatch(
  tx: Prisma.TransactionClient,
  storeId: string,
  shopperId?: string,
) {
  const where = openReviewProvenanceRedactionWhere(storeId, shopperId);
  const rows = await tx.weleticOpenReviewSubmission.findMany({
    where,
    orderBy: { id: "asc" },
    take: 20,
    select: { id: true, redactedAt: true },
  });
  for (const row of rows) {
    await tx.weleticOpenReviewSubmission.updateMany({
      where: { ...where, id: row.id },
      data: { contentDigest: null, redactedAt: row.redactedAt ?? new Date() },
    });
  }
}

/** Caller has proved the entire store frozen. Drain source children before
 * deleting originals. Customer erasure must never call this destructive path.
 */
export async function purgeOpenReviewProvenanceBatch(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  const rows = await tx.weleticOpenReviewSubmission.findMany({
    where: { storeId },
    orderBy: { id: "asc" },
    take: 20,
    select: { id: true },
  });
  if (!rows.length) return false;
  await tx.weleticOpenReviewSubmission.deleteMany({
    where: { storeId, id: { in: rows.map(({ id }) => id) } },
  });
  return true;
}
