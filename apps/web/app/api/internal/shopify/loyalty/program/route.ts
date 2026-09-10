import { prisma } from "@/lib/prisma";
import { normalizeStoredLoyaltyBranding } from "@/lib/weletic/loyalty/branding";
import { serializeCustomerEarningRule } from "@/lib/weletic/loyalty/earning-actions";
import { projectPublicLoyaltyNudges } from "@/lib/weletic/loyalty/nudge-public-projection";
import {
  loyaltyErrorResponse,
  loyaltySuccessResponse,
} from "@/lib/weletic/loyalty/response";
import {
  isReferralCouponProvisionable,
  isRewardAvailableOnSalesChannel,
  listRewardDefinitions,
} from "@/lib/weletic/loyalty/rewards";
import { currencyMinorUnits } from "@/lib/weletic/money";
import {
  readWeleticShopifyRequestBody,
  verifyWeleticShopifyRequest,
} from "@/lib/weletic/shopify/service-auth";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import {
  WeleticRewardExchangeType,
  WeleticRewardSalesChannel,
  WeleticRewardStatus,
} from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // 1. Verify HMAC signature
  const bodyText = (await readWeleticShopifyRequestBody(request)) ?? "";
  if (!verifyWeleticShopifyRequest({ request, body: bodyText })) {
    return loyaltyErrorResponse(
      "unauthorized",
      "Unauthorized service request",
      401,
    );
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  if (!shop) {
    return loyaltyErrorResponse("bad_request", "Missing shop parameter", 400);
  }

  // 2. Resolve store identity
  const resolution = await resolveShopifyStoreByDomain(shop);
  if (!resolution) {
    return loyaltyErrorResponse(
      "store_not_found",
      `Store ${shop} not found`,
      404,
    );
  }

  const store = resolution.storeId
    ? await prisma.weleticShopifyStore.findUnique({
        where: { id: resolution.storeId },
        select: {
          id: true,
          shopCurrency: true,
          storeAccessState: true,
          complianceState: true,
          uninstalledAt: true,
          redactedAt: true,
          installationGeneration: true,
        },
      })
    : null;

  if (!store) {
    return loyaltyErrorResponse(
      "store_not_found",
      `Store record not found`,
      404,
    );
  }

  try {
    const now = new Date();
    const [program, tiers, earnRules, rewards, referralRule] =
      await Promise.all([
        prisma.weleticLoyaltyProgram.findUnique({
          where: { storeId: store.id },
          select: {
            name: true,
            pointNameSingular: true,
            pointNamePlural: true,
            pointsPerCurrencyUnit: true,
            vipMilestoneMode: true,
            vipTimeframe: true,
            status: true,
            killSwitchActive: true,
            branding: true,
            metadata: true,
          },
        }),
        prisma.weleticLoyaltyTier.findMany({
          where: { program: { storeId: store.id }, deletedAt: null },
          orderBy: { tierOrder: "asc" },
          select: {
            id: true,
            name: true,
            slug: true,
            tierOrder: true,
            minSpendThreshold: true,
            minPointsThreshold: true,
            pointsMultiplier: true,
            entryBonusPoints: true,
            perks: true,
            iconUrl: true,
            color: true,
          },
        }),
        prisma.weleticLoyaltyEarningRule.findMany({
          where: {
            program: { storeId: store.id },
            isActive: true,
            deletedAt: null,
            OR: [{ startAt: null }, { startAt: { lte: now } }],
            AND: [{ OR: [{ endAt: null }, { endAt: { gt: now } }] }],
          },
          orderBy: { createdAt: "asc" },
        }),
        listRewardDefinitions({
          storeId: store.id,
          status: WeleticRewardStatus.active,
          provisionableOnly: true,
        }),
        prisma.weleticLoyaltyReferralRule.findFirst({
          where: { program: { storeId: store.id }, isActive: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            isActive: true,
            advocateRewardKind: true,
            advocatePointsReward: true,
            advocateRewardDefinitionId: true,
            refereeRewardKind: true,
            refereePointsReward: true,
            refereeRewardDefinitionId: true,
            minQualifyingOrderSubtotal: true,
          },
        }),
      ]);

    const friendReward = referralRule?.refereeRewardDefinitionId
      ? rewards.find(
          (reward) => reward.id === referralRule.refereeRewardDefinitionId,
        )
      : null;
    const advocateReward = referralRule?.advocateRewardDefinitionId
      ? rewards.find(
          (reward) => reward.id === referralRule.advocateRewardDefinitionId,
        )
      : null;
    const hasProvisionableReferralReward = ({
      kind,
      points,
      reward,
    }: {
      kind: string;
      points: bigint;
      reward: (typeof rewards)[number] | null | undefined;
    }) =>
      kind === "points"
        ? points > BigInt(0)
        : kind === "coupon" &&
          Boolean(
            reward &&
              reward.exchangeType === WeleticRewardExchangeType.fixed &&
              (reward.salesChannel === WeleticRewardSalesChannel.online_store ||
                reward.salesChannel === WeleticRewardSalesChannel.both) &&
              isReferralCouponProvisionable(reward),
          );
    const hasProvisionableAdvocateReward = Boolean(
      referralRule &&
        hasProvisionableReferralReward({
          kind: referralRule.advocateRewardKind,
          points: referralRule.advocatePointsReward,
          reward: advocateReward,
        }),
    );
    const hasProvisionableFriendReward = Boolean(
      referralRule &&
        hasProvisionableReferralReward({
          kind: referralRule.refereeRewardKind,
          points: referralRule.refereePointsReward,
          reward: friendReward,
        }),
    );
    const hasProvisionableReferralOffer =
      hasProvisionableAdvocateReward && hasProvisionableFriendReward;

    const branding = normalizeStoredLoyaltyBranding(
      program?.branding,
      program?.name,
    );
    const publicTiers = tiers.map((tier) => ({
      id: tier.id,
      name: tier.name,
      slug: tier.slug,
      tierOrder: tier.tierOrder,
      minSpendThreshold: tier.minSpendThreshold.toString(),
      minPointsThreshold: tier.minPointsThreshold.toString(),
      pointsMultiplier: tier.pointsMultiplier.toString(),
      entryBonusPoints: tier.entryBonusPoints.toString(),
      perks: Array.isArray(tier.perks)
        ? tier.perks.filter((perk): perk is string => typeof perk === "string")
        : [],
      iconUrl: tier.iconUrl,
      color: tier.color,
    }));
    const publicRewards = rewards
      .filter((reward) =>
        isRewardAvailableOnSalesChannel(
          reward,
          WeleticRewardSalesChannel.online_store,
        ),
      )
      .map((reward) => ({
        id: reward.id,
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
        entitlementCount:
          (Array.isArray(reward.entitledCollectionIds)
            ? reward.entitledCollectionIds.length
            : 0) +
          (Array.isArray(reward.entitledProductIds)
            ? reward.entitledProductIds.length
            : 0) +
          (Array.isArray(reward.entitledVariantIds)
            ? reward.entitledVariantIds.length
            : 0),
        combinesWithProductDiscounts: reward.combinesWithProductDiscounts,
        combinesWithOrderDiscounts: reward.combinesWithOrderDiscounts,
        combinesWithShippingDiscounts: reward.combinesWithShippingDiscounts,
        usageLimitPerCustomer: reward.usageLimitPerCustomer,
        expiresInDays: reward.expiresInDays,
      }));

    return loyaltySuccessResponse({
      program: program
        ? {
            name: program.name,
            pointNameSingular: program.pointNameSingular,
            pointNamePlural: program.pointNamePlural,
            pointsPerCurrencyUnit: program.pointsPerCurrencyUnit.toString(),
            vipMilestoneMode: program.vipMilestoneMode,
            vipTimeframe: program.vipTimeframe,
            isActive: program.status === "active" && !program.killSwitchActive,
          }
        : null,
      branding,
      nudges: projectPublicLoyaltyNudges(
        program?.metadata,
        program?.status === "active" &&
          !program.killSwitchActive &&
          store.storeAccessState === "active" &&
          store.complianceState === "active" &&
          store.uninstalledAt === null &&
          store.redactedAt === null &&
          typeof store.installationGeneration === "string" &&
          store.installationGeneration.length > 0,
      ),
      currency: store.shopCurrency,
      currencyMinorUnits: currencyMinorUnits(store.shopCurrency),
      tiers: publicTiers,
      earningRules: earnRules
        .filter(
          (rule) =>
            (!rule.startAt || rule.startAt <= now) &&
            (!rule.endAt || rule.endAt > now),
        )
        .map(serializeCustomerEarningRule),
      rewards: publicRewards,
      referralOffer:
        referralRule && hasProvisionableReferralOffer
          ? {
              isActive: referralRule.isActive,
              friendClaimEnabled: Boolean(
                program?.status === "active" &&
                  !program.killSwitchActive &&
                  referralRule.refereeRewardKind === "coupon" &&
                  hasProvisionableFriendReward,
              ),
              advocateRewardKind: referralRule.advocateRewardKind,
              advocatePointsReward:
                referralRule.advocatePointsReward.toString(),
              advocateRewardName: advocateReward?.name ?? null,
              friendRewardKind: referralRule.refereeRewardKind,
              friendPointsReward: referralRule.refereePointsReward.toString(),
              friendRewardName: friendReward?.name ?? null,
              minimumOrderSubtotal:
                referralRule.minQualifyingOrderSubtotal?.toString() ?? null,
            }
          : null,
    });
  } catch (error: any) {
    console.error("[Internal Loyalty Program Error]", error);
    return loyaltyErrorResponse(
      "internal_error",
      "Failed to load loyalty program metadata",
      500,
    );
  }
}
