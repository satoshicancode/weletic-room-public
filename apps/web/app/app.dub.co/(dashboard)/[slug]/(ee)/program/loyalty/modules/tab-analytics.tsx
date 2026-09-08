"use client";

import { Download } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi, type LoyaltyCohortAnalytics } from "../api-client";
import { formatCurrency, formatPoints } from "../currency-helpers";

export interface TabAnalyticsProps {
  currency?: string;
  initialAnalytics?: any;
  isOwner?: boolean;
}

function analyticsDateRange(timeRange: string) {
  const now = new Date();
  let startDate: string | undefined;
  if (timeRange === "30d") {
    startDate = new Date(
      now.getTime() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
  } else if (timeRange === "90d") {
    startDate = new Date(
      now.getTime() - 90 * 24 * 60 * 60 * 1000,
    ).toISOString();
  } else if (timeRange === "ytd") {
    startDate = new Date(now.getFullYear(), 0, 1).toISOString();
  }
  return { startDate, endDate: now.toISOString() };
}

export function TabAnalytics({
  currency = "USD",
  initialAnalytics,
  isOwner = false,
}: TabAnalyticsProps) {
  const [analytics, setAnalytics] = useState<any>(initialAnalytics || null);
  const [cohorts, setCohorts] = useState<LoyaltyCohortAnalytics | null>(null);
  const [loading, setLoading] = useState(!initialAnalytics);
  const [exporting, setExporting] = useState<"json" | "csv" | null>(null);
  const [timeRange, setTimeRange] = useState("30d");

  const fetchAnalytics = useCallback(async () => {
    try {
      setLoading(true);
      const dateRange = analyticsDateRange(timeRange);
      const [analyticsResult, cohortResult] = await Promise.all([
        LoyaltyAdminApi.getAnalytics(dateRange),
        isOwner
          ? LoyaltyAdminApi.getAnalyticsCohorts(dateRange)
          : Promise.resolve(null),
      ]);
      setAnalytics(analyticsResult);
      setCohorts(cohortResult);
    } catch (err: any) {
      toast.error(err.message || "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [isOwner, timeRange]);

  const handleExport = async (format: "json" | "csv") => {
    try {
      setExporting(format);
      const blob = await LoyaltyAdminApi.getAnalyticsExport(
        format,
        analyticsDateRange(timeRange),
      );
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = `weletic-loyalty-analytics.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : "Analytics export failed",
      );
    } finally {
      setExporting(null);
    }
  };

  useEffect(() => {
    fetchAnalytics();
  }, [fetchAnalytics]);

  const summary = analytics?.summary || {};
  const circulating =
    summary.totalCirculatingPoints ??
    (analytics?.totalCirculatingPoints || "0");
  const pending =
    summary.totalPendingPoints ?? (analytics?.totalPendingPoints || "0");
  const minted =
    summary.totalMintedPoints ?? (analytics?.totalMintedPoints || "0");
  const burned =
    summary.totalBurnedPoints ?? (analytics?.totalBurnedPoints || "0");
  const liability = summary.estimatedLiability ?? analytics?.estimatedLiability;
  const expired =
    summary.totalPointsExpired ?? (analytics?.totalPointsExpired || "0");
  const breakage =
    summary.breakageRate !== undefined ? `${summary.breakageRate}%` : "—";
  const burnToEarn =
    summary.burnToEarnRatio !== undefined ? `${summary.burnToEarnRatio}x` : "—";
  const activeMembers =
    summary.activeMembersCount ?? (analytics?.activeMembersCount || 0);
  const totalMembers =
    summary.totalMembersCount ?? (analytics?.totalMembersCount || 0);

  const tierDistribution = Array.isArray(analytics?.tierDistribution)
    ? analytics.tierDistribution
    : [];

  const financialStatus = analytics?.financialMetrics;
  const liabilityUnavailable = financialStatus?.liabilityStatus !== "available";
  const referralUnavailable = financialStatus?.referralStatus !== "available";
  const referralMetrics = analytics?.referralEconomics || {};

  return (
    <div className="space-y-6">
      {/* Header & Date Range Filter */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            Program Economics & Liability
          </h2>
          <p className="text-xs text-gray-500">
            Real-time signed-delta points accounting, outstanding balance
            liability, and customer cohort economics.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isOwner && (
            <div className="flex items-center gap-1">
              {(["csv", "json"] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  disabled={
                    exporting !== null ||
                    financialStatus?.status !== "available"
                  }
                  onClick={() => handleExport(format)}
                  className="flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  {exporting === format ? "Exporting…" : format.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2 rounded-xl bg-gray-100 p-1">
            {[
              { id: "30d", label: "Last 30 Days" },
              { id: "90d", label: "Last 90 Days" },
              { id: "ytd", label: "Year to Date" },
              { id: "all", label: "All Time" },
            ].map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setTimeRange(r.id)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
                  timeRange === r.id
                    ? "bg-white text-black shadow-sm"
                    : "text-gray-600 hover:text-black"
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {financialStatus?.status !== "available" && (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          {financialStatus?.reason ||
            "Monetary analytics are unavailable. Points activity remains available."}
        </div>
      )}

      {/* Financial Liability Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium text-gray-500">
            Circulating Points
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {formatPoints(circulating)}
          </div>
          <div className="mt-1 text-[11px] text-gray-400">
            Available for redemption
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium text-gray-500">
            Pending Points
          </div>
          <div className="mt-2 text-2xl font-bold text-amber-600">
            +{formatPoints(pending)}
          </div>
          <div className="mt-1 text-[11px] text-gray-400">
            Under return window holding
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium text-gray-500">
            Estimated Balance Liability
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {liabilityUnavailable || liability == null
              ? "Unavailable"
              : formatCurrency(liability, currency, { isMinorUnits: true })}
          </div>
          <div className="mt-1 text-[11px] text-gray-400">
            {liabilityUnavailable
              ? "Exact valuation is not configured"
              : "Monetary reward value at risk"}
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium text-gray-500">
            Expired Points
          </div>
          <div className="mt-2 text-2xl font-bold text-rose-600">
            {formatPoints(expired)}
          </div>
          <div className="mt-1 text-[11px] text-gray-400">
            Balance removed by inactivity policy
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="text-xs font-medium text-gray-500">
            Projected Breakage Rate
          </div>
          <div className="mt-2 text-2xl font-bold text-indigo-600">
            {breakage}
          </div>
          <div className="mt-1 text-[11px] text-gray-400">
            Unclaimed points post-expiry
          </div>
        </div>
      </div>

      {/* Program Velocity & Health */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-4 rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900">
            Minted vs Burned Dynamics
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-emerald-100 bg-emerald-50/50 p-4">
              <div className="text-xs font-semibold text-emerald-700">
                Points Minted (Earned)
              </div>
              <div className="mt-1 text-xl font-bold text-emerald-900">
                {formatPoints(minted)}
              </div>
            </div>
            <div className="rounded-xl border border-purple-100 bg-purple-50/50 p-4">
              <div className="text-xs font-semibold text-purple-700">
                Points Burned (Redeemed)
              </div>
              <div className="mt-1 text-xl font-bold text-purple-900">
                {formatPoints(burned)}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-gray-100 pt-2 text-xs text-gray-600">
            <span>Burn-to-Earn Velocity Ratio:</span>
            <span className="font-bold text-gray-900">{burnToEarn}</span>
          </div>
        </div>

        <div className="space-y-4 rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900">
            Member Participation
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-4">
              <div className="text-xs font-semibold text-blue-700">
                Active Participating Members
              </div>
              <div className="mt-1 text-xl font-bold text-blue-900">
                {formatPoints(activeMembers)}
              </div>
            </div>
            <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
              <div className="text-xs font-semibold text-gray-700">
                Total Enrolled Shoppers
              </div>
              <div className="mt-1 text-xl font-bold text-gray-900">
                {formatPoints(totalMembers)}
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between border-t border-gray-100 pt-2 text-xs text-gray-600">
            <span>Active Participation Rate:</span>
            <span className="font-bold text-gray-900">
              {Number(totalMembers) > 0
                ? `${Math.round((Number(activeMembers) / Number(totalMembers)) * 100)}%`
                : "0%"}
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900">
            Referral economics
          </h3>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div>
              <div className="text-xs text-gray-500">CAC</div>
              <div className="mt-1 font-semibold text-gray-900">
                {referralUnavailable ||
                referralMetrics.referralCACDecimal == null
                  ? "Unavailable"
                  : `${currency} ${referralMetrics.referralCACDecimal}`}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">ROI</div>
              <div className="mt-1 font-semibold text-gray-900">
                {referralUnavailable ||
                referralMetrics.referralROIDecimal == null
                  ? "Unavailable"
                  : `${referralMetrics.referralROIDecimal}%`}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Revenue multiple</div>
              <div className="mt-1 font-semibold text-gray-900">
                {referralUnavailable ||
                referralMetrics.referralROIMultiplierDecimal == null
                  ? "Unavailable"
                  : `${referralMetrics.referralROIMultiplierDecimal}x`}
              </div>
            </div>
          </div>
          {referralMetrics.referralROIReason && (
            <p className="mt-3 text-xs text-amber-700">
              {referralMetrics.referralROIReason}
            </p>
          )}
        </div>

        {isOwner && cohorts && (
          <div className="rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900">
              Member cohort economics
            </h3>
            {cohorts.dataQuality?.status !== "available" ? (
              <p className="mt-3 text-xs text-amber-700">
                {cohorts.dataQuality?.reason ||
                  "Cohort metrics are unavailable."}
              </p>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
                <div>
                  <div className="text-xs text-gray-500">Member AOV</div>
                  <div className="mt-1 font-semibold">
                    {currency} {cohorts.members?.aovDecimal ?? "—"}
                  </div>
                  <div className="mt-3 text-xs text-gray-500">Member LTV</div>
                  <div className="mt-1 font-semibold">
                    {currency} {cohorts.members?.ltvDecimal ?? "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Non-member AOV</div>
                  <div className="mt-1 font-semibold">
                    {currency} {cohorts.nonMembers?.aovDecimal ?? "—"}
                  </div>
                  <div className="mt-3 text-xs text-gray-500">AOV lift</div>
                  <div className="mt-1 font-semibold">
                    {cohorts.lift?.aovLiftPercentage == null
                      ? "—"
                      : `${cohorts.lift.aovLiftPercentage}%`}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* VIP Tier Distribution */}
      {tierDistribution.length > 0 && (
        <div className="rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
          <h3 className="mb-4 text-sm font-semibold text-gray-900">
            VIP Tier Cohort Distribution
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {tierDistribution.map((tier: any) => (
              <div
                key={tier.tierId || tier.name}
                className="rounded-xl border border-gray-100 bg-gray-50 p-4"
              >
                <div className="flex items-center justify-between text-xs font-semibold text-gray-900">
                  <span>{tier.name}</span>
                  <span className="rounded bg-amber-50 px-2 py-0.5 text-amber-600">
                    {tier.multiplier || "1.0"}x
                  </span>
                </div>
                <div className="mt-2 text-lg font-bold text-gray-900">
                  {formatPoints(
                    tier.memberCount || tier.customerCount || tier.count || 0,
                  )}{" "}
                  shoppers
                </div>
                <div className="mt-1 text-[11px] text-gray-500">
                  Avg Spend:{" "}
                  {formatCurrency(
                    tier.memberCount
                      ? Number(tier.totalRollingSpend || 0) / tier.memberCount
                      : tier.avgSpend || 0,
                    currency,
                    {
                      isMinorUnits: true,
                    },
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
