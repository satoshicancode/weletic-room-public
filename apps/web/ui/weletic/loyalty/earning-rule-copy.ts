import type { EarningRuleForm } from "./earning-rule-form";
export type EarningRuleLocale = "en" | "ja" | "vi";
const en = {
  save: "Save rule",
  shopCurrency: "Current shop currency",
  currencyUnavailable: "Unavailable",
  currencyBasis:
    "Minimum subtotal is evaluated in each order's shop currency, not the program accounting currency. No currency conversion is applied to this threshold.",
  cancel: "Cancel",
  invalid: "Check the highlighted settings.",
  honor:
    "Honor system: opening or claiming a social action does not verify a follow, like, or share.",
  review:
    "Legacy review earning rules depend on publication and provider eligibility, not star rating. Hiding, deleting or invalidating a review can reverse points. These settings do not configure participation-based incentives. Enable the selected reviews provider before activation.",
  purchase:
    "Taxes and shipping are excluded. Existing line-level refund allocation is preserved.",
  reset:
    "Changing the trigger resets earning settings and turns activation off.",
  fields: {
    name: "Rule name",
    description: "Description",
    triggerCode: "Trigger",
    priority: "Priority",
    multiplier: "Purchase multiplier",
    fixedPoints: "Points awarded",
    maxPointsPerEvent: "Maximum points per event (optional)",
    minOrderSubtotal: "Minimum order subtotal (optional)",
    maxEventsPerCustomer: "Maximum events per customer",
    limitInterval: "Limit period",
    excludeDiscountedItems: "Exclude discounted items",
    isActive: "Active",
    targetUrl: "Destination HTTPS URL",
    shareMessage: "Share message (optional)",
    provider: "Reviews provider",
    minContentLength: "Minimum review length",
    photoBonusPoints: "Photo bonus points",
    videoBonusPoints: "Video bonus points",
  } satisfies Record<keyof EarningRuleForm, string>,
  triggers: {
    order_paid: "Paid order",
    account_created: "Account created",
    birthday: "Birthday",
    product_review: "Product review",
    facebook_like: "Facebook like",
    facebook_share: "Facebook share",
    instagram_follow: "Instagram follow",
    x_share: "Share on X",
    x_follow: "Follow on X",
    tiktok_follow: "TikTok follow",
    link_click: "Open link",
  },
  periods: {
    lifetime: "Lifetime",
    monthly: "Monthly",
    calendar_year: "Calendar year",
  },
  providers: {
    native: "Weletic reviews",
    judgeme: "Judge.me (legacy integration)",
  },
};
type Copy = {
  [K in keyof typeof en]: (typeof en)[K] extends string
    ? string
    : { [P in keyof (typeof en)[K]]: string };
};
export const earningRuleCopy: Record<EarningRuleLocale, Copy> = {
  en,
  ja: {
    save: "ルールを保存",
    shopCurrency: "現在のショップ通貨",
    currencyUnavailable: "取得できません",
    currencyBasis:
      "最低小計はプログラムの会計通貨ではなく、各注文のショップ通貨で判定されます。このしきい値に通貨換算は適用されません。",
    cancel: "キャンセル",
    invalid: "表示された設定を確認してください。",
    honor:
      "自己申告制：リンクを開く操作や申請では、フォロー・いいね・共有の実行は確認できません。",
    review:
      "従来のレビュー獲得ルールは星評価ではなく、公開状況と連携先の適格条件に基づきます。非表示・削除・無効化によりポイントが取り消される場合があります。この設定では参加型インセンティブは設定できません。有効化前に選択したレビュー連携を有効にしてください。",
    purchase: "税金と送料は対象外です。既存の明細別返金配分を維持します。",
    reset: "トリガーを変更すると獲得設定がリセットされ、無効になります。",
    fields: {
      name: "ルール名",
      description: "説明",
      triggerCode: "トリガー",
      priority: "優先度",
      multiplier: "購入ポイント倍率",
      fixedPoints: "付与ポイント",
      maxPointsPerEvent: "イベントごとのポイント上限（任意）",
      minOrderSubtotal: "注文小計の最低額（任意）",
      maxEventsPerCustomer: "顧客ごとのイベント上限",
      limitInterval: "制限期間",
      excludeDiscountedItems: "割引商品を除外",
      isActive: "有効",
      targetUrl: "移動先HTTPS URL",
      shareMessage: "共有メッセージ（任意）",
      provider: "レビュー連携",
      minContentLength: "レビューの最小文字数",
      photoBonusPoints: "写真ボーナスポイント",
      videoBonusPoints: "動画ボーナスポイント",
    },
    triggers: {
      order_paid: "支払済み注文",
      account_created: "アカウント作成",
      birthday: "誕生日",
      product_review: "商品レビュー",
      facebook_like: "Facebookいいね",
      facebook_share: "Facebook共有",
      instagram_follow: "Instagramフォロー",
      x_share: "Xで共有",
      x_follow: "Xでフォロー",
      tiktok_follow: "TikTokフォロー",
      link_click: "リンクを開く",
    },
    periods: { lifetime: "全期間", monthly: "月ごと", calendar_year: "暦年" },
    providers: { native: "Weleticレビュー", judgeme: "Judge.me（既存連携）" },
  },
  vi: {
    save: "Lưu quy tắc",
    shopCurrency: "Tiền tệ hiện tại của cửa hàng",
    currencyUnavailable: "Chưa có thông tin",
    currencyBasis:
      "Tổng tiền hàng tối thiểu được xét theo tiền tệ cửa hàng của từng đơn, không phải tiền tệ kế toán của chương trình. Ngưỡng này không được quy đổi tiền tệ.",
    cancel: "Hủy",
    invalid: "Kiểm tra các cài đặt được đánh dấu.",
    honor:
      "Tự khai báo: mở liên kết hoặc yêu cầu điểm không xác minh lượt theo dõi, thích hay chia sẻ.",
    review:
      "Quy tắc tích điểm đánh giá cũ phụ thuộc trạng thái xuất bản và điều kiện của nhà cung cấp, không phụ thuộc số sao. Ẩn, xóa hoặc vô hiệu hóa đánh giá có thể thu hồi điểm. Các cài đặt này không cấu hình ưu đãi dựa trên việc tham gia. Cần bật nhà cung cấp đánh giá đã chọn trước khi kích hoạt.",
    purchase:
      "Không tính thuế và phí vận chuyển. Giữ nguyên phân bổ hoàn tiền theo từng dòng hàng.",
    reset:
      "Đổi điều kiện kích hoạt sẽ đặt lại cài đặt tích điểm và tắt quy tắc.",
    fields: {
      name: "Tên quy tắc",
      description: "Mô tả",
      triggerCode: "Điều kiện kích hoạt",
      priority: "Độ ưu tiên",
      multiplier: "Hệ số điểm mua hàng",
      fixedPoints: "Điểm thưởng",
      maxPointsPerEvent: "Điểm tối đa mỗi sự kiện (tùy chọn)",
      minOrderSubtotal: "Tổng tiền hàng tối thiểu (tùy chọn)",
      maxEventsPerCustomer: "Số sự kiện tối đa mỗi khách hàng",
      limitInterval: "Chu kỳ giới hạn",
      excludeDiscountedItems: "Loại trừ hàng giảm giá",
      isActive: "Kích hoạt",
      targetUrl: "URL HTTPS đích",
      shareMessage: "Nội dung chia sẻ (tùy chọn)",
      provider: "Nhà cung cấp đánh giá",
      minContentLength: "Độ dài đánh giá tối thiểu",
      photoBonusPoints: "Điểm thưởng ảnh",
      videoBonusPoints: "Điểm thưởng video",
    },
    triggers: {
      order_paid: "Đơn đã thanh toán",
      account_created: "Tạo tài khoản",
      birthday: "Sinh nhật",
      product_review: "Đánh giá sản phẩm",
      facebook_like: "Thích Facebook",
      facebook_share: "Chia sẻ Facebook",
      instagram_follow: "Theo dõi Instagram",
      x_share: "Chia sẻ trên X",
      x_follow: "Theo dõi trên X",
      tiktok_follow: "Theo dõi TikTok",
      link_click: "Mở liên kết",
    },
    periods: {
      lifetime: "Trọn đời",
      monthly: "Hàng tháng",
      calendar_year: "Năm dương lịch",
    },
    providers: {
      native: "Đánh giá Weletic",
      judgeme: "Judge.me (tích hợp cũ)",
    },
  },
};
