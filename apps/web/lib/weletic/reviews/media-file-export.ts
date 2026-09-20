import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import type { Prisma } from "@prisma/client";
import { REVIEW_MAX_PHOTO_BYTES } from "./contracts";
import {
  hasPublicReviewPhotoOwnership,
  publicPhotoMediaSelection,
  publicPhotoReviewSelection,
} from "./media-public-ownership";

/** Exclusive private ownership, including unattached confirmed uploads. This
 * is not the inclusive erasure predicate and grants no public photo access.
 */
export function reviewMediaFileExportWhere(storeId: string, shopperId: string) {
  return {
    storeId,
    status: "uploaded",
    OR: [
      {
        requestId: { not: null },
        request: { storeId, shopperId },
        openOwnership: null,
      },
      {
        requestId: null,
        openOwnership: {
          storeId,
          shopperId,
          redactedAt: null,
          storageWriteState: "confirmed",
        },
      },
    ],
  } satisfies Prisma.WeleticReviewMediaWhereInput;
}

export const reviewMediaFileExportSelect = {
  id: true,
  requestId: true,
  reviewId: true,
  contentType: true,
  sizeBytes: true,
  objectKey: true,
  createdAt: true,
} satisfies Prisma.WeleticReviewMediaSelect;

type FileRecord = Prisma.WeleticReviewMediaGetPayload<{
  select: typeof reviewMediaFileExportSelect;
}>;

/** One bounded photo per encrypted compliance chunk. Only the authenticated,
 * lease-fenced compliance writer may deliver this result. Never persist a raw
 * object key or storage bearer in an export; recheck ownership after remote I/O.
 */
export async function exportReviewMediaFile(
  storeId: string,
  shopperId: string,
  record: FileRecord,
) {
  if (
    record.objectKey !== `weletic/reviews/${storeId}/${record.id}.webp` ||
    record.contentType !== "image/webp" ||
    !Number.isInteger(record.sizeBytes) ||
    record.sizeBytes < 1 ||
    record.sizeBytes > REVIEW_MAX_PHOTO_BYTES
  )
    throw new Error("Review export photo metadata is invalid");
  const selection = {
    where: {
      ...reviewMediaFileExportWhere(storeId, shopperId),
      id: record.id,
      objectKey: record.objectKey,
      sizeBytes: record.sizeBytes,
      contentType: record.contentType,
      requestId: record.requestId,
      reviewId: record.reviewId,
    },
    select: {
      ...publicPhotoMediaSelection,
      review: { select: publicPhotoReviewSelection },
    },
  };
  async function ownedSnapshot() {
    const current = await prisma.weleticReviewMedia.findFirst(selection);
    if (!current) throw new Error("Review export photo ownership changed");
    let productId: string;
    if (current.reviewId !== null) {
      if (
        !current.review ||
        current.review.shopperId !== shopperId ||
        !hasPublicReviewPhotoOwnership(storeId, current.review, current)
      )
        throw new Error("Review export attached photo ownership invalid");
      productId = current.review.productId;
    } else {
      if (current.review)
        throw new Error("Review export photo ownership invalid");
      const owner = current.openOwnership;
      const request = current.request;
      if (current.requestId !== null) {
        if (
          owner ||
          !request ||
          request.id !== current.requestId ||
          request.storeId !== storeId ||
          request.shopperId !== shopperId
        )
          throw new Error("Review export invitation ownership invalid");
        productId = request.productId;
      } else {
        if (
          request ||
          !owner ||
          owner.storeId !== storeId ||
          owner.mediaId !== current.id ||
          owner.shopperId !== shopperId ||
          owner.redactedAt !== null ||
          owner.storageWriteState !== "confirmed" ||
          !owner.installationGeneration ||
          !["app_proxy", "customer_account"].includes(owner.source) ||
          !/^[a-f0-9]{64}$/.test(owner.contentDigest ?? "") ||
          !/^[a-f0-9]{64}$/.test(owner.submissionKey) ||
          !Number.isInteger(owner.settingsRevision) ||
          owner.settingsRevision < 1
        )
          throw new Error("Review export open reservation ownership invalid");
        productId = owner.productId;
      }
    }
    if (
      !(await prisma.weleticShopifyProduct.findFirst({
        where: { id: productId, storeId },
        select: { id: true },
      }))
    )
      throw new Error("Review export photo product ownership invalid");
    return JSON.stringify(current);
  }
  const before = await ownedSnapshot();
  const bytes = await storage.readPrivateR2Object(
    record.objectKey,
    record.sizeBytes,
  );
  if ((await ownedSnapshot()) !== before)
    throw new Error("Review export photo ownership changed");
  return {
    id: record.id,
    reviewId: record.reviewId,
    contentType: record.contentType,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
    fileName: `${record.id}.webp`,
    encoding: "base64" as const,
    data: bytes.toString("base64"),
  };
}
