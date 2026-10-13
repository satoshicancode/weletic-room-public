const en = {
  deliveryTitle: "Shared email delivery",
  deliveryEnabled: "Configure delivery policy",
  deliveryNote:
    "Loyalty and Reviews share these limits. Anonymous confirmations and later signed-in messages use the same email budget; customer limits also apply across email changes.",
  quietEnabled: "Set quiet hours",
  quietStart: "Quiet hours start",
  quietEnd: "Quiet hours end",
  messageLimit: "Maximum messages in any 24 hours (1–100)",
  limitNote:
    "Leave blank for no frequency limit. Quiet hours may cross midnight; start and end must differ. Uncertain send attempts count toward the limit.",
  deliveryProspective:
    "Changes apply at the next delivery check, including pending messages. Messages already in flight may finish. Saving does not create requests for past orders or extend message expiry. Turning this policy off keeps the separate email pause in effect.",
  deliveryInvalid:
    "Confirm an IANA timezone, different quiet-hours start and end, and a whole-number limit from 1 to 100 or leave the limit blank.",
  title: "Loyalty & reviews settings",
  language: "Interface language",
  brand: "Shared branding",
  brandName: "Brand name",
  logoUrl: "Public HTTPS logo URL",
  accentColor: "Accent color (#RRGGBB)",
  defaultLocale: "Default customer language",
  timeZone: "Saved timezone (IANA)",
  pause: "Pause new shopper email deliveries",
  pauseNote:
    "Review invitations, referral coupons and expiry notices are paused. Messages already in flight may finish. Balances and expiry processing continue; resuming does not bypass consent or other eligibility checks.",
  timezoneNote:
    "A configured delivery policy requires a confirmed IANA timezone, such as Asia/Tokyo. Quiet hours use this timezone. Birthday, campaign and points-expiry dates keep their existing policies.",
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
    deliveryTitle: "共通メール配信",
    deliveryEnabled: "配信ルールを設定する",
    deliveryNote:
      "ロイヤルティとレビューで制限を共有します。匿名の確認メールと登録後のメールは同じメールアドレスの上限を使用し、アドレス変更後も顧客ごとの上限が適用されます。",
    quietEnabled: "配信休止時間を設定する",
    quietStart: "配信休止の開始時刻",
    quietEnd: "配信休止の終了時刻",
    messageLimit: "任意の24時間の最大配信数（1〜100）",
    limitNote:
      "空欄は配信数の制限なしです。休止時間は日付をまたげますが、開始と終了は異なる時刻にしてください。結果が不明な送信試行も上限に含みます。",
    deliveryProspective:
      "変更は保留中のメールを含め、次の配信確認から適用されます。送信中のメールは完了する場合があります。保存しても過去の注文への依頼は作成されず、有効期限も延長されません。ルールを解除しても、別途設定したメールの一時停止は維持されます。",
    deliveryInvalid:
      "IANAタイムゾーン、異なる休止開始・終了時刻、1〜100の整数の上限を確認してください。上限は空欄にもできます。",
    title: "ロイヤルティとレビューの設定",
    language: "表示言語",
    brand: "共通ブランド",
    brandName: "ブランド名",
    logoUrl: "公開HTTPSロゴURL",
    accentColor: "アクセントカラー（#RRGGBB）",
    defaultLocale: "顧客の既定言語",
    timeZone: "配信用タイムゾーン（IANA）",
    pause: "新しい顧客メールの配信を一時停止",
    pauseNote:
      "レビュー依頼、紹介クーポン、有効期限通知を一時停止します。送信中のメールは完了する場合があります。残高と失効処理は継続し、再開後も同意と配信条件を確認します。",
    timezoneNote:
      "配信ルールには、Asia/Tokyoなど確認済みのIANAタイムゾーンが必要です。配信休止時間に適用します。誕生日・キャンペーン・ポイント失効の日付は既存のポリシーに従います。",
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
    deliveryTitle: "Gửi email dùng chung",
    deliveryEnabled: "Cấu hình chính sách gửi",
    deliveryNote:
      "Loyalty và Reviews dùng chung giới hạn. Email xác nhận ẩn danh và email sau khi đăng nhập dùng cùng hạn mức theo địa chỉ email; giới hạn theo khách hàng vẫn áp dụng khi đổi email.",
    quietEnabled: "Đặt khung giờ tạm ngừng gửi",
    quietStart: "Giờ bắt đầu tạm ngừng",
    quietEnd: "Giờ kết thúc tạm ngừng",
    messageLimit: "Số email tối đa trong bất kỳ 24 giờ nào (1–100)",
    limitNote:
      "Để trống nếu không giới hạn số email. Khung giờ có thể qua nửa đêm; giờ bắt đầu và kết thúc phải khác nhau. Lần gửi chưa xác định kết quả vẫn tính vào hạn mức.",
    deliveryProspective:
      "Thay đổi áp dụng từ lần kiểm tra gửi tiếp theo, kể cả email đang chờ. Email đang gửi có thể hoàn tất. Lưu không tạo yêu cầu cho đơn hàng cũ hay gia hạn email. Tắt chính sách này vẫn giữ cài đặt tạm dừng email riêng biệt.",
    deliveryInvalid:
      "Xác nhận múi giờ IANA, giờ bắt đầu và kết thúc khác nhau, và giới hạn là số nguyên từ 1 đến 100 hoặc để trống giới hạn.",
    title: "Cài đặt loyalty và reviews",
    language: "Ngôn ngữ giao diện",
    brand: "Thương hiệu dùng chung",
    brandName: "Tên thương hiệu",
    logoUrl: "URL logo HTTPS công khai",
    accentColor: "Màu nhấn (#RRGGBB)",
    defaultLocale: "Ngôn ngữ mặc định của khách hàng",
    timeZone: "Múi giờ đã lưu (IANA)",
    pause: "Tạm dừng gửi email mới cho khách hàng",
    pauseNote:
      "Tạm dừng lời mời đánh giá, coupon giới thiệu và thông báo hết hạn điểm. Email đang gửi có thể hoàn tất. Số dư và xử lý hết hạn vẫn tiếp tục; tiếp tục gửi vẫn phải đáp ứng điều kiện và sự đồng ý.",
    timezoneNote:
      "Cần xác nhận múi giờ IANA, ví dụ Asia/Ho_Chi_Minh, khi cấu hình chính sách gửi. Khung giờ tạm ngừng dùng múi giờ này. Ngày sinh nhật, chiến dịch và hết hạn điểm vẫn theo chính sách hiện có.",
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
