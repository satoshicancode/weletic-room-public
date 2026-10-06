import { useAppBridge } from "@shopify/app-bridge-react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  InlineGrid,
  InlineStack,
  Page,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import type {
  RewardCatalogContain,
  RewardCatalogFields,
  RewardCatalogResponse,
  RewardCatalogWrite,
} from "@weletic/contracts/loyalty/reward-catalog-contract";
import React from "react";
import { useCoreLaunch } from "~/core-launch-context";
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
    note: "Values use minor currency units (JPY 1 = 1; USD 1 = 100). Native Shopify discount rewards can target one-time purchases, subscriptions, or both; Weletic does not sell or manage subscriptions. Product rewards are capped discounts, not guaranteed free items. Gift Card/Store Credit checkout acceptance remains gated.",
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
    note: "金額は最小通貨単位です（1円 = 1、1米ドル = 100）。Shopify標準割引は通常購入、定期購入、または両方を対象にできます。Weleticは定期購入の販売・契約管理を行いません。商品特典は上限付き割引です。ギフトカード・ストアクレジットの決済検証は未完了です。",
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
    note: "Số tiền dùng đơn vị tiền tệ nhỏ nhất (1 JPY = 1; 1 USD = 100). Phần thưởng giảm giá Shopify có thể áp dụng cho mua một lần, đăng ký hoặc cả hai; Weletic không bán hay quản lý hợp đồng đăng ký. Quà sản phẩm là giảm giá có giới hạn. Gift Card/Store Credit vẫn cần nghiệm thu.",
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
  purchaseType: ["Purchase eligibility", "購入対象", "Điều kiện mua hàng"],
  subscriptionCadence: [
    "Subscription payments",
    "定期購入の支払い",
    "Thanh toán đăng ký",
  ],
  subscriptionPaymentLimit: [
    "Eligible payment count",
    "対象支払い回数",
    "Số lần thanh toán đủ điều kiện",
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
  purchaseType: [
    ["one_time", "One-time purchases", "通常購入", "Mua một lần"],
    ["subscription", "Subscriptions", "定期購入", "Đăng ký"],
    ["both", "Both", "両方", "Cả hai"],
  ],
  subscriptionCadence: [
    ["first_payment", "First payment", "初回支払い", "Lần đầu"],
    ["first_n_payments", "First N payments", "最初のN回", "N lần đầu"],
    ["every_payment", "Every renewal", "すべての更新", "Mọi lần gia hạn"],
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
  const coreLaunch = useCoreLaunch();
  const [form, setForm] = React.useState(() =>
    rewardCatalogFormFromFields(initial),
  );
  const [errors, setErrors] = React.useState<string[]>([]);
  const language = { en: 0, ja: 1, vi: 2 }[locale];
  const financial = ["gift_card", "store_credit"].includes(form.rewardType);
  const incremental = form.exchangeType === "incremental";
  const visible = (key: keyof RewardCatalogForm) => {
    if (key === "salesChannel") return false;
    if (key === "purchaseType") return !financial;
    if (key === "subscriptionCadence")
      return !financial && form.purchaseType !== "one_time";
    if (key === "subscriptionPaymentLimit")
      return (
        !financial &&
        form.purchaseType !== "one_time" &&
        form.subscriptionCadence === "first_n_payments"
      );
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
      if (key === "purchaseType")
        return {
          ...current,
          purchaseType: value,
          subscriptionCadence:
            value === "one_time"
              ? "first_payment"
              : current.subscriptionCadence,
          subscriptionPaymentLimit:
            value === "one_time" ? "" : current.subscriptionPaymentLimit,
        };
      if (key === "subscriptionCadence")
        return {
          ...current,
          subscriptionCadence: value,
          subscriptionPaymentLimit:
            value === "first_n_payments"
              ? current.subscriptionPaymentLimit || "2"
              : "",
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
      lang={locale}
      onSubmit={(event) => {
        event.preventDefault();
        if (busy) return;
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
      <BlockStack gap="400">
        {errors.length > 0 && (
          <Banner tone="critical">
            <p>
              {copy[locale].invalid}{" "}
              {errors
                .map(
                  (key) =>
                    labels[key as keyof RewardCatalogForm]?.[language] ?? key,
                )
                .join(", ")}
            </p>
          </Banner>
        )}
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
          {(Object.keys(labels) as Array<keyof RewardCatalogForm>)
            .filter(visible)
            .map((key) => {
              const label = labels[key][language];
              if (key.startsWith("combinesWith")) {
                return (
                  <Checkbox
                    key={key}
                    label={label}
                    name={key}
                    checked={form[key] === "true"}
                    disabled={busy}
                    onChange={(checked) => change(key, String(checked))}
                  />
                );
              }
              if (options[key]) {
                const selectOptions = options[key]!.filter(
                  ([value]) =>
                    !coreLaunch ||
                    !["rewardType", "exchangeType", "purchaseType"].includes(
                      key,
                    ) ||
                    value ===
                      (
                        {
                          rewardType: "amount_off",
                          exchangeType: "fixed",
                          purchaseType: "one_time",
                        } as Record<string, string>
                      )[key],
                ).map(([value, ...text]) => ({
                  label: text[language],
                  value,
                }));
                return (
                  <Select
                    key={key}
                    label={label}
                    name={key}
                    value={form[key]}
                    options={selectOptions}
                    error={errors.includes(key)}
                    disabled={busy}
                    onChange={(val) => change(key, val)}
                  />
                );
              }
              if (key.startsWith("entitled")) {
                return (
                  <TextField
                    key={key}
                    label={label}
                    name={key}
                    multiline={3}
                    value={form[key]}
                    error={errors.includes(key)}
                    disabled={busy}
                    autoComplete="off"
                    onChange={(val) => change(key, val)}
                  />
                );
              }
              return (
                <TextField
                  key={key}
                  label={label}
                  name={key}
                  value={form[key]}
                  error={errors.includes(key)}
                  disabled={busy}
                  autoComplete="off"
                  onChange={(val) => change(key, val)}
                />
              );
            })}
        </InlineGrid>
        <InlineStack gap="300">
          <Button variant="primary" submit={true} disabled={busy}>
            {copy[locale].save}
          </Button>
          <Button onClick={onCancel} disabled={busy}>
            {copy[locale].cancel}
          </Button>
        </InlineStack>
      </BlockStack>
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
  const shopify = useAppBridge();
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
    // StrictMode replays mount effects. Do not dispatch an authenticated read
    // for an already-discarded visit; ignoring its response still holds a lease.
    Promise.resolve()
      .then(async () => {
        if (!current) return;
        const data = await transport.read();
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
      shopify.toast?.show?.(text.saved);
    } catch {
      if (mounted.current && pending.current === ticket) {
        setView(null);
        setDraft(null);
        setContainment(null);
        setError(true);
        shopify.toast?.show?.(text.error, { isError: true });
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

  const filterOptions = [
    { label: text.all, value: "all" },
    ...(options.status?.map(([value, ...label]) => ({
      label: label[{ en: 0, ja: 1, vi: 2 }[locale]],
      value,
    })) ?? []),
  ];

  return (
    <Page
      title={text.title}
      primaryAction={
        view?.capabilities.configure &&
        view.shopCurrency &&
        !draft &&
        !containment
          ? {
              content: text.create,
              onAction: () =>
                setDraft({ id: null, fields: newRewardCatalogFields() }),
              disabled: busy,
            }
          : undefined
      }
      secondaryActions={[
        {
          content: text.reload,
          onAction: () => setReload((count) => count + 1),
          disabled: busy,
        },
      ]}
    >
      <BlockStack gap="400">
        <InlineStack align="end">
          <Select
            label={text.language}
            labelInline
            value={locale}
            options={[
              { label: "English", value: "en" },
              { label: "日本語", value: "ja" },
              { label: "Tiếng Việt", value: "vi" },
            ]}
            onChange={(val) => setLocale(val as Locale)}
          />
        </InlineStack>

        <Card>
          <Text as="p" variant="bodySm" tone="subdued">
            {text.note}
          </Text>
        </Card>

        {busy && (
          <Card>
            <Text as="p" tone="subdued">
              {text.load}
            </Text>
          </Card>
        )}
        {error && (
          <Banner
            tone="critical"
            action={{
              content: text.reload,
              onAction: () => setReload((count) => count + 1),
              loading: busy,
            }}
          >
            <p>{text.error}</p>
          </Banner>
        )}
        {saved && (
          <Banner tone="success">
            <p>{text.saved}</p>
          </Banner>
        )}

        {view && (
          <>
            <Card>
              <Text as="p" variant="bodySm" tone="subdued">
                {view.shopCurrency ?? text.currencyUnavailable}
              </Text>
              {!view.capabilities.configure && (
                <Text as="p" tone="subdued">
                  {text.readonly}
                </Text>
              )}
            </Card>

            {containment ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    {containment.name}:{" "}
                    {containment.status === "inactive"
                      ? text.pause
                      : text.archive}
                  </Text>
                  <InlineStack gap="200">
                    <Button
                      variant="primary"
                      tone="critical"
                      disabled={busy}
                      onClick={contain}
                    >
                      {text.confirm}
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() => setContainment(null)}
                    >
                      {text.cancel}
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            ) : draft ? (
              <Card>
                <RewardEditor
                  key={draft.id ?? "new"}
                  initial={draft.fields}
                  locale={locale}
                  busy={busy}
                  onSave={save}
                  onCancel={() => setDraft(null)}
                />
              </Card>
            ) : (
              <>
                <Card>
                  <Select
                    label={text.filter}
                    options={filterOptions}
                    value={filter}
                    onChange={setFilter}
                  />
                </Card>

                {view.rewards.filter(
                  (reward) => filter === "all" || reward.status === filter,
                ).length === 0 && (
                  <Card>
                    <Text as="p" tone="subdued">
                      {text.empty}
                    </Text>
                  </Card>
                )}

                <BlockStack gap="300">
                  {view.rewards
                    .filter(
                      (reward) => filter === "all" || reward.status === filter,
                    )
                    .map((reward) => (
                      <Card key={reward.id}>
                        <BlockStack gap="300">
                          <InlineStack
                            align="space-between"
                            blockAlign="center"
                          >
                            <Text as="h2" variant="headingSm">
                              {reward.name}
                            </Text>
                            <Badge
                              tone={
                                reward.status === "active"
                                  ? "success"
                                  : reward.status === "inactive"
                                    ? "attention"
                                    : undefined
                              }
                            >
                              {
                                options.status?.find(
                                  ([value]) => value === reward.status,
                                )?.[{ en: 1, ja: 2, vi: 3 }[locale]]
                              }
                            </Badge>
                          </InlineStack>

                          <Text as="p" variant="bodySm" tone="subdued">
                            {
                              options.rewardType?.find(
                                ([value]) => value === reward.rewardType,
                              )?.[{ en: 1, ja: 2, vi: 3 }[locale]]
                            }
                          </Text>

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
                                          [
                                            "gift_card",
                                            "store_credit",
                                          ].includes(reward.rewardType) &&
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
                                            labels[
                                              key as keyof RewardCatalogForm
                                            ][{ en: 0, ja: 1, vi: 2 }[locale]]
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

                              <Text as="p" variant="bodySm">
                                {reward.fields.pointsCost} ·{" "}
                                {reward.fields.discountValue ??
                                  reward.fields.maxDiscountValue ??
                                  "—"}
                              </Text>

                              {view.capabilities.configure &&
                                view.shopCurrency && (
                                  <InlineStack gap="200">
                                    <Button
                                      size="micro"
                                      disabled={busy}
                                      onClick={() =>
                                        setDraft({
                                          id: reward.id,
                                          fields: reward.fields!,
                                        })
                                      }
                                    >
                                      {text.edit}
                                    </Button>
                                    {reward.status === "active" && (
                                      <Button
                                        size="micro"
                                        tone="critical"
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
                                      </Button>
                                    )}
                                    {reward.status !== "archived" && (
                                      <Button
                                        size="micro"
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
                                      </Button>
                                    )}
                                  </InlineStack>
                                )}
                            </>
                          ) : (
                            <Text as="p" variant="bodySm" tone="subdued">
                              {text.legacy}
                            </Text>
                          )}
                        </BlockStack>
                      </Card>
                    ))}
                </BlockStack>
              </>
            )}
          </>
        )}
      </BlockStack>
    </Page>
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
