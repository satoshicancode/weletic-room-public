export type LoyaltyConfigurationLocale = "en" | "ja" | "vi";

const en = {
  title: "Loyalty configuration",
  language: "Language",
  loading: "Checking access…",
  unavailable:
    "Configuration is unavailable. Reload to check access and current settings.",
  reload: "Reload",
  saved: "Configuration saved.",
  error: "The save could not be confirmed. Reload before trying again.",
  invalid:
    "Check your settings. Use valid numbers and configure all valuation fields together.",
  unchanged: "No settings have changed.",
  save: "Save configuration",
  create: "Create draft program",
  unconfigured:
    "No Loyalty program is configured. Creating one leaves it in draft.",
  readOnly: "You have read-only access to this configuration.",
  ownerOnly:
    "Only the store owner can change lifecycle, emergency controls, or financial valuation.",
  general: "Points and expiry",
  vip: "VIP qualification",
  finance: "Exact financial valuation",
  lifecycle: "Lifecycle and emergency control",
  valuationHelp:
    "Value is accounting-currency minor units per number of points. For ¥1 per 100 points, enter 1 and 100. Blank valuation fields keep monetary analytics unavailable.",
  expiryHelp:
    "Use days or months, not both. Zero disables expiry. Existing balances and immutable earning history are retained.",
  lifecycleHelp:
    "Active programs can earn points. The emergency switch blocks Loyalty operations. Configuration changes do not enable historical backfill commits.",
  currency: "Accounting currency",
  point: "Point",
  points: "Points",
  fields: {
    name: "Program name",
    status: "Program status",
    pointNameSingular: "Point name (singular)",
    pointNamePlural: "Point name (plural)",
    pointsPerCurrencyUnit: "Points per currency unit",
    holdingPeriodDays: "Pending period (days)",
    pointsExpiryMonths: "Expiry (months)",
    pointsExpiryDays: "Expiry (days)",
    pointsExpiryWarningDays: "Warning before expiry (days)",
    pointsExpiryLastChanceDays: "Last warning before expiry (days)",
    pointsExpiryWarningEnabled: "Enable expiry warning",
    pointsExpiryLastChanceEnabled: "Enable last-chance warning",
    killSwitchActive: "Emergency stop",
    vipMilestoneMode: "VIP qualification metric",
    vipTimeframe: "VIP qualification period",
    vipDowngradeGraceDays: "Downgrade grace period (days)",
    vipAutoDowngradeEnabled: "Enable automatic tier downgrade",
    liabilityMinorUnitsNumerator: "Minor units of value",
    liabilityPointsDenominator: "Points for that value",
  },
  options: {
    draft: "Draft",
    test: "Test",
    active: "Active",
    disabled: "Disabled",
    amount_spent: "Amount spent",
    points_earned: "Points earned",
    both: "Both",
    rolling_12m: "Rolling 12 months",
    calendar_year: "Calendar year",
    lifetime: "Lifetime",
  },
};
type Copy = {
  [K in keyof typeof en]: K extends "fields" | "options"
    ? { [P in keyof (typeof en)[K]]: string }
    : string;
};

export const loyaltyConfigurationCopy: Record<
  LoyaltyConfigurationLocale,
  Copy
> = {
  en,
  ja: {
    title: "ロイヤルティ設定",
    language: "言語",
    loading: "アクセス権を確認中…",
    unavailable:
      "設定を取得できません。再読み込みして権限と最新の設定を確認してください。",
    reload: "再読み込み",
    saved: "設定を保存しました。",
    error: "保存を確認できませんでした。再試行する前に再読み込みしてください。",
    invalid:
      "設定を確認してください。有効な数値を入力し、評価額の項目をまとめて設定してください。",
    unchanged: "変更はありません。",
    save: "設定を保存",
    create: "下書きプログラムを作成",
    unconfigured: "プログラムは未設定です。作成後も下書きのままです。",
    readOnly: "この設定は閲覧のみ可能です。",
    ownerOnly:
      "状態、緊急停止、金銭評価を変更できるのはストアオーナーのみです。",
    general: "ポイントと有効期限",
    vip: "VIP判定",
    finance: "正確な金銭評価",
    lifecycle: "状態と緊急停止",
    valuationHelp:
      "ポイント数に対する会計通貨の最小単位で入力します。100ポイント＝1円なら、1と100を入力します。空欄の場合、金銭分析は利用できません。",
    expiryHelp:
      "日数または月数の一方を指定してください。0で有効期限を無効にします。既存の残高と獲得履歴は保持されます。",
    lifecycleHelp:
      "有効なプログラムではポイントを獲得できます。緊急停止はロイヤルティ処理を停止します。過去注文への付与は有効になりません。",
    currency: "会計通貨",
    point: "ポイント",
    points: "ポイント",
    fields: {
      name: "プログラム名",
      status: "プログラムの状態",
      pointNameSingular: "ポイント名（単数）",
      pointNamePlural: "ポイント名（複数）",
      pointsPerCurrencyUnit: "通貨単位あたりのポイント",
      holdingPeriodDays: "保留期間（日）",
      pointsExpiryMonths: "有効期限（月）",
      pointsExpiryDays: "有効期限（日）",
      pointsExpiryWarningDays: "期限前の通知（日）",
      pointsExpiryLastChanceDays: "期限前の最終通知（日）",
      pointsExpiryWarningEnabled: "期限通知を有効化",
      pointsExpiryLastChanceEnabled: "最終通知を有効化",
      killSwitchActive: "緊急停止",
      vipMilestoneMode: "VIP判定基準",
      vipTimeframe: "VIP判定期間",
      vipDowngradeGraceDays: "ランク降格の猶予期間（日）",
      vipAutoDowngradeEnabled: "自動ランク降格を有効化",
      liabilityMinorUnitsNumerator: "通貨の最小単位での評価額",
      liabilityPointsDenominator: "評価額に相当するポイント数",
    },
    options: {
      draft: "下書き",
      test: "テスト",
      active: "有効",
      disabled: "無効",
      amount_spent: "購入金額",
      points_earned: "獲得ポイント",
      both: "両方",
      rolling_12m: "直近12か月",
      calendar_year: "暦年",
      lifetime: "全期間",
    },
  },
  vi: {
    title: "Cấu hình loyalty",
    language: "Ngôn ngữ",
    loading: "Đang kiểm tra quyền truy cập…",
    unavailable:
      "Không thể tải cấu hình. Hãy tải lại để kiểm tra quyền và cài đặt mới nhất.",
    reload: "Tải lại",
    saved: "Đã lưu cấu hình.",
    error: "Chưa xác nhận được kết quả lưu. Hãy tải lại trước khi thử tiếp.",
    invalid:
      "Kiểm tra cài đặt. Nhập số hợp lệ và cấu hình đồng thời các trường định giá.",
    unchanged: "Chưa có thay đổi.",
    save: "Lưu cấu hình",
    create: "Tạo chương trình nháp",
    unconfigured:
      "Chưa cấu hình chương trình loyalty. Chương trình mới sẽ ở trạng thái nháp.",
    readOnly: "Bạn chỉ có quyền xem cấu hình này.",
    ownerOnly:
      "Chỉ chủ cửa hàng được thay đổi trạng thái, dừng khẩn cấp hoặc định giá tài chính.",
    general: "Điểm và thời hạn",
    vip: "Điều kiện VIP",
    finance: "Định giá tài chính chính xác",
    lifecycle: "Trạng thái và dừng khẩn cấp",
    valuationHelp:
      "Nhập đơn vị tiền nhỏ nhất của đồng tiền kế toán cho số điểm tương ứng. Với 1 yên cho 100 điểm, nhập 1 và 100. Để trống các trường định giá sẽ giữ phân tích tiền tệ ở trạng thái không khả dụng.",
    expiryHelp:
      "Chọn ngày hoặc tháng, không dùng cả hai. Số 0 tắt thời hạn. Số dư và lịch sử tích điểm hiện có được giữ nguyên.",
    lifecycleHelp:
      "Chương trình đang hoạt động có thể tích điểm. Dừng khẩn cấp chặn các hoạt động loyalty. Thay đổi cấu hình không mở chức năng cộng điểm cho đơn hàng lịch sử.",
    currency: "Đồng tiền kế toán",
    point: "Điểm",
    points: "Điểm",
    fields: {
      name: "Tên chương trình",
      status: "Trạng thái chương trình",
      pointNameSingular: "Tên điểm (số ít)",
      pointNamePlural: "Tên điểm (số nhiều)",
      pointsPerCurrencyUnit: "Điểm trên mỗi đơn vị tiền",
      holdingPeriodDays: "Thời gian chờ (ngày)",
      pointsExpiryMonths: "Thời hạn (tháng)",
      pointsExpiryDays: "Thời hạn (ngày)",
      pointsExpiryWarningDays: "Thông báo trước hết hạn (ngày)",
      pointsExpiryLastChanceDays: "Thông báo cuối trước hết hạn (ngày)",
      pointsExpiryWarningEnabled: "Bật thông báo hết hạn",
      pointsExpiryLastChanceEnabled: "Bật thông báo cuối",
      killSwitchActive: "Dừng khẩn cấp",
      vipMilestoneMode: "Tiêu chí VIP",
      vipTimeframe: "Kỳ xét VIP",
      vipDowngradeGraceDays: "Thời gian gia hạn trước hạ hạng (ngày)",
      vipAutoDowngradeEnabled: "Bật tự động hạ hạng",
      liabilityMinorUnitsNumerator: "Giá trị theo đơn vị tiền nhỏ nhất",
      liabilityPointsDenominator: "Số điểm tương ứng",
    },
    options: {
      draft: "Nháp",
      test: "Thử nghiệm",
      active: "Hoạt động",
      disabled: "Đã tắt",
      amount_spent: "Số tiền đã chi",
      points_earned: "Điểm đã tích",
      both: "Cả hai",
      rolling_12m: "12 tháng gần nhất",
      calendar_year: "Năm dương lịch",
      lifetime: "Toàn thời gian",
    },
  },
};
