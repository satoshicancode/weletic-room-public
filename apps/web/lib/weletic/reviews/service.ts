import { createWeleticId } from "@/lib/weletic/ids";
import { enqueueOutboxJobFromProgramTransaction } from "@/lib/weletic/loyalty/outbox";
import {
  awardVerifiedReviewPoints,
  reverseReviewPoints,
  reviewAwardKey,
} from "@/lib/weletic/loyalty/review-rewards";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  ReviewError,
  reviewModerationSchema,
  reviewSettingsSchema,
  reviewSubmissionSchema,
} from "./contracts";
import { reserveProductReviewIncentiveInTransaction } from "./incentive-claims";
import { reviewParticipationContentDigest } from "./incentive-evidence";
import { fulfillReviewPointsClaimInTransaction } from "./incentive-points";
import {
  reviewModuleToggleSchema,
  type ReviewModuleToggle,
} from "./module-contract";
import { assertReviewPurchase, reviewRequestInclude } from "./purchase";
import { readUsableReviewRequest } from "./requests";
import { withReviewMutation } from "./transaction";

function assertReviewPolicyReference(value: string | null) {
  if (
    value !== null &&
    (!value || value.trim() !== value || value.length > 191)
  )
    throw new ReviewError(
      "unavailable",
      "Review incentive policy requires reconciliation",
    );
}

export async function updateReviewSettings(
  storeId: string,
  input: unknown,
  moduleToggle?: ReviewModuleToggle,
) {
  // Both editors use the same lifecycle writer. A module-only toggle builds its
  // policy from the locked row, not a stale browser copy of collection settings.
  const parsed = moduleToggle ? null : reviewSettingsSchema.parse(input);
  return withReviewMutation(
    storeId,
    (tx) => writeReviewSettings(tx, storeId, parsed, moduleToggle),
    moduleToggle?.expectedInstallationGeneration,
  );
}

/** Reuses the existing module writer after caller authorization. No nested
 * transaction/retry: the actor receipt and all module effects commit together.
 */
export async function toggleReviewModuleInTransaction(
  tx: Prisma.TransactionClient,
  storeId: string,
  input: unknown,
) {
  const moduleToggle = reviewModuleToggleSchema.parse(input);
  await assertShopifyStoreAcceptsOperationalWrites({
    tx,
    storeId,
    action: "native_reviews",
    expectedInstallationGeneration: moduleToggle.expectedInstallationGeneration,
  });
  return writeReviewSettings(tx, storeId, null, moduleToggle);
}

async function writeReviewSettings(
  tx: Prisma.TransactionClient,
  storeId: string,
  parsed: ReturnType<typeof reviewSettingsSchema.parse> | null,
  moduleToggle?: ReviewModuleToggle,
) {
  const previous = await tx.weleticReviewSettings.findUnique({
    where: { storeId },
  });
  if (
    moduleToggle &&
    (previous?.updatedAt.toISOString() ?? null) !==
      moduleToggle.expectedUpdatedAt
  )
    throw new ReviewError(
      "conflict",
      "Review settings changed. Reload before toggling the module",
    );
  const data =
    parsed ??
    reviewSettingsSchema.parse({
      enabled: moduleToggle!.enabled,
      sendAfterDays: previous?.sendAfterDays ?? 7,
      expiresAfterDays: previous?.expiresAfterDays ?? 30,
      autoPublish: previous?.autoPublish ?? false,
      photoUploadsEnabled: previous?.photoUploadsEnabled ?? true,
      requestEmailEnabled: previous?.requestEmailEnabled ?? false,
    });
  const settings = await tx.weleticReviewSettings.upsert({
    where: { storeId },
    create: {
      storeId,
      ...data,
      activatedAt: data.enabled ? new Date() : null,
    },
    update: {
      ...data,
      ...(data.enabled && !previous?.enabled
        ? { activatedAt: new Date() }
        : {}),
    },
  });
  if (data.enabled) {
    await tx.weleticLoyaltyReviewIntegration.updateMany({
      where: { storeId, provider: "judgeme" },
      data: { enabled: false },
    });
  }
  if (previous?.enabled !== data.enabled) {
    const revision = randomUUID();
    await enqueueOutboxJobFromProgramTransaction({
      tx,
      storeId,
      jobType: "REVIEW_SUMMARY_SYNC",
      payload: { productId: "*", revision },
      idempotencyKey: `review_settings_summary:${revision}`,
    });
  }
  if (!data.enabled || !data.requestEmailEnabled) {
    // Disabling email stops unfinished sends, but keeps already-sent tokens
    // usable while native reviews themselves remain enabled.
    await tx.weleticReviewRequest.updateMany({
      where: {
        storeId,
        status: {
          in: data.enabled
            ? ["queued", "sending", "failed"]
            : ["queued", "sending", "failed", "sent"],
        },
      },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancellationReason: "settings_disabled",
        tokenHash: null,
        encryptedDeliveryToken: null,
        deliveryToken: null,
        deliveryLeaseExpiresAt: null,
      },
    });
  }
  return settings;
}

export async function enqueueReviewSummary(
  tx: Prisma.TransactionClient,
  storeId: string,
  productId: string,
  changeKey: string,
) {
  await enqueueOutboxJobFromProgramTransaction({
    tx,
    storeId,
    jobType: "REVIEW_SUMMARY_SYNC",
    payload: { productId },
    idempotencyKey: `review_summary:${productId}:${changeKey}`,
  });
}

async function applyPublishedReviewReward(
  tx: Prisma.TransactionClient,
  storeId: string,
  reviewId: string,
  generation: string | null,
) {
  const review = await tx.weleticProductReview.findFirstOrThrow({
    where: { storeId, id: reviewId },
    include: { request: { include: reviewRequestInclude }, media: true },
  });
  if (
    // New promises never fall back to the publication-based legacy writer.
    review.request.incentivePolicyId !== null ||
    review.status !== "published" ||
    review.rewardStatus === "awarded" ||
    review.rewardStatus === "reversed"
  )
    return review;
  const settings = await tx.weleticReviewSettings.findUnique({
    where: { storeId },
    select: { enabled: true },
  });
  if (!settings?.enabled)
    return tx.weleticProductReview.update({
      where: { id: reviewId },
      data: {
        rewardStatus: "pending",
        rewardReason: "native_reviews_disabled",
      },
    });
  try {
    assertReviewPurchase(review.request, generation);
    if (
      await tx.weleticReviewOrderCancellation.findUnique({
        where: {
          storeId_orderExternalId: {
            storeId,
            orderExternalId: review.request.order.externalId,
          },
        },
      })
    )
      throw new ReviewError("not_found", "Purchase cancelled");
  } catch (error) {
    if (!(error instanceof ReviewError)) throw error;
    return tx.weleticProductReview.update({
      where: { id: reviewId },
      data: {
        rewardStatus: "ineligible",
        rewardReason: "purchase_ineligible_at_publication",
      },
    });
  }
  const result = await awardVerifiedReviewPoints({
    tx,
    storeId,
    provider: "native",
    accountIdentity: { shopperId: review.shopperId },
    review: {
      id: review.id,
      rating: review.rating,
      body: review.body,
      productId: review.request.product.externalId,
      hasPhoto: review.media.some((m) => m.status === "uploaded"),
      hasVideo: false,
      verifiedStatus: "verified-purchase",
    },
  });
  if (result.status === "awarded" || result.status === "duplicate") {
    const entry = await tx.weleticPointsLedgerEntry.findUniqueOrThrow({
      where: {
        storeId_idempotencyKey: {
          storeId,
          idempotencyKey: reviewAwardKey(storeId, "native", review.id),
        },
      },
    });
    return tx.weleticProductReview.update({
      where: { id: reviewId },
      data: {
        rewardStatus: "awarded",
        incentivized: true,
        rewardLedgerId: entry.id,
        rewardReason: null,
      },
    });
  }
  return tx.weleticProductReview.update({
    where: { id: reviewId },
    data: {
      rewardStatus:
        result.status === "limit_reached" ? "ineligible" : "pending",
      rewardReason: result.reason,
    },
  });
}

export async function submitNativeReview(storeId: string, input: unknown) {
  const data = reviewSubmissionSchema.parse(input);
  return withReviewMutation(storeId, async (tx, generation) => {
    const now = new Date();
    const { request, settings } = await readUsableReviewRequest(
      tx,
      storeId,
      data.token,
      generation,
      now,
    );
    assertReviewPolicyReference(request.incentivePolicyId);
    if (request.incentivePolicyId !== null) {
      if (!generation)
        throw new ReviewError(
          "unavailable",
          "Current installation identity is required",
        );
      if (
        await tx.weleticReviewOrderCancellation.findUnique({
          where: {
            storeId_orderExternalId: {
              storeId,
              orderExternalId: request.order.externalId,
            },
          },
        })
      )
        throw new ReviewError("unavailable", "Purchase is no longer eligible");
    }
    if (data.mediaIds.length && !settings.photoUploadsEnabled)
      throw new ReviewError("bad_request", "Photos are disabled");
    const media = await tx.weleticReviewMedia.findMany({
      where: {
        storeId,
        requestId: request.id,
        id: { in: data.mediaIds },
        reviewId: null,
        status: "uploaded",
        uploadExpiresAt: { gt: now },
      },
    });
    if (media.length !== data.mediaIds.length)
      throw new ReviewError(
        "bad_request",
        "Photo unavailable or owned by another request",
      );
    const consumed = await tx.weleticReviewRequest.updateMany({
      where: {
        id: request.id,
        storeId,
        status: "sent",
        tokenHash: request.tokenHash,
        expiresAt: { gt: now },
      },
      data: {
        status: "submitted",
        submittedAt: now,
        tokenHash: null,
        encryptedDeliveryToken: null,
      },
    });
    if (consumed.count !== 1)
      throw new ReviewError("conflict", "Review request has already been used");
    const review = await tx.weleticProductReview.create({
      data: {
        id: createWeleticId("wreview_"),
        storeId,
        requestId: request.id,
        productId: request.productId,
        shopperId: request.shopperId,
        rating: data.rating,
        title: data.title,
        body: data.body,
        displayName: data.displayName,
        verifiedPurchase: true,
        status: settings.autoPublish ? "published" : "pending",
        publishedAt: settings.autoPublish ? now : null,
      },
    });
    if (media.length)
      await tx.weleticReviewMedia.updateMany({
        where: {
          storeId,
          requestId: request.id,
          id: { in: data.mediaIds },
          reviewId: null,
          status: "uploaded",
        },
        data: { reviewId: review.id },
      });
    if (request.incentivePolicyId !== null) {
      // Invitation possession, current owned purchase, single token consumption,
      // bounded content and validated owned uploads are this revision's checks.
      // Neither star rating nor publication determines participation eligibility.
      // This is not an assertion of comprehensive spam or fraud detection.
      await tx.weleticProductReview.update({
        where: { id: review.id },
        data: {
          participationStatus: "validated",
          participationValidatedAt: now,
          participationValidationRevision: "purchase_abuse_v1",
          participationContentDigest: reviewParticipationContentDigest({
            ...review,
            mediaIds: media.map(({ id }) => id),
          }),
        },
      });
      await reserveProductReviewIncentiveInTransaction({
        tx,
        storeId,
        reviewId: review.id,
        generation,
      });
    }
    if (settings.autoPublish) {
      await applyPublishedReviewReward(tx, storeId, review.id, generation);
      await enqueueReviewSummary(
        tx,
        storeId,
        review.productId,
        `${review.id}:1`,
      );
    }
    return { id: review.id, status: review.status };
  });
}

export async function moderateNativeReview(
  storeId: string,
  reviewId: string,
  userId: string,
  input: unknown,
) {
  const patch = reviewModerationSchema.parse(input);
  return withReviewMutation(storeId, (tx, generation) =>
    moderateNativeReviewInTransaction({
      tx,
      storeId,
      reviewId,
      userId,
      input: patch,
      generation,
    }),
  );
}

/** Internal mutation primitive. The caller must authorize the actor and hold
 * the active-store/review mutation fence on this SAME transaction. This function
 * neither authenticates a caller nor opens/retries a transaction. Keep audit
 * writes on the supplied tx so failure rolls back the entire moderation event.
 */
export async function moderateNativeReviewInTransaction({
  tx,
  storeId,
  reviewId,
  userId,
  input,
  generation,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  reviewId: string;
  userId: string | null;
  input: unknown;
  generation: string | null;
}) {
  const patch = reviewModerationSchema.parse(input);
  const review = await tx.weleticProductReview.findFirst({
    where: { id: reviewId, storeId },
    include: {
      request: { select: { incentivePolicyId: true, orderId: true } },
    },
  });
  if (!review || review.status === "redacted")
    throw new ReviewError("not_found", "Review unavailable");
  assertReviewPolicyReference(review.request.incentivePolicyId);
  if (review.version !== patch.version)
    throw new ReviewError(
      "conflict",
      "Review changed; reload before moderating",
    );
  const status = patch.status ?? review.status;
  if (
    patch.retryReward &&
    review.request.incentivePolicyId === null &&
    status !== "published"
  )
    throw new ReviewError(
      "bad_request",
      "Publish the review before retrying its reward",
    );
  const updated = await tx.weleticProductReview.updateMany({
    where: { id: review.id, storeId, version: patch.version },
    data: {
      status,
      version: { increment: 1 },
      moderatedAt: new Date(),
      moderatedByUserId: userId,
      ...(patch.merchantReply !== undefined
        ? { merchantReply: patch.merchantReply }
        : {}),
      ...(status === "published" && !review.publishedAt
        ? { publishedAt: new Date() }
        : {}),
    },
  });
  if (updated.count !== 1)
    throw new ReviewError(
      "conflict",
      "Review changed; reload before moderating",
    );
  if (patch.retryReward && review.request.incentivePolicyId !== null) {
    if (!generation)
      throw new ReviewError(
        "unavailable",
        "Current installation identity is required",
      );
    const claim = await tx.weleticReviewIncentiveClaim.findUnique({
      where: {
        storeId_orderId: { storeId, orderId: review.request.orderId },
      },
    });
    if (
      !claim ||
      claim.sourceReviewId !== review.id ||
      claim.shopperId !== review.shopperId ||
      claim.policyId !== review.request.incentivePolicyId
    )
      throw new ReviewError(
        "unavailable",
        "This review has no owned incentive claim to retry",
      );
    // No second coupon issuance path: coupon delivery keeps its durable worker.
    const award = claim.awardSnapshot;
    if (
      !award ||
      typeof award !== "object" ||
      Array.isArray(award) ||
      award.kind !== "points"
    )
      throw new ReviewError(
        "bad_request",
        "Coupon fulfillment is managed by the reward delivery worker",
      );
    await fulfillReviewPointsClaimInTransaction({
      tx,
      storeId,
      claimId: claim.id,
      generation,
    });
  }
  if (status === "published") {
    await applyPublishedReviewReward(tx, storeId, review.id, generation);
  } else if (
    review.rewardStatus === "awarded" &&
    review.request.incentivePolicyId === null
  ) {
    const result = await reverseReviewPoints({
      tx,
      storeId,
      provider: "native",
      reviewId: review.id,
      reason: `review_${status}`,
    });
    if (result.status === "ignored")
      throw new ReviewError("unavailable", "Reward ledger evidence is missing");
    await tx.weleticProductReview.update({
      where: { id: review.id },
      data: { rewardStatus: "reversed", rewardReason: `review_${status}` },
    });
  }
  if (status === "published" || review.status === "published") {
    await enqueueReviewSummary(
      tx,
      storeId,
      review.productId,
      `${review.id}:${review.version + 1}`,
    );
  }
  return tx.weleticProductReview.findUniqueOrThrow({
    where: { id: review.id },
  });
}
