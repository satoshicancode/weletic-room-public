import LoyaltyPointsEarned from "@dub/email/templates/loyalty-points-earned";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { renderLoyaltyCommunicationText } from "../../lib/weletic/loyalty/communications-contract";
import { rewardCommunicationValue } from "../../lib/weletic/loyalty/reward-communication-value";
import { createDefaultLoyaltyCommunicationPolicy } from "../../ui/weletic/loyalty/communications-defaults";

it.each(["en", "ja", "vi"] as const)(
  "renders the real redemption email component in %s with escaped merchant content",
  (locale) => {
    const policy = createDefaultLoyaltyCommunicationPolicy("reward_redeemed");
    const template = policy.templates[locale];
    const rewardName = '<img src=x onerror="alert(1)">';
    const values = {
      brand_name: "Weletic",
      customer_first_name: "Shopper",
      reward_name: rewardName,
      reward_value: rewardCommunicationValue(
        {
          type: "amount_off",
          name: rewardName,
          value: "1234",
          currency: "USD",
        },
        locale,
      ),
    };
    const content = Object.fromEntries(
      Object.entries(template).map(([key, value]) => [
        key,
        renderLoyaltyCommunicationText(value, "reward_redeemed", values),
      ]),
    ) as typeof template;
    const html = renderToStaticMarkup(
      createElement(LoyaltyPointsEarned, {
        brandName: "Weletic",
        accountUrl: "https://synthetic.myshopify.com/account",
        locale,
        content,
      }),
    );
    expect(html).toContain(`lang="${locale}"`);
    expect(html).toContain("&lt;img");
    expect(html).not.toContain('<img src="x"');
    expect(html).not.toContain("{{");
    expect(html).toContain('href="https://synthetic.myshopify.com/account"');
    expect(html).toContain(
      'href="https://synthetic.myshopify.com/account/profile"',
    );
    expect(html).not.toMatch(/private-|gid:\/\/shopify|shopifyCustomerId/);
  },
);
