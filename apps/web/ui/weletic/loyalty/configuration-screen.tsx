"use client";

import React from "react";
import useSWR, { SWRConfig } from "swr";
import {
  loyaltyConfigurationUpdateSchema,
  type LoyaltyConfigurationResponse,
  type LoyaltyConfigurationUpdate,
} from "../../../lib/weletic/loyalty/configuration-contract";
import {
  loyaltyConfigurationCopy,
  type LoyaltyConfigurationLocale,
} from "./configuration-copy";

export type LoyaltyConfigurationTransport = {
  scopeKey: string;
  read: () => Promise<LoyaltyConfigurationResponse>;
  save: (
    input: LoyaltyConfigurationUpdate,
  ) => Promise<LoyaltyConfigurationResponse>;
};
const control =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm disabled:opacity-50";
const button =
  "rounded-md border border-neutral-300 bg-white px-4 py-2 text-sm focus-visible:outline focus-visible:outline-2 disabled:opacity-50";
type Notice = "saved" | "error" | null;
type Settings = NonNullable<
  LoyaltyConfigurationResponse["program"]
>["settings"];
type Field = {
  key: keyof typeof loyaltyConfigurationCopy.en.fields;
  kind: "text" | "integer" | "decimal" | "boolean" | "select";
  options?: readonly (keyof typeof loyaltyConfigurationCopy.en.options)[];
  maximum?: number;
};
const groups: Array<{
  key: "general" | "vip" | "finance" | "lifecycle";
  owner?: boolean;
  fields: Field[];
}> = [
  {
    key: "general",
    fields: [
      { key: "name", kind: "text" },
      { key: "pointNameSingular", kind: "text" },
      { key: "pointNamePlural", kind: "text" },
      { key: "pointsPerCurrencyUnit", kind: "decimal" },
      { key: "holdingPeriodDays", kind: "integer", maximum: 365 },
      { key: "pointsExpiryMonths", kind: "integer", maximum: 24 },
      { key: "pointsExpiryDays", kind: "integer", maximum: 730 },
      { key: "pointsExpiryWarningDays", kind: "integer", maximum: 730 },
      { key: "pointsExpiryLastChanceDays", kind: "integer", maximum: 730 },
      { key: "pointsExpiryWarningEnabled", kind: "boolean" },
      { key: "pointsExpiryLastChanceEnabled", kind: "boolean" },
    ],
  },
  {
    key: "vip",
    fields: [
      {
        key: "vipMilestoneMode",
        kind: "select",
        options: ["amount_spent", "points_earned", "both"],
      },
      {
        key: "vipTimeframe",
        kind: "select",
        options: ["rolling_12m", "calendar_year", "lifetime"],
      },
      { key: "vipDowngradeGraceDays", kind: "integer", maximum: 365 },
      { key: "vipAutoDowngradeEnabled", kind: "boolean" },
    ],
  },
  {
    key: "finance",
    owner: true,
    fields: [
      { key: "liabilityMinorUnitsNumerator", kind: "decimal" },
      { key: "liabilityPointsDenominator", kind: "decimal" },
    ],
  },
  {
    key: "lifecycle",
    owner: true,
    fields: [
      {
        key: "status",
        kind: "select",
        options: ["draft", "test", "active", "disabled"],
      },
      { key: "killSwitchActive", kind: "boolean" },
    ],
  },
];

function draftSettings(locale: LoyaltyConfigurationLocale): Settings {
  const text = loyaltyConfigurationCopy[locale];
  return {
    name: text.title,
    status: "draft",
    pointNameSingular: text.point,
    pointNamePlural: text.points,
    pointsPerCurrencyUnit: "1",
    holdingPeriodDays: 0,
    pointsExpiryMonths: 0,
    pointsExpiryDays: 0,
    pointsExpiryWarningDays: 30,
    pointsExpiryLastChanceDays: 3,
    pointsExpiryWarningEnabled: true,
    pointsExpiryLastChanceEnabled: true,
    killSwitchActive: false,
    vipMilestoneMode: "amount_spent",
    vipTimeframe: "rolling_12m",
    vipDowngradeGraceDays: 30,
    vipAutoDowngradeEnabled: true,
    liabilityValuationCurrency: null,
    liabilityMinorUnitsNumerator: null,
    liabilityPointsDenominator: null,
  };
}

export function LoyaltyConfigurationSession({
  transport,
}: {
  transport: LoyaltyConfigurationTransport;
}) {
  const cache = React.useMemo(() => ({ provider: () => new Map() }), []);
  return (
    <SWRConfig value={cache}>
      <LoyaltyConfigurationScreen transport={transport} />
    </SWRConfig>
  );
}

export function LoyaltyConfigurationScreen({
  transport,
}: {
  transport: LoyaltyConfigurationTransport;
}) {
  const [locale, setLocale] = React.useState<LoyaltyConfigurationLocale>("en");
  const text = loyaltyConfigurationCopy[locale];
  const visit = React.useId();
  const scopeVisit = React.useRef({ scope: transport.scopeKey, sequence: 0 });
  if (scopeVisit.current.scope !== transport.scopeKey)
    scopeVisit.current = {
      scope: transport.scopeKey,
      sequence: scopeVisit.current.sequence + 1,
    };
  const writePending = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const [blockedScope, setBlockedScope] = React.useState<string>();
  const [notice, setNotice] = React.useState<{
    scope: string;
    value: Notice;
  }>();
  const { data, error, mutate, isLoading, isValidating } = useSWR(
    [
      "loyalty-configuration",
      transport.scopeKey,
      scopeVisit.current.sequence,
      visit,
    ],
    transport.read,
    { keepPreviousData: false, shouldRetryOnError: false },
  );
  async function save(input: LoyaltyConfigurationUpdate) {
    if (
      writePending.current ||
      !data?.capabilities.configure ||
      blockedScope === transport.scopeKey
    )
      return;
    writePending.current = true;
    setBusy(true);
    const scope = transport.scopeKey;
    setNotice({ scope, value: null });
    try {
      await transport.save(input);
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
    const recoveryVisit = scopeVisit.current;
    try {
      if ((await mutate()) && scopeVisit.current === recoveryVisit) {
        setBlockedScope(undefined);
        setNotice({ scope: transport.scopeKey, value: null });
      }
    } catch {
      /* Explicit recovery must succeed before editing resumes. */
    }
  }
  return (
    <section className="min-w-0 space-y-6 py-6 font-sans" lang={locale}>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{text.title}</h1>
        <label className="flex shrink-0 items-center gap-2 whitespace-nowrap text-sm">
          {text.language}
          <select
            className={control}
            value={locale}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "en" || value === "ja" || value === "vi")
                setLocale(value);
            }}
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
            type="button"
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
        <ConfigurationEditor
          key={`${transport.scopeKey}:${data.installationGeneration}:${data.configurationRevision}`}
          data={data}
          locale={locale}
          busy={busy}
          save={save}
        />
      )}
    </section>
  );
}

function ConfigurationEditor({
  data,
  locale,
  busy,
  save,
}: {
  data: LoyaltyConfigurationResponse;
  locale: LoyaltyConfigurationLocale;
  busy: boolean;
  save: (input: LoyaltyConfigurationUpdate) => Promise<void>;
}) {
  const text = loyaltyConfigurationCopy[locale];
  const [initial] = React.useState(
    () => data.program?.settings ?? draftSettings(locale),
  );
  const [message, setMessage] = React.useState<"invalid" | "unchanged" | null>(
    null,
  );
  const writable = data.capabilities.configure && !busy;
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writable) return;
    const form = new FormData(event.currentTarget);
    const patch: Record<string, unknown> = {};
    for (const group of groups) {
      if (group.owner && !data.capabilities.owner) continue;
      if (group.key === "lifecycle" && !data.program) continue;
      for (const field of group.fields) {
        const raw = form.get(field.key);
        const value =
          field.kind === "boolean"
            ? raw === "on"
            : field.kind === "integer"
              ? typeof raw === "string" && raw.trim() !== ""
                ? Number(raw)
                : NaN
              : typeof raw === "string"
                ? raw.trim()
                : "";
        const current = initial[field.key] ?? "";
        if (!data.program || value !== current) patch[field.key] = value;
      }
    }
    if (!data.program) patch.name = form.get("name");
    if (
      "liabilityMinorUnitsNumerator" in patch ||
      "liabilityPointsDenominator" in patch
    ) {
      const numerator = String(
        form.get("liabilityMinorUnitsNumerator") ?? "",
      ).trim();
      const denominator = String(
        form.get("liabilityPointsDenominator") ?? "",
      ).trim();
      patch.liabilityMinorUnitsNumerator = numerator || null;
      patch.liabilityPointsDenominator = denominator || null;
      patch.liabilityValuationCurrency =
        numerator || denominator ? data.accountingCurrency : null;
    }
    if (Object.keys(patch).length === 0) {
      setMessage("unchanged");
      return;
    }
    const input = loyaltyConfigurationUpdateSchema.safeParse({
      expectedRevision: data.configurationRevision,
      expectedInstallationGeneration: data.installationGeneration,
      settings: patch,
    });
    if (!input.success) {
      setMessage("invalid");
      return;
    }
    setMessage(null);
    await save(input.data);
  }
  return (
    <form className="space-y-6" onSubmit={(event) => void submit(event)}>
      {!data.program && <p>{text.unconfigured}</p>}
      {!data.capabilities.configure && <p>{text.readOnly}</p>}
      {!data.capabilities.owner && <p>{text.ownerOnly}</p>}
      {message && <p role="alert">{text[message]}</p>}
      {groups.map((group) => (
        <fieldset
          key={group.key}
          disabled={
            !writable ||
            Boolean(group.owner && !data.capabilities.owner) ||
            (group.key === "lifecycle" && !data.program)
          }
          className="min-w-0 space-y-4 rounded-lg border border-neutral-200 p-4"
        >
          <legend className="px-1 font-semibold">{text[group.key]}</legend>
          {group.key === "finance" && (
            <>
              <p className="text-sm">
                {text.currency}: {data.accountingCurrency}
              </p>
              <p className="text-sm">{text.valuationHelp}</p>
            </>
          )}
          {group.key === "general" && (
            <p className="text-sm">{text.expiryHelp}</p>
          )}
          {group.key === "lifecycle" && (
            <p className="text-sm">{text.lifecycleHelp}</p>
          )}
          <div className="grid min-w-0 gap-4 sm:grid-cols-2">
            {group.fields.map((field) => (
              <label
                key={field.key}
                className="block min-w-0 space-y-1 text-sm"
              >
                <span>{text.fields[field.key]}</span>
                {field.kind === "boolean" ? (
                  <input
                    className="ml-2"
                    type="checkbox"
                    name={field.key}
                    defaultChecked={initial[field.key] === true}
                  />
                ) : field.kind === "select" ? (
                  <select
                    className={control}
                    name={field.key}
                    defaultValue={String(initial[field.key])}
                  >
                    {field.options?.map((option) => (
                      <option key={option} value={option}>
                        {text.options[option]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={control}
                    name={field.key}
                    defaultValue={String(initial[field.key] ?? "")}
                    type={field.kind === "integer" ? "number" : "text"}
                    min={field.kind === "integer" ? 0 : undefined}
                    max={field.maximum}
                    step={field.kind === "integer" ? 1 : undefined}
                    inputMode={
                      field.kind === "decimal"
                        ? "decimal"
                        : field.kind === "integer"
                          ? "numeric"
                          : undefined
                    }
                    maxLength={field.kind === "text" ? 191 : 32}
                    required={group.key !== "finance"}
                  />
                )}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <button className={button} type="submit" disabled={!writable}>
        {data.program ? text.save : text.create}
      </button>
    </form>
  );
}
