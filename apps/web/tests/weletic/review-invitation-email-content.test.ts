import {
  renderReviewInvitationEmail,
  reviewInvitationLocale,
} from "@/lib/weletic/reviews/invitation-email-content";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const input = {
  language: "en" as const,
  productTitle: "Product",
  brandName: "Weletic",
  logoUrl: null,
  accentColor: "#123456",
  url: "https://shop.myshopify.com/apps/weletic/reviews/write?locale=en#token=fixture",
  disclosure: ["10 points for valid participation", "One reward per order"],
};

describe("review invitation email content", () => {
  it.each([
    ["en", "How was Product?", "Write a review"],
    ["ja", "Productはいかがでしたか？", "レビューを書く"],
    ["vi", "Bạn thấy Product thế nào?", "Viết đánh giá"],
  ] as const)(
    "localizes subject, introduction and action in %s",
    (language, subject, action) => {
      const result = renderReviewInvitationEmail({ ...input, language });
      const html = renderToStaticMarkup(result.react);
      expect(result.subject).toBe(subject);
      expect(result.text).toContain(action);
      expect(html).toContain(`lang="${language}"`);
      expect(html).toContain(action);
      for (const promise of input.disclosure) {
        expect(result.text).toContain(promise);
        expect(html).toContain(promise);
      }
      if (language !== "en") {
        expect(result.text).not.toContain("All ratings are welcome");
        expect(html).not.toContain("Write a review");
      }
    },
  );
  it.each([
    ["JA-jp", "ja"],
    ["vi_VN", "vi"],
    [null, "en"],
    ["fr", "en"],
    ["javascript:ja", "en"],
  ])(
    "normalizes %s without reflecting unsupported locales",
    (value, expected) => {
      expect(reviewInvitationLocale(value)).toBe(expected);
    },
  );
  it("escapes catalog, brand and disclosure text and strips subject header breaks", () => {
    const result = renderReviewInvitationEmail({
      ...input,
      productTitle: "<img src=x>\r\nBcc: victim",
      brandName: "<script>bad()</script>",
      disclosure: ["<iframe src=x>"],
    });
    expect(result.subject).not.toMatch(/[\r\n]/);
    const html = renderToStaticMarkup(result.react);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;iframe");
  });
  it("does not add a generic reward promise to explicit none disclosure", () => {
    const result = renderReviewInvitationEmail({
      ...input,
      disclosure: ["No points or coupon are offered."],
    });
    expect(result.text).not.toContain("Any available loyalty reward");
    expect(renderToStaticMarkup(result.react)).not.toContain(
      "Any available loyalty reward",
    );
  });
  it("uses translated legacy wording only when there is no versioned disclosure", () => {
    const result = renderReviewInvitationEmail({
      ...input,
      language: "ja",
      disclosure: [],
    });
    expect(result.text).toContain("評価の内容に左右されません");
  });
});
