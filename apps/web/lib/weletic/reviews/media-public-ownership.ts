import { Prisma } from "@prisma/client";
import { REVIEW_MAX_PHOTO_BYTES } from "./contracts";

/** Private projection fields. Public callers must return only explicit IDs. */
export const publicPhotoReviewSelection = {
  id: true,
  storeId: true,
  shopperId: true,
  productId: true,
  requestId: true,
  openSubmission: {
    select: {
      storeId: true,
      reviewId: true,
      shopperId: true,
      installationGeneration: true,
      source: true,
      idempotencyKey: true,
      settingsRevision: true,
      redactedAt: true,
      contentDigest: true,
    },
  },
} satisfies Prisma.WeleticProductReviewSelect;

export const publicPhotoMediaSelection = {
  id: true,
  storeId: true,
  reviewId: true,
  requestId: true,
  status: true,
  objectKey: true,
  contentType: true,
  sizeBytes: true,
  request: {
    select: { id: true, storeId: true, shopperId: true, productId: true },
  },
  openOwnership: {
    select: {
      storeId: true,
      mediaId: true,
      shopperId: true,
      productId: true,
      installationGeneration: true,
      source: true,
      submissionKey: true,
      settingsRevision: true,
      redactedAt: true,
      contentDigest: true,
      storageWriteState: true,
    },
  },
} satisfies Prisma.WeleticReviewMediaSelect;

type Review = Prisma.WeleticProductReviewGetPayload<{
  select: typeof publicPhotoReviewSelection;
}>;
type Media = Prisma.WeleticReviewMediaGetPayload<{
  select: typeof publicPhotoMediaSelection;
}>;

/** Publication/privacy/admission are checked by the caller in the same snapshot.
 * Upload expiry applies to unattached drafts, not already published photos.
 * Historical generation must agree between immutable source and upload; a fresh
 * installation does not rewrite or invalidate previously accepted content.
 */
export function hasPublicReviewPhotoOwnership(
  storeId: string,
  review: Review,
  media: Media,
) {
  if (
    review.storeId !== storeId ||
    media.storeId !== storeId ||
    media.reviewId !== review.id ||
    media.status !== "uploaded" ||
    media.objectKey !== `weletic/reviews/${storeId}/${media.id}.webp` ||
    media.contentType !== "image/webp" ||
    !Number.isInteger(media.sizeBytes) ||
    media.sizeBytes < 1 ||
    media.sizeBytes > REVIEW_MAX_PHOTO_BYTES
  )
    return false;
  if (review.requestId) {
    const request = media.request;
    return (
      !review.openSubmission &&
      !media.openOwnership &&
      media.requestId === review.requestId &&
      !!request &&
      request.id === review.requestId &&
      request.storeId === storeId &&
      request.shopperId === review.shopperId &&
      request.productId === review.productId
    );
  }
  const source = review.openSubmission;
  const owner = media.openOwnership;
  return (
    media.requestId === null &&
    !media.request &&
    !!source &&
    !!owner &&
    source.storeId === storeId &&
    source.reviewId === review.id &&
    source.shopperId === review.shopperId &&
    source.redactedAt === null &&
    !!source.contentDigest &&
    !!source.installationGeneration &&
    ["app_proxy", "customer_account"].includes(source.source) &&
    owner.storeId === storeId &&
    owner.mediaId === media.id &&
    owner.shopperId === review.shopperId &&
    owner.productId === review.productId &&
    owner.installationGeneration === source.installationGeneration &&
    owner.submissionKey === source.idempotencyKey &&
    owner.settingsRevision === source.settingsRevision &&
    ["app_proxy", "customer_account"].includes(owner.source) &&
    owner.redactedAt === null &&
    !!owner.contentDigest &&
    owner.storageWriteState === "confirmed"
  );
}
