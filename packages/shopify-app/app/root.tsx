import type { HeadersFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useRouteError,
} from "@remix-run/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider } from "@shopify/polaris";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import enTranslations from "@shopify/polaris/locales/en.json";
import jaTranslations from "@shopify/polaris/locales/ja.json";
import viTranslations from "@shopify/polaris/locales/vi.json";
import { boundary } from "@shopify/shopify-app-remix/server";
import { isCoreLaunch } from "@weletic/contracts/core-launch-policy";
import { isSetupOnly } from "@weletic/contracts/shopify/setup-only";
import { CoreLaunchContext } from "~/core-launch-context";
import { MerchantLocaleProvider, useMerchantLocale } from "./merchant-locale";
import { SubscriptionStatus } from "./subscription-status";
import { requireEnv } from "./weletic-api.server";

const navLinks = [
  {
    to: "/",
    rel: "home",
    label: { en: "Overview", ja: "概要", vi: "Tổng quan" },
    core: true,
  },
  {
    to: "/customers",
    label: { en: "Customers", ja: "顧客", vi: "Khách hàng" },
    core: true,
  },
  {
    to: "/reviews",
    label: { en: "Reviews", ja: "レビュー", vi: "Đánh giá" },
    core: true,
  },
  {
    to: "/loyalty",
    label: {
      en: "Loyalty Program",
      ja: "ロイヤルティ",
      vi: "Khách hàng thân thiết",
    },
    core: true,
  },
  {
    to: "/earning-rules",
    label: { en: "Earning Rules", ja: "獲得ルール", vi: "Quy tắc tích điểm" },
    core: true,
  },
  {
    to: "/loyalty-rewards",
    label: { en: "Rewards", ja: "特典", vi: "Phần thưởng" },
    core: true,
  },
  {
    to: "/loyalty-referrals",
    label: { en: "Referrals", ja: "紹介プログラム", vi: "Giới thiệu" },
    core: false,
  },
  {
    to: "/loyalty-vip",
    label: {
      en: "VIP & Campaigns",
      ja: "VIP & キャンペーン",
      vi: "VIP & Chiến dịch",
    },
    core: false,
  },
  {
    to: "/loyalty-analytics",
    label: { en: "Analytics", ja: "分析", vi: "Phân tích" },
    core: false,
  },
  {
    to: "/loyalty-communications",
    label: { en: "Communications", ja: "コミュニケーション", vi: "Thông báo" },
    core: true,
  },
  {
    to: "/loyalty-imports",
    label: { en: "Imports", ja: "インポート", vi: "Nhập dữ liệu" },
    core: false,
  },
  {
    to: "/loyalty-nudges",
    label: { en: "Nudges", ja: "ナッジ設定", vi: "Gợi ý tương tác" },
    core: false,
  },
  {
    to: "/loyalty-flow",
    label: { en: "Flow Permissions", ja: "Flow権限", vi: "Quyền Flow" },
    core: true,
  },
  {
    to: "/appearance",
    label: { en: "Appearance", ja: "外観", vi: "Giao diện" },
    core: true,
  },
  {
    to: "/settings",
    label: { en: "Settings", ja: "設定", vi: "Cài đặt" },
    core: true,
  },
] as const;

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

export function loader() {
  return json({
    apiKey: requireEnv("SHOPIFY_API_KEY"),
    coreLaunch: isCoreLaunch(),
    setupOnly: isSetupOnly(),
    restrictedDevelopment:
      process.env.WELETIC_RESTRICTED_DEVELOPMENT !== undefined,
  });
}

export default function App() {
  return (
    <MerchantLocaleProvider>
      <AppDocument />
    </MerchantLocaleProvider>
  );
}

function AppDocument() {
  const [locale] = useMerchantLocale();
  const { apiKey, coreLaunch, setupOnly, restrictedDevelopment } =
    useLoaderData<typeof loader>();

  const visibleLinks = navLinks.filter((item) => !coreLaunch || item.core);

  return (
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="shopify-api-key" content={apiKey} />
        <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
        <Meta />
        <Links />
      </head>
      <body>
        <AppProvider
          i18n={
            { en: enTranslations, ja: jaTranslations, vi: viTranslations }[
              locale
            ]
          }
        >
          <NavMenu>
            {visibleLinks.map((item) => (
              <a
                key={item.to}
                href={item.to}
                {...("rel" in item && item.rel ? { rel: item.rel } : {})}
              >
                {item.label[locale]}
              </a>
            ))}
          </NavMenu>
          {coreLaunch && (
            <SubscriptionStatus
              setupOnly={setupOnly}
              restrictedDevelopment={restrictedDevelopment}
            />
          )}
          <CoreLaunchContext.Provider value={coreLaunch}>
            <Outlet />
          </CoreLaunchContext.Provider>
        </AppProvider>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
