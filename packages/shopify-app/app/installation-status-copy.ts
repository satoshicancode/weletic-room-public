export const installationStatusCopy = {
  en: {
    title: "Store approval",
    pending_approval:
      "This installation is awaiting company approval. Customer synchronization and loyalty activity are disabled. A company operator must link and approve this store.",
    active:
      "This store is approved. Your Shopify staff permissions still apply.",
    suspended:
      "Access to this store is suspended. Contact your company operator. This screen cannot reactivate loyalty.",
    reauthenticate:
      "This installation is no longer current. Reopen the app from Shopify Admin to authenticate again. Reauthentication does not approve the store.",
    unavailable:
      "Installation status could not be verified. No loyalty activity has been enabled. Try again or contact your company operator.",
  },
  ja: {
    title: "ストアの承認",
    pending_approval:
      "このインストールは会社の承認待ちです。顧客の同期とロイヤルティ機能は無効です。会社の管理担当者によるストアの紐付けと承認が必要です。",
    active:
      "このストアは承認されています。Shopifyスタッフの権限は引き続き適用されます。",
    suspended:
      "このストアへのアクセスは停止中です。会社の管理担当者にお問い合わせください。この画面ではロイヤルティ機能を再開できません。",
    reauthenticate:
      "このインストールは現在無効です。Shopify管理画面からアプリを開き直して再認証してください。再認証だけではストアは承認されません。",
    unavailable:
      "インストールの状態を確認できませんでした。ロイヤルティ機能は有効化されていません。再試行するか会社の管理担当者にお問い合わせください。",
  },
  vi: {
    title: "Phê duyệt cửa hàng",
    pending_approval:
      "Bản cài đặt đang chờ công ty phê duyệt. Đồng bộ khách hàng và hoạt động loyalty đang bị tắt. Người vận hành của công ty cần liên kết và phê duyệt cửa hàng này.",
    active:
      "Cửa hàng đã được phê duyệt. Quyền nhân viên Shopify của bạn vẫn được áp dụng.",
    suspended:
      "Quyền truy cập cửa hàng đang bị đình chỉ. Hãy liên hệ người vận hành của công ty. Màn hình này không thể kích hoạt lại loyalty.",
    reauthenticate:
      "Bản cài đặt này không còn hiệu lực. Hãy mở lại ứng dụng từ Shopify Admin để xác thực lại. Xác thực lại không đồng nghĩa với phê duyệt cửa hàng.",
    unavailable:
      "Không thể xác minh trạng thái cài đặt. Chưa có hoạt động loyalty nào được kích hoạt. Hãy thử lại hoặc liên hệ người vận hành của công ty.",
  },
} as const;
