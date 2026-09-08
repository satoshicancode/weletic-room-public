"use client";

import {
  Award,
  ChevronLeft,
  ChevronRight,
  Clock,
  RefreshCw,
  Search,
  Users,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi } from "../api-client";
import { formatPoints } from "../currency-helpers";
import { ModalAdjustPoints } from "../modals/modal-adjust-points";

export interface TabCustomersProps {
  tiers?: any[];
  isOwner?: boolean;
  onRefresh?: () => void;
}

export function TabCustomers({
  tiers = [],
  isOwner = true,
  onRefresh,
}: TabCustomersProps) {
  const [customers, setCustomers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [selectedTier, setSelectedTier] = useState("all");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<{
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  }>({ page: 1, limit: 10, total: 0, totalPages: 1 });

  const [selectedCustomer, setSelectedCustomer] = useState<any | null>(null);
  const [customerDetailLoading, setCustomerDetailLoading] = useState(false);
  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [adjustTargetCustomer, setAdjustTargetCustomer] = useState<any | null>(
    null,
  );

  const fetchCustomers = useCallback(async () => {
    try {
      setLoading(true);
      const res = await LoyaltyAdminApi.getCustomers({
        page,
        limit: 10,
        search: submittedSearch || undefined,
        tierId: selectedTier !== "all" ? selectedTier : undefined,
      });

      setCustomers(res.accounts || []);
      setPagination(
        res.pagination || { page: 1, limit: 10, total: 0, totalPages: 1 },
      );
    } catch (err: any) {
      toast.error(err.message || "Failed to load loyalty customer accounts");
      setCustomers([]);
    } finally {
      setLoading(false);
    }
  }, [page, selectedTier, submittedSearch]);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittedSearch(search.trim());
    setPage(1);
  };

  const openCustomerDetail = async (customer: any) => {
    setSelectedCustomer(customer);
    setCustomerDetailLoading(true);
    try {
      setSelectedCustomer(await LoyaltyAdminApi.getCustomer(customer.id));
    } catch (err: any) {
      toast.error(err.message || "Failed to load customer loyalty history");
    } finally {
      setCustomerDetailLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header & Filters */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            Customer Accounts & Balances
          </h2>
          <p className="text-xs text-gray-500">
            View member balances, tier progression, pending maturity points, and
            perform manual adjustments.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <form onSubmit={handleSearchSubmit} className="relative">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email, ref code..."
              className="w-64 rounded-lg border border-gray-200 py-1.5 pl-8 pr-3 text-xs focus:outline-none focus:ring-2 focus:ring-black"
            />
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-gray-400" />
          </form>

          <select
            value={selectedTier}
            onChange={(e) => {
              setSelectedTier(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-black"
          >
            <option value="all">All Tiers</option>
            {tiers.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            onClick={fetchCustomers}
            className="rounded-lg border border-gray-200 p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-black"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
          </button>
        </div>
      </div>

      {/* Customer Accounts Table */}
      <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-sm">
        {loading ? (
          <div className="p-12 text-center text-xs text-gray-400">
            <RefreshCw className="mx-auto mb-2 h-6 w-6 animate-spin text-gray-400" />
            Loading customer accounts...
          </div>
        ) : customers.length === 0 ? (
          <div className="p-12 text-center">
            <Users className="mx-auto mb-2 h-8 w-8 text-gray-300" />
            <p className="text-sm font-semibold text-gray-900">
              No Customers Found
            </p>
            <p className="mt-1 text-xs text-gray-500">
              {search || selectedTier !== "all"
                ? "No customer accounts match your search filters."
                : "Customers will appear here once they enroll or place qualifying orders."}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-100 text-xs">
              <thead className="bg-gray-50/75 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                <tr>
                  <th className="px-4 py-3 text-left">Customer</th>
                  <th className="px-4 py-3 text-left">VIP Tier</th>
                  <th className="px-4 py-3 text-right">Available Points</th>
                  <th className="px-4 py-3 text-right">Pending Points</th>
                  <th className="px-4 py-3 text-right">Lifetime Earned</th>
                  <th className="px-4 py-3 text-left">Referral Code</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {customers.map((c) => {
                  const firstName =
                    c.shopper?.firstName || c.customer?.firstName || "";
                  const lastName =
                    c.shopper?.lastName || c.customer?.lastName || "";
                  const fullName =
                    `${firstName} ${lastName}`.trim() || "Anonymous Member";
                  const email = c.shopper?.email || c.customer?.email || "—";
                  const tierName =
                    c.currentTier?.name || c.tierName || "Base Member";
                  const available = Number(
                    c.pointsBalance || c.cachedPointsBalance || 0,
                  );
                  const pending = Number(c.pendingPoints || 0);
                  const lifetime = Number(
                    c.lifetimeEarnedPoints ?? c.lifetimeEarned ?? 0,
                  );
                  const refCode =
                    c.referralCode || c.shopper?.referralCode || "—";

                  return (
                    <tr
                      key={c.id}
                      className="transition-colors hover:bg-gray-50/50"
                    >
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => openCustomerDetail(c)}
                          className="group text-left"
                        >
                          <div className="font-semibold text-gray-900 transition-colors group-hover:text-indigo-600">
                            {fullName}
                          </div>
                          <div className="font-mono text-[11px] text-gray-400">
                            {email}
                          </div>
                        </button>
                      </td>

                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 rounded-full border border-amber-200/50 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
                          <Award className="h-3 w-3" />
                          {tierName}
                        </span>
                      </td>

                      <td className="px-4 py-3 text-right font-bold text-gray-900">
                        {formatPoints(available)} pts
                      </td>

                      <td className="px-4 py-3 text-right">
                        {pending > 0 ? (
                          <span className="inline-flex items-center gap-1 font-medium text-amber-600">
                            <Clock className="h-3 w-3" /> +
                            {formatPoints(pending)} pts
                          </span>
                        ) : (
                          <span className="text-gray-400">0 pts</span>
                        )}
                      </td>

                      <td className="px-4 py-3 text-right text-gray-600">
                        {formatPoints(lifetime)} pts
                      </td>

                      <td className="px-4 py-3">
                        <span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-[11px] text-gray-700">
                          {refCode}
                        </span>
                      </td>

                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => {
                            setAdjustTargetCustomer(c);
                            setAdjustModalOpen(true);
                          }}
                          disabled={!isOwner}
                          title={
                            !isOwner
                              ? "Only workspace owners can adjust balances"
                              : "Adjust points"
                          }
                          className="rounded-lg bg-gray-100 px-2.5 py-1 text-[11px] font-medium text-gray-700 transition-colors hover:bg-gray-200 hover:text-black disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          Adjust
                        </button>
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
              {pagination.total} members)
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

      {selectedCustomer && (
        <section className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">
                Customer loyalty history
              </h3>
              <p className="mt-1 text-xs text-gray-500">
                {[
                  selectedCustomer.shopper?.firstName,
                  selectedCustomer.shopper?.lastName,
                ]
                  .filter(Boolean)
                  .join(" ") || "Anonymous member"}
                {selectedCustomer.shopper?.email
                  ? ` · ${selectedCustomer.shopper.email}`
                  : ""}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close customer loyalty history"
              onClick={() => setSelectedCustomer(null)}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {customerDetailLoading ? (
            <div className="py-8 text-center text-xs text-gray-500">
              <RefreshCw className="mx-auto mb-2 h-4 w-4 animate-spin" />
              Loading activity and rewards…
            </div>
          ) : (
            <div className="mt-4 grid gap-5 lg:grid-cols-2">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Points activity
                </h4>
                <div className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-100">
                  {(selectedCustomer.ledgerEntries || []).length === 0 ? (
                    <p className="p-4 text-xs text-gray-500">
                      No points activity yet.
                    </p>
                  ) : (
                    selectedCustomer.ledgerEntries.map((entry: any) => (
                      <div
                        key={entry.id}
                        className="flex items-center justify-between gap-4 p-3 text-xs"
                      >
                        <div>
                          <p className="font-medium text-gray-800">
                            {entry.reason ||
                              entry.entryType.replaceAll("_", " ")}
                          </p>
                          <p className="mt-0.5 text-[11px] text-gray-400">
                            {new Date(entry.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <span
                          className={
                            Number(entry.pointsDelta) >= 0
                              ? "font-semibold text-emerald-600"
                              : "font-semibold text-red-600"
                          }
                        >
                          {Number(entry.pointsDelta) >= 0 ? "+" : ""}
                          {formatPoints(entry.pointsDelta)} pts
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Coupon history
                </h4>
                <div className="mt-2 divide-y divide-gray-100 rounded-xl border border-gray-100">
                  {(selectedCustomer.redemptions || []).length === 0 ? (
                    <p className="p-4 text-xs text-gray-500">
                      No redeemed coupons yet.
                    </p>
                  ) : (
                    selectedCustomer.redemptions.map((redemption: any) => (
                      <div
                        key={redemption.id}
                        className="flex items-center justify-between gap-4 p-3 text-xs"
                      >
                        <div>
                          <p className="font-mono font-medium text-gray-800">
                            {redemption.shopifyDiscountCode || "Provisioning"}
                          </p>
                          <p className="mt-0.5 text-[11px] text-gray-400">
                            {new Date(redemption.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-semibold text-gray-800">
                            {formatPoints(redemption.pointsSpent)} pts
                          </p>
                          <p className="text-[11px] capitalize text-gray-500">
                            {redemption.status.replaceAll("_", " ")}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Adjust Modal */}
      {adjustModalOpen && (
        <ModalAdjustPoints
          isOpen={adjustModalOpen}
          onClose={() => {
            setAdjustModalOpen(false);
            setAdjustTargetCustomer(null);
          }}
          onSuccess={() => {
            fetchCustomers();
            if (onRefresh) onRefresh();
          }}
          customer={adjustTargetCustomer}
          isOwner={isOwner}
        />
      )}
    </div>
  );
}
