"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  RefreshCw,
  Search,
} from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  LoyaltyActivityEntry,
  LoyaltyAdminApi,
  parseLoyaltyPointInteger,
  toLoyaltyActivityTableRow,
} from "../api-client";
import { formatPoints } from "../currency-helpers";

export interface TabActivityProps {
  isOwner?: boolean;
}

export function TabActivity({ isOwner = true }: TabActivityProps) {
  const [entries, setEntries] = useState<LoyaltyActivityEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [selectedType, setSelectedType] = useState("all");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<{
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }>({ page: 1, limit: 25, total: 0, totalPages: 1 });

  const fetchActivity = useCallback(async () => {
    try {
      setLoading(true);
      const res = await LoyaltyAdminApi.getActivity({
        page,
        limit: 25,
        type: selectedType,
        search: submittedSearch || undefined,
      });

      setEntries(res.entries || []);
      setPagination(
        res.pagination || { page: 1, limit: 25, total: 0, totalPages: 1 },
      );
    } catch (err: any) {
      toast.error(err.message || "Failed to load activity ledger");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [page, selectedType, submittedSearch]);

  useEffect(() => {
    fetchActivity();
  }, [fetchActivity]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittedSearch(search.trim());
    setPage(1);
  };

  const handleExportCsv = async () => {
    if (!isOwner) {
      toast.error("Only workspace owners can export the activity ledger CSV.");
      return;
    }
    try {
      setExporting(true);
      await LoyaltyAdminApi.exportActivityCsv();
      toast.success("Activity ledger exported successfully");
    } catch (err: any) {
      toast.error(err.message || "Failed to export CSV");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Controls */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            Append-Only Activity Ledger
          </h2>
          <p className="text-xs text-gray-500">
            Audit stream of all points issuances, holding period releases,
            redemptions, and manual adjustments.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <form onSubmit={handleSearchSubmit} className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search reference, note, customer..."
              className="w-60 rounded-lg border border-gray-200 py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-black"
            />
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
          </form>

          <select
            value={selectedType}
            onChange={(e) => {
              setSelectedType(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-black"
          >
            <option value="all">All Events</option>
            <option value="EARN_ORDER">Order Earn</option>
            <option value="EARN_REFERRAL">Referral Earn</option>
            <option value="EARN_BONUS">Bonus Campaign</option>
            <option value="REDEEM_REWARD">Redemption</option>
            <option value="REFUND_REVERSAL">Refund Reversal</option>
            <option value="MANUAL_ADJUSTMENT">Manual Adjustment</option>
            <option value="EXPIRATION">Points Expiration</option>
            <option value="BACKFILL">Historical Backfill</option>
            <option value="TIER_BONUS">VIP Tier Bonus</option>
          </select>

          <button
            type="button"
            disabled={exporting || !isOwner}
            onClick={handleExportCsv}
            title={
              !isOwner
                ? "Only owners can export CSV"
                : "Export activity ledger to CSV"
            }
            className="flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200 hover:text-black disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            {exporting ? "Exporting..." : "Export CSV"}
          </button>
        </div>
      </div>

      {/* Ledger Table */}
      <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-sm">
        {loading ? (
          <div className="p-12 text-center text-xs text-gray-400">
            <RefreshCw className="mx-auto mb-2 h-6 w-6 animate-spin text-gray-400" />
            Loading activity stream...
          </div>
        ) : entries.length === 0 ? (
          <div className="p-12 text-center">
            <History className="mx-auto mb-2 h-8 w-8 text-gray-300" />
            <p className="text-sm font-semibold text-gray-900">
              No Ledger Entries Found
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Ledger transactions will stream here as points are earned and
              redeemed.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100 text-xs">
              <thead className="bg-gray-50/75 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-4 py-3 text-left">Seq / Date</th>
                  <th className="px-4 py-3 text-left">Customer</th>
                  <th className="px-4 py-3 text-left">Event Type</th>
                  <th className="px-4 py-3 text-right">Points Delta</th>
                  <th className="px-4 py-3 text-right">Pending Delta</th>
                  <th className="px-4 py-3 text-right">New Balance</th>
                  <th className="px-4 py-3 text-left">Reference / Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {entries.map((entry) => {
                  const row = toLoyaltyActivityTableRow(entry);
                  const parsedDelta = parseLoyaltyPointInteger(row.pointsDelta);
                  const parsedPending = parseLoyaltyPointInteger(
                    row.pendingDelta,
                  );
                  const parsedBalance = parseLoyaltyPointInteger(
                    row.balanceAfter,
                  );
                  const delta =
                    parsedDelta.state === "valid" ? parsedDelta.value : null;
                  const isCredit = delta !== null && delta > BigInt(0);
                  const isDebit = delta !== null && delta < BigInt(0);

                  return (
                    <tr
                      key={entry.id}
                      className="transition-colors hover:bg-gray-50/50"
                    >
                      <td className="px-4 py-3">
                        <div className="font-mono font-semibold text-gray-900">
                          #{entry.sequenceNumber || entry.id?.slice(0, 8)}
                        </div>
                        <div className="text-[11px] text-gray-400">
                          {new Date(entry.createdAt).toLocaleString(undefined, {
                            dateStyle: "short",
                            timeStyle: "short",
                          })}
                        </div>
                      </td>

                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">
                          {row.customerName}
                        </div>
                        {row.customerEmail && (
                          <div className="text-[11px] text-gray-400">
                            {row.customerEmail}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3">
                        <span className="inline-flex items-center rounded-md bg-gray-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-700">
                          {entry.entryType || "ACTIVITY"}
                        </span>
                      </td>

                      <td className="px-4 py-3 text-right font-bold">
                        {parsedDelta.state === "invalid" ? (
                          <span
                            className="text-amber-700"
                            title="Invalid points ledger value"
                          >
                            {parsedDelta.display}
                          </span>
                        ) : isCredit ? (
                          <span className="flex items-center justify-end gap-0.5 text-emerald-600">
                            <ArrowUpRight className="h-3.5 w-3.5" />+
                            {formatPoints(parsedDelta.value)} pts
                          </span>
                        ) : isDebit ? (
                          <span className="flex items-center justify-end gap-0.5 text-red-600">
                            <ArrowDownRight className="h-3.5 w-3.5" />
                            {formatPoints(parsedDelta.value)} pts
                          </span>
                        ) : (
                          <span className="text-gray-400">0 pts</span>
                        )}
                      </td>

                      <td className="px-4 py-3 text-right">
                        {parsedPending.state === "invalid" ? (
                          <span
                            className="font-medium text-amber-700"
                            title="Invalid pending points ledger value"
                          >
                            {parsedPending.display}
                          </span>
                        ) : parsedPending.value !== BigInt(0) ? (
                          <span className="font-medium text-amber-600">
                            {parsedPending.value > BigInt(0)
                              ? `+${formatPoints(parsedPending.value)}`
                              : formatPoints(parsedPending.value)}{" "}
                            pts
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>

                      <td className="px-4 py-3 text-right font-mono font-semibold text-gray-900">
                        {parsedBalance.state === "invalid" ? (
                          <span
                            className="text-amber-700"
                            title="Invalid balance ledger value"
                          >
                            {parsedBalance.display}
                          </span>
                        ) : (
                          <>{formatPoints(parsedBalance.value)} pts</>
                        )}
                      </td>

                      <td className="px-4 py-3">
                        <div
                          className="max-w-xs truncate text-[11px] text-gray-600"
                          title={row.notes}
                        >
                          {row.notes}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {pagination.totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-gray-100 px-4 py-3 text-xs">
            <div className="text-gray-500">
              Showing page{" "}
              <span className="font-semibold">{pagination.page}</span> of{" "}
              <span className="font-semibold">{pagination.totalPages}</span> (
              {pagination.total} entries)
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="rounded-lg border border-gray-200 p-1.5 transition-colors hover:bg-gray-50 disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={page >= pagination.totalPages}
                onClick={() => setPage(page + 1)}
                className="rounded-lg border border-gray-200 p-1.5 transition-colors hover:bg-gray-50 disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
