import { useAppBridge } from "@shopify/app-bridge-react";
import { useId, useMemo } from "react";
import { ReferralConfigurationSession } from "../../../../apps/web/ui/weletic/loyalty/referral-configuration-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { createMerchantReferralConfigurationClient } from "../merchant-referral-configuration-client";

// Data-free authenticated bootstrap. Every data request obtains a fresh token.
export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function ReferralConfigurationPage() {
  const shopify = useAppBridge();
  const scopeKey = useId();
  const transport = useMemo(
    () => ({
      scopeKey,
      ...createMerchantReferralConfigurationClient(() => shopify.idToken()),
    }),
    [scopeKey, shopify],
  );
  return (
    <main className="weletic-shoppers">
      <LoyaltyNavigation />
      <ReferralConfigurationSession transport={transport} />
    </main>
  );
}
