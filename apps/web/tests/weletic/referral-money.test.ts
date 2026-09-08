import { referralMinimumSubtotalMinorUnits } from "@/lib/weletic/loyalty/referrals";
import { describe, expect, it } from "vitest";

describe("referral minimum subtotal currency precision", () => {
  it("uses three minor units for KWD thresholds", () => {
    expect(
      referralMinimumSubtotalMinorUnits({
        minimumSubtotal: "12.345",
        currency: "KWD",
      }),
    ).toBe(BigInt(12_345));
  });

  it("uses zero minor units for ISO zero-decimal currencies outside the old hard-coded list", () => {
    expect(
      referralMinimumSubtotalMinorUnits({
        minimumSubtotal: "3000",
        currency: "CLP",
      }),
    ).toBe(BigInt(3000));
  });
});
