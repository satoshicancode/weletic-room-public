import { useAppBridge } from "@shopify/app-bridge-react";
import { useMemo, useState } from "react";
import { CommunicationsScreen } from "../../../../apps/web/ui/weletic/loyalty/communications-screen";
import { useCommunicationsUnsavedGuard } from "../communications-unsaved-guard";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { createMerchantCommunicationsClient } from "../merchant-communications-client";

export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function LoyaltyCommunicationsPage() {
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
  return (
    <main className="weletic-shoppers">
      <LoyaltyNavigation />
      <CommunicationsScreen
        request={request}
        onNavigationStateChange={setNavigation}
      />
    </main>
  );
}
