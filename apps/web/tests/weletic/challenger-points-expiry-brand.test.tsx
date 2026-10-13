import PointsExpiryReminder, {
  getPointsExpiryCopy,
} from "@dub/email/templates/points-expiry-reminder";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { render } from "../../../../packages/email/node_modules/@react-email/render";

describe("PKG-06 Challenger: Brand name neutralization when omitted", () => {
  const baseProps = {
    customerFirstName: "TestUser",
    pointsBalance: "500 Points",
    expiryDate: "October 31, 2026",
    accountUrl: "https://example.myshopify.com/account",
  };

  const locales = ["en", "ja", "vi", "fr", null, undefined] as const;
  const urgencies = ["warning", "last_chance"] as const;

  for (const locale of locales) {
    for (const urgency of urgencies) {
      it(`renders "Rewards Club" and NEVER renders "Yamax" for locale=${locale}, urgency=${urgency} when brandName is omitted`, async () => {
        // Test 1: brandName prop omitted entirely
        const htmlOmitted = await render(
          createElement(PointsExpiryReminder, {
            ...baseProps,
            locale,
            urgency,
          } as any),
        );

        // Verification 1: Must contain "Rewards Club"
        expect(htmlOmitted).toContain("Rewards Club");

        // Verification 2: Must NEVER contain "Yamax" (case-insensitive)
        expect(htmlOmitted.toLowerCase()).not.toContain("yamax");

        // Test 2: brandName explicitly passed as undefined
        const htmlUndefined = await render(
          createElement(PointsExpiryReminder, {
            ...baseProps,
            brandName: undefined as any,
            locale,
            urgency,
          } as any),
        );

        expect(htmlUndefined).toContain("Rewards Club");
        expect(htmlUndefined.toLowerCase()).not.toContain("yamax");
      });
    }
  }

  it("ensures getPointsExpiryCopy with fallback brandName never contains Yamax", () => {
    for (const locale of locales) {
      for (const urgency of urgencies) {
        const copy = getPointsExpiryCopy({
          locale,
          urgency,
          pointsBalance: "500 Points",
          expiryDate: "October 31, 2026",
          customerFirstName: "Alex",
          brandName: "Rewards Club",
        });

        const allText = `${copy.subject} ${copy.heading} ${copy.body} ${copy.consent} ${copy.preferences}`;
        expect(allText.toLowerCase()).not.toContain("yamax");
        expect(allText).toContain("Rewards Club");
      }
    }
  });

  it("renders custom brandName accurately without Yamax leak when a custom tenant name is given", async () => {
    const customBrand = "Acme Athletics";
    const html = await render(
      createElement(PointsExpiryReminder, {
        ...baseProps,
        brandName: customBrand,
        urgency: "warning",
        locale: "en",
      } as any),
    );

    expect(html).toContain(customBrand);
    expect(html).not.toContain("Rewards Club");
    expect(html.toLowerCase()).not.toContain("yamax");
  });
});
