import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { requiresUnverifiedSubscriptionCycle } from "@weletic/contracts/loyalty/purchase-policy";
import {
  referralConfigurationFieldsSchema,
  type ReferralConfigurationFields,
  type ReferralConfigurationPause,
  type ReferralConfigurationResponse,
  type ReferralConfigurationWrite,
} from "@weletic/contracts/loyalty/referral-configuration-contract";
import React from "react";

export type ReferralConfigurationTransport = {
  scopeKey: string;
  read: () => Promise<ReferralConfigurationResponse>;
  save: (
    input: ReferralConfigurationWrite,
  ) => Promise<ReferralConfigurationResponse>;
  pause: (
    input: ReferralConfigurationPause,
  ) => Promise<ReferralConfigurationResponse>;
};
const copy = {
  en: {
    title: "Referral configuration",
    reload: "Reload",
    language: "Language",
    save: "Save",
    pause: "Pause referrals",
    confirm: "Confirm pause",
    cancel: "Cancel",
    loading: "Checking access…",
    error: "Result unavailable or uncertain. Reload before changing settings.",
    saved: "Configuration saved.",
    readonly: "Read-only access",
    missing: "Configure a loyalty program and store currency first.",
    legacy:
      "Legacy terms require review. You can still pause referrals without rewriting them.",
    invalid:
      "Check the highlighted fields. Coupon rewards require an eligible catalog reward.",
    advocate: "Advocate",
    referee: "Friend",
    kind: "Reward kind",
    points: "Points",
    coupon: "Coupon",
    choose: "Select a reward",
    minimum: "Minimum order subtotal (major currency units)",
    maximum: "Maximum referrals per advocate (blank: unlimited)",
    fraud: "Flag matching IP addresses for fraud review",
    active: "Enable referrals",
    purchaseType: "Qualifying purchase type",
    cadence: "Eligible subscription payments",
    paymentLimit: "Eligible payment count",
    oneTime: "One-time purchases",
    subscription: "Subscriptions",
    both: "Both",
    firstPayment: "First payment",
    firstNPayments: "First N payments",
    everyPayment: "Every renewal",
    cadenceUnavailable:
      "First-payment and first-N referral qualification are unavailable until subscription billing cycles can be verified. Subscription-only orders under existing rules are held for reconciliation; choose every renewal or pause referrals.",
    note: "A referral can qualify only once, using eligible line subtotal and the rule current at qualification. Selecting a catalog coupon does not issue it. Weletic interprets Shopify subscription orders but does not sell or manage subscriptions. Issued rewards and recorded history remain unchanged.",
    status: "Status",
    enabled: "Active",
    disabled: "Inactive",
  },
  ja: {
    title: "紹介プログラム設定",
    reload: "再読み込み",
    language: "言語",
    save: "保存",
    pause: "紹介を停止",
    confirm: "停止を確定",
    cancel: "キャンセル",
    loading: "権限を確認中…",
    error: "結果を確認できません。変更前に再読み込みしてください。",
    saved: "設定を保存しました。",
    readonly: "閲覧専用",
    missing: "先にポイントプログラムと店舗通貨を設定してください。",
    legacy: "既存条件は確認が必要です。条件を変更せずに紹介を停止できます。",
    invalid:
      "入力項目を確認してください。クーポンには利用可能な特典が必要です。",
    advocate: "紹介者",
    referee: "友達",
    kind: "特典の種類",
    points: "ポイント",
    coupon: "クーポン",
    choose: "特典を選択",
    minimum: "最低注文小計（通貨の基本単位）",
    maximum: "紹介者ごとの上限（空欄：無制限）",
    fraud: "同一IPを不正確認の対象にする",
    active: "紹介を有効にする",
    purchaseType: "対象となる購入種類",
    cadence: "対象となる定期購入支払い",
    paymentLimit: "対象支払い回数",
    oneTime: "通常購入",
    subscription: "定期購入",
    both: "両方",
    firstPayment: "初回支払い",
    firstNPayments: "最初のN回",
    everyPayment: "すべての更新",
    cadenceUnavailable:
      "定期購入の請求回を確認できるまで、初回および最初のN回の紹介達成は利用できません。既存の該当ルールによる定期購入のみの注文は照合待ちになります。すべての更新を選ぶか、紹介を停止してください。",
    note: "紹介は、達成時点のルールと対象明細の小計に基づき一度だけ達成できます。特典の選択だけではクーポンを発行しません。WeleticはShopifyの定期購入注文を判定しますが、定期購入の販売・契約管理は行いません。発行済み特典と履歴は変更しません。",
    status: "状態",
    enabled: "有効",
    disabled: "無効",
  },
  vi: {
    title: "Cấu hình giới thiệu",
    reload: "Tải lại",
    language: "Ngôn ngữ",
    save: "Lưu",
    pause: "Tạm dừng giới thiệu",
    confirm: "Xác nhận tạm dừng",
    cancel: "Hủy",
    loading: "Đang kiểm tra quyền…",
    error: "Chưa xác nhận được kết quả. Hãy tải lại trước khi thay đổi.",
    saved: "Đã lưu cấu hình.",
    readonly: "Chỉ có quyền xem",
    missing: "Hãy cấu hình chương trình điểm và tiền tệ cửa hàng trước.",
    legacy:
      "Điều khoản cũ cần được kiểm tra. Vẫn có thể tạm dừng mà không sửa điều khoản.",
    invalid:
      "Hãy kiểm tra các trường. Phần thưởng coupon cần một phần thưởng hợp lệ trong danh mục.",
    advocate: "Người giới thiệu",
    referee: "Bạn bè",
    kind: "Loại phần thưởng",
    points: "Điểm",
    coupon: "Coupon",
    choose: "Chọn phần thưởng",
    minimum: "Giá trị đơn tối thiểu (đơn vị tiền tệ chính)",
    maximum: "Số lượt tối đa mỗi người giới thiệu (trống: không giới hạn)",
    fraud: "Đánh dấu IP trùng để kiểm tra gian lận",
    active: "Bật giới thiệu",
    purchaseType: "Loại mua hàng đủ điều kiện",
    cadence: "Thanh toán đăng ký đủ điều kiện",
    paymentLimit: "Số lần thanh toán đủ điều kiện",
    oneTime: "Mua một lần",
    subscription: "Đăng ký",
    both: "Cả hai",
    firstPayment: "Lần đầu",
    firstNPayments: "N lần đầu",
    everyPayment: "Mọi lần gia hạn",
    cadenceUnavailable:
      "Chưa thể xét giới thiệu theo lần đầu hoặc N lần đầu đến khi xác minh được kỳ thanh toán đăng ký. Đơn chỉ có sản phẩm đăng ký theo quy tắc hiện có sẽ được giữ để đối soát. Hãy chọn mọi lần gia hạn hoặc tạm dừng giới thiệu.",
    note: "Mỗi lượt giới thiệu chỉ đạt điều kiện một lần, theo tổng phụ của các dòng hợp lệ và quy tắc tại thời điểm đó. Chọn coupon không phát hành coupon. Weletic chỉ diễn giải đơn đăng ký từ Shopify, không bán hay quản lý hợp đồng đăng ký. Phần thưởng đã phát hành và lịch sử không thay đổi.",
    status: "Trạng thái",
    enabled: "Đang bật",
    disabled: "Đã tắt",
  },
};
type Locale = keyof typeof copy;
const button =
  "rounded border border-neutral-300 px-3 py-2 text-sm disabled:opacity-50";
const control = "w-full rounded border border-neutral-300 p-2";

function ConfigurationForm({
  view,
  locale,
  busy,
  onSave,
}: {
  view: ReferralConfigurationResponse;
  locale: Locale;
  busy: boolean;
  onSave: (fields: ReferralConfigurationFields) => void;
}) {
  const [fields, setFields] = React.useState(view.fields!);
  const [maximum, setMaximum] = React.useState(
    fields.maxReferralsPerAdvocate?.toString() ?? "",
  );
  const [errors, setErrors] = React.useState<string[]>([]);
  const text = copy[locale];
  const update = <K extends keyof ReferralConfigurationFields>(
    key: K,
    value: ReferralConfigurationFields[K],
  ) => setFields((old) => ({ ...old, [key]: value }));
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = referralConfigurationFieldsSchema.safeParse({
      ...fields,
      maxReferralsPerAdvocate:
        maximum === ""
          ? null
          : /^[1-9]\d{0,6}$/.test(maximum)
            ? Number(maximum)
            : NaN,
    });
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((issue) => String(issue.path[0])));
      return;
    }
    if (
      parsed.data.isActive &&
      requiresUnverifiedSubscriptionCycle(parsed.data)
    ) {
      setErrors(["subscriptionCadence"]);
      return;
    }
    const fraction =
      parsed.data.minQualifyingOrderSubtotal
        ?.split(".")[1]
        ?.replace(/0+$/, "") ?? "";
    if (fraction.length > (view.thresholdDecimalPlaces ?? 0)) {
      setErrors(["minQualifyingOrderSubtotal"]);
      return;
    }
    setErrors([]);
    onSave(parsed.data);
  };
  return (
    <form onSubmit={submit}>
      <BlockStack gap="400">
        {errors.length > 0 && (
          <Banner tone="critical">
            <p role="alert">{text.invalid}</p>
          </Banner>
        )}
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
          {(["advocate", "referee"] as const).map((side) => (
            <Card key={side}>
              <BlockStack gap="300">
                <Text as="h3" variant="headingSm">
                  {text[side]}
                </Text>
                <Select
                  label={text.kind}
                  disabled={busy}
                  options={[
                    { label: text.points, value: "points" },
                    { label: text.coupon, value: "coupon" },
                  ]}
                  value={fields[`${side}RewardKind`]}
                  onChange={(val) => {
                    const kind = val === "coupon" ? "coupon" : "points";
                    setFields((old) => ({
                      ...old,
                      [`${side}RewardKind`]: kind,
                      [`${side}RewardDefinitionId`]: null,
                      [`${side}PointsReward`]: "0",
                    }));
                  }}
                />
                {fields[`${side}RewardKind`] === "points" ? (
                  <TextField
                    label={text.points}
                    disabled={busy}
                    type="number"
                    autoComplete="off"
                    value={fields[`${side}PointsReward`]}
                    error={errors.includes(`${side}PointsReward`)}
                    onChange={(val) => update(`${side}PointsReward`, val)}
                  />
                ) : (
                  <Select
                    label={text.coupon}
                    disabled={busy}
                    error={errors.includes(`${side}RewardDefinitionId`)}
                    options={[
                      { label: text.choose, value: "" },
                      ...(fields[`${side}RewardDefinitionId`] &&
                      !view.couponOptions.some(
                        (row) => row.id === fields[`${side}RewardDefinitionId`],
                      )
                        ? [
                            {
                              label: `${text.choose} — ${fields[`${side}RewardDefinitionId`]}`,
                              value: fields[`${side}RewardDefinitionId`] ?? "",
                              disabled: true,
                            },
                          ]
                        : []),
                      ...view.couponOptions.map((row) => ({
                        label: `${row.name} · ${row.rewardType}`,
                        value: row.id,
                      })),
                    ]}
                    value={fields[`${side}RewardDefinitionId`] ?? ""}
                    onChange={(val) =>
                      update(`${side}RewardDefinitionId`, val || null)
                    }
                  />
                )}
              </BlockStack>
            </Card>
          ))}
        </InlineGrid>
        <Card>
          <BlockStack gap="300">
            <TextField
              label={`${text.minimum} · ${view.shopCurrency}`}
              disabled={busy}
              autoComplete="off"
              value={fields.minQualifyingOrderSubtotal ?? ""}
              error={errors.includes("minQualifyingOrderSubtotal")}
              onChange={(val) =>
                update("minQualifyingOrderSubtotal", val || null)
              }
            />
            <TextField
              label={text.maximum}
              disabled={busy}
              type="number"
              autoComplete="off"
              value={maximum}
              error={errors.includes("maxReferralsPerAdvocate")}
              onChange={(val) => setMaximum(val)}
            />
            <Select
              label={text.purchaseType}
              disabled={busy}
              options={[
                { label: text.oneTime, value: "one_time" },
                { label: text.subscription, value: "subscription" },
                { label: text.both, value: "both" },
              ]}
              value={fields.purchaseType}
              onChange={(val) => {
                const purchaseType = val as
                  | "one_time"
                  | "subscription"
                  | "both";
                setFields((old) => ({
                  ...old,
                  purchaseType,
                  subscriptionCadence:
                    purchaseType === "one_time"
                      ? "first_payment"
                      : old.subscriptionCadence,
                  subscriptionPaymentLimit:
                    purchaseType === "one_time"
                      ? null
                      : old.subscriptionPaymentLimit,
                }));
              }}
            />
            {fields.purchaseType !== "one_time" && (
              <Select
                label={text.cadence}
                disabled={busy}
                options={[
                  {
                    label: text.firstPayment,
                    value: "first_payment",
                    disabled: true,
                  },
                  {
                    label: text.firstNPayments,
                    value: "first_n_payments",
                    disabled: true,
                  },
                  { label: text.everyPayment, value: "every_payment" },
                ]}
                value={fields.subscriptionCadence}
                onChange={(val) => {
                  const subscriptionCadence = val as
                    | "first_payment"
                    | "first_n_payments"
                    | "every_payment";
                  setFields((old) => ({
                    ...old,
                    subscriptionCadence,
                    subscriptionPaymentLimit:
                      subscriptionCadence === "first_n_payments"
                        ? old.subscriptionPaymentLimit ?? 2
                        : null,
                  }));
                }}
              />
            )}
            {fields.purchaseType !== "one_time" && (
              <Text as="p" tone="caution">
                {text.cadenceUnavailable}
              </Text>
            )}
            {fields.purchaseType !== "one_time" &&
              fields.subscriptionCadence === "first_n_payments" && (
                <TextField
                  label={text.paymentLimit}
                  disabled={busy}
                  type="number"
                  autoComplete="off"
                  value={
                    fields.subscriptionPaymentLimit === null ||
                    fields.subscriptionPaymentLimit === undefined
                      ? ""
                      : String(fields.subscriptionPaymentLimit)
                  }
                  error={errors.includes("subscriptionPaymentLimit")}
                  onChange={(val) =>
                    update(
                      "subscriptionPaymentLimit",
                      /^\d+$/.test(val) ? Number(val) : null,
                    )
                  }
                />
              )}
            <Checkbox
              label={text.fraud}
              disabled={busy}
              checked={fields.fraudCheckSameIp}
              onChange={(checked) => update("fraudCheckSameIp", checked)}
            />
            <Checkbox
              label={text.active}
              disabled={busy}
              checked={fields.isActive}
              onChange={(checked) => update("isActive", checked)}
            />
            <InlineStack gap="300">
              <Button submit variant="primary" disabled={busy}>
                {text.save}
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>
    </form>
  );
}

function ConfigurationVisit({
  transport,
  locked,
}: {
  transport: ReferralConfigurationTransport;
  locked: boolean;
}) {
  const shopify = useAppBridge();
  const [locale, setLocale] = React.useState<Locale>("en");
  const [view, setView] = React.useState<ReferralConfigurationResponse | null>(
    null,
  );
  const [loading, setLoading] = React.useState(true);
  const [reload, setReload] = React.useState(0);
  const [error, setError] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [confirm, setConfirm] = React.useState(false);
  const visit = React.useRef<object | null>(null);
  const pending = React.useRef<object | null>(null);
  React.useEffect(() => {
    const ticket = {};
    visit.current = ticket;
    pending.current = null;
    setLoading(true);
    setView(null);
    setError(false);
    setSaved(false);
    setConfirm(false);
    transport
      .read()
      .then((data) => {
        if (visit.current === ticket) setView(data);
      })
      .catch(() => {
        if (visit.current === ticket) setError(true);
      })
      .finally(() => {
        if (visit.current === ticket) setLoading(false);
      });
    return () => {
      if (visit.current === ticket) visit.current = null;
    };
  }, [transport, reload]);
  const busy = loading || locked;
  const mutate = async (
    operation: () => Promise<ReferralConfigurationResponse>,
  ) => {
    if (!view?.capabilities.configure || busy || pending.current) return;
    const ticket = {};
    const current = visit.current;
    pending.current = ticket;
    setSaved(false);
    try {
      const result = await operation();
      if (visit.current !== current || pending.current !== ticket) return;
      if (
        result.storeId !== view.storeId ||
        result.programId !== view.programId ||
        result.shopCurrency !== view.shopCurrency
      )
        throw new Error("Scope changed");
      setView(result);
      setConfirm(false);
      setSaved(true);
      shopify.toast?.show?.(text.saved);
    } catch {
      if (visit.current === current && pending.current === ticket) {
        setView(null);
        setError(true);
        setConfirm(false);
        shopify.toast?.show?.(text.error, { isError: true });
      }
    } finally {
      if (pending.current === ticket) pending.current = null;
    }
  };
  const expected = view
    ? {
        expectedRevision: view.revision,
        expectedInstallationGeneration: view.installationGeneration,
      }
    : null;
  const text = copy[locale];
  return (
    <section className="mx-auto grid w-full max-w-4xl gap-4 p-4">
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h1" variant="headingLg">
            {text.title}
          </Text>
          <div style={{ minWidth: 150 }}>
            <Select
              label={text.language}
              labelHidden
              options={[
                { label: "English", value: "en" },
                { label: "日本語", value: "ja" },
                { label: "Tiếng Việt", value: "vi" },
              ]}
              value={locale}
              onChange={(val) => setLocale(val as Locale)}
            />
          </div>
        </InlineStack>
        <Text as="p" tone="subdued">
          {text.note}
        </Text>
        <InlineStack gap="300">
          <Button
            disabled={busy}
            onClick={() => setReload((value) => value + 1)}
          >
            {text.reload}
          </Button>
        </InlineStack>
        {loading && <p role="status">{text.loading}</p>}
        {error && (
          <Banner tone="critical">
            <p role="alert">{text.error}</p>
          </Banner>
        )}
        {saved && (
          <Banner tone="success" onDismiss={() => setSaved(false)}>
            <p role="status">{text.saved}</p>
          </Banner>
        )}
        {view && (
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="200">
                <Text as="p">
                  {text.status}: {view.active ? text.enabled : text.disabled}
                </Text>
                {!view.capabilities.configure && (
                  <Banner tone="info">
                    <p>{text.readonly}</p>
                  </Banner>
                )}
                {(!view.programId || !view.shopCurrency) && (
                  <Banner tone="warning">
                    <p>{text.missing}</p>
                  </Banner>
                )}
                {view.legacyConfiguration && (
                  <Banner tone="warning">
                    <p>{text.legacy}</p>
                  </Banner>
                )}
                {view.capabilities.configure &&
                  view.programId &&
                  view.active && (
                    <InlineStack gap="300">
                      <Button disabled={busy} onClick={() => setConfirm(true)}>
                        {text.pause}
                      </Button>
                      {confirm && (
                        <div role="group" aria-label={text.confirm}>
                          <InlineStack gap="200">
                            <Button
                              tone="critical"
                              variant="primary"
                              disabled={busy}
                              onClick={() =>
                                mutate(() => transport.pause(expected!))
                              }
                            >
                              {text.confirm}
                            </Button>
                            <Button
                              disabled={busy}
                              onClick={() => setConfirm(false)}
                            >
                              {text.cancel}
                            </Button>
                          </InlineStack>
                        </div>
                      )}
                    </InlineStack>
                  )}
              </BlockStack>
            </Card>
            {view.fields && view.programId && view.shopCurrency && (
              <ConfigurationForm
                key={view.revision}
                view={view}
                locale={locale}
                busy={busy || !view.capabilities.configure}
                onSave={(fields) =>
                  mutate(() =>
                    transport.save({
                      ...expected!,
                      ruleId: view.ruleId,
                      fields,
                    }),
                  )
                }
              />
            )}
          </BlockStack>
        )}
      </BlockStack>
    </section>
  );
}

export function ReferralConfigurationSession({
  transport,
}: {
  transport: ReferralConfigurationTransport;
}) {
  const pending = React.useRef<object | null>(null);
  const active = React.useRef(false);
  const [locked, setLocked] = React.useState(false);
  React.useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const guarded = React.useMemo(() => {
    const run = async (
      operation: () => Promise<ReferralConfigurationResponse>,
    ) => {
      if (pending.current) throw new Error("Referral write pending");
      const ticket = {};
      pending.current = ticket;
      setLocked(true);
      try {
        return await operation();
      } finally {
        if (pending.current === ticket) {
          pending.current = null;
          if (active.current) setLocked(false);
        }
      }
    };
    return {
      ...transport,
      save: (input: ReferralConfigurationWrite) =>
        run(() => transport.save(input)),
      pause: (input: ReferralConfigurationPause) =>
        run(() => transport.pause(input)),
    };
  }, [transport]);
  return (
    <ConfigurationVisit
      key={transport.scopeKey}
      transport={guarded}
      locked={locked}
    />
  );
}
