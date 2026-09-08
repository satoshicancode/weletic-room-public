import { Link } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useId, useMemo } from "react";
import { RewardCatalogSession } from "../../../../apps/web/ui/weletic/loyalty/reward-catalog-screen";
import { createMerchantRewardCatalogClient } from "../merchant-reward-catalog-client";

// Data-free authenticated bootstrap. Every data request obtains a fresh token.
export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function RewardCatalogPage() {
  const shopify = useAppBridge();
  const scopeKey = useId();
  const transport = useMemo(
    () => ({
      scopeKey,
      ...createMerchantRewardCatalogClient(() => shopify.idToken()),
    }),
    [scopeKey, shopify],
  );
  return (
    <main className="weletic-shoppers">
      <nav aria-label="Weletic">
        <Link to="/">Weletic</Link> · <Link to="/loyalty">Loyalty</Link>
      </nav>
      <RewardCatalogSession transport={transport} />
    </main>
  );
}
