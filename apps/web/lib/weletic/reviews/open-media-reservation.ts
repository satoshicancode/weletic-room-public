import { createWeleticId } from "@/lib/weletic/ids";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import { Prisma } from "@prisma/client";
import { isCoreLaunch } from "../core-launch-policy";
import { REVIEW_MAX_PHOTOS, ReviewError } from "./contracts";
import type {
  OpenReviewPhotoInput,
  openReviewPhotoEvidence,
} from "./open-media-contract";
import { OpenPhotoReconciliationRequired } from "./open-media-errors";
import type { OpenReviewSubmissionScope } from "./open-submission-contract";

type PhotoEvidence = ReturnType<typeof openReviewPhotoEvidence>;
type ReservedPhoto = {
  storageWriteState: string;
  id: string;
  objectKey: string;
  status: string;
  reviewId: string | null;
  uploadExpiresAt: Date;
};

/** Internal primitive. Caller holds the operational store fence and has checked
 * current policy, exact active product and authenticated unsuppressed owner.
 * Current SQL reads avoid a callback's earlier Repeatable Read snapshot.
 */
export async function reserveOpenReviewPhotoInTransaction({
  tx,
  scope,
  input,
  evidence,
  productId,
  sizeBytes,
  maxSubmissionsPer24Hours,
}: {
  tx: Prisma.TransactionClient;
  scope: OpenReviewSubmissionScope;
  input: OpenReviewPhotoInput;
  evidence: PhotoEvidence;
  productId: string;
  sizeBytes: number;
  maxSubmissionsPer24Hours: number;
}): Promise<ReservedPhoto> {
  if (isCoreLaunch())
    throw new ReviewError(
      "disabled",
      "Open reviews are unavailable in the core launch",
    );
  const { storeId, shopperId, installationGeneration, source } = scope;
  const clocks = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  const now = clocks[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime()))
    throw new ReviewError("unavailable", "Upload clock unavailable");
  const existing = await tx.$queryRaw<
    Array<
      ReservedPhoto & {
        mediaStoreId: string | null;
        requestId: string | null;
        shopperId: string;
        productId: string;
        installationGeneration: string;
        source: string;
        submissionKey: string;
        contentDigest: string | null;
        redactedAt: Date | null;
        settingsRevision: number;
        sizeBytes: number;
        contentType: string;
      }
    >
  >(Prisma.sql`
    SELECT m.id, m.storeId AS mediaStoreId, m.objectKey, m.status, m.reviewId,
      m.uploadExpiresAt, m.requestId, m.sizeBytes, m.contentType,
      o.shopperId, o.productId, o.installationGeneration, o.source, o.submissionKey,
      o.contentDigest, o.redactedAt, o.settingsRevision, o.storageWriteState
    FROM WeleticOpenReviewMediaOwnership o LEFT JOIN WeleticReviewMedia m
      ON m.id = o.mediaId AND m.storeId = o.storeId
    WHERE o.storeId = ${storeId} AND o.idempotencyKey = ${evidence.idempotencyKey}
    LIMIT 1 FOR UPDATE
  `);
  if (existing.length) {
    const row = existing[0];
    if (
      row.mediaStoreId !== storeId ||
      row.requestId !== null ||
      row.shopperId !== shopperId ||
      row.productId !== productId ||
      row.installationGeneration !== installationGeneration ||
      !["app_proxy", "customer_account"].includes(row.source) ||
      row.redactedAt ||
      !row.contentDigest ||
      !["reserved", "uploaded"].includes(row.status) ||
      !(row.uploadExpiresAt instanceof Date) ||
      row.uploadExpiresAt <= now ||
      row.objectKey !== `weletic/reviews/${storeId}/${row.id}.webp` ||
      row.contentType !== "image/webp" ||
      (row.status === "uploaded" && row.storageWriteState !== "confirmed") ||
      row.reviewId !== null
    )
      throw new ReviewError("not_found", "Photo unavailable");
    if (
      row.submissionKey !== evidence.submissionKey ||
      row.contentDigest !== evidence.contentDigest ||
      row.settingsRevision !== input.expectedSettingsRevision ||
      row.sizeBytes !== sizeBytes
    )
      throw new ReviewError("conflict", "Upload identity already used");
    // Do not use an unknown provider outcome to bypass ownership/content
    // checks or let altered retries initiate remote reconciliation reads.
    if (["in_flight", "ambiguous"].includes(row.storageWriteState))
      throw new OpenPhotoReconciliationRequired(row.id);
    if (!["not_started", "confirmed"].includes(row.storageWriteState))
      throw new ReviewError(
        "unavailable",
        "Photo storage outcome requires reconciliation",
      );
    return row;
  }
  const accepted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticOpenReviewSubmission WHERE storeId = ${storeId}
      AND idempotencyKey = ${evidence.submissionKey} LIMIT 1 FOR UPDATE
  `);
  if (accepted.length)
    throw new ReviewError("conflict", "Review already submitted");
  const slots = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT o.id FROM WeleticOpenReviewMediaOwnership o LEFT JOIN WeleticReviewMedia m
      ON m.id = o.mediaId AND m.storeId = o.storeId
    WHERE o.storeId = ${storeId} AND o.submissionKey = ${evidence.submissionKey}
      AND (m.id IS NULL OR m.status <> 'deleted') LIMIT ${REVIEW_MAX_PHOTOS} FOR UPDATE
  `);
  if (slots.length >= REVIEW_MAX_PHOTOS)
    throw new ReviewError(
      "bad_request",
      "A review can contain at most five photos",
    );
  const quota = REVIEW_MAX_PHOTOS * maxSubmissionsPer24Hours;
  if (!Number.isInteger(quota) || quota < REVIEW_MAX_PHOTOS || quota > 100)
    throw new ReviewError("unavailable", "Upload quota unavailable");
  // Include deleted attempts, future timestamps and older installations. Neither
  // abandoning drafts nor cleanup/reinstall resets the customer's daily budget.
  const recent = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticOpenReviewMediaOwnership WHERE storeId = ${storeId}
      AND shopperId = ${shopperId} AND createdAt > ${new Date(now.getTime() - 86_400_000)}
    LIMIT ${quota} FOR UPDATE
  `);
  if (recent.length >= quota)
    throw new ReviewError("unavailable", "Photo upload limit reached");
  const id = createWeleticId("wrevmedia_");
  const uploadExpiresAt = new Date(now.getTime() + 86_400_000);
  const objectKey = `weletic/reviews/${storeId}/${id}.webp`;
  await tx.weleticReviewMedia.create({
    data: {
      id,
      storeId,
      requestId: null,
      reviewId: null,
      objectKey,
      contentType: "image/webp",
      sizeBytes,
      status: "reserved",
      uploadExpiresAt,
      createdAt: now,
    },
  });
  await tx.weleticOpenReviewMediaOwnership.create({
    data: {
      id: createWeleticId("wrevmediaown_"),
      storeId,
      mediaId: id,
      shopperId,
      productId,
      installationGeneration,
      source,
      ...evidence,
      settingsRevision: input.expectedSettingsRevision,
      createdAt: now,
    },
  });
  await enqueueOutboxJob({
    tx,
    storeId,
    jobType: "REVIEW_MEDIA_CLEANUP",
    payload: { mediaId: id },
    idempotencyKey: `review_media_expiry:${id}`,
    scheduledFor: uploadExpiresAt,
  });
  return {
    id,
    objectKey,
    uploadExpiresAt,
    status: "reserved",
    reviewId: null,
    storageWriteState: "not_started",
  };
}
