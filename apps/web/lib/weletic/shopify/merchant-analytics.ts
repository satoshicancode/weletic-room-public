import type { Prisma } from "@prisma/client";
import { getLoyaltyDashboardOverview } from "../loyalty/analytics";
import { resolveLoyaltyFinancialConfiguration } from "../loyalty/analytics-financial";
import { escapeCsvUntrustedTextCell } from "../loyalty/csv";
import {
  merchantAnalyticsRequestSchema,
  merchantAnalyticsResponseSchema,
  merchantAnalyticsSnapshotSchema,
  type MerchantAnalyticsSnapshot,
} from "../loyalty/merchant-analytics-contract";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";

/** One row per scalar, shared with the JSON snapshot. Never export shopper rows. */
export function merchantAnalyticsCsv(snapshot: MerchantAnalyticsSnapshot) {
  const rows: string[][] = [["metric", "value"]];
  function visit(value: unknown, path: string) {
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value))
        visit(child, path ? `${path}.${key}` : key);
    } else rows.push([path, value === null ? "" : String(value)]);
  }
  visit(snapshot, "");
  return (
    rows
      .map((row) => row.map(escapeCsvUntrustedTextCell).join(","))
      .join("\r\n") + "\r\n"
  );
}

/** Caller verifies the signed body and runs authorization plus all reads on one
 * transaction. Reuse exact financial services; never infer a monetary valuation. */
export async function readShopifyMerchantAnalyticsInTransaction({
  tx,
  envelope,
  request,
  now = new Date(),
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
  now?: Date;
}) {
  const data = merchantAnalyticsRequestSchema.parse(request);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission:
      data.operation === "export" ? "analytics.export" : "analytics.read",
  });
  // Preserve existing owner-only financial-export policy even for delegated staff.
  if (data.operation === "export" && !actor.owner)
    throw new ShopifyStaffAuthorizationError("access_denied");
  if (
    data.operation === "export" &&
    data.expectedInstallationGeneration !== actor.installationGeneration
  )
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: actor.storeId },
    select: {
      projectId: true,
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
  if (!store || store.projectId !== actor.projectId)
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  const financial = resolveLoyaltyFinancialConfiguration({
    accountingCurrency: store.program.accountingCurrency,
    ...store.loyaltyProgram,
  });
  const dateRange = {
    startDate: data.filter.startAt ? new Date(data.filter.startAt) : undefined,
    endDate: data.filter.endAt ? new Date(data.filter.endAt) : undefined,
  };
  const where = {
    storeId: actor.storeId,
    createdAt: { gte: dateRange.startDate, lte: dateRange.endDate },
  };
  const overview = await getLoyaltyDashboardOverview({
    tx,
    storeId: actor.storeId,
    currency: financial.accountingCurrency,
    liabilityMinorUnitsNumerator:
      financial.valuation?.minorUnitsNumerator ?? BigInt(1),
    liabilityPointsDenominator:
      financial.valuation?.pointsDenominator ?? BigInt(1),
    dateRange,
    now,
  });
  const [rewards, referrals] = await Promise.all([
    tx.weleticRewardRedemption.groupBy({
      by: ["status", "artifactKind"],
      where,
      _count: { _all: true },
      _sum: { pointsSpent: true },
      orderBy: [{ status: "asc" }, { artifactKind: "asc" }],
    }),
    tx.weleticLoyaltyReferral.groupBy({
      by: ["status"],
      where,
      _count: { _all: true },
      orderBy: { status: "asc" },
    }),
  ]);
  const { liability, healthMetrics: health } = overview;
  const moneyAvailable = financial.valuation !== null;
  const referralMoneyAvailable =
    moneyAvailable && health.financialDataQuality.status === "available";
  const snapshot = merchantAnalyticsSnapshotSchema.parse({
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    generatedAt: now.toISOString(),
    filter: data.filter,
    currency: financial.accountingCurrency,
    canExport: actor.owner,
    financialStatus: !moneyAvailable
      ? "temporarily_unavailable"
      : health.financialDataQuality.status,
    financialReason: !moneyAvailable
      ? financial.reason
      : health.financialDataQuality.reason,
    liability: {
      circulatingPoints: String(liability.totalCirculatingPoints),
      pendingPoints: String(liability.totalPendingPoints),
      debtPoints: String(liability.negativeBalancePointsDebt),
      currentMinorUnits: moneyAvailable
        ? String(liability.totalLiabilityMinorUnits)
        : null,
      pendingMinorUnits: moneyAvailable
        ? String(liability.totalPendingLiabilityMinorUnits)
        : null,
      potentialMinorUnits: moneyAvailable
        ? String(liability.totalPotentialLiabilityMinorUnits)
        : null,
      totalMembers: String(liability.totalMembersCount),
      activeMembers: String(liability.activeMembersCount),
    },
    activity: {
      earned: String(health.totalPointsEarned),
      redeemed: String(health.totalPointsRedeemed),
      refundReversed: String(health.totalPointsRefundReversed),
      expired: String(health.totalPointsExpired),
      backfilled: String(health.totalPointsBackfilled),
      backfillCorrected: String(health.totalPointsBackfillCorrected),
      manualCredits: String(health.totalManualAdjustmentCredits),
      manualDebits: String(health.totalManualAdjustmentDebits),
    },
    referralEconomics: {
      total: String(health.referralMetrics.totalReferrals),
      successful: String(health.referralMetrics.successfulReferrals),
      revenueMinorUnits: referralMoneyAvailable
        ? health.referralMetrics.referralRevenueMinorUnits?.toString() ?? null
        : null,
      costMinorUnits: referralMoneyAvailable
        ? health.referralMetrics.referralRewardCostMinorUnits?.toString() ??
          null
        : null,
    },
    referrals: referrals.map((row) => ({
      status: row.status,
      count: String(row._count._all),
    })),
    rewards: rewards.map((row) => ({
      status: row.status,
      artifact: row.artifactKind,
      count: String(row._count._all),
      pointsSpent: String(row._sum.pointsSpent ?? BigInt(0)),
    })),
    tiers: overview.tierDistribution.map((tier) => ({
      name: tier.name,
      assignment: tier.assignment ?? "configured",
      members: String(tier.memberCount),
      pointsBalance: String(tier.totalPointsBalance),
      rollingSpendMinorUnits: String(tier.totalRollingSpend),
    })),
  });
  return merchantAnalyticsResponseSchema.parse({
    snapshot,
    download:
      data.operation === "export"
        ? {
            filename: `weletic-loyalty-analytics.${data.format}`,
            contentType:
              data.format === "csv"
                ? "text/csv; charset=utf-8"
                : "application/json; charset=utf-8",
            content:
              data.format === "csv"
                ? merchantAnalyticsCsv(snapshot)
                : JSON.stringify(snapshot, null, 2),
          }
        : null,
  });
}
