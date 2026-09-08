"use client";

import { Crown, Edit2, Plus, Sparkles, Trash2 } from "lucide-react";
import React from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi } from "../api-client";
import { formatCurrency, formatPoints } from "../currency-helpers";
import { ModalVipTier } from "../modals/modal-vip-tier";

export interface TabVipProps {
  tiers: any[];
  onConfigure: () => void;
  currency?: string;
  onRefresh: () => void;
}

export function TabVip({
  tiers = [],
  onConfigure,
  currency = "USD",
  onRefresh,
}: TabVipProps) {
  const [modalOpen, setModalOpen] = React.useState(false);
  const [editingTier, setEditingTier] = React.useState<any | null>(null);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const sortedTiers = [...tiers].sort(
    (a, b) => (a.tierOrder || 0) - (b.tierOrder || 0),
  );

  const handleDeleteTier = async (tierId: string) => {
    if (!confirm("Are you sure you want to delete this VIP tier?")) return;
    try {
      setDeletingId(tierId);
      await LoyaltyAdminApi.deleteTier(tierId);
      toast.success("VIP tier deleted successfully");
      onRefresh();
    } catch (err: any) {
      toast.error(err.message || "Failed to delete tier");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            VIP Tiers & Progression
          </h2>
          <p className="text-xs text-gray-500">
            Structure ascending VIP tiers with increasing points multipliers,
            entry bonuses, and exclusive shopper perks.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditingTier(null);
            setModalOpen(true);
          }}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-black px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-800"
        >
          <Plus className="h-4 w-4" /> Add VIP Tier
        </button>
      </div>

      {/* Tiers List */}
      {sortedTiers.length === 0 ? (
        <div className="rounded-2xl border border-gray-200/80 bg-white p-12 text-center shadow-sm">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600">
            <Crown className="h-6 w-6" />
          </div>
          <h3 className="text-sm font-semibold text-gray-900">
            No VIP Tiers Configured
          </h3>
          <p className="mx-auto mb-4 mt-1 max-w-sm text-xs text-gray-500">
            Add tier levels (e.g. Bronze, Silver, Gold, Platinum) with spend
            thresholds and points multipliers.
          </p>
          <button
            type="button"
            onClick={() => {
              setEditingTier(null);
              setModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-black px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-800"
          >
            <Plus className="h-4 w-4" /> Create First Tier
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {sortedTiers.map((tier, idx) => {
            const multiplier = parseFloat(tier.pointsMultiplier) || 1.0;
            const spend = tier.minSpendThreshold || 0;
            const points = tier.minPointsThreshold || 0;
            const entryBonus = tier.entryBonusPoints || 0;
            const perksList = Array.isArray(tier.perks) ? tier.perks : [];

            return (
              <div
                key={tier.id}
                className="flex flex-col justify-between rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm"
              >
                <div>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-amber-100 text-xs font-bold text-amber-700">
                        #{tier.tierOrder || idx + 1}
                      </div>
                      <div>
                        <h4 className="text-sm font-semibold text-gray-900">
                          {tier.name}
                        </h4>
                        <span className="mt-0.5 inline-block rounded-md bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-600">
                          {multiplier}x Points
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setEditingTier(tier);
                          setModalOpen(true);
                        }}
                        className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-black"
                      >
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={deletingId === tier.id}
                        onClick={() => handleDeleteTier(tier.id)}
                        className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 space-y-1 border-t border-gray-100 pt-3 text-xs text-gray-600">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Milestone Spend:</span>
                      <span className="font-semibold text-gray-900">
                        {formatCurrency(spend, currency, {
                          isMinorUnits: true,
                        })}
                      </span>
                    </div>
                    {Number(points) > 0 && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">
                          Points Requirement:
                        </span>
                        <span className="font-semibold text-gray-900">
                          {formatPoints(points)} pts
                        </span>
                      </div>
                    )}
                    {Number(entryBonus) > 0 && (
                      <div className="flex justify-between">
                        <span className="text-gray-400">Entry Bonus:</span>
                        <span className="font-semibold text-emerald-600">
                          +{formatPoints(entryBonus)} pts
                        </span>
                      </div>
                    )}
                  </div>

                  {perksList.length > 0 && (
                    <div className="mt-4 border-t border-gray-100 pt-3">
                      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                        Perks & Benefits
                      </div>
                      <div className="space-y-1.5">
                        {perksList.map((perk: string, pIdx: number) => (
                          <div
                            key={pIdx}
                            className="flex items-center gap-1.5 text-xs text-gray-700"
                          >
                            <Sparkles className="h-3 w-3 shrink-0 text-amber-500" />
                            <span className="truncate">{perk}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-2xl border border-gray-200 bg-white p-6">
        <h3 className="text-sm font-semibold">
          VIP Policy & Evaluation Criteria
        </h3>
        <p className="mt-1 text-xs text-gray-500">
          Qualification, evaluation windows and downgrade settings are managed
          in the shared Loyalty settings editor.
        </p>
        <button
          type="button"
          onClick={onConfigure}
          className="mt-3 rounded-lg border border-gray-300 px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2"
        >
          Configure VIP policy in Settings
        </button>
      </div>

      {modalOpen && (
        <ModalVipTier
          isOpen={modalOpen}
          onClose={() => {
            setModalOpen(false);
            setEditingTier(null);
          }}
          onSuccess={onRefresh}
          currency={currency}
          initialTier={editingTier}
          nextTierOrder={sortedTiers.length + 1}
        />
      )}
    </div>
  );
}
