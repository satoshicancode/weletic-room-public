"use client";

import { Modal } from "@dub/ui";
import { AlertTriangle, History, ShieldAlert, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi } from "../api-client";
import { formatCurrency, formatPoints } from "../currency-helpers";

const BACKFILL_COMMITS_TEMPORARILY_DISABLED = true;

export interface ModalBackfillPreviewProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  previewData: any;
  currency?: string;
  isOwner?: boolean;
}

export function ModalBackfillPreview({
  isOpen,
  onClose,
  onSuccess,
  previewData,
  currency = "USD",
  isOwner = true,
}: ModalBackfillPreviewProps) {
  const [committing, setCommitting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const jobId = previewData?.jobId || previewData?.id;
  const shoppersCount = previewData?.totalShoppersCount || 0;
  const ordersCount = previewData?.totalOrdersCount || 0;
  const projectedPoints = previewData?.totalProjectedPoints || "0";
  const previewItems =
    previewData?.previewItemsSample || previewData?.previewItems || [];

  const handleCommit = async () => {
    if (!jobId) return;
    if (!isOwner) {
      toast.error("Only workspace owners can commit historical backfill jobs.");
      return;
    }

    try {
      setCommitting(true);
      await LoyaltyAdminApi.commitBackfill(jobId);
      toast.success(
        "Historical opening balances committed to ledger successfully!",
      );
      onSuccess();
      onClose();
    } catch (err: any) {
      toast.error(err.message || "Failed to commit backfill job");
    } finally {
      setCommitting(false);
    }
  };

  const handleCancel = async () => {
    if (!jobId) {
      onClose();
      return;
    }

    try {
      setCancelling(true);
      await LoyaltyAdminApi.cancelBackfill(jobId);
      toast.info("Backfill preview cancelled");
      onClose();
    } catch {
      onClose();
    } finally {
      setCancelling(false);
    }
  };

  return (
    <Modal showModal={isOpen} setShowModal={onClose}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 pb-4">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-indigo-50 p-2 text-indigo-600">
              <History className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-gray-900">
                Historical Order Backfill Preview
              </h3>
              <p className="text-xs text-gray-500">Job ID: {jobId}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!isOwner && (
          <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-red-200 bg-red-50 p-3">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <div className="text-xs text-red-800">
              <span className="font-semibold">Owner Permission Required:</span>{" "}
              Only workspace owners can commit historical backfill points into
              customer accounts.
            </div>
          </div>
        )}

        <div className="mt-4 grid grid-cols-3 gap-4">
          <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
            <div className="text-xs font-medium text-gray-500">
              Eligible Shoppers
            </div>
            <div className="mt-1 text-xl font-bold text-gray-900">
              {formatPoints(shoppersCount)}
            </div>
          </div>
          <div className="rounded-xl border border-gray-100 bg-gray-50 p-4">
            <div className="text-xs font-medium text-gray-500">
              Historical Orders
            </div>
            <div className="mt-1 text-xl font-bold text-gray-900">
              {formatPoints(ordersCount)}
            </div>
          </div>
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4">
            <div className="text-xs font-medium text-indigo-600">
              Projected Points
            </div>
            <div className="mt-1 text-xl font-bold text-indigo-700">
              {formatPoints(projectedPoints)}
            </div>
          </div>
        </div>

        {/* Sample breakdown */}
        <div className="mt-6">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-700">
            Immutable Order Snapshots (First 10)
          </h4>
          {previewItems.length === 0 ? (
            <div className="rounded-xl bg-gray-50 p-4 text-center text-xs text-gray-500">
              No historical orders found matching the filter criteria.
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-gray-100 text-xs">
              <table className="min-w-full divide-y divide-gray-100">
                <thead className="bg-gray-50 font-medium text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Order / Shopper</th>
                    <th className="px-3 py-2 text-center">Status</th>
                    <th className="px-3 py-2 text-right">Eligible Spend</th>
                    <th className="px-3 py-2 text-right">Opening Points</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {previewItems.map((item: any, i: number) => (
                    <tr key={i} className="hover:bg-gray-50/50">
                      <td className="px-3 py-2 font-mono text-[11px] text-gray-700">
                        {item.orderId ||
                          item.shopperId ||
                          item.accountId ||
                          `Order #${i + 1}`}
                      </td>
                      <td className="px-3 py-2 text-center text-gray-600">
                        {item.orderStatus || `${item.ordersCount} orders`}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-600">
                        {formatCurrency(
                          item.eligibleSpend,
                          item.currency || currency,
                          { isMinorUnits: true },
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-semibold text-emerald-600">
                        +{formatPoints(item.projectedPoints)} pts
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="mt-6 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3.5">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <div className="text-xs text-amber-800">
            <span className="font-semibold">Commit temporarily disabled:</span>{" "}
            Preview and audit remain available while the persisted-data release
            gates are completed. When enabled, each order will create one
            immutable ledger entry and one refund-safe earn grant.
          </div>
        </div>

        <div className="mt-6 flex items-center justify-between border-t border-gray-100 pt-6">
          <button
            type="button"
            onClick={handleCancel}
            disabled={cancelling || committing}
            className="rounded-lg bg-gray-100 px-4 py-2 text-xs font-semibold text-gray-600 transition-colors hover:bg-gray-200 hover:text-gray-900"
          >
            {cancelling ? "Cancelling..." : "Cancel Job"}
          </button>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-100"
            >
              Close Preview
            </button>
            <button
              type="button"
              onClick={handleCommit}
              disabled={
                BACKFILL_COMMITS_TEMPORARILY_DISABLED ||
                committing ||
                !isOwner ||
                shoppersCount === 0
              }
              className="flex items-center gap-1.5 rounded-lg bg-black px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            >
              {BACKFILL_COMMITS_TEMPORARILY_DISABLED
                ? "Commit Temporarily Unavailable"
                : committing
                  ? "Committing Balances..."
                  : "Commit Opening Balances"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
