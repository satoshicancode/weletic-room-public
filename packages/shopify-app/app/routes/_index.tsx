import {
  json,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { Link, useRouteError } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { boundary } from "@shopify/shopify-app-remix/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ShopifyMerchantOverview } from "../../../../apps/web/lib/weletic/shopify/staff-contract";
import { createMerchantOverviewClient } from "../merchant-overview-client";
import { merchantOverviewCopy } from "../merchant-overview-copy";
import { authenticate } from "../shopify.server";
import { StaffAccessClientError } from "../staff-access-client";

export const headers: HeadersFunction = (args) => {
  const result = new Headers(boundary.headers(args));
  result.set("Cache-Control", "private, no-store");
  return result;
};
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

// Legacy form submissions must not invoke service-only/offline catalog sync.
export function action() {
  return json(
    { error: "method_not_allowed" },
    { status: 405, headers: { "Cache-Control": "private, no-store" } },
  );
}

// Preserve managed install/reinstall bootstrap, not merchant authority. A staff
// denial below never retries this step to read data with offline credentials.
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return json(null, { headers: { "Cache-Control": "private, no-store" } });
}

// The document shell contains no store or affiliate data; every merchant data
// read starts with a fresh App Bridge token in the browser.
export default function IndexPage() {
  const shopify = useAppBridge();
  const read = useMemo(
    () => createMerchantOverviewClient(() => shopify.idToken()),
    [shopify],
  );
  const [locale, setLocale] = useState<"en" | "ja" | "vi">("en");
  const copy = merchantOverviewCopy[locale];
  const [data, setData] = useState<ShopifyMerchantOverview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StaffAccessClientError["code"] | null>(
    null,
  );
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error) notice.current?.focus();
  }, [error]);
  const reload = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setData(null);
    try {
      const result = await read();
      if (mounted.current) setData(result);
    } catch (failure) {
      if (mounted.current)
        setError(
          failure instanceof StaffAccessClientError
            ? failure.code
            : "unavailable",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [read]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);
  return (
    <div lang={locale}>
      <Page title={copy.title}>
        <BlockStack gap="400">
          <Select
            label={copy.language}
            value={locale}
            options={[
              { label: "English", value: "en" },
              { label: "日本語", value: "ja" },
              { label: "Tiếng Việt", value: "vi" },
            ]}
            onChange={(value) => {
              if (value === "en" || value === "ja" || value === "vi")
                setLocale(value);
            }}
          />
          <Text as="p">{copy.description}</Text>
          <Link to="/customers">
            {locale === "ja"
              ? "顧客"
              : locale === "vi"
                ? "Khách hàng"
                : "Customers"}
          </Link>
          <Link to="/reviews">
            {locale === "ja"
              ? "レビュー"
              : locale === "vi"
                ? "Đánh giá"
                : "Reviews"}
          </Link>
          <Link to="/loyalty">
            {locale === "ja" ? "ロイヤルティ" : "Loyalty"}
          </Link>
          <Link to="/earning-rules">
            {locale === "ja"
              ? "獲得ルール"
              : locale === "vi"
                ? "Quy tắc tích điểm"
                : "Earning rules"}
          </Link>
          <Link to="/settings">
            {locale === "ja"
              ? "設定"
              : locale === "vi"
                ? "Cài đặt"
                : "Settings"}
          </Link>
          <Link to="/appearance">
            {locale === "ja"
              ? "外観"
              : locale === "vi"
                ? "Giao diện"
                : "Appearance"}
          </Link>
          {error && (
            <div tabIndex={-1} ref={notice}>
              <Banner tone="critical">
                <p>
                  {error === "denied"
                    ? copy.denied
                    : error === "reauthenticate"
                      ? copy.reauthenticate
                      : copy.unavailable}
                </p>
              </Banner>
            </div>
          )}
          <Button disabled={busy} onClick={() => void reload()}>
            {copy.reload}
          </Button>
          {busy && <p role="status">{copy.loading}</p>}
          {data && (
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  {data.shop}
                </Text>
                <Text as="p">
                  {copy.products}:{" "}
                  {data.catalog.products.toLocaleString(locale)}
                </Text>
                <Text as="p">
                  {copy.markets}: {data.catalog.markets.toLocaleString(locale)}
                </Text>
                <Text as="p">
                  {copy.sync}: {copy.status[data.catalog.syncStatus]}
                </Text>
                <Text as="p">
                  {copy.lastSync}:{" "}
                  {data.catalog.lastSyncAt
                    ? new Date(data.catalog.lastSyncAt).toLocaleString(locale)
                    : copy.never}
                </Text>
                {data.canManageStaff && (
                  <Link to="/staff-access">{copy.staff}</Link>
                )}
              </BlockStack>
            </Card>
          )}
          <Text as="p">{copy.separate}</Text>
        </BlockStack>
      </Page>
    </div>
  );
}
