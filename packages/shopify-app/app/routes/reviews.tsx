import {
  json,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { Link, useRouteError } from "@remix-run/react";
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
import enTranslations from "@shopify/polaris/locales/en.json";
import jaTranslations from "@shopify/polaris/locales/ja.json";
import viTranslations from "@shopify/polaris/locales/vi.json";
import { boundary } from "@shopify/shopify-app-remix/server";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  merchantReviewRequestStatusSchema,
  merchantReviewStatusSchema,
  type MerchantReviewListInput,
  type MerchantReviewListPage,
} from "../../../../apps/web/lib/weletic/reviews/merchant-contract";
import type { AuditedReviewModerationInput } from "../../../../apps/web/lib/weletic/reviews/moderation-contract";
import { OpenReviewPolicyPanel } from "../components/OpenReviewPolicyPanel";
import { ReviewCollectionPanel } from "../components/ReviewCollectionPanel";
import { ReviewDeliveryHistory } from "../components/ReviewDeliveryHistory";
import { ReviewIncentivesPanel } from "../components/ReviewIncentivesPanel";
import { ReviewModerationForm } from "../components/ReviewModerationForm";
import { ReviewTranslationsPanel } from "../components/ReviewTranslationsPanel";
import { createMerchantOpenReviewPolicyClient } from "../merchant-open-review-policy-client";
import { createMerchantReviewCollectionClient } from "../merchant-review-collection-client";
import { createMerchantReviewIncentivesClient } from "../merchant-review-incentives-client";
import { createMerchantReviewModerationClient } from "../merchant-review-moderation-client";
import { createMerchantReviewTranslationsClient } from "../merchant-review-translations-client";
import { createMerchantReviewsClient } from "../merchant-reviews-client";
import { merchantReviewsCopy } from "../merchant-reviews-copy";
import { reviewModerationCopy } from "../review-moderation-copy";
import { reviewTranslationCopy } from "../review-translation-copy";
import { authenticate } from "../shopify.server";
import { StaffAccessClientError } from "../staff-access-client";

const polarisTranslations = {
  en: enTranslations,
  ja: jaTranslations,
  vi: viTranslations,
};

export const headers: HeadersFunction = (args) => {
  const result = new Headers(boundary.headers(args));
  result.set("Cache-Control", "private, no-store");
  return result;
};
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return json(null, { headers: { "Cache-Control": "private, no-store" } });
}
export function action() {
  return json(
    { error: "method_not_allowed" },
    { status: 405, headers: { "Cache-Control": "private, no-store" } },
  );
}

export default function ReviewsPage() {
  const shopify = useAppBridge();
  const read = useMemo(
    () => createMerchantReviewsClient(() => shopify.idToken()),
    [shopify],
  );
  const [locale, setLocale] = useState<"en" | "ja" | "vi">("en");
  const openPolicyClient = useMemo(
    () => createMerchantOpenReviewPolicyClient(() => shopify.idToken()),
    [shopify],
  );
  const incentiveClient = useMemo(
    () => createMerchantReviewIncentivesClient(() => shopify.idToken()),
    [shopify],
  );
  const translationClient = useMemo(
    () => createMerchantReviewTranslationsClient(() => shopify.idToken()),
    [shopify],
  );
  const collectionClient = useMemo(
    () => createMerchantReviewCollectionClient(() => shopify.idToken()),
    [shopify],
  );
  const copy = merchantReviewsCopy[locale];
  const moderationCopy = reviewModerationCopy[locale];
  const write = useMemo(
    () => createMerchantReviewModerationClient(() => shopify.idToken()),
    [shopify],
  );
  const [moderationResult, setModerationResult] = useState<
    "saved" | StaffAccessClientError["code"] | null
  >(null);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState<MerchantReviewListInput>({
    view: "reviews",
  });
  const [data, setData] = useState<MerchantReviewListPage | null>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<StaffAccessClientError["code"] | null>(
    null,
  );
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const notice = useRef<HTMLDivElement>(null);
  const dirtyTranslations = useRef(new Set<string>());
  const policyDirtyChanged = useCallback((dirty: boolean) => {
    if (dirty) dirtyTranslations.current.add("open-policy");
    else dirtyTranslations.current.delete("open-policy");
  }, []);
  const discardCopy = useRef(reviewTranslationCopy[locale].discardPage);
  discardCopy.current = reviewTranslationCopy[locale].discardPage;
  const confirmDiscard = useCallback(
    () =>
      dirtyTranslations.current.size === 0 ||
      window.confirm(discardCopy.current),
    [],
  );
  const loseReviewAccess = useCallback(() => {
    setData(null);
    setError("denied");
  }, []);
  useEffect(() => {
    const preventLeaving = (event: BeforeUnloadEvent) => {
      if (inFlight.current || dirtyTranslations.current.size) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", preventLeaving);
    return () => window.removeEventListener("beforeunload", preventLeaving);
  }, []);
  const acquireTranslationOperation = useCallback(() => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setBusy(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    };
  }, []);
  const load = useCallback(
    async (query: MerchantReviewListInput, pageNumber: number) => {
      if (inFlight.current || !confirmDiscard()) return;
      inFlight.current = true;
      setBusy(true);
      setData(null);
      setError(null);
      setModerationResult(null);
      try {
        const result = await read(query);
        if (mounted.current) {
          setData(result);
          setPage(pageNumber);
        }
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
    },
    [read, confirmDiscard],
  );
  const save = async (input: AuditedReviewModerationInput) => {
    // One synchronous guard covers all forms, reads and page navigation.
    if (inFlight.current || !confirmDiscard()) return;
    inFlight.current = true;
    setBusy(true);
    setSaving(true);
    setError(null);
    setModerationResult(null);
    try {
      await write(input);
      if (mounted.current) setModerationResult("saved");
    } catch (failure) {
      if (mounted.current)
        setModerationResult(
          failure instanceof StaffAccessClientError
            ? failure.code
            : "unavailable",
        );
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setData(null);
        setBusy(false);
        setSaving(false);
      }
    }
  };
  useEffect(() => {
    mounted.current = true;
    void load({ view: "reviews" }, 1);
    return () => {
      mounted.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (error || moderationResult) notice.current?.focus();
  }, [error, moderationResult]);
  const changeFilter = (next: MerchantReviewListInput) => {
    if (inFlight.current || !confirmDiscard()) return;
    setFilter(next);
    setData(null);
    setError(null);
    setModerationResult(null);
    setPage(1);
  };
  const statuses =
    filter.view === "reviews"
      ? merchantReviewStatusSchema.options
      : merchantReviewRequestStatusSchema.options;
  return (
    <AppProvider i18n={polarisTranslations[locale]}>
      <div lang={locale}>
        <Page title={copy.title}>
          <BlockStack gap="400">
            <Link
              to="/"
              aria-disabled={busy}
              onClick={(event) => {
                if (inFlight.current || !confirmDiscard())
                  event.preventDefault();
              }}
            >
              {copy.home}
            </Link>
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
            <Card>
              <ReviewIncentivesPanel client={incentiveClient} locale={locale} />
              <ReviewCollectionPanel
                client={collectionClient}
                locale={locale}
              />
            </Card>
            <Card>
              <OpenReviewPolicyPanel
                client={openPolicyClient}
                locale={locale}
                acquireOperation={acquireTranslationOperation}
                onDirtyChange={policyDirtyChanged}
              />
            </Card>
            <Select
              disabled={busy}
              label={copy.view}
              value={filter.view}
              options={[
                { label: copy.reviews, value: "reviews" },
                { label: copy.requests, value: "requests" },
              ]}
              onChange={(view) => {
                if (view === "reviews" || view === "requests")
                  changeFilter({ view });
              }}
            />
            <Select
              disabled={busy}
              label={copy.status}
              value={filter.status ?? ""}
              options={[
                { label: copy.all, value: "" },
                ...statuses.map((status) => ({
                  label: copy.statuses[status],
                  value: status,
                })),
              ]}
              onChange={(value) => {
                if (filter.view === "reviews") {
                  const status = merchantReviewStatusSchema.safeParse(value);
                  if (!value || status.success)
                    changeFilter({
                      ...filter,
                      status: status.success ? status.data : undefined,
                    });
                } else {
                  const status =
                    merchantReviewRequestStatusSchema.safeParse(value);
                  if (!value || status.success)
                    changeFilter({
                      ...filter,
                      status: status.success ? status.data : undefined,
                    });
                }
              }}
            />
            {filter.view === "reviews" && (
              <Select
                disabled={busy}
                label={copy.rating}
                value={filter.rating?.toString() ?? ""}
                options={[
                  { label: copy.all, value: "" },
                  ...[1, 2, 3, 4, 5].map((rating) => ({
                    label: `${rating} / 5`,
                    value: String(rating),
                  })),
                ]}
                onChange={(value) =>
                  changeFilter({
                    ...filter,
                    rating: value ? Number(value) : undefined,
                  })
                }
              />
            )}
            <Button disabled={busy} onClick={() => void load(filter, 1)}>
              {copy.reload}
            </Button>
            {busy && (
              <p role="status">
                {saving ? moderationCopy.saving : copy.loading}
              </p>
            )}
            {moderationResult && (
              <div ref={notice} tabIndex={-1}>
                <p role={moderationResult === "saved" ? "status" : "alert"}>
                  {moderationCopy[moderationResult]}
                </p>
              </div>
            )}
            {error && (
              <div ref={notice} tabIndex={-1}>
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
            {data && (
              <>
                <p>
                  {copy.page} {page}
                </p>
                {!data.items.length && <p>{copy.empty}</p>}
                {data.items.map((row) => (
                  <Card key={row.id}>
                    <BlockStack gap="200">
                      <Text as="h2" variant="headingMd">
                        {row.product.title}
                      </Text>
                      <p>
                        {copy.statuses[row.status]} ·{" "}
                        {new Date(row.createdAt).toLocaleString(locale)}
                      </p>
                      {"rating" in row ? (
                        <>
                          <p>
                            {row.rating} / 5 · {row.displayName}
                          </p>
                          <Text as="h3" variant="headingSm">
                            {row.title}
                          </Text>
                          <p
                            style={{
                              whiteSpace: "pre-wrap",
                              overflowWrap: "anywhere",
                            }}
                          >
                            {row.body}
                          </p>
                          <p>
                            {row.verifiedPurchase
                              ? copy.verified
                              : copy.unverified}
                            {row.incentivized ? ` · ${copy.incentive}` : ""} ·{" "}
                            {copy.photos}: {row.photoCount}
                          </p>
                          {row.merchantReply && (
                            <>
                              <Text as="h3" variant="headingSm">
                                {copy.reply}
                              </Text>
                              <p
                                style={{
                                  whiteSpace: "pre-wrap",
                                  overflowWrap: "anywhere",
                                }}
                              >
                                {row.merchantReply}
                              </p>
                            </>
                          )}
                          {row.status !== "redacted" &&
                            row.version < 2_147_483_647 && (
                              <ReviewModerationForm
                                key={`${row.id}:${row.version}`}
                                review={row}
                                locale={locale}
                                disabled={busy}
                                save={save}
                              />
                            )}
                          {row.status !== "redacted" && (
                            <ReviewTranslationsPanel
                              key={`translations:${row.id}:${row.version}`}
                              reviewId={row.id}
                              client={translationClient}
                              locale={locale}
                              disabled={busy}
                              acquireOperation={acquireTranslationOperation}
                              onDirtyChange={(dirty) => {
                                if (dirty)
                                  dirtyTranslations.current.add(row.id);
                                else dirtyTranslations.current.delete(row.id);
                              }}
                              onAccessLost={loseReviewAccess}
                            />
                          )}
                        </>
                      ) : (
                        <>
                          <p>
                            {copy.scheduled}:{" "}
                            {new Date(row.sendAt).toLocaleString(locale)}
                          </p>
                          <p>
                            {copy.expires}:{" "}
                            {new Date(row.expiresAt).toLocaleString(locale)}
                          </p>
                          <p>
                            {copy.attempts}: {row.deliveryAttempts}
                          </p>
                          {row.hasDeliveryError && <p>{copy.deliveryError}</p>}
                          <ReviewDeliveryHistory
                            history={row.deliveryHistory}
                            locale={locale}
                          />
                        </>
                      )}
                    </BlockStack>
                  </Card>
                ))}
                {data.nextCursor && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void load(
                        { ...filter, cursor: data.nextCursor ?? undefined },
                        page + 1,
                      )
                    }
                  >
                    {copy.next}
                  </Button>
                )}
              </>
            )}
            <Text as="p">{moderationCopy.limit}</Text>
          </BlockStack>
        </Page>
      </div>
    </AppProvider>
  );
}
