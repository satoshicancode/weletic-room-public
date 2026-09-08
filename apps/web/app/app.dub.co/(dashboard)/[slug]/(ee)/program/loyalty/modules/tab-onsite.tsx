"use client";

import { LoyaltyWidget } from "@/components/weletic/loyalty/LoyaltyWidget";
import { DEFAULT_LOYALTY_BRANDING } from "@/lib/weletic/loyalty/branding";
import {
  AlertTriangle,
  Eye,
  Layout,
  Monitor,
  Palette,
  RefreshCw,
  Smartphone,
} from "lucide-react";
import React, { useEffect, useState } from "react";
import { toast } from "sonner";
import { LoyaltyAdminApi, type LoyaltyBranding } from "../api-client";

export interface TabOnsiteProps {
  branding: LoyaltyBranding | null;
  brandingLoaded: boolean;
  brandingLoadError: string | null;
  earnRules?: any[];
  rewards?: any[];
  tiers?: any[];
  referralRule?: any;
  shopDomain?: string;
  currency?: string;
  pointNameSingular?: string;
  pointNamePlural?: string;
  onRefresh: () => void;
}

export function TabOnsite({
  branding,
  brandingLoaded,
  brandingLoadError,
  earnRules = [],
  rewards = [],
  tiers = [],
  referralRule,
  shopDomain = "store.myshopify.com",
  currency = "USD",
  pointNameSingular = "Point",
  pointNamePlural = "Points",
  onRefresh,
}: TabOnsiteProps) {
  const [launcherText, setLauncherText] = useState(
    branding?.launcherText || DEFAULT_LOYALTY_BRANDING.launcherText,
  );
  const [launcherPosition, setLauncherPosition] = useState<
    LoyaltyBranding["launcherPosition"]
  >(branding?.launcherPosition || DEFAULT_LOYALTY_BRANDING.launcherPosition);
  const [launcherIcon, setLauncherIcon] = useState<
    LoyaltyBranding["launcherIcon"]
  >(branding?.launcherIcon || DEFAULT_LOYALTY_BRANDING.launcherIcon);
  const [primaryColor, setPrimaryColor] = useState(
    branding?.primaryColor || DEFAULT_LOYALTY_BRANDING.primaryColor,
  );
  const [headerTextColor, setHeaderTextColor] = useState(
    branding?.headerTextColor || DEFAULT_LOYALTY_BRANDING.headerTextColor,
  );
  const [panelTitle, setPanelTitle] = useState(
    branding?.panelTitle || DEFAULT_LOYALTY_BRANDING.panelTitle,
  );
  const [panelWelcomeSubtitle, setPanelWelcomeSubtitle] = useState(
    branding?.panelWelcomeSubtitle ??
      DEFAULT_LOYALTY_BRANDING.panelWelcomeSubtitle,
  );
  const [heroImageUrl, setHeroImageUrl] = useState(
    branding?.heroImageUrl || "",
  );
  const [enableFloatingLauncher, setEnableFloatingLauncher] = useState(
    branding?.enableFloatingLauncher ??
      DEFAULT_LOYALTY_BRANDING.enableFloatingLauncher,
  );
  const [syncedBranding, setSyncedBranding] = useState<LoyaltyBranding | null>(
    branding,
  );

  const [previewDevice, setPreviewDevice] = useState<"mobile" | "desktop">(
    "mobile",
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!branding) return;
    setLauncherText(branding.launcherText);
    setLauncherPosition(branding.launcherPosition);
    setLauncherIcon(branding.launcherIcon);
    setPrimaryColor(branding.primaryColor);
    setHeaderTextColor(branding.headerTextColor);
    setPanelTitle(branding.panelTitle);
    setPanelWelcomeSubtitle(branding.panelWelcomeSubtitle);
    setHeroImageUrl(branding.heroImageUrl || "");
    setEnableFloatingLauncher(branding.enableFloatingLauncher);
    setSyncedBranding(branding);
  }, [branding]);

  const brandingReady =
    brandingLoaded && branding !== null && syncedBranding === branding;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!brandingReady) {
      toast.error(
        "Saved branding must finish loading before you can make changes.",
      );
      return;
    }
    try {
      setSaving(true);
      const nextBranding: LoyaltyBranding = {
        launcherText:
          launcherText.trim() || DEFAULT_LOYALTY_BRANDING.launcherText,
        launcherPosition,
        launcherIcon,
        primaryColor,
        headerTextColor,
        panelTitle: panelTitle.trim() || DEFAULT_LOYALTY_BRANDING.panelTitle,
        panelWelcomeSubtitle: panelWelcomeSubtitle.trim(),
        heroImageUrl: heroImageUrl.trim() || null,
        enableFloatingLauncher,
      };
      await LoyaltyAdminApi.updateBranding(nextBranding);
      toast.success("On-site branding and launcher settings saved");
      onRefresh();
    } catch (err: any) {
      toast.error(err.message || "Failed to save branding");
    } finally {
      setSaving(false);
    }
  };

  const previewBranding = {
    launcherText,
    launcherPosition,
    launcherIcon,
    primaryColor,
    headerTextColor,
    panelTitle,
    panelWelcomeSubtitle,
    heroImageUrl: heroImageUrl.trim() || null,
    enableFloatingLauncher,
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">
            On-Site Content & Storefront Preview
          </h2>
          <p className="text-xs text-gray-500">
            Customize the floating launcher button, modal drawer branding, and
            preview the live storefront experience.
          </p>
        </div>

        <div className="flex items-center gap-2 rounded-xl bg-gray-100 p-1">
          <button
            type="button"
            onClick={() => setPreviewDevice("mobile")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              previewDevice === "mobile"
                ? "bg-white text-black shadow-sm"
                : "text-gray-600 hover:text-black"
            }`}
          >
            <Smartphone className="h-3.5 w-3.5" /> Mobile Frame
          </button>
          <button
            type="button"
            onClick={() => setPreviewDevice("desktop")}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all ${
              previewDevice === "desktop"
                ? "bg-white text-black shadow-sm"
                : "text-gray-600 hover:text-black"
            }`}
          >
            <Monitor className="h-3.5 w-3.5" /> Desktop Browser
          </button>
        </div>
      </div>

      {brandingLoadError && (
        <div
          id="branding-load-error"
          role="alert"
          className="flex items-center justify-between gap-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="text-xs font-semibold">
                On-site customization is temporarily read-only
              </p>
              <p className="mt-0.5 text-xs">{brandingLoadError}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-amber-100"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Retry
          </button>
        </div>
      )}

      {/* Main Layout: Form (Left) + Interactive Preview (Right) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Customization Form */}
        <div className="space-y-6 lg:col-span-5">
          <form
            onSubmit={handleSave}
            aria-describedby={
              brandingLoadError ? "branding-load-error" : undefined
            }
          >
            <fieldset
              disabled={!brandingReady || saving}
              className="space-y-6 disabled:cursor-not-allowed"
            >
              {/* Launcher Button Card */}
              <div className="space-y-4 rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-900">
                  <Layout className="h-4 w-4 text-indigo-600" />
                  Floating Launcher Button
                </h3>

                <div>
                  <label className="mb-1 block text-xs font-semibold text-gray-700">
                    Button Text
                  </label>
                  <input
                    type="text"
                    value={launcherText}
                    onChange={(e) => setLauncherText(e.target.value)}
                    placeholder="Rewards"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-gray-700">
                      Launcher Position
                    </label>
                    <select
                      value={launcherPosition}
                      onChange={(e) =>
                        setLauncherPosition(
                          e.target.value as LoyaltyBranding["launcherPosition"],
                        )
                      }
                      className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
                    >
                      <option value="bottom_right">Bottom Right</option>
                      <option value="bottom_left">Bottom Left</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs font-semibold text-gray-700">
                      Launcher Icon
                    </label>
                    <select
                      value={launcherIcon}
                      onChange={(e) =>
                        setLauncherIcon(
                          e.target.value as LoyaltyBranding["launcherIcon"],
                        )
                      }
                      className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
                    >
                      <option value="award">Award Ribbon</option>
                      <option value="gift">Gift Box</option>
                      <option value="crown">Crown</option>
                      <option value="star">Star</option>
                      <option value="sparkles">Sparkles</option>
                    </select>
                  </div>
                </div>

                <div>
                  <label className="flex cursor-pointer items-center gap-2 pt-1">
                    <input
                      type="checkbox"
                      checked={enableFloatingLauncher}
                      onChange={(e) =>
                        setEnableFloatingLauncher(e.target.checked)
                      }
                      className="h-4 w-4 rounded border-gray-300 text-black focus:ring-black"
                    />
                    <span className="text-xs font-medium text-gray-700">
                      Enable floating launcher on storefront
                    </span>
                  </label>
                </div>
              </div>

              {/* Modal & Drawer Card */}
              <div className="space-y-4 rounded-2xl border border-gray-200/80 bg-white p-5 shadow-sm">
                <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-gray-900">
                  <Palette className="h-4 w-4 text-purple-600" />
                  Theme Colors & Modal Header
                </h3>

                <div>
                  <label className="mb-1 block text-xs font-semibold text-gray-700">
                    Primary Theme Color
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={primaryColor}
                      onChange={(e) => setPrimaryColor(e.target.value)}
                      className="h-8 w-8 cursor-pointer rounded-lg border-0 p-0"
                    />
                    <input
                      type="text"
                      value={primaryColor}
                      onChange={(e) => setPrimaryColor(e.target.value)}
                      placeholder="#6366f1"
                      className="flex-1 rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-black"
                    />
                  </div>
                  {/* Color presets */}
                  <div className="mt-2 flex items-center gap-2">
                    {[
                      "#6366f1",
                      "#059669",
                      "#dc2626",
                      "#d97706",
                      "#2563eb",
                      "#000000",
                    ].map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setPrimaryColor(c)}
                        style={{ backgroundColor: c }}
                        className="shadow-xs h-5 w-5 rounded-full border border-gray-200 transition-transform hover:scale-110"
                      />
                    ))}
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold text-gray-700">
                    Header Text Color
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="color"
                      value={headerTextColor}
                      onChange={(e) => setHeaderTextColor(e.target.value)}
                      className="h-8 w-8 cursor-pointer rounded-lg border-0 p-0"
                    />
                    <input
                      type="text"
                      value={headerTextColor}
                      onChange={(e) => setHeaderTextColor(e.target.value)}
                      placeholder="#ffffff"
                      className="flex-1 rounded-lg border border-gray-200 px-3 py-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-black"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold text-gray-700">
                    Panel Title
                  </label>
                  <input
                    type="text"
                    value={panelTitle}
                    onChange={(e) => setPanelTitle(e.target.value)}
                    placeholder="Rewards Club"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold text-gray-700">
                    Welcome Subtitle
                  </label>
                  <textarea
                    rows={2}
                    value={panelWelcomeSubtitle}
                    onChange={(e) => setPanelWelcomeSubtitle(e.target.value)}
                    placeholder="Earn points, level up, and unlock exclusive discounts."
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-xs font-semibold text-gray-700">
                    Loyalty Hub Hero Image URL
                  </label>
                  <input
                    type="url"
                    value={heroImageUrl}
                    onChange={(e) => setHeroImageUrl(e.target.value)}
                    placeholder="https://cdn.example.com/loyalty-hero.jpg"
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-black"
                  />
                  <p className="mt-1 text-[11px] text-gray-500">
                    Optional HTTPS image displayed in the Shopify customer
                    account Loyalty Hub.
                  </p>
                </div>
              </div>

              <button
                type="submit"
                disabled={!brandingReady || saving}
                className="w-full rounded-xl bg-black py-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-gray-800 disabled:opacity-50"
              >
                {saving ? "Saving Changes..." : "Save On-Site Customization"}
              </button>
            </fieldset>
          </form>
        </div>

        {/* Live Interactive Storefront Preview */}
        <div className="flex flex-col items-center justify-start lg:col-span-7">
          <div className="flex w-full flex-col items-center rounded-3xl border border-gray-200 bg-gray-100 p-4">
            <div className="mb-3 flex items-center gap-1.5 text-[11px] font-medium text-gray-500">
              <Eye className="h-3.5 w-3.5" /> Interactive Storefront Live
              Preview ({previewDevice})
            </div>

            {previewDevice === "mobile" ? (
              /* Mobile iPhone Device Frame */
              <div className="relative flex h-[680px] w-[360px] flex-col overflow-hidden rounded-[40px] border-[8px] border-gray-900 bg-white shadow-2xl">
                {/* Dynamic Notch */}
                <div className="relative flex h-7 w-full items-center justify-center bg-gray-900">
                  <div className="mb-1 h-4 w-20 rounded-full bg-black"></div>
                </div>

                {/* Mock Store Header */}
                <div className="flex items-center justify-between border-b border-gray-100 bg-white px-4 py-3">
                  <span className="text-xs font-bold uppercase tracking-wider text-gray-900">
                    Store Demo
                  </span>
                  <div className="flex items-center gap-2 text-gray-600">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium">
                      Cart (1)
                    </span>
                  </div>
                </div>

                {/* Mock Store Content */}
                <div className="flex-1 space-y-4 overflow-y-auto bg-gray-50/50 p-4 text-center">
                  <div className="shadow-xs rounded-2xl border border-gray-100 bg-white p-6">
                    <div className="mx-auto mb-3 flex h-20 w-20 items-center justify-center rounded-xl bg-gray-100 text-gray-300">
                      Product
                    </div>
                    <h4 className="text-xs font-semibold text-gray-900">
                      Performance Activewear
                    </h4>
                    <p className="mt-1 text-xs font-bold text-emerald-600">
                      $48.00
                    </p>
                  </div>
                </div>

                {/* Embedded Live Widget In Preview Mode */}
                <div className="pointer-events-auto absolute inset-0 z-10">
                  <LoyaltyWidget
                    shopDomain={shopDomain}
                    previewMode={true}
                    isInlinePreview={true}
                    branding={previewBranding}
                    currency={currency}
                    earningRules={earnRules}
                    pointNamePlural={pointNamePlural}
                    pointNameSingular={pointNameSingular}
                    rewards={rewards}
                    tiers={tiers}
                    referralRule={referralRule}
                  />
                </div>
              </div>
            ) : (
              /* Desktop Browser Frame */
              <div className="relative flex h-[620px] w-full flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl">
                {/* Browser Address Bar */}
                <div className="flex items-center gap-2 border-b border-gray-200 bg-gray-100 px-4 py-2">
                  <div className="flex gap-1.5">
                    <div className="h-2.5 w-2.5 rounded-full bg-red-400"></div>
                    <div className="h-2.5 w-2.5 rounded-full bg-yellow-400"></div>
                    <div className="h-2.5 w-2.5 rounded-full bg-green-400"></div>
                  </div>
                  <div className="flex-1 rounded-md border border-gray-200/80 bg-white px-3 py-1 font-mono text-[11px] text-gray-500">
                    https://{shopDomain}/products/active-collection
                  </div>
                </div>

                {/* Desktop Store Content */}
                <div className="flex-1 space-y-6 overflow-y-auto bg-gray-50/30 p-8">
                  <div className="shadow-xs mx-auto max-w-xl rounded-2xl border border-gray-100 bg-white p-8 text-center">
                    <div className="mx-auto mb-4 flex h-24 w-24 items-center justify-center rounded-2xl bg-gray-100 text-gray-300">
                      Product Image
                    </div>
                    <h3 className="text-sm font-bold text-gray-900">
                      Featured Activewear Collection
                    </h3>
                    <p className="mt-1 text-xs text-gray-500">$65.00</p>
                  </div>
                </div>

                {/* Embedded Live Widget */}
                <div className="pointer-events-auto absolute inset-0 z-10">
                  <LoyaltyWidget
                    shopDomain={shopDomain}
                    previewMode={true}
                    isInlinePreview={true}
                    branding={previewBranding}
                    currency={currency}
                    earningRules={earnRules}
                    pointNamePlural={pointNamePlural}
                    pointNameSingular={pointNameSingular}
                    rewards={rewards}
                    tiers={tiers}
                    referralRule={referralRule}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
