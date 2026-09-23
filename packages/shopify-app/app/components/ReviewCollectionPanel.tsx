import { useEffect, useId, useRef, useState } from "react";
import { reviewCollectionPolicySchema } from "../../../../apps/web/lib/weletic/reviews/collection-contract";
import type { createMerchantReviewCollectionClient } from "../merchant-review-collection-client";
import { reviewCollectionCopy } from "../review-collection-copy";
import { StaffAccessClientError } from "../staff-access-client";

type Client = ReturnType<typeof createMerchantReviewCollectionClient>;
type Settings = Awaited<ReturnType<Client["read"]>>;
export function ReviewCollectionPanel({
  client,
  locale,
}: {
  client: Client;
  locale: keyof typeof reviewCollectionCopy;
}) {
  const copy = reviewCollectionCopy[locale];
  const id = useId();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [send, setSend] = useState("");
  const [expiry, setExpiry] = useState("");
  const [reminders, setReminders] = useState("");
  const [email, setEmail] = useState(false);
  const [photos, setPhotos] = useState(false);
  const [publish, setPublish] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<"loading" | "saving" | null>(null);
  const [notice, setNotice] = useState<
    "saved" | "failed" | "denied" | "invalid" | null
  >(null);
  const [mustReload, setMustReload] = useState(false);
  const flight = useRef(false);
  const epoch = useRef(0);
  const mounted = useRef(false);
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const generation = epoch;
    generation.current++;
    mounted.current = true;
    flight.current = false;
    setSettings(null);
    setConfirmed(false);
    setNotice(null);
    setBusy(null);
    setMustReload(false);
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, [client]);
  useEffect(() => {
    if (notice) status.current?.focus();
  }, [notice]);
  const accept = (fresh: Settings) => {
    setSettings(fresh);
    setSend(String(fresh.policy.sendAfterDays));
    setExpiry(String(fresh.policy.expiresAfterDays));
    setReminders(fresh.policy.reminderAfterDays.join(", "));
    setEmail(fresh.policy.requestEmailEnabled);
    setPhotos(fresh.policy.photoUploadsEnabled);
    setPublish(fresh.policy.autoPublish);
    setConfirmed(false);
  };
  const load = async () => {
    if (flight.current) return;
    flight.current = true;
    const token = ++epoch.current;
    setBusy("loading");
    setNotice(null);
    setSettings(null);
    setConfirmed(false);
    try {
      const fresh = await client.read();
      if (mounted.current && epoch.current === token) {
        accept(fresh);
        setMustReload(false);
      }
    } catch (error) {
      if (mounted.current && epoch.current === token)
        setNotice(
          error instanceof StaffAccessClientError && error.code === "denied"
            ? "denied"
            : "failed",
        );
    } finally {
      if (mounted.current && epoch.current === token) {
        flight.current = false;
        setBusy(null);
      }
    }
  };
  const save = async () => {
    if (flight.current || !settings || !confirmed || mustReload) return;
    const days = reminders.trim()
      ? reminders.split(",").map((value) => value.trim())
      : [];
    if (![send, expiry, ...days].every((value) => /^\d+$/.test(value))) {
      setNotice("invalid");
      return;
    }
    const parsed = reviewCollectionPolicySchema.safeParse({
      sendAfterDays: Number(send),
      expiresAfterDays: Number(expiry),
      reminderAfterDays: days.map(Number),
      requestEmailEnabled: email,
      photoUploadsEnabled: photos,
      autoPublish: publish,
    });
    if (!parsed.success) {
      setNotice("invalid");
      return;
    }
    flight.current = true;
    const token = ++epoch.current;
    setBusy("saving");
    setNotice(null);
    try {
      const fresh = await client.write({
        expectedRevision: settings.revision,
        expectedInstallationGeneration: settings.installationGeneration,
        policy: parsed.data,
      });
      if (mounted.current && epoch.current === token) {
        accept(fresh);
        setNotice("saved");
      }
    } catch (error) {
      if (mounted.current && epoch.current === token) {
        setMustReload(true);
        setConfirmed(false);
        setNotice(
          error instanceof StaffAccessClientError && error.code === "denied"
            ? "denied"
            : "failed",
        );
      }
    } finally {
      if (mounted.current && epoch.current === token) {
        flight.current = false;
        setBusy(null);
      }
    }
  };
  const changed = () => {
    setConfirmed(false);
    setNotice(null);
  };
  return (
    <section aria-labelledby={`${id}-title`} style={{ minWidth: 0 }}>
      <h2 id={`${id}-title`}>{copy.title}</h2>
      <p role="status" tabIndex={-1} ref={status}>
        {busy ? copy[busy] : notice ? copy[notice] : ""}
      </p>
      <button type="button" disabled={!!busy} onClick={() => void load()}>
        {settings ? copy.reload : copy.load}
      </button>
      {settings && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p>{copy.timing}</p>
          {!settings.moduleEnabled && <p>{copy.disabled}</p>}
          <fieldset
            disabled={!!busy || mustReload}
            style={{
              display: "grid",
              gap: 12,
              minWidth: 0,
              border: 0,
              padding: 0,
            }}
          >
            <legend>{copy.title}</legend>
            {(
              [
                ["send", copy.send, send, setSend, 0, 60],
                ["expiry", copy.expiry, expiry, setExpiry, 1, 90],
              ] as const
            ).map(([key, label, value, update, min, max]) => (
              <label key={key} htmlFor={`${id}-${key}`}>
                {label}
                <input
                  id={`${id}-${key}`}
                  type="number"
                  min={min}
                  max={max}
                  step={1}
                  required
                  value={value}
                  onChange={(event) => {
                    update(event.target.value);
                    changed();
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    boxSizing: "border-box",
                  }}
                />
              </label>
            ))}
            <label htmlFor={`${id}-reminders`}>
              {copy.reminders}
              <input
                id={`${id}-reminders`}
                value={reminders}
                maxLength={24}
                aria-describedby={`${id}-note`}
                onChange={(event) => {
                  setReminders(event.target.value);
                  changed();
                }}
                style={{
                  display: "block",
                  width: "100%",
                  boxSizing: "border-box",
                }}
              />
            </label>
            {(
              [
                ["email", copy.email, email, setEmail],
                ["photos", copy.photos, photos, setPhotos],
                ["publish", copy.publish, publish, setPublish],
              ] as const
            ).map(([key, label, checked, update]) => (
              <label key={key} htmlFor={`${id}-${key}`}>
                <input
                  id={`${id}-${key}`}
                  type="checkbox"
                  checked={checked}
                  onChange={(event) => {
                    update(event.target.checked);
                    changed();
                  }}
                />{" "}
                {label}
              </label>
            ))}
            <p id={`${id}-note`}>{copy.note}</p>
            <label htmlFor={`${id}-confirm`}>
              <input
                id={`${id}-confirm`}
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              {copy.confirm}
            </label>
            <button type="submit" disabled={!confirmed}>
              {copy.save}
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
