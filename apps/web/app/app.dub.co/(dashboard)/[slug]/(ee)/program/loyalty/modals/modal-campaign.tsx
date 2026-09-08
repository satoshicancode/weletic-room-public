"use client";

import {
  MAX_BONUS_CAMPAIGN_DURATION_DAYS,
  MAX_BONUS_CAMPAIGN_MULTIPLIER,
  MIN_BONUS_CAMPAIGN_MULTIPLIER,
} from "@/lib/weletic/loyalty/bonus-campaign-policy";
import { Modal } from "@dub/ui";
import { Flame, X } from "lucide-react";
import React, { useState } from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi } from "../api-client";

export interface ModalCampaignProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
  tiers?: any[];
}

function localDateTimeValue(date: Date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
}

function parseIdentifierList(value: string) {
  return value
    .split(/[\n,]/)
    .map((identifier) => identifier.trim())
    .filter(Boolean);
}

export function ModalCampaign({
  isOpen,
  onClose,
  onSuccess,
  tiers = [],
}: ModalCampaignProps) {
  const [name, setName] = useState("");
  const [multiplier, setMultiplier] = useState("2.0");
  const [startsAt, setStartsAt] = useState(localDateTimeValue(new Date()));
  const [endsAt, setEndsAt] = useState(
    localDateTimeValue(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
  );
  const [targetTier, setTargetTier] = useState("all");
  const [eligibleSkus, setEligibleSkus] = useState("");
  const [eligibleCollectionIds, setEligibleCollectionIds] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error("Please enter a campaign name");
      return;
    }

    const mult = parseFloat(multiplier);
    if (
      !Number.isFinite(mult) ||
      mult < MIN_BONUS_CAMPAIGN_MULTIPLIER ||
      mult > MAX_BONUS_CAMPAIGN_MULTIPLIER
    ) {
      toast.error(
        `Multiplier must be between ${MIN_BONUS_CAMPAIGN_MULTIPLIER}x and ${MAX_BONUS_CAMPAIGN_MULTIPLIER}x`,
      );
      return;
    }
    const start = new Date(startsAt);
    const end = new Date(endsAt);
    if (
      !Number.isFinite(start.getTime()) ||
      !Number.isFinite(end.getTime()) ||
      end <= start
    ) {
      toast.error("Campaign end must be after its start");
      return;
    }
    if (
      end.getTime() - start.getTime() >
      MAX_BONUS_CAMPAIGN_DURATION_DAYS * 24 * 60 * 60 * 1000
    ) {
      toast.error(
        `Bonus campaigns can run for at most ${MAX_BONUS_CAMPAIGN_DURATION_DAYS} days`,
      );
      return;
    }

    try {
      setSubmitting(true);
      await LoyaltyAdminApi.createCampaign({
        name: name.trim(),
        multiplier: mult,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        eligibleTierIds: targetTier === "all" ? [] : [targetTier],
        eligibleSkus: parseIdentifierList(eligibleSkus),
        eligibleCollectionIds: parseIdentifierList(eligibleCollectionIds),
        isActive,
      });

      toast.success("Bonus multiplier campaign created successfully");
      onSuccess();
      onClose();
    } catch (err: any) {
      toast.error(err.message || "Failed to create bonus campaign");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal showModal={isOpen} setShowModal={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 pb-4">
          <h3 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            <Flame className="h-5 w-5 text-orange-500" />
            Create Bonus Campaign
          </h3>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
              Campaign Name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Double Points Weekend, Summer Boost"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Points Multiplier
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="0.1"
                  min={MIN_BONUS_CAMPAIGN_MULTIPLIER}
                  max={MAX_BONUS_CAMPAIGN_MULTIPLIER}
                  required
                  value={multiplier}
                  onChange={(e) => setMultiplier(e.target.value)}
                  className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
                />
                <span className="absolute right-3 top-2.5 text-xs font-medium text-gray-400">
                  x Points
                </span>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Target Audience
              </label>
              <select
                value={targetTier}
                onChange={(e) => setTargetTier(e.target.value)}
                className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-black"
              >
                <option value="all">All Members</option>
                {tiers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} Only
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Eligible SKUs
              </label>
              <textarea
                value={eligibleSkus}
                onChange={(event) => setEligibleSkus(event.target.value)}
                rows={3}
                placeholder={"SUMMER-TEE-S\nSUMMER-TEE-M"}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
              />
              <p className="mt-1 text-[10px] text-gray-500">
                Optional; comma or newline separated, up to 100.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Eligible Collection GIDs
              </label>
              <textarea
                value={eligibleCollectionIds}
                onChange={(event) =>
                  setEligibleCollectionIds(event.target.value)
                }
                rows={3}
                placeholder="gid://shopify/Collection/123456789"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
              />
              <p className="mt-1 text-[10px] text-gray-500">
                Optional canonical Shopify GIDs, up to 100.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                Start Date & Time
              </label>
              <input
                type="datetime-local"
                required
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-gray-700">
                End Date & Time
              </label>
              <input
                type="datetime-local"
                required
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
              />
            </div>
          </div>

          <div>
            <label className="flex cursor-pointer items-center gap-2 pt-1">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300 text-black focus:ring-black"
              />
              <span className="text-xs font-medium text-gray-700">
                Campaign is active immediately within scheduled dates
              </span>
            </label>
          </div>

          <p className="rounded-lg bg-orange-50 px-3 py-2 text-[11px] text-orange-800">
            Smile-compatible scheduling allows one non-overlapping campaign at a
            time, for up to {MAX_BONUS_CAMPAIGN_DURATION_DAYS} days, with a
            {` ${MIN_BONUS_CAMPAIGN_MULTIPLIER}x–${MAX_BONUS_CAMPAIGN_MULTIPLIER}x `}
            multiplier. SKU and collection targets use match-any semantics;
            lines outside the target keep their base earning. With no product
            targets, the campaign applies to every eligible paid-order line.
            Social, review, signup, and birthday actions are unchanged.
          </p>

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
              className="flex items-center gap-1.5 rounded-lg bg-black px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-gray-800 disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create Campaign"}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
