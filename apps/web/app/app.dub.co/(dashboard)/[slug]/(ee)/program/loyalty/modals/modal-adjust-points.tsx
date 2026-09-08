"use client";

import { Modal } from "@dub/ui";
import { Award, ShieldAlert, X } from "lucide-react";
import React, { useState } from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi } from "../api-client";
import { formatPoints } from "../currency-helpers";

export interface ModalAdjustPointsProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  customer?: any;
  isOwner?: boolean;
}

export function ModalAdjustPoints({
  isOpen,
  onClose,
  onSuccess,
  customer,
  isOwner = true,
}: ModalAdjustPointsProps) {
  const [pointsDelta, setPointsDelta] = useState("");
  const [direction, setDirection] = useState<"add" | "deduct">("add");
  const [reason, setReason] = useState("");
  const [adjustmentType, setAdjustmentType] = useState("MANUAL_ADJUSTMENT");
  const [submitting, setSubmitting] = useState(false);

  const currentBalance = Number(
    customer?.pointsBalance || customer?.cachedPointsBalance || 0,
  );
  const deltaNum = parseInt(pointsDelta, 10) || 0;
  const effectiveDelta =
    direction === "add" ? Math.abs(deltaNum) : -Math.abs(deltaNum);
  const projectedBalance = currentBalance + effectiveDelta;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isOwner) {
      toast.error(
        "Only workspace owners can perform manual points adjustments.",
      );
      return;
    }

    if (!pointsDelta || deltaNum <= 0) {
      toast.error("Please enter a valid points amount");
      return;
    }

    if (!reason.trim()) {
      toast.error("An audit reason is required for points adjustments");
      return;
    }

    try {
      setSubmitting(true);
      await LoyaltyAdminApi.adjustCustomerPoints({
        shopperId: customer?.shopperId || customer?.id,
        accountId: customer?.accountId || customer?.id,
        pointsDelta: effectiveDelta,
        reason: reason.trim(),
        adjustmentType,
      });

      toast.success(
        `Successfully ${effectiveDelta > 0 ? "added" : "deducted"} ${formatPoints(Math.abs(effectiveDelta))} points`,
      );
      onSuccess();
      onClose();
    } catch (err: any) {
      toast.error(err.message || "Failed to adjust points balance");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal showModal={isOpen} setShowModal={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 pb-4">
          <div className="flex items-center gap-2">
            <div className="rounded-lg bg-amber-50 p-2 text-amber-600">
              <Award className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-gray-900">
                Adjust Points Balance
              </h3>
              <p className="text-xs text-gray-500">
                {customer?.shopper?.email ||
                  customer?.email ||
                  customer?.shopper?.firstName ||
                  "Customer"}
              </p>
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
              Only workspace owners can perform manual points adjustments.
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-1">
            <button
              type="button"
              onClick={() => setDirection("add")}
              className={`rounded-lg py-2 text-xs font-semibold transition-all ${
                direction === "add"
                  ? "bg-white text-emerald-700 shadow-sm"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              + Add Points (Credit)
            </button>
            <button
              type="button"
              onClick={() => setDirection("deduct")}
              className={`rounded-lg py-2 text-xs font-semibold transition-all ${
                direction === "deduct"
                  ? "bg-white text-red-700 shadow-sm"
                  : "text-gray-600 hover:text-gray-900"
              }`}
            >
              - Deduct Points (Debit)
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Points Amount
              </label>
              <input
                type="number"
                min="1"
                required
                disabled={!isOwner}
                value={pointsDelta}
                onChange={(e) => setPointsDelta(e.target.value)}
                placeholder="e.g. 250"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black disabled:bg-gray-100"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Adjustment Type
              </label>
              <select
                value={adjustmentType}
                disabled={!isOwner}
                onChange={(e) => setAdjustmentType(e.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black disabled:bg-gray-100"
              >
                <option value="MANUAL_ADJUSTMENT">Manual Adjustment</option>
                <option value="GOODWILL_BONUS">Customer Goodwill Bonus</option>
                <option value="CLAWBACK">Correction / Clawback</option>
                <option value="AUDIT_FIX">Audit Reconciliation</option>
              </select>
            </div>
          </div>

          {/* Live Balance Preview */}
          <div className="rounded-xl border border-gray-100 bg-gray-50 p-3">
            <div className="mb-1 text-xs text-gray-500">Balance Preview</div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-gray-600">
                Current: {formatPoints(currentBalance)} pts
              </span>
              <span className="font-semibold text-gray-400">→</span>
              <span
                className={`font-bold ${direction === "add" ? "text-emerald-600" : "text-red-600"}`}
              >
                Projected: {formatPoints(projectedBalance)} pts
              </span>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
              Audit Reason <span className="text-red-500">*</span>
            </label>
            <textarea
              required
              rows={2}
              disabled={!isOwner}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Resolved customer support ticket #1234 regarding order delay"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black disabled:bg-gray-100"
            />
          </div>

          <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-gray-100 px-4 py-2 text-xs font-semibold text-gray-700 transition-colors hover:bg-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !isOwner}
              className="rounded-lg bg-black px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            >
              {submitting ? "Processing..." : "Confirm Adjustment"}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
