import { prisma } from "@/lib/prisma";
import { forUpdateClause } from "@/lib/prisma/sql-helpers";
import { storage } from "@/lib/storage";
import { createWeleticId } from "@/lib/weletic/ids";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import { withDistributedLock } from "@/lib/weletic/redis-lock";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { Prisma, type WeleticReviewMedia } from "@prisma/client";
import { Input, MP4, UrlSource } from "mediabunny";
import sharp from "sharp";
import {
  REVIEW_MAX_PHOTO_BYTES,
  REVIEW_MAX_PHOTOS,
  REVIEW_MAX_VIDEO_DURATION_MS,
  REVIEW_MAX_VIDEOS,
  ReviewError,
  reviewVideoFinalizeSchema,
  reviewVideoReserveSchema,
} from "./contracts";
import {
  hasPublicReviewMediaOwnership,
  publicPhotoMediaSelection,
  publicPhotoReviewSelection,
} from "./media-public-ownership";
import { OpenPhotoCleanupReconciliationRequired } from "./open-media-errors";
import { reconcileOpenReviewPhotoStorage } from "./open-media-reconciliation";
import { assertReviewPhotoStorageSettled } from "./open-media-write-state";
import { buildReviewPublicPrivacySql } from "./privacy-public-sql";
import { readUsableReviewRequest } from "./requests";
import { withReviewMutation } from "./transaction";

export function requireReviewStorage() {
  if (
    ![
      process.env.STORAGE_ENDPOINT,
      process.env.STORAGE_PRIVATE_BUCKET,
      process.env.STORAGE_ACCESS_KEY_ID,
      process.env.STORAGE_SECRET_ACCESS_KEY,
    ].every(Boolean)
  ) {
    throw new ReviewError(
      "unavailable",
      "Review media storage is not configured",
    );
  }
}

export async function normalizeReviewPhoto(
  bytes: Buffer,
  declaredType: string,
) {
  const formats: Record<string, string> = {
    "image/jpeg": "jpeg",
    "image/png": "png",
    "image/webp": "webp",
  };
  if (
    !formats[declaredType] ||
    !bytes.length ||
    bytes.length > REVIEW_MAX_PHOTO_BYTES
  ) {
    throw new ReviewError(
      "bad_request",
      "Use a JPEG, PNG, or WebP photo up to 2 MB",
    );
  }
  try {
    const source = sharp(bytes, {
      limitInputPixels: 20_000_000,
      failOn: "warning",
      animated: true,
    });
    const metadata = await source.metadata();
    if (
      metadata.format !== formats[declaredType] ||
      (metadata.pages ?? 1) !== 1
    ) {
      throw new Error("Invalid photo format");
    }
    // Decode and re-encode to strip EXIF/GPS metadata and active/polyglot content.
    return await source
      .rotate()
      .resize({
        width: 2000,
        height: 2000,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw new ReviewError("bad_request", "Photo could not be validated");
  }
}

export async function reserveReviewVideo(storeId: string, input: unknown) {
  const data = reviewVideoReserveSchema.parse(input);
  const { request } = await withReviewMutation(storeId, (tx, generation) =>
    readUsableReviewRequest(tx, storeId, data.token, generation),
  );
  const store = await prisma.weleticShopifyStore.findUniqueOrThrow({
    where: { id: storeId },
    select: { projectId: true },
  });
  return withShopifyCustomerSettlementLocks({
    workspaceId: store.projectId,
    storeId,
    shopifyCustomerId: request.shopper.shopifyCustomerId,
    fn: async () => {
      requireReviewStorage();
      const media = await withReviewMutation(
        storeId,
        async (tx, generation) => {
          const { request: ownedRequest, settings } =
            await readUsableReviewRequest(tx, storeId, data.token, generation);
          if (!settings.videoUploadsEnabled)
            throw new ReviewError("disabled", "Videos are disabled");
          const videos = await tx.weleticReviewMedia.count({
            where: {
              storeId,
              requestId: ownedRequest.id,
              kind: "video",
              status: { not: "deleted" },
            },
          });
          if (videos >= REVIEW_MAX_VIDEOS)
            throw new ReviewError(
              "bad_request",
              "A review can contain at most one video",
            );
          const id = createWeleticId("wrevmedia_");
          const uploadExpiresAt = new Date(
            Math.min(ownedRequest.expiresAt.getTime(), Date.now() + 600_000),
          );
          const record = await tx.weleticReviewMedia.create({
            data: {
              id,
              storeId,
              requestId: ownedRequest.id,
              kind: "video",
              objectKey: `weletic/reviews/${storeId}/${id}.mp4`,
              contentType: data.contentType,
              sizeBytes: data.sizeBytes,
              uploadExpiresAt,
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
          return record;
        },
      );
      return {
        id: media.id,
        uploadUrl: await storage.getSignedUploadUrl({
          key: media.objectKey,
          bucket: "private",
          expiresIn: 600,
          contentLength: media.sizeBytes,
          contentType: media.contentType,
        }),
        headers: {
          "Content-Type": media.contentType,
          "Content-Length": String(media.sizeBytes),
        },
      };
    },
  });
}

async function inspectReviewVideo(objectKey: string) {
  const signedUrl = await storage.getSignedDownloadUrl({
    key: objectKey,
    bucket: "private",
    expiresIn: 300,
  });
  const input = new Input({
    source: new UrlSource(signedUrl, {
      maxCacheSize: 8 * 1024 * 1024,
      parallelism: 1,
      getRetryDelay: () => null,
    }),
    formats: [MP4],
  });
  try {
    if (!(await input.canRead()) || (await input.getFormat()) !== MP4)
      throw new ReviewError("bad_request", "Video must be a valid MP4 file");
    const [videoTracks, audioTracks] = await Promise.all([
      input.getVideoTracks(),
      input.getAudioTracks(),
    ]);
    const video = videoTracks[0];
    if (
      videoTracks.length !== 1 ||
      audioTracks.length > 1 ||
      !video ||
      (await video.getCodec()) !== "avc"
    )
      throw new ReviewError(
        "bad_request",
        "Video must contain one H.264 video track",
      );
    const audio = audioTracks[0];
    const audioCodec = audio ? await audio.getCodec() : null;
    if (audioCodec && audioCodec !== "aac")
      throw new ReviewError("bad_request", "Video audio must use AAC");
    const durationMs = Math.ceil((await input.computeDuration()) * 1000);
    const [width, height] = await Promise.all([
      video.getDisplayWidth(),
      video.getDisplayHeight(),
    ]);
    if (
      !Number.isFinite(durationMs) ||
      durationMs < 1 ||
      durationMs > REVIEW_MAX_VIDEO_DURATION_MS
    )
      throw new ReviewError(
        "bad_request",
        "Video must be no longer than 60 seconds",
      );
    if (width < 1 || height < 1 || width > 4096 || height > 4096)
      throw new ReviewError("bad_request", "Video dimensions are unsupported");
    return { durationMs, width, height, videoCodec: "avc", audioCodec };
  } finally {
    input.dispose();
  }
}

export async function finalizeReviewVideo(storeId: string, input: unknown) {
  const data = reviewVideoFinalizeSchema.parse(input);
  const { request } = await withReviewMutation(storeId, (tx, generation) =>
    readUsableReviewRequest(tx, storeId, data.token, generation),
  );
  const store = await prisma.weleticShopifyStore.findUniqueOrThrow({
    where: { id: storeId },
    select: { projectId: true },
  });
  return withShopifyCustomerSettlementLocks({
    workspaceId: store.projectId,
    storeId,
    shopifyCustomerId: request.shopper.shopifyCustomerId,
    fn: () =>
      withDistributedLock({
        key: `weletic:reviews:media:${storeId}:${data.mediaId}`,
        ttlSeconds: 300,
        fn: async () => {
          requireReviewStorage();
          await withReviewMutation(storeId, async (tx, generation) => {
            const { request: current } = await readUsableReviewRequest(
              tx,
              storeId,
              data.token,
              generation,
            );
            if (current.id !== request.id)
              throw new ReviewError("not_found", "Video upload unavailable");
          });
          const media = await prisma.weleticReviewMedia.findFirst({
            where: {
              id: data.mediaId,
              storeId,
              requestId: request.id,
              reviewId: null,
              kind: "video",
              status: "reserved",
              uploadExpiresAt: { gt: new Date() },
            },
          });
          if (!media)
            throw new ReviewError("not_found", "Video upload unavailable");
          try {
            const object = await storage.head({
              key: media.objectKey,
              bucket: "private",
            });
            if (
              object.contentLength !== media.sizeBytes ||
              object.contentType?.split(";", 1)[0] !== "video/mp4"
            )
              throw new ReviewError(
                "bad_request",
                "Uploaded video does not match its reservation",
              );
            const metadata = await inspectReviewVideo(media.objectKey);
            const updated = await prisma.weleticReviewMedia.updateMany({
              where: {
                id: media.id,
                storeId,
                requestId: request.id,
                status: "reserved",
                uploadExpiresAt: { gt: new Date() },
              },
              data: { status: "uploaded", ...metadata },
            });
            if (updated.count !== 1)
              throw new ReviewError("conflict", "Video upload expired");
            return { id: media.id, ...metadata };
          } catch (error) {
            if (error instanceof ReviewError && error.code === "bad_request") {
              await prisma.$transaction(async (tx) => {
                await tx.weleticReviewMedia.updateMany({
                  where: { id: media.id, storeId, status: "reserved" },
                  data: { status: "deletion_pending" },
                });
                await enqueueOutboxJob({
                  tx,
                  storeId,
                  jobType: "REVIEW_MEDIA_CLEANUP",
                  payload: { mediaId: media.id },
                  idempotencyKey: `review_media_invalid:${media.id}`,
                });
              });
            }
            if (error instanceof ReviewError) throw error;
            throw new ReviewError(
              "unavailable",
              "Video validation failed; please retry later",
            );
          }
        },
      }),
  });
}

export async function uploadReviewPhoto(
  storeId: string,
  token: string,
  bytes: Buffer,
  contentType: string,
) {
  const { request } = await withReviewMutation(storeId, (tx, generation) =>
    readUsableReviewRequest(tx, storeId, token, generation),
  );
  const store = await prisma.weleticShopifyStore.findUniqueOrThrow({
    where: { id: storeId },
    select: { projectId: true },
  });
  return withShopifyCustomerSettlementLocks({
    workspaceId: store.projectId,
    storeId,
    shopifyCustomerId: request.shopper.shopifyCustomerId,
    fn: () => uploadReviewPhotoLocked(storeId, token, bytes, contentType),
  });
}

async function uploadReviewPhotoLocked(
  storeId: string,
  token: string,
  bytes: Buffer,
  contentType: string,
) {
  requireReviewStorage();
  // Validate the token before spending resources decoding an untrusted image.
  await withReviewMutation(storeId, (tx, generation) =>
    readUsableReviewRequest(tx, storeId, token, generation),
  );
  const normalized = await normalizeReviewPhoto(bytes, contentType);
  const media = await withReviewMutation(storeId, async (tx, generation) => {
    const { request, settings } = await readUsableReviewRequest(
      tx,
      storeId,
      token,
      generation,
    );
    if (!settings.photoUploadsEnabled)
      throw new ReviewError("disabled", "Photos are disabled");
    const count = await tx.weleticReviewMedia.count({
      where: {
        storeId,
        requestId: request.id,
        kind: "photo",
        status: { not: "deleted" },
      },
    });
    if (count >= REVIEW_MAX_PHOTOS)
      throw new ReviewError(
        "bad_request",
        "A review can contain at most five photos",
      );
    const id = createWeleticId("wrevmedia_");
    const uploadExpiresAt = new Date(
      Math.min(request.expiresAt.getTime(), Date.now() + 86_400_000),
    );
    const record = await tx.weleticReviewMedia.create({
      data: {
        id,
        storeId,
        requestId: request.id,
        objectKey: `weletic/reviews/${storeId}/${id}.webp`,
        contentType: "image/webp",
        sizeBytes: normalized.length,
        uploadExpiresAt,
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
    return record;
  });
  return withDistributedLock({
    key: `weletic:reviews:media:${storeId}:${media.id}`,
    ttlSeconds: 300,
    fn: async () => {
      // A privacy worker can acquire this lock before an uploader that paused
      // after reservation. Never write until ownership is reread under the lock.
      await withReviewMutation(storeId, async (tx, generation) => {
        await readUsableReviewRequest(tx, storeId, token, generation);
        const authorized = await tx.weleticReviewMedia.count({
          where: {
            id: media.id,
            storeId,
            status: "reserved",
            reviewId: null,
            uploadExpiresAt: { gt: new Date() },
          },
        });
        if (authorized !== 1)
          throw new ReviewError(
            "conflict",
            "Photo upload reservation was revoked",
          );
      });
      try {
        await storage.upload({
          key: media.objectKey,
          bucket: "private",
          body: normalized,
          opts: {
            contentType: "image/webp",
            signal: AbortSignal.timeout(30_000),
          },
        });
        await withReviewMutation(storeId, async (tx, generation) => {
          await readUsableReviewRequest(tx, storeId, token, generation);
          const updated = await tx.weleticReviewMedia.updateMany({
            where: {
              id: media.id,
              storeId,
              status: "reserved",
              uploadExpiresAt: { gt: new Date() },
            },
            data: { status: "uploaded" },
          });
          if (updated.count !== 1)
            throw new ReviewError("conflict", "Photo upload expired");
        });
        return { id: media.id };
      } catch {
        await prisma.$transaction(async (tx) => {
          await tx.weleticReviewMedia.updateMany({
            where: { id: media.id, storeId },
            data: { status: "deletion_pending" },
          });
          await enqueueOutboxJob({
            tx,
            storeId,
            jobType: "REVIEW_MEDIA_CLEANUP",
            payload: { mediaId: media.id },
            idempotencyKey: `review_media_upload_failed:${media.id}`,
          });
        });
        throw new ReviewError(
          "unavailable",
          "Photo upload failed; please retry later",
        );
      }
    },
  });
}

export async function cleanupReviewPhoto(storeId: string, mediaId: string) {
  return withDistributedLock({
    key: `weletic:reviews:media:${storeId}:${mediaId}`,
    ttlSeconds: 300,
    fn: async () => {
      try {
        return await cleanupReviewPhotoLocked(storeId, mediaId);
      } catch (error) {
        if (!(error instanceof OpenPhotoCleanupReconciliationRequired))
          throw error;
        let confirmed = false;
        try {
          confirmed =
            (await reconcileOpenReviewPhotoStorage(storeId, mediaId)).status ===
            "confirmed";
        } catch {
          // Keep unknown attempts quarantined; never log provider/token details.
        }
        if (!confirmed) throw error;
        // Same distributed lock, new SQL transaction. Original due/ownership/
        // attachment/deletion-pending checks still decide whether deletion is due.
        return cleanupReviewPhotoLocked(storeId, mediaId);
      }
    },
  });
}

async function cleanupReviewPhotoLocked(storeId: string, mediaId: string) {
  const media = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<WeleticReviewMedia[]>(Prisma.sql`
      SELECT * FROM WeleticReviewMedia WHERE id = ${mediaId} AND storeId = ${storeId} ${forUpdateClause}
    `);
    const current = rows[0];
    if (!current) return null;
    await assertReviewPhotoStorageSettled(
      tx,
      storeId,
      mediaId,
      current.requestId,
    );
    if (current.status === "deleted") return null;
    if (current.status !== "deletion_pending") {
      if (current.reviewId) return null;
      if (current.uploadExpiresAt > new Date())
        throw new ReviewError("unavailable", "Photo cleanup is not due");
    }
    const claimed = await tx.weleticReviewMedia.updateMany({
      where: {
        id: mediaId,
        storeId,
        status: current.status,
        ...(current.status === "deletion_pending"
          ? {}
          : { reviewId: null, uploadExpiresAt: { lte: new Date() } }),
      },
      data: { status: "deletion_pending" },
    });
    return claimed.count === 1 ? current : null;
  });
  if (!media) return;
  if (!media.objectKey.startsWith(`weletic/reviews/${storeId}/${media.id}.`))
    throw new ReviewError("unavailable", "Invalid photo object ownership");
  requireReviewStorage();
  await storage.delete({ key: media.objectKey, bucket: "private" });
  await prisma.weleticReviewMedia.updateMany({
    where: { id: media.id, storeId, status: "deletion_pending" },
    data: { status: "deleted" },
  });
}

export async function getPublicReviewMedia(storeId: string, mediaId: string) {
  const result = await prisma.$transaction(
    async (tx) => {
      const media = await tx.weleticReviewMedia.findFirst({
        where: {
          id: mediaId,
          storeId,
          status: "uploaded",
          review: {
            storeId,
            status: "published",
            redactedAt: null,
            store: {
              complianceState: "active",
              reviewSettings: { enabled: true },
            },
          },
        },
        select: {
          ...publicPhotoMediaSelection,
          review: {
            select: {
              ...publicPhotoReviewSelection,
              store: { select: { installationGeneration: true } },
            },
          },
        },
      });
      const generation = media?.review?.store.installationGeneration;
      if (!media?.review || !generation)
        throw new ReviewError("not_found", "Media unavailable");
      if (!hasPublicReviewMediaOwnership(storeId, media.review, media))
        throw new ReviewError("not_found", "Media unavailable");
      if (media.review.source !== "merchant") {
        const privacy = buildReviewPublicPrivacySql({
          storeId,
          productId: media.review.productId,
          installationGeneration: generation,
        });
        const eligible = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT r.id FROM ${privacy.from} WHERE ${privacy.eligible} AND r.id = ${media.review.id} LIMIT 1`);
        if (!eligible.length)
          throw new ReviewError("not_found", "Media unavailable");
      }
      return {
        objectKey: media.objectKey,
        kind: media.kind,
        contentType: media.contentType,
        durationMs: media.durationMs,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
  requireReviewStorage();
  return {
    url: await storage.getSignedDownloadUrl({
      key: result.objectKey,
      bucket: "private",
      expiresIn: result.kind === "video" ? 900 : 60,
    }),
    kind: result.kind,
    contentType: result.contentType,
    durationMs: result.durationMs,
  };
}

export async function getPublicReviewPhoto(storeId: string, mediaId: string) {
  const media = await getPublicReviewMedia(storeId, mediaId);
  if (media.kind !== "photo")
    throw new ReviewError("not_found", "Photo unavailable");
  return { url: media.url };
}

export const cleanupReviewMedia = cleanupReviewPhoto;
