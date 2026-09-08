import { prisma } from "@/lib/prisma";
import { getLoyaltyDiscountOwnershipFingerprint } from "@/lib/weletic/loyalty/redemption-discount-identity";
import { DIRECT_REVIEW_REWARD_SOURCE } from "@/lib/weletic/loyalty/reward-ownership";
import { z } from "zod";
import {
  reviewInvalidationAwardSchema,
  reviewInvalidationSnapshotSchema,
} from "./incentive-decision";
import {
  reviewIncentivePolicyDigest,
  reviewIncentivePolicySnapshotSchema,
} from "./incentive-policy";

/** Observed paid-order discount cost, not face value or causal revenue loss.
 * Pending provider reconciliation and missing allocations never become zero.
 * Financial reporting must supply its configured accounting currency.
 */
export async function readInvalidatedReviewCouponCost({
  storeId,
  invalidationId,
  accountingCurrency,
}: {
  storeId: string;
  invalidationId: string;
  accountingCurrency: string;
}) {
  if (!new Set(Intl.supportedValuesOf("currency")).has(accountingCurrency))
    throw new Error("A supported accounting currency is required");
  return prisma.$transaction(async (tx) => {
    const invalidation = await tx.weleticReviewIncentiveInvalidation.findFirst({
      where: { id: invalidationId, storeId },
      include: {
        claim: { include: { policy: true } },
        cleanup: true,
        store: {
          select: { complianceState: true, financialRetentionUntil: true },
        },
      },
    });
    if (!invalidation) throw new Error("Owned invalidation is unavailable");
    const unavailable = (
      reason: string,
      observedMinor: string | null = null,
      recordedUses = 0,
    ) => ({
      dataQuality: "unavailable" as const,
      reason,
      currency: accountingCurrency,
      observedMinor,
      unrecoverableMinor: null,
      recordedUses,
    });
    const snapshot = reviewInvalidationSnapshotSchema.parse(
      invalidation.decisionSnapshot,
    );
    if (snapshot.award.kind !== "coupon" || !snapshot.redemptionId)
      return unavailable("not_coupon_award");
    const policy = reviewIncentivePolicySnapshotSchema.safeParse(
      invalidation.claim.policy.snapshot,
    );
    const award = reviewInvalidationAwardSchema.safeParse(
      invalidation.claim.awardSnapshot,
    );
    if (
      invalidation.claim.storeId !== storeId ||
      invalidation.claim.policyId !== snapshot.policyId ||
      invalidation.claim.sourceReviewId !== snapshot.sourceReviewId ||
      invalidation.claim.policy.storeId !== storeId ||
      invalidation.claim.policy.contentDigest !== snapshot.policyDigest ||
      !policy.success ||
      reviewIncentivePolicyDigest(policy.data) !== snapshot.policyDigest ||
      policy.data.award.kind !== "coupon" ||
      JSON.stringify(policy.data.award) !== JSON.stringify(snapshot.award) ||
      !award.success ||
      JSON.stringify(award.data) !== JSON.stringify(snapshot.award) ||
      invalidation.claim.shopperId !== invalidation.shopperId ||
      !["invalidated", "privacy_redacted"].includes(invalidation.claim.status)
    )
      return unavailable("claim_ownership_unavailable");
    if (
      invalidation.store.complianceState === "redacted" &&
      invalidation.store.financialRetentionUntil &&
      invalidation.store.financialRetentionUntil <= new Date()
    )
      return unavailable("financial_retention_expired");
    const uses = await tx.weleticRewardCouponUse.findMany({
      where: { storeId, redemptionId: snapshot.redemptionId },
      orderBy: { id: "asc" },
      take: 1001,
    });
    if (uses.length > 1000)
      return unavailable("usage_page_limit_exceeded", null, uses.length);
    if (
      uses.some(
        (use) =>
          use.shopperId !== invalidation.shopperId ||
          use.installationGeneration !== invalidation.installationGeneration ||
          use.source !== "shopify_orders_paid",
      )
    )
      return unavailable("usage_ownership_unavailable", null, uses.length);
    if (
      uses.some(
        (use) =>
          use.discountAmountMinor === null ||
          use.amountUnavailableReason !== null ||
          use.discountAmountMinor < BigInt(0),
      )
    )
      return unavailable("allocation_unavailable", null, uses.length);
    if (uses.some((use) => use.currency !== accountingCurrency))
      return unavailable("accounting_currency_mismatch", null, uses.length);
    const observedMinor = uses
      .reduce(
        (total, use) => total + (use.discountAmountMinor ?? BigInt(0)),
        BigInt(0),
      )
      .toString();
    const cleanup = invalidation.cleanup;
    const redemption = await tx.weleticRewardRedemption.findFirst({
      where: { storeId, id: snapshot.redemptionId },
    });
    const owner = z
      .object({
        version: z.literal(2),
        kind: z.literal("shopper"),
        shopperId: z.literal(invalidation.shopperId),
        claimId: z.literal(invalidation.claimId),
        installationGeneration: z.literal(invalidation.installationGeneration),
        ownershipFingerprint: z.string(),
        captureError: z.null(),
        remoteProvisionAttemptedAt: z.string().datetime().nullable(),
        remoteProvisionReconcileUntil: z.string().datetime().nullable(),
      })
      .safeParse(cleanup?.ownershipSnapshot);
    if (
      !cleanup ||
      cleanup.storeId !== storeId ||
      cleanup.redemptionId !== snapshot.redemptionId ||
      cleanup.id !== invalidation.cleanupId ||
      !redemption ||
      redemption.accountId !== null ||
      redemption.shopperId !== invalidation.shopperId ||
      redemption.fulfillmentSource !== DIRECT_REVIEW_REWARD_SOURCE ||
      redemption.fulfillmentReference !== invalidation.claimId ||
      redemption.pointsSpent !== BigInt(0) ||
      redemption.ledgerEntryId !== null ||
      redemption.artifactKind !== "discount_code" ||
      redemption.rewardDefinitionId !==
        snapshot.award.terms.rewardDefinitionId ||
      !owner.success ||
      owner.data.ownershipFingerprint !==
        getLoyaltyDiscountOwnershipFingerprint({
          storeId,
          redemptionId: redemption.id,
          ownerKind: "shopper",
          shopperId: invalidation.shopperId,
          fulfillmentSource: DIRECT_REVIEW_REWARD_SOURCE,
          fulfillmentReference: invalidation.claimId,
          rewardDefinitionId: redemption.rewardDefinitionId,
          discountCode: redemption.shopifyDiscountCode,
        })
    )
      return unavailable(
        "cleanup_ownership_unavailable",
        observedMinor,
        uses.length,
      );
    if (
      cleanup.status !== "completed" ||
      invalidation.outcome === "pending" ||
      !invalidation.completedAt
    )
      return unavailable("recovery_pending", observedMinor, uses.length);
    if (
      cleanup.remoteUsageCount !== null &&
      (!Number.isSafeInteger(cleanup.remoteUsageCount) ||
        cleanup.remoteUsageCount < 0)
    )
      return unavailable(
        "provider_evidence_unavailable",
        observedMinor,
        uses.length,
      );
    if (
      (cleanup.remoteUsageCount !== null &&
        cleanup.remoteUsageCount > uses.length) ||
      (cleanup.remoteOutcome === "used_preserved" && uses.length === 0)
    )
      return unavailable("unsettled_provider_uses", observedMinor, uses.length);
    if (
      !(
        ["deactivated", "used_preserved"].includes(
          cleanup.remoteOutcome ?? "",
        ) &&
        cleanup.remoteUsageCount !== null &&
        cleanup.completedAt &&
        cleanup.remoteUsageObservedAt &&
        cleanup.remoteVerifiedAt &&
        cleanup.remoteDeactivationStartedAt &&
        cleanup.remoteDeactivatedAt
      ) &&
      !(
        cleanup.remoteOutcome === "verified_absent" &&
        invalidation.outcome === "coupon_absent" &&
        cleanup.completedAt &&
        ((cleanup.expectedDiscountId &&
          cleanup.remoteVerifiedAt &&
          cleanup.remoteDeactivationStartedAt &&
          cleanup.remoteDeactivatedAt &&
          cleanup.remoteUsageObservedAt &&
          cleanup.remoteUsageCount !== null) ||
          (!cleanup.expectedDiscountId &&
            !redemption.shopifyDiscountId &&
            owner.data.remoteProvisionAttemptedAt === null &&
            owner.data.remoteProvisionReconcileUntil === null &&
            uses.length === 0))
      )
    )
      return unavailable(
        "provider_evidence_unavailable",
        observedMinor,
        uses.length,
      );
    return {
      dataQuality: "available" as const,
      reason: null,
      currency: accountingCurrency,
      observedMinor,
      unrecoverableMinor: observedMinor,
      recordedUses: uses.length,
    };
  });
}
