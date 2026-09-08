import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  canonicalizeLoyaltyDiscountCode,
  getLoyaltyDiscountOwnershipFingerprint,
} from "./redemption-discount-identity";
import { DIRECT_REVIEW_REWARD_SOURCE } from "./reward-ownership";

const KIND = "coupon_use_retention";
const FAILURE_KIND = "coupon_use_retention_failure";
const KEY = "shop_financial_retention_v1";
class CouponRetentionReviewRequiredError extends Error {}
const progressSchema = z
  .object({
    version: z.literal(1),
    installationGeneration: z.string().min(1),
    retentionUntil: z.string().datetime(),
    afterId: z.string().nullable(),
    deletedCount: z.number().int().nonnegative(),
    blockedCount: z.number().int().nonnegative(),
    scanComplete: z.boolean(),
  })
  .strict();
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Shop erasure retains pseudonymous financial facts until the store's saved
 * deadline. This sweep never shortens that deadline from current environment
 * settings. Store locking fences reinstall, settlement, and competing sweepers.
 * Reconciliation progress supplies a durable keyset cursor; blocked facts are
 * retained for an operator rather than repeatedly starving later valid rows.
 */
export async function purgeExpiredShopperCouponUsesPage({
  storeId,
  batchSize = 20,
  now = new Date(),
}: {
  storeId: string;
  batchSize?: number;
  now?: Date;
}) {
  if (!Number.isFinite(batchSize) || !Number.isFinite(now.getTime()))
    throw new Error("Invalid coupon retention bounds");
  const take = Math.max(1, Math.min(100, Math.trunc(batchSize)));
  return prisma.$transaction(
    async (tx) => {
      const stores = await tx.$queryRaw<
        Array<{
          id: string;
          complianceState: string;
          installationGeneration: string | null;
          redactedAt: Date | null;
          financialRetentionUntil: Date | null;
        }>
      >`
      SELECT id, complianceState, installationGeneration, redactedAt, financialRetentionUntil
      FROM WeleticShopifyStore WHERE id = ${storeId} LIMIT 1 FOR UPDATE`;
      const store = stores[0];
      if (
        !store ||
        store.complianceState !== "redacted" ||
        !store.redactedAt ||
        !store.financialRetentionUntil ||
        store.financialRetentionUntil > now ||
        !store.installationGeneration
      )
        return {
          status: "not_due" as const,
          scanned: 0,
          deleted: 0,
          blocked: 0,
        };
      const previous = await tx.weleticReconciliationIssue.findUnique({
        where: {
          storeId_kind_externalKey: { storeId, kind: KIND, externalKey: KEY },
        },
      });
      const initial = {
        version: 1 as const,
        installationGeneration: store.installationGeneration,
        retentionUntil: store.financialRetentionUntil.toISOString(),
        afterId: null,
        deletedCount: 0,
        blockedCount: 0,
        scanComplete: false,
      };
      // A resolved operator finding starts a fresh scan. An open cursor never
      // silently changes owners, deadline, or installation generation.
      const parsed = previous
        ? progressSchema.safeParse(previous.details)
        : null;
      if (parsed && !parsed.success)
        throw new CouponRetentionReviewRequiredError(
          "Coupon retention progress is malformed",
        );
      const saved = parsed?.success ? parsed.data : null;
      const progress =
        previous?.status === "open" && saved
          ? saved
          : { ...initial, deletedCount: saved?.deletedCount ?? 0 };
      if (
        saved &&
        (saved.installationGeneration !== store.installationGeneration ||
          saved.retentionUntil !== store.financialRetentionUntil.toISOString())
      )
        throw new CouponRetentionReviewRequiredError(
          "Coupon retention scope changed; operator reconciliation required",
        );
      if (progress.scanComplete && progress.blockedCount)
        return {
          status: "manual_reconciliation" as const,
          scanned: 0,
          deleted: 0,
          blocked: progress.blockedCount,
        };
      const rows = await tx.weleticRewardCouponUse.findMany({
        where: {
          storeId,
          ...(progress.afterId ? { id: { gt: progress.afterId } } : {}),
        },
        orderBy: { id: "asc" },
        take: take + 1,
      });
      const page = rows.slice(0, take);
      if (
        page.length === 0 &&
        previous?.status === "resolved" &&
        saved?.scanComplete &&
        saved.blockedCount === 0
      )
        return {
          status: "completed" as const,
          scanned: 0,
          deleted: 0,
          blocked: 0,
        };
      let deleted = 0,
        blocked = 0;
      for (const use of page) {
        const redemption = await tx.weleticRewardRedemption.findFirst({
          where: { id: use.redemptionId, storeId },
        });
        const cleanup = await tx.weleticShopifyVoucherCleanup.findUnique({
          where: {
            storeId_redemptionId: { storeId, redemptionId: use.redemptionId },
          },
        });
        const snapshot = object(cleanup?.ownershipSnapshot);
        let verified = false;
        if (
          redemption &&
          redemption.accountId === null &&
          redemption.shopperId === use.shopperId &&
          redemption.pointsSpent === BigInt(0) &&
          redemption.ledgerEntryId === null &&
          redemption.fulfillmentSource === DIRECT_REVIEW_REWARD_SOURCE &&
          redemption.fulfillmentReference &&
          redemption.artifactKind === "discount_code" &&
          ["used", "cancelled", "expired", "failed"].includes(
            redemption.status,
          ) &&
          use.installationGeneration === store.installationGeneration &&
          use.source === "shopify_orders_paid" &&
          cleanup?.status === "completed" &&
          cleanup.completedAt &&
          cleanup.remoteVerifiedAt &&
          cleanup.remoteDeactivatedAt &&
          ["used_preserved", "deactivated", "verified_absent"].includes(
            cleanup.remoteOutcome ?? "",
          ) &&
          typeof cleanup.expectedDiscountId === "string" &&
          /^gid:\/\/shopify\/DiscountCodeNode\/[1-9]\d{0,29}$/.test(
            cleanup.expectedDiscountId,
          ) &&
          (redemption.shopifyDiscountId === null ||
            redemption.shopifyDiscountId === cleanup.expectedDiscountId) &&
          snapshot.version === 2 &&
          snapshot.kind === "shopper" &&
          snapshot.captureError === null &&
          snapshot.installationGeneration === use.installationGeneration &&
          snapshot.shopperId === use.shopperId &&
          snapshot.claimId === redemption.fulfillmentReference
        ) {
          try {
            verified =
              cleanup.expectedDiscountCodeCanonical ===
                canonicalizeLoyaltyDiscountCode(
                  redemption.shopifyDiscountCode,
                ) &&
              snapshot.ownershipFingerprint ===
                getLoyaltyDiscountOwnershipFingerprint({
                  storeId,
                  redemptionId: redemption.id,
                  ownerKind: "shopper",
                  shopperId: use.shopperId,
                  fulfillmentSource: DIRECT_REVIEW_REWARD_SOURCE,
                  fulfillmentReference: redemption.fulfillmentReference,
                  rewardDefinitionId: redemption.rewardDefinitionId,
                  discountCode: redemption.shopifyDiscountCode,
                });
          } catch {
            verified = false;
          }
        }
        if (!verified) {
          blocked++;
          continue;
        }
        deleted += (
          await tx.weleticRewardCouponUse.deleteMany({
            where: {
              id: use.id,
              storeId,
              redemptionId: use.redemptionId,
              shopperId: use.shopperId,
              installationGeneration: store.installationGeneration,
            },
          })
        ).count;
      }
      const next = {
        ...progress,
        afterId: page.at(-1)?.id ?? progress.afterId,
        deletedCount: progress.deletedCount + deleted,
        blockedCount: progress.blockedCount + blocked,
        scanComplete: rows.length <= take,
      };
      const completed = next.scanComplete && next.blockedCount === 0;
      await tx.weleticReconciliationIssue.upsert({
        where: {
          storeId_kind_externalKey: { storeId, kind: KIND, externalKey: KEY },
        },
        create: {
          id: createWeleticId("wrecon_"),
          storeId,
          kind: KIND,
          externalKey: KEY,
          severity: next.blockedCount ? "critical" : "info",
          status: completed ? "resolved" : "open",
          details: next,
          detectedAt: now,
          resolvedAt: completed ? now : null,
        },
        update: {
          severity: next.blockedCount ? "critical" : "info",
          status: completed ? "resolved" : "open",
          details: next,
          resolvedAt: completed ? now : null,
        },
      });
      return {
        status: completed
          ? ("completed" as const)
          : next.scanComplete
            ? ("manual_reconciliation" as const)
            : ("pending" as const),
        scanned: page.length,
        deleted,
        blocked,
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    },
  );
}

export async function deleteExpiredShopperCouponUsesBatch({
  batchSize = 20,
  now = new Date(),
}: {
  batchSize?: number;
  now?: Date;
} = {}) {
  if (!Number.isFinite(batchSize) || !Number.isFinite(now.getTime()))
    throw new Error("Invalid coupon retention bounds");
  const budget = Math.max(1, Math.min(100, Math.trunc(batchSize)));
  const stores = await prisma.weleticShopifyStore.findMany({
    where: {
      complianceState: "redacted",
      redactedAt: { not: null },
      financialRetentionUntil: { lte: now },
      AND: [
        { installationGeneration: { not: null } },
        { installationGeneration: { not: "" } },
      ],
      rewardCouponUses: { some: {} },
      NOT: {
        reconciliationIssues: {
          some: {
            externalKey: KEY,
            status: "open",
            OR: [
              { kind: KIND, details: { path: "$.scanComplete", equals: true } },
              { kind: FAILURE_KIND },
            ],
          },
        },
      },
    },
    orderBy: [{ financialRetentionUntil: "asc" }, { id: "asc" }],
    take: Math.min(10, budget),
    select: { id: true },
  });
  const results: Array<{
    storeId: string;
    status: string;
    scanned: number;
    deleted: number;
    blocked: number;
  }> = [];
  const perStore = Math.max(1, Math.floor(budget / Math.max(1, stores.length)));
  for (const store of stores) {
    try {
      results.push({
        storeId: store.id,
        ...(await purgeExpiredShopperCouponUsesPage({
          storeId: store.id,
          batchSize: perStore,
          now,
        })),
      });
    } catch (error) {
      if (error instanceof CouponRetentionReviewRequiredError) {
        // Keep the malformed/original financial progress intact. This separate
        // diagnostic prevents an unprocessable oldest store starving the queue.
        await prisma.weleticReconciliationIssue.upsert({
          where: {
            storeId_kind_externalKey: {
              storeId: store.id,
              kind: FAILURE_KIND,
              externalKey: KEY,
            },
          },
          create: {
            id: createWeleticId("wrecon_"),
            storeId: store.id,
            kind: FAILURE_KIND,
            externalKey: KEY,
            status: "open",
            severity: "critical",
            detectedAt: now,
            details: {
              version: 1,
              reason: "retention_progress_requires_operator_review",
            },
          },
          update: { status: "open", resolvedAt: null },
        });
      }
      results.push({
        storeId: store.id,
        status: "failed",
        scanned: 0,
        deleted: 0,
        blocked: 0,
      });
    }
  }
  return {
    selectedStores: stores.length,
    deleted: results.reduce((sum, row) => sum + row.deleted, 0),
    results,
  };
}
