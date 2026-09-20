import { useAppBridge } from "@shopify/app-bridge-react";
import { useId, useMemo } from "react";
import { FlowGrantsSession } from "../../../../apps/web/ui/weletic/loyalty/flow-grants-screen";
import { LoyaltyNavigation } from "../loyalty-navigation";
import {
  createMerchantFlowGrantsClient,
  newFlowGrantAttemptId,
} from "../merchant-flow-grants-client";

export { action, ErrorBoundary, headers, links, loader } from "./settings";
export default function FlowGrantsPage() {
  const shopify = useAppBridge();
  const scopeKey = useId();
  const transport = useMemo(
    () => ({
      scopeKey,
      newAttemptId: newFlowGrantAttemptId,
      ...createMerchantFlowGrantsClient(() => shopify.idToken()),
    }),
    [scopeKey, shopify],
  );
  return (
    <main className="weletic-shoppers">
      <LoyaltyNavigation />
      <FlowGrantsSession transport={transport} />
    </main>
  );
}
