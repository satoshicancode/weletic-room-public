import { DEFAULT_REWARD_PURCHASE_POLICY } from "@/lib/weletic/loyalty/purchase-policy";
import { minorUnitsToDecimal } from "@/lib/weletic/money";
import type { z } from "zod";
import { ReviewError } from "./contracts";
import type { ReviewDisclosure } from "./incentive-disclosure";
import type { reviewCouponAwardSchema } from "./incentive-policy";

const unavailable = () =>
  new ReviewError("unavailable", "Saved coupon disclosure is unavailable");
type Locale = keyof ReviewDisclosure;
const pick = (locale: Locale, en: string, ja: string, vi: string) =>
  ({ en, ja, vi })[locale];

/** Input has already passed snapshot schema/digest validation. Display only
 * terms the native provisioning path honors; never invent caps or restrictions.
 */
export function reviewCouponDisclosure(
  award: z.infer<typeof reviewCouponAwardSchema>,
): ReviewDisclosure {
  const t = award.terms;
  const amount = (value: string) => {
    if (!/^\d+(?:\.0+)?$/.test(value)) throw unavailable();
    return `${minorUnitsToDecimal(BigInt(value.split(".")[0]), t.shopCurrency)} ${t.shopCurrency}`;
  };
  if (t.exchangeType === "incremental" || t.maxDiscountValue !== null)
    throw unavailable();
  const ids = [
    ...t.entitledProductIds,
    ...t.entitledVariantIds,
    ...t.entitledCollectionIds,
  ];
  if (
    ids.length > 250 ||
    new Set(ids).size !== ids.length ||
    t.entitledProductIds.some(
      (id) => !/^gid:\/\/shopify\/Product\/\d+$/.test(id),
    ) ||
    t.entitledVariantIds.some(
      (id) => !/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id),
    ) ||
    t.entitledCollectionIds.some(
      (id) => !/^gid:\/\/shopify\/Collection\/\d+$/.test(id),
    )
  )
    throw unavailable();
  if (!["entire_order", "specific_items"].includes(t.appliesToResource ?? ""))
    throw unavailable();
  if (t.appliesToResource === "entire_order" && ids.length) throw unavailable();
  if (
    t.appliesToResource === "specific_items" &&
    (!ids.length ||
      t.rewardType === "free_shipping" ||
      (t.entitledCollectionIds.length &&
        t.entitledProductIds.length + t.entitledVariantIds.length))
  )
    throw unavailable();
  const labels = new Map(
    award.displayTargets?.map((item) => [item.id, item.name]) ?? [],
  );
  if (
    labels.size !== (award.displayTargets?.length ?? 0) ||
    labels.size !== new Set(ids).size ||
    ids.some((id) => !labels.has(id))
  )
    throw unavailable();
  const targets = ids.map((id) => labels.get(id)!);
  const policy = t.purchasePolicy ?? DEFAULT_REWARD_PURCHASE_POLICY;
  const render = (locale: Locale) => {
    let value: string;
    if (t.rewardType === "free_shipping") {
      if (t.discountValue !== null) throw unavailable();
      value = pick(locale, "Free shipping", "送料無料", "Miễn phí vận chuyển");
    } else if (t.rewardType === "amount_off") {
      if (
        !t.discountValue ||
        !/^\d+(?:\.0+)?$/.test(t.discountValue) ||
        BigInt(t.discountValue.split(".")[0]) <= BigInt(0)
      )
        throw unavailable();
      value = amount(t.discountValue);
    } else {
      if (!t.discountValue || !/^\d+(?:\.\d{1,2})?$/.test(t.discountValue))
        throw unavailable();
      const [whole, fraction = ""] = t.discountValue.split(".");
      const basis =
        BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
      if (basis < BigInt(100) || basis > BigInt(10000)) throw unavailable();
      value = `${t.discountValue}%`;
    }
    const yes = (enabled: boolean) =>
      enabled
        ? pick(locale, "yes", "可", "có")
        : pick(locale, "no", "不可", "không");
    const minimum =
      t.minOrderAmount === null ? amount("0") : amount(t.minOrderAmount);
    const type =
      policy.purchaseType === "one_time"
        ? pick(
            locale,
            "one-time purchases only",
            "通常購入のみ",
            "chỉ mua một lần",
          )
        : policy.purchaseType === "subscription"
          ? pick(
              locale,
              "subscription purchases only",
              "定期購入のみ",
              "chỉ mua theo đăng ký",
            )
          : pick(
              locale,
              "one-time and subscription purchases",
              "通常購入と定期購入",
              "mua một lần và mua theo đăng ký",
            );
    const cadence =
      policy.subscriptionCadence === "first_payment"
        ? pick(
            locale,
            "first payment",
            "初回の支払い",
            "lần thanh toán đầu tiên",
          )
        : policy.subscriptionCadence === "every_payment"
          ? pick(locale, "every payment", "毎回の支払い", "mọi lần thanh toán")
          : pick(
              locale,
              `first ${policy.subscriptionPaymentLimit} payments`,
              `最初の${policy.subscriptionPaymentLimit}回の支払い`,
              `${policy.subscriptionPaymentLimit} lần thanh toán đầu tiên`,
            );
    const lines = [
      pick(
        locale,
        `Participation coupon: ${value}. Online store only.`,
        `投稿特典クーポン：${value}。オンラインストア限定。`,
        `Phiếu giảm giá cho việc đánh giá: ${value}. Chỉ dùng tại cửa hàng trực tuyến.`,
      ),
      pick(
        locale,
        `Minimum order amount: ${minimum}.`,
        `最低注文金額：${minimum}。`,
        `Giá trị đơn hàng tối thiểu: ${minimum}.`,
      ),
      pick(
        locale,
        `Purchase eligibility: ${type}.`,
        `対象購入：${type}。`,
        `Loại giao dịch đủ điều kiện: ${type}.`,
      ),
      ...(policy.purchaseType === "one_time"
        ? []
        : [
            pick(
              locale,
              `Subscription discount applies to ${cadence} after the code is applied, subject to the coupon's use and expiry limits.`,
              `コード適用後の定期購入割引：${cadence}。クーポンの使用回数と有効期限の制限が適用されます。`,
              `Giảm giá đăng ký áp dụng cho ${cadence} sau khi áp dụng mã, tùy giới hạn sử dụng và thời hạn phiếu.`,
            ),
          ]),
      pick(
        locale,
        `Combinations — product discounts: ${yes(t.combinesWithProductDiscounts)}; order discounts: ${yes(t.combinesWithOrderDiscounts)}; shipping discounts: ${yes(t.combinesWithShippingDiscounts)}.`,
        `併用 — 商品割引：${yes(t.combinesWithProductDiscounts)}、注文割引：${yes(t.combinesWithOrderDiscounts)}、送料割引：${yes(t.combinesWithShippingDiscounts)}。`,
        `Kết hợp — giảm giá sản phẩm: ${yes(t.combinesWithProductDiscounts)}; đơn hàng: ${yes(t.combinesWithOrderDiscounts)}; vận chuyển: ${yes(t.combinesWithShippingDiscounts)}.`,
      ),
      pick(
        locale,
        `Total code uses: ${t.usageLimit || 1}. Once per customer: ${yes(t.usageLimitPerCustomer === 1)}.`,
        `コードの総使用回数：${t.usageLimit || 1}。お客様ごとに1回のみ：${yes(t.usageLimitPerCustomer === 1)}。`,
        `Tổng số lần dùng mã: ${t.usageLimit || 1}. Giới hạn một lần mỗi khách: ${yes(t.usageLimitPerCustomer === 1)}.`,
      ),
      t.expiresInDays
        ? pick(
            locale,
            `Expires ${t.expiresInDays} days after reward reservation, not after email delivery.`,
            `特典の予約確定から${t.expiresInDays}日後に失効します。メール配信日からではありません。`,
            `Hết hạn ${t.expiresInDays} ngày sau khi phần thưởng được ghi nhận để cấp, không tính từ lúc gửi email.`,
          )
        : pick(
            locale,
            "No scheduled coupon expiry.",
            "クーポンの有効期限の設定はありません。",
            "Phiếu không có ngày hết hạn được lên lịch.",
          ),
      pick(
        locale,
        "At most one points-or-coupon reward per order across product and store reviews. Valid participation is rewarded independently of rating or publication. This coupon does not require loyalty enrollment.",
        "商品レビューとストアレビューを合わせて、1注文につきポイントまたはクーポンの特典は最大1回です。有効な投稿は評価や公開状況に関係なく対象です。このクーポンにロイヤルティ登録は不要です。",
        "Tối đa một phần thưởng điểm hoặc phiếu cho mỗi đơn, tính chung đánh giá sản phẩm và cửa hàng. Đánh giá hợp lệ được thưởng không phụ thuộc xếp hạng hay đăng công khai. Phiếu này không yêu cầu đăng ký loyalty.",
      ),
    ];
    if (!targets.length)
      lines.push(
        pick(
          locale,
          "No product or collection restriction.",
          "商品・コレクションの制限はありません。",
          "Không giới hạn sản phẩm hoặc bộ sưu tập.",
        ),
      );
    else {
      const prefix = pick(
        locale,
        "Eligible saved catalog items: ",
        "対象となる保存済みカタログ項目：",
        "Mục trong danh mục đã lưu đủ điều kiện: ",
      );
      let line = prefix;
      for (const name of targets) {
        if (line.length + name.length + 2 > 1800) {
          lines.push(line);
          line = prefix;
        }
        line += (line === prefix ? "" : "; ") + name;
      }
      lines.push(line);
    }
    return lines;
  };
  return { en: render("en"), ja: render("ja"), vi: render("vi") };
}
