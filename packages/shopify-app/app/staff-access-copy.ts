const en = {
  title: "Staff access",
  language: "Language",
  description:
    "Only the verified Shopify account owner can manage these store-scoped permissions. Affiliate, billing and workspace access are separate.",
  refresh: "Reload access",
  next: "Next page",
  newGrant: "New grant",
  edit: "Edit",
  empty: "No staff grants on this page.",
  userId: "Shopify staff user ID",
  idHelp:
    "Use the numeric Shopify user ID, not an email address. This does not create a Shopify staff account.",
  permissions: "Permissions",
  save: "Save permissions",
  revoke: "Revoke access",
  clear: "Clear permissions",
  cancel: "Cancel editing",
  saved: "Access updated.",
  loading: "Loading staff access…",
  revision: "Revision",
  note: "Staff start without access. Saving an empty permission list revokes access. Reload to see newly added grants from the beginning.",
  status: {
    active: "Active",
    revoked: "Revoked",
    invalid: "Invalid — requires investigation",
  },
  errors: {
    denied: "Only the verified Shopify account owner can manage staff access.",
    reauthenticate:
      "Open this page again from Shopify Admin, then reload access.",
    reload: "Access changed. Reload before editing again.",
    unavailable:
      "The current result could not be confirmed. Reload access before another change; do not repeat an uncertain save.",
    invalid: "Check the user ID and selected permissions.",
  },
  labels: {
    "overview.read": "View overview",
    "customers.read": "View customers",
    "loyalty.read": "View loyalty",
    "loyalty.configure": "Configure loyalty",
    "loyalty.adjust": "Adjust points",
    "reviews.read": "View reviews",
    "reviews.moderate": "Moderate reviews",
    "reviews.configure": "Configure reviews",
    "campaigns.configure": "Configure campaigns",
    "appearance.configure": "Configure appearance",
    "analytics.read": "View analytics",
    "analytics.export": "Export analytics",
    "settings.configure": "Configure settings",
  },
};
type Copy = {
  [K in keyof typeof en]: (typeof en)[K] extends string
    ? string
    : { [P in keyof (typeof en)[K]]: string };
};
export const staffAccessCopy = {
  en,
  ja: {
    title: "スタッフ権限",
    language: "言語",
    description:
      "確認済みのShopifyアカウントオーナーのみ、このストアの権限を管理できます。アフィリエイト、請求、ワークスペースの権限は別です。",
    refresh: "権限を再読み込み",
    next: "次のページ",
    newGrant: "権限を追加",
    edit: "編集",
    empty: "このページにスタッフ権限はありません。",
    userId: "ShopifyスタッフのユーザーID",
    idHelp:
      "メールアドレスではなく、Shopifyの数値ユーザーIDを入力してください。スタッフアカウントは作成されません。",
    permissions: "権限",
    save: "権限を保存",
    revoke: "アクセスを取り消す",
    clear: "権限をすべて解除",
    cancel: "編集をキャンセル",
    saved: "権限を更新しました。",
    loading: "スタッフ権限を読み込み中…",
    revision: "リビジョン",
    note: "スタッフの初期状態はアクセス不可です。権限を未選択で保存するとアクセスを取り消します。新しい権限を先頭から確認するには再読み込みしてください。",
    status: {
      active: "有効",
      revoked: "取り消し済み",
      invalid: "無効なデータ — 調査が必要です",
    },
    errors: {
      denied: "確認済みのShopifyアカウントオーナーのみ管理できます。",
      reauthenticate:
        "Shopify管理画面からこのページを開き直し、権限を再読み込みしてください。",
      reload: "権限が変更されました。編集前に再読み込みしてください。",
      unavailable:
        "現在の結果を確認できませんでした。変更前に権限を再読み込みしてください。結果が不明な保存を繰り返さないでください。",
      invalid: "ユーザーIDと選択した権限を確認してください。",
    },
    labels: {
      "overview.read": "概要を表示",
      "customers.read": "顧客を表示",
      "loyalty.read": "ロイヤルティを表示",
      "loyalty.configure": "ロイヤルティを設定",
      "loyalty.adjust": "ポイントを調整",
      "reviews.read": "レビューを表示",
      "reviews.moderate": "レビューを管理",
      "reviews.configure": "レビューを設定",
      "campaigns.configure": "キャンペーンを設定",
      "appearance.configure": "外観を設定",
      "analytics.read": "分析を表示",
      "analytics.export": "分析をエクスポート",
      "settings.configure": "設定を変更",
    },
  },
  vi: {
    title: "Quyền nhân viên",
    language: "Ngôn ngữ",
    description:
      "Chỉ chủ tài khoản Shopify đã được xác minh mới được quản lý quyền trong cửa hàng này. Quyền affiliate, thanh toán và workspace được quản lý riêng.",
    refresh: "Tải lại quyền",
    next: "Trang tiếp",
    newGrant: "Cấp quyền mới",
    edit: "Chỉnh sửa",
    empty: "Không có quyền nhân viên trên trang này.",
    userId: "ID người dùng nhân viên Shopify",
    idHelp:
      "Nhập ID người dùng Shopify dạng số, không phải email. Thao tác này không tạo tài khoản nhân viên Shopify.",
    permissions: "Quyền truy cập",
    save: "Lưu quyền",
    revoke: "Thu hồi quyền",
    clear: "Bỏ chọn tất cả quyền",
    cancel: "Hủy chỉnh sửa",
    saved: "Đã cập nhật quyền.",
    loading: "Đang tải quyền nhân viên…",
    revision: "Phiên bản",
    note: "Nhân viên mặc định không có quyền truy cập. Lưu danh sách quyền trống để thu hồi quyền. Tải lại từ đầu để thấy các quyền mới được thêm.",
    status: {
      active: "Đang hoạt động",
      revoked: "Đã thu hồi",
      invalid: "Dữ liệu không hợp lệ — cần kiểm tra",
    },
    errors: {
      denied:
        "Chỉ chủ tài khoản Shopify đã được xác minh mới được quản lý quyền nhân viên.",
      reauthenticate: "Mở lại trang này từ Shopify Admin rồi tải lại quyền.",
      reload: "Quyền đã thay đổi. Hãy tải lại trước khi chỉnh sửa.",
      unavailable:
        "Chưa xác nhận được kết quả hiện tại. Hãy tải lại quyền trước khi thay đổi; không gửi lại thao tác lưu có kết quả chưa rõ.",
      invalid: "Kiểm tra ID người dùng và các quyền đã chọn.",
    },
    labels: {
      "overview.read": "Xem tổng quan",
      "customers.read": "Xem khách hàng",
      "loyalty.read": "Xem loyalty",
      "loyalty.configure": "Cấu hình loyalty",
      "loyalty.adjust": "Điều chỉnh điểm",
      "reviews.read": "Xem đánh giá",
      "reviews.moderate": "Kiểm duyệt đánh giá",
      "reviews.configure": "Cấu hình đánh giá",
      "campaigns.configure": "Cấu hình chiến dịch",
      "appearance.configure": "Cấu hình giao diện",
      "analytics.read": "Xem phân tích",
      "analytics.export": "Xuất phân tích",
      "settings.configure": "Thay đổi cài đặt",
    },
  },
} satisfies Record<"en" | "ja" | "vi", Copy>;
