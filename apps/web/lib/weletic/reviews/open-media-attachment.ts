import { Prisma } from "@prisma/client";
import {
  REVIEW_MAX_PHOTOS,
  REVIEW_MAX_PHOTO_BYTES,
  ReviewError,
} from "./contracts";
import type { OpenReviewSubmissionScope } from "./open-submission-contract";

/** Internal only. The caller holds the operational store fence, has authorized
 * the unsuppressed shopper/current policy, and creates the owned review and its
 * provenance in this same transaction. Never call in a separate transaction.
 */
export async function attachOpenReviewPhotos({
  tx,
  scope,
  productId,
  submissionKey,
  settingsRevision,
  reviewId,
  mediaIds,
}: {
  tx: Prisma.TransactionClient;
  scope: OpenReviewSubmissionScope;
  productId: string;
  submissionKey: string;
  settingsRevision: number;
  reviewId: string;
  mediaIds: string[];
}) {
  if (!mediaIds.length) return;
  if (
    mediaIds.length > REVIEW_MAX_PHOTOS ||
    new Set(mediaIds).size !== mediaIds.length
  )
    throw new ReviewError("bad_request", "Invalid photos");
  const { storeId, shopperId, installationGeneration } = scope;
  const settings = await tx.$queryRaw<
    Array<{ photoUploadsEnabled: boolean | number }>
  >(Prisma.sql`
    SELECT photoUploadsEnabled FROM WeleticReviewSettings WHERE storeId = ${storeId} FOR UPDATE
  `);
  if (
    settings.length !== 1 ||
    ![true, 1].includes(settings[0].photoUploadsEnabled)
  )
    throw new ReviewError("disabled", "Review photos are disabled");
  // Lock media before ownership, matching storage claims and cleanup. Use current
  // reads rather than the authorization callback's possible earlier snapshot.
  const media = await tx.$queryRaw<
    Array<{
      id: string;
      objectKey: string;
      contentType: string;
      sizeBytes: number;
    }>
  >(Prisma.sql`
    SELECT id, objectKey, contentType, sizeBytes FROM WeleticReviewMedia
    WHERE storeId = ${storeId} AND id IN (${Prisma.join([...mediaIds].sort())})
      AND requestId IS NULL AND reviewId IS NULL AND status = 'uploaded'
      AND uploadExpiresAt > CURRENT_TIMESTAMP(3)
    ORDER BY id FOR UPDATE
  `);
  if (
    media.length !== mediaIds.length ||
    media.some(
      (row) =>
        row.objectKey !== `weletic/reviews/${storeId}/${row.id}.webp` ||
        row.contentType !== "image/webp" ||
        !Number.isInteger(row.sizeBytes) ||
        row.sizeBytes < 1 ||
        row.sizeBytes > REVIEW_MAX_PHOTO_BYTES,
    )
  )
    throw new ReviewError("not_found", "Photo unavailable");
  const owners = await tx.$queryRaw<
    Array<{
      mediaId: string;
      shopperId: string;
      productId: string;
      installationGeneration: string;
      submissionKey: string;
      settingsRevision: number;
      source: string;
      redactedAt: Date | null;
      contentDigest: string | null;
      storageWriteState: string;
    }>
  >(Prisma.sql`
    SELECT mediaId, shopperId, productId, installationGeneration, submissionKey,
      settingsRevision, source, redactedAt, contentDigest, storageWriteState
    FROM WeleticOpenReviewMediaOwnership
    WHERE storeId = ${storeId} AND mediaId IN (${Prisma.join([...mediaIds].sort())})
    ORDER BY mediaId FOR UPDATE
  `);
  if (
    owners.length !== mediaIds.length ||
    new Set(owners.map((row) => row.mediaId)).size !== mediaIds.length ||
    owners.some(
      (row) =>
        !mediaIds.includes(row.mediaId) ||
        row.shopperId !== shopperId ||
        row.productId !== productId ||
        row.installationGeneration !== installationGeneration ||
        row.submissionKey !== submissionKey ||
        row.settingsRevision !== settingsRevision ||
        !["app_proxy", "customer_account"].includes(row.source) ||
        row.redactedAt !== null ||
        !row.contentDigest ||
        row.storageWriteState !== "confirmed",
    )
  )
    throw new ReviewError("not_found", "Photo unavailable");
  const changed = await tx.$executeRaw(Prisma.sql`
    UPDATE WeleticReviewMedia SET reviewId = ${reviewId}, updatedAt = CURRENT_TIMESTAMP(3)
    WHERE storeId = ${storeId} AND id IN (${Prisma.join([...mediaIds].sort())})
      AND requestId IS NULL AND reviewId IS NULL AND status = 'uploaded'
      AND uploadExpiresAt > CURRENT_TIMESTAMP(3)
  `);
  if (changed !== mediaIds.length)
    throw new ReviewError("conflict", "Photo attachment changed");
}
