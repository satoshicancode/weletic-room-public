"use client";
import React from "react";
import {
  referralConfigurationFieldsSchema,
  type ReferralConfigurationFields,
  type ReferralConfigurationPause,
  type ReferralConfigurationResponse,
  type ReferralConfigurationWrite,
} from "../../../lib/weletic/loyalty/referral-configuration-contract";

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
    <form onSubmit={submit} className="grid gap-4">
      {errors.length > 0 && <p role="alert">{text.invalid}</p>}
      <fieldset disabled={busy} className="grid gap-4">
        {(["advocate", "referee"] as const).map((side) => (
          <fieldset key={side} className="grid gap-3 rounded border p-3">
            <legend>{text[side]}</legend>
            <label>
              {text.kind}
              <select
                className={control}
                value={fields[`${side}RewardKind`]}
                onChange={(event) => {
                  const kind =
                    event.target.value === "coupon" ? "coupon" : "points";
                  setFields((old) => ({
                    ...old,
                    [`${side}RewardKind`]: kind,
                    [`${side}RewardDefinitionId`]: null,
                    [`${side}PointsReward`]: "0",
                  }));
                }}
              >
                <option value="points">{text.points}</option>
                <option value="coupon">{text.coupon}</option>
              </select>
            </label>
            {fields[`${side}RewardKind`] === "points" ? (
              <label>
                {text.points}
                <input
                  className={control}
                  inputMode="numeric"
                  value={fields[`${side}PointsReward`]}
                  aria-invalid={errors.includes(`${side}PointsReward`)}
                  onChange={(event) =>
                    update(`${side}PointsReward`, event.target.value)
                  }
                />
              </label>
            ) : (
              <label>
                {text.coupon}
                <select
                  className={control}
                  value={fields[`${side}RewardDefinitionId`] ?? ""}
                  aria-invalid={errors.includes(`${side}RewardDefinitionId`)}
                  onChange={(event) =>
                    update(
                      `${side}RewardDefinitionId`,
                      event.target.value || null,
                    )
                  }
                >
                  <option value="">{text.choose}</option>
                  {fields[`${side}RewardDefinitionId`] &&
                    !view.couponOptions.some(
                      (row) => row.id === fields[`${side}RewardDefinitionId`],
                    ) && (
                      <option
                        value={fields[`${side}RewardDefinitionId`] ?? ""}
                        disabled
                      >
                        {text.choose} — {fields[`${side}RewardDefinitionId`]}
                      </option>
                    )}
                  {view.couponOptions.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.name} · {row.rewardType}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
        ))}
        <label>
          {text.minimum} · {view.shopCurrency}
          <input
            className={control}
            inputMode="decimal"
            value={fields.minQualifyingOrderSubtotal ?? ""}
            aria-invalid={errors.includes("minQualifyingOrderSubtotal")}
            onChange={(event) =>
              update("minQualifyingOrderSubtotal", event.target.value || null)
            }
          />
        </label>
        <label>
          {text.maximum}
          <input
            className={control}
            inputMode="numeric"
            value={maximum}
            aria-invalid={errors.includes("maxReferralsPerAdvocate")}
            onChange={(event) => setMaximum(event.target.value)}
          />
        </label>
        <label>
          {text.purchaseType}
          <select
            className={control}
            value={fields.purchaseType}
            onChange={(event) => {
              const purchaseType = event.target.value as
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
          >
            <option value="one_time">{text.oneTime}</option>
            <option value="subscription">{text.subscription}</option>
            <option value="both">{text.both}</option>
          </select>
        </label>
        {fields.purchaseType !== "one_time" && (
          <label>
            {text.cadence}
            <select
              className={control}
              value={fields.subscriptionCadence}
              onChange={(event) => {
                const subscriptionCadence = event.target.value as
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
            >
              <option value="first_payment">{text.firstPayment}</option>
              <option value="first_n_payments">{text.firstNPayments}</option>
              <option value="every_payment">{text.everyPayment}</option>
            </select>
          </label>
        )}
        {fields.purchaseType !== "one_time" &&
          fields.subscriptionCadence === "first_n_payments" && (
            <label>
              {text.paymentLimit}
              <input
                className={control}
                inputMode="numeric"
                value={fields.subscriptionPaymentLimit ?? ""}
                aria-invalid={errors.includes("subscriptionPaymentLimit")}
                onChange={(event) =>
                  update(
                    "subscriptionPaymentLimit",
                    /^\d+$/.test(event.target.value)
                      ? Number(event.target.value)
                      : null,
                  )
                }
              />
            </label>
          )}
        <label>
          <input
            type="checkbox"
            checked={fields.fraudCheckSameIp}
            onChange={(event) =>
              update("fraudCheckSameIp", event.target.checked)
            }
          />{" "}
          {text.fraud}
        </label>
        <label>
          <input
            type="checkbox"
            checked={fields.isActive}
            onChange={(event) => update("isActive", event.target.checked)}
          />{" "}
          {text.active}
        </label>
      </fieldset>
      <button className={button} disabled={busy} type="submit">
        {text.save}
      </button>
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
    } catch {
      if (visit.current === current && pending.current === ticket) {
        setView(null);
        setError(true);
        setConfirm(false);
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{text.title}</h1>
        <label>
          {text.language}
          <select
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            <option value="en">English</option>
            <option value="ja">日本語</option>
            <option value="vi">Tiếng Việt</option>
          </select>
        </label>
      </div>
      <p className="text-sm text-neutral-600">{text.note}</p>
      <button
        className={button}
        disabled={busy}
        onClick={() => setReload((value) => value + 1)}
      >
        {text.reload}
      </button>
      {loading && <p role="status">{text.loading}</p>}
      {error && <p role="alert">{text.error}</p>}
      {saved && <p role="status">{text.saved}</p>}
      {view && (
        <>
          <p>
            {text.status}: {view.active ? text.enabled : text.disabled}
          </p>
          {!view.capabilities.configure && <p>{text.readonly}</p>}
          {(!view.programId || !view.shopCurrency) && <p>{text.missing}</p>}
          {view.legacyConfiguration && <p>{text.legacy}</p>}
          {view.capabilities.configure && view.programId && view.active && (
            <>
              <button
                className={button}
                disabled={busy}
                onClick={() => setConfirm(true)}
              >
                {text.pause}
              </button>
              {confirm && (
                <div role="group" aria-label={text.confirm}>
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => mutate(() => transport.pause(expected!))}
                  >
                    {text.confirm}
                  </button>
                  <button
                    className={button}
                    disabled={busy}
                    onClick={() => setConfirm(false)}
                  >
                    {text.cancel}
                  </button>
                </div>
              )}
            </>
          )}
          {view.fields && view.programId && view.shopCurrency && (
            <ConfigurationForm
              key={view.revision}
              view={view}
              locale={locale}
              busy={busy || !view.capabilities.configure}
              onSave={(fields) =>
                mutate(() =>
                  transport.save({ ...expected!, ruleId: view.ruleId, fields }),
                )
              }
            />
          )}
        </>
      )}
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
