import { prisma } from "@/lib/prisma";
import { normalizeStoredLoyaltyBranding } from "@/lib/weletic/loyalty/branding";
import { serializeCustomerEarningRule } from "@/lib/weletic/loyalty/earning-actions";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import {
  DEFAULT_REWARD_PURCHASE_POLICY,
  readLoyaltyPurchasePolicy,
  type LoyaltyPurchasePolicy,
} from "@/lib/weletic/loyalty/purchase-policy";
import { getPersistedLoyaltyDiscountProvisioningIdentity } from "@/lib/weletic/loyalty/redemption-discount-identity";
import { readRedemptionMetadataDate } from "@/lib/weletic/loyalty/redemption-metadata";
import {
  matchesShopifyCustomerSelectionDigest,
  readLoyaltyRedemptionProvisioningSnapshot,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import { parseReferralCouponRewardSnapshotForIdentity } from "@/lib/weletic/loyalty/referral-coupon-snapshot";
import {
  bindShopperReferral,
  ensureAccountReferralCode,
  ensureAccountReferralLink,
  getAccountReferralStats,
} from "@/lib/weletic/loyalty/referrals";
import {
  isReferralCouponProvisionable,
  isRewardAvailableOnSalesChannel,
  listRewardDefinitions,
  redeemReward,
} from "@/lib/weletic/loyalty/rewards";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import { getAccountTierProgress } from "@/lib/weletic/loyalty/tiers";
import { currencyMinorUnits } from "@/lib/weletic/money";
import { hasShopifyCustomerPrivacyTombstone } from "@/lib/weletic/shopify/privacy-identity";
import {
  Prisma,
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
  WeleticRewardExchangeType,
  WeleticRewardSalesChannel,
  WeleticRewardStatus,
  WeleticRewardType,
} from "@prisma/client";

export const CUSTOMER_REWARD_HISTORY_LIMIT = 50;

type CustomerVipMilestoneMode = "amount_spent" | "points_earned" | "both";

function percentageToward(current: bigint, threshold: bigint) {
  if (threshold <= BigInt(0)) return 100;
  if (current >= threshold) return 100;
  if (current <= BigInt(0)) return 0;
  const basisPoints = (current * BigInt(10_000)) / threshold;
  // The early bounds prove basisPoints is in [0, 10_000), so this conversion
  // cannot lose integer precision even for arbitrarily large input values.
  return Number(basisPoints) / 100;
}

export function calculateCustomerVipProgress({
  milestoneMode,
  currentSpend,
  spendThreshold,
  currentPoints,
  pointsThreshold,
}: {
  milestoneMode: CustomerVipMilestoneMode;
  currentSpend: bigint;
  spendThreshold: bigint;
  currentPoints: bigint;
  pointsThreshold: bigint;
}) {
  const spendPercent = percentageToward(currentSpend, spendThreshold);
  const pointsPercent = percentageToward(currentPoints, pointsThreshold);
  return {
    milestoneMode,
    percent:
      milestoneMode === "amount_spent"
        ? spendPercent
        : milestoneMode === "points_earned"
          ? pointsPercent
          : Math.min(spendPercent, pointsPercent),
    spendRemaining: (spendThreshold > currentSpend
      ? spendThreshold - currentSpend
      : BigInt(0)
    ).toString(),
    pointsRemaining: (pointsThreshold > currentPoints
      ? pointsThreshold - currentPoints
      : BigInt(0)
    ).toString(),
  };
}

const CUSTOMER_AVAILABLE_REDEMPTION_STATUSES = [
  WeleticRedemptionStatus.issued,
  WeleticRedemptionStatus.active,
] as const;

export type CustomerRewardStatus =
  | "available"
  | "used"
  | "expired"
  | "cancelled";

export function getCustomerRewardStatus({
  status,
  expiresAt,
  now = new Date(),
}: {
  status: WeleticRedemptionStatus;
  expiresAt: Date | null;
  now?: Date;
}): CustomerRewardStatus {
  if (status === WeleticRedemptionStatus.used) return "used";
  if (status === WeleticRedemptionStatus.cancelled) return "cancelled";
  if (status === WeleticRedemptionStatus.expired) return "expired";
  if (
    status === WeleticRedemptionStatus.issued ||
    status === WeleticRedemptionStatus.active
  ) {
    return expiresAt && expiresAt.getTime() <= now.getTime()
      ? "expired"
      : "available";
  }
  throw new Error(`Redemption status ${status} is not customer-visible.`);
}

function readOrderName(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const orderName = (metadata as Record<string, unknown>).orderName;
  return typeof orderName === "string" && orderName.trim()
    ? orderName.trim()
    : null;
}

function readJsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mapCustomerTier(tier: {
  id: string;
  name: string;
  slug?: string;
  tierOrder: number;
  minSpendThreshold?: bigint;
  minPointsThreshold?: bigint;
  pointsMultiplier: unknown;
  entryBonusPoints?: bigint;
  perks?: unknown;
  iconUrl?: string | null;
  color?: string | null;
}) {
  return {
    id: tier.id,
    name: tier.name,
    slug: tier.slug || tier.name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-"),
    tierOrder: tier.tierOrder,
    minSpendThreshold: (tier.minSpendThreshold ?? BigInt(0)).toString(),
    minPointsThreshold: (tier.minPointsThreshold ?? BigInt(0)).toString(),
    pointsMultiplier: Number(tier.pointsMultiplier),
    entryBonusPoints: (tier.entryBonusPoints ?? BigInt(0)).toString(),
    perks: Array.isArray(tier.perks)
      ? tier.perks.filter((perk): perk is string => typeof perk === "string")
      : [],
    iconUrl: tier.iconUrl ?? null,
    color: tier.color ?? null,
  };
}

type RewardDisplaySnapshot = {
  name: string;
  description: string | null;
  rewardType: string;
};

type CustomerRewardTermsSnapshot = {
  version: 1;
  exchangeType: "fixed" | "incremental" | null;
  startsAt: string;
  purchasePolicy: LoyaltyPurchasePolicy;
  rewardType: RewardDisplaySnapshot["rewardType"];
  salesChannel: "online_store" | "pos" | "both" | null;
  currency: string;
  currencyMinorUnits: number;
  minOrderAmount: string | null;
  expiresInDays: number | null;
  usageLimitPerCustomer: number | null;
  appliesToResource: string | null;
  entitlementCount: number;
  entitledProductIds: string[];
  entitledVariantIds: string[];
  entitledCollectionIds: string[];
  combinesWithProductDiscounts: boolean;
  combinesWithOrderDiscounts: boolean;
  combinesWithShippingDiscounts: boolean;
};

type CustomerRewardTermsSnapshotResult =
  | {
      source: "issuance_snapshot";
      snapshot: CustomerRewardTermsSnapshot;
      displaySnapshot: RewardDisplaySnapshot;
    }
  | {
      source: "legacy" | "unavailable";
      snapshot: null;
      displaySnapshot: null;
    };

type CustomerRewardTermsIdentity = {
  storeId: string;
  accountId: string;
  redemptionId: string;
  rewardDefinitionId: string;
  shopifyCustomerId: string;
  shopifyDiscountCode: string;
  pointsSpent: bigint;
  expiresAt: Date | null;
};

type CustomerReferralRuleForOffer = {
  isActive: boolean;
  advocateRewardKind: "points" | "coupon";
  advocatePointsReward: bigint;
  advocateRewardDefinitionId: string | null;
  refereeRewardKind: "points" | "coupon";
  refereePointsReward: bigint;
  refereeRewardDefinitionId: string | null;
  minQualifyingOrderSubtotal: { toString(): string } | null;
  maxReferralsPerAdvocate: number | null;
};

type CustomerReferralRewardForOffer = {
  id: string;
  name: string;
  exchangeType: WeleticRewardExchangeType;
  rewardType: WeleticRewardType;
  salesChannel?: WeleticRewardSalesChannel;
  discountValue: unknown;
  maxDiscountValue: unknown;
  minOrderAmount?: unknown;
  entitledProductIds: unknown;
  entitledVariantIds: unknown;
  entitledCollectionIds: unknown;
  usageLimit?: number | null;
  usageLimitPerCustomer?: number | null;
};

export function getCustomerReferralOffer({
  programStatus,
  killSwitchActive,
  rule,
  rewards,
}: {
  programStatus: string | null | undefined;
  killSwitchActive: boolean | null | undefined;
  rule: CustomerReferralRuleForOffer | null;
  rewards: CustomerReferralRewardForOffer[];
}) {
  if (programStatus !== "active" || killSwitchActive || !rule?.isActive) {
    return null;
  }
  const hasValidReward = ({
    kind,
    points,
    rewardDefinitionId,
  }: {
    kind: "points" | "coupon";
    points: bigint;
    rewardDefinitionId: string | null;
  }) =>
    kind === "points"
      ? points > BigInt(0)
      : Boolean(
          rewardDefinitionId &&
            rewards.some(
              (reward) =>
                reward.id === rewardDefinitionId &&
                reward.exchangeType === WeleticRewardExchangeType.fixed &&
                isReferralCouponProvisionable(reward),
            ),
        );

  if (
    !hasValidReward({
      kind: rule.advocateRewardKind,
      points: rule.advocatePointsReward,
      rewardDefinitionId: rule.advocateRewardDefinitionId,
    }) ||
    !hasValidReward({
      kind: rule.refereeRewardKind,
      points: rule.refereePointsReward,
      rewardDefinitionId: rule.refereeRewardDefinitionId,
    })
  ) {
    return null;
  }

  return {
    advocateRewardKind: rule.advocateRewardKind,
    advocatePointsReward: rule.advocatePointsReward.toString(),
    advocateRewardDefinitionId: rule.advocateRewardDefinitionId,
    advocateRewardName:
      rewards.find((reward) => reward.id === rule.advocateRewardDefinitionId)
        ?.name ?? null,
    refereeRewardKind: rule.refereeRewardKind,
    refereePointsReward: rule.refereePointsReward.toString(),
    refereeRewardDefinitionId: rule.refereeRewardDefinitionId,
    refereeRewardName:
      rewards.find((reward) => reward.id === rule.refereeRewardDefinitionId)
        ?.name ?? null,
    minQualifyingOrderSubtotal:
      rule.minQualifyingOrderSubtotal?.toString() ?? null,
    maxReferralsPerAdvocate: rule.maxReferralsPerAdvocate,
  };
}

function readRewardDisplaySnapshot(
  metadata: unknown,
): RewardDisplaySnapshot | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const root = metadata as Record<string, unknown>;
  const nested = root.rewardSnapshot;
  const source =
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : root;
  const name = source.name ?? source.rewardName;
  const rewardType = source.rewardType;
  const description = source.description ?? source.rewardDescription ?? null;
  if (typeof name !== "string" || typeof rewardType !== "string") return null;
  return {
    name,
    rewardType,
    description: typeof description === "string" ? description : null,
  };
}

function readCustomerRewardTermsSnapshot(
  metadata: unknown,
  identity: CustomerRewardTermsIdentity,
): CustomerRewardTermsSnapshotResult {
  const root = readJsonRecord(metadata);
  if (Object.prototype.hasOwnProperty.call(root, "provisioningSnapshot")) {
    try {
      const snapshot = readLoyaltyRedemptionProvisioningSnapshot(metadata);
      if (!snapshot) {
        return {
          source: "unavailable",
          snapshot: null,
          displaySnapshot: null,
        };
      }
      if (snapshot.rewardDefinitionId !== identity.rewardDefinitionId) {
        throw new Error("Redemption reward definition does not match.");
      }
      if (
        snapshot.pointsCost !== identity.pointsSpent.toString() ||
        snapshot.expiresAt !== (identity.expiresAt?.toISOString() ?? null)
      ) {
        throw new Error(
          "Redemption economics do not match the immutable provisioning snapshot.",
        );
      }
      if (
        !matchesShopifyCustomerSelectionDigest({
          digest: snapshot.customerSelectionDigest,
          storeId: identity.storeId,
          shopifyCustomerId: identity.shopifyCustomerId,
        })
      ) {
        throw new Error("Redemption customer selection does not match.");
      }
      if (
        !getPersistedLoyaltyDiscountProvisioningIdentity({
          identity: {
            storeId: identity.storeId,
            redemptionId: identity.redemptionId,
            accountId: identity.accountId,
            rewardDefinitionId: identity.rewardDefinitionId,
            discountCode: identity.shopifyDiscountCode,
          },
          metadata,
        })
      ) {
        throw new Error("Redemption ownership metadata is unavailable.");
      }

      return {
        source: "issuance_snapshot",
        displaySnapshot: {
          name: snapshot.name,
          description: snapshot.description,
          rewardType: snapshot.rewardType,
        },
        snapshot: {
          version: 1,
          exchangeType: snapshot.exchangeType ?? null,
          startsAt: snapshot.startsAt,
          purchasePolicy: readLoyaltyPurchasePolicy(
            snapshot.purchasePolicy,
            DEFAULT_REWARD_PURCHASE_POLICY,
          ),
          rewardType: snapshot.rewardType,
          salesChannel: snapshot.salesChannel ?? null,
          currency: snapshot.shopCurrency,
          currencyMinorUnits: currencyMinorUnits(snapshot.shopCurrency),
          minOrderAmount: snapshot.minOrderAmount,
          expiresInDays: snapshot.expiresInDays,
          usageLimitPerCustomer: snapshot.usageLimitPerCustomer,
          appliesToResource: snapshot.appliesToResource,
          entitledProductIds: [...snapshot.entitledProductIds],
          entitledVariantIds: [...snapshot.entitledVariantIds],
          entitledCollectionIds: [...snapshot.entitledCollectionIds],
          entitlementCount:
            snapshot.entitledCollectionIds.length +
            snapshot.entitledProductIds.length +
            snapshot.entitledVariantIds.length,
          combinesWithProductDiscounts: snapshot.combinesWithProductDiscounts,
          combinesWithOrderDiscounts: snapshot.combinesWithOrderDiscounts,
          combinesWithShippingDiscounts: snapshot.combinesWithShippingDiscounts,
        },
      };
    } catch {
      // A malformed modern snapshot must not be relabelled from the merchant's
      // mutable current definition. Keep the wallet usable while withholding
      // terms that can no longer be proven to be the issuance-time contract.
      return {
        source: "unavailable",
        snapshot: null,
        displaySnapshot: null,
      };
    }
  }

  const referralSnapshot = readJsonRecord(root.rewardSnapshot);
  if (!Object.prototype.hasOwnProperty.call(referralSnapshot, "version")) {
    return { source: "legacy", snapshot: null, displaySnapshot: null };
  }

  try {
    const referralId = root.referralId;
    const qualificationOrderId = root.qualificationOrderId;
    const referralSide = root.referralSide;
    if (
      typeof referralId !== "string" ||
      typeof qualificationOrderId !== "string" ||
      (referralSide !== "advocate" && referralSide !== "referee")
    ) {
      throw new Error("Invalid referral coupon identity metadata.");
    }
    const snapshot = parseReferralCouponRewardSnapshotForIdentity(
      referralSnapshot,
      {
        ...identity,
        referralId,
        qualificationOrderId,
        side: referralSide,
      },
    );
    if (
      !matchesShopifyCustomerSelectionDigest({
        digest: snapshot.customerSelectionDigest,
        storeId: identity.storeId,
        shopifyCustomerId: identity.shopifyCustomerId,
      })
    ) {
      throw new Error("Referral coupon customer selection does not match.");
    }
    if (
      identity.pointsSpent !== BigInt(0) ||
      snapshot.discountCode !== identity.shopifyDiscountCode ||
      snapshot.expiresAt !== (identity.expiresAt?.toISOString() ?? null)
    ) {
      throw new Error(
        "Referral coupon redemption does not match its qualification snapshot.",
      );
    }
    return {
      source: "issuance_snapshot",
      displaySnapshot: {
        name: snapshot.name,
        description: snapshot.description,
        rewardType: snapshot.rewardType,
      },
      snapshot: {
        version: 1,
        exchangeType: snapshot.exchangeType ?? null,
        startsAt: snapshot.startsAt,
        purchasePolicy: readLoyaltyPurchasePolicy(
          snapshot.purchasePolicy,
          DEFAULT_REWARD_PURCHASE_POLICY,
        ),
        rewardType: snapshot.rewardType,
        salesChannel: snapshot.salesChannel ?? null,
        currency: snapshot.shopCurrency,
        currencyMinorUnits: currencyMinorUnits(snapshot.shopCurrency),
        minOrderAmount: snapshot.minOrderAmount,
        expiresInDays: snapshot.expiresInDays,
        usageLimitPerCustomer: snapshot.usageLimitPerCustomer,
        appliesToResource: snapshot.appliesToResource,
        entitledProductIds: [...snapshot.entitledProductIds],
        entitledVariantIds: [...snapshot.entitledVariantIds],
        entitledCollectionIds: [...snapshot.entitledCollectionIds],
        entitlementCount:
          snapshot.entitledCollectionIds.length +
          snapshot.entitledProductIds.length +
          snapshot.entitledVariantIds.length,
        combinesWithProductDiscounts: snapshot.combinesWithProductDiscounts,
        combinesWithOrderDiscounts: snapshot.combinesWithOrderDiscounts,
        combinesWithShippingDiscounts: snapshot.combinesWithShippingDiscounts,
      },
    };
  } catch {
    // A versioned referral reward snapshot is authoritative. If its digest or
    // qualification identity is invalid, never substitute mutable catalog
    // terms for the coupon that was actually issued.
    return {
      source: "unavailable",
      snapshot: null,
      displaySnapshot: null,
    };
  }
}

function getCustomerRewardStatusDate(
  redemption: {
    status: WeleticRedemptionStatus;
    expiresAt: Date | null;
    usedAt: Date | null;
    metadata: unknown;
    createdAt: Date;
    updatedAt: Date;
  },
  now: Date,
) {
  const status = getCustomerRewardStatus({
    status: redemption.status,
    expiresAt: redemption.expiresAt,
    now,
  });
  return status === "used"
    ? redemption.usedAt ?? redemption.updatedAt
    : status === "expired"
      ? redemption.expiresAt ?? redemption.updatedAt
      : status === "cancelled"
        ? readRedemptionMetadataDate(redemption.metadata, "cancelledAt")
        : redemption.createdAt;
}

export interface GetCustomerLoyaltySummaryParams {
  /** Internal read-only consumers must not create referral identities/links. */
  provisionReferralIdentity?: boolean;
  storeId?: string;
  shopDomain?: string;
  shopifyCustomerId: string;
  redemptionChannel?: "online_store" | "pos";
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  onTiming?: (timings: CustomerLoyaltySummaryTimings) => void;
}

export interface CustomerLoyaltySummaryTimings {
  resolveStore: number;
  loadShopper: number;
  loadSummary: number;
  loadLegacyMetadata: number;
  total: number;
}

function roundDuration(duration: number) {
  return Math.round(duration * 10) / 10;
}

export async function resolveStoreId({
  storeId,
  shopDomain,
}: {
  storeId?: string;
  shopDomain?: string;
}): Promise<string | null> {
  if (storeId) {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { id: storeId },
      select: { id: true },
    });
    return store?.id ?? null;
  }
  if (!shopDomain) return null;

  const store = await prisma.weleticShopifyStore.findUnique({
    where: { shopDomain },
    select: { id: true },
  });

  return store?.id ?? null;
}

export async function getCustomerLoyaltySummary({
  storeId: explicitStoreId,
  shopDomain,
  shopifyCustomerId,
  redemptionChannel = "online_store",
  provisionReferralIdentity = true,
  loyaltyMaintenancePermit,
  onTiming,
}: GetCustomerLoyaltySummaryParams) {
  const startedAt = performance.now();
  let stageStartedAt = startedAt;
  const timings: CustomerLoyaltySummaryTimings = {
    resolveStore: 0,
    loadShopper: 0,
    loadSummary: 0,
    loadLegacyMetadata: 0,
    total: 0,
  };
  const recordStage = (
    stage: keyof Omit<CustomerLoyaltySummaryTimings, "total">,
  ) => {
    const now = performance.now();
    timings[stage] = roundDuration(now - stageStartedAt);
    stageStartedAt = now;
  };
  const finish = <T>(result: T) => {
    timings.total = roundDuration(performance.now() - startedAt);
    onTiming?.({ ...timings });
    return result;
  };

  const storeId = await resolveStoreId({
    storeId: explicitStoreId,
    shopDomain,
  });
  recordStage("resolveStore");

  if (!storeId) {
    throw new Error("Shopify store not found.");
  }

  // 1. Fetch shopper with loyalty account and store
  const shopper = await prisma.weleticShopper.findUnique({
    where: {
      storeId_shopifyCustomerId: {
        storeId,
        shopifyCustomerId: String(shopifyCustomerId),
      },
    },
    include: {
      store: {
        select: {
          id: true,
          shopDomain: true,
          shopCurrency: true,
        },
      },
      loyaltyAccount: {
        include: {
          program: {
            include: {
              earningRules: {
                where: {
                  isActive: true,
                  deletedAt: null,
                  OR: [{ startAt: null }, { startAt: { lte: new Date() } }],
                  AND: [
                    { OR: [{ endAt: null }, { endAt: { gte: new Date() } }] },
                  ],
                },
                orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
              },
              bonusCampaigns: {
                where: {
                  isActive: true,
                  deletedAt: null,
                  startAt: { lte: new Date() },
                  endAt: { gt: new Date() },
                },
                orderBy: { endAt: "asc" },
              },
              referralRules: {
                where: { isActive: true },
                orderBy: [{ createdAt: "desc" }, { id: "desc" }],
                take: 1,
              },
            },
          },
          currentTier: true,
          tierHistory: {
            orderBy: { effectiveAt: "desc" },
            take: 20,
            include: {
              fromTier: { select: { id: true, name: true } },
              toTier: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });
  recordStage("loadShopper");

  if (!shopper) {
    return finish({
      isEnrolled: false as const,
      storeId,
      pointsBalance: "0",
      pendingPoints: "0",
      lifetimePointsEarned: "0",
      tier: null,
      referral: null,
      rewards: [],
      rewardWallet: [],
      recentActivity: [],
    });
  }

  if (
    await hasShopifyCustomerPrivacyTombstone({
      storeId,
      shopifyCustomerId,
      email: shopper.email,
    })
  ) {
    return finish({
      isEnrolled: false as const,
      storeId,
      pointsBalance: "0",
      pendingPoints: "0",
      lifetimePointsEarned: "0",
      tier: null,
      referral: null,
      rewards: [],
      rewardWallet: [],
      recentActivity: [],
    });
  }

  // Enrollment is event-driven (customer/order ingestion), never a side effect
  // of a read request.
  const account = shopper.loyaltyAccount;
  if (!account) {
    return finish({
      isEnrolled: false as const,
      storeId,
      pointsBalance: "0",
      pendingPoints: "0",
      lifetimePointsEarned: "0",
      tier: null,
      referral: null,
      rewards: [],
      rewardWallet: [],
      recentActivity: [],
    });
  }

  const domain = shopDomain || shopper.store.shopDomain;

  // Persistent customer coupon wallet. Keep history bounded and scope every
  // read by both store and loyalty account so a code can never cross tenants.
  const redemptionSelect = {
    id: true,
    rewardDefinitionId: true,
    pointsSpent: true,
    shopifyDiscountCode: true,
    artifactKind: true,
    status: true,
    orderId: true,
    expiresAt: true,
    usedAt: true,
    ledgerEntryId: true,
    metadata: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  // Never cap outstanding coupons: a purchased, still-valid code must remain
  // retrievable. Each terminal lifecycle and computed expiry contributes at
  // most its latest 50 candidates to one lifecycle-sorted bounded history.
  // Repeatable-read prevents a concurrent webhook transition from duplicating
  // or temporarily hiding a redemption across these buckets.
  const walletNow = new Date();
  const walletPromise = prisma.$transaction(
    (tx) =>
      Promise.all([
        tx.weleticRewardRedemption.findMany({
          where: {
            storeId,
            accountId: account.id,
            status: { in: [...CUSTOMER_AVAILABLE_REDEMPTION_STATUSES] },
            OR: [{ expiresAt: null }, { expiresAt: { gt: walletNow } }],
          },
          orderBy: { createdAt: "desc" },
          select: redemptionSelect,
        }),
        tx.weleticRewardRedemption.findMany({
          where: {
            storeId,
            accountId: account.id,
            status: WeleticRedemptionStatus.used,
          },
          orderBy: [{ usedAt: "desc" }, { updatedAt: "desc" }],
          take: CUSTOMER_REWARD_HISTORY_LIMIT,
          select: redemptionSelect,
        }),
        tx.weleticRewardRedemption.findMany({
          where: {
            storeId,
            accountId: account.id,
            status: WeleticRedemptionStatus.expired,
          },
          orderBy: [{ expiresAt: "desc" }, { updatedAt: "desc" }],
          take: CUSTOMER_REWARD_HISTORY_LIMIT,
          select: redemptionSelect,
        }),
        tx.weleticRewardRedemption.findMany({
          where: {
            storeId,
            accountId: account.id,
            status: WeleticRedemptionStatus.cancelled,
          },
          orderBy: { updatedAt: "desc" },
          take: CUSTOMER_REWARD_HISTORY_LIMIT,
          select: redemptionSelect,
        }),
        tx.weleticRewardRedemption.findMany({
          where: {
            storeId,
            accountId: account.id,
            status: { in: [...CUSTOMER_AVAILABLE_REDEMPTION_STATUSES] },
            expiresAt: { lte: walletNow },
          },
          orderBy: { expiresAt: "desc" },
          take: CUSTOMER_REWARD_HISTORY_LIMIT,
          select: redemptionSelect,
        }),
      ]),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  // After identity is resolved, these reads are independent. Running them
  // together removes avoidable database round trips from the critical path.
  // Create the tier and referral-stat reads first because they share the same
  // account model as link provisioning and should not be delayed behind it.
  const tierProgressPromise = getAccountTierProgress(account.id);
  const referralStatsPromise = getAccountReferralStats(account.id);
  const loyaltyProgram = account.program;
  const programIsActive = Boolean(
    loyaltyProgram?.status === "active" && !loyaltyProgram.killSwitchActive,
  );
  const canParticipate = programIsActive && account.status === "active";
  const configuredReferralRule = loyaltyProgram?.referralRules?.[0] ?? null;
  const rewardsPromise = canParticipate
    ? listRewardDefinitions({
        storeId,
        status: WeleticRewardStatus.active,
        provisionableOnly: true,
      }).then((rewards) =>
        rewards.filter((reward) =>
          isRewardAvailableOnSalesChannel(reward, redemptionChannel),
        ),
      )
    : Promise.resolve([]);
  const referralOfferPromise = canParticipate
    ? rewardsPromise.then((rewards) =>
        getCustomerReferralOffer({
          programStatus: loyaltyProgram?.status,
          killSwitchActive: loyaltyProgram?.killSwitchActive,
          rule: configuredReferralRule,
          rewards,
        }),
      )
    : Promise.resolve(null);
  const canProvisionReferralIdentity =
    provisionReferralIdentity &&
    canParticipate &&
    !hasShopifyCustomerRedactionTombstone(account.metadata);
  const unavailableReferralLink = {
    referralCode: null,
    referralLink: null,
    dubLinkId: null,
  };
  const referralContextPromise = referralOfferPromise.then(
    async (referralOffer) => {
      if (!canProvisionReferralIdentity || !referralOffer) {
        return { referralOffer, referralLink: unavailableReferralLink };
      }
      const referralLink = await ensureAccountReferralLink({
        storeId,
        accountId: account.id,
        loyaltyMaintenancePermit,
      }).catch(async (error) => {
        if (process.env.NODE_ENV !== "test") {
          console.error("[Loyalty Referral Link Fallback]", error);
        }
        const referralCode =
          account.referralCode ||
          (await ensureAccountReferralCode(
            account.id,
            shopper.firstName,
            loyaltyMaintenancePermit,
          ));
        return {
          referralCode,
          referralLink: `https://${domain}?ref=${encodeURIComponent(referralCode)}`,
          dubLinkId: null,
        };
      });
      return { referralOffer, referralLink };
    },
  );

  const [
    tierProgress,
    referralStats,
    rewards,
    recentLedger,
    [
      availableRedemptions,
      usedRedemptions,
      expiredRedemptions,
      cancelledRedemptions,
      overdueRedemptions,
    ],
    referralContext,
  ] = await Promise.all([
    tierProgressPromise,
    referralStatsPromise,
    rewardsPromise,
    prisma.weleticPointsLedgerEntry.findMany({
      where: { accountId: account.id },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        id: true,
        entryType: true,
        pointsDelta: true,
        balanceAfter: true,
        reason: true,
        createdAt: true,
        referenceType: true,
        referenceId: true,
      },
    }),
    walletPromise,
    referralContextPromise,
  ]);
  const { referralOffer, referralLink } = referralContext;
  recordStage("loadSummary");

  const availablePoints = account.cachedPointsBalance;
  const program = loyaltyProgram;
  const programBranding = normalizeStoredLoyaltyBranding(
    program?.branding,
    program?.name,
  );
  const birthdayMetadata =
    account.metadata &&
    typeof account.metadata === "object" &&
    !Array.isArray(account.metadata)
      ? (account.metadata as Record<string, any>).birthday
      : null;
  const waysToEarn = canParticipate
    ? (program?.earningRules || []).map(serializeCustomerEarningRule)
    : [];
  const activeCampaigns = canParticipate
    ? (program?.bonusCampaigns || [])
        .filter(
          (campaign) =>
            !Array.isArray(campaign.eligibleTierIds) ||
            campaign.eligibleTierIds.length === 0 ||
            (account.currentTierId &&
              campaign.eligibleTierIds.includes(account.currentTierId)),
        )
        .map((campaign) => ({
          id: campaign.id,
          name: campaign.name,
          description: campaign.description,
          multiplier: Number(campaign.multiplier),
          startAt: campaign.startAt,
          endAt: campaign.endAt,
        }))
    : [];
  const rewardCatalog = rewards.map((reward) => ({
    id: reward.id,
    purchasePolicy: readLoyaltyPurchasePolicy(
      reward.purchasePolicy,
      DEFAULT_REWARD_PURCHASE_POLICY,
    ),
    name: reward.name,
    description: reward.description,
    rewardType: reward.rewardType,
    salesChannel: reward.salesChannel,
    exchangeType: reward.exchangeType,
    pointsCost: reward.pointsCost.toString(),
    pointsStep: reward.pointsStep?.toString() ?? null,
    minPointsCost: reward.minPointsCost?.toString() ?? null,
    maxPointsCost: reward.maxPointsCost?.toString() ?? null,
    discountValue: reward.discountValue?.toString() ?? null,
    maxDiscountValue: reward.maxDiscountValue?.toString() ?? null,
    minOrderAmount: reward.minOrderAmount?.toString() ?? null,
    appliesToResource: reward.appliesToResource,
    entitledCollectionIds: Array.isArray(reward.entitledCollectionIds)
      ? reward.entitledCollectionIds
      : [],
    entitledProductIds: Array.isArray(reward.entitledProductIds)
      ? reward.entitledProductIds
      : [],
    entitledVariantIds: Array.isArray(reward.entitledVariantIds)
      ? reward.entitledVariantIds
      : [],
    combinesWithProductDiscounts: reward.combinesWithProductDiscounts,
    combinesWithOrderDiscounts: reward.combinesWithOrderDiscounts,
    combinesWithShippingDiscounts: reward.combinesWithShippingDiscounts,
    usageLimitPerCustomer: reward.usageLimitPerCustomer,
    expiresInDays: reward.expiresInDays,
    canRedeem:
      canParticipate &&
      availablePoints >=
        (reward.exchangeType === "incremental"
          ? reward.minPointsCost ?? reward.pointsCost
          : reward.pointsCost) &&
      availablePoints > BigInt(0),
  }));
  const recentActivity = recentLedger.map((entry) => ({
    id: entry.id,
    entryType: entry.entryType,
    pointsDelta: entry.pointsDelta.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    reason: entry.reason,
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    createdAt: entry.createdAt,
  }));

  const availableIds = new Set(
    availableRedemptions.map((redemption) => redemption.id),
  );
  const historyById = new Map(
    [
      ...usedRedemptions,
      ...expiredRedemptions,
      ...cancelledRedemptions,
      ...overdueRedemptions,
    ]
      .filter((redemption) => !availableIds.has(redemption.id))
      .map((redemption) => [redemption.id, redemption]),
  );
  const historicalRedemptions = [...historyById.values()]
    .sort(
      (left, right) =>
        (getCustomerRewardStatusDate(right, walletNow)?.getTime() ??
          right.createdAt.getTime()) -
        (getCustomerRewardStatusDate(left, walletNow)?.getTime() ??
          left.createdAt.getTime()),
    )
    .slice(0, CUSTOMER_REWARD_HISTORY_LIMIT);
  const redemptions = [...availableRedemptions, ...historicalRedemptions];

  // Old redemptions predate the redemption metadata snapshot. Their immutable
  // debit ledger metadata preserves the issued reward name/type.
  const legacyLedgerEntryIds = redemptions
    .filter(
      (redemption) =>
        !readRewardDisplaySnapshot(redemption.metadata) &&
        redemption.ledgerEntryId,
    )
    .map((redemption) => redemption.ledgerEntryId as string);
  const legacyLedgerEntries = legacyLedgerEntryIds.length
    ? await prisma.weleticPointsLedgerEntry.findMany({
        where: {
          storeId,
          accountId: account.id,
          id: { in: legacyLedgerEntryIds },
        },
        select: { id: true, metadata: true },
      })
    : [];
  recordStage("loadLegacyMetadata");
  const legacyLedgerMetadata = new Map(
    legacyLedgerEntries.map((entry) => [entry.id, entry.metadata]),
  );

  const rewardWallet = redemptions.map((redemption) => {
    const artifactKind =
      redemption.artifactKind ?? WeleticRewardArtifactKind.discount_code;
    const status = getCustomerRewardStatus({
      status: redemption.status,
      expiresAt: redemption.expiresAt,
      now: walletNow,
    });
    const termsSnapshot = readCustomerRewardTermsSnapshot(redemption.metadata, {
      storeId,
      accountId: account.id,
      redemptionId: redemption.id,
      rewardDefinitionId: redemption.rewardDefinitionId,
      shopifyCustomerId,
      shopifyDiscountCode: redemption.shopifyDiscountCode,
      pointsSpent: redemption.pointsSpent,
      expiresAt: redemption.expiresAt,
    });
    const rewardSnapshot = termsSnapshot.displaySnapshot ??
      (termsSnapshot.source === "legacy"
        ? readRewardDisplaySnapshot(redemption.metadata) ??
          readRewardDisplaySnapshot(
            redemption.ledgerEntryId
              ? legacyLedgerMetadata.get(redemption.ledgerEntryId)
              : null,
          )
        : null) ?? {
        // Never relabel a legacy or unverifiable modern coupon from a mutable
        // current definition or from a failed snapshot parse.
        name: "Loyalty reward",
        description: null,
        rewardType: "legacy",
      };
    const statusDate = getCustomerRewardStatusDate(redemption, walletNow);
    return {
      id: redemption.id,
      rewardDefinitionId: redemption.rewardDefinitionId,
      rewardName: rewardSnapshot.name,
      rewardDescription: rewardSnapshot.description,
      rewardType: rewardSnapshot.rewardType,
      salesChannel: termsSnapshot.snapshot?.salesChannel ?? null,
      termsSnapshot: termsSnapshot.snapshot,
      termsSource: termsSnapshot.source,
      pointsSpent: redemption.pointsSpent.toString(),
      artifactKind,
      artifactCode:
        artifactKind === WeleticRewardArtifactKind.store_credit
          ? null
          : redemption.shopifyDiscountCode,
      discountCode:
        artifactKind === WeleticRewardArtifactKind.discount_code
          ? redemption.shopifyDiscountCode
          : null,
      giftCardCode:
        artifactKind === WeleticRewardArtifactKind.gift_card
          ? redemption.shopifyDiscountCode
          : null,
      status,
      issuedAt: redemption.createdAt,
      statusDate,
      expiresAt: redemption.expiresAt,
      usedAt: redemption.usedAt,
      orderId: redemption.orderId,
      orderName: readOrderName(redemption.metadata),
      applyUrl:
        status === "available" &&
        artifactKind === WeleticRewardArtifactKind.discount_code &&
        (termsSnapshot.snapshot?.salesChannel ===
          WeleticRewardSalesChannel.online_store ||
          termsSnapshot.snapshot?.salesChannel ===
            WeleticRewardSalesChannel.both)
          ? `https://${domain}/discount/${encodeURIComponent(redemption.shopifyDiscountCode)}?redirect=/cart`
          : null,
    };
  });

  return finish({
    isEnrolled: true as const,
    storeId,
    shopDomain: domain,
    shopper: {
      firstName: shopper.firstName,
    },
    account: {
      id: account.id,
      status: account.status,
      canParticipate,
      pointsBalance: availablePoints.toString(),
      pendingPoints: account.cachedPendingPoints.toString(),
      lifetimePointsEarned: account.lifetimePointsEarned.toString(),
      lifetimePointsRedeemed: account.lifetimePointsRedeemed.toString(),
      enrolledAt: account.enrolledAt,
      nextExpiryDate: account.nextExpiryDate,
    },
    program: {
      isActive: programIsActive,
      name: program?.name || "Loyalty Program",
      pointNameSingular: program?.pointNameSingular || "Point",
      pointNamePlural: program?.pointNamePlural || "Points",
      pointsExpiryMonths: program?.pointsExpiryMonths || 0,
      pointsExpiryDays: program?.pointsExpiryDays || 0,
      pointsExpiryWarningDays: program?.pointsExpiryWarningDays || 30,
      pointsExpiryLastChanceDays: program?.pointsExpiryLastChanceDays || 3,
      vipMilestoneMode: program?.vipMilestoneMode || "amount_spent",
      vipTimeframe: program?.vipTimeframe || "rolling_12m",
      currency: shopper.store.shopCurrency,
      currencyMinorUnits: currencyMinorUnits(shopper.store.shopCurrency),
      branding: {
        title: programBranding.panelTitle,
        subtitle: programBranding.panelWelcomeSubtitle,
        heroImageUrl: programBranding.heroImageUrl,
        primaryColor: programBranding.primaryColor,
      },
    },
    tier: {
      ...tierProgress,
      rollingSpend: (
        tierProgress.rollingSpend ??
        account.tierSpendRolling12Months ??
        0
      ).toString(),
      lifetimePoints: (
        tierProgress.lifetimePoints ??
        account.lifetimePointsEarned ??
        0
      ).toString(),
      currentTier: tierProgress.currentTier
        ? mapCustomerTier(tierProgress.currentTier)
        : null,
      nextTier: tierProgress.nextTier
        ? mapCustomerTier(tierProgress.nextTier)
        : null,
      allTiers: tierProgress.allTiers.map(mapCustomerTier),
      tierExpiresAt: account.tierExpiresAt,
      history: (account.tierHistory || []).map((entry) => ({
        id: entry.id,
        fromTier: entry.fromTier,
        toTier: entry.toTier,
        changeReason: entry.changeReason,
        qualifyingSpendSnapshot:
          entry.qualifyingSpendSnapshot?.toString() ?? null,
        qualifyingPointsSnapshot:
          entry.qualifyingPointsSnapshot?.toString() ?? null,
        effectiveAt: entry.effectiveAt,
      })),
      progress: tierProgress.nextTier
        ? calculateCustomerVipProgress({
            milestoneMode: program?.vipMilestoneMode || "amount_spent",
            currentSpend: tierProgress.rollingSpend,
            spendThreshold:
              tierProgress.nextTier.minSpendThreshold ?? BigInt(0),
            currentPoints: tierProgress.lifetimePoints,
            pointsThreshold:
              tierProgress.nextTier.minPointsThreshold ?? BigInt(0),
          })
        : null,
    },
    referral: {
      referralCode: referralLink.referralCode,
      referralShareUrl: referralOffer ? referralLink.referralLink : null,
      dubLinkId: referralLink.dubLinkId,
      totalReferrals: referralStats.totalReferralCount,
      qualifiedReferrals: referralStats.qualifiedReferralCount,
      totalPointsEarned: referralStats.referralPointsEarned.toString(),
      offer: referralOffer,
      activity: (referralStats.referrals || []).map((referral) => ({
        id: referral.id,
        status: referral.status,
        refereeName: referral.refereeName,
        advocatePointsAwarded: referral.advocatePointsAwarded.toString(),
        refereePointsAwarded: referral.refereePointsAwarded?.toString() ?? "0",
        rewardedAt: referral.rewardedAt ?? null,
        createdAt: referral.createdAt,
      })),
    },
    waysToEarn,
    activeCampaigns,
    pointsExpiry: {
      enabled: Boolean(
        program?.status === "active" &&
          !program.killSwitchActive &&
          (program.pointsExpiryDays > 0 || program.pointsExpiryMonths > 0),
      ),
      days: program?.pointsExpiryDays || 0,
      months: program?.pointsExpiryMonths || 0,
      warningDays: program?.pointsExpiryWarningDays || 30,
      lastChanceDays: program?.pointsExpiryLastChanceDays || 3,
      nextExpiryDate: account.nextExpiryDate,
    },
    birthday: {
      enabled: waysToEarn.some((rule) => rule.triggerCode === "birthday"),
      isRegistered: Boolean(birthdayMetadata?.birthDate),
      birthMonth: birthdayMetadata?.birthDate
        ? Number(String(birthdayMetadata.birthDate).slice(5, 7))
        : null,
      birthDay: birthdayMetadata?.birthDate
        ? Number(String(birthdayMetadata.birthDate).slice(8, 10))
        : null,
      registeredAt: birthdayMetadata?.registeredAt || null,
      nextEligibleYear: birthdayMetadata?.nextEligibleYear || null,
    },
    rewards: rewardCatalog,
    rewardWallet,
    recentActivity,
  });
}

export function validateCustomerIncrementalPointsRequest({
  pointsRequested,
  minimum,
  maximum,
  step,
}: {
  pointsRequested?: bigint | string;
  minimum: bigint;
  maximum: bigint | null;
  step: bigint;
}) {
  let requested: bigint;
  if (pointsRequested === undefined) {
    requested = minimum;
  } else if (typeof pointsRequested === "bigint") {
    requested = pointsRequested;
  } else if (
    typeof pointsRequested === "string" &&
    /^\d+$/.test(pointsRequested)
  ) {
    requested = BigInt(pointsRequested);
  } else {
    throw new Error("Requested points must be a whole-number string.");
  }

  if (
    minimum <= BigInt(0) ||
    step <= BigInt(0) ||
    (maximum !== null && maximum < minimum) ||
    requested < minimum ||
    (maximum !== null && requested > maximum) ||
    requested % step !== BigInt(0)
  ) {
    throw new Error(
      "Requested points do not satisfy the reward step or limits.",
    );
  }
  return requested;
}

export async function redeemCustomerPoints({
  storeId: explicitStoreId,
  shopDomain,
  shopifyCustomerId,
  rewardDefinitionId,
  pointsRequested,
  discountCode,
  expiresInDays,
  idempotencyKey,
  redemptionChannel = "online_store",
  notifyStoreCreditOwner,
  loyaltyMaintenancePermit,
}: {
  storeId?: string;
  shopDomain?: string;
  shopifyCustomerId: string;
  rewardDefinitionId: string;
  pointsRequested?: bigint | string;
  discountCode?: string;
  expiresInDays?: number;
  idempotencyKey: string;
  redemptionChannel?: "online_store" | "pos";
  notifyStoreCreditOwner?: boolean;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const storeId = await resolveStoreId({
    storeId: explicitStoreId,
    shopDomain,
  });

  if (!storeId) {
    throw new Error("Shopify store not found.");
  }

  const shopper = await prisma.weleticShopper.findUnique({
    where: {
      storeId_shopifyCustomerId: {
        storeId,
        shopifyCustomerId: String(shopifyCustomerId),
      },
    },
    include: { loyaltyAccount: true },
  });

  if (!shopper || !shopper.loyaltyAccount) {
    throw new Error("Customer loyalty account not found.");
  }
  if (
    await hasShopifyCustomerPrivacyTombstone({
      storeId,
      shopifyCustomerId,
      email: shopper.email,
    })
  ) {
    throw new Error("Customer loyalty account has been redacted.");
  }

  let pointsCostOverride: bigint | undefined;
  let discountValueOverride: string | undefined;
  const reward = await prisma.weleticRewardDefinition.findFirst({
    where: {
      id: rewardDefinitionId,
      storeId,
      status: WeleticRewardStatus.active,
    },
  });
  if (!reward) {
    throw new Error("Reward is not available for this Shopify store.");
  }
  const configuredSalesChannel =
    reward.salesChannel ?? WeleticRewardSalesChannel.online_store;
  if (
    configuredSalesChannel !== WeleticRewardSalesChannel.both &&
    configuredSalesChannel !== redemptionChannel
  ) {
    throw new Error(
      redemptionChannel === "pos"
        ? "Reward is not available in Shopify POS."
        : "Reward is only available in Shopify POS.",
    );
  }
  if (reward.exchangeType === "incremental") {
    if (
      reward.rewardType !== "amount_off" ||
      !reward.pointsStep ||
      !reward.discountValue
    ) {
      throw new Error("Incremental reward is not available.");
    }
    const minimum = reward.minPointsCost ?? reward.pointsCost;
    pointsCostOverride = validateCustomerIncrementalPointsRequest({
      pointsRequested,
      minimum,
      maximum: reward.maxPointsCost,
      step: reward.pointsStep,
    });
    let discount = new Prisma.Decimal(reward.discountValue).mul(
      (pointsCostOverride / reward.pointsStep).toString(),
    );
    if (
      reward.maxDiscountValue &&
      discount.greaterThan(reward.maxDiscountValue)
    ) {
      discount = new Prisma.Decimal(reward.maxDiscountValue);
    }
    discountValueOverride = discount.toFixed();
    if (!/^\d+$/.test(discountValueOverride)) {
      throw new Error(
        "Calculated reward discount must be an integer number of minor currency units.",
      );
    }
  } else if (pointsRequested !== undefined) {
    throw new Error(
      "Points selection is only allowed for incremental rewards.",
    );
  }

  const result = await redeemReward({
    storeId,
    accountId: shopper.loyaltyAccount.id,
    rewardDefinitionId,
    pointsCostOverride,
    discountValueOverride,
    discountCode,
    expiresInDays,
    idempotencyKey,
    notifyStoreCreditOwner,
    loyaltyMaintenancePermit,
  });

  return {
    success: true,
    redemptionId: result.redemption.id,
    artifactKind: result.redemption.artifactKind,
    artifactCode:
      result.redemption.artifactKind === WeleticRewardArtifactKind.store_credit
        ? null
        : result.discountCode,
    // Backward-compatible alias. New consumers should branch on artifactKind
    // and use artifactCode so store-credit references are never presented.
    discountCode: result.discountCode,
    giftCardCode:
      result.redemption.artifactKind === WeleticRewardArtifactKind.gift_card
        ? result.discountCode
        : null,
    pointsSpent: result.redemption.pointsSpent.toString(),
    status: result.redemption.status,
    expiresAt: result.redemption.expiresAt,
    newBalance: result.ledgerEntry.balanceAfter.toString(),
  };
}

export async function bindCustomerReferral({
  storeId: explicitStoreId,
  shopDomain,
  shopifyCustomerId,
  referralCode,
  loyaltyMaintenancePermit,
}: {
  storeId?: string;
  shopDomain?: string;
  shopifyCustomerId: string;
  referralCode: string;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const storeId = await resolveStoreId({
    storeId: explicitStoreId,
    shopDomain,
  });

  if (!storeId) {
    throw new Error("Shopify store not found.");
  }

  const shopper = await prisma.weleticShopper.findUnique({
    where: {
      storeId_shopifyCustomerId: {
        storeId,
        shopifyCustomerId: String(shopifyCustomerId),
      },
    },
    include: { loyaltyAccount: true },
  });

  if (!shopper || !shopper.loyaltyAccount) {
    throw new Error("Customer loyalty account not found.");
  }
  if (
    await hasShopifyCustomerPrivacyTombstone({
      storeId,
      shopifyCustomerId,
      email: shopper.email,
    })
  ) {
    throw new Error("Customer loyalty account has been redacted.");
  }

  const referral = await bindShopperReferral({
    storeId,
    refereeAccountId: shopper.loyaltyAccount.id,
    referralCode,
    loyaltyMaintenancePermit,
  });

  return {
    success: true,
    status: referral.status,
  };
}
