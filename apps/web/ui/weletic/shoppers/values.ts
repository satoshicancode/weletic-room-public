import type { MerchantShopperProfile } from "../../../lib/weletic/shoppers/merchant-response";
import type { ShopperLocale } from "./copy";

type Overview = Extract<MerchantShopperProfile, { section: "overview" }>;
type Page = Exclude<MerchantShopperProfile, Overview>;
type Row<S extends Page["section"]> = Extract<
  Page,
  { section: S }
>["items"][number];

// Browser adapters compile independently of generated database clients.
// Keep translation coverage exhaustive against the shared response contract.
type Value =
  | NonNullable<Overview["modules"]["loyalty"]>["status"]
  | Row<"purchases">["status"]
  | Row<"points">["entryType"]
  | Row<"referrals">["status" | "role"]
  | Row<"reviews">["status" | "rewardStatus"]
  | Row<"rewards">["status" | "artifactKind"]
  | Row<"review_requests">["status"]
  // Retained display label; the browser response contract rejects redacted rows.
  | "redacted";
// All retained enum values are translated. Unknown future values remain visible
// as their original code rather than being misrepresented as a known state.
const values = {
  draft: ["Draft", "下書き", "Bản nháp"],
  test: ["Test", "テスト", "Thử nghiệm"],
  active: ["Active", "有効", "Hoạt động"],
  disabled: ["Disabled", "無効", "Đã tắt"],
  pending: ["Pending", "保留", "Đang chờ"],
  paid: ["Paid", "支払済み", "Đã thanh toán"],
  partially_refunded: [
    "Partially refunded",
    "一部返金済み",
    "Đã hoàn một phần",
  ],
  refunded: ["Refunded", "返金済み", "Đã hoàn tiền"],
  voided: ["Voided", "無効化済み", "Đã vô hiệu"],
  qualified: ["Qualified", "条件達成", "Đủ điều kiện"],
  rewarded: ["Rewarded", "特典付与済み", "Đã thưởng"],
  cancelled: ["Cancelled", "キャンセル済み", "Đã hủy"],
  fraud_blocked: ["Blocked for fraud", "不正により停止", "Bị chặn do gian lận"],
  published: ["Published", "公開中", "Đã công bố"],
  hidden: ["Hidden", "非表示", "Đã ẩn"],
  rejected: ["Rejected", "却下", "Bị từ chối"],
  redacted: ["Redacted", "匿名化済み", "Đã xóa dữ liệu cá nhân"],
  awarded: ["Awarded", "付与済み", "Đã cấp"],
  ineligible: ["Ineligible", "対象外", "Không đủ điều kiện"],
  reversed: ["Reversed", "取消済み", "Đã thu hồi"],
  invalidated: ["Invalidated", "無効化済み", "Đã vô hiệu"],
  recovery_pending: ["Recovery pending", "回収処理待ち", "Đang chờ thu hồi"],
  unrecoverable: [
    "Benefit already used",
    "利用済み特典・回収不可",
    "Quyền lợi đã dùng, không thể thu hồi",
  ],
  provisioning: ["Provisioning", "発行処理中", "Đang cấp"],
  issued: ["Issued", "発行済み", "Đã phát hành"],
  used: ["Used", "利用済み", "Đã sử dụng"],
  failed: ["Failed", "失敗", "Thất bại"],
  expired: ["Expired", "期限切れ", "Hết hạn"],
  queued: ["Queued", "待機中", "Trong hàng đợi"],
  sending: ["Sending", "送信中", "Đang gửi"],
  sent: ["Send recorded", "送信記録あり", "Đã ghi nhận gửi"],
  submitted: ["Submitted", "投稿済み", "Đã gửi đánh giá"],
  discount_code: ["Discount code", "割引コード", "Mã giảm giá"],
  gift_card: ["Gift card", "ギフトカード", "Thẻ quà tặng"],
  store_credit: ["Store credit", "ストアクレジット", "Tín dụng cửa hàng"],
  advocate: ["Advocate", "紹介者", "Người giới thiệu"],
  friend: ["Friend", "紹介された顧客", "Người được giới thiệu"],
  EARN_ORDER: ["Purchase earning", "購入ポイント", "Điểm mua hàng"],
  EARN_REFERRAL: ["Referral earning", "紹介ポイント", "Điểm giới thiệu"],
  EARN_BONUS: ["Bonus earning", "ボーナスポイント", "Điểm thưởng"],
  REDEEM_REWARD: ["Reward redemption", "特典交換", "Đổi thưởng"],
  REFUND_REVERSAL: [
    "Refund reversal",
    "返金による取消",
    "Thu hồi do hoàn tiền",
  ],
  MANUAL_ADJUSTMENT: ["Manual adjustment", "手動調整", "Điều chỉnh thủ công"],
  EXPIRATION: ["Points expiration", "ポイント失効", "Điểm hết hạn"],
  BACKFILL: ["Historical credit", "過去分付与", "Cấp điểm lịch sử"],
  BACKFILL_CORRECTION: [
    "Historical correction",
    "過去分修正",
    "Điều chỉnh điểm lịch sử",
  ],
  TIER_BONUS: ["Tier bonus", "ランクボーナス", "Thưởng theo hạng"],
} satisfies Record<Value, [string, string, string]>;

export function shopperValue(value: string, locale: ShopperLocale): string {
  return Object.prototype.hasOwnProperty.call(values, value)
    ? values[value as Value][{ en: 0, ja: 1, vi: 2 }[locale]]
    : value;
}
