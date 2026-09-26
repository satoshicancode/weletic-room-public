import { useLocation } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useMemo, useState } from "react";
import { subscriptionPageSchema } from "../../../apps/web/lib/weletic/shopify/app-pricing-contract";
import { createMerchantJsonPost } from "./staff-access-client";

const copy = {
  en: {
    title: "Shopify subscription",
    loading: "Checking subscription…",
    active: "Subscription verified",
    development: "Development test plan verified",
    inactive:
      "Select a Shopify plan to enable new loyalty benefits and review invitations.",
    unavailable:
      "Subscription verification is unavailable. New benefits stay paused; existing rewards and refunds remain recoverable.",
    plan: "Manage Shopify plan",
    terms:
      "Public plan: US$500/month. Company stores use an assigned private free plan. Manage cancellation in Shopify; verified access lasts through the current paid cycle.",
    support: "Support",
    retry: "Check again",
  },
  ja: {
    title: "Shopifyサブスクリプション",
    loading: "確認中…",
    active: "契約を確認しました",
    development: "開発ストア用プランを確認しました",
    inactive:
      "Shopifyでプランを選択すると、新しいポイント特典とレビュー招待が有効になります。",
    unavailable:
      "契約を確認できません。新しい特典は一時停止されます。既存の特典と返金処理は維持されます。",
    plan: "Shopifyでプランを管理",
    terms:
      "公開プランは月額500米ドルです。自社ストアには非公開の無料プランを割り当てます。解約はShopifyで管理してください。確認済みのアクセスは支払い済み期間の終了まで有効です。",
    support: "サポート",
    retry: "再確認",
  },
  vi: {
    title: "Gói đăng ký Shopify",
    loading: "Đang kiểm tra…",
    active: "Đã xác minh gói đăng ký",
    development: "Đã xác minh gói thử nghiệm cho cửa hàng phát triển",
    inactive:
      "Chọn gói trên Shopify để bật quyền lợi loyalty và lời mời đánh giá mới.",
    unavailable:
      "Chưa thể xác minh gói đăng ký. Quyền lợi mới tạm dừng; phần thưởng hiện có và hoàn tiền vẫn được xử lý.",
    plan: "Quản lý gói trên Shopify",
    terms:
      "Gói công khai: 500 USD/tháng. Cửa hàng công ty dùng gói miễn phí riêng. Quản lý hủy gói trên Shopify; quyền truy cập đã xác minh có hiệu lực đến hết chu kỳ đã thanh toán.",
    support: "Hỗ trợ",
    retry: "Kiểm tra lại",
  },
};

/** Fresh SDK bearer identity is the only input. Welcome URL parameters never
 * grant access. Backend gates benefits independently of this status display. */
export function SubscriptionStatus() {
  const shopify = useAppBridge();
  const location = useLocation();
  const post = useMemo(
    () =>
      createMerchantJsonPost(() => shopify.idToken(), fetch, {
        timeoutMs: 55_000,
      }),
    [shopify],
  );
  const [data, setData] = useState<ReturnType<
    typeof subscriptionPageSchema.parse
  > | null>(null);
  const [busy, setBusy] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [locale, setLocale] = useState<keyof typeof copy>("en");
  useEffect(() => {
    const lang = navigator.language.slice(0, 2);
    if (lang === "ja" || lang === "vi") setLocale(lang);
  }, []);
  useEffect(() => {
    let current = true;
    setBusy(true);
    setData(null);
    void post("/api/installation/billing", {})
      .then((value) => {
        const result = subscriptionPageSchema.parse(value);
        if (current) {
          setData(result);
          window.dispatchEvent(new Event("weletic-subscription-refreshed"));
        }
      })
      .catch(() => {
        if (current) setData(null);
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [post, location.key, attempt]);
  useEffect(() => {
    const timer = window.setInterval(
      () => setAttempt((value) => value + 1),
      240_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const text = copy[locale];
  const state = data?.status ?? "unavailable";
  return (
    <aside aria-label={text.title} style={{ padding: "16px" }}>
      <p role="status" aria-live="polite">
        {busy
          ? text.loading
          : state === "paid" || state === "private_free"
            ? text.active
            : state === "development"
              ? text.development
              : state === "inactive"
                ? text.inactive
                : text.unavailable}
      </p>
      <p>{text.terms}</p>
      {data && (
        <p>
          <a href={data.pricingUrl} target="_top">
            {text.plan}
          </a>{" "}
          · <a href={`mailto:${data.supportEmail}`}>{text.support}</a>
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => setAttempt((value) => value + 1)}
      >
        {text.retry}
      </button>
    </aside>
  );
}
