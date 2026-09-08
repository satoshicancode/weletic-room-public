import { describe, expect, it } from "vitest";
import {
  CUSTOMER_INTENT_TRIGGER_CODES,
  getCustomerIntentAction,
  validateCustomerIntentConditions,
} from "../../lib/weletic/loyalty/customer-intent-policy";

// Import the browser-safe entry point directly, without server-service mocks.
describe("customer intent policy", () => {
  it.each(CUSTOMER_INTENT_TRIGGER_CODES)(
    "fails closed for invalid stored %s conditions",
    (triggerCode) => {
      expect(
        getCustomerIntentAction({
          triggerCode,
          conditions: { targetUrl: "http://example.com" },
        }),
      ).toBeNull();
    },
  );

  it("preserves canonical URL and legacy message normalization", () => {
    expect(
      validateCustomerIntentConditions({
        triggerCode: "x_share",
        conditions: {
          targetUrl: " https://EXAMPLE.com ",
          shareMessage: ` ${"a".repeat(300)} `,
        },
      }),
    ).toEqual({
      targetUrl: "https://example.com/",
      shareMessage: "a".repeat(280),
    });
  });

  it("does not mistake a lookalike domain for a provider", () => {
    expect(() =>
      validateCustomerIntentConditions({
        triggerCode: "instagram_follow",
        conditions: { targetUrl: "https://instagram.com.example.com/profile" },
      }),
    ).toThrow("target URL is not valid");
  });

  it("labels sharing as honor-system participation, not verification", () => {
    const action = getCustomerIntentAction({
      triggerCode: "x_share",
      conditions: {
        targetUrl: "https://example.com/?a=1&b=2",
        shareMessage: "Hello & welcome",
      },
    });
    expect(action?.verification).toBe("honor_system");
    const url = new URL(action!.url);
    expect(url.searchParams.get("url")).toBe("https://example.com/?a=1&b=2");
    expect(url.searchParams.get("text")).toBe("Hello & welcome");
  });
});
