import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useId, useMemo } from "react";
import { RewardCatalogSession } from "~/ui/loyalty/reward-catalog-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { useMerchantLocale } from "../merchant-locale";
import { createMerchantRewardCatalogClient } from "../merchant-reward-catalog-client";

// Data-free authenticated bootstrap. Every data request obtains a fresh token.
export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function RewardCatalogPage() {
  const shopify = useAppBridge();
  const [locale] = useMerchantLocale();
  const scopeKey = useId();
  const transport = useMemo(
    () => ({
      scopeKey,
      ...createMerchantRewardCatalogClient(() => shopify.idToken()),
    }),
    [scopeKey, shopify],
  );

  const pageTitle =
    locale === "ja"
      ? "特典カタログ"
      : locale === "vi"
        ? "Danh mục phần thưởng"
        : "Rewards Catalog";

  return (
    <main className="weletic-shoppers">
      <TitleBar title={pageTitle} />
      <LoyaltyNavigation />
      <RewardCatalogSession transport={transport} />
    </main>
  );
}
