import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import type {
  EarningRuleRetire,
  EarningRulesResponse,
  EarningRuleWrite,
} from "@weletic/contracts/loyalty/earning-rule-contract";
import React from "react";
import { useCoreLaunch } from "~/core-launch-context";
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
    language: "Language",
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
    language: "言語",
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
    language: "Ngôn ngữ",
  },
};

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
  if (fields.conditions) {
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
  }

  return (
    <BlockStack gap="200">
      {rows.map(([label, value]) => (
        <InlineStack key={label} align="space-between">
          <Text as="span" variant="bodySm" tone="subdued">
            {label}
          </Text>
          <Text as="span" variant="bodySm">
            {value}
          </Text>
        </InlineStack>
      ))}
    </BlockStack>
  );
}

export function EarningRulesSession({
  transport,
}: {
  transport: EarningRulesTransport;
}) {
  const [locale, setLocale] = React.useState<EarningRuleLocale>("en");
  const copy = messages[locale];

  return (
    <BlockStack gap="400">
      <InlineStack align="end">
        <Select
          label={copy.language}
          labelInline
          value={locale}
          options={[
            { label: "English", value: "en" },
            { label: "日本語", value: "ja" },
            { label: "Tiếng Việt", value: "vi" },
          ]}
          onChange={(value) => {
            if (value === "en" || value === "ja" || value === "vi")
              setLocale(value);
          }}
        />
      </InlineStack>
      <EarningRulesScreen transport={transport} locale={locale} />
    </BlockStack>
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
  const shopify = useAppBridge();
  const coreLaunch = useCoreLaunch();
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
        shopify.toast?.show?.(copy.saved);
      }
    } catch {
      if (alive.current && generation === readId.current) {
        setView(null);
        setEditing(null);
        setRetiring(null);
        setFailed(true);
        shopify.toast?.show?.(copy.unavailable, { isError: true });
      }
    }
  };

  return (
    <Page
      title={copy.title}
      primaryAction={
        view?.capabilities.configure && !editing
          ? {
              content: copy.create,
              onAction: () => {
                setSaved(false);
                setRetiring(null);
                setEditing({
                  id: null,
                  form: {
                    ...newEarningRuleForm(),
                    ...(coreLaunch
                      ? {
                          purchaseType: "one_time" as const,
                          subscriptionCadence: "first_payment" as const,
                          subscriptionPaymentLimit: "",
                        }
                      : {}),
                  },
                });
              },
              disabled: busy,
            }
          : undefined
      }
      secondaryActions={[
        {
          content: copy.reload,
          onAction: () => void reload(),
          disabled: busy || loading,
        },
      ]}
    >
      <BlockStack gap="400">
        {loading && (
          <Card>
            <Text as="p" tone="subdued">
              {copy.loading}
            </Text>
          </Card>
        )}
        {failed && (
          <Banner
            tone="critical"
            action={{
              content: copy.reload,
              onAction: () => void reload(),
              loading: busy || loading,
            }}
          >
            <p>{copy.unavailable}</p>
          </Banner>
        )}
        {saved && (
          <Banner tone="success">
            <p>{copy.saved}</p>
          </Banner>
        )}

        {view && (
          <>
            <Card>
              <Text as="p" variant="bodySm" tone="subdued">
                {earningRuleCopy[locale].shopCurrency}:{" "}
                {view.shopCurrency ??
                  earningRuleCopy[locale].currencyUnavailable}
                . {earningRuleCopy[locale].currencyBasis}
              </Text>
              {!view.capabilities.configure && (
                <Text as="p" tone="subdued">
                  {copy.readonly}
                </Text>
              )}
            </Card>

            {editing && view.capabilities.configure ? (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    {editing.id ? copy.edit : copy.create}
                  </Text>
                  <EarningRuleEditor
                    value={editing.form}
                    locale={locale}
                    disabled={busy}
                    onChange={(form) => setEditing({ ...editing, form })}
                    onCancel={() => setEditing(null)}
                    onSubmit={(rule) =>
                      void write(() =>
                        transport.save({
                          expectedInstallationGeneration:
                            view.installationGeneration,
                          expectedRevision: view.revision,
                          ruleId: editing.id,
                          rule,
                        }),
                      )
                    }
                  />
                </BlockStack>
              </Card>
            ) : (
              <BlockStack gap="300">
                {view.rules.length === 0 && (
                  <Card>
                    <Text as="p" tone="subdued">
                      {copy.empty}
                    </Text>
                  </Card>
                )}
                {view.rules.map((rule) => (
                  <Card key={rule.id}>
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h2" variant="headingSm">
                          {rule.name}
                        </Text>
                        <Badge tone={rule.isActive ? "success" : undefined}>
                          {rule.isActive ? copy.active : copy.inactive}
                        </Badge>
                      </InlineStack>

                      <RuleDetails rule={rule} locale={locale} />

                      {rule.editUnavailableReason && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {copy.legacy}
                        </Text>
                      )}
                      {(rule.constraints.startAt ||
                        rule.constraints.endAt ||
                        rule.constraints.hasTierEligibility) && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {copy.constraints}
                        </Text>
                      )}

                      {view.capabilities.configure && (
                        <InlineStack gap="200">
                          <Button
                            size="micro"
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
                          </Button>
                          <Button
                            size="micro"
                            tone="critical"
                            disabled={busy}
                            onClick={() => setRetiring(rule.id)}
                          >
                            {copy.retire}
                          </Button>
                          {retiring === rule.id && (
                            <InlineStack gap="100">
                              <Button
                                size="micro"
                                variant="primary"
                                tone="critical"
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
                              </Button>
                              <Button
                                size="micro"
                                disabled={busy}
                                onClick={() => setRetiring(null)}
                              >
                                {copy.cancel}
                              </Button>
                            </InlineStack>
                          )}
                        </InlineStack>
                      )}
                    </BlockStack>
                  </Card>
                ))}
              </BlockStack>
            )}
          </>
        )}
      </BlockStack>
    </Page>
  );
}
