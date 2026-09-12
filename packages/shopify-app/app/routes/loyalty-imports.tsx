import { useAppBridge } from "@shopify/app-bridge-react";
import LoyaltyImportsPage from "../imports-page";

export { action, ErrorBoundary, headers, links, loader } from "./settings";

export default function LoyaltyImportsRoute() {
  const shopify = useAppBridge();
  return <LoyaltyImportsPage shopify={shopify} />;
}
