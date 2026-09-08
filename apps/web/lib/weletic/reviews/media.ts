import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { createWeleticId } from "@/lib/weletic/ids";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import { withDistributedLock } from "@/lib/weletic/redis-lock";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import sharp from "sharp";
import {
  REVIEW_MAX_PHOTO_BYTES,
  REVIEW_MAX_PHOTOS,
  ReviewError,
} from "./contracts";
import { readUsableReviewRequest } from "./requests";
import { withReviewMutation } from "./transaction";

function requireReviewStorage() {
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
      "Review photo storage is not configured",
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
      where: { storeId, requestId: request.id, status: { not: "deleted" } },
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
    fn: () => cleanupReviewPhotoLocked(storeId, mediaId),
  });
}

async function cleanupReviewPhotoLocked(storeId: string, mediaId: string) {
  const media = await prisma.weleticReviewMedia.findFirst({
    where: { id: mediaId, storeId },
  });
  if (!media || media.status === "deleted") return;
  if (media.status !== "deletion_pending") {
    if (media.reviewId) return;
    if (media.uploadExpiresAt > new Date())
      throw new ReviewError("unavailable", "Photo cleanup is not due");
  }
  const claimed = await prisma.weleticReviewMedia.updateMany({
    where: {
      id: mediaId,
      storeId,
      status: media.status,
      ...(media.status === "deletion_pending"
        ? {}
        : { reviewId: null, uploadExpiresAt: { lte: new Date() } }),
    },
    data: { status: "deletion_pending" },
  });
  if (!claimed.count) return;
  if (!media.objectKey.startsWith(`weletic/reviews/${storeId}/${media.id}.`))
    throw new ReviewError("unavailable", "Invalid photo object ownership");
  requireReviewStorage();
  await storage.delete({ key: media.objectKey, bucket: "private" });
  await prisma.weleticReviewMedia.updateMany({
    where: { id: media.id, storeId, status: "deletion_pending" },
    data: { status: "deleted" },
  });
}

export async function getPublicReviewPhoto(storeId: string, mediaId: string) {
  const media = await prisma.weleticReviewMedia.findFirst({
    where: {
      id: mediaId,
      storeId,
      status: "uploaded",
      review: {
        storeId,
        status: "published",
        shopper: { privacyTombstones: { none: {} } },
        store: { complianceState: "active", reviewSettings: { enabled: true } },
      },
    },
  });
  if (!media) throw new ReviewError("not_found", "Photo unavailable");
  requireReviewStorage();
  return {
    url: await storage.getSignedDownloadUrl({
      key: media.objectKey,
      bucket: "private",
      expiresIn: 60,
    }),
  };
}
