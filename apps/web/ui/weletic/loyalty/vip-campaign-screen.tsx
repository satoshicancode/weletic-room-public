"use client";
import React from "react";
import type {
  BonusCampaignFields,
  VipCampaignRequest,
  VipCampaignResponse,
  VipProgramPolicy,
  VipTierFields,
} from "../../../lib/weletic/loyalty/vip-campaign-contract";

type Locale = "en" | "ja" | "vi";
export type VipCampaignTransport = {
  scopeKey: string;
  read: () => Promise<VipCampaignResponse>;
  mutate: (
    request: Exclude<VipCampaignRequest, { operation: "read" }>,
  ) => Promise<VipCampaignResponse>;
};
const messages = {
  en: {
    title: "VIP tiers & bonus campaigns",
    policy: "VIP policy",
    tiers: "VIP tiers",
    campaigns: "Bonus campaigns",
    history: "Recent tier history",
    noTier: "No tier",
    addTier: "Add tier",
    addCampaign: "Add campaign",
    save: "Save",
    cancel: "Cancel",
    edit: "Edit",
    retire: "Retire",
    loading: "Checking access…",
    empty: "Nothing configured yet.",
    readonly: "Read-only access",
    error: "State is unavailable or changed. Reload before saving.",
    language: "Language",
    reload: "Reload",
    name: "Name",
    slug: "Slug",
    order: "Order",
    pointsMultiplier: "Points multiplier",
    minimumSpend: "Minimum spend (minor units)",
    minimumPoints: "Minimum points",
    entryReward: "Entry reward points",
    graceDays: "Grace days (blank: program default)",
    badgeColor: "Badge color",
    iconUrl: "HTTPS icon URL",
    perks: "Perks (one per line)",
    milestone: "Milestone",
    amountSpent: "Amount spent",
    pointsEarned: "Points earned",
    both: "Both",
    timeframe: "Timeframe",
    rollingYear: "Rolling 12 months",
    calendarYear: "Calendar year",
    lifetime: "Lifetime",
    defaultGrace: "Default downgrade grace days",
    automaticDowngrade: "Automatic downgrade",
    enabled: "Enabled",
    disabled: "Disabled",
    multiplier: "Multiplier",
    starts: "Starts",
    ends: "Ends",
    description: "Description",
    eligibleVip: "Eligible VIP tiers",
    active: "Active",
    yes: "Yes",
    no: "No",
    eligibleSkus: "Eligible SKUs (one per line)",
    eligibleCollections: "Eligible collection GIDs (one per line)",
    confirmRetireTier: "Retire this VIP tier? This cannot be undone.",
    confirmRetireCampaign:
      "Retire this scheduled campaign? This cannot be undone.",
    scheduled: "Scheduled",
    running: "Running",
    ended: "Ended",
    paused: "Paused",
    thresholdReached: "Threshold reached",
    annualDowngrade: "Annual downgrade",
    note: "Amounts use minor currency units. Running campaign economics, schedule, and targeting are immutable; pause a running campaign to contain it.",
  },
  ja: {
    title: "VIPランク・ボーナスキャンペーン",
    policy: "VIPポリシー",
    tiers: "VIPランク",
    campaigns: "ボーナスキャンペーン",
    history: "最近のランク履歴",
    noTier: "ランクなし",
    addTier: "ランクを追加",
    addCampaign: "キャンペーンを追加",
    save: "保存",
    cancel: "キャンセル",
    edit: "編集",
    retire: "廃止",
    loading: "権限を確認中…",
    empty: "設定はありません。",
    readonly: "閲覧専用",
    error: "状態を確認できないか変更されています。再読み込みしてください。",
    language: "言語",
    reload: "再読み込み",
    name: "名前",
    slug: "スラッグ",
    order: "表示順",
    pointsMultiplier: "ポイント倍率",
    minimumSpend: "最低購入額（最小通貨単位）",
    minimumPoints: "最低獲得ポイント",
    entryReward: "ランク到達ボーナス",
    graceDays: "猶予日数（空欄：既定値）",
    badgeColor: "バッジ色",
    iconUrl: "HTTPSアイコンURL",
    perks: "特典（1行に1件）",
    milestone: "到達条件",
    amountSpent: "購入額",
    pointsEarned: "獲得ポイント",
    both: "両方",
    timeframe: "集計期間",
    rollingYear: "直近12か月",
    calendarYear: "暦年",
    lifetime: "通算",
    defaultGrace: "降格の既定猶予日数",
    automaticDowngrade: "自動降格",
    enabled: "有効",
    disabled: "無効",
    multiplier: "倍率",
    starts: "開始",
    ends: "終了",
    description: "説明",
    eligibleVip: "対象VIPランク",
    active: "有効状態",
    yes: "はい",
    no: "いいえ",
    eligibleSkus: "対象SKU（1行に1件）",
    eligibleCollections: "対象コレクションGID（1行に1件）",
    confirmRetireTier: "このVIPランクを廃止しますか？元に戻せません。",
    confirmRetireCampaign:
      "この予定キャンペーンを廃止しますか？元に戻せません。",
    scheduled: "予定",
    running: "実行中",
    ended: "終了",
    paused: "一時停止",
    thresholdReached: "条件達成",
    annualDowngrade: "年次降格",
    note: "金額は最小通貨単位です。実行中キャンペーンの倍率・期間・対象は変更できません。停止は可能です。",
  },
  vi: {
    title: "Hạng VIP và chiến dịch thưởng",
    policy: "Chính sách VIP",
    tiers: "Hạng VIP",
    campaigns: "Chiến dịch thưởng",
    history: "Lịch sử hạng gần đây",
    noTier: "Chưa có hạng",
    addTier: "Thêm hạng",
    addCampaign: "Thêm chiến dịch",
    save: "Lưu",
    cancel: "Hủy",
    edit: "Sửa",
    retire: "Ngừng dùng",
    loading: "Đang kiểm tra quyền…",
    empty: "Chưa có cấu hình.",
    readonly: "Chỉ có quyền xem",
    error: "Không thể xác nhận trạng thái hoặc trạng thái đã đổi. Hãy tải lại.",
    language: "Ngôn ngữ",
    reload: "Tải lại",
    name: "Tên",
    slug: "Slug",
    order: "Thứ tự",
    pointsMultiplier: "Hệ số điểm",
    minimumSpend: "Mức chi tối thiểu (đơn vị tiền tệ nhỏ nhất)",
    minimumPoints: "Điểm tối thiểu",
    entryReward: "Điểm thưởng khi vào hạng",
    graceDays: "Số ngày ân hạn (để trống: mặc định)",
    badgeColor: "Màu huy hiệu",
    iconUrl: "URL biểu tượng HTTPS",
    perks: "Quyền lợi (mỗi dòng một mục)",
    milestone: "Điều kiện xếp hạng",
    amountSpent: "Số tiền đã chi",
    pointsEarned: "Điểm đã tích",
    both: "Cả hai",
    timeframe: "Khoảng thời gian",
    rollingYear: "12 tháng gần nhất",
    calendarYear: "Năm dương lịch",
    lifetime: "Toàn thời gian",
    defaultGrace: "Số ngày ân hạn hạ hạng mặc định",
    automaticDowngrade: "Tự động hạ hạng",
    enabled: "Bật",
    disabled: "Tắt",
    multiplier: "Hệ số",
    starts: "Bắt đầu",
    ends: "Kết thúc",
    description: "Mô tả",
    eligibleVip: "Hạng VIP đủ điều kiện",
    active: "Đang hoạt động",
    yes: "Có",
    no: "Không",
    eligibleSkus: "SKU đủ điều kiện (mỗi dòng một mã)",
    eligibleCollections: "GID bộ sưu tập (mỗi dòng một mã)",
    confirmRetireTier: "Ngừng dùng hạng VIP này? Không thể hoàn tác.",
    confirmRetireCampaign:
      "Ngừng dùng chiến dịch đã lên lịch này? Không thể hoàn tác.",
    scheduled: "Đã lên lịch",
    running: "Đang chạy",
    ended: "Đã kết thúc",
    paused: "Đã tạm dừng",
    thresholdReached: "Đã đạt điều kiện",
    annualDowngrade: "Hạ hạng hằng năm",
    note: "Số tiền dùng đơn vị tiền tệ nhỏ nhất. Không thể sửa hệ số, lịch và đối tượng của chiến dịch đang chạy; có thể tạm dừng để khoanh vùng.",
  },
};
const control =
  "w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm";
const button =
  "rounded border border-neutral-300 px-3 py-2 text-sm disabled:opacity-50";
const panel = "space-y-4 rounded border border-neutral-200 bg-white p-4";
const nowPlus = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
const newTier = (order: number): VipTierFields => ({
  name: "",
  slug: "",
  tierOrder: order,
  minSpendThreshold: "0",
  minPointsThreshold: "0",
  pointsMultiplier: 1,
  entryBonusPoints: "0",
  gracePeriodDays: null,
  perks: [],
  iconUrl: null,
  color: null,
});
const newCampaign = (): BonusCampaignFields => ({
  name: "",
  description: null,
  multiplier: 2,
  startAt: nowPlus(1),
  endAt: nowPlus(8),
  isActive: true,
  eligibleTierIds: [],
  eligibleSkus: [],
  eligibleCollectionIds: [],
});
const dateValue = (value: string) => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};
const localDateIso = (value: string, fallback: string) => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
};
const listValue = (values: string[]) => values.join("\n");
const readList = (value: string) => [
  ...new Set(
    value
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean),
  ),
];
const lifecycleLabel = (
  copy: typeof messages.en,
  lifecycle: VipCampaignResponse["campaigns"][number]["lifecycle"],
) => copy[lifecycle];
const historyReasonLabel = (copy: typeof messages.en, reason: string) =>
  reason === "threshold_reached"
    ? copy.thresholdReached
    : reason === "annual_downgrade"
      ? copy.annualDowngrade
      : reason.replaceAll("_", " ");

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}

function PolicyEditor({
  value,
  busy,
  copy,
  onSave,
}: {
  value: VipProgramPolicy;
  busy: boolean;
  copy: typeof messages.en;
  onSave: (value: VipProgramPolicy) => void;
}) {
  const [draft, setDraft] = React.useState(value);
  return (
    <form
      className="grid gap-3 md:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(draft);
      }}
    >
      <Field label={copy.milestone}>
        <select
          className={control}
          disabled={busy}
          value={draft.milestoneMode}
          onChange={(event) =>
            setDraft({
              ...draft,
              milestoneMode: event.target
                .value as VipProgramPolicy["milestoneMode"],
            })
          }
        >
          <option value="amount_spent">{copy.amountSpent}</option>
          <option value="points_earned">{copy.pointsEarned}</option>
          <option value="both">{copy.both}</option>
        </select>
      </Field>
      <Field label={copy.timeframe}>
        <select
          className={control}
          disabled={busy}
          value={draft.timeframe}
          onChange={(event) =>
            setDraft({
              ...draft,
              timeframe: event.target.value as VipProgramPolicy["timeframe"],
            })
          }
        >
          <option value="rolling_12m">{copy.rollingYear}</option>
          <option value="calendar_year">{copy.calendarYear}</option>
          <option value="lifetime">{copy.lifetime}</option>
        </select>
      </Field>
      <Field label={copy.defaultGrace}>
        <input
          className={control}
          type="number"
          min={0}
          max={3650}
          disabled={busy}
          value={draft.downgradeGraceDays}
          onChange={(event) =>
            setDraft({
              ...draft,
              downgradeGraceDays: Number(event.target.value),
            })
          }
        />
      </Field>
      <Field label={copy.automaticDowngrade}>
        <select
          className={control}
          disabled={busy}
          value={draft.autoDowngradeEnabled ? "yes" : "no"}
          onChange={(event) =>
            setDraft({
              ...draft,
              autoDowngradeEnabled: event.target.value === "yes",
            })
          }
        >
          <option value="yes">{copy.enabled}</option>
          <option value="no">{copy.disabled}</option>
        </select>
      </Field>
      <div className="md:col-span-2">
        <button className={button} disabled={busy} type="submit">
          {copy.save}
        </button>
      </div>
    </form>
  );
}

function TierEditor({
  value,
  busy,
  copy,
  onSave,
  onCancel,
}: {
  value: VipTierFields;
  busy: boolean;
  copy: typeof messages.en;
  onSave: (value: VipTierFields) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState(value);
  const text =
    (
      key:
        | "name"
        | "slug"
        | "minSpendThreshold"
        | "minPointsThreshold"
        | "entryBonusPoints",
    ) =>
    (event: React.ChangeEvent<HTMLInputElement>) =>
      setDraft({ ...draft, [key]: event.target.value });
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field label={copy.name}>
        <input className={control} value={draft.name} onChange={text("name")} />
      </Field>
      <Field label={copy.slug}>
        <input className={control} value={draft.slug} onChange={text("slug")} />
      </Field>
      <Field label={copy.order}>
        <input
          className={control}
          type="number"
          min={1}
          max={100}
          value={draft.tierOrder}
          onChange={(event) =>
            setDraft({ ...draft, tierOrder: Number(event.target.value) })
          }
        />
      </Field>
      <Field label={copy.pointsMultiplier}>
        <input
          className={control}
          type="number"
          min={1}
          max={100}
          step="0.01"
          value={draft.pointsMultiplier}
          onChange={(event) =>
            setDraft({ ...draft, pointsMultiplier: Number(event.target.value) })
          }
        />
      </Field>
      <Field label={copy.minimumSpend}>
        <input
          className={control}
          inputMode="numeric"
          value={draft.minSpendThreshold}
          onChange={text("minSpendThreshold")}
        />
      </Field>
      <Field label={copy.minimumPoints}>
        <input
          className={control}
          inputMode="numeric"
          value={draft.minPointsThreshold}
          onChange={text("minPointsThreshold")}
        />
      </Field>
      <Field label={copy.entryReward}>
        <input
          className={control}
          inputMode="numeric"
          value={draft.entryBonusPoints}
          onChange={text("entryBonusPoints")}
        />
      </Field>
      <Field label={copy.graceDays}>
        <input
          className={control}
          type="number"
          min={0}
          max={3650}
          value={draft.gracePeriodDays ?? ""}
          onChange={(event) =>
            setDraft({
              ...draft,
              gracePeriodDays:
                event.target.value === "" ? null : Number(event.target.value),
            })
          }
        />
      </Field>
      <Field label={copy.badgeColor}>
        <input
          className={control}
          placeholder="#FFD700"
          value={draft.color ?? ""}
          onChange={(event) =>
            setDraft({ ...draft, color: event.target.value || null })
          }
        />
      </Field>
      <Field label={copy.iconUrl}>
        <input
          className={control}
          type="url"
          value={draft.iconUrl ?? ""}
          onChange={(event) =>
            setDraft({ ...draft, iconUrl: event.target.value || null })
          }
        />
      </Field>
      <div className="md:col-span-2">
        <Field label={copy.perks}>
          <textarea
            className={control}
            rows={4}
            value={listValue(draft.perks)}
            onChange={(event) =>
              setDraft({ ...draft, perks: readList(event.target.value) })
            }
          />
        </Field>
      </div>
      <div className="flex gap-2 md:col-span-2">
        <button
          className={button}
          disabled={busy}
          type="button"
          onClick={() => onSave(draft)}
        >
          {copy.save}
        </button>
        <button
          className={button}
          disabled={busy}
          type="button"
          onClick={onCancel}
        >
          {copy.cancel}
        </button>
      </div>
    </div>
  );
}

function CampaignEditor({
  value,
  tiers,
  economicsEditable,
  busy,
  copy,
  onSave,
  onCancel,
}: {
  value: BonusCampaignFields;
  tiers: VipCampaignResponse["tiers"];
  economicsEditable: boolean;
  busy: boolean;
  copy: typeof messages.en;
  onSave: (value: BonusCampaignFields) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState(value);
  const immutable = !economicsEditable;
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <Field label={copy.name}>
        <input
          className={control}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
      </Field>
      <Field label={copy.multiplier}>
        <input
          className={control}
          disabled={immutable}
          type="number"
          min={1.5}
          max={10}
          step="0.1"
          value={draft.multiplier}
          onChange={(event) =>
            setDraft({ ...draft, multiplier: Number(event.target.value) })
          }
        />
      </Field>
      <Field label={copy.starts}>
        <input
          className={control}
          disabled={immutable}
          type="datetime-local"
          value={dateValue(draft.startAt)}
          onChange={(event) =>
            setDraft({
              ...draft,
              startAt: localDateIso(event.target.value, draft.startAt),
            })
          }
        />
      </Field>
      <Field label={copy.ends}>
        <input
          className={control}
          disabled={immutable}
          type="datetime-local"
          value={dateValue(draft.endAt)}
          onChange={(event) =>
            setDraft({
              ...draft,
              endAt: localDateIso(event.target.value, draft.endAt),
            })
          }
        />
      </Field>
      <div className="md:col-span-2">
        <Field label={copy.description}>
          <textarea
            className={control}
            value={draft.description ?? ""}
            onChange={(event) =>
              setDraft({ ...draft, description: event.target.value || null })
            }
          />
        </Field>
      </div>
      <Field label={copy.eligibleVip}>
        <select
          className={control}
          disabled={immutable}
          multiple
          value={draft.eligibleTierIds}
          onChange={(event) =>
            setDraft({
              ...draft,
              eligibleTierIds: Array.from(
                event.target.selectedOptions,
                (option) => option.value,
              ),
            })
          }
        >
          {tiers.map((tier) => (
            <option key={tier.id} value={tier.id}>
              {tier.fields.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={copy.active}>
        <select
          className={control}
          value={draft.isActive ? "yes" : "no"}
          onChange={(event) =>
            setDraft({ ...draft, isActive: event.target.value === "yes" })
          }
        >
          <option value="yes">{copy.yes}</option>
          <option value="no">{copy.no}</option>
        </select>
      </Field>
      <Field label={copy.eligibleSkus}>
        <textarea
          className={control}
          disabled={immutable}
          rows={4}
          value={listValue(draft.eligibleSkus)}
          onChange={(event) =>
            setDraft({ ...draft, eligibleSkus: readList(event.target.value) })
          }
        />
      </Field>
      <Field label={copy.eligibleCollections}>
        <textarea
          className={control}
          disabled={immutable}
          rows={4}
          value={listValue(draft.eligibleCollectionIds)}
          onChange={(event) =>
            setDraft({
              ...draft,
              eligibleCollectionIds: readList(event.target.value),
            })
          }
        />
      </Field>
      <div className="flex gap-2 md:col-span-2">
        <button
          className={button}
          disabled={busy}
          type="button"
          onClick={() => onSave(draft)}
        >
          {copy.save}
        </button>
        <button
          className={button}
          disabled={busy}
          type="button"
          onClick={onCancel}
        >
          {copy.cancel}
        </button>
      </div>
    </div>
  );
}

function VipCampaignVisit({ transport }: { transport: VipCampaignTransport }) {
  const [locale, setLocale] = React.useState<Locale>("en");
  const [view, setView] = React.useState<VipCampaignResponse | null>(null);
  const [busy, setBusy] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [blocked, setBlocked] = React.useState(false);
  const mutationPending = React.useRef(false);
  const [tierEdit, setTierEdit] = React.useState<{
    id: string | null;
    value: VipTierFields;
  } | null>(null);
  const [campaignEdit, setCampaignEdit] = React.useState<{
    id: string | null;
    value: BonusCampaignFields;
    economicsEditable: boolean;
  } | null>(null);
  const copy = messages[locale];
  const reload = React.useCallback(async () => {
    setBusy(true);
    setError(false);
    try {
      setView(await transport.read());
      setBlocked(false);
    } catch {
      setError(true);
      setBlocked(true);
    } finally {
      setBusy(false);
    }
  }, [transport]);
  React.useEffect(() => {
    void reload();
  }, [reload, transport.scopeKey]);
  const mutate = async (
    request: Exclude<VipCampaignRequest, { operation: "read" }>,
  ) => {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setBusy(true);
    setError(false);
    try {
      setView(await transport.mutate(request));
      setTierEdit(null);
      setCampaignEdit(null);
    } catch {
      setError(true);
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  };
  const fence = view && {
    expectedInstallationGeneration: view.installationGeneration,
    expectedRevision: view.revision,
  };
  const savePolicy = (policy: VipProgramPolicy) =>
    fence &&
    void mutate({ operation: "save_policy", input: { ...fence, policy } });
  const editingDisabled = !view?.capabilities.configure || busy || blocked;
  return (
    <section
      className="space-y-6"
      aria-labelledby="vip-campaign-title"
      lang={locale}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 id="vip-campaign-title" className="text-xl font-semibold">
          {copy.title}
        </h1>
        <select
          aria-label={copy.language}
          className={control}
          value={locale}
          onChange={(event) => setLocale(event.target.value as Locale)}
        >
          <option value="en">English</option>
          <option value="ja">日本語</option>
          <option value="vi">Tiếng Việt</option>
        </select>
      </div>
      <p className="text-sm text-neutral-600">{copy.note}</p>
      {busy && !view && <p role="status">{copy.loading}</p>}
      {error && (
        <div
          role="alert"
          className="rounded border border-red-300 bg-red-50 p-3"
        >
          <p>{copy.error}</p>
          <button
            className={button}
            type="button"
            onClick={() => void reload()}
          >
            {copy.reload}
          </button>
        </div>
      )}
      {view && (
        <>
          {!view.capabilities.configure && <p role="status">{copy.readonly}</p>}
          <div className={panel}>
            <h2 className="font-semibold">{copy.policy}</h2>
            <PolicyEditor
              key={view.revision}
              value={view.policy}
              busy={editingDisabled}
              copy={copy}
              onSave={savePolicy}
            />
          </div>
          <div className={panel}>
            <div className="flex justify-between">
              <h2 className="font-semibold">{copy.tiers}</h2>
              <button
                className={button}
                disabled={editingDisabled}
                type="button"
                onClick={() =>
                  setTierEdit({
                    id: null,
                    value: newTier(view.tiers.length + 1),
                  })
                }
              >
                {copy.addTier}
              </button>
            </div>
            {tierEdit && (
              <TierEditor
                value={tierEdit.value}
                busy={editingDisabled}
                copy={copy}
                onCancel={() => setTierEdit(null)}
                onSave={(tier) =>
                  fence &&
                  void mutate({
                    operation: "save_tier",
                    input: { ...fence, tierId: tierEdit.id, tier },
                  })
                }
              />
            )}
            {view.tiers.length === 0 && !tierEdit && <p>{copy.empty}</p>}
            <ul className="divide-y">
              {view.tiers.map((tier) => (
                <li
                  className="flex items-center justify-between gap-3 py-3"
                  key={tier.id}
                >
                  <div>
                    <strong>{tier.fields.name}</strong>
                    <p className="text-sm text-neutral-600">
                      #{tier.fields.tierOrder} · {tier.fields.pointsMultiplier}×
                      · {tier.fields.perks.join(", ")}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className={button}
                      disabled={editingDisabled}
                      type="button"
                      onClick={() =>
                        setTierEdit({ id: tier.id, value: tier.fields })
                      }
                    >
                      {copy.edit}
                    </button>
                    <button
                      className={button}
                      disabled={editingDisabled}
                      type="button"
                      onClick={() => {
                        if (!window.confirm(copy.confirmRetireTier)) return;
                        return (
                          fence &&
                          void mutate({
                            operation: "retire_tier",
                            input: { ...fence, tierId: tier.id },
                          })
                        );
                      }}
                    >
                      {copy.retire}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className={panel}>
            <div className="flex justify-between">
              <h2 className="font-semibold">{copy.campaigns}</h2>
              <button
                className={button}
                disabled={editingDisabled}
                type="button"
                onClick={() =>
                  setCampaignEdit({
                    id: null,
                    value: newCampaign(),
                    economicsEditable: true,
                  })
                }
              >
                {copy.addCampaign}
              </button>
            </div>
            {campaignEdit && (
              <CampaignEditor
                value={campaignEdit.value}
                tiers={view.tiers}
                economicsEditable={campaignEdit.economicsEditable}
                busy={editingDisabled}
                copy={copy}
                onCancel={() => setCampaignEdit(null)}
                onSave={(campaign) =>
                  fence &&
                  void mutate({
                    operation: "save_campaign",
                    input: { ...fence, campaignId: campaignEdit.id, campaign },
                  })
                }
              />
            )}
            {view.campaigns.length === 0 && !campaignEdit && (
              <p>{copy.empty}</p>
            )}
            <ul className="divide-y">
              {view.campaigns.map((campaign) => (
                <li
                  className="flex items-center justify-between gap-3 py-3"
                  key={campaign.id}
                >
                  <div>
                    <strong>{campaign.fields.name}</strong>
                    <p className="text-sm text-neutral-600">
                      {lifecycleLabel(copy, campaign.lifecycle)} ·{" "}
                      {campaign.fields.multiplier}× ·{" "}
                      {new Date(campaign.fields.startAt).toLocaleString(locale)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      className={button}
                      disabled={editingDisabled}
                      type="button"
                      onClick={() =>
                        setCampaignEdit({
                          id: campaign.id,
                          value: campaign.fields,
                          economicsEditable: campaign.economicsEditable,
                        })
                      }
                    >
                      {copy.edit}
                    </button>
                    {campaign.lifecycle === "scheduled" && (
                      <button
                        className={button}
                        disabled={editingDisabled}
                        type="button"
                        onClick={() => {
                          if (!window.confirm(copy.confirmRetireCampaign))
                            return;
                          return (
                            fence &&
                            void mutate({
                              operation: "retire_campaign",
                              input: { ...fence, campaignId: campaign.id },
                            })
                          );
                        }}
                      >
                        {copy.retire}
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className={panel}>
            <h2 className="font-semibold">{copy.history}</h2>
            {view.tierHistory.length === 0 ? (
              <p>{copy.empty}</p>
            ) : (
              <ul className="divide-y">
                {view.tierHistory.map((entry) => (
                  <li className="py-2 text-sm" key={entry.id}>
                    {new Date(entry.effectiveAt).toLocaleString(locale)} ·{" "}
                    {historyReasonLabel(copy, entry.changeReason)} ·{" "}
                    {entry.fromTierName ?? "—"} →{" "}
                    {entry.toTierName ?? entry.toTierId ?? copy.noTier}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

export function VipCampaignSession({
  transport,
}: {
  transport: VipCampaignTransport;
}) {
  return <VipCampaignVisit key={transport.scopeKey} transport={transport} />;
}
