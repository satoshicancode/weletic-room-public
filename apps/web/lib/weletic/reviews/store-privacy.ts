import type { Prisma } from "@prisma/client";
import {
  storeReviewAuditRedactionData,
  storeReviewAuditRedactionWhere,
  storeReviewContentRedactionData,
  storeReviewContentRedactionWhere,
  storeReviewRequestRedactionData,
  storeReviewRequestRedactionWhere,
  type StoreReviewPrivacyScope,
} from "./store-privacy-contract";

const PAGE_SIZE = 20;

async function lockPrivacyStore(
  tx: Prisma.TransactionClient,
  scope: StoreReviewPrivacyScope,
) {
  // Validate identities before querying. No optional shopper-to-shop fallback.
  storeReviewContentRedactionWhere(scope);
  const stores = await tx.$queryRaw<Array<{ complianceState: string }>>`
    SELECT complianceState FROM WeleticShopifyStore
    WHERE id = ${scope.storeId} FOR UPDATE
  `;
  if (!stores[0]) throw new Error("Store-review privacy store unavailable");
  if (
    scope.kind === "frozen_store" &&
    !["frozen", "redacted"].includes(stores[0].complianceState)
  )
    throw new Error("Store-review privacy requires a frozen store");
}

/** Invitation-backed foundation only. The caller owns the transaction and
 * customer privacy/settlement fence. Source tables must exist: missing schema
 * is an error, never evidence of completed privacy work. This helper does not
 * certify delivery-provider, projection, media or imported-owner cleanup.
 * Those consumers must be connected before any store-review writer is enabled.
 */
export async function redactStoreReviewsBatch(
  tx: Prisma.TransactionClient,
  scope: StoreReviewPrivacyScope,
) {
  await lockPrivacyStore(tx, scope);
  const now = new Date();
  const contentWhere = storeReviewContentRedactionWhere(scope);
  const requestWhere = storeReviewRequestRedactionWhere(scope);
  const auditWhere = storeReviewAuditRedactionWhere(scope);
  const reviews = await tx.weleticStoreReview.findMany({
    where: contentWhere,
    orderBy: { id: "asc" },
    take: PAGE_SIZE,
    select: { id: true, version: true, redactedAt: true },
  });
  for (const row of reviews) {
    const changed = await tx.weleticStoreReview.updateMany({
      where: { ...contentWhere, id: row.id, version: row.version },
      data: storeReviewContentRedactionData(row, now),
    });
    if (changed.count !== 1)
      throw new Error("Store-review content changed during privacy erasure");
  }
  const requests = await tx.weleticStoreReviewRequest.findMany({
    where: requestWhere,
    orderBy: { id: "asc" },
    take: PAGE_SIZE,
    select: { id: true, cancelledAt: true },
  });
  for (const row of requests) {
    const changed = await tx.weleticStoreReviewRequest.updateMany({
      where: { ...requestWhere, id: row.id },
      data: storeReviewRequestRedactionData(row, now),
    });
    if (changed.count !== 1)
      throw new Error("Store-review request changed during privacy erasure");
  }
  const audits = await tx.weleticStoreReviewModerationAudit.findMany({
    where: auditWhere,
    orderBy: { id: "asc" },
    take: PAGE_SIZE,
    select: { id: true, redactedAt: true },
  });
  for (const row of audits) {
    const changed = await tx.weleticStoreReviewModerationAudit.updateMany({
      where: { ...auditWhere, id: row.id },
      data: storeReviewAuditRedactionData(row, now),
    });
    if (changed.count !== 1)
      throw new Error("Store-review audit changed during privacy erasure");
  }
  return {
    hasMore:
      (await tx.weleticStoreReview.findFirst({
        where: contentWhere,
        select: { id: true },
      })) !== null ||
      (await tx.weleticStoreReviewRequest.findFirst({
        where: requestWhere,
        select: { id: true },
      })) !== null ||
      (await tx.weleticStoreReviewModerationAudit.findFirst({
        where: auditWhere,
        select: { id: true },
      })) !== null,
  };
}

/** Frozen whole-store purge only, after source redaction. Bounded child-first
 * deletion leaves shared incentive claims and append-only financial rows alone.
 * Do not connect until external delivery/projection cleanup is also complete.
 */
export async function purgeStoreReviewsBatch(
  tx: Prisma.TransactionClient,
  storeId: string,
) {
  const scope = { kind: "frozen_store" as const, storeId };
  await lockPrivacyStore(tx, scope);
  if (
    (await tx.weleticStoreReview.findFirst({
      where: storeReviewContentRedactionWhere(scope),
      select: { id: true },
    })) !== null ||
    (await tx.weleticStoreReviewRequest.findFirst({
      where: storeReviewRequestRedactionWhere(scope),
      select: { id: true },
    })) !== null ||
    (await tx.weleticStoreReviewModerationAudit.findFirst({
      where: storeReviewAuditRedactionWhere(scope),
      select: { id: true },
    })) !== null
  )
    throw new Error("Store-review sources must be redacted before purge");

  // Explicit delegates retain generated Prisma input checking for each table.
  const audits = await tx.weleticStoreReviewModerationAudit.findMany({
    where: { storeId },
    orderBy: { id: "asc" },
    take: PAGE_SIZE,
    select: { id: true },
  });
  if (audits.length) {
    await tx.weleticStoreReviewModerationAudit.deleteMany({
      where: { storeId, id: { in: audits.map(({ id }) => id) } },
    });
    return { hasMore: true };
  }
  const reviews = await tx.weleticStoreReview.findMany({
    where: { storeId },
    orderBy: { id: "asc" },
    take: PAGE_SIZE,
    select: { id: true },
  });
  if (reviews.length) {
    await tx.weleticStoreReview.deleteMany({
      where: { storeId, id: { in: reviews.map(({ id }) => id) } },
    });
    return { hasMore: true };
  }
  const lines = await tx.weleticStoreReviewRequestLine.findMany({
    where: { storeId },
    orderBy: { id: "asc" },
    take: PAGE_SIZE,
    select: { id: true },
  });
  if (lines.length) {
    await tx.weleticStoreReviewRequestLine.deleteMany({
      where: { storeId, id: { in: lines.map(({ id }) => id) } },
    });
    return { hasMore: true };
  }
  const requests = await tx.weleticStoreReviewRequest.findMany({
    where: { storeId },
    orderBy: { id: "asc" },
    take: PAGE_SIZE,
    select: { id: true },
  });
  if (requests.length) {
    await tx.weleticStoreReviewRequest.deleteMany({
      where: { storeId, id: { in: requests.map(({ id }) => id) } },
    });
    return { hasMore: true };
  }
  await tx.weleticStoreReviewSettings.deleteMany({ where: { storeId } });
  return { hasMore: false };
}
