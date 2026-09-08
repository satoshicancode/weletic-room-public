export const WELETIC_LOCALES = ["en", "vi", "ja"] as const;

export type WeleticLocale = (typeof WELETIC_LOCALES)[number];

export const WELETIC_DEFAULT_LOCALE: WeleticLocale = "en";

const localeAliases: Record<string, WeleticLocale> = {
  en: "en",
  "en-us": "en",
  "en-gb": "en",
  "en-au": "en",
  "en-ca": "en",
  vi: "vi",
  "vi-vn": "vi",
  ja: "ja",
  "ja-jp": "ja",
};

export function resolveWeleticLocale(locale?: string | null): WeleticLocale {
  if (!locale) return WELETIC_DEFAULT_LOCALE;
  const normalized = locale.trim().toLowerCase();
  if (localeAliases[normalized]) return localeAliases[normalized];
  const langPrefix = normalized.split(/[-_]/)[0];
  if (localeAliases[langPrefix]) return localeAliases[langPrefix];
  return WELETIC_DEFAULT_LOCALE;
}

export function resolveLocaleFromAcceptLanguage(
  header?: string | null,
): WeleticLocale {
  if (!header) return WELETIC_DEFAULT_LOCALE;
  // Parse header like "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7,ja;q=0.6"
  const preferences = header
    .split(",")
    .map((item) => {
      const [lang, qPart] = item.trim().split(";");
      const q =
        qPart && qPart.startsWith("q=") ? parseFloat(qPart.slice(2)) : 1.0;
      return { lang: lang.trim(), q: isNaN(q) ? 0 : q };
    })
    .sort((a, b) => b.q - a.q);

  for (const { lang } of preferences) {
    const resolved = resolveWeleticLocale(lang);
    if (
      resolved !== WELETIC_DEFAULT_LOCALE ||
      lang.toLowerCase().startsWith("en")
    ) {
      return resolved;
    }
  }
  return WELETIC_DEFAULT_LOCALE;
}

export function resolveWeleticLocaleHierarchy({
  explicitLocale,
  partnerLocale,
  cookieLocale,
  acceptLanguageHeader,
}: {
  explicitLocale?: string | null;
  partnerLocale?: string | null;
  cookieLocale?: string | null;
  acceptLanguageHeader?: string | null;
}): WeleticLocale {
  if (explicitLocale) return resolveWeleticLocale(explicitLocale);
  if (partnerLocale) return resolveWeleticLocale(partnerLocale);
  if (cookieLocale) return resolveWeleticLocale(cookieLocale);
  if (acceptLanguageHeader) {
    return resolveLocaleFromAcceptLanguage(acceptLanguageHeader);
  }
  return WELETIC_DEFAULT_LOCALE;
}

const messages = {
  en: {
    "catalog.title": "Products",
    "catalog.search": "Search products",
    "catalog.empty": "No products match your filters.",
    "catalog.createLink": "Create affiliate link",
    "catalog.market": "Market",
    "catalog.country": "Country",
    "catalog.language": "Language",
    "catalog.commission": "Commission",
    "catalog.commissionSuffix": "commission",
    "catalog.estimate": "estimate",
    "catalog.available": "Available",
    "catalog.unavailable": "Unavailable",
    "catalog.loadError": "Products could not be loaded.",
    "catalog.noImage": "No image",
    "catalog.variant": "Variant",
    "catalog.linkCopied": "Affiliate link created and copied.",
    "catalog.linkError": "Could not create the link.",
    "reporting.revenue": "Attributed revenue",
    "reporting.title": "Commerce",
    "reporting.earnings": "Commission earnings",
    "reporting.payouts": "Payouts",
    "reporting.orders": "Orders",
    "reporting.refunds": "Refunds",
    "reporting.customerCurrencies": "Customer currencies",
    "reporting.orderSuffix": "orders",
    "reporting.loadError": "Report could not be loaded.",
    "payout.pending": "Pending",
    "payout.completed": "Completed",
    "payout.failed": "Failed",
    "payout.processing": "Processing",
    "settlement.title": "Settlement preferences",
    "settlement.description":
      "Commissions remain in the program accounting currency; this controls your payout quote and localized statement.",
    "settlement.program": "Program",
    "settlement.country": "Country",
    "settlement.currency": "Payout currency",
    "settlement.provider": "Provider",
    "settlement.accountLabel": "Account label",
    "settlement.accountPlaceholder": "e.g. PayPal or bank nickname",
    "settlement.accountLast4": "Destination account last 4 digits",
    "settlement.save": "Save settlement preferences",
    "settlement.submitted":
      "Settlement preferences submitted for verification.",
    "settlement.saveError": "Settlement preferences could not be saved.",
    "settlement.status.draft": "Draft",
    "settlement.status.pending": "Pending verification",
    "settlement.status.verified": "Verified",
    "settlement.status.disabled": "Disabled",
    "profile.regionalTitle": "Language, timezone, and currency",
    "profile.regionalDescription":
      "Choose how product catalogs, reports, dates, and payout estimates are displayed.",
    "profile.language": "Language",
    "profile.timezone": "Timezone",
    "profile.displayCurrency": "Display currency",
    "profile.payoutCurrency": "Preferred payout currency",
    "profile.programDefault": "Program default",
    "statement.title": "Payout Statement",
    "statement.period": "Period",
    "statement.accountingTotal": "Accounting Total",
    "statement.payoutTotal": "Payout Total",
    "statement.exchangeRate": "Exchange Rate",
    "statement.commissions": "Itemized Commissions",
    "statement.date": "Date",
    "statement.description": "Description",
    "statement.amount": "Amount",
    "statement.download": "Download Statement",
    "common.save": "Save",
    "common.saved": "Saved",
    "common.cancel": "Cancel",
    "common.error": "An error occurred",
    "common.loading": "Loading...",
    "common.copied": "Copied to clipboard",
    "errors.unauthorized": "You are not authorized to perform this action.",
    "errors.notFound": "The requested resource was not found.",
    "errors.serverError":
      "An unexpected server error occurred. Please try again later.",
    "errors.invalidInput": "Please check the form inputs and try again.",
    "errors.rateLimit": "Too many requests. Please try again later.",
  },
  vi: {
    "catalog.title": "Sản phẩm",
    "catalog.search": "Tìm kiếm sản phẩm",
    "catalog.empty": "Không có sản phẩm phù hợp với bộ lọc.",
    "catalog.createLink": "Tạo liên kết tiếp thị",
    "catalog.market": "Thị trường",
    "catalog.country": "Quốc gia",
    "catalog.language": "Ngôn ngữ",
    "catalog.commission": "Hoa hồng",
    "catalog.commissionSuffix": "hoa hồng",
    "catalog.estimate": "ước tính",
    "catalog.available": "Có sẵn",
    "catalog.unavailable": "Không có sẵn",
    "catalog.loadError": "Không thể tải sản phẩm.",
    "catalog.noImage": "Không có hình ảnh",
    "catalog.variant": "Phiên bản",
    "catalog.linkCopied": "Đã tạo và sao chép liên kết tiếp thị.",
    "catalog.linkError": "Không thể tạo liên kết.",
    "reporting.revenue": "Doanh thu được ghi nhận",
    "reporting.title": "Thương mại",
    "reporting.earnings": "Thu nhập hoa hồng",
    "reporting.payouts": "Thanh toán",
    "reporting.orders": "Đơn hàng",
    "reporting.refunds": "Hoàn tiền",
    "reporting.customerCurrencies": "Tiền tệ của khách hàng",
    "reporting.orderSuffix": "đơn hàng",
    "reporting.loadError": "Không thể tải báo cáo.",
    "payout.pending": "Đang chờ",
    "payout.completed": "Hoàn tất",
    "payout.failed": "Thất bại",
    "payout.processing": "Đang xử lý",
    "settlement.title": "Tuỳ chọn thanh toán",
    "settlement.description":
      "Hoa hồng vẫn được ghi nhận bằng tiền tệ kế toán của chương trình; lựa chọn này quyết định báo giá thanh toán và sao kê bản địa hoá.",
    "settlement.program": "Chương trình",
    "settlement.country": "Quốc gia",
    "settlement.currency": "Tiền tệ thanh toán",
    "settlement.provider": "Nhà cung cấp",
    "settlement.accountLabel": "Tên gợi nhớ tài khoản",
    "settlement.accountPlaceholder": "Ví dụ: PayPal hoặc tên gợi nhớ ngân hàng",
    "settlement.accountLast4": "4 số cuối tài khoản nhận tiền",
    "settlement.save": "Lưu tuỳ chọn thanh toán",
    "settlement.submitted": "Đã gửi tuỳ chọn thanh toán để xác minh.",
    "settlement.saveError": "Không thể lưu tuỳ chọn thanh toán.",
    "settlement.status.draft": "Bản nháp",
    "settlement.status.pending": "Đang xác minh",
    "settlement.status.verified": "Đã xác minh",
    "settlement.status.disabled": "Đã vô hiệu hoá",
    "profile.regionalTitle": "Ngôn ngữ, múi giờ và tiền tệ",
    "profile.regionalDescription":
      "Chọn cách hiển thị danh mục sản phẩm, báo cáo, ngày tháng và ước tính thanh toán.",
    "profile.language": "Ngôn ngữ",
    "profile.timezone": "Múi giờ",
    "profile.displayCurrency": "Tiền tệ hiển thị",
    "profile.payoutCurrency": "Tiền tệ thanh toán ưu tiên",
    "profile.programDefault": "Mặc định của chương trình",
    "statement.title": "Sao Kê Thanh Toán",
    "statement.period": "Kỳ thanh toán",
    "statement.accountingTotal": "Tổng kế toán",
    "statement.payoutTotal": "Tổng chi trả",
    "statement.exchangeRate": "Tỷ giá quy đổi",
    "statement.commissions": "Danh mục hoa hồng chi tiết",
    "statement.date": "Ngày",
    "statement.description": "Mô tả",
    "statement.amount": "Số tiền",
    "statement.download": "Tải sao kê",
    "common.save": "Lưu",
    "common.saved": "Đã lưu",
    "common.cancel": "Huỷ",
    "common.error": "Đã có lỗi xảy ra",
    "common.loading": "Đang tải...",
    "common.copied": "Đã sao chép vào bộ nhớ tạm",
    "errors.unauthorized": "Bạn không có quyền thực hiện thao tác này.",
    "errors.notFound": "Không tìm thấy tài nguyên yêu cầu.",
    "errors.serverError": "Đã xảy ra lỗi máy chủ. Vui lòng thử lại sau.",
    "errors.invalidInput": "Vui lòng kiểm tra lại thông tin và thử lại.",
    "errors.rateLimit": "Quá nhiều yêu cầu. Vui lòng thử lại sau.",
  },
  ja: {
    "catalog.title": "商品",
    "catalog.search": "商品を検索",
    "catalog.empty": "条件に一致する商品はありません。",
    "catalog.createLink": "アフィリエイトリンクを作成",
    "catalog.market": "マーケット",
    "catalog.country": "国",
    "catalog.language": "言語",
    "catalog.commission": "コミッション",
    "catalog.commissionSuffix": "コミッション",
    "catalog.estimate": "見込み",
    "catalog.available": "販売中",
    "catalog.unavailable": "販売停止中",
    "catalog.loadError": "商品を読み込めませんでした。",
    "catalog.noImage": "画像なし",
    "catalog.variant": "バリエーション",
    "catalog.linkCopied": "アフィリエイトリンクを作成してコピーしました。",
    "catalog.linkError": "リンクを作成できませんでした。",
    "reporting.revenue": "成果売上",
    "reporting.title": "コマース",
    "reporting.earnings": "コミッション収益",
    "reporting.payouts": "支払い",
    "reporting.orders": "注文",
    "reporting.refunds": "返金",
    "reporting.customerCurrencies": "顧客通貨",
    "reporting.orderSuffix": "件の注文",
    "reporting.loadError": "レポートを読み込めませんでした。",
    "payout.pending": "保留中",
    "payout.completed": "完了",
    "payout.failed": "失敗",
    "payout.processing": "処理中",
    "settlement.title": "受取設定",
    "settlement.description":
      "コミッションはプログラムの会計通貨で記録され、この設定が支払い見積もりとローカライズされた明細書に適用されます。",
    "settlement.program": "プログラム",
    "settlement.country": "国",
    "settlement.currency": "受取通貨",
    "settlement.provider": "プロバイダー",
    "settlement.accountLabel": "アカウント表示名",
    "settlement.accountPlaceholder": "例：PayPal または銀行口座の表示名",
    "settlement.accountLast4": "受取口座の下4桁",
    "settlement.save": "受取設定を保存",
    "settlement.submitted": "受取設定を確認のため送信しました。",
    "settlement.saveError": "受取設定を保存できませんでした。",
    "settlement.status.draft": "下書き",
    "settlement.status.pending": "確認中",
    "settlement.status.verified": "確認済み",
    "settlement.status.disabled": "無効",
    "profile.regionalTitle": "言語、タイムゾーン、通貨",
    "profile.regionalDescription":
      "商品カタログ、レポート、日付、支払い見込みの表示方法を選択します。",
    "profile.language": "言語",
    "profile.timezone": "タイムゾーン",
    "profile.displayCurrency": "表示通貨",
    "profile.payoutCurrency": "希望受取通貨",
    "profile.programDefault": "プログラム既定",
    "statement.title": "支払い明細書",
    "statement.period": "対象期間",
    "statement.accountingTotal": "会計合計",
    "statement.payoutTotal": "受取合計",
    "statement.exchangeRate": "為替レート",
    "statement.commissions": "コミッション内訳",
    "statement.date": "日付",
    "statement.description": "内容",
    "statement.amount": "金額",
    "statement.download": "明細書をダウンロード",
    "common.save": "保存",
    "common.saved": "保存しました",
    "common.cancel": "キャンセル",
    "common.error": "エラーが発生しました",
    "common.loading": "読み込み中...",
    "common.copied": "クリップボードにコピーしました",
    "errors.unauthorized": "この操作を行う権限がありません。",
    "errors.notFound": "指定されたリソースが見つかりませんでした。",
    "errors.serverError":
      "サーバーエラーが発生しました。しばらく待ってから再度お試しください。",
    "errors.invalidInput": "入力内容を確認して再度お試しください。",
    "errors.rateLimit":
      "リクエストが多すぎます。しばらく待ってから再度お試しください。",
  },
} as const;

export type WeleticMessageKey = keyof (typeof messages)["en"];

export function getWeleticMessage(
  locale: string | null | undefined,
  key: WeleticMessageKey,
) {
  return messages[resolveWeleticLocale(locale)][key] ?? messages.en[key];
}

export function getWeleticMessages(locale?: string | null) {
  return messages[resolveWeleticLocale(locale)];
}
