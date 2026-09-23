import { createElement } from "react";
import { ReviewError } from "./contracts";

const copy = {
  en: {
    subject: "How was your store experience?",
    introduction:
      "Share an honest review of your store experience. All ratings are welcome.",
    action: "Sign in and open Store Reviews",
    noReward: "No reward was promised for this invitation.",
  },
  ja: {
    subject: "ストアでの体験はいかがでしたか？",
    introduction:
      "ストアでの体験について率直なレビューをお聞かせください。どの評価も歓迎します。",
    action: "ログインしてストアレビューを開く",
    noReward: "この案内には特典の約束はありません。",
  },
  vi: {
    subject: "Trải nghiệm của bạn với cửa hàng thế nào?",
    introduction:
      "Chia sẻ đánh giá trung thực về cửa hàng. Mọi mức đánh giá đều được chào đón.",
    action: "Đăng nhập và mở Đánh giá cửa hàng",
    noReward: "Lời mời này không hứa hẹn phần thưởng.",
  },
} as const;

/** The installed account page URL is shop-specific. Until its direct URL has
 * been accepted in the installed runtime, link only to Shopify's account entry
 * and tell the shopper to open Store Reviews from the account menu.
 */
export function storeReviewAccountEntryUrl(shopDomain: string) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain))
    throw new ReviewError("unavailable", "Invalid storefront domain");
  return `https://${shopDomain}/account`;
}

export function renderStoreReviewInvitationEmail(input: {
  language: "en" | "ja" | "vi";
  brandName: string;
  logoUrl: string | null;
  accentColor: string | null;
  url: string;
  disclosure: string[];
}) {
  const words = copy[input.language];
  const paragraphs = input.disclosure.length
    ? input.disclosure
    : [words.noReward];
  return {
    subject: words.subject,
    text: [
      input.brandName,
      words.subject,
      words.introduction,
      ...paragraphs,
      `${words.action}: ${input.url}`,
    ].join("\n\n"),
    react: createElement(
      "div",
      {
        lang: input.language,
        style: {
          borderTop: input.accentColor
            ? `4px solid ${input.accentColor}`
            : undefined,
        },
      },
      input.logoUrl
        ? createElement("img", {
            src: input.logoUrl,
            alt: input.brandName,
            width: 160,
          })
        : null,
      createElement("h1", null, input.brandName),
      createElement("p", null, words.subject),
      createElement("p", null, words.introduction),
      ...paragraphs.map((line, index) =>
        createElement("p", { key: index }, line),
      ),
      createElement("a", { href: input.url }, words.action),
    ),
  };
}
