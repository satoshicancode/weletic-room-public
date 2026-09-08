import { useAppBridge } from "@shopify/app-bridge-react";
import { useId, useMemo } from "react";
import { LoyaltyConfigurationSession } from "../../../../apps/web/ui/weletic/loyalty/configuration-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { createMerchantLoyaltyConfigurationClient } from "../merchant-loyalty-configuration-client";

// Data-free, authenticated page bootstrap; all reads/writes use fresh staff
// authority through the signed configuration gateway.
export { action, ErrorBoundary, headers, links, loader } from "./settings";

export default function LoyaltyPage() {
  const shopify = useAppBridge();
  const scopeKey = useId();
  const transport = useMemo(
    () => ({
      scopeKey,
      ...createMerchantLoyaltyConfigurationClient(() => shopify.idToken()),
    }),
    [scopeKey, shopify],
  );
  return (
    <main className="weletic-shoppers">
      <LoyaltyNavigation />
      <LoyaltyConfigurationSession transport={transport} />
    </main>
  );
}
