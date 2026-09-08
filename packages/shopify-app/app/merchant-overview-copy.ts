const en = {
  title: "Weletic — Overview",
  language: "Language",
  description:
    "Store catalog status for the native loyalty and reviews workspace.",
  reload: "Reload overview",
  loading: "Loading overview…",
  denied:
    "You do not have overview access. Ask the Shopify account owner to grant permission.",
  reauthenticate: "Reopen Weletic from Shopify Admin to authenticate again.",
  unavailable:
    "Overview is unavailable. Reload to try again; no catalog changes were requested.",
  products: "Products",
  markets: "Markets",
  sync: "Catalog sync",
  lastSync: "Last full sync",
  never: "Not yet recorded",
  staff: "Manage staff access",
  separate:
    "Affiliate administration remains separate in Weletic. Catalog synchronization is not available from this screen yet.",
  status: {
    pending: "Pending",
    running: "Running",
    succeeded: "Succeeded",
    failed: "Failed",
  },
};
type Copy = {
  [K in keyof typeof en]: K extends "status"
    ? { [S in keyof typeof en.status]: string }
    : string;
};
export const merchantOverviewCopy: Record<"en" | "ja" | "vi", Copy> = {
  en,
  ja: {
    title: "Weletic — 概要",
    language: "言語",
    description: "ロイヤルティとレビュー向けのストアカタログの状態です。",
    reload: "概要を再読み込み",
    loading: "概要を読み込み中…",
    denied:
      "概要の表示権限がありません。Shopifyアカウントオーナーに権限の付与を依頼してください。",
    reauthenticate:
      "再認証するには、Shopify管理画面からWeleticを開き直してください。",
    unavailable:
      "概要を取得できません。再読み込みしてください。カタログの変更は要求されていません。",
    products: "商品",
    markets: "マーケット",
    sync: "カタログ同期",
    lastSync: "最終完全同期",
    never: "記録なし",
    staff: "スタッフ権限を管理",
    separate:
      "アフィリエイトの管理はWeleticの別画面で行います。この画面からのカタログ同期はまだ利用できません。",
    status: {
      pending: "待機中",
      running: "実行中",
      succeeded: "成功",
      failed: "失敗",
    },
  },
  vi: {
    title: "Weletic — Tổng quan",
    language: "Ngôn ngữ",
    description:
      "Trạng thái danh mục cửa hàng dành cho loyalty và reviews tích hợp.",
    reload: "Tải lại tổng quan",
    loading: "Đang tải tổng quan…",
    denied:
      "Bạn chưa có quyền xem tổng quan. Hãy yêu cầu chủ tài khoản Shopify cấp quyền.",
    reauthenticate: "Mở lại Weletic từ Shopify Admin để xác thực lại.",
    unavailable:
      "Không thể tải tổng quan. Hãy thử tải lại; không có yêu cầu thay đổi danh mục nào được gửi.",
    products: "Sản phẩm",
    markets: "Thị trường",
    sync: "Đồng bộ danh mục",
    lastSync: "Lần đồng bộ đầy đủ gần nhất",
    never: "Chưa ghi nhận",
    staff: "Quản lý quyền nhân viên",
    separate:
      "Quản lý affiliate vẫn tách biệt trong Weletic. Màn hình này chưa hỗ trợ đồng bộ danh mục.",
    status: {
      pending: "Đang chờ",
      running: "Đang chạy",
      succeeded: "Thành công",
      failed: "Thất bại",
    },
  },
};
