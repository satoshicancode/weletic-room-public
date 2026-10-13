import {
  json,
  type HeadersFunction,
  type LoaderFunctionArgs,
} from "@remix-run/node";
import { Link, useRouteError } from "@remix-run/react";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
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
import {
  merchantReviewRequestStatusSchema,
  merchantReviewStatusSchema,
  type MerchantReviewListInput,
  type MerchantReviewListPage,
} from "@weletic/contracts/reviews/merchant-contract";
import type { AuditedReviewModerationInput } from "@weletic/contracts/reviews/moderation-contract";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCoreLaunch } from "~/core-launch-context";
import { OpenReviewPolicyPanel } from "../components/OpenReviewPolicyPanel";
import { ReviewCollectionPanel } from "../components/ReviewCollectionPanel";
import { ReviewDeliveryHistory } from "../components/ReviewDeliveryHistory";
import { ReviewIncentivesPanel } from "../components/ReviewIncentivesPanel";
import { ReviewModerationForm } from "../components/ReviewModerationForm";
import { ReviewTranslationsPanel } from "../components/ReviewTranslationsPanel";
import { StoreReviewSettingsPanel } from "../components/StoreReviewSettingsPanel";
import { StoreReviewsPanel } from "../components/StoreReviewsPanel";
import { useMerchantLocale } from "../merchant-locale";
import { createMerchantOpenReviewPolicyClient } from "../merchant-open-review-policy-client";
import { createMerchantReviewCollectionClient } from "../merchant-review-collection-client";
import { createMerchantReviewCreateClient } from "../merchant-review-create-client";
import { createMerchantReviewIncentivesClient } from "../merchant-review-incentives-client";
import { createMerchantReviewMediaClient } from "../merchant-review-media-client";
import { createMerchantReviewModerationClient } from "../merchant-review-moderation-client";
import { createMerchantReviewTranslationsClient } from "../merchant-review-translations-client";
import { createMerchantReviewsClient } from "../merchant-reviews-client";
import { merchantReviewsCopy } from "../merchant-reviews-copy";
import { createMerchantStoreReviewSettingsClient } from "../merchant-store-review-settings-client";
import { createMerchantStoreReviewsClient } from "../merchant-store-reviews-client";
import { reviewModerationCopy } from "../review-moderation-copy";
import { reviewTranslationCopy } from "../review-translation-copy";
import { authenticate } from "../shopify.server";
import { StaffAccessClientError } from "../staff-access-client";

const polarisTranslations = {
  en: enTranslations,
  ja: jaTranslations,
  vi: viTranslations,
};

function ReviewMediaPreview({
  media,
  load,
}: {
  media: { id: string; kind: "photo" | "video" };
  load: (id: string) => Promise<{ url: string; kind: "photo" | "video" }>;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (url)
    return media.kind === "video" ? (
      <video
        controls
        playsInline
        preload="metadata"
        src={url}
        style={{ maxWidth: 320 }}
      />
    ) : (
      <img
        src={url}
        alt="Review attachment"
        referrerPolicy="no-referrer"
        style={{ width: 120, height: 120, objectFit: "cover" }}
      />
    );
  return (
    <Button
      disabled={busy || failed}
      onClick={async () => {
        setBusy(true);
        try {
          const result = await load(media.id);
          setUrl(result.url);
        } catch {
          setFailed(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      {failed
        ? "Media unavailable"
        : busy
          ? "Loading…"
          : media.kind === "video"
            ? "Play video"
            : "View photo"}
    </Button>
  );
}

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
  const coreLaunch = useCoreLaunch();
  const shopify = useAppBridge();
  const read = useMemo(
    () => createMerchantReviewsClient(() => shopify.idToken()),
    [shopify],
  );
  const [locale, setLocale] = useMerchantLocale();
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
  const storeReviewsClient = useMemo(
    () => createMerchantStoreReviewsClient(() => shopify.idToken()),
    [shopify],
  );
  const storeReviewSettingsClient = useMemo(
    () => createMerchantStoreReviewSettingsClient(() => shopify.idToken()),
    [shopify],
  );
  const copy = merchantReviewsCopy[locale];
  const moderationCopy = reviewModerationCopy[locale];
  const write = useMemo(
    () => createMerchantReviewModerationClient(() => shopify.idToken()),
    [shopify],
  );
  const createReview = useMemo(
    () => createMerchantReviewCreateClient(() => shopify.idToken()),
    [shopify],
  );
  const readMedia = useMemo(
    () => createMerchantReviewMediaClient(() => shopify.idToken()),
    [shopify],
  );
  const [draftReview, setDraftReview] = useState({
    productId: "",
    displayName: "Store owner",
    rating: "5",
    title: "",
    body: "",
    publishNow: true,
  });
  const [creatingReview, setCreatingReview] = useState(false);
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
      if (mounted.current) {
        setModerationResult("saved");
        shopify.toast?.show?.(moderationCopy.saved);
      }
    } catch (failure) {
      const code =
        failure instanceof StaffAccessClientError
          ? failure.code
          : "unavailable";
      if (mounted.current) {
        setModerationResult(code);
        shopify.toast?.show?.(moderationCopy[code], { isError: true });
      }
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
          <TitleBar title={copy.title} />
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
            {!coreLaunch && (
              <>
                <Card>
                  <OpenReviewPolicyPanel
                    client={openPolicyClient}
                    locale={locale}
                    acquireOperation={acquireTranslationOperation}
                    onDirtyChange={policyDirtyChanged}
                  />
                </Card>
                <Card>
                  <StoreReviewSettingsPanel
                    client={storeReviewSettingsClient}
                    locale={locale}
                  />
                </Card>
                <Card>
                  <StoreReviewsPanel
                    client={storeReviewsClient}
                    locale={locale}
                  />
                </Card>
              </>
            )}
            <Card>
              {!creatingReview ? (
                <Button onClick={() => setCreatingReview(true)}>
                  {copy.createReview}
                </Button>
              ) : (
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (inFlight.current) return;
                    inFlight.current = true;
                    setBusy(true);
                    setError(null);
                    try {
                      const rawProductId = draftReview.productId.trim();
                      await createReview({
                        productId: rawProductId.startsWith("gid://")
                          ? rawProductId
                          : `gid://shopify/Product/${rawProductId}`,
                        displayName: draftReview.displayName,
                        rating: Number(draftReview.rating),
                        title: draftReview.title,
                        body: draftReview.body,
                        status: draftReview.publishNow
                          ? "published"
                          : "pending",
                      });
                      setDraftReview((current) => ({
                        ...current,
                        title: "",
                        body: "",
                      }));
                      setCreatingReview(false);
                      inFlight.current = false;
                      await load({ view: "reviews" }, 1);
                    } catch (failure) {
                      setError(
                        failure instanceof StaffAccessClientError
                          ? failure.code
                          : "unavailable",
                      );
                    } finally {
                      inFlight.current = false;
                      setBusy(false);
                    }
                  }}
                >
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingMd">
                      {copy.createReview}
                    </Text>
                    <label>
                      {copy.productId}
                      <select
                        required
                        value={draftReview.productId}
                        onChange={(event) =>
                          setDraftReview({
                            ...draftReview,
                            productId: event.target.value,
                          })
                        }
                      >
                        <option value="">—</option>
                        {data?.products?.map((product) => (
                          <option
                            key={product.externalId}
                            value={product.externalId}
                          >
                            {product.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {copy.displayName}
                      <input
                        required
                        maxLength={80}
                        value={draftReview.displayName}
                        onChange={(event) =>
                          setDraftReview({
                            ...draftReview,
                            displayName: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      {copy.rating}
                      <select
                        value={draftReview.rating}
                        onChange={(event) =>
                          setDraftReview({
                            ...draftReview,
                            rating: event.target.value,
                          })
                        }
                      >
                        {[5, 4, 3, 2, 1].map((rating) => (
                          <option key={rating} value={rating}>
                            {rating} / 5
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {copy.reviewTitle}
                      <input
                        required
                        maxLength={120}
                        value={draftReview.title}
                        onChange={(event) =>
                          setDraftReview({
                            ...draftReview,
                            title: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      {copy.reviewBody}
                      <textarea
                        required
                        minLength={20}
                        maxLength={10000}
                        value={draftReview.body}
                        onChange={(event) =>
                          setDraftReview({
                            ...draftReview,
                            body: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={draftReview.publishNow}
                        onChange={(event) =>
                          setDraftReview({
                            ...draftReview,
                            publishNow: event.target.checked,
                          })
                        }
                      />{" "}
                      {copy.publishNow}
                    </label>
                    <Button submit disabled={busy}>
                      {copy.create}
                    </Button>
                  </BlockStack>
                </form>
              )}
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
                            {row.source === "merchant"
                              ? copy.merchantAuthored
                              : row.verifiedPurchase
                                ? copy.verified
                                : copy.unverified}
                            {row.incentivized ? ` · ${copy.incentive}` : ""} ·{" "}
                            {copy.photos}: {row.photoCount} · {copy.videos}:{" "}
                            {row.videoCount ?? 0}
                          </p>
                          {Boolean(row.media?.length) && (
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                gap: 12,
                              }}
                            >
                              {row.media?.map((media) => (
                                <ReviewMediaPreview
                                  key={media.id}
                                  media={media}
                                  load={readMedia}
                                />
                              ))}
                            </div>
                          )}
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
                          {!coreLaunch && row.status !== "redacted" && (
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
