import { prisma } from "@/lib/prisma";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import { DIRECT_REVIEW_REWARD_SOURCE } from "@/lib/weletic/loyalty/reward-ownership";
import { Prisma } from "@prisma/client";
import { cleanupReviewPhoto } from "./media";

const PAGE_SIZE = 20;

/** Run under the customer's settlement lock, or after freezing the entire shop.
 * Each page is retryable. Privacy completion waits for actual private-object
 * deletion, not merely enqueueing cleanup jobs. Historical point rows stay put. */
export async function redactNativeReviewsBatch(
  storeId: string,
  shopperId?: string,
) {
  const where: Prisma.WeleticReviewRequestWhereInput = {
    storeId,
    ...(shopperId ? { shopperId } : {}),
    OR: [
      { status: { not: "cancelled" } },
      {
        review: {
          OR: [
            { status: { not: "redacted" } },
            { participationContentDigest: { not: null } },
            { participationValidatedAt: { not: null } },
          ],
        },
      },
      { media: { some: { status: { not: "deleted" } } } },
    ],
  };
  const claimWhere = {
    storeId,
    ...(shopperId ? { shopperId } : {}),
    status: { not: "privacy_redacted" },
  } satisfies Prisma.WeleticReviewIncentiveClaimWhereInput;
  const auditWhere = {
    storeId,
    redactedAt: null,
    review: { storeId, ...(shopperId ? { shopperId } : {}) },
  } satisfies Prisma.WeleticReviewModerationAuditWhereInput;
  const mediaIds = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
    const audits = await tx.weleticReviewModerationAudit.findMany({
      where: auditWhere,
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true },
    });
    if (audits.length)
      await tx.weleticReviewModerationAudit.updateMany({
        where: { ...auditWhere, id: { in: audits.map(({ id }) => id) } },
        data: {
          reasonDetails: null,
          actorUserId: null,
          merchantActionId: null,
          redactedAt: new Date(),
        },
      });
    const claims = await tx.weleticReviewIncentiveClaim.findMany({
      where: claimWhere,
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true, shopperId: true },
    });
    const redactedAt = new Date();
    for (const claim of claims) {
      // Preserve the order-wide financial marker and promised award. Privacy is
      // not fraud, and cannot create a second incentive or a points reversal.
      await tx.weleticReviewIncentiveClaim.update({
        where: { id: claim.id },
        data: {
          status: "privacy_redacted",
          validationSnapshot: {
            redacted: true,
            redactedAt: redactedAt.toISOString(),
          },
        },
      });
      const rewards = await tx.weleticRewardRedemption.findMany({
        where: {
          storeId,
          shopperId: claim.shopperId,
          accountId: null,
          fulfillmentSource: DIRECT_REVIEW_REWARD_SOURCE,
          fulfillmentReference: claim.id,
        },
        select: { id: true },
      });
      await tx.weleticLoyaltyOutboxJob.updateMany({
        where: {
          storeId,
          jobType: "SHOPPER_REWARD_PROVISION",
          idempotencyKey: {
            in: rewards.map(({ id }) => `shopper_reward_provision:${id}`),
          },
          status: { in: ["pending", "processing", "failed"] },
        },
        data: { status: "cancelled", lockedAt: null, lockedBy: null },
      });
    }
    const requests = await tx.weleticReviewRequest.findMany({
      where,
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      include: {
        review: true,
        media: { where: { status: { not: "deleted" } }, select: { id: true } },
      },
    });
    const ids: string[] = [];
    for (const request of requests) {
      await tx.weleticReviewRequest.update({
        where: { id: request.id },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancellationReason: "privacy_redaction",
          tokenHash: null,
          encryptedDeliveryToken: null,
          deliveryToken: null,
          deliveryLeaseExpiresAt: null,
          lastError: null,
        },
      });
      await tx.weleticLoyaltyOutboxJob.updateMany({
        where: {
          storeId,
          jobType: "REVIEW_REQUEST_EMAIL",
          idempotencyKey: `review_request_email:${request.id}`,
          status: { in: ["pending", "processing", "failed"] },
        },
        data: { status: "cancelled", lockedAt: null, lockedBy: null },
      });
      if (
        request.review &&
        (request.review.status !== "redacted" ||
          request.review.participationContentDigest ||
          request.review.participationValidatedAt)
      ) {
        await tx.weleticProductReview.update({
          where: { id: request.review.id },
          data: {
            status: "redacted",
            version: { increment: 1 },
            title: "",
            body: "",
            displayName: "Redacted customer",
            merchantReply: null,
            moderatedByUserId: null,
            participationStatus: "privacy_redacted",
            participationValidatedAt: null,
            participationValidationRevision: null,
            participationContentDigest: null,
            redactedAt: new Date(),
          },
        });
        await enqueueOutboxJob({
          tx,
          storeId,
          jobType: "REVIEW_SUMMARY_SYNC",
          payload: { productId: request.productId },
          idempotencyKey: `review_privacy_summary:${request.review.id}`,
        });
      }
      for (const media of request.media) {
        await tx.weleticReviewMedia.update({
          where: { id: media.id },
          data: { status: "deletion_pending" },
        });
        await enqueueOutboxJob({
          tx,
          storeId,
          jobType: "REVIEW_MEDIA_CLEANUP",
          payload: { mediaId: media.id },
          idempotencyKey: `review_privacy_media:${media.id}`,
        });
        ids.push(media.id);
      }
    }
    return ids;
  });
  for (const id of mediaIds) await cleanupReviewPhoto(storeId, id);
  return {
    hasMore:
      (await prisma.weleticReviewModerationAudit.count({ where: auditWhere })) >
        0 ||
      (await prisma.weleticReviewRequest.count({ where })) > 0 ||
      (await prisma.weleticReviewIncentiveClaim.count({ where: claimWhere })) >
        0,
  };
}

/** Frozen-shop purge precedes catalog deletion so retained review foreign keys
 * cannot block shop erasure. This is not used for individual customer redaction. */
export async function purgeNativeReviewsBatch(storeId: string) {
  return prisma.$transaction(async (tx) => {
    const stores = await tx.$queryRaw<
      Array<{ complianceState: string }>
    >`SELECT complianceState FROM WeleticShopifyStore WHERE id = ${storeId} FOR UPDATE`;
    if (
      !stores[0] ||
      !["frozen", "redacted"].includes(stores[0].complianceState)
    )
      throw new Error("Review purge requires a frozen store");
    // Drain bounded content-audit pages before removing their review parents.
    // Financial ledger and incentive-invalidity records are not deleted here.
    const audits = await tx.weleticReviewModerationAudit.findMany({
      where: { storeId },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true },
    });
    if (audits.length) {
      await tx.weleticReviewModerationAudit.deleteMany({
        where: { storeId, id: { in: audits.map(({ id }) => id) } },
      });
      return { hasMore: true };
    }
    const requests = await tx.weleticReviewRequest.findMany({
      where: { storeId },
      orderBy: { id: "asc" },
      take: PAGE_SIZE,
      select: { id: true },
    });
    const ids = requests.map((row) => row.id);
    if (
      await tx.weleticReviewMedia.count({
        where: { storeId, requestId: { in: ids }, status: { not: "deleted" } },
      })
    )
      throw new Error("Review photos must be erased before purging requests");
    await tx.weleticReviewMedia.deleteMany({
      where: { storeId, requestId: { in: ids } },
    });
    await tx.weleticProductReview.deleteMany({
      where: { storeId, requestId: { in: ids } },
    });
    await tx.weleticReviewRequestLine.deleteMany({
      where: { requestId: { in: ids }, request: { storeId } },
    });
    await tx.weleticReviewRequest.deleteMany({
      where: { storeId, id: { in: ids } },
    });
    let hasMore =
      (await tx.weleticReviewRequest.count({ where: { storeId } })) > 0;
    if (!hasMore) {
      // Confirmed-invalidity decisions retain their financial parent evidence.
      // Erase participation evidence without cascading away the audit or
      // letting retained claims keep the content-purge phase alive forever.
      const retainedWhere = {
        storeId,
        invalidation: { isNot: null },
        status: { not: "privacy_redacted" },
      };
      const retainedClaims = await tx.weleticReviewIncentiveClaim.findMany({
        where: retainedWhere,
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
        select: { id: true },
      });
      await tx.weleticReviewIncentiveClaim.updateMany({
        where: {
          ...retainedWhere,
          id: { in: retainedClaims.map(({ id }) => id) },
        },
        data: {
          status: "privacy_redacted",
          validationSnapshot: {
            redacted: true,
            redactedAt: new Date().toISOString(),
          },
        },
      });
      if (await tx.weleticReviewIncentiveClaim.count({ where: retainedWhere }))
        return { hasMore: true };
      const disposableWhere = { storeId, invalidation: { is: null } };
      const claims = await tx.weleticReviewIncentiveClaim.findMany({
        where: disposableWhere,
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
        select: { id: true },
      });
      const claimIds = claims.map(({ id }) => id);
      const rewards = await tx.weleticRewardRedemption.findMany({
        where: {
          storeId,
          fulfillmentSource: DIRECT_REVIEW_REWARD_SOURCE,
          fulfillmentReference: { in: claimIds },
        },
        select: { id: true, status: true },
      });
      const completedCleanups = await tx.weleticShopifyVoucherCleanup.findMany({
        where: {
          storeId,
          redemptionId: { in: rewards.map(({ id }) => id) },
          status: "completed",
          remoteOutcome: {
            in: ["deactivated", "verified_absent", "used_preserved"],
          },
        },
        select: { redemptionId: true },
      });
      const completedIds = new Set(
        completedCleanups.map(({ redemptionId }) => redemptionId),
      );
      if (
        rewards.some(
          ({ id, status }) =>
            !completedIds.has(id) ||
            !["used", "cancelled", "expired", "failed"].includes(status),
        )
      )
        throw new Error(
          "Review incentive voucher cleanup must finish before purging claim evidence",
        );
      await tx.weleticReviewIncentiveClaim.deleteMany({
        where: { ...disposableWhere, id: { in: claimIds } },
      });
      hasMore =
        (await tx.weleticReviewIncentiveClaim.count({
          where: disposableWhere,
        })) > 0;
    }
    if (!hasMore) {
      await tx.weleticReviewSettings.deleteMany({ where: { storeId } });
      await tx.weleticReviewOrderCancellation.deleteMany({
        where: { storeId },
      });
      const policies = await tx.weleticReviewIncentivePolicy.findMany({
        where: { storeId, claims: { none: {} } },
        orderBy: { id: "asc" },
        take: PAGE_SIZE,
        select: { id: true },
      });
      await tx.weleticReviewIncentivePolicy.deleteMany({
        where: {
          storeId,
          claims: { none: {} },
          id: { in: policies.map(({ id }) => id) },
        },
      });
      hasMore =
        (await tx.weleticReviewIncentivePolicy.count({
          where: { storeId, claims: { none: {} } },
        })) > 0;
    }
    return { hasMore };
  });
}
