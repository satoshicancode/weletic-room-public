import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useMemo, useState } from "react";
import { LoyaltyNudgeScreen } from "~/ui/loyalty/nudge-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { useMerchantLocale } from "../merchant-locale";
import { createMerchantLoyaltyNudgeClient } from "../merchant-loyalty-nudges-client";
import { useNudgeUnsavedGuard } from "../nudge-unsaved-guard";

export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function LoyaltyNudgesPage() {
  const [locale] = useMerchantLocale();
  const [navigation, setNavigation] = useState<{
    dirty: boolean;
    locale: "en" | "ja" | "vi";
  }>({ dirty: false, locale: "en" });
  useNudgeUnsavedGuard(navigation);
  const shopify = useAppBridge();
  const request = useMemo(
    () => createMerchantLoyaltyNudgeClient(() => shopify.idToken()),
    [shopify],
  );

  const pageTitle =
    locale === "ja"
      ? "ナッジ設定"
      : locale === "vi"
        ? "Gợi ý tương tác"
        : "Loyalty Nudges";

  return (
    <main className="weletic-shoppers">
      <TitleBar title={pageTitle} />
      <LoyaltyNavigation />
      <LoyaltyNudgeScreen
        request={request}
        onNavigationStateChange={setNavigation}
      />
    </main>
  );
}
