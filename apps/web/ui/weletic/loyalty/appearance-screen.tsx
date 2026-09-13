"use client";
import React, { useEffect, useId, useRef, useState } from "react";
import {
  loyaltyAppearanceBrandingSchema,
  verifyLoyaltyAppearanceResponse,
  type LoyaltyAppearanceRequest,
  type LoyaltyAppearanceResponse,
} from "../../../lib/weletic/loyalty/appearance-contract";
import {
  LOYALTY_LAUNCHER_ICONS,
  LOYALTY_LAUNCHER_POSITIONS,
  type LoyaltyBranding,
} from "../../../lib/weletic/loyalty/branding";
import { appearanceCopy } from "./appearance-copy";
import { LauncherPresentationFields } from "./launcher-presentation-fields";

type Locale = keyof typeof appearanceCopy;
export function LoyaltyAppearanceScreen({
  request,
  onNavigationStateChange,
}: {
  request: (
    input: LoyaltyAppearanceRequest,
  ) => Promise<LoyaltyAppearanceResponse>;
  onNavigationStateChange?: (state: { dirty: boolean; locale: Locale }) => void;
}) {
  const id = useId();
  const [locale, setLocale] = useState<Locale>("en");
  const [state, setState] = useState<LoyaltyAppearanceResponse | null>(null);
  const [draft, setDraft] = useState<LoyaltyBranding | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<"saved" | "error" | "invalid" | null>(
    null,
  );
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const copy = appearanceCopy[locale];
  useEffect(() => {
    onNavigationStateChange?.({ dirty: dirty || busy, locale });
  }, [dirty, busy, locale, onNavigationStateChange]);
  useEffect(() => {
    const fence = epoch;
    const version = ++fence.current;
    inFlight.current = true;
    setBusy(true);
    setState(null);
    setDraft(null);
    setDirty(false);
    setMessage(null);
    const input = { operation: "read" } as const;
    request(input)
      .then((value) => {
        if (version !== fence.current) return;
        const result = verifyLoyaltyAppearanceResponse(input, value);
        setState(result);
        setDraft(result.branding);
      })
      .catch(() => {
        if (version === fence.current) setMessage("error");
      })
      .finally(() => {
        if (version === fence.current) {
          inFlight.current = false;
          setBusy(false);
        }
      });
    return () => {
      fence.current++;
    };
  }, [request]);
  async function perform(input: LoyaltyAppearanceRequest) {
    if (inFlight.current) return;
    inFlight.current = true;
    const version = ++epoch.current;
    setBusy(true);
    setMessage(null);
    try {
      const result = verifyLoyaltyAppearanceResponse(
        input,
        await request(input),
      );
      if (version !== epoch.current) return;
      setState(result);
      setDraft(result.branding);
      setDirty(false);
      setMessage(input.operation === "save" ? "saved" : null);
    } catch {
      if (version === epoch.current) {
        setState(null);
        setMessage("error");
      }
    } finally {
      if (version === epoch.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  function change<K extends keyof LoyaltyBranding>(
    key: K,
    value: LoyaltyBranding[K],
  ) {
    if (!draft || inFlight.current) return;
    setDraft({ ...draft, [key]: value });
    setDirty(true);
    setMessage(null);
  }
  function save(event: React.FormEvent) {
    event.preventDefault();
    if (
      !state?.capabilities.configure ||
      !state.programConfigured ||
      !draft ||
      inFlight.current
    )
      return;
    const parsed = loyaltyAppearanceBrandingSchema.safeParse(draft);
    if (!parsed.success) {
      setMessage("invalid");
      return;
    }
    void perform({
      operation: "save",
      expectedInstallationGeneration: state.installationGeneration,
      expectedRevision: state.revision,
      branding: parsed.data,
    });
  }
  const disabled =
    busy || !state?.capabilities.configure || !state.programConfigured;
  return (
    <section
      className="weletic-communications"
      lang={locale}
      aria-busy={busy}
      aria-labelledby={`${id}-title`}
    >
      <h2 id={`${id}-title`}>{copy.title}</h2>
      <p>{copy.note}</p>
      <label>
        {copy.language}
        <select
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="vi">Tiếng Việt</option>
        </select>
      </label>
      {busy && <p role="status">{copy.loading}</p>}
      {message && (
        <p role={message === "saved" ? "status" : "alert"}>{copy[message]}</p>
      )}
      {state && !state.programConfigured && <p>{copy.missing}</p>}
      <form onSubmit={save}>
        <fieldset
          disabled={disabled}
          style={{ display: "grid", gap: "1rem", minWidth: 0 }}
        >
          <legend>{copy.title}</legend>
          {draft && (
            <>
              {(
                [
                  "launcherText",
                  "panelTitle",
                  "panelWelcomeSubtitle",
                  "primaryColor",
                  "headerTextColor",
                  "heroImageUrl",
                ] as const
              ).map((key) => (
                <label key={key} htmlFor={`${id}-${key}`}>
                  {copy[key]}
                  <input
                    id={`${id}-${key}`}
                    style={{ width: "100%", boxSizing: "border-box" }}
                    value={draft[key] ?? ""}
                    maxLength={
                      key === "launcherText"
                        ? 40
                        : key === "panelTitle"
                          ? 100
                          : key === "panelWelcomeSubtitle"
                            ? 300
                            : key === "heroImageUrl"
                              ? 2048
                              : 7
                    }
                    onChange={(event) => change(key, event.target.value)}
                  />
                </label>
              ))}
              <label>
                {copy.launcherPosition}
                <select
                  value={draft.launcherPosition}
                  onChange={(event) =>
                    change(
                      "launcherPosition",
                      event.target.value as LoyaltyBranding["launcherPosition"],
                    )
                  }
                >
                  {LOYALTY_LAUNCHER_POSITIONS.map((value) => (
                    <option key={value} value={value}>
                      {copy[value]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {copy.launcherIcon}
                <select
                  value={draft.launcherIcon}
                  onChange={(event) =>
                    change(
                      "launcherIcon",
                      event.target.value as LoyaltyBranding["launcherIcon"],
                    )
                  }
                >
                  {LOYALTY_LAUNCHER_ICONS.map((value) => (
                    <option key={value} value={value}>
                      {copy[value]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.enableFloatingLauncher}
                  onChange={(event) =>
                    change("enableFloatingLauncher", event.target.checked)
                  }
                />
                {copy.enableFloatingLauncher}
              </label>
              <LauncherPresentationFields
                value={draft.launcherPresentation}
                locale={locale}
                onChange={(value) => change("launcherPresentation", value)}
              />
            </>
          )}
          <button type="submit" disabled={!dirty}>
            {copy.save}
          </button>
        </fieldset>
      </form>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (!dirty || window.confirm(copy.discard))
            void perform({ operation: "read" });
        }}
      >
        {copy.reload}
      </button>
    </section>
  );
}
