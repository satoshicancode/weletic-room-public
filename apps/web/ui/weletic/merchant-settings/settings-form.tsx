"use client";

import React from "react";
import useSWR, { SWRConfig } from "swr";
import type { LoyaltyModuleToggle } from "../../../lib/weletic/loyalty/module-contract";
import {
  merchantAppearanceUpdateSchema,
  merchantSettingsUpdateSchema,
  type MerchantSettingsUpdate,
} from "../../../lib/weletic/merchant-settings/contracts";
import type {
  MerchantAppearanceView,
  MerchantSettingsView as MerchantSettings,
} from "../../../lib/weletic/merchant-settings/merchant-contract";
import { merchantSettingsCopy, type MerchantSettingsLocale } from "./copy";

export type MerchantSettingsTransport = {
  scopeKey: string;
  staffScoped?: boolean;
  appearanceOnly?: boolean;
  read: () => Promise<MerchantSettings | MerchantAppearanceView>;
  save: (input: MerchantSettingsUpdate) => Promise<unknown>;
  loyalty?: (input: LoyaltyModuleToggle) => Promise<unknown>;
  reviews?: (input: {
    enabled: boolean;
    expectedUpdatedAt: string | null;
    expectedInstallationGeneration: string;
  }) => Promise<unknown>;
};
const control =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm disabled:opacity-50";
const button =
  "rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50";
type Notice = "saved" | "error" | "invalid" | null;

export function MerchantSettingsSession(
  props: React.ComponentProps<typeof MerchantSettingsScreen>,
) {
  const cache = React.useMemo(() => ({ provider: () => new Map() }), []);
  return (
    <SWRConfig value={cache}>
      <MerchantSettingsScreen {...props} />
    </SWRConfig>
  );
}

export function MerchantSettingsScreen({
  transport,
  canEdit,
}: {
  transport: MerchantSettingsTransport;
  canEdit: boolean;
}) {
  const [locale, setLocale] = React.useState<MerchantSettingsLocale>("en");
  const [notice, setNotice] = React.useState<{
    scope: string;
    value: Notice;
  }>();
  const text = merchantSettingsCopy[locale];
  const visit = React.useId();
  const writePending = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const [blockedScope, setBlockedScope] = React.useState<string>();
  const { data, error, mutate, isLoading, isValidating } = useSWR(
    ["merchant-settings", transport.scopeKey, visit],
    transport.read,
    { keepPreviousData: false, shouldRetryOnError: false },
  );
  async function perform(
    operation: () => Promise<unknown>,
    permitted: boolean,
  ) {
    if (
      writePending.current ||
      !permitted ||
      blockedScope === transport.scopeKey
    )
      return;
    writePending.current = true;
    setBusy(true);
    const scope = transport.scopeKey;
    setNotice({ scope, value: null });
    try {
      await operation();
      await mutate();
      setNotice({ scope, value: "saved" });
    } catch {
      setBlockedScope(scope);
      setNotice({ scope, value: "error" });
    } finally {
      writePending.current = false;
      setBusy(false);
    }
  }
  async function reload() {
    try {
      const fresh = await mutate();
      if (fresh) setBlockedScope(undefined);
    } catch {
      /* Keep controls unavailable until an explicit read succeeds. */
    }
  }
  return (
    <section className="min-w-0 space-y-6 py-6" lang={locale}>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">
          {transport.appearanceOnly ? text.brand : text.title}
        </h2>
        <label className="flex items-center gap-2 text-sm">
          {text.language}
          <select
            className={control}
            value={locale}
            onChange={(event) =>
              setLocale(event.target.value as MerchantSettingsLocale)
            }
          >
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="vi">Tiếng Việt</option>
          </select>
        </label>
      </header>
      {notice?.scope === transport.scopeKey && notice.value && (
        <p role={notice.value === "saved" ? "status" : "alert"}>
          {text[notice.value]}
        </p>
      )}
      {error || blockedScope === transport.scopeKey ? (
        <div role="alert">
          <p>{text.unavailable}</p>
          <button
            className={button}
            disabled={busy || isValidating}
            onClick={() => void reload()}
          >
            {text.reload}
          </button>
        </div>
      ) : isLoading || isValidating || !data ? (
        <p role="status">{text.loading}</p>
      ) : (
        <SettingsEditor
          key={`${transport.scopeKey}:${data.installationGeneration}:${data.revision}`}
          data={data}
          transport={transport}
          canEdit={canEdit}
          locale={locale}
          busy={busy}
          run={perform}
          setNotice={(value) => setNotice({ scope: transport.scopeKey, value })}
        />
      )}
    </section>
  );
}

function SettingsEditor({
  data,
  transport,
  canEdit,
  locale,
  busy,
  run,
  setNotice,
}: {
  data: MerchantSettings | MerchantAppearanceView;
  transport: MerchantSettingsTransport;
  canEdit: boolean;
  locale: MerchantSettingsLocale;
  busy: boolean;
  run: (operation: () => Promise<unknown>, permitted: boolean) => Promise<void>;
  setNotice: (value: Notice) => void;
}) {
  const text = merchantSettingsCopy[locale];
  const saved: Partial<MerchantSettings["settings"]> = data.settings;
  const [draft, setDraft] = React.useState(saved);
  const fallback = canEdit && !transport.staffScoped;
  const permissions = ("capabilities" in data
    ? data.capabilities
    : undefined) ?? {
    settings: fallback,
    appearance: fallback || Boolean(canEdit && transport.appearanceOnly),
    loyalty: fallback,
    reviews: fallback,
  };
  const allowed = (key: keyof typeof permissions) =>
    canEdit && permissions[key];
  const patch = Object.fromEntries(
    Object.entries(draft).filter(
      ([key, value]) => value !== saved[key as keyof typeof draft],
    ),
  );
  const changed = Object.keys(patch).length > 0;
  async function perform(
    operation: () => Promise<unknown>,
    permitted = allowed("settings") || allowed("appearance"),
  ) {
    return run(operation, permitted);
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    const input = (
      transport.appearanceOnly
        ? merchantAppearanceUpdateSchema
        : merchantSettingsUpdateSchema
    ).safeParse({
      expectedRevision: data.revision,
      expectedInstallationGeneration: data.installationGeneration,
      settings: patch,
    });
    if (!input.success) {
      setNotice("invalid");
      return;
    }
    void perform(() => transport.save(input.data));
  }
  const fields = transport.appearanceOnly
    ? (["brandName", "logoUrl", "accentColor"] as const)
    : (["brandName", "logoUrl", "accentColor", "timeZone"] as const);
  const modules =
    "modules" in data && !transport.appearanceOnly ? data.modules : null;
  const loyalty = modules?.loyalty;
  const status =
    !loyalty || loyalty.status === "not_configured"
      ? text.unconfigured
      : text[loyalty.status];
  return (
    <div className="space-y-6">
      {!canEdit && <p>{text.owner}</p>}
      <form
        onSubmit={submit}
        className="space-y-4 rounded-xl border border-neutral-200 p-5"
      >
        <h3 className="font-semibold">{text.brand}</h3>
        <p className="text-sm text-neutral-600">{text.brandNote}</p>
        <fieldset
          disabled={(!allowed("settings") && !allowed("appearance")) || busy}
          className="grid gap-4 md:grid-cols-2"
        >
          {fields.map((field) => (
            <label key={field} className="space-y-1 text-sm">
              {text[field]}
              <input
                className={control}
                disabled={
                  !allowed(field === "timeZone" ? "settings" : "appearance")
                }
                value={draft[field] ?? ""}
                type={field === "logoUrl" ? "url" : "text"}
                maxLength={
                  field === "logoUrl" ? 2048 : field === "accentColor" ? 7 : 100
                }
                onChange={(event) =>
                  setDraft({ ...draft, [field]: event.target.value || null })
                }
              />
            </label>
          ))}
          {!transport.appearanceOnly && (
            <>
              <label className="space-y-1 text-sm">
                {text.defaultLocale}
                <select
                  className={control}
                  disabled={!allowed("settings")}
                  value={draft.defaultLocale}
                  onChange={(event) =>
                    setDraft({ ...draft, defaultLocale: event.target.value })
                  }
                >
                  {draft.defaultLocale &&
                    !["en", "ja", "vi"].includes(draft.defaultLocale) && (
                      <option value={draft.defaultLocale}>
                        {draft.defaultLocale}
                      </option>
                    )}
                  <option value="en">English</option>
                  <option value="ja">日本語</option>
                  <option value="vi">Tiếng Việt</option>
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  disabled={!allowed("settings")}
                  checked={draft.shopperEmailPaused}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      shopperEmailPaused: event.target.checked,
                    })
                  }
                />
                {text.pause}
              </label>
            </>
          )}
        </fieldset>
        {!transport.appearanceOnly && (
          <>
            <p className="text-sm text-neutral-600">{text.timezoneNote}</p>
            <p className="text-sm text-neutral-600">{text.pauseNote}</p>
          </>
        )}
        <div
          aria-label={text.preview}
          className="rounded-lg border-l-4 bg-neutral-50 p-4"
          style={{
            borderColor: /^#[0-9a-fA-F]{6}$/.test(draft.accentColor ?? "")
              ? draft.accentColor!
              : "#171717",
          }}
        >
          <p className="font-semibold">
            {draft.brandName ?? data.branding.name}
          </p>
        </div>
        <button
          className={button}
          disabled={
            (!allowed("settings") && !allowed("appearance")) || busy || !changed
          }
        >
          {busy ? text.saving : text.save}
        </button>
      </form>
      {modules && loyalty && (
        <section className="space-y-4 rounded-xl border border-neutral-200 p-5">
          <h3 className="font-semibold">{text.modules}</h3>
          <p className="text-sm text-neutral-600">{text.moduleNote}</p>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              {text.loyalty}: {status}
            </p>
            <button
              className={button}
              disabled={
                !allowed("loyalty") ||
                !transport.loyalty ||
                busy ||
                loyalty.killSwitchActive ||
                loyalty.status === "not_configured"
              }
              onClick={() => {
                const expectedStatus = loyalty.status;
                const toggle = transport.loyalty;
                if (expectedStatus === "not_configured" || !toggle) return;
                void perform(
                  () =>
                    toggle({
                      status:
                        loyalty.status === "active" ? "disabled" : "active",
                      expectedStatus,
                      expectedInstallationGeneration:
                        data.installationGeneration,
                    }),
                  allowed("loyalty"),
                );
              }}
            >
              {loyalty.status === "active" ? text.disable : text.enable}
            </button>
          </div>
          {loyalty.killSwitchActive && (
            <p role="status" className="text-sm">
              {text.kill}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p>
              {text.reviews}:{" "}
              {modules.reviews.enabled ? text.active : text.disabled}
            </p>
            <button
              className={button}
              disabled={!allowed("reviews") || !transport.reviews || busy}
              onClick={() => {
                const toggle = transport.reviews;
                if (!toggle) return;
                void perform(
                  () =>
                    toggle({
                      enabled: !modules.reviews.enabled,
                      expectedUpdatedAt: modules.reviews.updatedAt,
                      expectedInstallationGeneration:
                        data.installationGeneration,
                    }),
                  allowed("reviews"),
                );
              }}
            >
              {modules.reviews.enabled ? text.disable : text.enable}
            </button>
          </div>
          <p className="text-sm text-amber-800">{text.legacy}</p>
        </section>
      )}
    </div>
  );
}
