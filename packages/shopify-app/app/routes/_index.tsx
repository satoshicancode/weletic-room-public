import {
  json,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { Link, useLocation, useRouteError } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import {
  AppProvider,
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
import {
  installationAdmissionStatusSchema,
  type InstallationAdmissionStatus,
} from "../../../../apps/web/lib/weletic/shopify/installation-admission-contract";
import type { ShopifyMerchantOverview } from "../../../../apps/web/lib/weletic/shopify/staff-contract";
import { installationBootstrapError } from "../installation-bootstrap-error";
import { createInstallationStatusClient } from "../installation-status-client";
import { installationStatusCopy } from "../installation-status-copy";
import { createMerchantOverviewClient } from "../merchant-overview-client";
import { merchantOverviewCopy } from "../merchant-overview-copy";
import { merchantPolarisTranslations } from "../merchant-polaris-translations";
import { authenticate } from "../shopify.server";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "../staff-access-client";

export const headers: HeadersFunction = (args) => {
  const result = new Headers(boundary.headers(args));
  result.set("Cache-Control", "private, no-store");
  return result;
};
export function ErrorBoundary() {
  const location = useLocation();
  const error = installationBootstrapError(useRouteError());
  return (
    <>
      {error}
      <p>
        <Link to={{ pathname: "/installation", search: location.search }}>
          Installation status / インストール状況 / Trạng thái cài đặt
        </Link>
      </p>
    </>
  );
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
  const readStatus = useMemo(
    () => createInstallationStatusClient(() => shopify.idToken()),
    [shopify],
  );
  const [admission, setAdmission] =
    useState<InstallationAdmissionStatus | null>(null);
  const postReconnect = useMemo(
    () => createMerchantJsonPost(() => shopify.idToken()),
    [shopify],
  );
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
    setAdmission(null);
    try {
      const status = await readStatus();
      if (!mounted.current) return;
      setAdmission(status);
      if (status.status !== "active") return;
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
  }, [read, readStatus]);
  const reconnect = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setData(null);
    try {
      const status = installationAdmissionStatusSchema.parse(
        await postReconnect("/api/installation/reconnect", {}),
      );
      if (mounted.current) setAdmission(status);
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
  }, [postReconnect]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => {
      mounted.current = false;
    };
  }, [reload]);
  const content = (
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
          {admission && (
            <div role="status" aria-live="polite">
              <Banner
                title={installationStatusCopy[locale].title}
                tone={admission.status === "active" ? "success" : "info"}
              >
                <p>{installationStatusCopy[locale][admission.status]}</p>
              </Banner>
            </div>
          )}
          {admission?.status === "reauthenticate" && (
            <Button onClick={() => void reconnect()} disabled={busy}>
              {locale === "ja"
                ? "再認証する"
                : locale === "vi"
                  ? "Xác thực lại"
                  : "Reconnect installation"}
            </Button>
          )}
          {admission?.status === "active" && (
            <>
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
            </>
          )}
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
  return (
    <AppProvider i18n={merchantPolarisTranslations[locale]}>
      {content}
    </AppProvider>
  );
}
