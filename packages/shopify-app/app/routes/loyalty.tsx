import { Link } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useId, useMemo } from "react";
import { LoyaltyConfigurationSession } from "../../../../apps/web/ui/weletic/loyalty/configuration-screen";
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
      <nav aria-label="Weletic">
        <Link to="/">Weletic</Link>
        <Link to="/earning-rules">Earning rules</Link>
        <Link to="/loyalty-rewards">Rewards</Link>
        <Link to="/loyalty-referrals">Referrals</Link>
      </nav>
      <LoyaltyConfigurationSession transport={transport} />
    </main>
  );
}
