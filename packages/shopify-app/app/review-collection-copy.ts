export const reviewCollectionCopy = {
  en: {
    title: "Review collection",
    load: "Load collection settings",
    reload: "Discard draft and reload",
    loading: "Loading…",
    saving: "Saving…",
    saved: "Collection settings saved.",
    failed: "Unable to confirm current settings. Reload before trying again.",
    denied: "You do not have permission to configure reviews.",
    invalid:
      "Use whole days within the displayed limits. Reminders must increase and precede expiry.",
    timing:
      "New invitations use these settings. Existing invitation schedules and incentive promises do not change.",
    disabled:
      "Reviews are disabled. Saving these settings does not enable the module.",
    send: "Days after fulfillment (0–60)",
    expiry: "Invitation validity in days (1–90)",
    email: "Send review invitation emails",
    photos: "Allow photo uploads",
    publish: "Automatically publish valid reviews of every rating",
    reminders:
      "Reminder days after confirmed first email (up to 3, comma-separated; blank means off)",
    note: "Reminders reuse the same single-use invitation and reward promise. Disabling emails cancels pending reminders; enabling again does not revive them.",
    confirm: "I understand the email and publication changes above.",
    save: "Save collection settings",
  },
  ja: {
    title: "レビュー収集",
    load: "収集設定を読み込む",
    reload: "下書きを破棄して再読み込み",
    loading: "読み込み中…",
    saving: "保存中…",
    saved: "収集設定を保存しました。",
    failed:
      "現在の設定を確認できません。再試行する前に再読み込みしてください。",
    denied: "レビューを設定する権限がありません。",
    invalid:
      "表示された範囲内の整数を入力してください。リマインダーは昇順で、有効期限より前に設定してください。",
    timing:
      "この設定は新しい招待に適用されます。既存の招待日程や特典の約束は変更されません。",
    disabled:
      "レビューモジュールは無効です。この設定を保存しても有効にはなりません。",
    send: "発送完了後の日数（0～60）",
    expiry: "招待の有効日数（1～90）",
    email: "レビュー招待メールを送信",
    photos: "写真のアップロードを許可",
    publish: "評価に関係なく有効なレビューを自動公開",
    reminders:
      "初回メールの送信確認からの日数（最大3件、カンマ区切り。空欄で無効）",
    note: "リマインダーは同じ一度限りの招待と特典を使用します。メールを無効にすると未送信のリマインダーは取り消され、再度有効にしても復活しません。",
    confirm: "上記のメールと公開設定の変更を理解しました。",
    save: "収集設定を保存",
  },
  vi: {
    title: "Thu thập đánh giá",
    load: "Tải cài đặt thu thập",
    reload: "Bỏ bản nháp và tải lại",
    loading: "Đang tải…",
    saving: "Đang lưu…",
    saved: "Đã lưu cài đặt thu thập.",
    failed:
      "Không thể xác nhận cài đặt hiện tại. Hãy tải lại trước khi thử lại.",
    denied: "Bạn không có quyền cấu hình đánh giá.",
    invalid:
      "Nhập số ngày nguyên trong giới hạn. Các lần nhắc phải tăng dần và trước ngày hết hạn.",
    timing:
      "Cài đặt áp dụng cho lời mời mới. Lịch gửi và phần thưởng đã cam kết của lời mời cũ không thay đổi.",
    disabled: "Mô-đun đánh giá đang tắt. Lưu cài đặt này không bật mô-đun.",
    send: "Số ngày sau khi hoàn tất giao hàng (0–60)",
    expiry: "Số ngày lời mời có hiệu lực (1–90)",
    email: "Gửi email mời đánh giá",
    photos: "Cho phép tải ảnh",
    publish: "Tự động công khai đánh giá hợp lệ ở mọi mức sao",
    reminders:
      "Số ngày sau email đầu tiên đã xác nhận gửi (tối đa 3, phân cách bằng dấu phẩy; để trống để tắt)",
    note: "Email nhắc dùng lại lời mời một lần và phần thưởng đã cam kết. Tắt email sẽ hủy các lần nhắc đang chờ; bật lại không khôi phục chúng.",
    confirm: "Tôi hiểu các thay đổi về email và công khai đánh giá ở trên.",
    save: "Lưu cài đặt thu thập",
  },
} as const;
