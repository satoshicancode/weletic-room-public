import { createWeleticId } from "@/lib/weletic/ids";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { ReviewError } from "./contracts";
import { storeReviewParticipationContentDigest } from "./incentive-evidence";
import {
  auditedReviewModerationInputSchema,
  reviewModerationActorSchema,
} from "./moderation-contract";
import { replaceReviewOwnerPrivacyProjection } from "./privacy-owner-write";
import { assertReviewPurchaseNotSuppressed } from "./purchase";
import { reserveStoreReviewIncentiveInTransaction } from "./store-incentive-claims";
import {
  assertStoreReviewPurchaseIdentity,
  assertStoreReviewRequestLineBindings,
  assertStoreReviewSubmissionPurchase,
  storeReviewRequestInclude,
} from "./store-purchase";
import { withReviewMutation } from "./transaction";

export const storeReviewSubmissionSchema = z
  .object({
    requestId: z.string().min(1).max(191),
    rating: z.number().int().min(1).max(5),
    title: z.string().trim().max(120),
    body: z.string().trim().min(1).max(5000),
    displayName: z.string().trim().min(1).max(80),
    locale: z.enum(["en", "ja", "vi"]),
    publishConsent: z.literal(true),
  })
  .strict();

/** Internal authenticated boundary. The gateway must derive shopperId from a
 * verified Shopify customer session, never browser input. No route or collector
 * is enabled here. Retry identity is the owned, one-per-order invitation.
 */
export function submitAuthenticatedStoreReview({
  storeId,
  shopperId,
  expectedInstallationGeneration,
  input,
}: {
  storeId: string;
  shopperId: string;
  expectedInstallationGeneration: string;
  input: unknown;
}) {
  const patch = storeReviewSubmissionSchema.parse(input);
  if (!storeId || !shopperId || !expectedInstallationGeneration)
    throw new ReviewError(
      "unavailable",
      "Authenticated store review identity required",
    );
  return withReviewMutation(
    storeId,
    async (tx, generation) => {
      if (generation !== expectedInstallationGeneration)
        throw new ReviewError("conflict", "Installation changed");
      const [module, settings] = await Promise.all([
        tx.weleticReviewSettings.findUnique({ where: { storeId } }),
        tx.weleticStoreReviewSettings.findUnique({ where: { storeId } }),
      ]);
      if (!module?.enabled || !settings?.enabled)
        throw new ReviewError("disabled", "Store reviews unavailable");
      const request = await tx.weleticStoreReviewRequest.findFirst({
        where: { id: patch.requestId, storeId, shopperId },
        include: storeReviewRequestInclude,
      });
      if (!request)
        throw new ReviewError("not_found", "Review invitation unavailable");
      assertStoreReviewRequestLineBindings(request);
      assertStoreReviewPurchaseIdentity(request, generation);
      await assertReviewPurchaseNotSuppressed(tx, request);
      const existing = await tx.weleticStoreReview.findUnique({
        where: { requestId: request.id },
      });
      if (existing) {
        if (
          request.status !== "submitted" ||
          existing.storeId !== storeId ||
          existing.shopperId !== shopperId ||
          existing.source !== "invitation" ||
          existing.redactedAt ||
          existing.status === "redacted" ||
          existing.rating !== patch.rating ||
          existing.title !== patch.title ||
          existing.body !== patch.body ||
          existing.displayName !== patch.displayName ||
          existing.locale !== patch.locale
        )
          throw new ReviewError(
            "conflict",
            "Submitted review differs from this retry",
          );
        return { status: "received" as const, duplicate: true };
      }
      const now = new Date();
      if (request.status !== "sent" || request.expiresAt <= now)
        throw new ReviewError("unavailable", "Review invitation unavailable");
      if (
        request.incentivePolicyId !== null &&
        (!request.incentivePolicyId ||
          request.incentivePolicyId.trim() !== request.incentivePolicyId)
      )
        throw new ReviewError(
          "unavailable",
          "Review incentive policy requires reconciliation",
        );
      await assertStoreReviewSubmissionPurchase({
        tx,
        storeId,
        generation,
        request,
      });
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
      await replaceReviewOwnerPrivacyProjection({
        tx,
        storeId,
        shopperId,
        installationGeneration: generation,
      });
      const consumed = await tx.weleticStoreReviewRequest.updateMany({
        where: {
          id: request.id,
          storeId,
          shopperId,
          installationGeneration: generation,
          status: "sent",
          expiresAt: { gt: now },
        },
        data: {
          status: "submitted",
          submittedAt: now,
          tokenHash: null,
          encryptedDeliveryToken: null,
          encryptedDeliverySnapshot: null,
          deliveryToken: null,
          deliveryLeaseExpiresAt: null,
        },
      });
      if (consumed.count !== 1)
        throw new ReviewError("conflict", "Review invitation changed");
      const content = {
        id: createWeleticId("wstorerev_"),
        requestId: request.id,
        title: patch.title,
        body: patch.body,
      };
      const review = await tx.weleticStoreReview.create({
        data: {
          ...content,
          storeId,
          shopperId,
          source: "invitation",
          rating: patch.rating,
          displayName: patch.displayName,
          locale: patch.locale,
          verifiedPurchase: true,
          status: settings.autoPublish ? "published" : "pending",
          publishedAt: settings.autoPublish ? now : null,
          ...(request.incentivePolicyId
            ? {
                participationStatus: "validated",
                participationValidatedAt: now,
                participationValidationRevision: "store_purchase_abuse_v1",
                participationContentDigest:
                  storeReviewParticipationContentDigest(content),
              }
            : {}),
        },
      });
      if (request.incentivePolicyId)
        await reserveStoreReviewIncentiveInTransaction({
          tx,
          storeId,
          reviewId: review.id,
          generation,
        });
      return { status: "received" as const, duplicate: false };
    },
    expectedInstallationGeneration,
  );
}

/** Authorized merchant caller owns the store mutation fence and actor receipt.
 * Display decisions never revoke awards; audit and optimistic update are atomic.
 */
export async function moderateStoreReviewWithAuditInTransaction({
  tx,
  storeId,
  generation,
  actor: actorInput,
  input,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  generation: string;
  actor: unknown;
  input: unknown;
}) {
  const patch = auditedReviewModerationInputSchema.parse(input);
  const actor = reviewModerationActorSchema.parse(actorInput);
  if (
    !generation ||
    (actor.kind === "shopify" && actor.installationGeneration !== generation)
  )
    throw new ReviewError("conflict", "Installation changed before moderation");
  const [module, settings, before] = await Promise.all([
    tx.weleticReviewSettings.findUnique({ where: { storeId } }),
    tx.weleticStoreReviewSettings.findUnique({ where: { storeId } }),
    tx.weleticStoreReview.findFirst({
      where: { id: patch.reviewId, storeId },
      include: { request: { include: storeReviewRequestInclude } },
    }),
  ]);
  if (!module?.enabled || !settings?.enabled)
    throw new ReviewError("disabled", "Store reviews unavailable");
  if (
    !before ||
    before.redactedAt ||
    before.status === "redacted" ||
    !before.shopperId ||
    before.source !== "invitation" ||
    !before.request ||
    before.request.shopperId !== before.shopperId
  )
    throw new ReviewError("not_found", "Store review unavailable");
  if (before.version !== patch.version)
    throw new ReviewError("conflict", "Store review changed");
  assertStoreReviewRequestLineBindings(before.request);
  assertStoreReviewPurchaseIdentity(before.request, generation);
  await assertReviewPurchaseNotSuppressed(tx, before.request);
  await replaceReviewOwnerPrivacyProjection({
    tx,
    storeId,
    shopperId: before.shopperId,
    installationGeneration: generation,
  });
  const status = patch.status ?? before.status;
  const merchantReply =
    patch.merchantReply === undefined
      ? before.merchantReply
      : patch.merchantReply;
  const updated = await tx.weleticStoreReview.updateMany({
    where: { id: before.id, storeId, version: patch.version, redactedAt: null },
    data: {
      status,
      merchantReply,
      version: { increment: 1 },
      moderatedAt: new Date(),
      publishedAt:
        status === "published"
          ? before.publishedAt ?? new Date()
          : before.publishedAt,
    },
  });
  if (updated.count !== 1)
    throw new ReviewError("conflict", "Store review changed");
  const auditId = createWeleticId("wstoreaudit_");
  await tx.weleticStoreReviewModerationAudit.create({
    data: {
      id: auditId,
      storeId,
      reviewId: before.id,
      actorKind: actor.kind,
      actorUserId: actor.userId,
      appId: actor.kind === "shopify" ? actor.appId : null,
      installationGeneration: generation,
      merchantActionId:
        actor.kind === "shopify" ? actor.merchantActionId : null,
      reasonCode: patch.reason,
      reasonDetails: patch.reasonDetails ?? null,
      fromVersion: before.version,
      toVersion: before.version + 1,
      fromStatus: before.status,
      toStatus: status,
      replyChanged: before.merchantReply !== merchantReply,
    },
  });
  return { reviewId: before.id, auditId, version: before.version + 1, status };
}
