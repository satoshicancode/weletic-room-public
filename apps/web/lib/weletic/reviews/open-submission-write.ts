import { createWeleticId } from "@/lib/weletic/ids";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { isCoreLaunch } from "../core-launch-policy";
import { ReviewError } from "./contracts";
import { REVIEW_FLOW_HANDLES } from "./flow-contract";
import { enqueueReviewFlowEvent } from "./flow-producer";
import { attachOpenReviewPhotos } from "./open-media-attachment";
import { readCurrentOpenReviewPolicy } from "./open-policy-history";
import { ensureOpenReviewAuthorInTransaction } from "./open-submission-author";
import {
  classifyOpenReviewReplay,
  openReviewSubmissionEvidence,
  openReviewSubmissionSchema,
} from "./open-submission-contract";
import { openReviewRateCountWhere } from "./open-submission-policy";
import { withReviewMutation } from "./transaction";

const identitySchema = z
  .object({
    shopifyCustomerId: z.string().min(1).max(64),
    email: z.string().max(320).nullable(),
    source: z.enum(["app_proxy", "customer_account"]),
  })
  .strict();

/** Internal submission transaction, not an authentication endpoint.
 * The mandatory callback verifies the current Shopify customer for this store
 * and generation. Never construct its identity from shopper content JSON.
 * The callback must be transaction-local and replay-safe: the store fence can
 * rerun it after deadlock rollback. Perform no external sends or mutations here.
 * Submission, provenance, attachment and Flow enqueue commit atomically.
 */
export async function submitOpenReview({
  storeId,
  installationGeneration,
  input,
  authorize,
}: {
  storeId: string;
  installationGeneration: string;
  input: unknown;
  authorize: (
    tx: Prisma.TransactionClient,
  ) => Promise<z.infer<typeof identitySchema>>;
}) {
  if (isCoreLaunch())
    throw new ReviewError(
      "disabled",
      "Open reviews are unavailable in the core launch",
    );
  z.string().min(1).max(191).parse(storeId);
  const data = openReviewSubmissionSchema.parse(input);
  if (data.expectedInstallationGeneration !== installationGeneration)
    throw new ReviewError("conflict", "Installation changed");
  return withReviewMutation(
    storeId,
    async (tx) => {
      const identity = identitySchema.parse(await authorize(tx));
      const settings = await readCurrentOpenReviewPolicy(tx, storeId);
      if (
        !settings.policy.enabled ||
        settings.installationGeneration !== installationGeneration
      )
        throw new ReviewError("disabled", "Open reviews are unavailable");
      const { shopperId } = await ensureOpenReviewAuthorInTransaction({
        tx,
        storeId,
        installationGeneration,
        customer: {
          shopifyCustomerId: identity.shopifyCustomerId,
          email: identity.email,
        },
      });
      const evidence = openReviewSubmissionEvidence(
        { storeId, shopperId, installationGeneration, source: identity.source },
        data,
      );
      const previous = await tx.$queryRaw<
        Array<{
          idempotencyKey: string;
          contentDigest: string | null;
          redactedAt: Date | null;
          shopperId: string;
          installationGeneration: string;
          ownerId: string;
          reviewStatus: string;
        }>
      >(Prisma.sql`
      SELECT s.idempotencyKey, s.contentDigest, s.redactedAt, s.shopperId,
        s.installationGeneration, r.shopperId AS ownerId, r.status AS reviewStatus
      FROM WeleticOpenReviewSubmission s
      INNER JOIN WeleticProductReview r ON r.id = s.reviewId AND r.storeId = s.storeId
      WHERE s.storeId = ${storeId} AND s.idempotencyKey = ${evidence.idempotencyKey}
      LIMIT 1 FOR UPDATE
    `);
      if (previous.length) {
        const row = previous[0];
        if (
          row.shopperId !== shopperId ||
          row.ownerId !== shopperId ||
          row.installationGeneration !== installationGeneration ||
          row.reviewStatus === "redacted" ||
          classifyOpenReviewReplay(row, evidence) === "suppressed"
        )
          throw new ReviewError("not_found", "Review unavailable");
        if (classifyOpenReviewReplay(row, evidence) !== "duplicate")
          throw new ReviewError("conflict", "Submission identity already used");
        return { status: "received" as const, duplicate: true };
      }
      if (settings.revision !== data.expectedSettingsRevision)
        throw new ReviewError("conflict", "Open review policy changed");
      if (data.mediaIds.length && !settings.policy.photoUploadsEnabled)
        throw new ReviewError(
          "unavailable",
          "Open review photos are unavailable",
        );
      const products = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM WeleticShopifyProduct WHERE storeId = ${storeId}
        AND externalId = ${data.productId} AND status = 'active' LIMIT 1 FOR UPDATE
    `);
      if (!products.length)
        throw new ReviewError("not_found", "Product unavailable");
      const clocks = await tx.$queryRaw<Array<{ now: Date }>>(
        Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
      );
      const now = clocks[0]?.now;
      const where = openReviewRateCountWhere({ storeId, shopperId, now });
      const recent = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM WeleticOpenReviewSubmission WHERE storeId = ${storeId}
        AND shopperId = ${shopperId} AND createdAt > ${where.createdAt.gt}
      LIMIT ${settings.policy.maxSubmissionsPer24Hours} FOR UPDATE
    `);
      if (recent.length >= settings.policy.maxSubmissionsPer24Hours)
        throw new ReviewError(
          "unavailable",
          "Open review submission limit reached",
        );
      const reviewId = createWeleticId("wreview_");
      await tx.weleticProductReview.create({
        data: {
          id: reviewId,
          storeId,
          shopperId,
          productId: products[0].id,
          requestId: null,
          rating: data.rating,
          title: data.title,
          body: data.body,
          displayName: data.displayName,
          status: "pending",
          verifiedPurchase: false,
          incentivized: false,
          rewardStatus: "ineligible",
          rewardReason: "open_unrewarded",
          createdAt: now,
        },
      });
      await attachOpenReviewPhotos({
        tx,
        scope: {
          storeId,
          shopperId,
          installationGeneration,
          source: identity.source,
        },
        productId: products[0].id,
        submissionKey: evidence.idempotencyKey,
        settingsRevision: settings.revision,
        reviewId,
        mediaIds: data.mediaIds,
      });
      await tx.weleticOpenReviewSubmission.create({
        data: {
          id: createWeleticId("wrevsource_"),
          storeId,
          reviewId,
          shopperId,
          installationGeneration,
          source: identity.source,
          ...evidence,
          settingsRevision: settings.revision,
          disclosureRevision: data.disclosureRevision,
          locale: data.locale,
          createdAt: now,
        },
      });
      await enqueueReviewFlowEvent({
        tx,
        storeId,
        generation: installationGeneration,
        event: {
          handle: REVIEW_FLOW_HANDLES.SUBMITTED,
          reviewId,
          version: 1,
          occurredAt: now.toISOString(),
          rating: data.rating,
          verifiedPurchase: false,
        },
      });
      return { status: "received" as const, duplicate: false };
    },
    installationGeneration,
  );
}
