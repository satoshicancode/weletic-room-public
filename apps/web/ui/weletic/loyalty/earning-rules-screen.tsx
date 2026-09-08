"use client";
import React from "react";
import type {
  EarningRuleRetire,
  EarningRulesResponse,
  EarningRuleWrite,
} from "../../../lib/weletic/loyalty/earning-rule-contract";
import { earningRuleCopy, type EarningRuleLocale } from "./earning-rule-copy";
import { EarningRuleEditor } from "./earning-rule-editor";
import {
  earningRuleFormFromFields,
  newEarningRuleForm,
  type EarningRuleForm,
} from "./earning-rule-form";

export type EarningRulesTransport = {
  scopeKey: string;
  read: () => Promise<EarningRulesResponse>;
  save: (input: EarningRuleWrite) => Promise<EarningRulesResponse>;
  retire: (input: EarningRuleRetire) => Promise<EarningRulesResponse>;
};
const messages = {
  en: {
    title: "Earning rules",
    reload: "Reload",
    loading: "Checking access…",
    create: "New rule",
    edit: "Edit",
    retire: "Retire",
    confirm: "Confirm retirement",
    cancel: "Cancel",
    empty: "No earning rules configured.",
    readonly: "Read-only access",
    unavailable:
      "The result is unavailable or uncertain. Reload before making changes.",
    saved: "Rule saved.",
    legacy: "Legacy configuration requires review before editing.",
    constraints: "Existing schedule or tier restrictions are preserved.",
    active: "Active",
    inactive: "Inactive",
  },
  ja: {
    title: "ポイント獲得ルール",
    reload: "再読み込み",
    loading: "権限を確認中…",
    create: "ルールを追加",
    edit: "編集",
    retire: "停止",
    confirm: "停止を確定",
    cancel: "キャンセル",
    empty: "獲得ルールは未設定です。",
    readonly: "閲覧専用",
    unavailable: "結果を確認できません。変更前に再読み込みしてください。",
    saved: "ルールを保存しました。",
    legacy: "既存設定は編集前に確認が必要です。",
    constraints: "既存の期間・ランク制限を維持します。",
    active: "有効",
    inactive: "無効",
  },
  vi: {
    title: "Quy tắc tích điểm",
    reload: "Tải lại",
    loading: "Đang kiểm tra quyền…",
    create: "Quy tắc mới",
    edit: "Sửa",
    retire: "Ngừng áp dụng",
    confirm: "Xác nhận ngừng áp dụng",
    cancel: "Hủy",
    empty: "Chưa có quy tắc tích điểm.",
    readonly: "Chỉ có quyền xem",
    unavailable: "Chưa thể xác nhận kết quả. Hãy tải lại trước khi thay đổi.",
    saved: "Đã lưu quy tắc.",
    legacy: "Cần kiểm tra cấu hình cũ trước khi chỉnh sửa.",
    constraints: "Giữ nguyên giới hạn thời gian hoặc hạng hiện có.",
    active: "Kích hoạt",
    inactive: "Chưa kích hoạt",
  },
};
const button =
  "rounded border border-neutral-300 px-3 py-2 text-sm disabled:opacity-50";

function RuleDetails({
  rule,
  locale,
}: {
  rule: EarningRulesResponse["rules"][number];
  locale: EarningRuleLocale;
}) {
  if (!rule.fields) return null;
  const copy = earningRuleCopy[locale];
  const fields = rule.fields;
  const rows: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(fields)) {
    if (
      value === null ||
      key === "name" ||
      key === "isActive" ||
      key === "conditions"
    )
      continue;
    if (key === "multiplier" && fields.triggerCode !== "order_paid") continue;
    if (key === "excludeDiscountedItems" && fields.triggerCode !== "order_paid")
      continue;
    if (key === "excludeTaxesAndShipping") continue;
    const label = copy.fields[key as keyof EarningRuleForm];
    if (!label) continue;
    const text =
      key === "triggerCode"
        ? copy.triggers[fields.triggerCode]
        : key === "limitInterval" && fields.limitInterval
          ? copy.periods[fields.limitInterval]
          : typeof value === "boolean"
            ? value
              ? "✓"
              : "—"
            : String(value);
    rows.push([label, text]);
  }
  if (fields.conditions)
    for (const [key, value] of Object.entries<unknown>(fields.conditions)) {
      const label = copy.fields[key as keyof EarningRuleForm];
      if (label)
        rows.push([
          label,
          key === "provider" && (value === "native" || value === "judgeme")
            ? copy.providers[value]
            : String(value),
        ]);
    }
  return (
    <dl className="grid gap-2 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid gap-1 sm:grid-cols-2">
          <dt className="text-neutral-600">{label}</dt>
          <dd className="break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function EarningRulesSession({
  transport,
}: {
  transport: EarningRulesTransport;
}) {
  const [locale, setLocale] = React.useState<EarningRuleLocale>("en");
  const id = React.useId();
  return (
    <>
      <label
        htmlFor={id}
        className="mx-auto flex max-w-3xl items-center gap-2 px-4 pt-4"
      >
        {locale === "ja" ? "言語" : locale === "vi" ? "Ngôn ngữ" : "Language"}
        <select
          id={id}
          className={button}
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
      <EarningRulesScreen transport={transport} locale={locale} />
    </>
  );
}

export function EarningRulesScreen({
  transport,
  locale = "en",
}: {
  transport: EarningRulesTransport;
  locale?: EarningRuleLocale;
}) {
  const lock = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  // This lock survives scope-key remounts; an old in-flight write cannot enable
  // a second write in a newly selected workspace until it settles.
  const mutate = async (operation: () => Promise<EarningRulesResponse>) => {
    if (lock.current) return null;
    lock.current = true;
    setBusy(true);
    try {
      return await operation();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <ScopeScreen
      key={transport.scopeKey}
      transport={transport}
      locale={locale}
      busy={busy}
      mutate={mutate}
    />
  );
}

function ScopeScreen({
  transport,
  locale,
  busy,
  mutate,
}: {
  transport: EarningRulesTransport;
  locale: EarningRuleLocale;
  busy: boolean;
  mutate: (
    operation: () => Promise<EarningRulesResponse>,
  ) => Promise<EarningRulesResponse | null>;
}) {
  const copy = messages[locale];
  const [view, setView] = React.useState<EarningRulesResponse | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [editing, setEditing] = React.useState<{
    id: string | null;
    form: EarningRuleForm;
  } | null>(null);
  const [retiring, setRetiring] = React.useState<string | null>(null);
  const alive = React.useRef(false);
  const readId = React.useRef(0);
  const reload = React.useCallback(async () => {
    const id = ++readId.current;
    setView(null);
    setEditing(null);
    setRetiring(null);
    setLoading(true);
    setFailed(false);
    setSaved(false);
    try {
      const next = await transport.read();
      if (alive.current && id === readId.current) setView(next);
    } catch {
      if (alive.current && id === readId.current) setFailed(true);
    } finally {
      if (alive.current && id === readId.current) setLoading(false);
    }
  }, [transport]);
  React.useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload]);
  const write = async (operation: () => Promise<EarningRulesResponse>) => {
    if (!view?.capabilities.configure || failed || busy) return;
    const generation = readId.current;
    try {
      const next = await mutate(operation);
      if (next && alive.current && generation === readId.current) {
        setView(next);
        setEditing(null);
        setRetiring(null);
        setSaved(true);
      }
    } catch {
      if (alive.current && generation === readId.current) {
        setView(null);
        setEditing(null);
        setRetiring(null);
        setFailed(true);
      }
    }
  };
  return (
    <section
      lang={locale}
      className="mx-auto grid max-w-3xl gap-4 p-4"
      aria-busy={loading || busy}
    >
      <h1 className="text-xl font-semibold">{copy.title}</h1>
      <button
        type="button"
        className={button}
        disabled={busy || loading}
        onClick={() => void reload()}
      >
        {copy.reload}
      </button>
      {loading && <p role="status">{copy.loading}</p>}
      {failed && <p role="alert">{copy.unavailable}</p>}
      {saved && <p role="status">{copy.saved}</p>}
      {view && (
        <>
          <p className="text-sm text-neutral-600">
            {earningRuleCopy[locale].shopCurrency}:{" "}
            {view.shopCurrency ?? earningRuleCopy[locale].currencyUnavailable}.{" "}
            {earningRuleCopy[locale].currencyBasis}
          </p>
          {!view.capabilities.configure && <p>{copy.readonly}</p>}
          {view.capabilities.configure && !editing && (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => {
                setSaved(false);
                setRetiring(null);
                setEditing({ id: null, form: newEarningRuleForm() });
              }}
            >
              {copy.create}
            </button>
          )}
          {editing && view.capabilities.configure ? (
            <EarningRuleEditor
              value={editing.form}
              locale={locale}
              disabled={busy}
              onChange={(form) => setEditing({ ...editing, form })}
              onCancel={() => setEditing(null)}
              onSubmit={(rule) =>
                void write(() =>
                  transport.save({
                    expectedInstallationGeneration: view.installationGeneration,
                    expectedRevision: view.revision,
                    ruleId: editing.id,
                    rule,
                  }),
                )
              }
            />
          ) : (
            <>
              {view.rules.length === 0 && <p>{copy.empty}</p>}
              <ul className="grid gap-3">
                {view.rules.map((rule) => (
                  <li key={rule.id} className="grid gap-2 rounded border p-4">
                    <h2 className="font-medium">{rule.name}</h2>
                    <RuleDetails rule={rule} locale={locale} />
                    <p>{rule.isActive ? copy.active : copy.inactive}</p>
                    {rule.editUnavailableReason && <p>{copy.legacy}</p>}
                    {(rule.constraints.startAt ||
                      rule.constraints.endAt ||
                      rule.constraints.hasTierEligibility) && (
                      <p>{copy.constraints}</p>
                    )}
                    {view.capabilities.configure && (
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={button}
                          disabled={busy || !rule.fields}
                          onClick={() => {
                            if (rule.fields) {
                              setSaved(false);
                              setRetiring(null);
                              setEditing({
                                id: rule.id,
                                form: earningRuleFormFromFields(rule.fields),
                              });
                            }
                          }}
                        >
                          {copy.edit}
                        </button>
                        <button
                          type="button"
                          className={button}
                          disabled={busy}
                          onClick={() => setRetiring(rule.id)}
                        >
                          {copy.retire}
                        </button>
                        {retiring === rule.id && (
                          <>
                            <button
                              type="button"
                              className={button}
                              disabled={busy || !view.revision}
                              onClick={() => {
                                if (view.revision)
                                  void write(() =>
                                    transport.retire({
                                      expectedInstallationGeneration:
                                        view.installationGeneration,
                                      expectedRevision: view.revision!,
                                      ruleId: rule.id,
                                    }),
                                  );
                              }}
                            >
                              {copy.confirm}
                            </button>
                            <button
                              type="button"
                              className={button}
                              disabled={busy}
                              onClick={() => setRetiring(null)}
                            >
                              {copy.cancel}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
