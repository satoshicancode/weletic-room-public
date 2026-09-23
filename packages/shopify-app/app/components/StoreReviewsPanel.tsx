import { BlockStack, Button, Text } from "@shopify/polaris";
import { useEffect, useRef, useState } from "react";
import type { AuditedReviewModerationInput } from "../../../../apps/web/lib/weletic/reviews/moderation-contract";
import type { StoreMerchantListPage } from "../../../../apps/web/lib/weletic/reviews/store-merchant-contract";
import type { createMerchantStoreReviewsClient } from "../merchant-store-reviews-client";
import { StaffAccessClientError } from "../staff-access-client";
import { storeReviewsCopy } from "../store-reviews-copy";
import { ReviewModerationForm } from "./ReviewModerationForm";

type Client = ReturnType<typeof createMerchantStoreReviewsClient>;
export function StoreReviewsPanel({
  client,
  locale,
}: {
  client: Client;
  locale: keyof typeof storeReviewsCopy;
}) {
  const copy = storeReviewsCopy[locale];
  const [page, setPage] = useState<StoreMerchantListPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<
    "saved" | "unavailable" | "denied" | "reauthenticate" | "uncertain" | null
  >(null);
  const [pageNumber, setPageNumber] = useState(1);
  const flight = useRef(false);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const noticeElement = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    epoch.current++;
    mounted.current = true;
    flight.current = false;
    setPage(null);
    setNotice(null);
    setBusy(false);
    setPageNumber(1);
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, [client]);
  useEffect(() => {
    if (notice) noticeElement.current?.focus();
  }, [notice]);
  const load = async (cursor?: string, number = 1) => {
    if (flight.current) return;
    flight.current = true;
    const token = ++epoch.current;
    setBusy(true);
    setPage(null);
    setNotice(null);
    try {
      const result = await client.list({ cursor });
      if (mounted.current && epoch.current === token) {
        setPage(result);
        setPageNumber(number);
      }
    } catch (error) {
      if (mounted.current && epoch.current === token)
        setNotice(
          error instanceof StaffAccessClientError && error.code === "denied"
            ? "denied"
            : error instanceof StaffAccessClientError &&
                error.code === "reauthenticate"
              ? "reauthenticate"
              : "unavailable",
        );
    } finally {
      if (mounted.current && epoch.current === token) {
        flight.current = false;
        setBusy(false);
      }
    }
  };
  const save = async (input: AuditedReviewModerationInput) => {
    if (flight.current) return;
    flight.current = true;
    const token = ++epoch.current;
    setBusy(true);
    setNotice(null);
    try {
      await client.moderate(input);
      if (mounted.current && epoch.current === token) setNotice("saved");
    } catch (error) {
      if (mounted.current && epoch.current === token)
        setNotice(
          error instanceof StaffAccessClientError && error.code === "denied"
            ? "denied"
            : error instanceof StaffAccessClientError &&
                error.code === "reauthenticate"
              ? "reauthenticate"
              : "uncertain",
        );
    } finally {
      if (mounted.current && epoch.current === token) {
        flight.current = false;
        setPage(null);
        setBusy(false);
      }
    }
  };
  return (
    <section
      aria-label={copy.title}
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">
          {copy.title}
        </Text>
        <p>{copy.description}</p>
        <Button disabled={busy} onClick={() => void load()}>
          {copy.reload}
        </Button>
        {busy && <p role="status">{copy.loading}</p>}
        {notice && (
          <p
            ref={noticeElement}
            tabIndex={-1}
            role={notice === "saved" ? "status" : "alert"}
          >
            {copy[notice]}
          </p>
        )}
        {page && (
          <>
            {!page.enabled && <p>{copy.disabled}</p>}
            {!page.items.length && <p>{copy.empty}</p>}
            <ol style={{ paddingInlineStart: 24 }}>
              {page.items.map((review) => (
                <li key={review.id} style={{ marginBlockEnd: 24 }}>
                  <Text as="h3" variant="headingSm">
                    {review.title}
                  </Text>
                  <p>
                    {review.rating} / 5 · {copy.status[review.status]} ·{" "}
                    {new Date(review.createdAt).toLocaleString(locale)}
                  </p>
                  <p>{review.displayName}</p>
                  <p
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {review.body}
                  </p>
                  <p>
                    {review.verifiedPurchase ? copy.verified : copy.unverified}
                    {review.incentivized ? ` · ${copy.incentive}` : ""}
                  </p>
                  {review.merchantReply && (
                    <>
                      <Text as="h4" variant="headingSm">
                        {copy.reply}
                      </Text>
                      <p
                        style={{
                          whiteSpace: "pre-wrap",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {review.merchantReply}
                      </p>
                    </>
                  )}
                  {review.canModerate && (
                    <ReviewModerationForm
                      key={`${review.id}:${review.version}`}
                      review={review}
                      locale={locale}
                      disabled={busy}
                      save={save}
                    />
                  )}
                </li>
              ))}
            </ol>
            {page.nextCursor && (
              <Button
                disabled={busy}
                onClick={() =>
                  void load(page.nextCursor ?? undefined, pageNumber + 1)
                }
              >
                {`${copy.next} ${pageNumber + 1}`}
              </Button>
            )}
          </>
        )}
      </BlockStack>
    </section>
  );
}
