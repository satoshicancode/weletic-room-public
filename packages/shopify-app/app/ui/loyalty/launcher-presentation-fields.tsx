import {
  BlockStack,
  Card,
  Checkbox,
  InlineGrid,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import {
  getDefaultLauncherPresentation,
  LAUNCHER_LAYOUTS,
  LAUNCHER_SHAPES,
  LAUNCHER_VISIBILITY,
  type LoyaltyLauncherPresentation,
} from "@weletic/contracts/loyalty/launcher-presentation";

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

  const shapeOptions = LAUNCHER_SHAPES.map((key) => ({
    label: copy[key],
    value: key,
  }));

  const visibilityOptions = LAUNCHER_VISIBILITY.map((key) => ({
    label: copy[key],
    value: key,
  }));

  return (
    <Card>
      <BlockStack gap="400">
        <Text as="h3" variant="headingSm">
          {copy.title}
        </Text>
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="400">
          {(["desktop", "mobile"] as const).map((device) => {
            const settings = current[device];
            const update = (patch: Partial<typeof settings>) =>
              change({ [device]: { ...settings, ...patch } });
            const positionOptions = [
              { label: copy.inherit, value: "" },
              ...(["bottom_left", "bottom_right"] as const).map((key) => ({
                label: copy[key],
                value: key,
              })),
            ];
            const layoutOptions = LAUNCHER_LAYOUTS.map((key) => ({
              label: copy[key],
              value: key,
            }));
            return (
              <Card key={device}>
                <BlockStack gap="300">
                  <Text as="h4" variant="headingXs">
                    {copy[device]}
                  </Text>
                  <TextField
                    label={copy.text}
                    autoComplete="off"
                    maxLength={40}
                    value={settings.text ?? ""}
                    onChange={(val) => update({ text: val || null })}
                  />
                  <Select
                    label={copy.position}
                    options={positionOptions}
                    value={settings.position ?? ""}
                    onChange={(val) =>
                      update({
                        position: (val || null) as typeof settings.position,
                      })
                    }
                  />
                  <Select
                    label={copy.layout}
                    options={layoutOptions}
                    value={settings.layout}
                    onChange={(val) =>
                      update({
                        layout: val as typeof settings.layout,
                      })
                    }
                  />
                  {(["sideSpacing", "bottomSpacing"] as const).map((key) => (
                    <TextField
                      key={key}
                      label={copy[key]}
                      type="number"
                      min={0}
                      max={128}
                      step={1}
                      autoComplete="off"
                      value={
                        Number.isNaN(settings[key]) ||
                        settings[key] === undefined ||
                        settings[key] === null
                          ? ""
                          : String(settings[key])
                      }
                      onChange={(val) => {
                        const num = val === "" ? NaN : Number(val);
                        update({ [key]: num });
                      }}
                    />
                  ))}
                </BlockStack>
              </Card>
            );
          })}
        </InlineGrid>
        <Select
          label={copy.shape}
          options={shapeOptions}
          value={current.shape}
          onChange={(val) =>
            change({ shape: val as typeof current.shape })
          }
        />
        <Select
          label={copy.visibility}
          options={visibilityOptions}
          value={current.visibility}
          onChange={(val) =>
            change({ visibility: val as typeof current.visibility })
          }
        />
        <Checkbox
          label={copy.hideOnHomepage}
          checked={current.hideOnHomepage}
          onChange={(checked) => change({ hideOnHomepage: checked })}
        />
        <TextField
          label={copy.exclusions}
          autoComplete="off"
          multiline={4}
          value={current.excludedUrlContains.join("\n")}
          onChange={(val) =>
            change({
              excludedUrlContains: val === "" ? [] : val.split("\n"),
            })
          }
        />
      </BlockStack>
    </Card>
  );
}
