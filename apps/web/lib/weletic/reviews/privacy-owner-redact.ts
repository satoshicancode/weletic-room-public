import { Prisma } from "@prisma/client";

/** Internal privacy primitive, called only within an authorized erasure
 * transaction. Privacy must also work for frozen shops. Lock ordering matches
 * operational writers; erasure callers must atomically pseudonymize the owned
 * source. A bounded backfill may also record suppression after the source guard
 * proves existing authoritative redaction under the same transaction locks;
 * that does not claim completion of the source-erasure privacy workflow.
 */
export async function redactReviewOwnerPrivacyProjection({
  tx,
  storeId,
  shopperId,
  redactedAt = new Date(),
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  shopperId: string;
  redactedAt?: Date;
}) {
  if (!storeId || !shopperId || !Number.isFinite(redactedAt.getTime()))
    throw new Error("Review owner privacy erasure scope unavailable");
  const stores = await tx.$queryRaw<
    Array<{ id: string; installationGeneration: string | null }>
  >`
    SELECT id, installationGeneration FROM WeleticShopifyStore
    WHERE id = ${storeId} FOR UPDATE
  `;
  if (stores.length !== 1 || stores[0].id !== storeId)
    throw new Error("Review owner privacy erasure store unavailable");
  const owners = await tx.$queryRaw<Array<{ id: string; storeId: string }>>`
    SELECT id, storeId FROM WeleticShopper
    WHERE storeId = ${storeId} AND id = ${shopperId} FOR UPDATE
  `;
  if (
    owners.length !== 1 ||
    owners[0].id !== shopperId ||
    owners[0].storeId !== storeId
  )
    throw new Error("Review owner privacy erasure owner unavailable");
  const previous = await tx.$queryRaw<Array<{ redactedAt: Date | null }>>`
    SELECT redactedAt FROM WeleticReviewOwnerPrivacyCoverage
    WHERE storeId = ${storeId} AND shopperId = ${shopperId} FOR UPDATE
  `;
  const scope = { storeId, shopperId };
  const data = {
    installationGeneration: stores[0].installationGeneration,
    state: "redacted" as const,
    keySetDigest: null,
    sourceDigest: null,
    identityCount: 0,
    redactedAt: previous[0]?.redactedAt ?? redactedAt,
  };
  await tx.weleticReviewOwnerPrivacyCoverage.upsert({
    where: { storeId_shopperId: scope },
    create: { ...scope, ...data },
    update: data,
  });
  await tx.weleticReviewOwnerPrivacyIdentity.deleteMany({ where: scope });
}
