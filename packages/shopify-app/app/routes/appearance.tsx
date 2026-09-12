import { useBeforeUnload, useBlocker } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { appearanceCopy } from "../../../../apps/web/ui/weletic/loyalty/appearance-copy";
import { LoyaltyAppearanceScreen } from "../../../../apps/web/ui/weletic/loyalty/appearance-screen";
import { createMerchantLoyaltyAppearanceClient } from "../merchant-loyalty-appearance-client";
import SettingsPage from "./settings";

export { action, ErrorBoundary, headers, links, loader } from "./settings";

export default function AppearancePage() {
  const shopify = useAppBridge();
  const request = useMemo(
    () => createMerchantLoyaltyAppearanceClient(() => shopify.idToken()),
    [shopify],
  );
  const [navigation, setNavigation] = useState<{
    dirty: boolean;
    locale: "en" | "ja" | "vi";
  }>({ dirty: false, locale: "en" });
  const blocker = useBlocker(navigation.dirty);
  useBeforeUnload(
    useCallback(
      (event) => {
        if (!navigation.dirty) return;
        event.preventDefault();
        event.returnValue = "";
      },
      [navigation.dirty],
    ),
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm(appearanceCopy[navigation.locale].discard))
      blocker.proceed();
    else blocker.reset();
  }, [blocker, navigation.locale]);
  return (
    <SettingsPage appearanceOnly>
      <LoyaltyAppearanceScreen
        request={request}
        onNavigationStateChange={setNavigation}
      />
    </SettingsPage>
  );
}
