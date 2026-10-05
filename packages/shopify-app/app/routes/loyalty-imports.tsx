import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import LoyaltyImportsPage from "../imports-page";
import { useMerchantLocale } from "../merchant-locale";

export { action, ErrorBoundary, headers, links, loader } from "./settings";

export default function LoyaltyImportsRoute() {
  const shopify = useAppBridge();
  const [locale] = useMerchantLocale();
  const pageTitle =
    locale === "ja" ? "インポート" : locale === "vi" ? "Nhập dữ liệu" : "Imports";

  return (
    <>
      <TitleBar title={pageTitle} />
      <LoyaltyImportsPage shopify={shopify} />
    </>
  );
}
