import { useAppBridge } from "@shopify/app-bridge-react";
import { useId, useMemo } from "react";
import { VipCampaignSession } from "../../../../apps/web/ui/weletic/loyalty/vip-campaign-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { createMerchantVipCampaignClient } from "../merchant-vip-campaign-client";

export { action, ErrorBoundary, headers, links, loader } from "./settings";

export default function VipCampaignPage() {
  const shopify = useAppBridge();
  const scopeKey = useId();
  const transport = useMemo(
    () => ({
      scopeKey,
      ...createMerchantVipCampaignClient(() => shopify.idToken()),
    }),
    [scopeKey, shopify],
  );
  return (
    <main className="weletic-shoppers">
      <LoyaltyNavigation />
      <VipCampaignSession transport={transport} />
    </main>
  );
}
