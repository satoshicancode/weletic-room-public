"use client";

import React, { useRef, useState } from "react";
import {
  loyaltyCommunicationJourneySchema,
  loyaltyCommunicationPolicySchema,
  loyaltyCommunicationVariables,
  renderLoyaltyCommunicationText,
  verifyLoyaltyCommunicationsResponse,
  type LoyaltyCommunicationJourney,
  type LoyaltyCommunicationsRequest,
  type LoyaltyCommunicationsResponse,
} from "../../../lib/weletic/loyalty/communications-contract";
import { communicationsCopy } from "./communications-copy";
import { createDefaultLoyaltyCommunicationPolicy } from "./communications-defaults";

type Locale = keyof typeof communicationsCopy;
type Policy = ReturnType<typeof createDefaultLoyaltyCommunicationPolicy>;
export type CommunicationsTransport = (
  request: LoyaltyCommunicationsRequest,
) => Promise<LoyaltyCommunicationsResponse>;
export function CommunicationsScreen({
  request,
  onNavigationStateChange,
}: {
  request: CommunicationsTransport;
  onNavigationStateChange?: (state: { dirty: boolean; locale: Locale }) => void;
}) {
  const [locale, setLocale] = useState<Locale>("en");
  const [contentLocale, setContentLocale] = useState<Locale>("en");
  const [journey, setJourney] =
    useState<LoyaltyCommunicationJourney>("points_earned");
  const [state, setState] = useState<LoyaltyCommunicationsResponse | null>(
    null,
  );
  const [draft, setDraft] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<"error" | "invalid" | "saved" | null>(
    null,
  );
  const [mobile, setMobile] = useState(true);
  const epoch = useRef(0);
  const copy = communicationsCopy[locale];
  const birthdayIntegration =
    state?.deliveryIntegration ===
    "purchase_signup_birthday_and_expiry_policies";
  const birthdayConnected = birthdayIntegration && journey === "birthday";
  const signupConnected =
    (birthdayIntegration ||
      state?.deliveryIntegration === "purchase_signup_and_expiry_policies") &&
    journey === "points_earned";
  const purchaseConnected =
    state?.deliveryIntegration === "purchase_and_expiry_policies" &&
    journey === "points_earned";
  const expiryConnected =
    (birthdayIntegration ||
      state?.deliveryIntegration === "expiry_policies" ||
      state?.deliveryIntegration === "purchase_and_expiry_policies" ||
      state?.deliveryIntegration === "purchase_signup_and_expiry_policies") &&
    (journey === "points_warning" || journey === "points_last_chance");
  const connectedCopy = birthdayConnected
    ? {
        description: copy.birthdayConnected,
        saved: copy.birthdaySaved,
        enabled: copy.birthdayEnabled,
      }
    : signupConnected
      ? {
          description: birthdayIntegration
            ? copy.signupWithBirthdayConnected
            : copy.signupConnected,
          saved: copy.signupSaved,
          enabled: copy.signupEnabled,
        }
      : purchaseConnected
        ? {
            description: copy.purchaseConnected,
            saved: copy.purchaseSaved,
            enabled: copy.purchaseEnabled,
          }
        : expiryConnected
          ? {
              description: copy.expiryConnected,
              saved: copy.expirySaved,
              enabled: copy.expiryEnabled,
            }
          : null;
  React.useEffect(() => {
    onNavigationStateChange?.({ dirty, locale });
  }, [dirty, locale, onNavigationStateChange]);
  function draftFor(
    result: LoyaltyCommunicationsResponse,
    selected: LoyaltyCommunicationJourney,
  ) {
    return (
      result.policies.find((policy) => policy.journey === selected) ??
      createDefaultLoyaltyCommunicationPolicy(selected)
    );
  }
  React.useEffect(() => {
    const fence = epoch;
    const version = ++fence.current;
    setState(null);
    setDraft(null);
    setDirty(false);
    setMessage(null);
    setBusy(true);
    setJourney("points_earned");
    const input = { operation: "read" } as const;
    request(input)
      .then((value) => {
        if (version !== fence.current) return;
        const result = verifyLoyaltyCommunicationsResponse(input, value);
        setState(result);
        setDraft(draftFor(result, "points_earned"));
      })
      .catch(() => {
        if (version === fence.current) setMessage("error");
      })
      .finally(() => {
        if (version === fence.current) setBusy(false);
      });
    return () => {
      fence.current++;
    };
  }, [request]);

  async function reload() {
    const version = ++epoch.current;
    setBusy(true);
    setState(null);
    setDraft(null);
    setDirty(false);
    setMessage(null);
    const input = { operation: "read" } as const;
    try {
      const result = verifyLoyaltyCommunicationsResponse(
        input,
        await request(input),
      );
      if (version !== epoch.current) return;
      setState(result);
      setDraft(draftFor(result, journey));
    } catch {
      if (version === epoch.current) setMessage("error");
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  async function save() {
    if (!state?.capabilities.configure || !draft || busy) return;
    const parsed = loyaltyCommunicationPolicySchema.safeParse(draft);
    if (!parsed.success) {
      setMessage("invalid");
      return;
    }
    const input = {
      operation: "save",
      expectedInstallationGeneration: state.installationGeneration,
      expectedRevision: state.revision,
      policy: parsed.data,
    } as const;
    const version = ++epoch.current;
    setBusy(true);
    setMessage(null);
    try {
      const result = verifyLoyaltyCommunicationsResponse(
        input,
        await request(input),
      );
      if (version !== epoch.current) return;
      setState(result);
      setDraft(draftFor(result, journey));
      setDirty(false);
      setMessage("saved");
    } catch {
      if (version === epoch.current) {
        setState(null);
        setMessage("error");
      }
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }
  function change(field: keyof Policy["templates"]["en"], value: string) {
    if (!draft) return;
    setDraft({
      ...draft,
      templates: {
        ...draft.templates,
        [contentLocale]: { ...draft.templates[contentLocale], [field]: value },
      },
    });
    setDirty(true);
    setMessage(null);
  }
  const valid =
    draft && loyaltyCommunicationPolicySchema.safeParse(draft).success;
  const sampleValues = Object.fromEntries(
    loyaltyCommunicationVariables[journey].map((name) => [name, `[${name}]`]),
  );
  const preview =
    valid && draft
      ? Object.fromEntries(
          Object.entries(draft.templates[contentLocale]).map(
            ([field, text]) => [
              field,
              renderLoyaltyCommunicationText(text, journey, sampleValues),
            ],
          ),
        )
      : null;
  const disabled = busy || !state?.capabilities.configure;
  const languageOptions = (
    <>
      <option value="en">English</option>
      <option value="ja">日本語</option>
      <option value="vi">Tiếng Việt</option>
    </>
  );
  return (
    <article className="weletic-communications" lang={locale} aria-busy={busy}>
      <h1>{copy.title}</h1>
      <label>
        {copy.language}
        <select
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          {languageOptions}
        </select>
      </label>
      <p>{connectedCopy?.description ?? copy.disconnected}</p>
      {busy && <p role="status">{copy.loading}</p>}
      {message && (
        <p role={message === "saved" ? "status" : "alert"}>
          {message === "saved" && connectedCopy
            ? connectedCopy.saved
            : copy[message]}
        </p>
      )}
      {state && !state.capabilities.configure && <p>{copy.readonly}</p>}
      <button type="button" disabled={busy} onClick={() => void reload()}>
        {copy.reload}
      </button>
      {draft && (
        <>
          <label>
            {copy.journey}
            <select
              value={journey}
              disabled={busy || dirty || !state}
              onChange={(event) => {
                const selected = loyaltyCommunicationJourneySchema.parse(
                  event.target.value,
                );
                setJourney(selected);
                setDraft(draftFor(state!, selected));
                setMessage(null);
              }}
            >
              {loyaltyCommunicationJourneySchema.options.map((item) => (
                <option key={item} value={item}>
                  {
                    createDefaultLoyaltyCommunicationPolicy(item).templates[
                      locale
                    ].heading
                  }
                </option>
              ))}
            </select>
          </label>
          {dirty && <p>{copy.dirty}</p>}
          <label>
            {copy.contentLanguage}
            <select
              value={contentLocale}
              disabled={busy}
              onChange={(event) =>
                setContentLocale(event.target.value as Locale)
              }
            >
              {languageOptions}
            </select>
          </label>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={disabled}>
              <legend>{copy.title}</legend>
              <label>
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => {
                    setDraft({ ...draft, enabled: event.target.checked });
                    setDirty(true);
                    setMessage(null);
                  }}
                />
                {connectedCopy?.enabled ?? copy.enabled}
              </label>
              {(["subject", "heading", "body", "actionLabel"] as const).map(
                (field) => (
                  <label key={field}>
                    {copy[field]}
                    {field === "body" ? (
                      <textarea
                        lang={contentLocale}
                        rows={6}
                        value={draft.templates[contentLocale][field]}
                        onChange={(event) => change(field, event.target.value)}
                        maxLength={5000}
                      />
                    ) : (
                      <input
                        lang={contentLocale}
                        value={draft.templates[contentLocale][field]}
                        onChange={(event) => change(field, event.target.value)}
                        maxLength={field === "actionLabel" ? 80 : 200}
                      />
                    )}
                  </label>
                ),
              )}
              <button type="submit" disabled={!dirty}>
                {copy.save}
              </button>
            </fieldset>
          </form>
          <button
            type="button"
            disabled={busy || !state || !dirty}
            onClick={() => {
              setDraft(draftFor(state!, journey));
              setDirty(false);
              setMessage(null);
            }}
          >
            {copy.discard}
          </button>
          <p>
            {copy.variables}:{" "}
            {loyaltyCommunicationVariables[journey]
              .map((name) => `{{${name}}}`)
              .join(", ")}
          </p>
          <label>
            <input
              type="checkbox"
              checked={mobile}
              onChange={(event) => setMobile(event.target.checked)}
            />
            {mobile ? copy.mobile : copy.desktop}
          </label>
          <section
            aria-label={copy.preview}
            style={{ maxWidth: mobile ? 375 : 640 }}
          >
            <h2>{copy.preview}</h2>
            {preview ? (
              <div lang={contentLocale}>
                <p>{preview.subject}</p>
                <h3>{preview.heading}</h3>
                <p style={{ whiteSpace: "pre-wrap" }}>{preview.body}</p>
                <span>{preview.actionLabel}</span>
              </div>
            ) : (
              <p>{copy.invalid}</p>
            )}
          </section>
        </>
      )}
    </article>
  );
}
