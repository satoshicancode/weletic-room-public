import {
  readShopifyCouponUseAmount,
  selectShopifyCouponAllocationEvidence,
} from "@/lib/weletic/loyalty/coupon-use-amount";
import { describe, expect, it } from "vitest";

function allocation(amount: unknown, currency = "JPY", index = 0) {
  return {
    discount_application_index: index,
    amount_set: {
      shop_money: { amount, currency_code: currency },
      presentment_money: { amount: "99999.99", currency_code: "USD" },
    },
  };
}
function order(amount: unknown = "100", currency = "JPY") {
  return {
    discount_applications: [{ type: "discount_code", code: " WLI-EXACT " }],
    line_items: [{ discount_allocations: [allocation(amount, currency)] }],
    shipping_lines: [
      { discount_allocations: [] as ReturnType<typeof allocation>[] },
    ],
    total_price: "9999",
    discount_codes: [{ code: "WLI-EXACT", amount: "9999" }],
  };
}
describe("authoritative coupon use amount", () => {
  it("minimizes webhook fields while preserving exact allocation evidence", () => {
    const input = {
      ...order(),
      customer: { email: "must-not-retain@example.invalid" },
      name: "Private order",
    };
    const selected = selectShopifyCouponAllocationEvidence(input);
    expect(JSON.stringify(selected)).not.toContain("must-not-retain");
    expect(JSON.stringify(selected)).not.toContain("Private order");
    expect(JSON.stringify(selected)).not.toContain("presentment_money");
    expect(readShopifyCouponUseAmount(selected, "WLI-EXACT")).toEqual(
      readShopifyCouponUseAmount(input, "WLI-EXACT"),
    );
  });
  it.each([
    ["USD", "12.34", BigInt(1234)],
    ["JPY", "123.00", BigInt(123)],
    ["VND", "123", BigInt(123)],
    ["BHD", "12.345", BigInt(12345)],
    ["JPY", "9007199254740993", BigInt("9007199254740993")],
    ["JPY", "0", BigInt(0)],
  ])(
    "reads exact %s shop money without using presentment or face value",
    (currency, amount, expected) => {
      expect(
        readShopifyCouponUseAmount(order(amount, currency), "wli-exact"),
      ).toEqual({
        discountAmountMinor: expected,
        currency,
        amountUnavailableReason: null,
      });
    },
  );
  it("adds product and shipping allocations for only the matching code", () => {
    const input = order("100");
    input.discount_applications.push({ type: "discount_code", code: "OTHER" });
    input.line_items[0].discount_allocations.push(allocation("900", "JPY", 1));
    input.shipping_lines = [{ discount_allocations: [allocation("50")] }];
    expect(
      readShopifyCouponUseAmount(input, "WLI-EXACT").discountAmountMinor,
    ).toBe(BigInt(150));
  });
  it.each([
    ["1.5", "JPY", "inexact_shop_money_precision"],
    ["1.2345", "BHD", "inexact_shop_money_precision"],
    [1.23, "USD", "invalid_shop_money_amount"],
    ["-1", "USD", "invalid_shop_money_amount"],
    ["9223372036854775808", "JPY", "shop_money_overflow"],
    ["10", "ZZZ", "invalid_shop_money_currency"],
  ])("fails closed for invalid amount %s/%s", (amount, currency, reason) => {
    expect(
      readShopifyCouponUseAmount(order(amount, currency), "WLI-EXACT"),
    ).toEqual({
      discountAmountMinor: null,
      currency: null,
      amountUnavailableReason: reason,
    });
  });
  it("does not infer zero from absent allocations or discount-code summaries", () => {
    const input = order();
    input.line_items = [];
    expect(
      readShopifyCouponUseAmount(input, "WLI-EXACT").amountUnavailableReason,
    ).toBe("missing_coupon_allocations");
  });
  it("rejects duplicate matching applications and mixed allocation currencies", () => {
    const input = order();
    input.discount_applications.push({
      type: "discount_code",
      code: "wli-exact",
    });
    expect(
      readShopifyCouponUseAmount(input, "WLI-EXACT").amountUnavailableReason,
    ).toBe("ambiguous_discount_application");
    input.discount_applications.pop();
    input.shipping_lines[0].discount_allocations.push(allocation("1", "USD"));
    expect(
      readShopifyCouponUseAmount(input, "WLI-EXACT").amountUnavailableReason,
    ).toBe("mixed_shop_money_currencies");
  });
  it.each([-1, 1, 0.5, Number.NaN])(
    "rejects invalid allocation index %s even on an unrelated allocation",
    (index) => {
      const input = order();
      input.line_items[0].discount_allocations.push(
        allocation("1", "JPY", index),
      );
      expect(
        readShopifyCouponUseAmount(input, "WLI-EXACT").amountUnavailableReason,
      ).toBe("invalid_allocation_index");
    },
  );
  it("bounds the total allocation count across lines", () => {
    const input = order();
    input.discount_applications.push(
      ...Array.from({ length: 5000 }, (_, index) => ({
        type: "discount_code",
        code: `OTHER-${index}`,
      })),
    );
    input.line_items = Array.from({ length: 2 }, () => ({
      discount_allocations: Array.from({ length: 5001 }, (_, index) =>
        allocation("1", "JPY", index),
      ),
    }));
    expect(
      readShopifyCouponUseAmount(input, "WLI-EXACT").amountUnavailableReason,
    ).toBe("allocation_limit_exceeded");
  });
  it("bounds application and line counts before scanning allocations", () => {
    const input = order();
    input.discount_applications = Array.from({ length: 10001 }, () => ({
      type: "discount_code",
      code: "OTHER",
    }));
    expect(
      readShopifyCouponUseAmount(input, "WLI-EXACT").amountUnavailableReason,
    ).toBe("allocation_limit_exceeded");
    const manyLines = order();
    manyLines.line_items = Array.from({ length: 10001 }, () => ({
      discount_allocations: [],
    }));
    expect(
      readShopifyCouponUseAmount(manyLines, "WLI-EXACT")
        .amountUnavailableReason,
    ).toBe("allocation_limit_exceeded");
  });
  it("rejects overflow at the aggregate boundary", () => {
    const input = order("9223372036854775807");
    input.shipping_lines[0].discount_allocations.push(allocation("1"));
    expect(
      readShopifyCouponUseAmount(input, "WLI-EXACT").amountUnavailableReason,
    ).toBe("shop_money_overflow");
  });
  it.each([0, 1])(
    "rejects duplicate application %s within one line",
    (index) => {
      const input = order();
      input.discount_applications.push({
        type: "discount_code",
        code: "OTHER",
      });
      input.shipping_lines[0].discount_allocations = [
        allocation("100", "JPY", index),
        allocation("100", "JPY", index),
      ];
      expect(
        readShopifyCouponUseAmount(input, "WLI-EXACT").amountUnavailableReason,
      ).toBe("duplicate_line_allocation");
    },
  );
  it("sums the same application across distinct product lines", () => {
    const input = order();
    input.line_items.push({ discount_allocations: [allocation("50")] });
    expect(
      readShopifyCouponUseAmount(input, "WLI-EXACT").discountAmountMinor,
    ).toBe(BigInt(150));
  });
});
