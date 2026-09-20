import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import type { Prisma } from "@prisma/client";

/** Privacy ownership is deliberately inclusive: either an original or an open
 * reservation can reveal the owner. It is NOT an upload authorization predicate.
 * Whole-store erasure includes orphaned media as well as normal owned records.
 */
export function reviewOwnedMediaRedactionWhere(
  storeId: string,
  shopperId?: string,
) {
  return {
    storeId,
    status: { not: "deleted" },
    ...(shopperId
      ? {
          OR: [
            { review: { storeId, shopperId } },
            { openOwnership: { storeId, shopperId } },
          ],
        }
      : {}),
  } satisfies Prisma.WeleticReviewMediaWhereInput;
}

export function openReviewMediaRedactionWhere(
  storeId: string,
  shopperId?: string,
) {
  return {
    storeId,
    ...(shopperId
      ? {
          AND: [
            {
              OR: [
                { shopperId },
                {
                  media: {
                    storeId,
                    OR: [
                      { review: { storeId, shopperId } },
                      { request: { storeId, shopperId } },
                    ],
                  },
                },
              ],
            },
          ],
        }
      : {}),
    OR: [{ redactedAt: null }, { contentDigest: { not: null } }],
  } satisfies Prisma.WeleticOpenReviewMediaOwnershipWhereInput;
}

/** Reconciliation blocks completion, not progress scrubbing later private rows. */
export function openReviewMediaIncompleteWhere(
  storeId: string,
  shopperId?: string,
) {
  const where = openReviewMediaRedactionWhere(storeId, shopperId);
  return {
    ...where,
    OR: [
      ...where.OR,
      { storageWriteState: { notIn: ["not_started", "confirmed"] } },
    ],
  } satisfies Prisma.WeleticOpenReviewMediaOwnershipWhereInput;
}

/** Defer unknown PUTs without allowing a leading page to starve other uploads.
 * The broader ownership predicate still counts all of them as incomplete.
 */
export function reviewMediaCleanupCandidateWhere(
  storeId: string,
  shopperId?: string,
) {
  return {
    ...reviewOwnedMediaRedactionWhere(storeId, shopperId),
    AND: [
      {
        OR: [
          { requestId: { not: null }, openOwnership: null },
          {
            requestId: null,
            openOwnership: {
              storeId,
              storageWriteState: { in: ["not_started", "confirmed"] },
            },
          },
        ],
      },
    ],
  } satisfies Prisma.WeleticReviewMediaWhereInput;
}

/** Same caller-held privacy fence; also scrub terminal and orphaned provenance.
 * It cannot authorize a PUT, attach a photo or grant a public download.
 */
export async function redactOpenReviewMediaOwnershipBatch(
  tx: Prisma.TransactionClient,
  storeId: string,
  shopperId?: string,
) {
  const where = openReviewMediaRedactionWhere(storeId, shopperId);
  const rows = await tx.weleticOpenReviewMediaOwnership.findMany({
    where,
    orderBy: { id: "asc" },
    take: 20,
    select: { id: true, redactedAt: true },
  });
  for (const row of rows) {
    const changed = await tx.weleticOpenReviewMediaOwnership.updateMany({
      where: { ...where, id: row.id },
      data: { contentDigest: null, redactedAt: row.redactedAt ?? new Date() },
    });
    if (changed.count !== 1)
      throw new Error("Open media ownership changed during erasure");
  }
}

/** Whole-store frozen purge only, after actual object deletion. Retaining this
 * marker during customer erasure prevents a deleted upload being recreated.
 */
export async function purgeOpenReviewMediaOwnershipBatch(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  const rows = await tx.weleticOpenReviewMediaOwnership.findMany({
    where: { storeId },
    orderBy: { id: "asc" },
    take: 20,
    select: { id: true, mediaId: true },
  });
  if (!rows.length) return false;
  if (
    await tx.weleticOpenReviewMediaOwnership.count({
      where: {
        storeId,
        id: { in: rows.map(({ id }) => id) },
        storageWriteState: { notIn: ["not_started", "confirmed"] },
      },
    })
  )
    throw new Error(
      "Open review storage outcome must be reconciled before purge",
    );
  if (
    await tx.weleticReviewMedia.count({
      where: {
        storeId,
        id: { in: rows.map(({ mediaId }) => mediaId) },
        status: { not: "deleted" },
      },
    })
  )
    throw new Error(
      "Open review photos must be erased before purging ownership",
    );
  await tx.weleticOpenReviewMediaOwnership.deleteMany({
    where: { storeId, id: { in: rows.map(({ id }) => id) } },
  });
  return true;
}

/** Caller holds the store/customer privacy fence. Queue and mark in the same
 * transaction; the caller must await actual cleanup and count remaining rows.
 * Re-enqueueing an existing operation uses the existing idempotent job key.
 */
export async function redactReviewOwnedMediaBatch(
  tx: Prisma.TransactionClient,
  storeId: string,
  shopperId?: string,
) {
  const where = reviewMediaCleanupCandidateWhere(storeId, shopperId);
  const rows = await tx.weleticReviewMedia.findMany({
    where,
    orderBy: { id: "asc" },
    take: 20,
    select: { id: true, status: true },
  });
  const ids: string[] = [];
  for (const row of rows) {
    const changed = await tx.weleticReviewMedia.updateMany({
      where: { ...where, id: row.id, status: row.status },
      data: { status: "deletion_pending" },
    });
    if (changed.count !== 1)
      throw new Error("Review media changed during privacy erasure");
    await enqueueOutboxJob({
      tx,
      storeId,
      jobType: "REVIEW_MEDIA_CLEANUP",
      payload: { mediaId: row.id },
      idempotencyKey: `review_privacy_media:${row.id}`,
    });
    ids.push(row.id);
  }
  return ids;
}
