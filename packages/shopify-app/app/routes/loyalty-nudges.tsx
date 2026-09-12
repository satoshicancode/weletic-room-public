import { useAppBridge } from "@shopify/app-bridge-react";
import { useMemo, useState } from "react";
import { LoyaltyNudgeScreen } from "../../../../apps/web/ui/weletic/loyalty/nudge-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { createMerchantLoyaltyNudgeClient } from "../merchant-loyalty-nudges-client";
import { useNudgeUnsavedGuard } from "../nudge-unsaved-guard";

export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function LoyaltyNudgesPage() {
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
  return (
    <main className="weletic-shoppers">
      <LoyaltyNavigation />
      <LoyaltyNudgeScreen
        request={request}
        onNavigationStateChange={setNavigation}
      />
    </main>
  );
}
