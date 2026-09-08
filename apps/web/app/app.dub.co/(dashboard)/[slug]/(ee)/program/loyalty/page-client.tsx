"use client";

import useWorkspace from "@/lib/swr/use-workspace";
import {
  AlertOctagon,
  BarChart3,
  Coins,
  Crown,
  Flame,
  Gift,
  History,
  Layout,
  RefreshCw,
  Settings,
  Share2,
  Sparkles,
  Users,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi, type LoyaltyBranding } from "./api-client";
import { TabActivity } from "./modules/tab-activity";
import { TabAnalytics } from "./modules/tab-analytics";
import { TabBonuses } from "./modules/tab-bonuses";
import { TabCustomers } from "./modules/tab-customers";
import { TabEarn } from "./modules/tab-earn";
import { TabOnsite } from "./modules/tab-onsite";
import { TabPoints } from "./modules/tab-points";
import { TabReferrals } from "./modules/tab-referrals";
import { TabRewards } from "./modules/tab-rewards";
import { TabSettings } from "./modules/tab-settings";
import { TabVip } from "./modules/tab-vip";

export type LoyaltyTabKey =
  | "points"
  | "earn"
  | "rewards"
  | "customers"
  | "activity"
  | "referrals"
  | "vip"
  | "bonuses"
  | "analytics"
  | "onsite"
  | "settings";

export default function LoyaltyAdminPageClient({
  initialTab = "points",
}: {
  initialTab?: string;
} = {}) {
  const workspace = useWorkspace();
  const { id: workspaceId, slug } = workspace;
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const isOwner = workspace.isOwner || workspace.role === "owner";

  // Resolve initial tab from path, query param, or prop
  const tabFromUrl = searchParams.get("tab");
  const tabFromPath =
    pathname.endsWith("/referrals") || pathname.endsWith("/referral")
      ? "referrals"
      : pathname.endsWith("/vip") || pathname.endsWith("/tiers")
        ? "vip"
        : pathname.endsWith("/activity")
          ? "activity"
          : pathname.endsWith("/bonuses") || pathname.endsWith("/campaigns")
            ? "bonuses"
            : pathname.endsWith("/customers") ||
                pathname.endsWith("/members") ||
                pathname.endsWith("/accounts")
              ? "customers"
              : pathname.endsWith("/analytics")
                ? "analytics"
                : pathname.endsWith("/onsite") ||
                    pathname.endsWith("/branding") ||
                    pathname.endsWith("/widget")
                  ? "onsite"
                  : pathname.endsWith("/settings")
                    ? "settings"
                    : pathname.endsWith("/earn") ||
                        pathname.endsWith("/earning")
                      ? "earn"
                      : pathname.endsWith("/rewards") ||
                          pathname.endsWith("/redeem")
                        ? "rewards"
                        : pathname.endsWith("/points") ||
                            pathname.endsWith("/overview")
                          ? "points"
                          : null;

  const normalizeTab = (raw: string | null): LoyaltyTabKey => {
    if (!raw) return "points";
    const mapped: Record<string, LoyaltyTabKey> = {
      overview: "points",
      points: "points",
      earn: "earn",
      earning: "earn",
      redeem: "rewards",
      rewards: "rewards",
      customers: "customers",
      members: "customers",
      accounts: "customers",
      activity: "activity",
      referrals: "referrals",
      referral: "referrals",
      vip: "vip",
      tiers: "vip",
      bonuses: "bonuses",
      campaigns: "bonuses",
      analytics: "analytics",
      onsite: "onsite",
      branding: "onsite",
      widget: "onsite",
      settings: "settings",
      backfill: "settings",
    };
    return mapped[raw.toLowerCase()] || "points";
  };

  const [activeTab, setActiveTab] = useState<LoyaltyTabKey>(
    normalizeTab(tabFromPath || tabFromUrl || initialTab),
  );

  // Program and shared states
  const [settings, setSettings] = useState<any | null>(null);
  const [earnRules, setEarnRules] = useState<any[]>([]);
  const [rewards, setRewards] = useState<any[]>([]);
  const [tiers, setTiers] = useState<any[]>([]);
  const [referralData, setReferralData] = useState<any | null>(null);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [analytics, setAnalytics] = useState<any | null>(null);
  const [branding, setBranding] = useState<LoyaltyBranding | null>(null);
  const [brandingLoaded, setBrandingLoaded] = useState(false);
  const [brandingLoadError, setBrandingLoadError] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const fetchProgramData = useCallback(async () => {
    try {
      setLoading(true);
      setBrandingLoaded(false);
      setBrandingLoadError(null);

      const [
        settingsRes,
        earnRes,
        rewardsRes,
        tiersRes,
        referralsRes,
        campaignsRes,
        analyticsRes,
        brandingRes,
      ] = await Promise.allSettled([
        LoyaltyAdminApi.getSettings(),
        LoyaltyAdminApi.getEarnRules(),
        LoyaltyAdminApi.getRewards(),
        LoyaltyAdminApi.getTiers(),
        LoyaltyAdminApi.getReferrals(),
        LoyaltyAdminApi.getCampaigns(),
        LoyaltyAdminApi.getAnalytics(),
        LoyaltyAdminApi.getBranding(),
      ]);

      if (settingsRes.status === "fulfilled") setSettings(settingsRes.value);
      if (earnRes.status === "fulfilled")
        setEarnRules(earnRes.value.rules || []);
      if (rewardsRes.status === "fulfilled") setRewards(rewardsRes.value || []);
      if (tiersRes.status === "fulfilled") setTiers(tiersRes.value || []);
      if (referralsRes.status === "fulfilled")
        setReferralData(referralsRes.value);
      if (campaignsRes.status === "fulfilled")
        setCampaigns(campaignsRes.value.campaigns || []);
      if (analyticsRes.status === "fulfilled") setAnalytics(analyticsRes.value);
      if (brandingRes.status === "fulfilled") {
        setBranding(brandingRes.value.branding);
        setBrandingLoaded(true);
      } else {
        const errorMessage =
          brandingRes.reason instanceof Error
            ? brandingRes.reason.message
            : typeof brandingRes.reason === "string"
              ? brandingRes.reason
              : "The branding request failed.";
        setBrandingLoadError(
          `Saved on-site branding could not be loaded. ${errorMessage}`,
        );
      }

      const failedLoads = (
        [
          ["program settings", settingsRes],
          ["earning rules", earnRes],
          ["rewards", rewardsRes],
          ["VIP tiers", tiersRes],
          ["referrals", referralsRes],
          ["bonus campaigns", campaignsRes],
          ["analytics", analyticsRes],
          ["on-site branding", brandingRes],
        ] as const
      ).flatMap(([resource, result]) => {
        if (result.status === "fulfilled") return [];
        console.error(`Failed to load loyalty ${resource}`, result.reason);
        return [resource];
      });

      if (failedLoads.length > 0) {
        toast.error(
          `Failed to load ${failedLoads.join(", ")}. Please try again.`,
        );
      }
    } catch (err: unknown) {
      console.error("Failed to load program data", err);
      const errorMessage =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : "The program data request failed.";
      setBrandingLoadError(
        `Saved on-site branding could not be loaded. ${errorMessage}`,
      );
      toast.error(errorMessage);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProgramData();
  }, [fetchProgramData]);

  const handleTabChange = (tab: LoyaltyTabKey) => {
    setActiveTab(tab);
    if (slug) {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", tab);
      window.history.pushState({}, "", url.toString());
    }
  };

  const currency = settings?.store?.shopCurrency || "USD";
  const shopDomain = settings?.store?.shopDomain || "store.myshopify.com";
  const killSwitchActive = settings?.killSwitchActive ?? false;

  const tabs: {
    id: LoyaltyTabKey;
    label: string;
    icon: any;
    count?: number;
  }[] = [
    { id: "points", label: "Points Overview", icon: Coins },
    {
      id: "earn",
      label: "Ways to Earn",
      icon: Sparkles,
      count: earnRules.length,
    },
    {
      id: "rewards",
      label: "Ways to Redeem",
      icon: Gift,
      count: rewards.length,
    },
    { id: "customers", label: "Customers", icon: Users },
    { id: "activity", label: "Activity Ledger", icon: History },
    { id: "referrals", label: "Referrals", icon: Share2 },
    { id: "vip", label: "VIP Tiers", icon: Crown, count: tiers.length },
    {
      id: "bonuses",
      label: "Bonus Campaigns",
      icon: Flame,
      count: campaigns.length,
    },
    { id: "analytics", label: "Analytics & Liability", icon: BarChart3 },
    { id: "onsite", label: "On-site Content", icon: Layout },
    { id: "settings", label: "Settings & Backfill", icon: Settings },
  ];

  return (
    <div className="space-y-6">
      {/* Top Banner if Kill Switch is active */}
      {killSwitchActive && (
        <div className="flex items-center justify-between rounded-xl bg-red-600 p-3 text-xs font-semibold text-white shadow-sm">
          <div className="flex items-center gap-2">
            <AlertOctagon className="h-4 w-4" />
            <span>
              Emergency Kill-Switch is ACTIVE. All points earning and
              redemptions are paused.
            </span>
          </div>
          <button
            type="button"
            onClick={() => setActiveTab("settings")}
            className="rounded-lg bg-white px-3 py-1 text-[11px] font-bold text-red-700 transition-colors hover:bg-red-50"
          >
            Manage in Settings
          </button>
        </div>
      )}

      {/* Navigation Tabs Bar */}
      <div className="shadow-xs rounded-2xl border-b border-gray-200/80 bg-white px-2 pt-2">
        <nav
          className="scrollbar-none flex space-x-1 overflow-x-auto pb-2"
          aria-label="Tabs"
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isSelected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => handleTabChange(tab.id)}
                className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-3.5 py-2 text-xs font-semibold transition-all ${
                  isSelected
                    ? "shadow-xs bg-black text-white"
                    : "text-gray-600 hover:bg-gray-100/70 hover:text-black"
                }`}
              >
                <Icon
                  className={`h-4 w-4 ${isSelected ? "text-white" : "text-gray-400"}`}
                />
                <span>{tab.label}</span>
                {tab.count !== undefined && tab.count > 0 && (
                  <span
                    className={`py-0.2 rounded-full px-1.5 text-[10px] font-bold ${
                      isSelected
                        ? "bg-white/20 text-white"
                        : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab Content Panes */}
      <div className="min-h-[500px]">
        {loading && !settings ? (
          <div className="rounded-2xl border border-gray-200/80 bg-white p-16 text-center text-xs text-gray-400 shadow-sm">
            <RefreshCw className="mx-auto mb-2 h-6 w-6 animate-spin text-gray-400" />
            Loading loyalty dashboard modules...
          </div>
        ) : (
          <>
            {activeTab === "points" && (
              <TabPoints
                settings={settings}
                analytics={analytics}
                earnRules={earnRules}
                rewards={rewards}
                currency={currency}
                onNavigateTab={(tab) => handleTabChange(tab as any)}
                onRefresh={fetchProgramData}
                isOwner={isOwner}
              />
            )}

            {activeTab === "earn" && workspaceId && (
              <TabEarn workspaceId={workspaceId} onRefresh={fetchProgramData} />
            )}

            {activeTab === "rewards" && workspaceId && (
              <TabRewards
                workspaceId={workspaceId}
                onRefresh={fetchProgramData}
              />
            )}

            {activeTab === "customers" && (
              <TabCustomers
                tiers={tiers}
                isOwner={isOwner}
                onRefresh={fetchProgramData}
              />
            )}

            {activeTab === "activity" && <TabActivity isOwner={isOwner} />}

            {activeTab === "referrals" && workspaceId && (
              <TabReferrals
                workspaceId={workspaceId}
                referralData={referralData}
                onRefresh={fetchProgramData}
              />
            )}

            {activeTab === "vip" && (
              <TabVip
                tiers={tiers}
                onConfigure={() => handleTabChange("settings")}
                currency={currency}
                onRefresh={fetchProgramData}
              />
            )}

            {activeTab === "bonuses" && (
              <TabBonuses
                campaigns={campaigns}
                tiers={tiers}
                onRefresh={fetchProgramData}
              />
            )}

            {activeTab === "analytics" && (
              <TabAnalytics
                currency={settings?.accountingCurrency || currency}
                initialAnalytics={analytics}
                isOwner={isOwner}
              />
            )}

            {activeTab === "onsite" && (
              <TabOnsite
                branding={branding}
                brandingLoaded={brandingLoaded}
                brandingLoadError={brandingLoadError}
                earnRules={earnRules}
                rewards={rewards}
                tiers={tiers}
                referralRule={referralData?.rule}
                shopDomain={shopDomain}
                currency={currency}
                pointNameSingular={settings?.pointNameSingular}
                pointNamePlural={settings?.pointNamePlural}
                onRefresh={fetchProgramData}
              />
            )}

            {activeTab === "settings" && (
              <TabSettings
                workspaceId={workspaceId!}
                settings={settings}
                currency={currency}
                isOwner={isOwner}
                onRefresh={fetchProgramData}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
