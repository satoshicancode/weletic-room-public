import { createElement } from "react";

const copy = {
  en: {
    subject: (product: string) => `How was ${product}?`,
    introduction:
      "Share an honest review to help other shoppers. All ratings are welcome.",
    action: "Write a review",
    legacy: "Any available loyalty reward is independent of your rating.",
  },
  ja: {
    subject: (product: string) => `${product}はいかがでしたか？`,
    introduction:
      "他のお客様の参考になるよう、率直なレビューをお聞かせください。どのような評価も歓迎します。",
    action: "レビューを書く",
    legacy: "利用可能なロイヤルティ特典は評価の内容に左右されません。",
  },
  vi: {
    subject: (product: string) => `Bạn thấy ${product} thế nào?`,
    introduction:
      "Chia sẻ đánh giá trung thực để giúp người mua khác. Mọi xếp hạng đều được chào đón.",
    action: "Viết đánh giá",
    legacy:
      "Phần thưởng loyalty, nếu có, không phụ thuộc vào xếp hạng của bạn.",
  },
};

export function reviewInvitationLocale(
  value: string | null | undefined,
): "en" | "ja" | "vi" {
  const language = value?.toLowerCase().split(/[-_]/)[0];
  return language === "ja" || language === "vi" ? language : "en";
}

/** Pure rendering: no database reads, transport or current-policy lookup.
 * The delivery layer owns authorization and must freeze this input for retries.
 */
export function renderReviewInvitationEmail(input: {
  language: "en" | "ja" | "vi";
  productTitle: string;
  brandName: string;
  logoUrl: string | null;
  accentColor: string | null;
  url: string;
  disclosure: string[];
}) {
  const words = copy[input.language];
  // Shopify catalog strings cannot inject email header lines.
  const subject = words.subject(input.productTitle.replace(/[\r\n]+/g, " "));
  const paragraphs = input.disclosure.length
    ? input.disclosure
    : [words.legacy];
  return {
    subject,
    text: [
      input.brandName,
      subject,
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
      createElement("p", null, subject),
      createElement("p", null, words.introduction),
      ...paragraphs.map((line, index) =>
        createElement("p", { key: index }, line),
      ),
      createElement("a", { href: input.url }, words.action),
    ),
  };
}
