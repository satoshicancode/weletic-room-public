import type { Prisma } from "@prisma/client";

/** Private customer export only. Explicit scalar projections never include
 * bearer hashes, encrypted delivery envelopes, staff identities or leases.
 * Shared incentive promises/awards use the existing order-wide claim export.
 */
export const storeReviewExportSelect = {
  id: true,
  requestId: true,
  source: true,
  status: true,
  version: true,
  rating: true,
  title: true,
  body: true,
  displayName: true,
  locale: true,
  merchantReply: true,
  verifiedPurchase: true,
  incentivized: true,
  participationStatus: true,
  participationValidatedAt: true,
  rewardStatus: true,
  rewardLedgerId: true,
  createdAt: true,
  updatedAt: true,
  publishedAt: true,
  redactedAt: true,
} satisfies Prisma.WeleticStoreReviewSelect;

export const storeReviewRequestExportSelect = {
  id: true,
  orderId: true,
  incentivePolicyId: true,
  settingsRevision: true,
  status: true,
  fulfilledAt: true,
  sendAt: true,
  expiresAt: true,
  sentAt: true,
  submittedAt: true,
  cancelledAt: true,
  cancellationReason: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WeleticStoreReviewRequestSelect;

export const storeReviewAuditExportSelect = {
  id: true,
  reviewId: true,
  reasonCode: true,
  reasonDetails: true,
  fromVersion: true,
  toVersion: true,
  fromStatus: true,
  toStatus: true,
  replyChanged: true,
  createdAt: true,
  redactedAt: true,
} satisfies Prisma.WeleticStoreReviewModerationAuditSelect;
