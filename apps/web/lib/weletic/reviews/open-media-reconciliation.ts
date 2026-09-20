import { prisma } from "@/lib/prisma";
import { storage } from "@/lib/storage";
import { Prisma } from "@prisma/client";
import { REVIEW_MAX_PHOTO_BYTES, ReviewError } from "./contracts";
import { openPhotoUploadProof } from "./open-media-proof";

type Reservation = {
  id: string;
  objectKey: string;
  sizeBytes: number;
  contentType: string;
  requestId: string | null;
  reviewId: string | null;
  status: string;
};
type Owner = {
  id: string;
  storageWriteState: string;
  storageWriteToken: string | null;
  shopperId: string;
  productId: string;
  installationGeneration: string;
  source: string;
  submissionKey: string;
  settingsRevision: number;
};
async function readAttempt(
  tx: Prisma.TransactionClient,
  storeId: string,
  mediaId: string,
) {
  const rows = await tx.$queryRaw<Reservation[]>(Prisma.sql`
    SELECT id, objectKey, sizeBytes, contentType, requestId, reviewId, status
    FROM WeleticReviewMedia WHERE storeId = ${storeId} AND id = ${mediaId} FOR UPDATE
  `);
  if (rows.length !== 1)
    throw new ReviewError("not_found", "Photo unavailable");
  const media = rows[0];
  const owners = await tx.$queryRaw<Owner[]>(Prisma.sql`
    SELECT id, storageWriteState, storageWriteToken, shopperId, productId,
      installationGeneration, source, submissionKey, settingsRevision
    FROM WeleticOpenReviewMediaOwnership WHERE storeId = ${storeId} AND mediaId = ${mediaId} FOR UPDATE
  `);
  if (media.requestId !== null || owners.length !== 1)
    throw new ReviewError(
      "unavailable",
      "Photo ownership requires reconciliation",
    );
  const owner = owners[0];
  if (
    media.objectKey !== `weletic/reviews/${storeId}/${mediaId}.webp` ||
    media.contentType !== "image/webp" ||
    !Number.isInteger(media.sizeBytes) ||
    media.sizeBytes < 1 ||
    media.sizeBytes > REVIEW_MAX_PHOTO_BYTES ||
    !owner.storageWriteToken ||
    !/^[0-9a-f]{64}$/.test(owner.storageWriteToken) ||
    !["app_proxy", "customer_account"].includes(owner.source)
  )
    throw new ReviewError("unavailable", "Photo write evidence unavailable");
  return { media, owner };
}

/** Internal recovery, not a public API or shopper authorization mechanism.
 * A positive direct-R2 observation may settle an exact one-shot write even after
 * privacy redaction/admission removal. It never restores content or attaches,
 * publishes, uploads or deletes. Missing/legacy metadata remains unresolved.
 */
export async function reconcileOpenReviewPhotoStorage(
  storeId: string,
  mediaId: string,
) {
  const before = await prisma.$transaction((tx) =>
    readAttempt(tx, storeId, mediaId),
  );
  if (before.owner.storageWriteState === "confirmed")
    return { status: "confirmed" as const };
  if (
    !["in_flight", "ambiguous"].includes(before.owner.storageWriteState) ||
    before.media.status !== "reserved" ||
    before.media.reviewId !== null
  )
    throw new ReviewError("unavailable", "Photo write cannot be reconciled");
  const metadata = await storage.headPrivateR2Object(before.media.objectKey);
  if (
    !metadata ||
    metadata.contentType !== before.media.contentType ||
    metadata.sizeBytes !== before.media.sizeBytes ||
    metadata.uploadProof !==
      openPhotoUploadProof(storeId, mediaId, before.owner.storageWriteToken!)
  )
    return { status: "unresolved" as const };
  await prisma.$transaction(async (tx) => {
    const after = await readAttempt(tx, storeId, mediaId);
    // Privacy may scrub content in parallel; never restore it. Every immutable
    // attempt/ownership field must still agree before using remote evidence.
    if (
      JSON.stringify(after.media) !== JSON.stringify(before.media) ||
      Object.keys(before.owner).some(
        (field) =>
          field !== "storageWriteState" &&
          before.owner[field as keyof Owner] !==
            after.owner[field as keyof Owner],
      )
    )
      throw new ReviewError(
        "conflict",
        "Photo write changed during reconciliation",
      );
    if (after.owner.storageWriteState === "confirmed") return;
    if (!["in_flight", "ambiguous"].includes(after.owner.storageWriteState))
      throw new ReviewError(
        "conflict",
        "Photo write changed during reconciliation",
      );
    const changed = await tx.weleticOpenReviewMediaOwnership.updateMany({
      where: {
        storeId,
        mediaId,
        id: after.owner.id,
        storageWriteToken: before.owner.storageWriteToken,
        storageWriteState: after.owner.storageWriteState,
      },
      data: { storageWriteState: "confirmed" },
    });
    if (changed.count !== 1)
      throw new ReviewError(
        "conflict",
        "Photo write changed during reconciliation",
      );
  });
  return { status: "confirmed" as const };
}
