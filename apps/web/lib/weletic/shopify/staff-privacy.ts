import type { Prisma } from "@prisma/client";

/** Caller holds the exact store lifecycle lock and has verified frozen/redacted
 * state. Staff writers acquire that same lock and deny either state. No customer
 * privacy request may erase staff data by equating customer and staff IDs.
 */
export async function purgeShopifyStaffPrivacyBatch(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  const take = 100;
  const grants = await tx.weleticShopifyStaffGrant.findMany({
    where: { storeId },
    orderBy: { id: "asc" },
    select: { id: true },
    take,
  });
  const actions = await tx.weleticShopifyMerchantAction.findMany({
    where: { storeId },
    orderBy: { id: "asc" },
    select: { id: true },
    take,
  });
  const automationGrants = await tx.weleticShopifyFlowPointsGrant.findMany({
    where: {
      storeId,
      OR: [
        { approvedByShopifyUserId: { not: null } },
        { revokedByShopifyUserId: { not: null } },
      ],
    },
    orderBy: { id: "asc" },
    select: { id: true },
    take,
  });
  const translationAudits = await tx.weleticReviewTranslationAudit.findMany({
    where: { storeId, actorShopifyUserId: { not: null } },
    orderBy: { id: "asc" },
    select: { id: true },
    take,
  });
  if (grants.length)
    await tx.weleticShopifyStaffGrant.deleteMany({
      where: { storeId, id: { in: grants.map(({ id }) => id) } },
    });
  if (actions.length)
    await tx.weleticShopifyMerchantAction.deleteMany({
      where: { storeId, id: { in: actions.map(({ id }) => id) } },
    });
  // Keep immutable authority, consumed budgets and durable replay receipts.
  // Only frozen-shop erasure reaches this function, never customer erasure.
  if (automationGrants.length)
    await tx.weleticShopifyFlowPointsGrant.updateMany({
      where: { storeId, id: { in: automationGrants.map(({ id }) => id) } },
      data: {
        approvedByShopifyUserId: null,
        revokedByShopifyUserId: null,
        staffRedactedAt: new Date(),
      },
    });
  if (translationAudits.length)
    await tx.weleticReviewTranslationAudit.updateMany({
      where: { storeId, id: { in: translationAudits.map(({ id }) => id) } },
      data: { actorShopifyUserId: null, staffRedactedAt: new Date() },
    });
  // Require a subsequent empty read before finalization, including when exactly
  // one page remained. Retries restart at the first remaining ID without skips.
  return {
    pending:
      grants.length > 0 ||
      actions.length > 0 ||
      automationGrants.length > 0 ||
      translationAudits.length > 0,
  };
}
