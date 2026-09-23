/** @jsxImportSource preact */
import type {} from "@shopify/ui-extensions/customer-account.page.render";
import { useEffect, useRef, useState } from "preact/hooks";
import { accountReviewLocale } from "./reviews-copy";
import {
  AccountStoreReviewError,
  accountStoreReviewSubmission,
  type AccountStoreInvitation,
  type AccountStoreReviewTransport,
} from "./store-reviews-client";
import { accountStoreReviewCopy } from "./store-reviews-copy";

function fieldValue(event: Event) {
  const field = event.currentTarget;
  return field && "value" in field && typeof field.value === "string"
    ? field.value
    : "";
}
function fieldChecked(event: Event) {
  const field = event.currentTarget;
  return !!field && "checked" in field && field.checked === true;
}

export function CustomerAccountStoreReviews({
  language,
  transport,
  onPendingChange,
}: {
  language: string;
  transport: AccountStoreReviewTransport;
  onPendingChange?: (pending: boolean) => void;
}) {
  const locale = accountReviewLocale(language);
  const copy = accountStoreReviewCopy[locale];
  const [items, setItems] = useState<AccountStoreInvitation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [status, setStatus] = useState<
    | "loading"
    | "ready"
    | "unavailable"
    | "invalid"
    | "submitting"
    | "uncertain"
    | "received"
  >("loading");
  const [loadingMore, setLoadingMore] = useState(false);
  const [rating, setRating] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [consent, setConsent] = useState(false);
  const pending = useRef<ReturnType<
    typeof accountStoreReviewSubmission
  > | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const transportEpoch = useRef(0);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    const epoch = ++transportEpoch.current;
    let current = true;
    pending.current = null;
    busy.current = false;
    onPendingChange?.(false);
    setItems([]);
    setCursor(null);
    setSelectedId(null);
    setRating("");
    setDisplayName("");
    setTitle("");
    setBody("");
    setConsent(false);
    setStatus("loading");
    void transport
      .list()
      .then((page) => {
        if (!current || epoch !== transportEpoch.current) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setStatus("ready");
      })
      .catch(() => {
        if (current && epoch === transportEpoch.current)
          setStatus("unavailable");
      });
    return () => {
      current = false;
      transportEpoch.current++;
    };
  }, [transport, onPendingChange]);

  async function more() {
    if (!cursor || loadingMore || pending.current) return;
    const epoch = transportEpoch.current;
    setLoadingMore(true);
    try {
      const page = await transport.list(cursor);
      if (mounted.current && epoch === transportEpoch.current) {
        setItems((current) => [...current, ...page.items]);
        setCursor(page.nextCursor);
      }
    } catch {
      if (mounted.current && epoch === transportEpoch.current)
        setStatus("unavailable");
    } finally {
      if (mounted.current && epoch === transportEpoch.current)
        setLoadingMore(false);
    }
  }

  async function submit() {
    if (busy.current || status === "received") return;
    const epoch = transportEpoch.current;
    const selected = items.find((item) => item.requestId === selectedId);
    if (!pending.current) {
      if (!selected) return;
      try {
        pending.current = accountStoreReviewSubmission(
          selected,
          {
            rating: Number(rating),
            displayName,
            title,
            body,
            publishConsent: consent,
            locale,
          },
          transport,
        );
        onPendingChange?.(true);
      } catch (error) {
        setStatus(
          error instanceof AccountStoreReviewError &&
            error.code === "invalidInput"
            ? "invalid"
            : "unavailable",
        );
        return;
      }
    }
    busy.current = true;
    setStatus("submitting");
    try {
      await pending.current.send();
      if (mounted.current && epoch === transportEpoch.current) {
        pending.current = null;
        onPendingChange?.(false);
        setStatus("received");
        setRating("");
        setDisplayName("");
        setTitle("");
        setBody("");
        setConsent(false);
        setItems((current) =>
          current.filter((item) => item.requestId !== selectedId),
        );
      }
    } catch {
      if (mounted.current && epoch === transportEpoch.current)
        setStatus("uncertain");
    } finally {
      if (epoch === transportEpoch.current) busy.current = false;
    }
  }

  const selected = items.find((item) => item.requestId === selectedId);
  const locked = pending.current !== null || status === "received";
  return (
    <s-page heading={copy.heading}>
      <s-stack direction="block" gap="base">
        <s-paragraph>{copy.intro}</s-paragraph>
        {status === "loading" && <s-banner>{copy.loading}</s-banner>}
        {status === "unavailable" && (
          <s-banner tone="critical">{copy.unavailable}</s-banner>
        )}
        {status === "received" && (
          <s-banner tone="success">{copy.received}</s-banner>
        )}
        {status === "received" && (items.length > 0 || cursor) && (
          <s-button
            onClick={() => {
              setSelectedId(null);
              setStatus("ready");
            }}
          >
            {copy.continue}
          </s-button>
        )}
        {status === "uncertain" && (
          <s-banner tone="critical">{copy.uncertain}</s-banner>
        )}
        {status === "invalid" && (
          <s-banner tone="critical">{copy.invalid}</s-banner>
        )}
        {status === "ready" && items.length === 0 && (
          <s-banner>{copy.noInvitations}</s-banner>
        )}
        {items.map((item) => (
          <s-stack key={item.requestId} direction="block" gap="small">
            <s-paragraph>
              {copy.order} {item.orderExternalId} · {copy.expires}{" "}
              {new Date(item.expiresAt).toLocaleDateString(locale)}
            </s-paragraph>
            <s-button
              disabled={locked || status === "submitting"}
              onClick={() => {
                setSelectedId(item.requestId);
                setStatus("ready");
              }}
            >
              {copy.choose}
            </s-button>
          </s-stack>
        ))}
        {cursor && status !== "received" && (
          <s-button
            disabled={loadingMore || locked}
            onClick={() => void more()}
          >
            {copy.loadMore}
          </s-button>
        )}
        {selected && status !== "received" && (
          <s-stack direction="block" gap="base">
            <s-paragraph>{copy.privacy}</s-paragraph>
            {selected.incentiveDisclosure ? (
              selected.incentiveDisclosure[locale].map((line, index) => (
                <s-paragraph key={index}>{line}</s-paragraph>
              ))
            ) : (
              <s-paragraph>{copy.noReward}</s-paragraph>
            )}
            <s-paragraph>{copy.media}</s-paragraph>
            <s-select
              label={copy.rating}
              value={rating}
              disabled={locked}
              onChange={(event) => setRating(fieldValue(event))}
            >
              <s-option value="">{copy.ratingChoose}</s-option>
              {[1, 2, 3, 4, 5].map((value) => (
                <s-option key={value} value={String(value)}>
                  {String(value)}
                </s-option>
              ))}
            </s-select>
            <s-text-field
              label={copy.displayName}
              value={displayName}
              maxLength={80}
              disabled={locked}
              onInput={(event) => setDisplayName(fieldValue(event))}
            />
            <s-text-field
              label={copy.title}
              value={title}
              maxLength={120}
              disabled={locked}
              onInput={(event) => setTitle(fieldValue(event))}
            />
            <s-text-area
              label={copy.body}
              value={body}
              maxLength={5000}
              disabled={locked}
              onInput={(event) => setBody(fieldValue(event))}
            />
            <s-checkbox
              label={copy.consent}
              checked={consent}
              disabled={locked}
              onChange={(event) => setConsent(fieldChecked(event))}
            />
            <s-button
              variant="primary"
              disabled={status === "submitting"}
              onClick={() => void submit()}
            >
              {status === "uncertain" ? copy.retry : copy.submit}
            </s-button>
          </s-stack>
        )}
      </s-stack>
    </s-page>
  );
}
