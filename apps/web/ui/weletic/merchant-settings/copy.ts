const en = {
  title: "Loyalty & reviews settings",
  language: "Interface language",
  brand: "Shared branding",
  brandName: "Brand name",
  logoUrl: "Public HTTPS logo URL",
  accentColor: "Accent color (#RRGGBB)",
  defaultLocale: "Default customer language",
  timeZone: "Saved timezone (IANA; not yet applied)",
  pause: "Pause new shopper email deliveries",
  pauseNote:
    "Review invitations, referral coupons and expiry notices are paused. Messages already in flight may finish. Balances and expiry processing continue; resuming does not bypass consent or other eligibility checks.",
  timezoneNote:
    "Leave blank if not confirmed. This value is stored only: it does not yet change delivery timing or date displays. Shopify and existing birthday/campaign/expiry policies remain unchanged.",
  brandNote:
    "Shared brand settings are independent of loyalty enrollment. Blank values retain legacy/default branding. Specialized widget layouts remain in Appearance.",
  modules: "Modules",
  loyalty: "Loyalty",
  reviews: "Reviews",
  enable: "Enable",
  disable: "Disable",
  moduleNote:
    "Module switches preserve balances and submitted reviews. Disabling reviews cancels outstanding invitations; enabling does not send historical requests.",
  kill: "Loyalty kill switch is active. Review it in advanced loyalty settings before resuming operations.",
  legacy:
    "Review incentive policy cutover is still pending. Enabling reviews does not certify the new participation-based incentive policy.",
  owner: "Only workspace owners can change these settings.",
  save: "Save shared settings",
  saving: "Saving…",
  saved: "Settings saved",
  error:
    "Unable to save. Reload and check your input or access before trying again.",
  loading: "Loading settings…",
  unavailable: "Settings are unavailable. No previous workspace data is shown.",
  reload: "Reload",
  invalid:
    "Check the changed fields: use supported languages, a named timezone, HTTPS logo URL and a six-digit hex color.",
  preview: "Brand preview",
  unconfigured: "Not configured",
  active: "Active",
  draft: "Draft",
  test: "Test",
  disabled: "Disabled",
};
export type MerchantSettingsLocale = "en" | "ja" | "vi";
type Copy = Record<keyof typeof en, string>;
export const merchantSettingsCopy: Record<MerchantSettingsLocale, Copy> = {
  en,
  ja: {
    title: "ロイヤルティとレビューの設定",
    language: "表示言語",
    brand: "共通ブランド",
    brandName: "ブランド名",
    logoUrl: "公開HTTPSロゴURL",
    accentColor: "アクセントカラー（#RRGGBB）",
    defaultLocale: "顧客の既定言語",
    timeZone: "保存用タイムゾーン（IANA・未適用）",
    pause: "新しい顧客メールの配信を一時停止",
    pauseNote:
      "レビュー依頼、紹介クーポン、有効期限通知を一時停止します。送信中のメールは完了する場合があります。残高と失効処理は継続し、再開後も同意と配信条件を確認します。",
    timezoneNote:
      "未確認の場合は空欄にしてください。保存のみで、配信時刻や日付表示にはまだ適用されません。Shopifyや既存の誕生日・キャンペーン・失効ポリシーも変更されません。",
    brandNote:
      "共通ブランドは会員登録とは独立しています。空欄は従来の設定または既定値を使用します。ウィジェットのレイアウトは外観設定で管理します。",
    modules: "モジュール",
    loyalty: "ロイヤルティ",
    reviews: "レビュー",
    enable: "有効にする",
    disable: "無効にする",
    moduleNote:
      "残高と投稿済みレビューは保持されます。レビューの無効化は未完了の依頼をキャンセルします。有効化しても過去の注文への依頼は送信されません。",
    kill: "ロイヤルティの緊急停止が有効です。再開前に詳細設定を確認してください。",
    legacy:
      "レビュー報酬ポリシーの切り替えは未完了です。有効化は参加ベースの新ポリシーの検証完了を意味しません。",
    owner: "設定を変更できるのはワークスペースのオーナーのみです。",
    save: "共通設定を保存",
    saving: "保存中…",
    saved: "設定を保存しました",
    error: "保存できませんでした。再読み込みして入力と権限を確認してください。",
    loading: "設定を読み込み中…",
    unavailable:
      "設定を取得できません。以前のワークスペースのデータは表示されません。",
    reload: "再読み込み",
    invalid:
      "言語、IANAタイムゾーン、HTTPSロゴURL、6桁のカラーコードを確認してください。",
    preview: "ブランドのプレビュー",
    unconfigured: "未設定",
    active: "有効",
    draft: "下書き",
    test: "テスト",
    disabled: "無効",
  },
  vi: {
    title: "Cài đặt loyalty và reviews",
    language: "Ngôn ngữ giao diện",
    brand: "Thương hiệu dùng chung",
    brandName: "Tên thương hiệu",
    logoUrl: "URL logo HTTPS công khai",
    accentColor: "Màu nhấn (#RRGGBB)",
    defaultLocale: "Ngôn ngữ mặc định của khách hàng",
    timeZone: "Múi giờ đã lưu (IANA; chưa áp dụng)",
    pause: "Tạm dừng gửi email mới cho khách hàng",
    pauseNote:
      "Tạm dừng lời mời đánh giá, coupon giới thiệu và thông báo hết hạn điểm. Email đang gửi có thể hoàn tất. Số dư và xử lý hết hạn vẫn tiếp tục; tiếp tục gửi vẫn phải đáp ứng điều kiện và sự đồng ý.",
    timezoneNote:
      "Để trống nếu chưa xác nhận. Giá trị chỉ được lưu, chưa áp dụng cho lịch gửi hoặc hiển thị ngày giờ. Không thay đổi múi giờ Shopify hay chính sách sinh nhật, chiến dịch và hết hạn hiện có.",
    brandNote:
      "Thương hiệu dùng chung độc lập với việc tham gia loyalty. Để trống để dùng giá trị cũ hoặc mặc định. Bố cục widget vẫn nằm trong phần Giao diện.",
    modules: "Mô-đun",
    loyalty: "Loyalty",
    reviews: "Reviews",
    enable: "Bật",
    disable: "Tắt",
    moduleNote:
      "Giữ nguyên số dư và đánh giá đã gửi. Tắt reviews sẽ hủy lời mời chưa hoàn tất; bật lại không gửi lời mời cho đơn hàng cũ.",
    kill: "Loyalty đang bị dừng khẩn cấp. Kiểm tra cài đặt nâng cao trước khi tiếp tục.",
    legacy:
      "Chưa hoàn tất chuyển đổi chính sách thưởng đánh giá. Bật reviews không có nghĩa chính sách thưởng dựa trên tham gia đã được nghiệm thu.",
    owner: "Chỉ chủ workspace được thay đổi cài đặt.",
    save: "Lưu cài đặt chung",
    saving: "Đang lưu…",
    saved: "Đã lưu cài đặt",
    error:
      "Không thể lưu. Hãy tải lại và kiểm tra dữ liệu hoặc quyền truy cập.",
    loading: "Đang tải cài đặt…",
    unavailable:
      "Không thể tải cài đặt. Không hiển thị dữ liệu của workspace trước.",
    reload: "Tải lại",
    invalid:
      "Kiểm tra ngôn ngữ, múi giờ IANA, URL logo HTTPS và mã màu sáu chữ số.",
    preview: "Xem trước thương hiệu",
    unconfigured: "Chưa cấu hình",
    active: "Đang bật",
    draft: "Bản nháp",
    test: "Thử nghiệm",
    disabled: "Đã tắt",
  },
};
