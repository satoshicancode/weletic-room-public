import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useId, useMemo } from "react";
import { VipCampaignSession } from "~/ui/loyalty/vip-campaign-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { useMerchantLocale } from "../merchant-locale";
import { createMerchantVipCampaignClient } from "../merchant-vip-campaign-client";

export { action, ErrorBoundary, headers, links, loader } from "./settings";

export default function VipCampaignPage() {
  const shopify = useAppBridge();
  const [locale] = useMerchantLocale();
  const scopeKey = useId();
  const transport = useMemo(
    () => ({
      scopeKey,
      ...createMerchantVipCampaignClient(() => shopify.idToken()),
    }),
    [scopeKey, shopify],
  );

  const pageTitle =
    locale === "ja"
      ? "VIP & キャンペーン"
      : locale === "vi"
        ? "VIP & Chiến dịch"
        : "VIP & Campaigns";

  return (
    <main className="weletic-shoppers">
      <TitleBar title={pageTitle} />
      <LoyaltyNavigation />
      <VipCampaignSession transport={transport} />
    </main>
  );
}
