"use client";

import { ReferralConfigurationAdmin } from "@/ui/weletic/loyalty/referral-configuration-admin";
import {
  CheckCircle2,
  Link,
  ShoppingBag,
  Sparkles,
  Users,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi } from "../api-client";
import { formatPoints } from "../currency-helpers";

export interface TabReferralsProps {
  workspaceId: string;
  referralData: any;
  onRefresh: () => void;
}

export function TabReferrals({
  workspaceId,
  referralData,
  onRefresh,
}: TabReferralsProps) {
  const metrics = referralData?.metrics || {};
  const [reviewingReferralId, setReviewingReferralId] = useState<string | null>(
    null,
  );

  const handleReferralReview = async (
    referralId: string,
    action: "cancel" | "unblock",
  ) => {
    if (
      action === "cancel" &&
      !window.confirm(
        "Cancel this referral and revoke any unused rewards? This action cannot be undone.",
      )
    ) {
      return;
    }
    try {
      setReviewingReferralId(referralId);
      await LoyaltyAdminApi.reviewReferral({
        referralId,
        action,
        ...(action === "cancel"
          ? { reason: "Rejected during merchant fraud review" }
          : { note: "Approved during merchant fraud review" }),
      });
      toast.success(
        action === "unblock"
          ? "Referral approved. The friend can resubmit the same email to receive the voucher."
          : "Referral cancelled",
      );
      onRefresh();
    } catch (err: any) {
      toast.error(err.message || "Failed to review referral");
    } finally {
      setReviewingReferralId(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* 4-Metric Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-gray-500">
            <span>Referral Links Created</span>
            <div className="rounded-lg bg-blue-50 p-1.5 text-blue-600">
              <Link className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {formatPoints(metrics.linksGenerated || metrics.totalLinks || 0)}
          </div>
          <p className="mt-1 text-[11px] text-gray-400">
            Dub shortlinks assigned to shoppers
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-gray-500">
            <span>Friend Claims</span>
            <div className="rounded-lg bg-indigo-50 p-1.5 text-indigo-600">
              <Users className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {formatPoints(metrics.refereesBound || metrics.totalReferees || 0)}
          </div>
          <p className="mt-1 text-[11px] text-gray-400">
            Account-bound and anonymous email claims
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-gray-500">
            <span>Qualified First Orders</span>
            <div className="rounded-lg bg-emerald-50 p-1.5 text-emerald-600">
              <ShoppingBag className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {formatPoints(metrics.qualifiedOrders || 0)}
          </div>
          <p className="mt-1 text-[11px] text-gray-400">
            Orders meeting min spend criteria
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between text-xs font-medium text-gray-500">
            <span>Referral Points Rewarded</span>
            <div className="rounded-lg bg-purple-50 p-1.5 text-purple-600">
              <Sparkles className="h-4 w-4" />
            </div>
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {formatPoints(metrics.pointsRewarded || 0)}
          </div>
          <p className="mt-1 text-[11px] text-gray-400">
            Total points paid across both sides
          </p>
        </div>
      </div>

      <ReferralConfigurationAdmin
        workspaceId={workspaceId}
        onSaved={onRefresh}
      />

      {(referralData?.activity || []).length > 0 ? (
        <div className="overflow-hidden rounded-2xl border border-gray-200/80 bg-white shadow-sm">
          <div className="border-b border-gray-100 px-5 py-4">
            <h3 className="text-sm font-semibold text-gray-900">
              Recent referral activity
            </h3>
          </div>
          <div className="divide-y divide-gray-100">
            {referralData.activity.map((activity: any) => (
              <div
                key={activity.id}
                className="grid gap-2 px-5 py-3 text-xs sm:grid-cols-5 sm:items-center"
              >
                <span className="font-medium text-gray-900">
                  {activity.advocateName} → {activity.refereeName}
                </span>
                <span>
                  <span className="capitalize text-gray-600">
                    {activity.status.replaceAll("_", " ")}
                  </span>
                  {activity.fraudReason ? (
                    <span className="mt-1 block text-[11px] text-amber-700">
                      {activity.fraudReason}
                    </span>
                  ) : null}
                </span>
                <span className="text-gray-500">
                  {activity.qualifyingOrderId || "Awaiting first order"}
                </span>
                <span className="text-gray-500">
                  {new Date(activity.createdAt).toLocaleDateString()}
                </span>
                <span className="flex justify-end gap-2">
                  {activity.status === "fraud_blocked" ? (
                    <button
                      type="button"
                      disabled={reviewingReferralId === activity.id}
                      onClick={() =>
                        handleReferralReview(activity.id, "unblock")
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-emerald-200 px-2 py-1 font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Approve
                    </button>
                  ) : null}
                  {!["cancelled"].includes(activity.status) ? (
                    <button
                      type="button"
                      disabled={reviewingReferralId === activity.id}
                      onClick={() =>
                        handleReferralReview(activity.id, "cancel")
                      }
                      className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      Cancel
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
