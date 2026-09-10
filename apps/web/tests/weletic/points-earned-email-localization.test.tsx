import LoyaltyPointsEarned from "@dub/email/templates/loyalty-points-earned";
import { createElement } from "react";
import { expect, it } from "vitest";
import { render } from "../../../../packages/email/node_modules/@react-email/render";

it.each([
  ["en", "Preferences"],
  ["ja", "配信設定"],
  ["vi", "Tùy chọn nhận tin"],
] as const)(
  "renders escaped content and preferences in %s",
  async (locale, preferences) => {
    const html = await render(
      createElement(LoyaltyPointsEarned, {
        brandName: "<script>brand</script>",
        accountUrl: "https://synthetic.myshopify.com/account",
        locale,
        content: {
          subject: "Earned 9007199254740993",
          heading: "<img src=x onerror=alert(1)>",
          body: "9007199254740993 points",
          actionLabel: "View",
        },
      }),
    );
    expect(html).toContain(`lang="${locale}"`);
    expect(html).toContain("9007199254740993 points");
    expect(html).toContain(preferences);
    expect(html).toContain(
      'href="https://synthetic.myshopify.com/account/profile"',
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    if (locale !== "en")
      expect(html).not.toContain("You receive loyalty updates");
  },
);
