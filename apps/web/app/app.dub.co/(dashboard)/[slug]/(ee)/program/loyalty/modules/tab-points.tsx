"use client";

import { ChevronRight, Clock, Coins, Gift, Plus, Sparkles } from "lucide-react";
import React, { useState } from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi } from "../api-client";
import { formatCurrency, formatPoints } from "../currency-helpers";

export interface TabPointsProps {
  settings: any;
  analytics: any;
  earnRules: any[];
  rewards: any[];
  currency?: string;
  onNavigateTab: (tab: string) => void;
  onRefresh: () => void;
  isOwner?: boolean;
}

export function TabPoints({
  settings,
  analytics,
  earnRules = [],
  rewards = [],
  currency = "USD",
  onNavigateTab,
  onRefresh,
  isOwner = true,
}: TabPointsProps) {
  const [pointNameSingular, setPointNameSingular] = useState(
    settings?.pointNameSingular || "Point",
  );
  const [pointNamePlural, setPointNamePlural] = useState(
    settings?.pointNamePlural || "Points",
  );
  const [holdingPeriodDays, setHoldingPeriodDays] = useState(
    settings?.holdingPeriodDays !== undefined
      ? String(settings.holdingPeriodDays)
      : "14",
  );
  const [pointsExpiryWindow, setPointsExpiryWindow] = useState(
    settings?.pointsExpiryDays > 0
      ? `days:${settings.pointsExpiryDays}`
      : `months:${settings?.pointsExpiryMonths || 0}`,
  );
  const [pointsExpiryWarningDays, setPointsExpiryWarningDays] = useState(
    String(settings?.pointsExpiryWarningDays ?? 30),
  );
  const [pointsExpiryLastChanceDays, setPointsExpiryLastChanceDays] = useState(
    String(settings?.pointsExpiryLastChanceDays ?? 3),
  );
  const [pointsExpiryWarningEnabled, setPointsExpiryWarningEnabled] = useState(
    settings?.pointsExpiryWarningEnabled ?? true,
  );
  const [pointsExpiryLastChanceEnabled, setPointsExpiryLastChanceEnabled] =
    useState(settings?.pointsExpiryLastChanceEnabled ?? true);
  const [savingPolicy, setSavingPolicy] = useState(false);

  const summary = analytics?.summary || {};
  const circulatingPoints =
    summary.totalCirculatingPoints ??
    (analytics?.totalCirculatingPoints || "0");
  const pendingPoints =
    summary.totalPendingPoints ?? (analytics?.totalPendingPoints || "0");
  const mintedPoints =
    summary.totalMintedPoints ?? (analytics?.totalMintedPoints || "0");
  const burnedPoints =
    summary.totalBurnedPoints ?? (analytics?.totalBurnedPoints || "0");
  const estimatedLiability =
    summary.estimatedLiability ?? (analytics?.estimatedLiability || "0");

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setSavingPolicy(true);
      const [expiryUnit, rawExpiryValue] = pointsExpiryWindow.split(":");
      const expiryValue = parseInt(rawExpiryValue, 10) || 0;
      await LoyaltyAdminApi.updateSettings({
        pointNameSingular: pointNameSingular.trim() || "Point",
        pointNamePlural: pointNamePlural.trim() || "Points",
        holdingPeriodDays: parseInt(holdingPeriodDays, 10) || 0,
        pointsExpiryDays: expiryUnit === "days" ? expiryValue : 0,
        pointsExpiryMonths: expiryUnit === "months" ? expiryValue : 0,
        pointsExpiryWarningDays: parseInt(pointsExpiryWarningDays, 10) || 0,
        pointsExpiryLastChanceDays:
          parseInt(pointsExpiryLastChanceDays, 10) || 0,
        pointsExpiryWarningEnabled,
        pointsExpiryLastChanceEnabled,
      });
      toast.success("Points policy configuration saved");
      onRefresh();
    } catch (err: any) {
      toast.error(err.message || "Failed to save points policy");
    } finally {
      setSavingPolicy(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 4-Metric Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-gray-500">
            <span>Circulating Balance</span>
            <div className="rounded-lg bg-indigo-50 p-1.5 text-indigo-600">
              <Coins className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {formatPoints(circulatingPoints)}
          </div>
          <p className="mt-1 text-[11px] text-gray-400">
            Liability:{" "}
            {formatCurrency(estimatedLiability, currency, {
              isMinorUnits: true,
            })}
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-gray-500">
            <span>Pending (Holding Period)</span>
            <div className="rounded-lg bg-amber-50 p-1.5 text-amber-600">
              <Clock className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {formatPoints(pendingPoints)}
          </div>
          <p className="mt-1 text-[11px] text-gray-400">
            Releases upon return window maturity
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-gray-500">
            <span>Total Points Minted</span>
            <div className="rounded-lg bg-emerald-50 p-1.5 text-emerald-600">
              <Sparkles className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {formatPoints(mintedPoints)}
          </div>
          <p className="mt-1 text-[11px] text-gray-400">
            Lifetime accrued by shoppers
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-gray-500">
            <span>Total Points Burned</span>
            <div className="rounded-lg bg-purple-50 p-1.5 text-purple-600">
              <Gift className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {formatPoints(burnedPoints)}
          </div>
          <p className="mt-1 text-[11px] text-gray-400">
            Redeemed for discount vouchers
          </p>
        </div>
      </div>

      {/* Program Quick Cards */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Ways to Earn Summary */}
        <div className="flex flex-col justify-between rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="rounded-xl bg-emerald-50 p-2 text-emerald-600">
                  <Sparkles className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">
                    Ways to Earn
                  </h3>
                  <p className="text-xs text-gray-500">
                    {earnRules.filter((r) => r.isActive).length} active earning
                    rules
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab("earn")}
                className="flex items-center gap-1 rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-200"
              >
                Manage <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="mt-4 space-y-2">
              {earnRules.length === 0 ? (
                <p className="py-2 text-xs italic text-gray-400">
                  No earning rules configured yet.
                </p>
              ) : (
                earnRules.slice(0, 3).map((rule) => (
                  <div
                    key={rule.id}
                    className="flex items-center justify-between rounded-xl bg-gray-50 p-2.5 text-xs"
                  >
                    <span className="font-medium text-gray-800">
                      {rule.name}
                    </span>
                    <span className="rounded-md bg-emerald-50 px-2 py-0.5 font-semibold text-emerald-600">
                      {rule.multiplier
                        ? `${rule.multiplier}x points`
                        : "Active"}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => onNavigateTab("earn")}
            className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-gray-200 py-2 text-xs font-medium text-gray-600 transition-all hover:border-gray-400 hover:text-black"
          >
            <Plus className="h-3.5 w-3.5" /> Add Ways to Earn
          </button>
        </div>

        {/* Ways to Redeem Summary */}
        <div className="flex flex-col justify-between rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
          <div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="rounded-xl bg-purple-50 p-2 text-purple-600">
                  <Gift className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-gray-900">
                    Ways to Redeem
                  </h3>
                  <p className="text-xs text-gray-500">
                    {rewards.filter((r) => r.status === "active").length} active
                    reward vouchers
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigateTab("rewards")}
                className="flex items-center gap-1 rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-200"
              >
                Manage <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="mt-4 space-y-2">
              {rewards.length === 0 ? (
                <p className="py-2 text-xs italic text-gray-400">
                  No reward vouchers configured yet.
                </p>
              ) : (
                rewards.slice(0, 3).map((reward) => (
                  <div
                    key={reward.id}
                    className="flex items-center justify-between rounded-xl bg-gray-50 p-2.5 text-xs"
                  >
                    <span className="font-medium text-gray-800">
                      {reward.name}
                    </span>
                    <span className="rounded-md bg-purple-50 px-2 py-0.5 font-semibold text-purple-600">
                      {formatPoints(reward.pointsCost)} pts
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={() => onNavigateTab("rewards")}
            className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-gray-200 py-2 text-xs font-medium text-gray-600 transition-all hover:border-gray-400 hover:text-black"
          >
            <Plus className="h-3.5 w-3.5" /> Add Ways to Redeem
          </button>
        </div>
      </div>

      {/* Points Policy Configuration Card */}
      <div className="rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-100 pb-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">
              Points Policy & Terminology
            </h3>
            <p className="text-xs text-gray-500">
              Configure points naming, holding periods for return windows, and
              inactivity expiration rules.
            </p>
          </div>
        </div>

        <form onSubmit={handleSavePolicy} className="mt-6 space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Singular Name
              </label>
              <input
                type="text"
                value={pointNameSingular}
                onChange={(e) => setPointNameSingular(e.target.value)}
                placeholder="Point"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
              />
              <p className="mt-1 text-[11px] text-gray-400">
                e.g. Point, Xu, Điểm
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Plural Name
              </label>
              <input
                type="text"
                value={pointNamePlural}
                onChange={(e) => setPointNamePlural(e.target.value)}
                placeholder="Points"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
              />
              <p className="mt-1 text-[11px] text-gray-400">
                e.g. Points, Xu, Điểm
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Holding Period (Days)
              </label>
              <select
                value={holdingPeriodDays}
                onChange={(e) => setHoldingPeriodDays(e.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
              >
                <option value="0">0 Days (Instant Release)</option>
                <option value="7">7 Days</option>
                <option value="14">14 Days (Standard Return Window)</option>
                <option value="30">30 Days</option>
                <option value="60">60 Days</option>
              </select>
              <p className="mt-1 text-[11px] text-gray-400">
                Points stay pending during returns
              </p>
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
            <div className="mb-4">
              <h4 className="text-xs font-semibold text-gray-900">
                Points expiry
              </h4>
              <p className="mt-1 text-[11px] text-gray-500">
                Reset the entire available balance after continuous inactivity.
                Earning, redeeming, refunds, imports, and manual adjustments
                restart the rolling window.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-700">
                  Expiration period
                </label>
                <select
                  value={pointsExpiryWindow}
                  onChange={(e) => setPointsExpiryWindow(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
                >
                  <option value="months:0">Never expire</option>
                  <option value="days:3">3 days</option>
                  <option value="days:7">7 days</option>
                  <option value="months:1">1 month</option>
                  <option value="months:2">2 months</option>
                  <option value="months:3">3 months</option>
                  <option value="months:6">6 months</option>
                  <option value="months:12">1 year (recommended)</option>
                  <option value="months:24">2 years</option>
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-700">
                  Warning threshold
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    value={pointsExpiryWarningDays}
                    onChange={(e) => setPointsExpiryWarningDays(e.target.value)}
                    disabled={!pointsExpiryWarningEnabled}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black disabled:bg-gray-100"
                  />
                  <span className="text-xs text-gray-500">days</span>
                </div>
                <label className="mt-2 flex items-center gap-2 text-[11px] text-gray-600">
                  <input
                    type="checkbox"
                    checked={pointsExpiryWarningEnabled}
                    onChange={(e) =>
                      setPointsExpiryWarningEnabled(e.target.checked)
                    }
                  />
                  Send warning email
                </label>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-gray-700">
                  Last-chance threshold
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="0"
                    value={pointsExpiryLastChanceDays}
                    onChange={(e) =>
                      setPointsExpiryLastChanceDays(e.target.value)
                    }
                    disabled={!pointsExpiryLastChanceEnabled}
                    className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black disabled:bg-gray-100"
                  />
                  <span className="text-xs text-gray-500">days</span>
                </div>
                <label className="mt-2 flex items-center gap-2 text-[11px] text-gray-600">
                  <input
                    type="checkbox"
                    checked={pointsExpiryLastChanceEnabled}
                    onChange={(e) =>
                      setPointsExpiryLastChanceEnabled(e.target.checked)
                    }
                  />
                  Send last-chance email
                </label>
              </div>
            </div>

            <p className="mt-4 text-[11px] leading-5 text-gray-500">
              Reminder emails are sent only to customers who accepted marketing
              and have explicitly participated in the loyalty program.
            </p>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={savingPolicy}
              className="rounded-lg bg-black px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            >
              {savingPolicy ? "Saving Policy..." : "Save Points Policy"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
