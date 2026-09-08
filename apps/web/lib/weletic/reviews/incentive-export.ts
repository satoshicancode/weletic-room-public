import type { Prisma } from "@prisma/client";

// Shopper transparency without exposing merchant staff identifiers or leases.
export const reviewIncentiveInvalidationExportSelect = {
  id: true,
  claimId: true,
  decisionId: true,
  reason: true,
  decisionSnapshot: true,
  outcome: true,
  completedAt: true,
  createdAt: true,
} satisfies Prisma.WeleticReviewIncentiveInvalidationSelect;

// Only promises associated with this shopper's invitation/claim are exported.
// Do not include another shopper's claims or any invitation bearer/lease fields.
export const reviewIncentivePolicyExportSelect = {
  id: true,
  revision: true,
  snapshot: true,
  createdAt: true,
} satisfies Prisma.WeleticReviewIncentivePolicySelect;

export const reviewIncentiveClaimExportSelect = {
  id: true,
  orderId: true,
  policyId: true,
  sourceReviewId: true,
  subjectType: true,
  status: true,
  awardSnapshot: true,
  validationSnapshot: true,
  createdAt: true,
} satisfies Prisma.WeleticReviewIncentiveClaimSelect;

/** Keep every owned claim even if its policy relation is damaged. Resolve
 * promises separately within the store, never silently omit the financial row
 * or follow an unscoped foreign policy identifier.
 */
export async function attachReviewIncentivePolicyExports<
  T extends { policyId: string },
>({
  rows,
  storeId,
  db,
}: {
  rows: T[];
  storeId: string;
  db: Pick<Prisma.TransactionClient, "weleticReviewIncentivePolicy">;
}) {
  const policies = rows.length
    ? await db.weleticReviewIncentivePolicy.findMany({
        where: {
          storeId,
          id: { in: [...new Set(rows.map(({ policyId }) => policyId))] },
        },
        select: reviewIncentivePolicyExportSelect,
      })
    : [];
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  return rows.map((row) => ({
    ...row,
    policy: byId.get(row.policyId) ?? null,
    policyUnavailableReason: byId.has(row.policyId)
      ? null
      : "same_store_policy_not_found",
  }));
}

export const reviewParticipationExportSelect = {
  participationStatus: true,
  participationValidatedAt: true,
  participationValidationRevision: true,
  participationContentDigest: true,
} satisfies Prisma.WeleticProductReviewSelect;
