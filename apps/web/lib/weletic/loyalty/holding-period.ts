import { prisma } from "@/lib/prisma";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma, WeleticPointsLedgerEntryType } from "@prisma/client";
import { reconcilePersistedOrderMerchandiseRefunds } from "./earn";
import { enqueueFlowTriggerJob } from "./flow-trigger-outbox";
import {
  appendPointsLedgerEntry,
  appendPointsLedgerEntryWithReceipt,
  OptimisticConcurrencyError,
} from "./ledger";
import { allocateReversalAcrossRemainingLines } from "./line-reversal-allocation";
import { enqueueOutboxJob } from "./outbox";
import { enqueuePurchasePointsCommunication } from "./points-communication-producer";
import { scheduleTierReviewAfterQualifyingActivity } from "./tier-review-scheduling";

const HOLDING_RELEASE_TRANSACTION_RETRIES = 5;

function isRetryableHoldingReleaseError(error: unknown) {
  return (
    error instanceof OptimisticConcurrencyError ||
    (error instanceof Prisma.PrismaClientKnownRequestError &&
      ["P2002", "P2034"].includes(error.code))
  );
}

export interface HoldingPeriodJobPayload {
  orderId?: string;
  accountId?: string;
  shopperId?: string;
  pendingPoints?: string | bigint;
  holdingPeriodDays?: number;
  availableAt?: string;
  grantId?: string;
  sourceOrderExternalId?: string;
}

export interface ReleaseHoldingPeriodGrantParams {
  payload?: HoldingPeriodJobPayload;
  grantId?: string;
  orderId?: string;
  accountId?: string;
  storeId?: string;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx?: Prisma.TransactionClient;
}

/**
 * Releases a pending loyalty earn grant whose holding period has matured.
 * Safely decrements cachedPendingPoints, credits cachedPointsBalance via EARN_ORDER ledger entry,
 * transitions the grant status to 'settled', and enqueues METAFIELD_SYNC.
 */
export async function releaseHoldingPeriodGrant(
  params: ReleaseHoldingPeriodGrantParams,
) {
  const {
    payload,
    grantId: directGrantId,
    orderId: directOrderId,
    tx,
  } = params;
  const db = tx ?? prisma;

  const targetGrantId = payload?.grantId || directGrantId;
  const targetOrderId = payload?.orderId || directOrderId;

  const execute = async (client: Prisma.TransactionClient) => {
    if (params.storeId) {
      await assertShopifyStoreAcceptsOperationalWrites({
        storeId: params.storeId,
        action: "holding_period_release",
        expectedInstallationGeneration: params.expectedInstallationGeneration,
        loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
        tx: client,
      });
    }
    // 1. Fetch grant by ID or by Order ID
    const grant = targetGrantId
      ? await client.weleticLoyaltyEarnGrant.findUnique({
          where: { id: targetGrantId },
          include: {
            order: { include: { refunds: { include: { lines: true } } } },
            lineEarns: true,
          },
        })
      : targetOrderId && params.storeId
        ? await client.weleticLoyaltyEarnGrant.findUnique({
            where: {
              storeId_orderId: {
                storeId: params.storeId,
                orderId: targetOrderId,
              },
            },
            include: {
              order: { include: { refunds: { include: { lines: true } } } },
              lineEarns: true,
            },
          })
        : null;

    if (!grant) {
      return { released: false, reason: "grant_not_found" };
    }

    if (!params.storeId && grant.storeId) {
      await assertShopifyStoreAcceptsOperationalWrites({
        storeId: grant.storeId,
        action: "holding_period_release",
        expectedInstallationGeneration: params.expectedInstallationGeneration,
        loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
        tx: client,
      });
    }

    if (params.storeId && grant.storeId !== params.storeId) {
      throw new Error(
        `Loyalty earn grant ${grant.id} does not belong to Shopify store ${params.storeId}`,
      );
    }
    if (payload?.accountId && grant.accountId !== payload.accountId) {
      throw new Error(
        `Loyalty earn grant ${grant.id} does not belong to account ${payload.accountId}`,
      );
    }

    // 2. A partially reversed grant can still have pending points that must
    // mature after the refunded portion was voided. All terminal states skip.
    if (grant.status !== "pending" && grant.status !== "partially_reversed") {
      return {
        released: false,
        reason: `grant_already_${grant.status}`,
        grantId: grant.id,
      };
    }

    const pointsToRelease = grant.pendingPoints;
    if (pointsToRelease <= BigInt(0)) {
      if (grant.status === "partially_reversed") {
        return {
          released: false,
          reason: "grant_already_partially_reversed",
          grantId: grant.id,
        };
      }

      const zeroPendingClaim = await client.weleticLoyaltyEarnGrant.updateMany({
        where: {
          id: grant.id,
          storeId: grant.storeId,
          status: grant.status,
          pendingPoints: pointsToRelease,
        },
        data: { status: "settled", settledAt: new Date() },
      });
      if (zeroPendingClaim.count !== 1) {
        throw new OptimisticConcurrencyError(
          `Holding-period grant conflict for ${grant.id}`,
        );
      }
      return { released: false, reason: "zero_pending_points" };
    }

    // A fully refunded or voided order must never mature into spendable points.
    // Refund webhooks normally transition the grant first; this is the
    // fail-closed recovery path when the order projection arrives earlier.
    if (grant.order.status === "voided" || grant.order.status === "refunded") {
      const currentSettled = BigInt(grant.settledPoints ?? 0);
      const currentReversed = BigInt(grant.reversedPoints ?? 0);
      const lineAllocations = allocateReversalAcrossRemainingLines({
        grantId: grant.id,
        storeId: grant.storeId,
        grossPoints: BigInt(grant.grossPoints),
        alreadyReversedPoints: currentReversed,
        pointsToAllocate: pointsToRelease,
        lineEarns: grant.lineEarns,
      });

      // Lock source allocations in a stable order. Every update is a CAS on
      // the exact reversed-points snapshot and rolls back with the grant and
      // ledger if any concurrent refund has already claimed the line.
      for (const allocation of lineAllocations) {
        const lineClaim = await client.weleticLoyaltyOrderLineEarn.updateMany({
          where: {
            id: allocation.id,
            grantId: grant.id,
            storeId: grant.storeId,
            reversedPoints: allocation.reversedPoints,
          },
          data: {
            reversedPoints:
              allocation.reversedPoints + allocation.pointsToReverse,
          },
        });
        if (lineClaim.count !== 1) {
          throw new OptimisticConcurrencyError(
            `Holding-period line void conflict for ${allocation.id}`,
          );
        }
      }

      const voidClaim = await client.weleticLoyaltyEarnGrant.updateMany({
        where: {
          id: grant.id,
          storeId: grant.storeId,
          status: grant.status,
          pendingPoints: pointsToRelease,
          settledPoints: currentSettled,
          reversedPoints: currentReversed,
        },
        data: {
          status: "voided",
          pendingPoints: BigInt(0),
          reversedPoints: currentReversed + pointsToRelease,
          voidedAt: new Date(),
        },
      });

      if (voidClaim.count !== 1) {
        throw new OptimisticConcurrencyError(
          `Holding-period void conflict for loyalty earn grant ${grant.id}`,
        );
      }

      await appendPointsLedgerEntry({
        storeId: grant.storeId,
        accountId: grant.accountId,
        entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
        pointsDelta: BigInt(0),
        pendingDelta: -pointsToRelease,
        grantId: grant.id,
        referenceType: "COMMERCE_ORDER",
        referenceId: grant.orderId,
        idempotencyKey: `holding_void:${grant.orderId}`,
        reason: `Pending points voided for ${grant.order.status} order ${grant.order?.orderName || grant.order?.externalId || grant.orderId}`,
        metadata: {
          grantId: grant.id,
          orderId: grant.orderId,
          pendingVoided: pointsToRelease.toString(),
          orderStatus: grant.order.status,
          lineReversals: lineAllocations.map((allocation) => ({
            orderLineId: allocation.orderLineId,
            points: allocation.pointsToReverse.toString(),
          })),
        },
        tx: client,
      });

      await enqueueOutboxJob({
        storeId: grant.storeId,
        jobType: "METAFIELD_SYNC",
        payload: {
          accountId: grant.accountId,
          triggerReason: "holding_period_voided",
        },
        idempotencyKey: `metafield_sync:void:${grant.id}`,
        loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
        tx: client,
      });

      return {
        released: false,
        reason: `order_${grant.order.status}`,
        grantId: grant.id,
      };
    }

    // 3. Claim the exact pending grant snapshot before crediting it. The CAS
    // and ledger write share one serializable transaction, so a concurrent
    // refund can never be overwritten or resurrected as settled points.
    const currentSettled = BigInt(grant.settledPoints ?? 0);
    const currentReversed = BigInt(grant.reversedPoints ?? 0);
    const nextStatus =
      currentReversed > BigInt(0) ? "partially_reversed" : "settled";
    const releaseClaim = await client.weleticLoyaltyEarnGrant.updateMany({
      where: {
        id: grant.id,
        storeId: grant.storeId,
        status: grant.status,
        pendingPoints: pointsToRelease,
        settledPoints: currentSettled,
        reversedPoints: currentReversed,
      },
      data: {
        status: nextStatus,
        settledPoints: currentSettled + pointsToRelease,
        pendingPoints: BigInt(0),
        settledAt: new Date(),
      },
    });
    if (releaseClaim.count !== 1) {
      throw new OptimisticConcurrencyError(
        `Holding-period release conflict for loyalty earn grant ${grant.id}`,
      );
    }

    // 4. Append EARN_ORDER ledger entry with negative pending delta and positive points delta
    const idempotencyKey = `holding_release:${grant.orderId}`;
    const reason = `Holding period release for order ${grant.order?.orderName || grant.order?.externalId || grant.orderId}`;

    const receipt = await appendPointsLedgerEntryWithReceipt({
      storeId: grant.storeId,
      accountId: grant.accountId,
      entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
      pointsDelta: pointsToRelease,
      pendingDelta: -pointsToRelease,
      grantId: grant.id,
      referenceType: "COMMERCE_ORDER",
      referenceId: grant.orderId,
      idempotencyKey,
      reason,
      metadata: {
        grantId: grant.id,
        orderId: grant.orderId,
        grossPoints: grant.grossPoints.toString(),
        releasedPoints: pointsToRelease.toString(),
        selectedCampaignId: grant.selectedCampaignId ?? null,
        campaignMultiplier: grant.campaignMultiplier?.toString() ?? null,
      },
      tx: client,
    });
    const ledgerEntry = receipt.entry;
    await enqueueFlowTriggerJob({
      storeId: grant.storeId,
      eventId: ledgerEntry.id,
      payload: {
        accountId: grant.accountId,
        handle: "weletic-points-earned",
        pointsDelta: pointsToRelease.toString(),
        pointsBalance: ledgerEntry.balanceAfter.toString(),
        reason: "holding_period_release",
        orderId: grant.order.externalId,
      },
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
      tx: client,
    });

    // 5. Enqueue Metafield sync to push updated live balance to Shopify
    await enqueueOutboxJob({
      storeId: grant.storeId,
      jobType: "METAFIELD_SYNC",
      payload: {
        accountId: grant.accountId,
        triggerReason: "holding_period_release",
      },
      idempotencyKey: `metafield_sync:release:${grant.id}`,
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
      tx: client,
    });
    await scheduleTierReviewAfterQualifyingActivity({
      storeId: grant.storeId,
      accountId: grant.accountId,
      activityKey: `holding_release:${grant.id}`,
      reason: "held_order_points_released",
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
      tx: client,
    });

    await reconcilePersistedOrderMerchandiseRefunds({
      storeId: grant.storeId,
      refunds: grant.order.refunds || [],
      tx: client,
      expectedInstallationGeneration: params.expectedInstallationGeneration,
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
    });
    await enqueuePurchasePointsCommunication({
      tx: client,
      storeId: grant.storeId,
      programId: grant.programId,
      receipt,
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
    });
    return {
      released: true,
      grantId: grant.id,
      points: pointsToRelease,
      ledgerEntryId: ledgerEntry.id,
    };
  };

  if (tx) {
    return await execute(tx);
  }

  for (
    let attempt = 1;
    attempt <= HOLDING_RELEASE_TRANSACTION_RETRIES;
    attempt++
  ) {
    try {
      return await prisma.$transaction(execute, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      });
    } catch (error) {
      if (
        attempt === HOLDING_RELEASE_TRANSACTION_RETRIES ||
        !isRetryableHoldingReleaseError(error)
      ) {
        throw error;
      }
    }
  }

  throw new Error("Holding-period transaction retry budget exhausted");
}
