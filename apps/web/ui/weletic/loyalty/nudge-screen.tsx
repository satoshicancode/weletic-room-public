"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultLoyaltyNudgeSettings,
  loyaltyNudgeKinds,
  loyaltyNudgeSettingsSchema,
  verifyLoyaltyNudgeResponse,
  type LoyaltyNudgeKind,
  type LoyaltyNudgeRequest,
  type LoyaltyNudgeResponse,
  type LoyaltyNudgeSettings,
} from "../../../lib/weletic/loyalty/nudge-contract";
import { nudgeCopy } from "./nudge-copy";
type Locale = keyof typeof nudgeCopy;
type Policy = LoyaltyNudgeSettings["policies"][number];
export function LoyaltyNudgeScreen({
  request,
  onNavigationStateChange,
}: {
  request: (input: LoyaltyNudgeRequest) => Promise<LoyaltyNudgeResponse>;
  onNavigationStateChange?: (state: { dirty: boolean; locale: Locale }) => void;
}) {
  const [locale, setLocale] = useState<Locale>("en");
  const [contentLocale, setContentLocale] = useState<Locale>("en");
  const [kind, setKind] = useState<LoyaltyNudgeKind>("signup");
  const [state, setState] = useState<LoyaltyNudgeResponse | null>(null);
  const [draft, setDraft] = useState<LoyaltyNudgeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState<"saved" | "invalid" | "error" | null>(
    null,
  );
  const epoch = useRef(0);
  const saving = React.useRef(false);
  const copy = nudgeCopy[locale];
  useEffect(
    () => onNavigationStateChange?.({ dirty, locale }),
    [dirty, locale, onNavigationStateChange],
  );
  const reload = useCallback(async () => {
    const version = ++epoch.current;
    saving.current = false;
    setBusy(true);
    setState(null);
    setDraft(null);
    setDirty(false);
    setMessage(null);
    const input = { operation: "read" } as const;
    try {
      const result = verifyLoyaltyNudgeResponse(input, await request(input));
      if (version !== epoch.current) return;
      setState(result);
      setDraft(result.settings);
    } catch {
      if (version === epoch.current) setMessage("error");
    } finally {
      if (version === epoch.current) setBusy(false);
    }
  }, [request]);
  useEffect(() => {
    const requestEpoch = epoch;
    void reload();
    return () => {
      requestEpoch.current++;
    };
  }, [reload]);
  const disabled =
    busy || !state?.capabilities.configure || !state.programConfigured;
  const policy = draft?.policies.find((p) => p.kind === kind);
  const validation = loyaltyNudgeSettingsSchema.safeParse(draft);
  const valid = draft !== null && validation.success;
  function change(next: Policy) {
    if (!draft || disabled) return;
    setDraft({
      ...draft,
      policies: draft.policies.map((p) => (p.kind === kind ? next : p)),
    });
    setDirty(true);
    setMessage(null);
  }
  async function save() {
    if (saving.current || disabled || !state || !draft || !dirty) return;
    const parsed = loyaltyNudgeSettingsSchema.safeParse(draft);
    if (!parsed.success) {
      setMessage("invalid");
      return;
    }
    const input = {
      operation: "save",
      expectedInstallationGeneration: state.installationGeneration,
      expectedRevision: state.revision,
      settings: parsed.data,
    } as const;
    const storeId = state.storeId;
    const version = ++epoch.current;
    saving.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const result = verifyLoyaltyNudgeResponse(input, await request(input));
      if (version !== epoch.current) return;
      if (result.storeId !== storeId) throw new Error("Nudge scope changed");
      setState(result);
      setDraft(result.settings);
      setDirty(false);
      setMessage("saved");
    } catch {
      if (version === epoch.current) {
        setState(null);
        setMessage("error");
      }
    } finally {
      if (version === epoch.current) {
        saving.current = false;
        setBusy(false);
      }
    }
  }
  const languages = (
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
          onChange={(e) => setLocale(e.target.value as Locale)}
        >
          {languages}
        </select>
      </label>
      <p>{copy.note}</p>
      {busy && <p role="status">{copy.loading}</p>}
      {message && (
        <p role={message === "saved" ? "status" : "alert"}>{copy[message]}</p>
      )}
      {dirty && !validation.success && (
        <div role="alert">
          <p>{copy.invalid}</p>
          <ul>
            {validation.error.issues.map((issue, index) => {
              const invalidKind = draft?.policies[Number(issue.path[1])]?.kind;
              const invalidLocale = issue.path[3];
              const field = issue.path[4];
              return (
                <li key={index}>
                  {invalidKind ? copy[invalidKind] : copy.title}
                  {typeof invalidLocale === "string"
                    ? ` · ${invalidLocale.toUpperCase()}`
                    : ""}
                  {field === "title"
                    ? ` · ${copy.subject}`
                    : field === "description"
                      ? ` · ${copy.description}`
                      : field === "actionLabel"
                        ? ` · ${copy.actionLabel}`
                        : ""}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {state && !state.capabilities.configure && <p>{copy.readonly}</p>}
      {state && !state.programConfigured && <p>{copy.missing}</p>}
      <button type="button" disabled={busy} onClick={() => void reload()}>
        {copy.reload}
      </button>
      {policy && (
        <>
          <label>
            {copy.kind}
            <select
              value={kind}
              disabled={busy}
              onChange={(e) => setKind(e.target.value as LoyaltyNudgeKind)}
            >
              {loyaltyNudgeKinds.map((k) => (
                <option value={k} key={k}>
                  {copy[k]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {copy.contentLanguage}
            <select
              value={contentLocale}
              disabled={busy}
              onChange={(e) => setContentLocale(e.target.value as Locale)}
            >
              {languages}
            </select>
          </label>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={disabled}>
              <legend>{copy[kind]}</legend>
              <label>
                <input
                  type="checkbox"
                  checked={policy.enabled}
                  onChange={(e) =>
                    change({ ...policy, enabled: e.target.checked })
                  }
                />
                {copy.enabled}
              </label>
              <label>
                {copy.icon}
                <select
                  value={policy.icon}
                  onChange={(e) =>
                    change({
                      ...policy,
                      icon: e.target.value as Policy["icon"],
                    })
                  }
                >
                  {(["gift", "star", "award", "sparkles"] as const).map(
                    (icon) => (
                      <option key={icon} value={icon}>
                        {copy[icon]}
                      </option>
                    ),
                  )}
                </select>
              </label>
              {(["title", "description", "actionLabel"] as const).map(
                (field) => (
                  <label key={field}>
                    {field === "title" ? copy.subject : copy[field]}
                    <textarea
                      lang={contentLocale}
                      value={policy.templates[contentLocale][field]}
                      maxLength={
                        field === "title"
                          ? 100
                          : field === "description"
                            ? 300
                            : 60
                      }
                      onChange={(e) =>
                        change({
                          ...policy,
                          templates: {
                            ...policy.templates,
                            [contentLocale]: {
                              ...policy.templates[contentLocale],
                              [field]: e.target.value,
                            },
                          },
                        })
                      }
                    />
                  </label>
                ),
              )}
              <button
                type="button"
                onClick={() =>
                  change({
                    ...policy,
                    templates: defaultLoyaltyNudgeSettings().policies.find(
                      (p) => p.kind === kind,
                    )!.templates,
                  })
                }
              >
                {copy.restore}
              </button>
              <button type="submit" disabled={!valid || !dirty}>
                {copy.save}
              </button>
            </fieldset>
          </form>
          <button
            type="button"
            disabled={disabled || !dirty}
            onClick={() => {
              setDraft(state!.settings);
              setDirty(false);
              setMessage(null);
            }}
          >
            {copy.discard}
          </button>
          <section
            aria-label={copy.preview}
            style={{ overflowWrap: "anywhere" }}
          >
            <h2>{copy.preview}</h2>
            <h3 lang={contentLocale}>
              {policy.templates[contentLocale].title}
            </h3>
            <p
              lang={contentLocale}
              style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
            >
              {policy.templates[contentLocale].description}
            </p>
            <span lang={contentLocale}>
              {policy.templates[contentLocale].actionLabel}
            </span>
          </section>
        </>
      )}
    </article>
  );
}
