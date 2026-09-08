"use client";

import {
  Calendar,
  Clock,
  Flame,
  PackageSearch,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi } from "../api-client";
import { ModalCampaign } from "../modals/modal-campaign";

function campaignProductTargetLabel(campaign: {
  eligibleSkus?: unknown;
  eligibleCollectionIds?: unknown;
}) {
  const skuCount = Array.isArray(campaign.eligibleSkus)
    ? campaign.eligibleSkus.length
    : 0;
  const collectionCount = Array.isArray(campaign.eligibleCollectionIds)
    ? campaign.eligibleCollectionIds.length
    : 0;
  if (skuCount === 0 && collectionCount === 0) return "All products";
  return [
    skuCount > 0 ? `${skuCount} SKU${skuCount === 1 ? "" : "s"}` : null,
    collectionCount > 0
      ? `${collectionCount} collection${collectionCount === 1 ? "" : "s"}`
      : null,
  ]
    .filter(Boolean)
    .join(" or ");
}

export interface TabBonusesProps {
  campaigns: any[];
  tiers?: any[];
  onRefresh: () => void;
}

export function TabBonuses({
  campaigns = [],
  tiers = [],
  onRefresh,
}: TabBonusesProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const now = new Date();

  const activeCampaigns = campaigns.filter((c) => {
    const startsAt = new Date(c.startAt);
    const endsAt = new Date(c.endAt);
    return c.isActive && startsAt <= now && endsAt > now;
  });

  const scheduledCampaigns = campaigns.filter((c) => {
    const startsAt = new Date(c.startAt);
    return startsAt > now;
  });

  const completedCampaigns = campaigns.filter((c) => {
    const startsAt = new Date(c.startAt);
    const endsAt = new Date(c.endAt);
    return endsAt <= now || (!c.isActive && startsAt <= now);
  });

  const handleDeleteCampaign = async (campaignId: string) => {
    if (!confirm("Are you sure you want to delete this bonus campaign?"))
      return;
    try {
      setDeletingId(campaignId);
      await LoyaltyAdminApi.deleteCampaign(campaignId);
      toast.success("Bonus campaign deleted");
      onRefresh();
    } catch (err: any) {
      toast.error(err.message || "Failed to delete campaign");
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
            Bonus Multiplier Campaigns
          </h2>
          <p className="text-xs text-gray-500">
            Launch time-limited points multiplier promotions (e.g. 2x Points
            Weekend) targeted by VIP tier, SKU, or Shopify collection.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="flex shrink-0 items-center gap-1.5 rounded-lg bg-black px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-800"
        >
          <Plus className="h-4 w-4" /> Create Campaign
        </button>
      </div>

      {/* Active Campaigns */}
      <div>
        <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-700">
          <Flame className="h-4 w-4 text-orange-500" />
          Active Campaigns ({activeCampaigns.length})
        </h3>
        {activeCampaigns.length === 0 ? (
          <div className="rounded-2xl border border-gray-200/80 bg-white p-8 text-center text-xs text-gray-500 shadow-sm">
            No active campaigns running right now.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {activeCampaigns.map((c) => (
              <div
                key={c.id}
                className="flex flex-col justify-between rounded-2xl border border-orange-200/80 bg-white p-5 shadow-sm"
              >
                <div>
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="mb-1 inline-block rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-orange-600">
                        Active Now
                      </span>
                      <h4 className="text-sm font-semibold text-gray-900">
                        {c.name}
                      </h4>
                    </div>
                  </div>

                  <div className="mt-3 text-2xl font-bold text-orange-600">
                    {c.multiplier}x Points
                  </div>

                  <div className="mt-3 space-y-1 border-t border-gray-100 pt-3 text-xs text-gray-500">
                    <div className="flex items-center gap-1.5">
                      <Clock className="h-3.5 w-3.5 text-gray-400" />
                      <span>
                        Ends: {new Date(c.endAt).toLocaleDateString()} at{" "}
                        {new Date(c.endAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <PackageSearch className="h-3.5 w-3.5 text-gray-400" />
                      <span>Products: {campaignProductTargetLabel(c)}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Users className="h-3.5 w-3.5 text-gray-400" />
                      <span>
                        Audience:{" "}
                        {c.eligibleTierIds?.length
                          ? c.eligibleTierIds
                              .map(
                                (id: string) =>
                                  tiers.find((tier) => tier.id === id)?.name ||
                                  "VIP tier",
                              )
                              .join(", ")
                          : "All Members"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Scheduled Campaigns */}
      {scheduledCampaigns.length > 0 && (
        <div>
          <h3 className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-700">
            <Calendar className="h-4 w-4 text-indigo-500" />
            Scheduled Upcoming ({scheduledCampaigns.length})
          </h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {scheduledCampaigns.map((c) => (
              <div
                key={c.id}
                className="flex flex-col justify-between rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm"
              >
                <div>
                  <div className="flex items-start justify-between">
                    <div>
                      <span className="mb-1 inline-block rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-600">
                        Upcoming
                      </span>
                      <h4 className="text-sm font-semibold text-gray-900">
                        {c.name}
                      </h4>
                    </div>
                    <button
                      type="button"
                      disabled={deletingId === c.id}
                      onClick={() => handleDeleteCampaign(c.id)}
                      className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="mt-3 text-2xl font-bold text-gray-900">
                    {c.multiplier}x Points
                  </div>

                  <div className="mt-3 space-y-1 border-t border-gray-100 pt-3 text-xs text-gray-500">
                    <div>Starts: {new Date(c.startAt).toLocaleString()}</div>
                    <div>Ends: {new Date(c.endAt).toLocaleString()}</div>
                    <div>Products: {campaignProductTargetLabel(c)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {completedCampaigns.length > 0 && (
        <div>
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
            Campaign history ({completedCampaigns.length})
          </h3>
          <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-sm">
            {completedCampaigns.map((campaign) => (
              <div
                key={campaign.id}
                className="flex items-center justify-between border-b border-gray-100 px-5 py-3 last:border-b-0"
              >
                <div>
                  <div className="text-sm font-medium text-gray-800">
                    {campaign.name}
                  </div>
                  <div className="text-[11px] text-gray-500">
                    {new Date(campaign.startAt).toLocaleString()} –{" "}
                    {new Date(campaign.endAt).toLocaleString()}
                  </div>
                </div>
                <span className="text-sm font-semibold text-gray-500">
                  {campaign.multiplier}x
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {modalOpen && (
        <ModalCampaign
          isOpen={modalOpen}
          onClose={() => setModalOpen(false)}
          onSuccess={onRefresh}
          tiers={tiers}
        />
      )}
    </div>
  );
}
