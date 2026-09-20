import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { openReviewPolicySchema } from "../../../../apps/web/lib/weletic/reviews/open-policy-contract";
import type { createMerchantOpenReviewPolicyClient } from "../merchant-open-review-policy-client";
import { openReviewPolicyCopy } from "../open-review-policy-copy";
import { StaffAccessClientError } from "../staff-access-client";

type Client = ReturnType<typeof createMerchantOpenReviewPolicyClient>;
type View = Awaited<ReturnType<Client["read"]>>;
const buttonStyle: CSSProperties = {
  minHeight: 44,
  padding: "8px 12px",
  border: "1px solid currentColor",
  borderRadius: 8,
  font: "inherit",
  maxWidth: "100%",
};
const labelStyle: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  minHeight: 44,
  paddingBlock: 8,
};
const checkboxStyle: CSSProperties = {
  flexShrink: 0,
  width: 20,
  height: 20,
  margin: 0,
};
export function OpenReviewPolicyPanel({
  client,
  locale,
  acquireOperation,
  onDirtyChange,
}: {
  client: Client;
  locale: keyof typeof openReviewPolicyCopy;
  acquireOperation?: () => (() => void) | null;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const copy = openReviewPolicyCopy[locale];
  const id = useId();
  const [view, setView] = useState<View | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [photos, setPhotos] = useState(false);
  const [limit, setLimit] = useState("3");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"denied" | "reload" | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const flight = useRef(false);
  const epoch = useRef(0);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    setView(null);
    setError(null);
    setSaved(false);
    setConfirm(false);
    const sequence = epoch;
    return () => {
      mounted.current = false;
      sequence.current++;
    };
  }, [client]);
  const dirty =
    !!view &&
    (enabled !== view.policy.enabled ||
      photos !== view.policy.photoUploadsEnabled ||
      limit !== String(view.policy.maxSubmissionsPer24Hours));
  const policy = openReviewPolicySchema.safeParse({
    enabled,
    photoUploadsEnabled: photos,
    maxSubmissionsPer24Hours: limit.trim() ? Number(limit) : NaN,
  });
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  const run = async (save: boolean) => {
    if (flight.current || (save && (!view || !policy.success || error))) return;
    const release = acquireOperation?.();
    if (acquireOperation && !release) return;
    flight.current = true;
    const token = ++epoch.current;
    setBusy(true);
    setSaved(false);
    setConfirm(false);
    setError(null);
    try {
      let next: View;
      if (save && view && policy.success) {
        const receipt = await client.save({
          expectedInstallationGeneration: view.installationGeneration,
          expectedRevision: view.revision,
          policy: policy.data,
        });
        next = {
          ...view,
          ...receipt,
          requiresReauthorization: false,
          policyEnabledForInstallation: receipt.policy.enabled,
        };
      } else next = await client.read();
      if (!mounted.current || epoch.current !== token) return;
      setView(next);
      setEnabled(next.policy.enabled);
      setPhotos(next.policy.photoUploadsEnabled);
      setLimit(String(next.policy.maxSubmissionsPer24Hours));
      setSaved(save);
    } catch (failure) {
      if (!mounted.current || epoch.current !== token) return;
      setView(null);
      setError(
        failure instanceof StaffAccessClientError &&
          (failure.code === "denied" || failure.code === "reauthenticate")
          ? "denied"
          : "reload",
      );
    } finally {
      release?.();
      flight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      aria-labelledby={id}
      aria-busy={busy}
      style={{ display: "grid", gap: 12, minWidth: 0 }}
    >
      <h2 id={id} style={{ fontSize: 20, fontWeight: 600, lineHeight: 1.4 }}>
        {copy.title}
      </h2>
      <p>{copy.description}</p>
      {error && (
        <p role="alert">{error === "denied" ? copy.denied : copy.error}</p>
      )}
      {saved && <p role="status">{copy.saved}</p>}
      {busy && <p role="status">{copy.busy}</p>}
      <button
        style={buttonStyle}
        type="button"
        disabled={busy}
        onClick={() => (dirty ? setConfirm(true) : void run(false))}
      >
        {view ? copy.reload : copy.load}
      </button>
      {confirm && (
        <div
          role="group"
          aria-label={copy.discard}
          style={{ display: "grid", gap: 8 }}
        >
          <p>{copy.discard}</p>
          <button
            style={buttonStyle}
            type="button"
            disabled={busy}
            onClick={() => void run(false)}
          >
            {copy.confirm}
          </button>
          <button
            style={buttonStyle}
            type="button"
            onClick={() => setConfirm(false)}
          >
            {copy.cancel}
          </button>
        </div>
      )}
      {view && (
        <form
          style={{ display: "grid", gap: 12, minWidth: 0 }}
          onSubmit={(event) => {
            event.preventDefault();
            void run(true);
          }}
        >
          {view.requiresReauthorization && <p role="status">{copy.stale}</p>}
          <fieldset
            disabled={busy || !!error}
            style={{
              display: "grid",
              gap: 12,
              minWidth: 0,
              margin: 0,
              padding: 0,
              border: 0,
            }}
          >
            <legend>{copy.title}</legend>
            <label style={labelStyle}>
              <input
                style={checkboxStyle}
                type="checkbox"
                checked={enabled}
                onChange={(event) => {
                  setEnabled(event.target.checked);
                  setSaved(false);
                }}
              />
              {copy.enabled}
            </label>
            <label style={labelStyle}>
              <input
                style={checkboxStyle}
                type="checkbox"
                checked={photos}
                onChange={(event) => {
                  setPhotos(event.target.checked);
                  setSaved(false);
                }}
              />
              {copy.photos}
            </label>
            <label htmlFor={id + "-limit"}>{copy.limit}</label>
            <input
              style={{
                minHeight: 44,
                width: "100%",
                maxWidth: 128,
                boxSizing: "border-box",
                padding: "8px 12px",
                font: "inherit",
              }}
              id={id + "-limit"}
              type="number"
              min={1}
              max={20}
              step={1}
              value={limit}
              onChange={(event) => {
                setLimit(event.target.value);
                setSaved(false);
              }}
            />
            <button
              style={buttonStyle}
              type="submit"
              disabled={!policy.success || view.revision >= 2147483647}
            >
              {copy.save}
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
