import type { Prisma } from "@prisma/client";
import { createWeleticId } from "../ids";
import { ReviewError } from "./contracts";
import {
  auditedReviewModerationInputSchema,
  auditedReviewModerationResponseSchema,
  reviewModerationActorSchema,
} from "./moderation-contract";
import { moderateNativeReviewInTransaction } from "./service";

/** Internal only: caller must authenticate and hold the review mutation fence
 * on this transaction. Audit failure intentionally rolls back all side effects.
 * No historical reasons are inferred and no compatibility writer is redirected.
 */
export async function moderateReviewWithAuditInTransaction({
  tx,
  storeId,
  generation,
  actor: actorInput,
  input,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  generation: string | null;
  actor: unknown;
  input: unknown;
}) {
  const patch = auditedReviewModerationInputSchema.parse(input);
  const actor = reviewModerationActorSchema.parse(actorInput);
  if (actor.kind === "shopify" && actor.installationGeneration !== generation)
    throw new ReviewError("conflict", "Installation changed before moderation");
  const before = await tx.weleticProductReview.findFirst({
    where: { storeId, id: patch.reviewId, product: { storeId } },
    select: { id: true, version: true, status: true, merchantReply: true },
  });
  if (!before || before.status === "redacted")
    throw new ReviewError("not_found", "Review unavailable");
  const after = await moderateNativeReviewInTransaction({
    tx,
    storeId,
    generation,
    reviewId: before.id,
    // Compatibility display column must not misidentify a Shopify user as a
    // workspace User. Explicit provenance is retained in the audit below.
    userId: actor.kind === "workspace" ? actor.userId : null,
    input: {
      version: patch.version,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.merchantReply !== undefined
        ? { merchantReply: patch.merchantReply }
        : {}),
    },
  });
  const auditId = createWeleticId("wrevaudit_");
  await tx.weleticReviewModerationAudit.create({
    data: {
      id: auditId,
      storeId,
      reviewId: before.id,
      actorKind: actor.kind,
      actorUserId: actor.userId,
      appId: actor.kind === "shopify" ? actor.appId : null,
      installationGeneration:
        actor.kind === "shopify" ? actor.installationGeneration : null,
      merchantActionId:
        actor.kind === "shopify" ? actor.merchantActionId : null,
      reasonCode: patch.reason,
      reasonDetails: patch.reasonDetails ?? null,
      fromVersion: before.version,
      toVersion: after.version,
      fromStatus: before.status,
      toStatus: after.status,
      replyChanged: before.merchantReply !== after.merchantReply,
    },
  });
  return auditedReviewModerationResponseSchema.parse({
    reviewId: after.id,
    auditId,
    version: after.version,
    status: after.status,
  });
}
