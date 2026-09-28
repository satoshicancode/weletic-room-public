import { useLocation } from "@remix-run/react";
import { useAppBridge } from "@shopify/app-bridge-react";
import { useEffect, useMemo, useState } from "react";
import { subscriptionPageSchema } from "../../../apps/web/lib/weletic/shopify/app-pricing-contract";
import { useMerchantLocale } from "./merchant-locale";
import {
  createMerchantJsonPost,
  StaffAccessClientError,
} from "./staff-access-client";

const copy = {
  en: {
    title: "Shopify subscription",
    restricted:
      "Restricted yamaxdev feature testing. Subscription billing is not verified; this access cannot be used in production.",
    restrictedPaused:
      "Restricted testing access is paused until the development installation identity is verified. Subscription billing remains untested.",
    setup:
      "Development setup only. New points, coupons and review rewards are disabled. Registration remains deferred.",
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
    restricted:
      "yamaxdev限定の機能テストです。課金契約は未検証で、本番環境では利用できません。",
    restrictedPaused:
      "開発ストアのインストール情報を確認するまでテスト権限は停止中です。課金契約は未検証です。",
    setup:
      "開発設定専用モードです。新しいポイント・クーポン・レビュー特典は無効です。アプリ登録は保留中です。",
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
    restricted:
      "Thử nghiệm tính năng giới hạn trên yamaxdev. Chưa xác minh thanh toán gói đăng ký; quyền này không dùng được trên production.",
    restrictedPaused:
      "Quyền thử nghiệm tạm dừng cho đến khi xác minh cài đặt trên cửa hàng phát triển. Thanh toán gói đăng ký vẫn chưa được kiểm thử.",
    setup:
      "Chỉ thiết lập môi trường phát triển. Điểm, mã giảm giá và phần thưởng đánh giá mới bị vô hiệu hóa. Đăng ký ứng dụng vẫn được hoãn.",
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
export function SubscriptionStatus({
  setupOnly = false,
  restrictedDevelopment = false,
}: {
  setupOnly?: boolean;
  restrictedDevelopment?: boolean;
}) {
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
  const [locale] = useMerchantLocale();
  useEffect(() => {
    let current = true;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    setBusy(true);
    setData(null);
    const check = async (retried = false) => {
      try {
        const result = subscriptionPageSchema.parse(
          await post("/api/installation/billing", {}),
        );
        if (current) {
          setData(result);
          setBusy(false);
          window.dispatchEvent(new Event("weletic-subscription-refreshed"));
        }
      } catch (error) {
        if (!current) return;
        // App entry may refresh the SDK session during identity verification.
        // Retry this idempotent verification once with fresh authentication;
        // never retry subscription selection or any benefit mutation here.
        if (
          !retried &&
          error instanceof StaffAccessClientError &&
          error.code === "unavailable"
        ) {
          retryTimer = setTimeout(() => void check(true), 750);
          return;
        }
        setData(null);
        setBusy(false);
      }
    };
    void check();
    return () => {
      current = false;
      clearTimeout(retryTimer);
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
        {setupOnly
          ? text.setup
          : busy
            ? text.loading
            : restrictedDevelopment
              ? state === "restricted_development"
                ? text.restricted
                : text.restrictedPaused
              : state === "paid" || state === "private_free"
                ? text.active
                : state === "development"
                  ? text.development
                  : state === "inactive"
                    ? text.inactive
                    : text.unavailable}
      </p>
      {!setupOnly && !restrictedDevelopment && <p>{text.terms}</p>}
      {data && !setupOnly && !restrictedDevelopment && (
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
