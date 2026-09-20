import { Button } from "@shopify/polaris";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ManualReviewTranslationPage } from "../../../../apps/web/lib/weletic/reviews/translation-contract";
import type { createMerchantReviewTranslationsClient } from "../merchant-review-translations-client";
import { reviewTranslationCopy } from "../review-translation-copy";
import { StaffAccessClientError } from "../staff-access-client";
import { ReviewTranslationForm } from "./ReviewTranslationForm";

type Client = ReturnType<typeof createMerchantReviewTranslationsClient>;

/** No background polling or automatic refresh: only explicit reads may replace
 * editor drafts. Caller replaces client identity when authentication changes.
 */
export function ReviewTranslationsPanel({
  reviewId,
  client,
  locale,
  disabled = false,
  acquireOperation,
  onDirtyChange,
  onAccessLost,
}: {
  reviewId: string;
  client: Client;
  locale: keyof typeof reviewTranslationCopy;
  disabled?: boolean;
  acquireOperation?: () => (() => void) | null;
  onDirtyChange?: (dirty: boolean) => void;
  onAccessLost?: () => void;
}) {
  const copy = reviewTranslationCopy[locale];
  const sequence = useRef(0);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"accessChanged" | "loadFailed" | null>(
    null,
  );
  const [snapshot, setSnapshot] = useState<{
    client: Client;
    reviewId: string;
    page: ManualReviewTranslationPage;
    key: string;
  } | null>(null);
  const current =
    snapshot?.client === client && snapshot.reviewId === reviewId
      ? snapshot
      : null;
  const invalidateOperations = useCallback(() => {
    sequence.current++;
    pending.current = false;
  }, []);
  useEffect(() => {
    invalidateOperations();
    setBusy(false);
    setSnapshot(null);
    setError(null);
    return invalidateOperations;
  }, [client, reviewId, invalidateOperations]);
  const handleError = (reason: unknown) => {
    if (
      reason instanceof StaffAccessClientError &&
      ["denied", "reauthenticate"].includes(reason.code)
    ) {
      setSnapshot(null);
      setError("accessChanged");
      onAccessLost?.();
    } else setError("loadFailed");
  };
  const reload = async () => {
    if (disabled || pending.current)
      throw new StaffAccessClientError("unavailable");
    const release = acquireOperation?.();
    if (acquireOperation && !release)
      throw new StaffAccessClientError("unavailable");
    pending.current = true;
    setBusy(true);
    setError(null);
    const operation = ++sequence.current;
    try {
      const page = await client.read({ reviewId });
      if (operation !== sequence.current)
        throw new StaffAccessClientError("unavailable");
      setSnapshot({ client, reviewId, page, key: String(operation) });
    } catch (reason) {
      if (operation === sequence.current) handleError(reason);
      throw reason;
    } finally {
      release?.();
      if (operation === sequence.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section aria-label={copy.heading}>
      {busy && <p role="status">{copy.loading}</p>}
      {error && <p role="alert">{copy[error]}</p>}
      {current ? (
        <ReviewTranslationForm
          page={current.page}
          locale={locale}
          snapshotKey={current.key}
          disabled={busy || disabled}
          onDirtyChange={onDirtyChange}
          reload={reload}
          save={async (input) => {
            if (disabled || pending.current)
              throw new StaffAccessClientError("unavailable");
            const release = acquireOperation?.();
            if (acquireOperation && !release)
              throw new StaffAccessClientError("unavailable");
            pending.current = true;
            const operation = ++sequence.current;
            try {
              await client.save(input);
            } catch (reason) {
              if (
                operation === sequence.current &&
                reason instanceof StaffAccessClientError &&
                ["denied", "reauthenticate"].includes(reason.code)
              )
                handleError(reason);
              throw reason;
            } finally {
              release?.();
              if (operation === sequence.current) pending.current = false;
            }
          }}
        />
      ) : (
        <Button
          disabled={busy || disabled}
          onClick={() => {
            void reload().catch(() => undefined);
          }}
        >
          {copy.load}
        </Button>
      )}
    </section>
  );
}
