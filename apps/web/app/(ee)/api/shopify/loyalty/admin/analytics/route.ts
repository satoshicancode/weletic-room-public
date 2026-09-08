import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getLoyaltyDashboardOverview,
  LoyaltyDashboardOverviewResult,
} from "@/lib/weletic/loyalty/analytics";
import {
  finiteCompatibilityNumber,
  formatRationalDecimal,
  resolveLoyaltyFinancialConfiguration,
} from "@/lib/weletic/loyalty/analytics-financial";
import { loyaltySuccessResponse } from "@/lib/weletic/loyalty/response";
import { Prisma } from "@prisma/client";

function parseOptionalDate(value: string | undefined, field: string) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new DubApiError({
      code: "bad_request",
      message: `${field} must be a valid date.`,
    });
  }
  return parsed;
}

// GET /api/shopify/loyalty/admin/analytics - Retrieve financial liability, health metrics, tier distribution, and referral economics
export const GET = withWorkspace(
  async ({ workspace, searchParams }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
      select: {
        id: true,
        program: { select: { accountingCurrency: true } },
        loyaltyProgram: {
          select: {
            liabilityValuationCurrency: true,
            liabilityMinorUnitsNumerator: true,
            liabilityPointsDenominator: true,
          },
        },
      },
    });

    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const financialConfiguration = resolveLoyaltyFinancialConfiguration({
      accountingCurrency: store.program.accountingCurrency,
      liabilityValuationCurrency:
        store.loyaltyProgram?.liabilityValuationCurrency,
      liabilityMinorUnitsNumerator:
        store.loyaltyProgram?.liabilityMinorUnitsNumerator,
      liabilityPointsDenominator:
        store.loyaltyProgram?.liabilityPointsDenominator,
    });
    const valuation = financialConfiguration.valuation;
    const currency = financialConfiguration.accountingCurrency;

    const startDate = parseOptionalDate(searchParams.startDate, "startDate");
    const endDate = parseOptionalDate(searchParams.endDate, "endDate");
    if (startDate && endDate && startDate > endDate) {
      throw new DubApiError({
        code: "bad_request",
        message: "startDate must not be after endDate.",
      });
    }

    const overview: LoyaltyDashboardOverviewResult = await prisma.$transaction(
      (tx) =>
        getLoyaltyDashboardOverview({
          storeId: store.id,
          currency,
          liabilityMinorUnitsNumerator:
            valuation?.minorUnitsNumerator ?? BigInt(1),
          liabilityPointsDenominator: valuation?.pointsDenominator ?? BigInt(1),
          dateRange:
            startDate || endDate
              ? {
                  startDate,
                  endDate,
                }
              : undefined,
          tx,
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const totalPointsEarned = overview.healthMetrics.totalPointsEarned;
    const totalPointsRedeemed = overview.healthMetrics.totalPointsRedeemed;
    const burnToEarnRatio =
      totalPointsEarned > BigInt(0)
        ? finiteCompatibilityNumber(
            formatRationalDecimal({
              numerator: totalPointsRedeemed,
              denominator: totalPointsEarned,
              fractionDigits: 2,
            }),
          )
        : 0;
    const liabilityAvailable = valuation !== null;
    const referralDataQuality = overview.healthMetrics.financialDataQuality;
    const financialMetrics = !liabilityAvailable
      ? {
          status: "temporarily_unavailable" as const,
          reason: financialConfiguration.reason,
          liabilityStatus: "temporarily_unavailable" as const,
          referralStatus: "temporarily_unavailable" as const,
          accountingCurrency: currency,
        }
      : referralDataQuality.status === "data_quality_error"
        ? {
            status: "data_quality_error" as const,
            reason: referralDataQuality.reason,
            liabilityStatus: "available" as const,
            referralStatus: "data_quality_error" as const,
            accountingCurrency: currency,
          }
        : {
            status: "available" as const,
            reason: null,
            liabilityStatus: "available" as const,
            referralStatus: "available" as const,
            accountingCurrency: currency,
          };
    const summary = {
      totalCirculatingPoints: overview.liability.totalCirculatingPoints,
      totalPendingPoints: overview.liability.totalPendingPoints,
      totalMintedPoints: totalPointsEarned,
      totalBurnedPoints: totalPointsRedeemed,
      totalPointsExpired: overview.healthMetrics.totalPointsExpired,
      estimatedLiability: liabilityAvailable
        ? overview.liability.totalLiabilityMinorUnits
        : null,
      breakageRate: overview.healthMetrics.breakageRate,
      redemptionRate: overview.healthMetrics.redemptionRate,
      burnToEarnRatio,
      activeMembersCount: overview.liability.activeMembersCount,
      totalMembersCount: overview.liability.totalMembersCount,
      participationRate: overview.healthMetrics.participationRate,
    };

    const unavailableReferralEconomics = !liabilityAvailable
      ? {
          ...overview.healthMetrics.referralMetrics,
          referralRewardCostMinorUnits: null,
          referralRevenueMinorUnits: null,
          referralCACMinorUnits: null,
          referralCAC: null,
          referralCACDecimal: null,
          referralROI: null,
          referralROIDecimal: null,
          referralROIMultiplier: null,
          referralROIMultiplierDecimal: null,
          referralROIReason: financialConfiguration.reason,
          dataQuality: {
            ...overview.healthMetrics.referralMetrics.dataQuality,
            status: "temporarily_unavailable" as const,
            reason: financialConfiguration.reason,
          },
        }
      : overview.healthMetrics.referralMetrics;
    const liability = !liabilityAvailable
      ? {
          ...overview.liability,
          valuationPerPointMinorUnits: null,
          liabilityMinorUnitsNumerator: null,
          liabilityPointsDenominator: null,
          totalLiabilityMinorUnits: null,
          totalPendingLiabilityMinorUnits: null,
          totalPotentialLiabilityMinorUnits: null,
          totalLiabilityDecimal: null,
          totalPendingLiabilityDecimal: null,
          totalPotentialLiabilityDecimal: null,
          averageLiabilityPerMemberMinorUnits: null,
        }
      : overview.liability;
    const health = !liabilityAvailable
      ? {
          ...overview.healthMetrics,
          referralMetrics: unavailableReferralEconomics,
          referralRevenueMinorUnits: null,
          referralRewardCostMinorUnits: null,
          referralCAC: null,
          referralROI: null,
          financialDataQuality: unavailableReferralEconomics.dataQuality,
        }
      : overview.healthMetrics;

    return loyaltySuccessResponse(
      {
        storeId: overview.storeId,
        currency: overview.currency,
        financialMetrics,
        summary,
        liability,
        health,
        healthMetrics: health,
        tiers: overview.tierDistribution,
        tierDistribution: overview.tierDistribution,
        referrals: unavailableReferralEconomics,
        referralEconomics: unavailableReferralEconomics,
        generatedAt: overview.generatedAt,
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.read"],
  },
);

export const OPTIONS = () => {
  return new Response(null, {
    status: 204,
    headers: COMMON_CORS_HEADERS,
  });
};
