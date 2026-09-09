import { useAppBridge } from "@shopify/app-bridge-react";
import { useMemo } from "react";
import { MerchantAnalyticsScreen } from "../../../../apps/web/ui/weletic/loyalty/merchant-analytics-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { createMerchantAnalyticsClient } from "../merchant-analytics-client";

export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function LoyaltyAnalyticsPage() {
  const shopify = useAppBridge();
  const request = useMemo(
    () => createMerchantAnalyticsClient(() => shopify.idToken()),
    [shopify],
  );
  return (
    <main className="weletic-shoppers">
      <LoyaltyNavigation />
      <MerchantAnalyticsScreen request={request} />
    </main>
  );
}
