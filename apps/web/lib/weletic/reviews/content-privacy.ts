import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import type { Prisma } from "@prisma/client";

export function reviewContentRedactionWhere(
  storeId: string,
  shopperId?: string,
) {
  return {
    storeId,
    ...(shopperId ? { shopperId } : {}),
    OR: [
      { status: { not: "redacted" } },
      { redactedAt: null },
      { title: { not: "" } },
      { body: { not: "" } },
      { displayName: { not: "Redacted customer" } },
      { merchantReply: { not: null } },
      { moderatedByUserId: { not: null } },
      { participationStatus: { not: "privacy_redacted" } },
      { participationValidatedAt: { not: null } },
      { participationValidationRevision: { not: null } },
      { participationContentDigest: { not: null } },
    ],
  } satisfies Prisma.WeleticProductReviewWhereInput;
}

/** Caller holds the store/customer privacy fence. Discover content by its own
 * owner, not through an invitation. Preserve financial fields and source links.
 * This also repairs partially redacted content without reissuing any reward.
 */
export async function redactReviewContentBatch(
  tx: Prisma.TransactionClient,
  storeId: string,
  shopperId?: string,
) {
  const where = reviewContentRedactionWhere(storeId, shopperId);
  const rows = await tx.weleticProductReview.findMany({
    where,
    orderBy: { id: "asc" },
    take: 20,
    select: { id: true, productId: true, version: true, redactedAt: true },
  });
  for (const row of rows) {
    if (
      !Number.isInteger(row.version) ||
      row.version < 1 ||
      row.version > 2147483647
    )
      throw new Error("Invalid review version during privacy erasure");
    const result = await tx.weleticProductReview.updateMany({
      where: { ...where, id: row.id, version: row.version },
      data: {
        status: "redacted",
        // Redacted status independently rejects all content writers. Saturating
        // the terminal version prevents signed-Int exhaustion blocking erasure.
        version: Math.min(row.version + 1, 2147483647),
        title: "",
        body: "",
        displayName: "Redacted customer",
        merchantReply: null,
        moderatedByUserId: null,
        participationStatus: "privacy_redacted",
        participationValidatedAt: null,
        participationValidationRevision: null,
        participationContentDigest: null,
        redactedAt: row.redactedAt ?? new Date(),
      },
    });
    if (result.count !== 1)
      throw new Error("Review content changed during privacy erasure");
    await enqueueOutboxJob({
      tx,
      storeId,
      jobType: "REVIEW_SUMMARY_SYNC",
      payload: { productId: row.productId },
      idempotencyKey: `review_privacy_content:${row.id}:${row.version}`,
    });
  }
}
