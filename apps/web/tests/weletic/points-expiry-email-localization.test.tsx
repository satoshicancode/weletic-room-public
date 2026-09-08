import PointsExpiryReminder, {
  getPointsExpiryCopy,
  resolvePointsExpiryLocale,
} from "@dub/email/templates/points-expiry-reminder";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { render } from "../../../../packages/email/node_modules/@react-email/render";

const fields = {
  brandName: "Example Store",
  customerFirstName: "Mai",
  pointsBalance: "9007199254740993 Tokens",
  expiryDate: "2026-09-30",
  accountUrl: "https://example.myshopify.com/account",
};

describe("localized points-expiry email", () => {
  it.each([
    ["en-US", "en"],
    ["ja-JP", "ja"],
    [" JA_jp ", "ja"],
    ["vi-VN", "vi"],
    ["fr-FR", "en"],
    ["invalid locale", "en"],
    [null, "en"],
    [undefined, "en"],
  ])("normalizes %s to supported language %s", (input, expected) => {
    expect(resolvePointsExpiryLocale(input)).toBe(expected);
  });

  for (const urgency of ["warning", "last_chance"] as const) {
    it.each([
      ["en", "View rewards", "marketing", "Last chance:"],
      ["ja", "特典を見る", "マーケティング", "最終のお知らせ："],
      ["vi", "Xem phần thưởng", "tiếp thị", "Nhắc nhở lần cuối:"],
    ])(
      `renders the complete %s ${urgency} message`,
      async (locale, action, consent, prefix) => {
        const copy = getPointsExpiryCopy({ ...fields, locale, urgency });
        const html = await render(
          createElement(PointsExpiryReminder, { ...fields, locale, urgency }),
        );
        expect(html).toContain(`lang="${locale}"`);
        for (const text of [
          copy.heading,
          copy.body,
          copy.consent,
          copy.preferences,
          action,
        ]) {
          expect(html).toContain(text);
        }
        expect(html).toContain(consent);
        expect(html).toContain(`href="${fields.accountUrl}"`);
        expect(copy.subject).toContain(fields.pointsBalance);
        expect(copy.subject).toContain(fields.expiryDate);
        expect(copy.subject.startsWith(prefix)).toBe(urgency === "last_chance");
        if (locale !== "en") {
          expect(html).not.toContain("View rewards");
          expect(html).not.toContain("You can review your customer profile");
        }
      },
    );
  }

  it.each(["en", "ja", "vi"])(
    "escapes substitutions and handles absent names in %s",
    async (locale) => {
      const html = await render(
        createElement(PointsExpiryReminder, {
          ...fields,
          locale,
          urgency: "warning",
          brandName: '<script>alert("brand")</script>',
          customerFirstName: '<img src=x onerror="alert(1)">',
        }),
      );
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;script&gt;");
      expect(html).toContain("&lt;img");
      const copy = getPointsExpiryCopy({
        ...fields,
        locale,
        urgency: "warning",
        customerFirstName: null,
      });
      expect(copy.body).not.toMatch(/null|undefined/);
      if (locale !== "en") expect(copy.body).not.toContain("there");
      for (const customerFirstName of [null, undefined, " "]) {
        const unnamedHtml = await render(
          createElement(PointsExpiryReminder, {
            ...fields,
            locale,
            urgency: "warning",
            customerFirstName,
          }),
        );
        expect(unnamedHtml).not.toMatch(/null|undefined/);
        if (locale !== "en") expect(unnamedHtml).not.toContain("there");
      }
    },
  );
});
