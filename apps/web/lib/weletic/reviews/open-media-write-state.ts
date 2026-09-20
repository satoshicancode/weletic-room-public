import { Prisma } from "@prisma/client";
import { ReviewError } from "./contracts";
import { OpenPhotoCleanupReconciliationRequired } from "./open-media-errors";

/** Lock the media before its ownership row, matching cleanup. This is a durable
 * remote-write claim, not a lease that may be assumed safe after a timeout.
 */
export async function claimOpenPhotoStorageWrite(
  tx: Prisma.TransactionClient,
  storeId: string,
  mediaId: string,
  token: string,
) {
  const media = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticReviewMedia WHERE storeId = ${storeId} AND id = ${mediaId}
      AND requestId IS NULL AND reviewId IS NULL AND status = 'reserved'
      AND uploadExpiresAt > CURRENT_TIMESTAMP(3) FOR UPDATE
  `);
  if (media.length !== 1)
    throw new ReviewError("conflict", "Photo reservation changed");
  const changed = await tx.weleticOpenReviewMediaOwnership.updateMany({
    where: {
      storeId,
      mediaId,
      storageWriteState: "not_started",
      storageWriteToken: null,
      redactedAt: null,
    },
    data: { storageWriteState: "in_flight", storageWriteToken: token },
  });
  if (changed.count !== 1)
    throw new ReviewError(
      "unavailable",
      "Photo storage outcome requires reconciliation",
    );
}

/** Only the process that awaited a successful PUT may call confirmed. A HEAD
 * miss or an elapsed lease does not prove that an earlier request cannot commit.
 * This evidence write remains allowed after operational admission is revoked.
 */
export async function recordOpenPhotoStorageOutcome(
  tx: Prisma.TransactionClient,
  storeId: string,
  mediaId: string,
  token: string,
  outcome: "confirmed" | "ambiguous",
) {
  const changed = await tx.weleticOpenReviewMediaOwnership.updateMany({
    where: {
      storeId,
      mediaId,
      storageWriteToken: token,
      storageWriteState: "in_flight",
    },
    data: { storageWriteState: outcome },
  });
  if (changed.count !== 1)
    throw new ReviewError(
      "unavailable",
      "Photo storage evidence requires reconciliation",
    );
}

/** Caller holds the media row lock until its cleanup-state CAS commits. A
 * missing/mixed owner or an unresolved PUT cannot be declared safe to delete.
 */
export async function assertReviewPhotoStorageSettled(
  tx: Prisma.TransactionClient,
  storeId: string,
  mediaId: string,
  requestId: string | null,
) {
  const owners = await tx.$queryRaw<
    Array<{ storageWriteState: string }>
  >(Prisma.sql`
    SELECT storageWriteState FROM WeleticOpenReviewMediaOwnership
    WHERE storeId = ${storeId} AND mediaId = ${mediaId} FOR UPDATE
  `);
  if (
    requestId === null &&
    owners.length === 1 &&
    ["in_flight", "ambiguous"].includes(owners[0].storageWriteState)
  )
    throw new OpenPhotoCleanupReconciliationRequired();
  if (
    (requestId === null && owners.length !== 1) ||
    (requestId !== null && owners.length !== 0) ||
    owners.some(
      ({ storageWriteState }) =>
        !["not_started", "confirmed"].includes(storageWriteState),
    )
  )
    throw new ReviewError(
      "unavailable",
      "Photo storage outcome requires reconciliation",
    );
}
