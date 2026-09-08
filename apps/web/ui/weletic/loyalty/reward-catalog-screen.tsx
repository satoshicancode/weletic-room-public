"use client";
import React from "react";
import type {
  RewardCatalogContain,
  RewardCatalogFields,
  RewardCatalogResponse,
  RewardCatalogWrite,
} from "../../../lib/weletic/loyalty/reward-catalog-contract";
import {
  changeRewardCatalogType,
  newRewardCatalogFields,
  parseRewardCatalogForm,
  rewardCatalogFormFromFields,
  type RewardCatalogForm,
} from "./reward-catalog-form";

type Locale = "en" | "ja" | "vi";
export type RewardCatalogTransport = {
  scopeKey: string;
  read: () => Promise<RewardCatalogResponse>;
  save: (input: RewardCatalogWrite) => Promise<RewardCatalogResponse>;
  contain: (input: RewardCatalogContain) => Promise<RewardCatalogResponse>;
};
const copy = {
  en: {
    title: "Reward catalog",
    currencyUnavailable:
      "Currency unavailable: economic edits are disabled; pause/archive remains available.",
    pause: "Pause",
    archive: "Archive",
    confirm: "Confirm status change",
    language: "Language",
    filter: "Status filter",
    all: "All rewards",
    details: "Configuration",
    load: "Checking access…",
    reload: "Reload",
    create: "New reward",
    edit: "Edit",
    save: "Save",
    cancel: "Cancel",
    empty: "No rewards configured.",
    readonly: "Read-only access",
    legacy: "Legacy configuration requires review before editing.",
    error: "Result unavailable or uncertain. Reload before making changes.",
    invalid: "Check the highlighted configuration fields.",
    saved: "Reward saved.",
    note: "Values use minor currency units (JPY 1 = 1; USD 1 = 100). Type changes reset incompatible draft settings. Blank code usage defaults to one use. Subscription settings are not available yet. Product rewards are capped discounts, not guaranteed free items. Gift Card/Store Credit checkout acceptance remains gated; code-use controls do not apply to them.",
  },
  ja: {
    title: "特典カタログ",
    currencyUnavailable:
      "通貨を確認できないため金額設定は変更できません。停止・アーカイブは可能です。",
    pause: "停止",
    archive: "アーカイブ",
    confirm: "状態変更を確定",
    language: "言語",
    filter: "状態で絞り込み",
    all: "すべての特典",
    details: "設定内容",
    load: "権限を確認中…",
    reload: "再読み込み",
    create: "特典を追加",
    edit: "編集",
    save: "保存",
    cancel: "キャンセル",
    empty: "特典は未設定です。",
    readonly: "閲覧専用",
    legacy: "既存設定は編集前に確認が必要です。",
    error: "結果を確認できません。変更前に再読み込みしてください。",
    invalid: "設定項目を確認してください。",
    saved: "特典を保存しました。",
    note: "金額は最小通貨単位です（1円 = 1、1米ドル = 100）。種類を変更すると対応しない下書き設定を初期化します。コード利用回数が空欄の場合は1回です。定期購入設定は未対応です。商品特典は上限付き割引で、必ず無料になるわけではありません。ギフトカード・ストアクレジットの決済検証は未完了で、コード利用制限は適用されません。",
  },
  vi: {
    title: "Danh mục phần thưởng",
    currencyUnavailable:
      "Chưa xác định được tiền tệ: không thể sửa giá trị; vẫn có thể tạm dừng hoặc lưu trữ.",
    pause: "Tạm dừng",
    archive: "Lưu trữ",
    confirm: "Xác nhận đổi trạng thái",
    language: "Ngôn ngữ",
    filter: "Lọc trạng thái",
    all: "Tất cả phần thưởng",
    details: "Cấu hình",
    load: "Đang kiểm tra quyền…",
    reload: "Tải lại",
    create: "Phần thưởng mới",
    edit: "Sửa",
    save: "Lưu",
    cancel: "Hủy",
    empty: "Chưa có phần thưởng.",
    readonly: "Chỉ có quyền xem",
    legacy: "Cần kiểm tra cấu hình cũ trước khi sửa.",
    error: "Chưa thể xác nhận kết quả. Hãy tải lại trước khi thay đổi.",
    invalid: "Hãy kiểm tra các trường cấu hình.",
    saved: "Đã lưu phần thưởng.",
    note: "Số tiền dùng đơn vị tiền tệ nhỏ nhất (1 JPY = 1; 1 USD = 100). Đổi loại sẽ đặt lại cấu hình nháp không tương thích. Để trống số lần dùng mã nghĩa là một lần. Chưa hỗ trợ cấu hình đơn hàng định kỳ. Quà sản phẩm là giảm giá có giới hạn, không đảm bảo miễn phí. Thanh toán Gift Card/Store Credit chưa được nghiệm thu; giới hạn sử dụng mã không áp dụng cho hai loại này.",
  },
};
const labels: Record<keyof RewardCatalogForm, [string, string, string]> = {
  name: ["Name", "名前", "Tên"],
  description: ["Description", "説明", "Mô tả"],
  rewardType: ["Reward type", "特典の種類", "Loại phần thưởng"],
  salesChannel: ["Channel", "チャネル", "Kênh"],
  exchangeType: ["Exchange type", "交換方式", "Kiểu đổi"],
  pointsCost: ["Reference point cost", "基準ポイント数", "Điểm đổi cơ sở"],
  pointsStep: ["Point step", "ポイント刻み", "Bước điểm"],
  minPointsCost: ["Minimum points", "最小ポイント", "Điểm tối thiểu"],
  maxPointsCost: ["Maximum points", "最大ポイント", "Điểm tối đa"],
  discountValue: ["Value / percentage", "金額・割引率", "Giá trị / phần trăm"],
  maxDiscountValue: [
    "Discount cap (minor units)",
    "割引上限（最小通貨単位）",
    "Giới hạn giảm giá (đơn vị nhỏ nhất)",
  ],
  minOrderAmount: [
    "Minimum order (minor units)",
    "最低注文額（最小通貨単位）",
    "Giá trị đơn tối thiểu (đơn vị nhỏ nhất)",
  ],
  appliesToResource: ["Item scope", "対象範囲", "Phạm vi sản phẩm"],
  entitledProductIds: [
    "Product GIDs (one per line)",
    "商品GID（1行に1件）",
    "GID sản phẩm (mỗi dòng một mã)",
  ],
  entitledVariantIds: [
    "Variant GIDs (one per line)",
    "バリエーションGID（1行に1件）",
    "GID biến thể (mỗi dòng một mã)",
  ],
  entitledCollectionIds: [
    "Collection GIDs (one per line)",
    "コレクションGID（1行に1件）",
    "GID bộ sưu tập (mỗi dòng một mã)",
  ],
  combinesWithOrderDiscounts: [
    "Combine order discounts",
    "注文割引との併用",
    "Kết hợp giảm giá đơn",
  ],
  combinesWithProductDiscounts: [
    "Combine product discounts",
    "商品割引との併用",
    "Kết hợp giảm giá sản phẩm",
  ],
  combinesWithShippingDiscounts: [
    "Combine shipping discounts",
    "送料割引との併用",
    "Kết hợp giảm phí vận chuyển",
  ],
  usageLimit: ["Code usage limit", "コード利用回数", "Giới hạn dùng mã"],
  usageLimitPerCustomer: [
    "Once per customer (1) / no restriction (0)",
    "顧客ごと1回（1）・制限なし（0）",
    "Một lần mỗi khách (1) / không giới hạn (0)",
  ],
  expiresInDays: [
    "Expiry days (blank: none)",
    "有効日数（空欄：無期限）",
    "Số ngày hết hạn (trống: không hạn)",
  ],
  status: ["Status", "状態", "Trạng thái"],
};
const options: Partial<
  Record<keyof RewardCatalogForm, Array<[string, string, string, string]>>
> = {
  rewardType: [
    ["amount_off", "Amount off", "定額割引", "Giảm số tiền"],
    ["percentage_off", "Percentage off", "定率割引", "Giảm phần trăm"],
    ["free_shipping", "Free shipping", "送料無料", "Miễn phí vận chuyển"],
    [
      "free_product",
      "Capped product discount",
      "上限付き商品割引",
      "Giảm giá sản phẩm có giới hạn",
    ],
    [
      "gift_card",
      "Gift Card (gated)",
      "ギフトカード（検証待ち）",
      "Gift Card (chưa nghiệm thu)",
    ],
    [
      "store_credit",
      "Store Credit (gated)",
      "ストアクレジット（検証待ち）",
      "Store Credit (chưa nghiệm thu)",
    ],
  ],
  exchangeType: [
    ["fixed", "Fixed", "固定", "Cố định"],
    ["incremental", "Incremental", "段階式", "Theo bước"],
  ],
  status: [
    ["inactive", "Inactive", "無効", "Chưa kích hoạt"],
    ["active", "Active", "有効", "Kích hoạt"],
    ["archived", "Archived", "アーカイブ", "Lưu trữ"],
  ],
  appliesToResource: [
    ["entire_order", "Entire order", "注文全体", "Toàn bộ đơn"],
    [
      "specific_items",
      "Products/variants OR collections",
      "商品・バリエーション、またはコレクション",
      "Sản phẩm/biến thể HOẶC bộ sưu tập",
    ],
  ],
  usageLimitPerCustomer: [
    ["1", "1", "1", "1"],
    ["0", "0", "0", "0"],
  ],
};
const control =
  "w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm";
const button =
  "rounded border border-neutral-300 px-3 py-2 text-sm disabled:opacity-50";

function RewardEditor({
  initial,
  locale,
  busy,
  onSave,
  onCancel,
}: {
  initial: RewardCatalogFields;
  locale: Locale;
  busy: boolean;
  onSave: (fields: RewardCatalogFields) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = React.useState(() =>
    rewardCatalogFormFromFields(initial),
  );
  const [errors, setErrors] = React.useState<string[]>([]);
  const language = { en: 0, ja: 1, vi: 2 }[locale];
  const financial = ["gift_card", "store_credit"].includes(form.rewardType);
  const incremental = form.exchangeType === "incremental";
  const visible = (key: keyof RewardCatalogForm) => {
    if (key === "salesChannel") return false;
    if (key === "exchangeType") return form.rewardType === "amount_off";
    if (["pointsStep", "minPointsCost", "maxPointsCost"].includes(key))
      return incremental;
    if (key === "discountValue")
      return !["free_shipping", "free_product"].includes(form.rewardType);
    if (key === "maxDiscountValue")
      return form.rewardType === "free_product" || incremental;
    if (
      ["minOrderAmount", "usageLimit", "usageLimitPerCustomer"].includes(key) ||
      key.startsWith("combinesWith")
    )
      return !financial;
    if (key === "appliesToResource")
      return !financial && form.rewardType !== "free_shipping";
    if (key.startsWith("entitled"))
      return (
        form.appliesToResource === "specific_items" &&
        (key !== "entitledCollectionIds" || form.rewardType !== "free_product")
      );
    return true;
  };
  const change = (key: keyof RewardCatalogForm, value: string) =>
    setForm((current) => {
      if (key === "rewardType")
        return changeRewardCatalogType(
          current,
          value as RewardCatalogFields["rewardType"],
        );
      if (key === "exchangeType")
        return {
          ...current,
          exchangeType: value,
          pointsStep: value === "incremental" ? "100" : "",
          minPointsCost: value === "incremental" ? "100" : "",
          maxPointsCost: "",
          maxDiscountValue: "",
        };
      if (key === "appliesToResource" && value === "entire_order")
        return {
          ...current,
          appliesToResource: value,
          entitledProductIds: "",
          entitledVariantIds: "",
          entitledCollectionIds: "",
        };
      return { ...current, [key]: value };
    });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const parsed = parseRewardCatalogForm(form);
        if (!parsed.success) {
          setErrors([
            ...new Set(
              parsed.error.issues.map((issue) => String(issue.path[0])),
            ),
          ]);
          return;
        }
        setErrors([]);
        onSave(parsed.data);
      }}
    >
      {errors.length > 0 && (
        <p role="alert">
          {copy[locale].invalid}{" "}
          {errors
            .map(
              (key) =>
                labels[key as keyof RewardCatalogForm]?.[language] ?? key,
            )
            .join(", ")}
        </p>
      )}
      <fieldset disabled={busy} className="grid gap-4 sm:grid-cols-2">
        {(Object.keys(labels) as Array<keyof RewardCatalogForm>)
          .filter(visible)
          .map((key) => (
            <label key={key} className="grid min-w-0 gap-1 text-sm">
              <span>{labels[key][language]}</span>
              {key.startsWith("combinesWith") ? (
                <input
                  type="checkbox"
                  checked={form[key] === "true"}
                  onChange={(event) =>
                    change(key, String(event.target.checked))
                  }
                />
              ) : options[key] ? (
                <select
                  className={control}
                  value={form[key]}
                  onChange={(event) => change(key, event.target.value)}
                  aria-invalid={errors.includes(key)}
                >
                  {options[key]!.map(([value, ...text]) => (
                    <option key={value} value={value}>
                      {text[language]}
                    </option>
                  ))}
                </select>
              ) : key.startsWith("entitled") ? (
                <textarea
                  className={control}
                  rows={3}
                  value={form[key]}
                  onChange={(event) => change(key, event.target.value)}
                  aria-invalid={errors.includes(key)}
                />
              ) : (
                <input
                  className={control}
                  value={form[key]}
                  onChange={(event) => change(key, event.target.value)}
                  aria-invalid={errors.includes(key)}
                />
              )}
            </label>
          ))}
      </fieldset>
      <div className="mt-4 flex gap-2">
        <button className={button} disabled={busy} type="submit">
          {copy[locale].save}
        </button>
        <button
          className={button}
          disabled={busy}
          type="button"
          onClick={onCancel}
        >
          {copy[locale].cancel}
        </button>
      </div>
    </form>
  );
}

function CatalogVisit({
  transport,
  locked,
}: {
  transport: RewardCatalogTransport;
  locked: boolean;
}) {
  const [locale, setLocale] = React.useState<Locale>("en");
  const [filter, setFilter] = React.useState("all");
  const [view, setView] = React.useState<RewardCatalogResponse | null>(null);
  const [reload, setReload] = React.useState(0);
  const [localBusy, setBusy] = React.useState(true);
  const busy = localBusy || locked;
  const [error, setError] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [containment, setContainment] = React.useState<{
    id: string;
    name: string;
    status: "inactive" | "archived";
  } | null>(null);
  const [draft, setDraft] = React.useState<{
    id: string | null;
    fields: RewardCatalogFields;
  } | null>(null);
  const mounted = React.useRef(false);
  const pending = React.useRef<object | null>(null);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  React.useEffect(() => {
    let current = true;
    pending.current = null;
    setBusy(true);
    setError(false);
    setSaved(false);
    setView(null);
    setDraft(null);
    setContainment(null);
    transport
      .read()
      .then((data) => {
        if (current) setView(data);
      })
      .catch(() => {
        if (current) setError(true);
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [transport, reload]);
  const mutate = async (operation: () => Promise<RewardCatalogResponse>) => {
    if (!view || busy || pending.current || !view.capabilities.configure)
      return;
    const ticket = {};
    pending.current = ticket;
    setBusy(true);
    setSaved(false);
    try {
      const result = await operation();
      if (!mounted.current || pending.current !== ticket) return;
      if (
        result.storeId !== view.storeId ||
        result.shopCurrency !== view.shopCurrency
      )
        throw new Error("Catalog scope changed");
      setView(result);
      setDraft(null);
      setContainment(null);
      setSaved(true);
    } catch {
      if (mounted.current && pending.current === ticket) {
        setView(null);
        setDraft(null);
        setContainment(null);
        setError(true);
      }
    } finally {
      if (mounted.current && pending.current === ticket) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  const save = (fields: RewardCatalogFields) => {
    if (!view?.shopCurrency || !draft) return;
    return mutate(() =>
      transport.save({
        expectedInstallationGeneration: view.installationGeneration,
        expectedRevision: view.revision,
        rewardId: draft.id,
        reward: fields,
      }),
    );
  };
  const contain = () => {
    if (!view || !containment) return;
    return mutate(() =>
      transport.contain({
        expectedInstallationGeneration: view.installationGeneration,
        expectedRevision: view.revision,
        rewardId: containment.id,
        status: containment.status,
      }),
    );
  };
  const text = copy[locale];
  return (
    <section className="mx-auto grid w-full max-w-4xl gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{text.title}</h1>
        <label className="text-sm">
          {text.language}{" "}
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
        onClick={() => setReload((count) => count + 1)}
      >
        {text.reload}
      </button>
      {busy && <p role="status">{text.load}</p>}
      {error && <p role="alert">{text.error}</p>}
      {saved && <p role="status">{text.saved}</p>}
      {view && (
        <>
          <p>{view.shopCurrency ?? text.currencyUnavailable}</p>
          {!view.capabilities.configure && <p>{text.readonly}</p>}
          {containment ? (
            <div className="grid gap-3">
              <p>
                {containment.name}:{" "}
                {containment.status === "inactive" ? text.pause : text.archive}
              </p>
              <button className={button} disabled={busy} onClick={contain}>
                {text.confirm}
              </button>
              <button
                className={button}
                disabled={busy}
                onClick={() => setContainment(null)}
              >
                {text.cancel}
              </button>
            </div>
          ) : draft ? (
            <RewardEditor
              key={draft.id ?? "new"}
              initial={draft.fields}
              locale={locale}
              busy={busy}
              onSave={save}
              onCancel={() => setDraft(null)}
            />
          ) : (
            <>
              {view.capabilities.configure && view.shopCurrency && (
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    setDraft({ id: null, fields: newRewardCatalogFields() })
                  }
                >
                  {text.create}
                </button>
              )}
              <label>
                {text.filter}{" "}
                <select
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                >
                  <option value="all">{text.all}</option>
                  {options.status!.map(([value, ...label]) => (
                    <option key={value} value={value}>
                      {label[{ en: 0, ja: 1, vi: 2 }[locale]]}
                    </option>
                  ))}
                </select>
              </label>
              {view.rewards.filter(
                (reward) => filter === "all" || reward.status === filter,
              ).length === 0 && <p>{text.empty}</p>}
              {view.rewards
                .filter(
                  (reward) => filter === "all" || reward.status === filter,
                )
                .map((reward) => (
                  <article
                    key={reward.id}
                    className="grid gap-2 rounded border p-4"
                  >
                    <h2 className="break-words font-medium">{reward.name}</h2>
                    <p>
                      {
                        options.rewardType?.find(
                          ([value]) => value === reward.rewardType,
                        )?.[{ en: 1, ja: 2, vi: 3 }[locale]]
                      }{" "}
                      ·{" "}
                      {
                        options.status?.find(
                          ([value]) => value === reward.status,
                        )?.[{ en: 1, ja: 2, vi: 3 }[locale]]
                      }
                    </p>
                    {reward.fields ? (
                      <>
                        <details>
                          <summary>{text.details}</summary>
                          <dl className="grid gap-2 text-sm">
                            {Object.entries(reward.fields)
                              .filter(
                                ([key, value]) =>
                                  value !== null &&
                                  key !== "name" &&
                                  !(
                                    ["gift_card", "store_credit"].includes(
                                      reward.rewardType,
                                    ) &&
                                    (key === "usageLimitPerCustomer" ||
                                      key.startsWith("combinesWith"))
                                  ),
                              )
                              .map(([key, value]) => (
                                <div
                                  key={key}
                                  className="grid gap-1 sm:grid-cols-2"
                                >
                                  <dt>
                                    {
                                      labels[key as keyof RewardCatalogForm][
                                        { en: 0, ja: 1, vi: 2 }[locale]
                                      ]
                                    }
                                  </dt>
                                  <dd className="break-words">
                                    {Array.isArray(value)
                                      ? value.join(", ") || "—"
                                      : typeof value === "boolean"
                                        ? value
                                          ? "✓"
                                          : "—"
                                        : String(value)}
                                  </dd>
                                </div>
                              ))}
                          </dl>
                        </details>
                        <p>
                          {reward.fields.pointsCost} ·{" "}
                          {reward.fields.discountValue ??
                            reward.fields.maxDiscountValue ??
                            "—"}
                        </p>
                        {view.capabilities.configure && view.shopCurrency && (
                          <button
                            className={button}
                            disabled={busy}
                            onClick={() =>
                              setDraft({
                                id: reward.id,
                                fields: reward.fields!,
                              })
                            }
                          >
                            {text.edit}
                          </button>
                        )}
                      </>
                    ) : (
                      <p>{text.legacy}</p>
                    )}
                    {view.capabilities.configure && (
                      <div className="flex gap-2">
                        {reward.status === "active" && (
                          <button
                            className={button}
                            disabled={busy}
                            onClick={() =>
                              setContainment({
                                id: reward.id,
                                name: reward.name,
                                status: "inactive",
                              })
                            }
                          >
                            {text.pause}
                          </button>
                        )}
                        {reward.status !== "archived" && (
                          <button
                            className={button}
                            disabled={busy}
                            onClick={() =>
                              setContainment({
                                id: reward.id,
                                name: reward.name,
                                status: "archived",
                              })
                            }
                          >
                            {text.archive}
                          </button>
                        )}
                      </div>
                    )}
                  </article>
                ))}
            </>
          )}
        </>
      )}
    </section>
  );
}
export function RewardCatalogSession({
  transport,
}: {
  transport: RewardCatalogTransport;
}) {
  // This lock survives CatalogVisit remounts and read refreshes. Completion
  // identity inside the visit is separate from permission to start a write.
  const inFlight = React.useRef<object | null>(null);
  const [locked, setLocked] = React.useState(false);
  const active = React.useRef(false);
  React.useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const guarded = React.useMemo(() => {
    const run = async (operation: () => Promise<RewardCatalogResponse>) => {
      if (inFlight.current)
        throw new Error("A reward mutation is still pending");
      const ticket = {};
      inFlight.current = ticket;
      setLocked(true);
      try {
        return await operation();
      } finally {
        if (inFlight.current === ticket) {
          inFlight.current = null;
          if (active.current) setLocked(false);
        }
      }
    };
    return {
      ...transport,
      save: (input: RewardCatalogWrite) => run(() => transport.save(input)),
      contain: (input: RewardCatalogContain) =>
        run(() => transport.contain(input)),
    };
  }, [transport]);
  return (
    <CatalogVisit
      key={transport.scopeKey}
      transport={guarded}
      locked={locked}
    />
  );
}
