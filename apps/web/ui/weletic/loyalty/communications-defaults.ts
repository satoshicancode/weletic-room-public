import {
  loyaltyCommunicationPolicySchema,
  type LoyaltyCommunicationJourney,
} from "../../../lib/weletic/loyalty/communications-contract";

type Locale = "en" | "ja" | "vi";
const messages: Record<
  Locale,
  Record<LoyaltyCommunicationJourney, readonly [string, string]>
> = {
  en: {
    points_earned: [
      "You earned points",
      "You earned {{points}} {{points_label}}. View your account for details.",
    ],
    reward_redeemed: [
      "Your reward confirmation",
      "Your {{reward_name}} reward is ready. View your account for the reward and its terms.",
    ],
    referral_friend: [
      "Your referral reward",
      "You received {{reward_name}}. View your account for eligibility and redemption terms.",
    ],
    referral_advocate: [
      "Your referral was completed",
      "Your referral qualified for {{reward_name}}. View your account for details.",
    ],
    birthday: [
      "Happy birthday!",
      "Celebrate with {{reward_name}}. View your account for your birthday reward and its terms.",
    ],
    vip_achieved: [
      "You reached a new VIP tier",
      "You achieved {{tier_name}}. View your account for tier benefits and membership details.",
    ],
    reward_expiry: [
      "Your reward expires soon",
      "Your {{reward_name}} reward expires on {{expiry_date}}. View your account for its terms.",
    ],
    points_warning: [
      "Your points have an expiry date",
      "Your {{points}} {{points_label}} expire on {{expiry_date}} unless qualifying activity extends their validity. View your account for details.",
    ],
    points_last_chance: [
      "Last chance to keep your points",
      "Your {{points}} {{points_label}} expire on {{expiry_date}} unless qualifying activity extends their validity. View your account for details.",
    ],
  },
  ja: {
    points_earned: [
      "ポイントを獲得しました",
      "{{points}} {{points_label}}を獲得しました。詳細はアカウントでご確認ください。",
    ],
    reward_redeemed: [
      "特典交換のご確認",
      "特典「{{reward_name}}」をご用意しました。特典と利用条件はアカウントでご確認ください。",
    ],
    referral_friend: [
      "紹介特典のお知らせ",
      "特典「{{reward_name}}」を受け取りました。対象条件と利用方法はアカウントでご確認ください。",
    ],
    referral_advocate: [
      "ご紹介が成立しました",
      "ご紹介が特典「{{reward_name}}」の対象になりました。詳細はアカウントでご確認ください。",
    ],
    birthday: [
      "お誕生日おめでとうございます",
      "お誕生日特典「{{reward_name}}」をお楽しみください。特典と利用条件はアカウントでご確認ください。",
    ],
    vip_achieved: [
      "新しいVIPランクに到達しました",
      "{{tier_name}}に到達しました。ランク特典と会員情報はアカウントでご確認ください。",
    ],
    reward_expiry: [
      "特典の有効期限が近づいています",
      "特典「{{reward_name}}」の有効期限は{{expiry_date}}です。利用条件はアカウントでご確認ください。",
    ],
    points_warning: [
      "ポイントの有効期限のお知らせ",
      "{{points}} {{points_label}}の有効期限は{{expiry_date}}です。対象の活動により期限が延長されます。詳細はアカウントでご確認ください。",
    ],
    points_last_chance: [
      "ポイント有効期限の最終のお知らせ",
      "{{points}} {{points_label}}の有効期限は{{expiry_date}}です。対象の活動により期限が延長されます。詳細はアカウントでご確認ください。",
    ],
  },
  vi: {
    points_earned: [
      "Bạn vừa tích điểm",
      "Bạn đã nhận {{points}} {{points_label}}. Xem tài khoản để biết chi tiết.",
    ],
    reward_redeemed: [
      "Xác nhận đổi phần thưởng",
      "Phần thưởng {{reward_name}} của bạn đã sẵn sàng. Xem phần thưởng và điều kiện sử dụng trong tài khoản.",
    ],
    referral_friend: [
      "Phần thưởng giới thiệu của bạn",
      "Bạn đã nhận {{reward_name}}. Xem điều kiện nhận và sử dụng phần thưởng trong tài khoản.",
    ],
    referral_advocate: [
      "Lượt giới thiệu đã hoàn tất",
      "Lượt giới thiệu của bạn đủ điều kiện nhận {{reward_name}}. Xem tài khoản để biết chi tiết.",
    ],
    birthday: [
      "Chúc mừng sinh nhật!",
      "Mừng sinh nhật với {{reward_name}}. Xem phần thưởng sinh nhật và điều kiện sử dụng trong tài khoản.",
    ],
    vip_achieved: [
      "Bạn đã đạt hạng VIP mới",
      "Bạn đã đạt hạng {{tier_name}}. Xem quyền lợi và thông tin thành viên trong tài khoản.",
    ],
    reward_expiry: [
      "Phần thưởng sắp hết hạn",
      "Phần thưởng {{reward_name}} hết hạn vào {{expiry_date}}. Xem điều kiện sử dụng trong tài khoản.",
    ],
    points_warning: [
      "Thông báo ngày hết hạn điểm",
      "{{points}} {{points_label}} của bạn hết hạn vào {{expiry_date}} nếu không có hoạt động đủ điều kiện để gia hạn. Xem tài khoản để biết chi tiết.",
    ],
    points_last_chance: [
      "Nhắc nhở lần cuối về điểm sắp hết hạn",
      "{{points}} {{points_label}} của bạn hết hạn vào {{expiry_date}} nếu không có hoạt động đủ điều kiện để gia hạn. Xem tài khoản để biết chi tiết.",
    ],
  },
};

/** New drafts stay disabled. Existing producer defaults and consent rules are
 * independent; creating editor content never activates a journey. */
export function createDefaultLoyaltyCommunicationPolicy(
  journey: LoyaltyCommunicationJourney,
) {
  const content = (locale: Locale) => {
    const [heading, body] = messages[locale][journey];
    return {
      subject: `${heading} — {{brand_name}}`,
      heading,
      body,
      actionLabel:
        locale === "ja"
          ? "アカウントを見る"
          : locale === "vi"
            ? "Xem tài khoản"
            : "View your account",
    };
  };
  return loyaltyCommunicationPolicySchema.parse({
    journey,
    enabled: false,
    templates: { en: content("en"), ja: content("ja"), vi: content("vi") },
  });
}
