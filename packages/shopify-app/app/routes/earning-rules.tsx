import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useId, useMemo } from "react";
import { EarningRulesSession } from "~/ui/loyalty/earning-rules-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { createMerchantEarningRulesClient } from "../merchant-earning-rules-client";
import { useMerchantLocale } from "../merchant-locale";

// Data-free authenticated bootstrap. Every data request obtains a fresh token.
export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function EarningRulesPage() {
  const shopify = useAppBridge();
  const [locale] = useMerchantLocale();
  const scopeKey = useId();
  const transport = useMemo(
    () => ({
      scopeKey,
      ...createMerchantEarningRulesClient(() => shopify.idToken()),
    }),
    [scopeKey, shopify],
  );

  const pageTitle =
    locale === "ja"
      ? "獲得ルール"
      : locale === "vi"
        ? "Quy tắc tích điểm"
        : "Earning Rules";

  return (
    <main className="weletic-shoppers">
      <TitleBar title={pageTitle} />
      <LoyaltyNavigation />
      <EarningRulesSession transport={transport} />
    </main>
  );
}
