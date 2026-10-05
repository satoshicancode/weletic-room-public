import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { useId, useMemo } from "react";
import { FlowGrantsSession } from "~/ui/loyalty/flow-grants-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import { useMerchantLocale } from "../merchant-locale";
import {
  createMerchantFlowGrantsClient,
  newFlowGrantAttemptId,
} from "../merchant-flow-grants-client";

export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function FlowGrantsPage() {
  const shopify = useAppBridge();
  const [locale] = useMerchantLocale();
  const scopeKey = useId();
  const transport = useMemo(
    () => ({
      scopeKey,
      newAttemptId: newFlowGrantAttemptId,
      ...createMerchantFlowGrantsClient(() => shopify.idToken()),
    }),
    [scopeKey, shopify],
  );

  const pageTitle =
    locale === "ja"
      ? "Flow権限"
      : locale === "vi"
        ? "Quyền Shopify Flow"
        : "Flow Permissions";

  return (
    <main className="weletic-shoppers">
      <TitleBar title={pageTitle} />
      <LoyaltyNavigation />
      <FlowGrantsSession transport={transport} />
    </main>
  );
}
