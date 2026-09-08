"use client";

import {
  ArrowLeft,
  Award,
  Calendar,
  Check,
  Copy,
  Crown,
  Gift,
  Instagram,
  Mail,
  Percent,
  Share2,
  ShoppingBag,
  Sparkles,
  Star,
  Tag,
  Truck,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  buildLoyaltyWidgetDisplayModel,
  formatLoyaltyInteger,
  formatLoyaltyMinorCurrency,
  formatLoyaltyPoints,
  isLoyaltyIntegerAtLeast,
  type LoyaltyInteger,
  unwrapLoyaltyPayload,
} from "./loyalty-widget-model";

export interface LoyaltyWidgetProps {
  shopDomain?: string;
  shopifyCustomerId?: string;
  apiBaseUrl?: string;
  currency?: string;
  themeColor?: string;
  // Milestone 3 Preview & Customizer Props
  previewMode?: boolean;
  isOpenDefault?: boolean;
  isInlinePreview?: boolean;
  branding?: {
    launcherText?: string;
    launcherPosition?: "bottom_right" | "bottom_left";
    launcherIcon?: string;
    primaryColor?: string;
    headerTextColor?: string;
    panelTitle?: string;
    panelWelcomeSubtitle?: string;
    enableFloatingLauncher?: boolean;
  };
  earningRules?: any[];
  rewards?: any[];
  tiers?: any[];
  referralRule?: any;
  shopper?: {
    firstName?: string;
    lastName?: string;
    email?: string;
  };
  pointsBalance?: LoyaltyInteger;
  pendingPoints?: LoyaltyInteger;
  currentTierName?: string;
  tierMultiplier?: number;
  pointNameSingular?: string;
  pointNamePlural?: string;
}

const DEFAULT_PANEL_SUBTITLE =
  "Earn points, level up, and unlock exclusive discounts.";

export function resolveLoyaltyPanelSubtitle(
  panelWelcomeSubtitle: string | null | undefined,
) {
  return panelWelcomeSubtitle ?? DEFAULT_PANEL_SUBTITLE;
}

function earningRuleLabel(
  rule: any,
  pointNameSingular: string,
  pointNamePlural: string,
) {
  if (typeof rule?.pointsRewardText === "string") {
    return rule.pointsRewardText;
  }
  if (rule?.triggerCode === "order_paid") {
    return `${rule.multiplier || 1}× ${pointNamePlural.toLowerCase()}`;
  }
  if (rule?.fixedPoints !== null && rule?.fixedPoints !== undefined) {
    return formatLoyaltyPoints(
      rule.fixedPoints,
      pointNameSingular,
      pointNamePlural,
    );
  }
  return "Reward details unavailable";
}

function tierPerks(tier: any): string[] {
  if (Array.isArray(tier?.perks)) {
    return tier.perks.filter((perk: unknown): perk is string =>
      Boolean(typeof perk === "string" && perk.trim()),
    );
  }
  if (typeof tier?.perks !== "string") return [];
  try {
    const parsed = JSON.parse(tier.perks);
    return Array.isArray(parsed)
      ? parsed.filter((perk): perk is string => typeof perk === "string")
      : [];
  } catch {
    return [];
  }
}

function activityTitle(activity: any) {
  if (typeof activity?.reason === "string" && activity.reason.trim()) {
    return activity.reason;
  }
  return String(activity?.entryType || "Points activity").replaceAll("_", " ");
}

function activityDate(value: unknown) {
  const date = new Date(String(value || ""));
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export function LoyaltyWidget({
  shopDomain = "store.myshopify.com",
  shopifyCustomerId = "",
  apiBaseUrl = "",
  currency = "USD",
  themeColor,
  previewMode = false,
  isOpenDefault,
  isInlinePreview = false,
  branding,
  earningRules = [],
  rewards = [],
  tiers = [],
  referralRule,
  shopper,
  pointsBalance,
  pendingPoints,
  currentTierName,
  tierMultiplier,
  pointNameSingular = "Point",
  pointNamePlural = "Points",
}: LoyaltyWidgetProps) {
  const [isOpen, setIsOpen] = useState(
    isOpenDefault !== undefined ? isOpenDefault : previewMode ? true : false,
  );
  const [activeTab, setActiveTab] = useState<
    "home" | "earn" | "rewards" | "vip" | "referral" | "history"
  >("home");
  const [loading, setLoading] = useState(
    !previewMode && Boolean(shopifyCustomerId),
  );
  const [data, setData] = useState<any>(null);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [lastRedemption, setLastRedemption] = useState<{
    code: string | null;
    rewardName: string;
  } | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [actionSuccessMsg, setActionSuccessMsg] = useState<string | null>(null);
  const redemptionIntentKeys = useRef(new Map<string, string>());

  // Sync isOpenDefault prop if provided
  useEffect(() => {
    if (isOpenDefault !== undefined) {
      setIsOpen(isOpenDefault);
    }
  }, [isOpenDefault]);

  const activeColor = branding?.primaryColor || themeColor || "#059669";
  const headerTextColor = branding?.headerTextColor || "#ffffff";
  const launcherText = branding?.launcherText || "Rewards";
  const launcherIcon = branding?.launcherIcon || "award";
  const panelTitle = branding?.panelTitle || "Rewards Club";
  const panelSubtitle = resolveLoyaltyPanelSubtitle(
    branding?.panelWelcomeSubtitle,
  );
  const launcherPosition = branding?.launcherPosition || "bottom_right";

  const fetchSummary = useCallback(async () => {
    if (!shopDomain || !shopifyCustomerId || previewMode) return;
    try {
      setLoading(true);
      const res = await fetch(
        `${apiBaseUrl}/apps/weletic/customer?shop=${encodeURIComponent(shopDomain)}`,
      );
      if (res.ok) {
        const json = await res.json();
        setData(unwrapLoyaltyPayload(json));
      }
    } catch (e) {
      console.error("Failed to fetch customer loyalty summary", e);
    } finally {
      setLoading(false);
    }
  }, [shopDomain, shopifyCustomerId, previewMode, apiBaseUrl]);

  useEffect(() => {
    if (shopDomain && shopifyCustomerId && !previewMode) {
      fetchSummary();
    }
  }, [shopDomain, shopifyCustomerId, previewMode, fetchSummary]);

  // Derive both preview and live content through one shopper-safe display model.
  const effectiveCurrency = data?.program?.currency || currency;
  const effectivePointNameSingular =
    data?.program?.pointNameSingular || pointNameSingular;
  const effectivePointNamePlural =
    data?.program?.pointNamePlural || pointNamePlural;
  const displayModel = buildLoyaltyWidgetDisplayModel({
    currency: effectiveCurrency,
    earningRules:
      earningRules.length > 0 ? earningRules : data?.waysToEarn || [],
    rewards: rewards.length > 0 ? rewards : data?.rewards || [],
    tiers: tiers.length > 0 ? tiers : data?.tier?.allTiers || [],
    referralRule: referralRule || data?.referral?.offer || null,
    pointNameSingular: effectivePointNameSingular,
    pointNamePlural: effectivePointNamePlural,
  });

  // Derived state combining live data and customizer preview overrides
  const memberName =
    shopper?.firstName ||
    data?.shopper?.firstName ||
    (previewMode ? "Alex" : "Member");

  const effectivePoints =
    pointsBalance !== undefined
      ? pointsBalance
      : data?.account?.pointsBalance ?? (previewMode ? "1250" : "0");

  const effectivePendingPoints =
    pendingPoints !== undefined
      ? pendingPoints
      : data?.account?.pendingPoints ?? (previewMode ? "150" : "0");

  const effectiveTierName =
    currentTierName ||
    data?.tier?.currentTier?.name ||
    (previewMode && tiers.length > 1 ? tiers[1].name : "Member");

  const effectiveMultiplier =
    tierMultiplier !== undefined
      ? tierMultiplier
      : data?.tier?.currentTier?.pointsMultiplier ?? (previewMode ? 1.25 : 1.0);

  const referralUrl =
    data?.referral?.referralShareUrl ||
    (previewMode && displayModel.referralOffer
      ? `https://${shopDomain}/?ref=customer-code`
      : "");
  const effectiveEarningRules = displayModel.earningRules;
  const effectiveRewards = displayModel.rewards;
  const effectiveTiers = displayModel.tiers;
  const referralOffer = displayModel.referralOffer;
  const friendRewardText = referralOffer?.friendRewardText || "";
  const advocateRewardText = referralOffer?.advocateRewardText || "";
  const recentActivity = Array.isArray(data?.recentActivity)
    ? data.recentActivity
    : [];
  const nextTierName = data?.tier?.nextTier?.name;
  const tierProgressPercent = Number(data?.tier?.progress?.percent);
  const showTierProgress =
    !previewMode &&
    Boolean(nextTierName) &&
    Number.isFinite(tierProgressPercent) &&
    tierProgressPercent >= 0;

  const handleRedeem = async (rewardId: string, rewardName: string) => {
    if (previewMode) {
      setLastRedemption({
        code: null,
        rewardName,
      });
      return;
    }

    let idempotencyKey = redemptionIntentKeys.current.get(rewardId);
    if (!idempotencyKey) {
      idempotencyKey = crypto.randomUUID();
      redemptionIntentKeys.current.set(rewardId, idempotencyKey);
    }

    try {
      setRedeemingId(rewardId);
      const res = await fetch(`${apiBaseUrl}/apps/weletic/customer/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          shop: shopDomain,
          rewardDefinitionId: rewardId,
          idempotencyKey,
        }),
      });

      if (res.ok) {
        const result = unwrapLoyaltyPayload<any>(await res.json());
        const artifactCode = Object.prototype.hasOwnProperty.call(
          result || {},
          "artifactCode",
        )
          ? result?.artifactCode
          : result?.discountCode;
        redemptionIntentKeys.current.delete(rewardId);
        setLastRedemption({
          code: typeof artifactCode === "string" ? artifactCode : null,
          rewardName,
        });
        await fetchSummary();
      } else {
        const err = await res.json().catch(() => ({}));
        alert(err.error?.message || "Failed to redeem reward.");
      }
    } catch {
      alert("Error redeeming reward. Please try again.");
    } finally {
      setRedeemingId(null);
    }
  };

  const copyToClipboard = (text: string, type: "link" | "code") => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(text);
    }
    if (type === "link") {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } else {
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    }
  };

  const triggerActionMock = (name: string) => {
    setActionSuccessMsg(`Preview only — no points credited for "${name}".`);
    setTimeout(() => setActionSuccessMsg(null), 3000);
  };

  // Render launcher icon helper
  const renderLauncherIcon = () => {
    switch (launcherIcon) {
      case "gift":
        return <Gift className="h-5 w-5 text-amber-300" />;
      case "crown":
        return <Crown className="h-5 w-5 text-amber-300" />;
      case "star":
        return <Star className="h-5 w-5 text-amber-300" />;
      case "sparkles":
        return <Sparkles className="h-5 w-5 text-amber-300" />;
      case "award":
      default:
        return <Award className="h-5 w-5 text-amber-300" />;
    }
  };

  const containerClasses = isInlinePreview
    ? "relative w-full h-full flex flex-col items-center justify-end font-sans select-none"
    : `fixed bottom-6 ${launcherPosition === "bottom_left" ? "left-6" : "right-6"} z-50 font-sans`;

  return (
    <React.Fragment>
      <div className={containerClasses}>
        {/* ========================================================================= */}
        {/* FLOATING LAUNCHER BUTTON                                                  */}
        {/* ========================================================================= */}
        {!isOpen && (
          <button
            onClick={() => setIsOpen(true)}
            className="flex cursor-pointer items-center gap-2.5 rounded-full px-5 py-3.5 shadow-2xl transition-all duration-200 hover:scale-105 active:scale-95"
            style={{ backgroundColor: activeColor, color: headerTextColor }}
          >
            {renderLauncherIcon()}
            <span className="text-sm font-bold tracking-wide">
              {loading
                ? "Loyalty"
                : `${launcherText} • ${formatLoyaltyInteger(effectivePoints)} pts`}
            </span>
          </button>
        )}

        {/* ========================================================================= */}
        {/* MAIN DRAWER / MODAL PANEL                                                 */}
        {/* ========================================================================= */}
        {isOpen && (
          <div className="flex h-[620px] w-[370px] max-w-full flex-col overflow-hidden rounded-3xl bg-white shadow-2xl ring-1 ring-black/10 transition-all duration-300 sm:w-[410px]">
            {/* HEADER BANNER */}
            <div
              className="relative shrink-0 px-6 pb-4 pt-5 text-white"
              style={{ backgroundColor: activeColor, color: headerTextColor }}
            >
              {/* Top Bar: Back Button & Close Button */}
              <div className="flex items-center justify-between pb-3">
                {activeTab !== "home" ? (
                  <button
                    onClick={() => setActiveTab("home")}
                    className="flex cursor-pointer items-center gap-1 text-xs font-semibold text-white/90 transition hover:text-white"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    <span>Back</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider opacity-85">
                    <Sparkles className="h-3.5 w-3.5 text-amber-300" />
                    <span>{panelTitle}</span>
                  </div>
                )}

                {!isInlinePreview && (
                  <button
                    onClick={() => setIsOpen(false)}
                    className="cursor-pointer rounded-full p-1 text-white/80 transition hover:bg-white/10 hover:text-white"
                  >
                    <X className="h-5 w-5" />
                  </button>
                )}
              </div>

              {/* Greeting & Tier */}
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white/20 text-amber-300 shadow-inner ring-2 ring-white/25">
                  <Crown className="h-6 w-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-base font-black leading-tight">
                    Hi, {memberName}
                  </h3>
                  <div className="mt-0.5 flex items-center gap-1.5 text-xs opacity-90">
                    <span className="inline-flex items-center rounded-full bg-white/20 px-2 py-0.5 font-bold text-amber-200">
                      {effectiveTierName}
                    </span>
                    <span>• {effectiveMultiplier}x points</span>
                  </div>
                </div>
              </div>

              {/* Points Balance Card */}
              <div className="mt-3.5 rounded-2xl bg-white/15 p-3.5 ring-1 ring-white/20 backdrop-blur-md">
                <div className="flex items-end justify-between">
                  <div>
                    <div className="text-2xs font-bold uppercase tracking-wider opacity-75">
                      Your Points Balance
                    </div>
                    <div className="text-3xl font-black tracking-tight">
                      {formatLoyaltyInteger(effectivePoints)}
                    </div>
                  </div>
                  {isLoyaltyIntegerAtLeast(effectivePendingPoints, "1") && (
                    <div className="text-right text-xs font-medium opacity-80">
                      <span>
                        +{formatLoyaltyInteger(effectivePendingPoints)} pending
                      </span>
                    </div>
                  )}
                </div>

                {showTierProgress && (
                  <div className="mt-2.5 border-t border-white/15 pt-2">
                    <div className="flex justify-between text-[11px] font-medium opacity-85">
                      <span>Next: {nextTierName}</span>
                      <span>{Math.min(100, tierProgressPercent)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-white/25">
                      <div
                        className="h-full rounded-full bg-amber-300 transition-all duration-500"
                        style={{
                          width: `${Math.min(100, tierProgressPercent)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* BOTTOM / SUB-HEADER TAB NAVIGATION */}
            <div className="flex shrink-0 border-b border-neutral-100 bg-neutral-50/80 px-2 py-1.5 text-xs font-bold text-neutral-600">
              <button
                onClick={() => setActiveTab("home")}
                className={`flex-1 rounded-lg py-1.5 text-center transition ${
                  activeTab === "home"
                    ? "shadow-2xs bg-white text-neutral-900"
                    : "text-neutral-500 hover:text-neutral-900"
                }`}
              >
                Home
              </button>
              <button
                onClick={() => setActiveTab("earn")}
                className={`flex-1 rounded-lg py-1.5 text-center transition ${
                  activeTab === "earn"
                    ? "shadow-2xs bg-white text-neutral-900"
                    : "text-neutral-500 hover:text-neutral-900"
                }`}
              >
                Ways to Earn
              </button>
              <button
                onClick={() => setActiveTab("rewards")}
                className={`flex-1 rounded-lg py-1.5 text-center transition ${
                  activeTab === "rewards"
                    ? "shadow-2xs bg-white text-neutral-900"
                    : "text-neutral-500 hover:text-neutral-900"
                }`}
              >
                Redeem
              </button>
              <button
                onClick={() => setActiveTab("vip")}
                className={`flex-1 rounded-lg py-1.5 text-center transition ${
                  activeTab === "vip"
                    ? "shadow-2xs bg-white text-neutral-900"
                    : "text-neutral-500 hover:text-neutral-900"
                }`}
              >
                VIP Tiers
              </button>
              {referralOffer && (
                <button
                  onClick={() => setActiveTab("referral")}
                  className={`flex-1 rounded-lg py-1.5 text-center transition ${
                    activeTab === "referral"
                      ? "shadow-2xs bg-white text-neutral-900"
                      : "text-neutral-500 hover:text-neutral-900"
                  }`}
                >
                  Referrals
                </button>
              )}
            </div>

            {/* TAB BODY SCROLL CONTAINER */}
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              {/* Action Success Toast Banner */}
              {actionSuccessMsg && (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 text-xs font-semibold text-emerald-800">
                  <Check className="size-4 shrink-0 text-emerald-600" />
                  <span>{actionSuccessMsg}</span>
                </div>
              )}

              {/* Unlocked Reward Modal Banner */}
              {lastRedemption && (
                <div className="shadow-xs rounded-2xl border border-emerald-200 bg-emerald-50/90 p-4 text-emerald-950">
                  <div className="flex items-center justify-between">
                    <div className="text-xs font-bold uppercase tracking-wider text-emerald-700">
                      {previewMode ? "Reward preview" : "🎉 Reward Unlocked!"}
                    </div>
                    <button
                      onClick={() => setLastRedemption(null)}
                      className="text-emerald-600 hover:text-emerald-900"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                  <div className="mt-1 text-xs text-emerald-800">
                    {previewMode
                      ? `No reward was issued for ${lastRedemption.rewardName}.`
                      : lastRedemption.code
                        ? "Your issued reward code:"
                        : `${lastRedemption.rewardName} was added to your account.`}
                  </div>
                  {lastRedemption.code && (
                    <div className="mt-2.5 flex items-center justify-between rounded-xl border border-emerald-300 bg-white px-3.5 py-2 font-mono text-sm font-black">
                      <span>{lastRedemption.code}</span>
                      <button
                        onClick={() =>
                          copyToClipboard(lastRedemption.code!, "code")
                        }
                        className="flex items-center gap-1 rounded-md bg-emerald-100 px-2 py-1 text-xs font-bold text-emerald-800 hover:bg-emerald-200"
                      >
                        {copiedCode ? (
                          <Check className="size-3.5" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                        <span>{copiedCode ? "Copied" : "Copy"}</span>
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* =================================================================== */}
              {/* TAB 1: HOME OVERVIEW                                                */}
              {/* =================================================================== */}
              {activeTab === "home" && (
                <div className="space-y-4">
                  {/* Welcome message */}
                  <p
                    className="text-xs text-neutral-600"
                    data-loyalty-panel-subtitle
                  >
                    {panelSubtitle}
                  </p>

                  {/* Quick Navigation Cards */}
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      onClick={() => setActiveTab("earn")}
                      className="flex flex-col items-start rounded-2xl border border-neutral-200 bg-neutral-50/60 p-3.5 text-left transition hover:border-neutral-300 hover:bg-neutral-100/60"
                    >
                      <div className="flex size-8 items-center justify-center rounded-xl bg-amber-100 text-amber-700">
                        <Gift className="size-4" />
                      </div>
                      <span className="mt-2 text-xs font-bold text-neutral-900">
                        Ways to Earn
                      </span>
                      <span className="text-2xs text-neutral-500">
                        {effectiveEarningRules.length} actions
                      </span>
                    </button>

                    <button
                      onClick={() => setActiveTab("rewards")}
                      className="flex flex-col items-start rounded-2xl border border-neutral-200 bg-neutral-50/60 p-3.5 text-left transition hover:border-neutral-300 hover:bg-neutral-100/60"
                    >
                      <div className="flex size-8 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700">
                        <Tag className="size-4" />
                      </div>
                      <span className="mt-2 text-xs font-bold text-neutral-900">
                        Ways to Redeem
                      </span>
                      <span className="text-2xs text-neutral-500">
                        {effectiveRewards.length} rewards
                      </span>
                    </button>

                    <button
                      onClick={() => setActiveTab("vip")}
                      className="flex flex-col items-start rounded-2xl border border-neutral-200 bg-neutral-50/60 p-3.5 text-left transition hover:border-neutral-300 hover:bg-neutral-100/60"
                    >
                      <div className="flex size-8 items-center justify-center rounded-xl bg-purple-100 text-purple-700">
                        <Crown className="size-4" />
                      </div>
                      <span className="mt-2 text-xs font-bold text-neutral-900">
                        VIP Tiers
                      </span>
                      <span className="text-2xs text-neutral-500">
                        {effectiveTiers.length} tiers
                      </span>
                    </button>

                    {referralOffer && (
                      <button
                        onClick={() => setActiveTab("referral")}
                        className="flex flex-col items-start rounded-2xl border border-neutral-200 bg-neutral-50/60 p-3.5 text-left transition hover:border-neutral-300 hover:bg-neutral-100/60"
                      >
                        <div className="flex size-8 items-center justify-center rounded-xl bg-blue-100 text-blue-700">
                          <Users className="size-4" />
                        </div>
                        <span className="mt-2 text-xs font-bold text-neutral-900">
                          Refer a Friend
                        </span>
                        <span className="text-2xs text-neutral-500">
                          Give {friendRewardText}, get {advocateRewardText}
                        </span>
                      </button>
                    )}
                  </div>

                  {referralOffer && (
                    <div className="rounded-2xl border border-blue-200/80 bg-gradient-to-br from-blue-50/70 to-indigo-50/70 p-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="text-xs font-bold text-blue-900">
                            Refer Friends & Earn
                          </div>
                          <div className="text-2xs mt-0.5 text-blue-700">
                            Give your friends {friendRewardText} and earn{" "}
                            {advocateRewardText}.
                          </div>
                        </div>
                        <button
                          onClick={() => setActiveTab("referral")}
                          className="text-2xs rounded-lg bg-blue-600 px-3 py-1.5 font-bold text-white hover:bg-blue-700"
                        >
                          Share Link
                        </button>
                      </div>
                    </div>
                  )}

                  {recentActivity.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                          Recent Activity
                        </span>
                        <button
                          onClick={() => setActiveTab("history")}
                          className="text-2xs font-semibold text-neutral-600 hover:text-neutral-900"
                        >
                          View All
                        </button>
                      </div>
                      <div className="mt-2 space-y-2">
                        {recentActivity.slice(0, 2).map((activity: any) => (
                          <div
                            key={activity.id}
                            className="shadow-2xs flex items-center justify-between rounded-xl border border-neutral-100 bg-white p-3 text-xs"
                          >
                            <div>
                              <div className="font-bold text-neutral-900">
                                {activityTitle(activity)}
                              </div>
                              <div className="text-2xs text-neutral-400">
                                {activityDate(activity.createdAt)}
                              </div>
                            </div>
                            <span className="font-bold text-emerald-600">
                              {isLoyaltyIntegerAtLeast(
                                activity.pointsDelta,
                                "1",
                              )
                                ? "+"
                                : ""}
                              {formatLoyaltyInteger(activity.pointsDelta)} pts
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* =================================================================== */}
              {/* TAB 2: WAYS TO EARN                                                 */}
              {/* =================================================================== */}
              {activeTab === "earn" && (
                <div className="space-y-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                    Earn Points
                  </div>
                  {effectiveEarningRules.map((rule: any) => (
                    <div
                      key={rule.id}
                      className="shadow-2xs flex items-center justify-between rounded-2xl border border-neutral-200/90 bg-white p-3.5 transition hover:border-neutral-300"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex size-9 items-center justify-center rounded-xl bg-amber-50 font-bold text-amber-600">
                          {rule.icon === "instagram" ? (
                            <Instagram className="size-4 text-pink-600" />
                          ) : rule.icon === "birthday" ? (
                            <Calendar className="size-4 text-amber-600" />
                          ) : rule.icon === "signup" ? (
                            <UserPlus className="size-4 text-blue-600" />
                          ) : (
                            <ShoppingBag className="size-4 text-neutral-800" />
                          )}
                        </div>
                        <div>
                          <div className="text-xs font-bold text-neutral-900">
                            {rule.name}
                          </div>
                          <div className="text-2xs text-neutral-500">
                            {earningRuleLabel(
                              rule,
                              effectivePointNameSingular,
                              effectivePointNamePlural,
                            )}
                          </div>
                        </div>
                      </div>
                      <button
                        onClick={() => triggerActionMock(rule.name)}
                        className="text-2xs rounded-lg bg-neutral-900 px-3 py-1.5 font-bold text-white hover:bg-neutral-800"
                      >
                        Complete
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* =================================================================== */}
              {/* TAB 3: WAYS TO REDEEM                                               */}
              {/* =================================================================== */}
              {activeTab === "rewards" && (
                <div className="space-y-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                    Available Rewards
                  </div>
                  {effectiveRewards.map((reward: any) => {
                    const minimumPointsCost =
                      reward.exchangeType === "incremental"
                        ? reward.minPointsCost || reward.pointsCost
                        : reward.pointsCost;
                    const canRedeem =
                      reward.canRedeem !== undefined
                        ? reward.canRedeem
                        : isLoyaltyIntegerAtLeast(
                            effectivePoints,
                            minimumPointsCost,
                          );

                    return (
                      <div
                        key={reward.id}
                        className="shadow-2xs flex items-center justify-between rounded-2xl border border-neutral-200/90 bg-white p-3.5 transition hover:border-neutral-300"
                      >
                        <div className="flex items-center gap-3">
                          <div className="flex size-9 items-center justify-center rounded-xl bg-emerald-50 font-bold text-emerald-600">
                            {reward.rewardType === "free_shipping" ? (
                              <Truck className="size-4 text-purple-600" />
                            ) : reward.rewardType === "percentage_off" ? (
                              <Percent className="size-4 text-blue-600" />
                            ) : reward.rewardType === "free_product" ? (
                              <Gift className="size-4 text-amber-600" />
                            ) : (
                              <Tag className="size-4 text-emerald-600" />
                            )}
                          </div>
                          <div>
                            <div className="text-xs font-bold text-neutral-900">
                              {reward.name}
                            </div>
                            <div className="text-2xs text-neutral-500">
                              {reward.exchangeType === "incremental"
                                ? "From "
                                : ""}
                              {formatLoyaltyPoints(
                                minimumPointsCost,
                                effectivePointNameSingular,
                                effectivePointNamePlural,
                              )}
                              {isLoyaltyIntegerAtLeast(
                                reward.minOrderAmount,
                                "1",
                              )
                                ? ` • Min ${formatLoyaltyMinorCurrency(
                                    reward.minOrderAmount,
                                    displayModel.currency,
                                  )}`
                                : ""}
                            </div>
                          </div>
                        </div>
                        <button
                          onClick={() => handleRedeem(reward.id, reward.name)}
                          disabled={!canRedeem || redeemingId === reward.id}
                          className={`text-2xs rounded-lg px-3.5 py-1.5 font-bold transition ${
                            canRedeem
                              ? "bg-neutral-900 text-white hover:bg-neutral-800"
                              : "cursor-not-allowed bg-neutral-100 text-neutral-400"
                          }`}
                        >
                          {redeemingId === reward.id
                            ? "..."
                            : canRedeem
                              ? "Redeem"
                              : "Locked"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* =================================================================== */}
              {/* TAB 4: VIP TIERS ROADMAP                                            */}
              {/* =================================================================== */}
              {activeTab === "vip" && (
                <div className="space-y-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                    VIP Program Progression
                  </div>
                  {effectiveTiers.map((tier: any, idx: number) => {
                    const isCurrentTier =
                      tier.name?.toLowerCase() ===
                      effectiveTierName?.toLowerCase();

                    const perksList = tierPerks(tier);

                    return (
                      <div
                        key={tier.id || idx}
                        className={`rounded-2xl border p-4 transition ${
                          isCurrentTier
                            ? "shadow-xs border-amber-400 bg-amber-50/50 ring-1 ring-amber-300"
                            : "border-neutral-200 bg-white"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Crown
                              className={`size-4 ${
                                isCurrentTier
                                  ? "text-amber-600"
                                  : "text-neutral-400"
                              }`}
                            />
                            <span className="text-xs font-bold text-neutral-900">
                              {tier.name}
                            </span>
                          </div>
                          {isCurrentTier && (
                            <span className="text-2xs rounded-full bg-amber-200 px-2 py-0.5 font-black text-amber-900">
                              Current Tier
                            </span>
                          )}
                        </div>

                        <div className="text-2xs mt-2 flex items-center gap-3 text-neutral-600">
                          <span>
                            Spend:{" "}
                            <strong>
                              {formatLoyaltyMinorCurrency(
                                tier.minSpendThreshold || 0,
                                displayModel.currency,
                              )}
                            </strong>
                          </span>
                          <span>•</span>
                          <span>
                            Multiplier:{" "}
                            <strong>
                              {Number(tier.pointsMultiplier || 1.0)}x
                            </strong>
                          </span>
                        </div>

                        <div className="mt-2.5 space-y-1 border-t border-neutral-100 pt-2">
                          {perksList.map((perk: string, pIdx: number) => (
                            <div
                              key={pIdx}
                              className="text-2xs flex items-center gap-1.5 text-neutral-700"
                            >
                              <Check className="size-3 shrink-0 text-emerald-500" />
                              <span>{perk}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* =================================================================== */}
              {/* TAB 5: REFERRALS                                                    */}
              {/* =================================================================== */}
              {activeTab === "referral" && referralOffer && (
                <div className="space-y-4">
                  <div className="rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50/60 to-indigo-50/60 p-4 text-center">
                    <h4 className="text-sm font-black text-neutral-900">
                      Give {friendRewardText}, Get {advocateRewardText}
                    </h4>
                    <p className="text-2xs mt-1 text-neutral-600">
                      Your friend receives {friendRewardText}, and you receive{" "}
                      {advocateRewardText} when their first eligible order
                      qualifies.
                    </p>

                    <div className="mt-3 flex items-center justify-between rounded-xl border border-neutral-300 bg-white px-3 py-2 font-mono text-xs">
                      <span className="truncate pr-2 text-neutral-700">
                        {referralUrl}
                      </span>
                      <button
                        onClick={() => copyToClipboard(referralUrl, "link")}
                        className="text-2xs flex shrink-0 items-center gap-1 rounded-lg bg-neutral-900 px-2.5 py-1 font-bold text-white hover:bg-neutral-800"
                      >
                        {copiedLink ? (
                          <Check className="size-3" />
                        ) : (
                          <Copy className="size-3" />
                        )}
                        <span>{copiedLink ? "Copied" : "Copy"}</span>
                      </button>
                    </div>

                    {/* Social Share Buttons */}
                    <div className="mt-3 flex items-center justify-center gap-2">
                      <button
                        onClick={() => {
                          window.open(
                            `https://twitter.com/intent/tweet?text=${encodeURIComponent(`Get ${friendRewardText} with my referral link!`)}&url=${encodeURIComponent(referralUrl)}`,
                            "_blank",
                          );
                        }}
                        className="text-2xs flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-3 py-1 font-bold text-neutral-700 hover:bg-neutral-50"
                      >
                        <Share2 className="size-3" /> Tweet
                      </button>
                      <button
                        onClick={() => {
                          window.open(
                            `mailto:?subject=${encodeURIComponent("Claim your loyalty discount")}&body=${encodeURIComponent(`Check this out: ${referralUrl}`)}`,
                          );
                        }}
                        className="text-2xs flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-3 py-1 font-bold text-neutral-700 hover:bg-neutral-50"
                      >
                        <Mail className="size-3" /> Email
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-center">
                    <div className="rounded-2xl border border-neutral-200 bg-white p-3.5">
                      <div className="text-xl font-black text-neutral-900">
                        {previewMode
                          ? "—"
                          : formatLoyaltyInteger(
                              data?.referral?.totalReferrals || 0,
                            )}
                      </div>
                      <div className="text-2xs mt-0.5 font-bold uppercase tracking-wider text-neutral-500">
                        Friends Invited
                      </div>
                    </div>
                    <div className="rounded-2xl border border-neutral-200 bg-white p-3.5">
                      <div className="text-xl font-black text-emerald-600">
                        {previewMode
                          ? "—"
                          : formatLoyaltyInteger(
                              referralOffer.advocateRewardKind === "points"
                                ? data?.referral?.totalPointsEarned || 0
                                : data?.referral?.qualifiedReferrals || 0,
                            )}
                      </div>
                      <div className="text-2xs mt-0.5 font-bold uppercase tracking-wider text-neutral-500">
                        {referralOffer.advocateRewardKind === "points"
                          ? `${effectivePointNamePlural} Earned`
                          : "Qualified Referrals"}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* =================================================================== */}
              {/* TAB 6: ACTIVITY HISTORY                                             */}
              {/* =================================================================== */}
              {activeTab === "history" && (
                <div className="space-y-2.5">
                  <div className="text-xs font-bold uppercase tracking-wider text-neutral-400">
                    Points History
                  </div>
                  <div className="space-y-2">
                    {recentActivity.length > 0 ? (
                      recentActivity.map((activity: any) => (
                        <div
                          key={activity.id}
                          className="shadow-2xs flex items-center justify-between rounded-xl border border-neutral-100 bg-white p-3 text-xs"
                        >
                          <div>
                            <div className="font-bold text-neutral-900">
                              {activityTitle(activity)}
                            </div>
                            <div className="text-2xs text-neutral-400">
                              {activityDate(activity.createdAt)}
                            </div>
                          </div>
                          <span className="font-bold text-neutral-900">
                            {isLoyaltyIntegerAtLeast(activity.pointsDelta, "1")
                              ? "+"
                              : ""}
                            {formatLoyaltyInteger(activity.pointsDelta)}
                          </span>
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-neutral-500">
                        No points activity yet.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </React.Fragment>
  );
}
