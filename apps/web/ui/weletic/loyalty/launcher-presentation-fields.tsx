import {
  getDefaultLauncherPresentation,
  LAUNCHER_LAYOUTS,
  LAUNCHER_SHAPES,
  LAUNCHER_VISIBILITY,
  type LoyaltyLauncherPresentation,
} from "../../../lib/weletic/loyalty/launcher-presentation";

const labels = {
  en: {
    title: "Launcher display controls",
    desktop: "Desktop",
    mobile: "Mobile (up to 767px)",
    text: "Label override (blank inherits launcher label)",
    position: "Position",
    inherit: "Use launcher position",
    bottom_left: "Bottom left",
    bottom_right: "Bottom right",
    layout: "Layout",
    icon_text: "Icon then text",
    text_icon: "Text then icon",
    icon_only: "Icon only",
    text_only: "Text only",
    sideSpacing: "Side spacing (0–128px)",
    bottomSpacing: "Bottom spacing (0–128px)",
    shape: "Shape",
    square: "Square",
    shaved: "Beveled corners",
    rounded: "Rounded",
    circular: "Pill / circle",
    visibility: "Devices",
    all: "Desktop and mobile",
    desktop_only: "Desktop only",
    hidden: "Hidden",
    hideOnHomepage: "Hide on homepage (including localized homepage)",
    exclusions:
      "Hide on URLs containing any of these strings (one per line, case-sensitive; up to 20)",
  },
  ja: {
    title: "ランチャーの表示設定",
    desktop: "デスクトップ",
    mobile: "モバイル（767px以下）",
    text: "ラベルの上書き（空欄は共通ラベルを使用）",
    position: "位置",
    inherit: "共通の位置を使用",
    bottom_left: "左下",
    bottom_right: "右下",
    layout: "レイアウト",
    icon_text: "アイコン・テキスト",
    text_icon: "テキスト・アイコン",
    icon_only: "アイコンのみ",
    text_only: "テキストのみ",
    sideSpacing: "左右の余白（0〜128px）",
    bottomSpacing: "下の余白（0〜128px）",
    shape: "形状",
    square: "四角",
    shaved: "面取り",
    rounded: "角丸",
    circular: "カプセル・円",
    visibility: "デバイス",
    all: "デスクトップとモバイル",
    desktop_only: "デスクトップのみ",
    hidden: "非表示",
    hideOnHomepage: "ホームページで非表示（言語別ページを含む）",
    exclusions:
      "次の文字列を含むURLで非表示（1行に1件、大文字小文字を区別、最大20件）",
  },
  vi: {
    title: "Điều khiển hiển thị nút mở",
    desktop: "Máy tính",
    mobile: "Di động (tối đa 767px)",
    text: "Nhãn riêng (để trống để dùng nhãn chung)",
    position: "Vị trí",
    inherit: "Dùng vị trí chung",
    bottom_left: "Góc dưới bên trái",
    bottom_right: "Góc dưới bên phải",
    layout: "Bố cục",
    icon_text: "Biểu tượng rồi chữ",
    text_icon: "Chữ rồi biểu tượng",
    icon_only: "Chỉ biểu tượng",
    text_only: "Chỉ chữ",
    sideSpacing: "Khoảng cách cạnh (0–128px)",
    bottomSpacing: "Khoảng cách đáy (0–128px)",
    shape: "Hình dạng",
    square: "Vuông",
    shaved: "Vát góc",
    rounded: "Bo góc",
    circular: "Viên thuốc / tròn",
    visibility: "Thiết bị",
    all: "Máy tính và di động",
    desktop_only: "Chỉ máy tính",
    hidden: "Ẩn",
    hideOnHomepage: "Ẩn trên trang chủ (bao gồm trang chủ theo ngôn ngữ)",
    exclusions:
      "Ẩn khi URL chứa một trong các chuỗi sau (mỗi dòng một chuỗi, phân biệt hoa thường; tối đa 20)",
  },
};

export function LauncherPresentationFields({
  value,
  locale,
  onChange,
}: {
  value?: LoyaltyLauncherPresentation;
  locale: keyof typeof labels;
  onChange: (value: LoyaltyLauncherPresentation) => void;
}) {
  const copy = labels[locale];
  const current = value ?? getDefaultLauncherPresentation();
  const change = (patch: Partial<LoyaltyLauncherPresentation>) =>
    onChange({ ...current, ...patch });
  return (
    <fieldset style={{ minWidth: 0, display: "grid", gap: "1rem" }}>
      <legend>{copy.title}</legend>
      {(["desktop", "mobile"] as const).map((device) => {
        const settings = current[device];
        const update = (patch: Partial<typeof settings>) =>
          change({ [device]: { ...settings, ...patch } });
        return (
          <fieldset
            key={device}
            style={{ minWidth: 0, display: "grid", gap: "0.5rem" }}
          >
            <legend>{copy[device]}</legend>
            <label>
              {copy.text}
              <input
                value={settings.text ?? ""}
                maxLength={40}
                onChange={(event) =>
                  update({ text: event.target.value || null })
                }
              />
            </label>
            <label>
              {copy.position}
              <select
                value={settings.position ?? ""}
                onChange={(event) =>
                  update({
                    position: (event.target.value ||
                      null) as typeof settings.position,
                  })
                }
              >
                <option value="">{copy.inherit}</option>
                {(["bottom_left", "bottom_right"] as const).map((key) => (
                  <option key={key} value={key}>
                    {copy[key]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {copy.layout}
              <select
                value={settings.layout}
                onChange={(event) =>
                  update({
                    layout: event.target.value as typeof settings.layout,
                  })
                }
              >
                {LAUNCHER_LAYOUTS.map((key) => (
                  <option key={key} value={key}>
                    {copy[key]}
                  </option>
                ))}
              </select>
            </label>
            {(["sideSpacing", "bottomSpacing"] as const).map((key) => (
              <label key={key}>
                {copy[key]}
                <input
                  type="number"
                  min={0}
                  max={128}
                  step={1}
                  required
                  value={Number.isNaN(settings[key]) ? "" : settings[key]}
                  onChange={(event) =>
                    update({ [key]: event.target.valueAsNumber })
                  }
                />
              </label>
            ))}
          </fieldset>
        );
      })}
      <label>
        {copy.shape}
        <select
          value={current.shape}
          onChange={(event) =>
            change({ shape: event.target.value as typeof current.shape })
          }
        >
          {LAUNCHER_SHAPES.map((key) => (
            <option key={key} value={key}>
              {copy[key]}
            </option>
          ))}
        </select>
      </label>
      <label>
        {copy.visibility}
        <select
          value={current.visibility}
          onChange={(event) =>
            change({
              visibility: event.target.value as typeof current.visibility,
            })
          }
        >
          {LAUNCHER_VISIBILITY.map((key) => (
            <option key={key} value={key}>
              {copy[key]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={current.hideOnHomepage}
          onChange={(event) => change({ hideOnHomepage: event.target.checked })}
        />
        {copy.hideOnHomepage}
      </label>
      <label>
        {copy.exclusions}
        <textarea
          style={{ width: "100%", boxSizing: "border-box" }}
          rows={4}
          value={current.excludedUrlContains.join("\n")}
          onChange={(event) =>
            change({
              excludedUrlContains:
                event.target.value === "" ? [] : event.target.value.split("\n"),
            })
          }
        />
      </label>
    </fieldset>
  );
}
