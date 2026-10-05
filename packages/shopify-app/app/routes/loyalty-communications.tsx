import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useMemo, useState } from "react";
import { CommunicationsScreen } from "~/ui/loyalty/communications-screen";
import { useCommunicationsUnsavedGuard } from "../communications-unsaved-guard";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { useMerchantLocale } from "../merchant-locale";
import { createMerchantCommunicationsClient } from "../merchant-communications-client";

export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function LoyaltyCommunicationsPage() {
  const [locale] = useMerchantLocale();
  const [navigation, setNavigation] = useState<{
    dirty: boolean;
    locale: "en" | "ja" | "vi";
  }>({ dirty: false, locale: "en" });
  useCommunicationsUnsavedGuard(navigation);
  const shopify = useAppBridge();
  const request = useMemo(
    () => createMerchantCommunicationsClient(() => shopify.idToken()),
    [shopify],
  );

  const pageTitle =
    locale === "ja"
      ? "コミュニケーション"
      : locale === "vi"
        ? "Thông báo khách hàng"
        : "Communications";

  return (
    <main className="weletic-shoppers">
      <TitleBar title={pageTitle} />
      <LoyaltyNavigation />
      <CommunicationsScreen
        request={request}
        onNavigationStateChange={setNavigation}
      />
    </main>
  );
}
