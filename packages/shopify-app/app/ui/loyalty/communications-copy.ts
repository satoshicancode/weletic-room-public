export const communicationsCopy = {
  en: {
    rewardExpiryConnected:
      "Connected for unused discount rewards and account-backed referral coupons with verified issuance and expiry. Reminders become due 72 hours before expiry; delayed reminders can run only before expiry. Gift Cards, Store Credit and anonymous friend coupons are not supported. Dates currently display in UTC. Delivery still requires consent, an active program, an approved sender and running scheduler/worker. Saving does not send email; disabling also stops queued reminders.",
    rewardExpirySaved:
      "Saved for future eligible reward-expiry reminders. No email was sent.",
    rewardExpiryEnabled:
      "Allow discount reward-expiry reminders (consent and configured delivery required)",
    redemptionConnected:
      "New reservations with verified installation provenance can produce notices after confirmed reward issuance. Existing reservations are not backfilled. Consent and delivery settings still apply.",
    redemptionSaved:
      "Saved for future confirmed-redemption notices. No email was sent.",
    redemptionEnabled:
      "Allow confirmed-redemption notices (consent and delivery settings required)",
    vipConnected:
      "Connected for new threshold-based VIP promotions, including requalification after a downgrade. Manual or imported tier placement, maintenance and downgrades do not send achievement notices. Superseded notices are suppressed. Delivery requires an approved sender, running worker, customer consent and an active program. Queued notices keep saved content; disabling also stops queued notices. Saving does not send email.",
    vipSaved: "Saved for future VIP achievement notices. No email was sent.",
    vipEnabled:
      "Allow VIP achievement notices (requires consent and configured delivery)",
    birthdayConnected:
      "Connected after a fresh annual birthday points award. This is not an advance birthday reminder or a separate reward schedule. Delivery requires an approved sender, running worker, customer consent and an active program. Queued notices keep saved content; disabling also stops queued notices. Saving does not send email.",
    birthdaySaved:
      "Saved for future birthday award notices. No email was sent.",
    birthdayEnabled:
      "Allow birthday award notices (requires consent and configured delivery)",
    signupWithBirthdayConnected:
      "Connected for newly available purchase points (including matured holds) and new signup awards. Birthday notices use the separate Birthday journey. Manual and other point sources are not connected. Delivery requires an approved sender, running worker, customer consent and an active program. Queued notices keep saved content; disabling also stops queued notices. Saving does not send email.",
    signupConnected:
      "Connected for newly available purchase points (including matured holds) and new signup awards. Manual, birthday and other point sources are not connected. Delivery requires an approved sender, running worker, customer consent and an active program. Queued notices keep saved content; disabling also stops queued notices. Saving does not send email.",
    signupSaved:
      "Saved for future purchase-point and signup notices. No email was sent.",
    signupEnabled:
      "Allow purchase-point and signup notices (requires consent and configured delivery)",
    purchaseConnected:
      "Connected for newly available purchase points, including matured holds. Signup, manual, birthday and other point sources are not connected. Delivery requires an approved sender, running worker, customer consent and an active program. Queued notices keep saved content; disabling also stops queued notices. Saving does not send email.",
    purchaseSaved:
      "Saved for future purchase-point notices. No email was sent.",
    purchaseEnabled:
      "Allow purchase-point notices (requires consent and configured delivery)",
    expiryConnected:
      "Expiry templates apply to newly scheduled notices. Queued notices keep their saved content. Disabling stops queued notices too. Existing timing, consent and email pause controls still apply; saving does not send an email.",
    expirySaved: "Saved for future expiry notices. No email was sent.",
    expiryEnabled:
      "Allow this expiry notice (requires existing timing and consent)",
    title: "Loyalty communications",
    language: "Editor language",
    journey: "Journey",
    contentLanguage: "Message language",
    disconnected:
      "Delivery is not connected to these policies yet. Saving content or an enablement preference does not send email, change existing expiry reminders, or grant customer consent.",
    loading: "Loading…",
    error: "Unable to confirm the latest state. Reload before saving again.",
    invalid:
      "Check all three languages: use plain text and only the variables listed for this journey.",
    reload: "Reload and discard draft",
    discard: "Discard changes",
    save: "Save all languages",
    saved: "Saved. Delivery remains disconnected.",
    readonly:
      "You can view these policies but do not have permission to configure them.",
    enabled: "Enablement preference (delivery disconnected)",
    subject: "Subject",
    heading: "Heading",
    body: "Message",
    actionLabel: "Button label",
    variables: "Allowed variables",
    preview: "Sample preview — no customer data",
    mobile: "Mobile preview",
    desktop: "Desktop preview",
    dirty: "Unsaved changes. Save or discard before changing journeys.",
  },
  ja: {
    rewardExpiryConnected:
      "発行と有効期限を確認できる未使用の割引特典、および会員アカウントに紐づく紹介クーポンに対応しています。有効期限の72時間前から通知対象となり、遅延時も期限前のみ配信できます。ギフトカード、ストアクレジット、匿名の紹介先クーポンは対象外です。日付は現在UTC表示です。配信には同意、有効なプログラム、承認済み送信者、稼働中のスケジューラーとワーカーが必要です。保存だけでは送信せず、無効化すると待機中の通知も停止します。",
    rewardExpirySaved:
      "今後の対象特典の期限通知用に保存しました。メールは送信していません。",
    rewardExpiryEnabled: "割引特典の期限通知を許可する（同意と配信設定が必要）",
    redemptionConnected:
      "インストール時の情報を確認できる新規予約では、特典の発行確定後に通知できます。既存の予約には遡って適用しません。同意と配信設定が必要です。",
    redemptionSaved:
      "今後の特典交換確定通知用に保存しました。メールは送信していません。",
    redemptionEnabled: "特典交換確定通知を許可する（同意と配信設定が必要）",
    vipConnected:
      "条件達成による新しいVIP昇格に対応しています。降格後の再昇格も対象です。手動設定、インポート、ランク維持、降格では達成通知を送りません。後のランク変更により古くなった通知は送信しません。配信には承認済み送信者、稼働中のワーカー、お客様の同意、有効なプログラムが必要です。待機中の通知は保存時の内容を保持します。無効化すると待機中の通知も停止します。保存だけではメールを送信しません。",
    vipSaved: "今後のVIP達成通知用に保存しました。メールは送信していません。",
    vipEnabled: "VIP達成通知を許可する（同意と配信設定が必要）",
    birthdayConnected:
      "新たな年次誕生日ポイント付与後の通知に接続されています。事前リマインダーや別の特典スケジュールではありません。配信には承認済み送信元、稼働中のワーカー、お客様の同意、有効なプログラムが必要です。予約済み通知の内容は維持され、無効化すると予約済み通知も停止します。保存だけでは送信されません。",
    birthdaySaved:
      "今後の誕生日ポイント付与通知用に保存しました。メールは送信していません。",
    birthdayEnabled: "誕生日ポイント付与通知を許可（同意と配信設定が必要）",
    signupWithBirthdayConnected:
      "購入で新たに利用可能になったポイント（保留期間終了分を含む）と新規会員登録のポイント付与に接続されています。誕生日通知は別の誕生日ジャーニーを使用します。手動付与などのポイントは未接続です。配信には承認済み送信元、稼働中のワーカー、お客様の同意、有効なプログラムが必要です。予約済み通知の内容は維持され、無効化すると予約済み通知も停止します。保存だけでは送信されません。",
    signupConnected:
      "購入で新たに利用可能になったポイント（保留期間終了分を含む）と新規会員登録のポイント付与に接続されています。手動付与、誕生日などのポイントは未接続です。配信には承認済み送信元、稼働中のワーカー、お客様の同意、有効なプログラムが必要です。予約済み通知の内容は維持され、無効化すると予約済み通知も停止します。保存だけでは送信されません。",
    signupSaved:
      "今後の購入・会員登録ポイント通知用に保存しました。メールは送信していません。",
    signupEnabled: "購入・会員登録ポイント通知を許可（同意と配信設定が必要）",
    purchaseConnected:
      "購入で新たに利用可能になったポイント（保留期間終了分を含む）に接続されています。会員登録、手動付与、誕生日などのポイントは未接続です。配信には承認済み送信元、稼働中のワーカー、お客様の同意、有効なプログラムが必要です。予約済み通知の内容は維持され、無効化すると予約済み通知も停止します。保存だけでは送信されません。",
    purchaseSaved:
      "今後の購入ポイント通知用に保存しました。メールは送信していません。",
    purchaseEnabled: "購入ポイント通知を許可（同意と配信設定が必要）",
    expiryConnected:
      "失効通知のテンプレートは新しく予約される通知に適用されます。予約済み通知の内容は維持されます。無効化すると予約済み通知も停止します。既存の配信時期、同意、メール一時停止の条件は引き続き適用され、保存だけでは送信されません。",
    expirySaved: "今後の失効通知用に保存しました。メールは送信していません。",
    expiryEnabled: "この失効通知を許可（既存の配信時期と同意が必要）",
    title: "ロイヤルティ通知",
    language: "編集画面の言語",
    journey: "通知の種類",
    contentLanguage: "メッセージの言語",
    disconnected:
      "この設定はまだ配信に接続されていません。内容や有効化の希望を保存しても、メールの送信、既存の失効通知の変更、お客様の同意の付与は行われません。",
    loading: "読み込み中…",
    error:
      "最新の状態を確認できませんでした。再保存する前に読み込み直してください。",
    invalid:
      "3言語の内容を確認してください。プレーンテキストと、この通知で使用できる変数のみを使用してください。",
    reload: "再読み込みして下書きを破棄",
    discard: "変更を破棄",
    save: "全言語を保存",
    saved: "保存しました。配信にはまだ接続されていません。",
    readonly: "設定を閲覧できますが、変更する権限がありません。",
    enabled: "有効化の希望（配信未接続）",
    subject: "件名",
    heading: "見出し",
    body: "本文",
    actionLabel: "ボタンの文言",
    variables: "使用できる変数",
    preview: "サンプルプレビュー — 顧客データなし",
    mobile: "モバイル表示",
    desktop: "デスクトップ表示",
    dirty:
      "未保存の変更があります。通知を切り替える前に保存または破棄してください。",
  },
  vi: {
    rewardExpiryConnected:
      "Đã kết nối cho phần thưởng giảm giá chưa sử dụng và mã giới thiệu gắn với tài khoản thành viên, có bằng chứng phát hành và hạn dùng. Nhắc hạn bắt đầu trước khi hết hạn 72 giờ; thông báo bị chậm chỉ được gửi trước hạn. Chưa hỗ trợ Gift Card, Store Credit và mã cho người được giới thiệu chưa có tài khoản. Ngày hiện hiển thị theo UTC. Gửi thư vẫn cần sự đồng ý, chương trình hoạt động, người gửi được duyệt và bộ lập lịch/worker đang chạy. Lưu không gửi email; tắt cũng dừng các lời nhắc đang chờ.",
    rewardExpirySaved:
      "Đã lưu cho lời nhắc hết hạn phần thưởng đủ điều kiện trong tương lai. Chưa gửi email.",
    rewardExpiryEnabled:
      "Cho phép nhắc hết hạn phần thưởng giảm giá (cần sự đồng ý và cấu hình gửi thư)",
    redemptionConnected:
      "Các yêu cầu đổi thưởng mới có thông tin cài đặt đã xác minh có thể tạo thông báo sau khi phần thưởng được cấp thành công. Không áp dụng hồi tố cho yêu cầu cũ. Vẫn cần sự đồng ý và cấu hình gửi.",
    redemptionSaved:
      "Đã lưu cho các thông báo đổi thưởng thành công trong tương lai. Chưa gửi email.",
    redemptionEnabled:
      "Cho phép thông báo đổi thưởng thành công (cần sự đồng ý và cấu hình gửi)",
    vipConnected:
      "Đã kết nối với lần thăng hạng VIP mới khi đạt điều kiện, kể cả thăng hạng lại sau khi bị hạ hạng. Không gửi thông báo thành tích khi gán hạng thủ công, nhập dữ liệu, duy trì hoặc hạ hạng. Thông báo đã lỗi thời do thay đổi hạng sau đó sẽ không được gửi. Cần người gửi được phê duyệt, worker đang chạy, sự đồng ý của khách hàng và chương trình đang hoạt động. Thông báo chờ giữ nguyên nội dung đã lưu; tắt cũng dừng thông báo đang chờ. Lưu không gửi email.",
    vipSaved:
      "Đã lưu cho các thông báo đạt hạng VIP trong tương lai. Chưa gửi email.",
    vipEnabled:
      "Cho phép thông báo đạt hạng VIP (cần sự đồng ý và cấu hình gửi)",
    birthdayConnected:
      "Đã kết nối sau khi cấp điểm sinh nhật mới hằng năm. Đây không phải lời nhắc trước sinh nhật hoặc lịch thưởng riêng. Cần người gửi được phê duyệt, worker đang chạy, sự đồng ý của khách hàng và chương trình hoạt động. Thông báo đã xếp hàng giữ nội dung đã lưu; tắt cũng ngăn các thông báo này. Lưu không gửi email.",
    birthdaySaved:
      "Đã lưu cho thông báo thưởng sinh nhật sau này. Chưa gửi email.",
    birthdayEnabled:
      "Cho phép thông báo thưởng sinh nhật (cần sự đồng ý và cấu hình gửi)",
    signupWithBirthdayConnected:
      "Đã kết nối cho điểm mua hàng mới khả dụng (bao gồm điểm hết thời gian chờ) và điểm thưởng đăng ký mới. Thông báo sinh nhật dùng hành trình Sinh nhật riêng. Điểm thủ công và các nguồn khác chưa được kết nối. Cần người gửi được phê duyệt, worker đang chạy, sự đồng ý của khách hàng và chương trình hoạt động. Thông báo đã xếp hàng giữ nội dung đã lưu; tắt cũng ngăn các thông báo này. Lưu không gửi email.",
    signupConnected:
      "Đã kết nối cho điểm mua hàng mới khả dụng (bao gồm điểm hết thời gian chờ) và điểm thưởng đăng ký mới. Điểm thủ công, sinh nhật và các nguồn khác chưa được kết nối. Cần người gửi được phê duyệt, worker đang chạy, sự đồng ý của khách hàng và chương trình hoạt động. Thông báo đã xếp hàng giữ nội dung đã lưu; tắt cũng ngăn các thông báo này. Lưu không gửi email.",
    signupSaved:
      "Đã lưu cho thông báo điểm mua hàng và đăng ký sau này. Chưa gửi email.",
    signupEnabled:
      "Cho phép thông báo điểm mua hàng và đăng ký (cần sự đồng ý và cấu hình gửi)",
    purchaseConnected:
      "Đã kết nối cho điểm mua hàng mới khả dụng, bao gồm điểm hết thời gian chờ. Điểm đăng ký, thủ công, sinh nhật và các nguồn khác chưa được kết nối. Cần người gửi được phê duyệt, worker đang chạy, sự đồng ý của khách hàng và chương trình hoạt động. Thông báo đã xếp hàng giữ nội dung đã lưu; tắt cũng ngăn các thông báo này. Lưu không gửi email.",
    purchaseSaved:
      "Đã lưu cho thông báo điểm mua hàng sau này. Chưa gửi email.",
    purchaseEnabled:
      "Cho phép thông báo điểm mua hàng (cần sự đồng ý và cấu hình gửi)",
    expiryConnected:
      "Mẫu hết hạn áp dụng cho thông báo được lên lịch mới. Thông báo đã xếp hàng giữ nội dung đã lưu. Tắt cũng ngăn thông báo đang xếp hàng. Thời điểm, sự đồng ý và chế độ tạm dừng email hiện có vẫn được áp dụng; lưu không gửi email.",
    expirySaved: "Đã lưu cho thông báo hết hạn sau này. Chưa gửi email.",
    expiryEnabled:
      "Cho phép thông báo hết hạn này (cần thời điểm và sự đồng ý hiện có)",
    title: "Thông báo khách hàng thân thiết",
    language: "Ngôn ngữ trình chỉnh sửa",
    journey: "Loại thông báo",
    contentLanguage: "Ngôn ngữ nội dung",
    disconnected:
      "Các chính sách này chưa được kết nối với hệ thống gửi. Lưu nội dung hoặc tùy chọn bật không gửi email, không thay đổi lời nhắc hết hạn hiện có và không cấp sự đồng ý thay cho khách hàng.",
    loading: "Đang tải…",
    error:
      "Không thể xác nhận trạng thái mới nhất. Hãy tải lại trước khi lưu tiếp.",
    invalid:
      "Kiểm tra cả ba ngôn ngữ: chỉ dùng văn bản thuần và các biến được liệt kê cho thông báo này.",
    reload: "Tải lại và bỏ bản nháp",
    discard: "Bỏ thay đổi",
    save: "Lưu cả ba ngôn ngữ",
    saved: "Đã lưu. Hệ thống gửi vẫn chưa được kết nối.",
    readonly:
      "Bạn có thể xem nhưng không có quyền chỉnh sửa các chính sách này.",
    enabled: "Tùy chọn bật (chưa kết nối gửi)",
    subject: "Tiêu đề email",
    heading: "Tiêu đề nội dung",
    body: "Nội dung",
    actionLabel: "Nhãn nút",
    variables: "Các biến được phép",
    preview: "Xem trước mẫu — không có dữ liệu khách hàng",
    mobile: "Xem trên di động",
    desktop: "Xem trên máy tính",
    dirty:
      "Có thay đổi chưa lưu. Hãy lưu hoặc bỏ thay đổi trước khi đổi loại thông báo.",
  },
};
