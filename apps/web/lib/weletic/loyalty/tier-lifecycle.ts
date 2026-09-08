import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { GENUINE_EARN_ENTRY_TYPES } from "@/lib/weletic/loyalty/ledger-entry-policy";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import { sumValidQualifyingPoints } from "@/lib/weletic/loyalty/qualifying-review-points";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import {
  Prisma,
  WeleticLoyaltyTierChangeReason,
  WeleticPointsLedgerEntryType,
  WeleticVipMilestoneMode,
  WeleticVipTimeframe,
} from "@prisma/client";

export type TierReviewPeriod = "ROLLING_12M" | "CALENDAR_YEAR" | "LIFETIME";

export type TierLifecycleStatus =
  | "MAINTAINED"
  | "PROMOTED"
  | "IN_GRACE_PERIOD"
  | "DEMOTED";

export interface EvaluateTierMaintenanceParams {
  storeId: string;
  accountId: string;
  reviewPeriod?: TierReviewPeriod | WeleticVipTimeframe;
  milestoneMode?: WeleticVipMilestoneMode | string;
  now?: Date;
  gracePeriodDays?: number;
  cycleYear?: number;
  expectedInstallationGeneration?: string | null;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx?: Prisma.TransactionClient;
}

export interface TierLifecycleResult {
  accountId: string;
  previousTierId: string | null;
  newTierId: string | null;
  status: TierLifecycleStatus;
  gracePeriodExpiresAt?: Date | null;
  qualifyingSpend: bigint;
  qualifyingPoints: bigint;
  reviewPeriod: TierReviewPeriod | WeleticVipTimeframe;
  reason: string;
  tierChanged: boolean;
  previousTierName?: string | null;
  newTierName?: string | null;
}

export interface BatchTierLifecycleResult {
  totalEvaluated: number;
  promoted: number;
  maintained: number;
  inGracePeriod: number;
  demoted: number;
  results: TierLifecycleResult[];
}

export interface NormalizedTier {
  id: string;
  name: string;
  slug?: string;
  tierOrder: number;
  minSpendThreshold: bigint;
  minPointsThreshold: bigint;
  pointsMultiplier?: number | Prisma.Decimal;
  entryBonusPoints?: bigint;
}

/**
 * Normalizes tier records across schema and mock types.
 */
function normalizeTier(tier: any): NormalizedTier {
  const tierOrder =
    typeof tier.tierOrder === "number"
      ? tier.tierOrder
      : typeof tier.rank === "number"
        ? tier.rank
        : 1;

  const minSpendThreshold =
    typeof tier.minSpendThreshold === "bigint"
      ? tier.minSpendThreshold
      : typeof tier.minSpendThreshold === "number"
        ? BigInt(tier.minSpendThreshold)
        : BigInt(0);

  const minPointsThreshold =
    typeof tier.minPointsThreshold === "bigint"
      ? tier.minPointsThreshold
      : typeof tier.minPointsThreshold === "number"
        ? BigInt(tier.minPointsThreshold)
        : BigInt(0);

  const entryBonusPoints =
    typeof tier.entryBonusPoints === "bigint"
      ? tier.entryBonusPoints
      : typeof tier.entryBonusPoints === "number"
        ? BigInt(tier.entryBonusPoints)
        : BigInt(0);

  return {
    id: tier.id,
    name: tier.name,
    slug: tier.slug,
    tierOrder,
    minSpendThreshold,
    minPointsThreshold,
    pointsMultiplier: tier.pointsMultiplier ?? 1.0,
    entryBonusPoints,
  };
}

async function allocateNextTierHistorySequence({
  db,
  accountId,
}: {
  db: Prisma.TransactionClient;
  accountId: string;
}) {
  const delegate = (
    db as Prisma.TransactionClient & {
      weleticLoyaltyTierHistory?: {
        findFirst?: (args: unknown) => Promise<{
          id: string;
          sequenceNumber: number | null;
        } | null>;
      };
    }
  ).weleticLoyaltyTierHistory;

  if (typeof delegate?.findFirst !== "function") {
    if (process.env.NODE_ENV === "test") {
      // Legacy focused mocks predate sequence allocation. Production Prisma
      // always exposes findFirst, so this compatibility path is test-only.
      return 1;
    }
    throw new Error(
      `Tier history sequence allocation is unavailable for loyalty account ${accountId}.`,
    );
  }

  const unsequencedHistory = await delegate.findFirst({
    where: { accountId, sequenceNumber: null },
    orderBy: [{ effectiveAt: "asc" }, { id: "asc" }],
    select: { id: true, sequenceNumber: true },
  });
  if (unsequencedHistory) {
    throw new Error(
      `Loyalty account ${accountId} has unsequenced tier history ${unsequencedHistory.id}; complete the earn-policy cutover before changing tiers.`,
    );
  }

  const latestHistory = await delegate.findFirst({
    where: { accountId, sequenceNumber: { not: null } },
    orderBy: { sequenceNumber: "desc" },
    select: { id: true, sequenceNumber: true },
  });
  const latestSequence = latestHistory?.sequenceNumber ?? 0;
  if (
    !Number.isSafeInteger(latestSequence) ||
    latestSequence < 0 ||
    latestSequence >= Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(
      `Loyalty account ${accountId} has an invalid tier history sequence.`,
    );
  }
  return latestSequence + 1;
}

/**
 * Computes start and end timestamps for the specified tier review timeframe.
 */
export function calculateTierReviewWindow(
  reviewPeriod: TierReviewPeriod | WeleticVipTimeframe | string,
  now: Date = new Date(),
  cycleYear?: number,
): { startDate: Date; endDate: Date } {
  const normalized = String(reviewPeriod).toUpperCase();

  if (normalized === "CALENDAR_YEAR") {
    const targetYear =
      cycleYear ??
      (now.getUTCMonth() === 0 && now.getUTCDate() <= 31
        ? now.getUTCFullYear() - 1
        : now.getUTCFullYear());

    const startDate = new Date(Date.UTC(targetYear, 0, 1, 0, 0, 0, 0));
    const endDate = new Date(Date.UTC(targetYear, 11, 31, 23, 59, 59, 999));
    return { startDate, endDate };
  }

  if (normalized === "LIFETIME") {
    return { startDate: new Date(0), endDate: now };
  }

  // Default: ROLLING_12M (365 days)
  const startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const endDate = now;
  return { startDate, endDate };
}

/**
 * Evaluates an account's VIP tier maintenance cycle against qualification requirements.
 * Supports ROLLING_12M, CALENDAR_YEAR, and LIFETIME cycles, 30-day soft-downgrade grace periods,
 * single-tier step-down demotions, entry bonus awarding, and audit logging to WeleticLoyaltyTierHistory.
 */
export async function evaluateTierMaintenanceCycle(
  params: EvaluateTierMaintenanceParams,
): Promise<TierLifecycleResult> {
  if (!params.tx) {
    const transaction = (
      prisma as typeof prisma & {
        $transaction?: typeof prisma.$transaction;
      }
    ).$transaction;
    if (!transaction && process.env.NODE_ENV === "test") {
      // Legacy focused mocks expose the delegates directly but predate the
      // transaction wrapper. Production Prisma always provides $transaction.
      return evaluateTierMaintenanceCycle({
        ...params,
        tx: prisma as unknown as Prisma.TransactionClient,
      });
    }
    return prisma.$transaction(
      (tx) => evaluateTierMaintenanceCycle({ ...params, tx }),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }
  const db = (params.tx || prisma) as any;
  const now = params.now ? new Date(params.now) : new Date();
  await assertShopifyStoreAcceptsOperationalWrites({
    storeId: params.storeId,
    action: "loyalty_tier_evaluation",
    expectedInstallationGeneration: params.expectedInstallationGeneration,
    loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
    tx: params.tx,
  });

  // 1. Fetch loyalty account with currentTier, shopper, and program
  const account = await db.weleticLoyaltyAccount.findUnique({
    where: { id: params.accountId },
    include: {
      currentTier: true,
      shopper: true,
      program: {
        include: {
          tiers: {
            where: { deletedAt: null },
            orderBy: { tierOrder: "asc" },
          },
        },
      },
    },
  });

  if (!account || account.storeId !== params.storeId) {
    throw new Error(
      `Loyalty account ${params.accountId} not found for store ${params.storeId}.`,
    );
  }

  const program = account.program;
  const effectiveReviewPeriod =
    params.reviewPeriod || program?.vipTimeframe || "rolling_12m";
  const effectiveMilestoneMode =
    params.milestoneMode || program?.vipMilestoneMode || "amount_spent";
  const effectiveGraceDays =
    params.gracePeriodDays ?? program?.vipDowngradeGraceDays ?? 30;
  const autoDowngradeEnabled =
    String(effectiveReviewPeriod).toUpperCase() !== "LIFETIME" &&
    program?.vipAutoDowngradeEnabled !== false;

  if (
    (account.status != null && account.status !== "active") ||
    hasShopifyCustomerRedactionTombstone(account.metadata)
  ) {
    return {
      accountId: account.id,
      previousTierId: account.currentTierId,
      newTierId: account.currentTierId,
      status: "MAINTAINED",
      qualifyingSpend: account.tierSpendRolling12Months ?? BigInt(0),
      qualifyingPoints: account.tierPointsRolling12Months ?? BigInt(0),
      reviewPeriod: effectiveReviewPeriod as TierReviewPeriod,
      tierChanged: false,
      previousTierName: account.currentTier?.name ?? null,
      newTierName: account.currentTier?.name ?? null,
      reason: "Tier evaluation skipped because the loyalty account is closed.",
    };
  }

  // Fetch tiers
  let rawTiers = program?.tiers;
  if (!rawTiers || rawTiers.length === 0) {
    rawTiers = await db.weleticLoyaltyTier.findMany({
      where: { programId: account.programId, deletedAt: null },
      orderBy: { tierOrder: "asc" },
    });
  }

  if (!rawTiers || rawTiers.length === 0) {
    return {
      accountId: params.accountId,
      previousTierId: account.currentTierId,
      newTierId: account.currentTierId,
      status: "MAINTAINED",
      qualifyingSpend: BigInt(0),
      qualifyingPoints: BigInt(0),
      reviewPeriod: effectiveReviewPeriod as TierReviewPeriod,
      tierChanged: false,
      reason: "No VIP tiers defined for store.",
    };
  }

  // Normalize all tiers and sort ascending by tierOrder
  const allTiers: NormalizedTier[] = rawTiers
    .map(normalizeTier)
    .sort((a, b) => a.tierOrder - b.tierOrder);

  const entryTier = allTiers[0];
  const currentTier: NormalizedTier = account.currentTier
    ? normalizeTier(account.currentTier)
    : entryTier;

  // 2. Compute start/end dates for evaluation timeframe
  const { startDate, endDate } = calculateTierReviewWindow(
    effectiveReviewPeriod,
    now,
    params.cycleYear,
  );

  // 3. Compute qualifying spend in timeframe
  let qualifyingSpend = BigInt(0);
  const orders = await db.weleticCommerceOrder.findMany({
    where: {
      storeId: params.storeId,
      shopperId: account.shopperId,
      status: "paid",
      occurredAt: { gte: startDate, lte: endDate },
    },
    select: {
      shopTotal: true,
      presentmentNet: true,
      shopNet: true,
      refunds: {
        select: { shopAmount: true },
      },
    },
  });

  qualifyingSpend = orders.reduce((sum: bigint, ord: any) => {
    // Smile's amount-spent milestone uses the paid order grand total after
    // discounts, including tax and shipping. Thresholds are store-currency
    // values, so shopTotal is authoritative; older mocks/data fall back.
    const total =
      ord.shopTotal ?? ord.shopNet ?? ord.presentmentNet ?? BigInt(0);
    const grossTotal = typeof total === "bigint" ? total : BigInt(total);
    const refundedTotal = (ord.refunds || []).reduce(
      (refundSum: bigint, refund: { shopAmount?: bigint | number | string }) =>
        refundSum + BigInt(refund.shopAmount ?? 0),
      BigInt(0),
    );
    // Smile removes fully and partially refunded order value from VIP
    // placement. Never let malformed imported refund totals turn one order
    // into negative qualifying revenue.
    return (
      sum +
      (grossTotal > refundedTotal ? grossTotal - refundedTotal : BigInt(0))
    );
  }, BigInt(0));

  // 4. Compute qualifying points in timeframe
  let qualifyingPoints = BigInt(0);
  const ledgerEntries = await db.weleticPointsLedgerEntry.findMany({
    where: {
      storeId: params.storeId,
      accountId: account.id,
      entryType: { in: [...GENUINE_EARN_ENTRY_TYPES] },
      pointsDelta: { gt: BigInt(0) },
      createdAt: { gte: startDate, lte: endDate },
    },
    select: {
      id: true,
      pointsDelta: true,
      referenceType: true,
      referenceId: true,
    },
  });

  qualifyingPoints = await sumValidQualifyingPoints({
    db,
    storeId: params.storeId,
    accountId: account.id,
    entries: ledgerEntries,
  });

  // 5. Determine highest qualifying tier
  let highestQualifyingTier: NormalizedTier = entryTier;
  for (const tier of allTiers) {
    const spendSatisfied = qualifyingSpend >= tier.minSpendThreshold;
    const pointsSatisfied = qualifyingPoints >= tier.minPointsThreshold;

    let qualified = false;
    if (effectiveMilestoneMode === "amount_spent") {
      qualified = spendSatisfied;
    } else if (effectiveMilestoneMode === "points_earned") {
      qualified = pointsSatisfied;
    } else {
      qualified = spendSatisfied && pointsSatisfied;
    }

    if (qualified) {
      highestQualifyingTier = tier;
    }
  }

  const previousTierId = account.currentTierId ?? entryTier.id;

  // ==========================================================================
  // Case 1: PROMOTION (Qualifies for a strictly higher tier)
  // ==========================================================================
  if (highestQualifyingTier.tierOrder > currentTier.tierOrder) {
    await db.weleticLoyaltyAccount.update({
      where: { id: account.id },
      data: {
        currentTierId: highestQualifyingTier.id,
        tierExpiresAt: null, // Clear any active grace period
        tierSpendRolling12Months: qualifyingSpend,
        tierPointsRolling12Months: qualifyingPoints,
      },
    });

    const tierHistoryId = createWeleticId("wtier_");
    const tierHistorySequence = await allocateNextTierHistorySequence({
      db,
      accountId: account.id,
    });
    await db.weleticLoyaltyTierHistory.create({
      data: {
        id: tierHistoryId,
        accountId: account.id,
        sequenceNumber: tierHistorySequence,
        fromTierId: previousTierId,
        toTierId: highestQualifyingTier.id,
        changeReason: WeleticLoyaltyTierChangeReason.threshold_reached,
        notes: `VIP Tier upgrade from ${currentTier.name} to ${highestQualifyingTier.name} (${effectiveReviewPeriod} spend: ${qualifyingSpend})`,
        qualifyingSpendSnapshot: qualifyingSpend,
        qualifyingPointsSnapshot: qualifyingPoints,
        effectiveAt: now,
      },
    });

    await enqueueFlowTriggerJob({
      storeId: params.storeId,
      eventId: tierHistoryId,
      payload: {
        accountId: account.id,
        handle: "weletic-vip-tier-changed",
        previousTier: currentTier.name,
        newTier: highestQualifyingTier.name,
        multiplier: String(highestQualifyingTier.pointsMultiplier ?? 1),
      },
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
      tx: params.tx,
    });

    // Smile issues each skipped tier's entry reward, and allows a later
    // re-qualification after downgrade to earn those rewards again.
    const crossedTiers = allTiers.filter(
      (tier) =>
        tier.tierOrder > currentTier.tierOrder &&
        tier.tierOrder <= highestQualifyingTier.tierOrder,
    );
    for (const crossedTier of crossedTiers) {
      if (
        !crossedTier.entryBonusPoints ||
        crossedTier.entryBonusPoints <= BigInt(0)
      ) {
        continue;
      }
      const bonusEntry = await appendPointsLedgerEntry({
        storeId: params.storeId,
        accountId: account.id,
        entryType: WeleticPointsLedgerEntryType.TIER_BONUS,
        pointsDelta: crossedTier.entryBonusPoints,
        referenceType: "LOYALTY_TIER_PROMOTION",
        referenceId: crossedTier.id,
        idempotencyKey: `tier_upgrade_bonus:${account.id}:${tierHistoryId}:${crossedTier.id}`,
        reason: `VIP Tier upgrade bonus for reaching ${crossedTier.name}`,
        metadata: {
          tierId: crossedTier.id,
          tierName: crossedTier.name,
          tierOrder: crossedTier.tierOrder,
          tierHistoryId,
        },
        tx: params.tx,
      });
      await enqueueFlowTriggerJob({
        storeId: params.storeId,
        eventId: bonusEntry.id,
        payload: {
          accountId: account.id,
          handle: "weletic-points-earned",
          pointsDelta: crossedTier.entryBonusPoints.toString(),
          pointsBalance: bonusEntry.balanceAfter.toString(),
          reason: "vip_tier_entry_bonus",
        },
        loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
        tx: params.tx,
      });
    }

    // Enqueue customer metafield sync
    await enqueueOutboxJob({
      storeId: params.storeId,
      jobType: "METAFIELD_SYNC",
      payload: {
        accountId: account.id,
        triggerReason: "tier_promoted",
      },
      idempotencyKey: `metafield_sync:tier_promo:${account.id}:${tierHistoryId}`,
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
      tx: params.tx,
    });

    return {
      accountId: account.id,
      previousTierId,
      newTierId: highestQualifyingTier.id,
      status: "PROMOTED",
      qualifyingSpend,
      qualifyingPoints,
      reviewPeriod: effectiveReviewPeriod as TierReviewPeriod,
      tierChanged: true,
      previousTierName: currentTier.name,
      newTierName: highestQualifyingTier.name,
      reason: `Promoted from ${currentTier.name} to ${highestQualifyingTier.name}.`,
    };
  }

  // ==========================================================================
  // Case 2: MAINTAINED (Qualifies for current tier or higher)
  // ==========================================================================
  if (highestQualifyingTier.tierOrder >= currentTier.tierOrder) {
    await db.weleticLoyaltyAccount.update({
      where: { id: account.id },
      data: {
        tierExpiresAt: null, // Clear active grace period
        tierSpendRolling12Months: qualifyingSpend,
        tierPointsRolling12Months: qualifyingPoints,
      },
    });

    return {
      accountId: account.id,
      previousTierId,
      newTierId: currentTier.id,
      status: "MAINTAINED",
      qualifyingSpend,
      qualifyingPoints,
      reviewPeriod: effectiveReviewPeriod as TierReviewPeriod,
      tierChanged: false,
      previousTierName: currentTier.name,
      newTierName: currentTier.name,
      reason: `Maintained VIP Tier ${currentTier.name} (${effectiveReviewPeriod} spend: ${qualifyingSpend} >= ${currentTier.minSpendThreshold}).`,
    };
  }

  // ==========================================================================
  // Case 3: UNDERPERFORMED CURRENT TIER (Eligible tier is lower)
  // ==========================================================================
  // Base tier cannot demote
  if (currentTier.tierOrder <= entryTier.tierOrder || !autoDowngradeEnabled) {
    await db.weleticLoyaltyAccount.update({
      where: { id: account.id },
      data: {
        tierExpiresAt: null,
        tierSpendRolling12Months: qualifyingSpend,
        tierPointsRolling12Months: qualifyingPoints,
      },
    });
    return {
      accountId: account.id,
      previousTierId,
      newTierId: currentTier.id,
      status: "MAINTAINED",
      qualifyingSpend,
      qualifyingPoints,
      reviewPeriod: effectiveReviewPeriod as TierReviewPeriod,
      tierChanged: false,
      previousTierName: currentTier.name,
      newTierName: currentTier.name,
      reason:
        currentTier.tierOrder <= entryTier.tierOrder
          ? `At base tier ${entryTier.name}. Maintained without demotion.`
          : `Lifetime or no-downgrade policy retained VIP Tier ${currentTier.name}.`,
    };
  }

  const activeGraceExpiration = account.tierExpiresAt
    ? new Date(account.tierExpiresAt)
    : null;

  // Subcase 3a: Grant 30-Day Soft Downgrade Grace Period
  if (!activeGraceExpiration) {
    const graceExpiresAt = new Date(
      now.getTime() + effectiveGraceDays * 24 * 60 * 60 * 1000,
    );

    await db.weleticLoyaltyAccount.update({
      where: { id: account.id },
      data: {
        tierExpiresAt: graceExpiresAt,
        tierSpendRolling12Months: qualifyingSpend,
        tierPointsRolling12Months: qualifyingPoints,
      },
    });

    await enqueueOutboxJob({
      storeId: params.storeId,
      jobType: "TIER_REVIEW",
      payload: {
        accountId: account.id,
        reviewPeriod: effectiveReviewPeriod,
        gracePeriodDays: effectiveGraceDays,
        reason: "grace_period_expiry_check",
      },
      scheduledFor: graceExpiresAt,
      idempotencyKey: `tier_review_grace:${account.id}:${graceExpiresAt.getTime()}`,
      loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
      tx: params.tx,
    });

    return {
      accountId: account.id,
      previousTierId,
      newTierId: currentTier.id, // Tier remains unchanged during grace period!
      status: "IN_GRACE_PERIOD",
      gracePeriodExpiresAt: graceExpiresAt,
      qualifyingSpend,
      qualifyingPoints,
      reviewPeriod: effectiveReviewPeriod as TierReviewPeriod,
      tierChanged: false,
      previousTierName: currentTier.name,
      newTierName: currentTier.name,
      reason: `Entered ${effectiveGraceDays}-day soft-downgrade grace period until ${graceExpiresAt.toISOString()}.`,
    };
  }

  // Subcase 3b: Grace Period Still Active
  if (now < activeGraceExpiration) {
    return {
      accountId: account.id,
      previousTierId,
      newTierId: currentTier.id,
      status: "IN_GRACE_PERIOD",
      gracePeriodExpiresAt: activeGraceExpiration,
      qualifyingSpend,
      qualifyingPoints,
      reviewPeriod: effectiveReviewPeriod as TierReviewPeriod,
      tierChanged: false,
      previousTierName: currentTier.name,
      newTierName: currentTier.name,
      reason: `Within soft-downgrade grace period until ${activeGraceExpiration.toISOString()}.`,
    };
  }

  // Subcase 3c: Grace Period Expired -> Single-Tier Step-Down Demotion
  const lowerTiers = allTiers.filter(
    (t) => t.tierOrder < currentTier.tierOrder,
  );
  const stepDownTier = lowerTiers[lowerTiers.length - 1] || entryTier;

  await db.weleticLoyaltyAccount.update({
    where: { id: account.id },
    data: {
      currentTierId: stepDownTier.id,
      tierExpiresAt: null,
      tierSpendRolling12Months: qualifyingSpend,
      tierPointsRolling12Months: qualifyingPoints,
    },
  });

  const tierHistoryId = createWeleticId("wtier_");
  const tierHistorySequence = await allocateNextTierHistorySequence({
    db,
    accountId: account.id,
  });
  await db.weleticLoyaltyTierHistory.create({
    data: {
      id: tierHistoryId,
      accountId: account.id,
      sequenceNumber: tierHistorySequence,
      fromTierId: previousTierId,
      toTierId: stepDownTier.id,
      changeReason: WeleticLoyaltyTierChangeReason.annual_downgrade,
      notes: `Grace period expired: Single-tier step-down demotion from ${currentTier.name} to ${stepDownTier.name} (${effectiveReviewPeriod} spend: ${qualifyingSpend})`,
      qualifyingSpendSnapshot: qualifyingSpend,
      qualifyingPointsSnapshot: qualifyingPoints,
      effectiveAt: now,
    },
  });

  await enqueueFlowTriggerJob({
    storeId: params.storeId,
    eventId: tierHistoryId,
    payload: {
      accountId: account.id,
      handle: "weletic-vip-tier-changed",
      previousTier: currentTier.name,
      newTier: stepDownTier.name,
      multiplier: String(stepDownTier.pointsMultiplier ?? 1),
    },
    loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
    tx: params.tx,
  });

  await enqueueOutboxJob({
    storeId: params.storeId,
    jobType: "METAFIELD_SYNC",
    payload: {
      accountId: account.id,
      triggerReason: "tier_demoted",
    },
    idempotencyKey: `metafield_sync:tier_demote:${account.id}:${tierHistoryId}`,
    loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
    tx: params.tx,
  });

  return {
    accountId: account.id,
    previousTierId,
    newTierId: stepDownTier.id,
    status: "DEMOTED",
    gracePeriodExpiresAt: null,
    qualifyingSpend,
    qualifyingPoints,
    reviewPeriod: effectiveReviewPeriod as TierReviewPeriod,
    tierChanged: true,
    previousTierName: currentTier.name,
    newTierName: stepDownTier.name,
    reason: `Grace period expired. Single-tier step-down demoted from ${currentTier.name} to ${stepDownTier.name}.`,
  };
}

/**
 * Batch evaluates tier maintenance cycles for all active accounts in a store.
 */
export async function batchEvaluateTierMaintenanceCycle(params: {
  storeId: string;
  reviewPeriod?: TierReviewPeriod | WeleticVipTimeframe;
  milestoneMode?: WeleticVipMilestoneMode;
  now?: Date;
  gracePeriodDays?: number;
  cycleYear?: number;
}): Promise<BatchTierLifecycleResult> {
  const { storeId, reviewPeriod = "ROLLING_12M", now = new Date() } = params;

  const accounts = await prisma.weleticLoyaltyAccount.findMany({
    where: {
      storeId,
      status: "active",
    },
    select: { id: true },
  });

  const results: TierLifecycleResult[] = [];
  let promoted = 0;
  let maintained = 0;
  let inGracePeriod = 0;
  let demoted = 0;

  for (const acc of accounts) {
    const result = await evaluateTierMaintenanceCycle({
      storeId,
      accountId: acc.id,
      reviewPeriod,
      milestoneMode: params.milestoneMode,
      now,
      gracePeriodDays: params.gracePeriodDays,
      cycleYear: params.cycleYear,
    });

    results.push(result);
    if (result.status === "PROMOTED") promoted++;
    else if (result.status === "MAINTAINED") maintained++;
    else if (result.status === "IN_GRACE_PERIOD") inGracePeriod++;
    else if (result.status === "DEMOTED") demoted++;
  }

  return {
    totalEvaluated: accounts.length,
    promoted,
    maintained,
    inGracePeriod,
    demoted,
    results,
  };
}

/**
 * Legacy compatibility wrapper for evaluateTierMaintenance.
 */
export async function evaluateTierMaintenance(params: {
  storeId: string;
  accountId: string;
  now?: Date;
  gracePeriodDays?: number;
  tx?: Prisma.TransactionClient;
}): Promise<{
  accountId: string;
  previousTierId: string | null;
  newTierId: string | null;
  status:
    | "retained"
    | "in_grace_period"
    | "downgraded"
    | "promoted"
    | "no_change";
  qualifyingSpend12m: bigint;
  qualifyingPoints12m: bigint;
  gracePeriodEndsAt?: Date | null;
  reason: string;
}> {
  const result = await evaluateTierMaintenanceCycle({
    storeId: params.storeId,
    accountId: params.accountId,
    reviewPeriod: "ROLLING_12M",
    now: params.now,
    gracePeriodDays: params.gracePeriodDays,
    tx: params.tx,
  });

  let legacyStatus:
    | "retained"
    | "in_grace_period"
    | "downgraded"
    | "promoted"
    | "no_change" = "no_change";
  if (result.status === "MAINTAINED") legacyStatus = "retained";
  else if (result.status === "PROMOTED") legacyStatus = "promoted";
  else if (result.status === "IN_GRACE_PERIOD")
    legacyStatus = "in_grace_period";
  else if (result.status === "DEMOTED") legacyStatus = "downgraded";

  return {
    accountId: result.accountId,
    previousTierId: result.previousTierId,
    newTierId: result.newTierId,
    status: legacyStatus,
    qualifyingSpend12m: result.qualifyingSpend,
    qualifyingPoints12m: result.qualifyingPoints,
    gracePeriodEndsAt: result.gracePeriodExpiresAt,
    reason: result.reason,
  };
}
