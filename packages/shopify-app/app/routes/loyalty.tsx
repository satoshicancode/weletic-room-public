import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useId, useMemo } from "react";
import { LoyaltyConfigurationSession } from "~/ui/loyalty/configuration-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { useMerchantLocale } from "../merchant-locale";
import { createMerchantLoyaltyConfigurationClient } from "../merchant-loyalty-configuration-client";

// Data-free, authenticated page bootstrap; all reads/writes use fresh staff
// authority through the signed configuration gateway.
export { action, ErrorBoundary, headers, links, loader } from "./settings";

export default function LoyaltyPage() {
  const shopify = useAppBridge();
  const [locale] = useMerchantLocale();
  const scopeKey = useId();
  const transport = useMemo(
    () => ({
      scopeKey,
      ...createMerchantLoyaltyConfigurationClient(() => shopify.idToken()),
    }),
    [scopeKey, shopify],
  );

  const pageTitle =
    locale === "ja"
      ? "ロイヤルティプログラム"
      : locale === "vi"
        ? "Chương trình khách hàng thân thiết"
        : "Loyalty Program";

  return (
    <main className="weletic-shoppers">
      <TitleBar title={pageTitle} />
      <LoyaltyNavigation />
      <LoyaltyConfigurationSession transport={transport} />
    </main>
  );
}
