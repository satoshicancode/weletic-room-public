import { useAppBridge } from "@shopify/app-bridge-react";
import { useMemo } from "react";
import { MerchantAnalyticsScreen } from "../../../../apps/web/ui/weletic/loyalty/merchant-analytics-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { createMerchantAccountRowExportClient } from "../merchant-account-row-export-client";
import { createMerchantAnalyticsClient } from "../merchant-analytics-client";
import { createMerchantLedgerRowExportClient } from "../merchant-ledger-row-export-client";
import { createMerchantRedemptionRowExportClient } from "../merchant-redemption-row-export-client";
import { createMerchantTierHistoryExportClient } from "../merchant-tier-history-export-client";

export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function LoyaltyAnalyticsPage() {
  const shopify = useAppBridge();
  const request = useMemo(
    () => createMerchantAnalyticsClient(() => shopify.idToken()),
    [shopify],
  );
  const requestTierHistory = useMemo(
    () => createMerchantTierHistoryExportClient(() => shopify.idToken()),
    [shopify],
  );
  const requestLedgerRows = useMemo(
    () => createMerchantLedgerRowExportClient(() => shopify.idToken()),
    [shopify],
  );
  const requestRedemptionRows = useMemo(
    () => createMerchantRedemptionRowExportClient(() => shopify.idToken()),
    [shopify],
  );
  const requestAccountRows = useMemo(
    () => createMerchantAccountRowExportClient(() => shopify.idToken()),
    [shopify],
  );
  return (
    <main className="weletic-shoppers">
      <LoyaltyNavigation />
      <MerchantAnalyticsScreen
        request={request}
        requestTierHistory={requestTierHistory}
        requestLedgerRows={requestLedgerRows}
        requestRedemptionRows={requestRedemptionRows}
        requestAccountRows={requestAccountRows}
      />
    </main>
  );
}
