import { assertPayoutProviderCompatibility } from "@/lib/weletic/payouts/providers";
import { describe, expect, test } from "vitest";

describe("Weletic payout providers", () => {
  test("accepts a compatible connected provider", () => {
    expect(
      assertPayoutProviderCompatibility({
        provider: "paypal",
        method: "paypal",
        providerAccountRef: "acct_123",
      }).automaticSettlement,
    ).toBe(true);
  });

  test("rejects an incompatible method", () => {
    expect(() =>
      assertPayoutProviderCompatibility({
        provider: "paypal",
        method: "bank",
        providerAccountRef: "acct_123",
      }),
    ).toThrow("bank is not supported by paypal");
  });

  test("requires a connected account before automatic settlement", () => {
    expect(() =>
      assertPayoutProviderCompatibility({
        provider: "stripe_connect",
        method: "bank",
      }),
    ).toThrow("must be connected");
  });

  test("rejects settlement currencies unsupported by the selected rail", () => {
    expect(() =>
      assertPayoutProviderCompatibility({
        provider: "stripe_connect",
        method: "bank",
        payoutCurrency: "JPY",
        providerAccountRef: "acct_123",
      }),
    ).toThrow("does not support JPY");
    expect(() =>
      assertPayoutProviderCompatibility({
        provider: "paypal",
        method: "paypal",
        payoutCurrency: "VND",
        providerAccountRef: "partner@example.com",
      }),
    ).toThrow("does not support VND");
  });

  test("accepts manual and bank transfer providers for operations-led settlement without connected account", () => {
    const bank = assertPayoutProviderCompatibility({
      provider: "bank_transfer",
      method: "bank",
      payoutCurrency: "VND",
      requireConnectedAccount: true,
    });
    expect(bank.automaticSettlement).toBe(false);
    expect(bank.requiresConnectedAccount).toBe(false);

    const manual = assertPayoutProviderCompatibility({
      provider: "manual",
      method: "manual",
      payoutCurrency: "JPY",
      requireConnectedAccount: true,
    });
    expect(manual.automaticSettlement).toBe(false);
    expect(manual.requiresConnectedAccount).toBe(false);
  });
});
