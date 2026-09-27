import { useEffect, useId, useRef, useState } from "react";
import { useCoreLaunch } from "../../../../apps/web/ui/weletic/core-launch-context";
import type { createMerchantReviewIncentivesClient } from "../merchant-review-incentives-client";
import { reviewIncentiveEditorCopy } from "../review-incentive-editor-copy";
import { ReviewIncentiveActivation } from "./ReviewIncentiveActivation";
import { ReviewIncentiveEditor } from "./ReviewIncentiveEditor";

type Client = ReturnType<typeof createMerchantReviewIncentivesClient>;
export function ReviewIncentivesPanel({
  client,
  locale,
}: {
  client: Client;
  locale: keyof typeof reviewIncentiveEditorCopy;
}) {
  const copy = reviewIncentiveEditorCopy[locale];
  const coreLaunch = useCoreLaunch();
  const [policy, setPolicy] = useState<Awaited<
    ReturnType<Client["read"]>
  > | null>(null);
  const [choices, setChoices] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [next, setNext] = useState<string | null>(null);
  const [visibleCouponIds, setVisibleCouponIds] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [focusEditor, setFocusEditor] = useState(false);
  const request = useRef(0);
  const flight = useRef(false);
  const mounted = useRef(false);
  const id = useId();
  useEffect(() => {
    const lifecycleRequest = request;
    mounted.current = true;
    return () => {
      mounted.current = false;
      lifecycleRequest.current++;
    };
  }, []);
  // Deliberate explicit load: rendering an inbox never consumes configuration
  // permission or silently discards a merchant's draft on background refresh.
  const load = async () => {
    if (flight.current) return;
    flight.current = true;
    const token = ++request.current;
    setBusy(true);
    setError(false);
    setPolicy(null);
    setConfirming(false);
    setFocusEditor(false);
    try {
      const [fresh, page] = await Promise.all([
        client.read(),
        coreLaunch
          ? Promise.resolve({ items: [], nextCursor: null })
          : client.coupons({}),
      ]);
      if (!mounted.current || request.current !== token) return;
      setPolicy(fresh);
      setChoices(page.items);
      setVisibleCouponIds(page.items.map((item) => item.id));
      setNext(page.nextCursor);
      setQuery("");
      setApplied("");
      setEmpty(!page.items.length);
      setEpoch((value) => value + 1);
    } catch {
      if (mounted.current && request.current === token) setError(true);
    } finally {
      flight.current = false;
      if (mounted.current && request.current === token) setBusy(false);
    }
  };
  const browse = async (more: boolean) => {
    if (coreLaunch || flight.current || !policy || (more && !next)) return;
    flight.current = true;
    const token = ++request.current;
    setBusy(true);
    setError(false);
    const search = more ? applied : query.trim();
    try {
      const page = await client.coupons({
        query: search,
        ...(more && next ? { cursor: next } : {}),
      });
      if (!mounted.current || request.current !== token) return;
      // Keep already selected/visited choices when browsing; the save service
      // still rejects coupons subsequently changed or removed from the catalog.
      setChoices((previous) => [
        ...new Map(
          [...previous, ...page.items].map((item) => [item.id, item]),
        ).values(),
      ]);
      setNext(page.nextCursor);
      setApplied(search);
      setVisibleCouponIds(page.items.map((item) => item.id));
      setEmpty(!page.items.length);
    } catch {
      if (mounted.current && request.current === token) setError(true);
    } finally {
      flight.current = false;
      if (mounted.current && request.current === token) setBusy(false);
    }
  };
  return (
    <section style={{ minWidth: 0 }}>
      <p role="status">{busy ? copy.loading : error ? copy.loadFailed : ""}</p>
      {!policy && (
        <button type="button" disabled={busy} onClick={() => void load()}>
          {copy.load}
        </button>
      )}
      {policy && confirming && (
        <ReviewIncentiveActivation
          key={`${epoch}:${policy.installationGeneration}:${policy.revision}`}
          policy={policy}
          locale={locale}
          activate={client.activate}
          cancel={() => {
            setConfirming(false);
            setFocusEditor(true);
          }}
          reload={() => void load()}
        />
      )}
      {policy && !confirming && (
        <>
          <h2>{copy.active}</h2>
          {policy.activePolicy ? (
            policy.activePolicy.disclosure?.[locale].map((text, index) => (
              <p key={index}>{text}</p>
            )) ?? <p>{copy.unavailable}</p>
          ) : (
            <p>{copy.legacy}</p>
          )}
          {!coreLaunch && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void browse(false);
              }}
              style={{ display: "grid", gap: 8, minWidth: 0 }}
            >
              <label htmlFor={`${id}-search`}>{copy.search}</label>
              <input
                id={`${id}-search`}
                value={query}
                maxLength={100}
                onChange={(event) => setQuery(event.target.value)}
                disabled={busy}
                style={{ width: "100%", minWidth: 0, boxSizing: "border-box" }}
              />
              <button type="submit" disabled={busy}>
                {copy.find}
              </button>
              {next && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void browse(true)}
                >
                  {copy.more}
                </button>
              )}
              {empty && <p>{copy.empty}</p>}
            </form>
          )}
          <ReviewIncentiveEditor
            key={`${epoch}:${policy.installationGeneration}:${policy.revision}`}
            policy={policy}
            coupons={choices}
            visibleCouponIds={visibleCouponIds}
            locale={locale}
            save={client.draft}
            reload={() => void load()}
            reviewActivation={() => {
              if (!flight.current) setConfirming(true);
            }}
            focusHeading={focusEditor}
          />
        </>
      )}
    </section>
  );
}
