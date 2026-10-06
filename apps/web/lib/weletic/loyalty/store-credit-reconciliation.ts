import { prisma } from "@/lib/prisma";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { enqueueOutboxJobFromProgramTransaction } from "@/lib/weletic/loyalty/outbox";
import { withLoyaltyProgramRowLock } from "@/lib/weletic/loyalty/program-write-fence";
import { readLoyaltyRedemptionProvisioningSnapshot } from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import { compensateDiscountSaga } from "@/lib/weletic/loyalty/saga";
import { resolveShopifyOfflineCredentials } from "@/lib/weletic/loyalty/shopify-discounts";
import {
  auditShopifyCustomerStoreCreditTransactions,
  sameMoney,
  type ShopifyCustomerStoreCreditTransaction,
} from "@/lib/weletic/loyalty/shopify-financial-rewards";
import { minorUnitsToDecimal } from "@/lib/weletic/money";
import {
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
} from "@prisma/client";

export const DEFAULT_STORE_CREDIT_RECONCILIATION_HORIZON_MS = 5 * 60 * 1000;

export type StoreCreditReconciliationOutcome =
  | { outcome: "confirmed"; transactionId: string }
  | { outcome: "refunded_and_failed" }
  | { outcome: "deferred" }
  | { outcome: "skipped"; reason: string };

/**
 * Reconciles a pending Store Credit redemption that encountered network or
 * post-dispatch transport ambiguity (REMOTE_OUTCOME_UNKNOWN).
 *
 * Checks Shopify Admin GraphQL customer store credit transactions:
 * - If confirmed on Shopify: transitions to 'issued', binds transaction ID, preserves points deduction.
 * - If absent and horizon expired: transitions to 'failed', refunds points to customer ledger, syncs storefront metafield.
 * - If absent and horizon active: defers to future sweep.
 */
export async function reconcilePendingStoreCreditRedemption({
  storeId,
  redemptionId,
  now = new Date(),
  reconciliationHorizonMs = DEFAULT_STORE_CREDIT_RECONCILIATION_HORIZON_MS,
  loyaltyMaintenancePermit,
  customFetch,
}: {
  storeId: string;
  redemptionId: string;
  now?: Date;
  reconciliationHorizonMs?: number;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  customFetch?: typeof fetch;
}): Promise<StoreCreditReconciliationOutcome> {
  const redemption = await prisma.weleticRewardRedemption.findUnique({
    where: { id: redemptionId },
    include: {
      account: {
        include: {
          shopper: true,
        },
      },
      shopper: true,
    },
  });

  if (!redemption || redemption.storeId !== storeId) {
    return { outcome: "skipped", reason: "not_found" };
  }

  if (redemption.status !== WeleticRedemptionStatus.provisioning) {
    return { outcome: "skipped", reason: `status_${redemption.status}` };
  }

  if (redemption.artifactKind !== WeleticRewardArtifactKind.store_credit) {
    return { outcome: "skipped", reason: "not_store_credit" };
  }

  const snapshot = readLoyaltyRedemptionProvisioningSnapshot(
    redemption.metadata,
  );
  if (
    !snapshot ||
    snapshot.rewardType !== "store_credit" ||
    !snapshot.discountValue
  ) {
    return { outcome: "skipped", reason: "missing_snapshot" };
  }

  const customerId =
    redemption.account?.shopper?.shopifyCustomerId ||
    redemption.shopper?.shopifyCustomerId;
  if (!customerId) {
    return { outcome: "skipped", reason: "missing_customer_id" };
  }

  const credentials = await resolveShopifyOfflineCredentials({
    storeId,
    customFetch,
  });

  const transactions = await auditShopifyCustomerStoreCreditTransactions({
    credentials,
    customerId,
    customFetch,
  });

  const expectedCurrency = snapshot.shopCurrency;
  const expectedDecimalAmount = minorUnitsToDecimal(
    BigInt(snapshot.discountValue),
    expectedCurrency,
  );

  const attemptTimeStr = (redemption.metadata as Record<string, unknown> | null)
    ?.remoteProvisionAttemptedAt;
  const remoteAttemptAt =
    typeof attemptTimeStr === "string" ? new Date(attemptTimeStr) : null;
  const attemptBase = remoteAttemptAt ?? redemption.createdAt;

  // Bounded proximity window around remote provision attempt / creation time
  const minCreatedAt = new Date(attemptBase.getTime() - 120_000);
  const maxCreatedAt = new Date(
    Math.max(attemptBase.getTime() + 10 * 60_000, now.getTime() + 60_000),
  );

  let matchingTx: ShopifyCustomerStoreCreditTransaction | null = null;
  for (const tx of transactions) {
    if (tx.currencyCode.toUpperCase() !== expectedCurrency.toUpperCase()) {
      continue;
    }
    if (!sameMoney(tx.amount, expectedDecimalAmount)) {
      continue;
    }
    if (tx.createdAt < minCreatedAt || tx.createdAt > maxCreatedAt) {
      continue;
    }

    // Collision check: verify transaction ID is not bound to another redemption in database
    const bound = await prisma.weleticRewardRedemption.findFirst({
      where: {
        storeId: redemption.storeId,
        shopifyStoreCreditTransactionId: tx.id,
        id: { not: redemption.id },
      },
      select: { id: true },
    });
    if (bound) {
      continue;
    }

    matchingTx = tx;
    break;
  }

  if (matchingTx) {
    await withLoyaltyProgramRowLock({
      storeId,
      mode: "active",
      loyaltyMaintenancePermit,
      operation: async (tx) => {
        const updateResult = await tx.weleticRewardRedemption.updateMany({
          where: {
            id: redemption.id,
            storeId,
            status: WeleticRedemptionStatus.provisioning,
          },
          data: {
            status: WeleticRedemptionStatus.issued,
            shopifyStoreCreditTransactionId: matchingTx.id,
            issuanceConfirmedAt: now,
          },
        });

        if (updateResult.count === 0) {
          return;
        }

        if (redemption.accountId) {
          await enqueueFlowTriggerJob({
            storeId,
            eventId: redemption.id,
            payload: {
              accountId: redemption.accountId,
              handle: "weletic-reward-redeemed",
              rewardType: "store_credit",
              discountCode: redemption.shopifyDiscountCode,
              pointsSpent: redemption.pointsSpent.toString(),
            },
            loyaltyMaintenancePermit,
            tx,
          });

          await enqueueOutboxJobFromProgramTransaction({
            storeId,
            jobType: "METAFIELD_SYNC",
            payload: {
              accountId: redemption.accountId,
              triggerReason: "financial_reward_redemption_issued",
            },
            idempotencyKey: `metafield_sync:redeem:${redemption.id}`,
            loyaltyMaintenancePermit,
            tx,
          });

          if (redemption.expiresAt) {
            await enqueueOutboxJobFromProgramTransaction({
              storeId,
              jobType: "REDEMPTION_RECOVERY",
              payload: {
                redemptionId: redemption.id,
                accountId: redemption.accountId,
                rewardDefinitionId: redemption.rewardDefinitionId,
                pointsCost: redemption.pointsSpent.toString(),
                shopifyDiscountCode: redemption.shopifyDiscountCode,
                artifactKind: WeleticRewardArtifactKind.store_credit,
                attemptCount: 0,
                sagaPhase: "expiry",
              },
              scheduledFor: redemption.expiresAt,
              idempotencyKey: `redemption_expiry:${redemption.id}`,
              loyaltyMaintenancePermit,
              tx,
            });
          }
        }
      },
    });

    return { outcome: "confirmed", transactionId: matchingTx.id };
  }

  // No matching transaction found on Shopify: evaluate reconciliation horizon
  const horizonBase = remoteAttemptAt ?? redemption.createdAt;
  const isHorizonExpired =
    now.getTime() - horizonBase.getTime() >= reconciliationHorizonMs;

  if (isHorizonExpired) {
    await compensateDiscountSaga({
      redemptionId: redemption.id,
      reason: `Store credit remote outcome reconciliation timed out after ${Math.round(reconciliationHorizonMs / 1000)}s without matching Shopify transaction`,
      targetStatus: WeleticRedemptionStatus.failed,
      loyaltyMaintenancePermit,
    });

    return { outcome: "refunded_and_failed" };
  }

  // Horizon is still active: defer for future sweep
  return { outcome: "deferred" };
}

/**
 * Sweeps all store credit redemptions currently stuck in provisioning.
 * Filters for records at least 60 seconds old to avoid racing with active sagas.
 */
export async function reconcilePendingStoreCreditRedemptionsSweep({
  batchSize = 50,
  now = new Date(),
  reconciliationHorizonMs = DEFAULT_STORE_CREDIT_RECONCILIATION_HORIZON_MS,
  customFetch,
}: {
  batchSize?: number;
  now?: Date;
  reconciliationHorizonMs?: number;
  customFetch?: typeof fetch;
} = {}): Promise<{
  scanned: number;
  confirmed: number;
  refunded: number;
  deferred: number;
  errors: number;
  details: Array<{
    redemptionId: string;
    outcome: string;
    error?: string;
  }>;
}> {
  const cutoff = new Date(now.getTime() - 60_000);
  const pendingRedemptions = await prisma.weleticRewardRedemption.findMany({
    where: {
      artifactKind: WeleticRewardArtifactKind.store_credit,
      status: WeleticRedemptionStatus.provisioning,
      createdAt: { lte: cutoff },
    },
    take: batchSize,
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      storeId: true,
    },
  });

  let confirmed = 0;
  let refunded = 0;
  let deferred = 0;
  let errors = 0;
  const details: Array<{
    redemptionId: string;
    outcome: string;
    error?: string;
  }> = [];

  for (const item of pendingRedemptions) {
    try {
      const result = await reconcilePendingStoreCreditRedemption({
        storeId: item.storeId,
        redemptionId: item.id,
        now,
        reconciliationHorizonMs,
        customFetch,
      });

      if (result.outcome === "confirmed") {
        confirmed++;
      } else if (result.outcome === "refunded_and_failed") {
        refunded++;
      } else if (result.outcome === "deferred") {
        deferred++;
      }

      details.push({ redemptionId: item.id, outcome: result.outcome });
    } catch (err: any) {
      errors++;
      details.push({
        redemptionId: item.id,
        outcome: "error",
        error: err?.message || String(err),
      });
    }
  }

  return {
    scanned: pendingRedemptions.length,
    confirmed,
    refunded,
    deferred,
    errors,
    details,
  };
}
