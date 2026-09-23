import { useEffect, useId, useRef, useState } from "react";
import {
  storeReviewSettingsPolicySchema,
  type StoreReviewSettingsWriteInput,
} from "../../../../apps/web/lib/weletic/reviews/store-settings-contract";
import type { createMerchantStoreReviewSettingsClient } from "../merchant-store-review-settings-client";
import { storeReviewSettingsCopy } from "../store-review-settings-copy";

type Client = ReturnType<typeof createMerchantStoreReviewSettingsClient>;
type Settings = Awaited<ReturnType<Client["read"]>>;
export function StoreReviewSettingsPanel({
  client,
  locale,
}: {
  client: Client;
  locale: keyof typeof storeReviewSettingsCopy;
}) {
  const copy = storeReviewSettingsCopy[locale];
  const id = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [email, setEmail] = useState(false);
  const [publish, setPublish] = useState(false);
  const [send, setSend] = useState("7");
  const [expiry, setExpiry] = useState("30");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mustReload, setMustReload] = useState(false);
  const [notice, setNotice] = useState<
    "saved" | "unavailable" | "uncertain" | "invalid" | null
  >(null);
  const flight = useRef(false);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    epoch.current++;
    mounted.current = true;
    flight.current = false;
    setSettings(null);
    setNotice(null);
    setConfirmed(false);
    setBusy(false);
    setMustReload(false);
    return () => {
      mounted.current = false;
      epoch.current++;
    };
  }, [client]);
  useEffect(() => {
    if (notice) status.current?.focus();
  }, [notice]);
  const accept = (value: Settings) => {
    setSettings(value);
    setEnabled(value.policy.enabled);
    setEmail(value.policy.requestEmailEnabled);
    setPublish(value.policy.autoPublish);
    setSend(String(value.policy.sendAfterDays));
    setExpiry(String(value.policy.expiresAfterDays));
    setConfirmed(false);
  };
  const load = async () => {
    if (flight.current) return;
    flight.current = true;
    const token = ++epoch.current;
    setBusy(true);
    setSettings(null);
    setNotice(null);
    try {
      const value = await client.read();
      if (mounted.current && epoch.current === token) {
        accept(value);
        setMustReload(false);
      }
    } catch {
      if (mounted.current && epoch.current === token) setNotice("unavailable");
    } finally {
      if (mounted.current && epoch.current === token) {
        flight.current = false;
        setBusy(false);
      }
    }
  };
  const save = async () => {
    if (flight.current || !settings || mustReload || !confirmed) return;
    if (!send.trim() || !expiry.trim()) {
      setNotice("invalid");
      return;
    }
    const parsed = storeReviewSettingsPolicySchema.safeParse({
      enabled,
      requestEmailEnabled: email,
      autoPublish: publish,
      sendAfterDays: Number(send),
      expiresAfterDays: Number(expiry),
    });
    if (!parsed.success || (enabled && !settings.productReviewsEnabled)) {
      setNotice("invalid");
      return;
    }
    const input: StoreReviewSettingsWriteInput = {
      expectedRevision: settings.revision,
      expectedInstallationGeneration: settings.installationGeneration,
      policy: parsed.data,
    };
    flight.current = true;
    const token = ++epoch.current;
    setBusy(true);
    setNotice(null);
    try {
      const value = await client.write(input);
      if (mounted.current && epoch.current === token) {
        accept(value);
        setNotice("saved");
      }
    } catch {
      if (mounted.current && epoch.current === token) {
        setSettings(null);
        setMustReload(true);
        setNotice("uncertain");
      }
    } finally {
      if (mounted.current && epoch.current === token) {
        flight.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section
      aria-label={copy.heading}
      style={{ minWidth: 0, overflowWrap: "anywhere" }}
    >
      <h2>{copy.heading}</h2>
      <p>{copy.description}</p>
      <button type="button" disabled={busy} onClick={() => void load()}>
        {settings ? copy.reload : copy.load}
      </button>
      {busy && <p role="status">{settings ? copy.saving : copy.loading}</p>}
      {notice && (
        <p
          ref={status}
          tabIndex={-1}
          role={notice === "saved" ? "status" : "alert"}
        >
          {copy[notice]}
        </p>
      )}
      {settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {!settings.productReviewsEnabled && <p>{copy.productDisabled}</p>}
          <p>
            <label htmlFor={`${id}-enabled`}>
              <input
                id={`${id}-enabled`}
                type="checkbox"
                checked={enabled}
                disabled={busy || (!settings.productReviewsEnabled && !enabled)}
                onChange={(event) => setEnabled(event.currentTarget.checked)}
              />{" "}
              {copy.enabled}
            </label>
          </p>
          <p>
            <label htmlFor={`${id}-email`}>
              <input
                id={`${id}-email`}
                type="checkbox"
                checked={email}
                disabled={busy}
                onChange={(event) => setEmail(event.currentTarget.checked)}
              />{" "}
              {copy.email}
            </label>
          </p>
          <p>
            <label htmlFor={`${id}-publish`}>
              <input
                id={`${id}-publish`}
                type="checkbox"
                checked={publish}
                disabled={busy}
                onChange={(event) => setPublish(event.currentTarget.checked)}
              />{" "}
              {copy.publish}
            </label>
          </p>
          <p>
            <label htmlFor={`${id}-send`}>
              {copy.send}{" "}
              <input
                id={`${id}-send`}
                type="number"
                min="0"
                max="60"
                value={send}
                disabled={busy}
                onChange={(event) => setSend(event.currentTarget.value)}
              />
            </label>
          </p>
          <p>
            <label htmlFor={`${id}-expiry`}>
              {copy.expiry}{" "}
              <input
                id={`${id}-expiry`}
                type="number"
                min="1"
                max="90"
                value={expiry}
                disabled={busy}
                onChange={(event) => setExpiry(event.currentTarget.value)}
              />
            </label>
          </p>
          <p>
            <label htmlFor={`${id}-confirm`}>
              <input
                id={`${id}-confirm`}
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.currentTarget.checked)}
              />{" "}
              {copy.confirm}
            </label>
          </p>
          <button type="submit" disabled={busy || !confirmed || mustReload}>
            {copy.save}
          </button>
        </form>
      )}
    </section>
  );
}
