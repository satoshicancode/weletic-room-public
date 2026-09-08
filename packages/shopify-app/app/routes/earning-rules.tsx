import { Link } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useId, useMemo } from "react";
import { EarningRulesSession } from "../../../../apps/web/ui/weletic/loyalty/earning-rules-screen";
import { createMerchantEarningRulesClient } from "../merchant-earning-rules-client";

// Data-free authenticated bootstrap. Every data request obtains a fresh token.
export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function EarningRulesPage() {
  const shopify = useAppBridge();
  const scopeKey = useId();
  const transport = useMemo(
    () => ({
      scopeKey,
      ...createMerchantEarningRulesClient(() => shopify.idToken()),
    }),
    [scopeKey, shopify],
  );
  return (
    <main className="weletic-shoppers">
      <nav aria-label="Weletic">
        <Link to="/">Weletic</Link> · <Link to="/loyalty">Loyalty</Link>
      </nav>
      <EarningRulesSession transport={transport} />
    </main>
  );
}
