/** @jsxImportSource preact */
import type {} from "@shopify/ui-extensions/customer-account.page.render";
import { useEffect, useRef, useState } from "preact/hooks";
import { ReviewProductPicker } from "./ReviewProductPicker";
import {
  AccountReviewError,
  accountReviewSubmission,
  prepareAccountReview,
  type AccountReviewPolicy,
  type ReviewTransport,
} from "./reviews-client";
import { accountReviewCopy, accountReviewLocale } from "./reviews-copy";
import type { ReviewProductQuery } from "./reviews-products";

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

/** Reviews do not load a Loyalty summary or enroll the shopper. */
export function CustomerAccountReviews({
  productId,
  language,
  transport,
  onPendingChange,
  queryProducts,
}: {
  productId: string | null;
  language: string;
  transport: ReviewTransport;
  onPendingChange?: (pending: boolean) => void;
  queryProducts?: ReviewProductQuery;
}) {
  const locale = accountReviewLocale(language);
  const copy = accountReviewCopy[locale];
  const [policy, setPolicy] = useState<AccountReviewPolicy | null>(null);
  const [status, setStatus] = useState<
    | "checking"
    | "ready"
    | "submitting"
    | "received"
    | "unavailable"
    | "invalidInput"
    | "uncertain"
  >("checking");
  const [rating, setRating] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [consent, setConsent] = useState(false);
  const [acceptedProduct, setAcceptedProduct] = useState<string | null>(null);
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  const pending = useRef<ReturnType<typeof accountReviewSubmission> | null>(
    null,
  );
  const busy = useRef(false);
  const currentProduct = useRef(productId);
  currentProduct.current = productId;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  useEffect(() => {
    let current = true;
    // Never replace an unresolved operation with the newly navigated product.
    if (pending.current) return;
    setPolicy(null);
    if (acceptedProduct === productId && acceptedProduct !== null) {
      setStatus("received");
      return;
    }
    setRating("");
    setDisplayName("");
    setTitle("");
    setBody("");
    setConsent(false);
    setStatus("checking");
    if (productId)
      void prepareAccountReview(productId, transport)
        .then((result) => {
          if (current) {
            setPolicy(result);
            setStatus("ready");
          }
        })
        .catch(() => {
          if (current) setStatus("unavailable");
        });
    return () => {
      current = false;
    };
  }, [productId, transport, acceptedProduct, recoveryRevision]);

  async function submit() {
    if (busy.current || status === "received") return;
    if (!pending.current) {
      if (!policy || policy.productId !== productId) return;
      try {
        pending.current = accountReviewSubmission(
          policy,
          {
            rating: Number(rating),
            displayName,
            title,
            body,
            publishConsent: consent,
            locale,
          },
          [],
          transport,
        );
        onPendingChange?.(true);
      } catch (error) {
        setStatus(
          error instanceof AccountReviewError && error.code === "invalidInput"
            ? "invalidInput"
            : "unavailable",
        );
        return;
      }
    }
    busy.current = true;
    setStatus("submitting");
    try {
      await pending.current.send();
      if (mounted.current) {
        setStatus("received");
        setDisplayName("");
        setTitle("");
        setBody("");
        setPolicy(null);
        pending.current = null;
        setAcceptedProduct(policy!.productId);
        onPendingChange?.(false);
      }
    } catch (error) {
      if (mounted.current) {
        if (
          error instanceof AccountReviewError &&
          error.code === "invalidInput"
        ) {
          pending.current = null;
          onPendingChange?.(false);
          setStatus("invalidInput");
          if (policy?.productId !== currentProduct.current)
            setRecoveryRevision((value) => value + 1);
        } else setStatus("uncertain");
      }
    } finally {
      busy.current = false;
    }
  }
  const locked = pending.current !== null || status === "received";
  return (
    <s-page heading={copy.heading}>
      <s-stack direction="block" gap="base">
        <s-paragraph>{copy.disclosure}</s-paragraph>
        {acceptedProduct && acceptedProduct !== productId && (
          <s-banner tone="success">{copy.previousReceived}</s-banner>
        )}
        {!productId && !pending.current ? (
          queryProducts ? (
            <ReviewProductPicker
              language={language}
              queryProducts={queryProducts}
            />
          ) : (
            <s-banner>{copy.selectProduct}</s-banner>
          )
        ) : (
          <>
            {status !== "ready" && (
              <s-banner
                tone={
                  status === "received"
                    ? "success"
                    : status === "invalidInput" ||
                        status === "unavailable" ||
                        status === "uncertain"
                      ? "critical"
                      : "info"
                }
              >
                {copy[status]}
              </s-banner>
            )}
            {policy && status !== "received" && (
              <>
                <s-heading>{policy.productTitle}</s-heading>
                <s-paragraph>{copy.privacy}</s-paragraph>
                <s-select
                  label={copy.rating}
                  value={rating}
                  disabled={locked}
                  onChange={(event) => setRating(fieldValue(event))}
                >
                  <s-option value="">{copy.choose}</s-option>
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
                  maxLength={10000}
                  disabled={locked}
                  onInput={(event) => setBody(fieldValue(event))}
                />
                {policy.photoUploadsAvailable && (
                  <s-paragraph>{copy.photosPending}</s-paragraph>
                )}
                <s-checkbox
                  label={copy.consent}
                  checked={consent}
                  disabled={locked}
                  onChange={(event) => setConsent(fieldChecked(event))}
                />
                <s-button
                  variant="primary"
                  disabled={status === "submitting"}
                  onClick={() => {
                    void submit();
                  }}
                >
                  {status === "uncertain" ? copy.retry : copy.submit}
                </s-button>
              </>
            )}
          </>
        )}
      </s-stack>
    </s-page>
  );
}
