"use client";

import { LoyaltyConfigurationAdmin } from "@/ui/weletic/loyalty/configuration-admin";
import { History, RefreshCw, Sparkles } from "lucide-react";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi } from "../api-client";
import { formatPoints } from "../currency-helpers";
import { ModalBackfillPreview } from "../modals/modal-backfill-preview";

export interface TabSettingsProps {
  workspaceId: string;
  settings: { pointsPerCurrencyUnit?: string | number | null } | null;
  currency?: string;
  isOwner?: boolean;
  onRefresh: () => void;
}

export function TabSettings({
  workspaceId,
  settings,
  currency = "USD",
  isOwner = false,
  onRefresh,
}: TabSettingsProps) {
  // Backfill engine states
  const [backfillLookback, setBackfillLookback] = useState("all");
  const [backfillMinSubtotal, setBackfillMinSubtotal] = useState("0");
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [previewData, setPreviewData] = useState<any | null>(null);
  const [previewModalOpen, setPreviewModalOpen] = useState(false);

  const [backfillJobs, setBackfillJobs] = useState<any[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);

  const fetchJobs = async () => {
    try {
      setLoadingJobs(true);
      const jobs = await LoyaltyAdminApi.getBackfillJobs();
      setBackfillJobs(Array.isArray(jobs) ? jobs : []);
    } catch {
      setBackfillJobs([]);
    } finally {
      setLoadingJobs(false);
    }
  };

  useEffect(() => {
    fetchJobs();
  }, []);

  const handleGenerateBackfillPreview = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setGeneratingPreview(true);
      const lookbackDays =
        backfillLookback === "30d"
          ? 30
          : backfillLookback === "90d"
            ? 90
            : backfillLookback === "365d"
              ? 365
              : undefined;

      const minOrder = parseFloat(backfillMinSubtotal) || 0;

      const res = await LoyaltyAdminApi.createBackfillPreview({
        lookbackDays,
        minOrderAmount: minOrder > 0 ? minOrder : undefined,
        pointsPerCurrencyUnit: Number(settings?.pointsPerCurrencyUnit ?? 1),
      });

      setPreviewData(res);
      setPreviewModalOpen(true);
    } catch (err: any) {
      toast.error(err.message || "Failed to generate backfill preview");
    } finally {
      setGeneratingPreview(false);
    }
  };

  return (
    <div className="space-y-8">
      <LoyaltyConfigurationAdmin
        workspaceId={workspaceId}
        onSaved={onRefresh}
      />
      {/* 4. Historical Order Backfill Engine */}
      <div className="space-y-6 rounded-2xl border border-gray-200/80 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between border-b border-gray-100 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="rounded-xl bg-indigo-50 p-2 text-indigo-600">
              <History className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-900">
                Historical Order Backfill Engine
              </h3>
              <p className="text-xs text-gray-500">
                Import historical Shopify orders to credit opening points
                balances for existing customers.
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleGenerateBackfillPreview} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Lookback Window
              </label>
              <select
                value={backfillLookback}
                onChange={(e) => setBackfillLookback(e.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
              >
                <option value="30d">Last 30 Days</option>
                <option value="90d">Last 90 Days</option>
                <option value="365d">Last 1 Year (365 Days)</option>
                <option value="all">All Time (Full Store History)</option>
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Points Rate
              </label>
              <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-700">
                {String(settings?.pointsPerCurrencyUnit ?? 1)} pts per{" "}
                {currency}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Min Order Subtotal ({currency})
              </label>
              <input
                type="number"
                step="any"
                min="0"
                value={backfillMinSubtotal}
                onChange={(e) => setBackfillMinSubtotal(e.target.value)}
                placeholder="0.00"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={generatingPreview}
              className="flex items-center gap-1.5 rounded-lg bg-black px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {generatingPreview
                ? "Calculating Preview..."
                : "Generate Backfill Preview"}
            </button>
          </div>
        </form>

        {/* Backfill Jobs History */}
        <div className="border-t border-gray-100 pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-gray-700">
              Recent Backfill Jobs
            </h4>
            <button
              type="button"
              onClick={fetchJobs}
              className="rounded p-1 text-gray-400 hover:text-black"
            >
              <RefreshCw
                className={`h-3 w-3 ${loadingJobs ? "animate-spin" : ""}`}
              />
            </button>
          </div>

          {backfillJobs.length === 0 ? (
            <div className="rounded-xl bg-gray-50 p-6 text-center text-xs text-gray-400">
              No historical backfill jobs run yet.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-100 text-xs">
              <table className="min-w-full divide-y divide-gray-100">
                <thead className="bg-gray-50 font-medium text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Job ID</th>
                    <th className="px-3 py-2 text-left">Status</th>
                    <th className="px-3 py-2 text-right">Shoppers</th>
                    <th className="px-3 py-2 text-right">Committed Points</th>
                    <th className="px-3 py-2 text-left">Created At</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {backfillJobs.map((j) => (
                    <tr key={j.id} className="hover:bg-gray-50/50">
                      <td className="px-3 py-2 font-mono text-[11px] text-gray-700">
                        {j.id}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                            j.status === "completed"
                              ? "bg-emerald-50 text-emerald-700"
                              : j.status === "preview"
                                ? "bg-blue-50 text-blue-700"
                                : "bg-gray-100 text-gray-700"
                          }`}
                        >
                          {j.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-gray-900">
                        {formatPoints(j.totalShoppersCount || 0)}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-emerald-600">
                        {formatPoints(j.totalCommittedPoints ?? 0)} pts
                      </td>
                      <td className="px-3 py-2 text-[11px] text-gray-500">
                        {new Date(j.createdAt).toLocaleDateString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Backfill Preview Modal */}
      {previewModalOpen && (
        <ModalBackfillPreview
          isOpen={previewModalOpen}
          onClose={() => setPreviewModalOpen(false)}
          onSuccess={() => {
            fetchJobs();
            onRefresh();
          }}
          previewData={previewData}
          currency={currency}
          isOwner={isOwner}
        />
      )}
    </div>
  );
}
