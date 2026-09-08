"use client";

import { Modal } from "@dub/ui";
import { Plus, Sparkles, Trash2, X } from "lucide-react";
import React, { useState } from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi } from "../api-client";
import {
  currencyInputStep,
  majorUnitsToMinorUnits,
  minorUnitsToMajorUnits,
} from "../currency-helpers";

export interface ModalVipTierProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  currency?: string;
  initialTier?: any;
  nextTierOrder?: number;
}

export function ModalVipTier({
  isOpen,
  onClose,
  onSuccess,
  currency = "USD",
  initialTier,
  nextTierOrder = 1,
}: ModalVipTierProps) {
  const amountStep = currencyInputStep(currency);

  const [name, setName] = useState(initialTier?.name || "");
  const [slug, setSlug] = useState(initialTier?.slug || "");
  const [tierOrder, setTierOrder] = useState(
    initialTier?.tierOrder !== undefined
      ? String(initialTier.tierOrder)
      : String(nextTierOrder),
  );
  const [minSpendThreshold, setMinSpendThreshold] = useState(
    initialTier?.minSpendThreshold !== undefined &&
      initialTier?.minSpendThreshold !== null
      ? minorUnitsToMajorUnits(initialTier.minSpendThreshold, currency)
      : "100",
  );
  const [minPointsThreshold, setMinPointsThreshold] = useState(
    initialTier?.minPointsThreshold !== undefined
      ? String(initialTier.minPointsThreshold)
      : "1000",
  );
  const [pointsMultiplier, setPointsMultiplier] = useState(
    initialTier?.pointsMultiplier !== undefined
      ? String(initialTier.pointsMultiplier)
      : "1.25",
  );
  const [entryBonusPoints, setEntryBonusPoints] = useState(
    initialTier?.entryBonusPoints !== undefined
      ? String(initialTier.entryBonusPoints)
      : "100",
  );
  const [perks, setPerks] = useState<string[]>(
    Array.isArray(initialTier?.perks)
      ? initialTier.perks
      : ["Exclusive VIP promotions", "Early access to new drops"],
  );
  const [newPerk, setNewPerk] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleAddPerk = () => {
    if (newPerk.trim()) {
      setPerks([...perks, newPerk.trim()]);
      setNewPerk("");
    }
  };

  const handleRemovePerk = (index: number) => {
    setPerks(perks.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Please enter a tier name");
      return;
    }

    const spendVal = parseFloat(minSpendThreshold) || 0;
    const calculatedMinSpend = majorUnitsToMinorUnits(spendVal, currency);

    const payload: any = {
      name: name.trim(),
      slug: (slug || name)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-"),
      tierOrder: parseInt(tierOrder, 10) || 1,
      minSpendThreshold: calculatedMinSpend,
      minPointsThreshold: parseInt(minPointsThreshold, 10) || 0,
      pointsMultiplier: parseFloat(pointsMultiplier) || 1.0,
      entryBonusPoints: parseInt(entryBonusPoints, 10) || 0,
      perks: perks.filter(Boolean),
    };

    try {
      setSubmitting(true);
      if (initialTier?.id) {
        payload.id = initialTier.id;
        payload.tierId = initialTier.id;
        await LoyaltyAdminApi.updateTier(payload);
        toast.success("VIP tier updated successfully");
      } else {
        await LoyaltyAdminApi.createTier(payload);
        toast.success("VIP tier created successfully");
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      toast.error(err.message || "Failed to save VIP tier");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal showModal={isOpen} setShowModal={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 pb-4">
          <h3 className="text-lg font-semibold text-gray-900">
            {initialTier ? "Edit VIP Tier" : "Add VIP Tier"}
          </h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Tier Name
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (
                    !slug ||
                    slug === name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
                  ) {
                    setSlug(
                      e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
                    );
                  }
                }}
                placeholder="e.g. Gold VIP, Diamond Tier"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Tier Order
              </label>
              <input
                type="number"
                min="1"
                required
                value={tierOrder}
                onChange={(e) => setTierOrder(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Spend Threshold ({currency})
              </label>
              <input
                type="number"
                step={amountStep}
                min="0"
                required
                value={minSpendThreshold}
                onChange={(e) => setMinSpendThreshold(e.target.value)}
                placeholder="100.00"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
              />
              <p className="mt-1 text-[11px] text-gray-500">
                Qualifying spend requirement
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Points Multiplier
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="0.05"
                  min="1.0"
                  required
                  value={pointsMultiplier}
                  onChange={(e) => setPointsMultiplier(e.target.value)}
                  placeholder="1.25"
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
                />
                <span className="absolute right-3 top-2.5 text-xs font-medium text-gray-400">
                  x
                </span>
              </div>
              <p className="mt-1 text-[11px] text-gray-500">
                e.g. 1.25x = 25% bonus points
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Points Threshold
              </label>
              <input
                type="number"
                min="0"
                value={minPointsThreshold}
                onChange={(e) => setMinPointsThreshold(e.target.value)}
                placeholder="1000"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
              />
              <p className="mt-1 text-[11px] text-gray-500">
                If milestone uses points
              </p>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Entry Bonus Points
              </label>
              <input
                type="number"
                min="0"
                value={entryBonusPoints}
                onChange={(e) => setEntryBonusPoints(e.target.value)}
                placeholder="100"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
              />
              <p className="mt-1 text-[11px] text-gray-500">
                Awarded upon tier level-up
              </p>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
              Tier Perks & Benefits
            </label>
            <div className="mb-2 space-y-2">
              {perks.map((perk, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-1.5 text-xs text-gray-700"
                >
                  <span className="flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                    {perk}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRemovePerk(idx)}
                    className="rounded p-0.5 text-gray-400 hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newPerk}
                onChange={(e) => setNewPerk(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddPerk();
                  }
                }}
                placeholder="e.g. Free express shipping on all orders"
                className="flex-1 rounded-lg border border-gray-200 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-black"
              />
              <button
                type="button"
                onClick={handleAddPerk}
                className="flex items-center gap-1 rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-200"
              >
                <Plus className="h-3.5 w-3.5" /> Add
              </button>
            </div>
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
              disabled={submitting}
              className="rounded-lg bg-black px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            >
              {submitting
                ? "Saving..."
                : initialTier
                  ? "Save Changes"
                  : "Create Tier"}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
