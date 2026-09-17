import { orderSchema } from "@/lib/integrations/shopify/schema";
import { readOrderLineDiscount } from "@/lib/weletic/commerce/order-line-discount";
import {
  readShopifyCouponUseAmount,
  selectShopifyCouponAllocationEvidence,
} from "@/lib/weletic/loyalty/coupon-use-amount";
import { describe, expect, it } from "vitest";

const money = (amount: string, currency_code = "JPY") => ({
  shop_money: { amount, currency_code },
});
const allocation = (amount: string, index = 0) => ({
  discount_application_index: index,
  amount_set: money(amount),
});
const line = () => ({
  id: 1,
  title: "Synthetic fixture",
  quantity: 1,
  price_set: money("1000"),
  total_discount_set: money("0"),
  discount_allocations: [allocation("100")],
});
const order = () => ({
  id: 1,
  confirmation_number: "synthetic",
  checkout_token: "synthetic",
  current_subtotal_price_set: money("900"),
  discount_codes: [{ code: "TEST" }],
  discount_applications: [{ type: "discount_code", code: "TEST" }],
  line_items: [line()],
  shipping_lines: [],
});

describe("native Shopify line allocation capture", () => {
  it("retains the live failure shape through repeated webhook parsing", () => {
    const parsed = orderSchema.parse(orderSchema.parse(order()));
    const discount = readOrderLineDiscount(
      parsed.line_items[0],
      "shop_money",
      "JPY",
    );
    expect(discount).toBe(BigInt(100));
    expect(BigInt(1000) - discount).toBe(
      BigInt(parsed.current_subtotal_price_set.shop_money.amount),
    );
    expect(
      readShopifyCouponUseAmount(
        selectShopifyCouponAllocationEvidence(parsed),
        "TEST",
      ),
    ).toEqual({
      discountAmountMinor: BigInt(100),
      currency: "JPY",
      amountUnavailableReason: null,
    });
  });
  it("sums allocations without adding the legacy total a second time", () => {
    expect(
      readOrderLineDiscount(
        {
          ...line(),
          total_discount_set: money("60"),
          discount_allocations: [allocation("60"), allocation("40", 1)],
        },
        "shop_money",
        "JPY",
      ),
    ).toBe(BigInt(100));
  });
  it("keeps each merchandise line isolated", () => {
    const lines = [
      line(),
      { ...line(), id: 2, discount_allocations: [allocation("25")] },
    ];
    expect(
      lines.map((l) => readOrderLineDiscount(l, "shop_money", "JPY")),
    ).toEqual([BigInt(100), BigInt(25)]);
  });
  it("uses legacy totals only when allocations are absent", () => {
    expect(
      readOrderLineDiscount(
        {
          ...line(),
          total_discount_set: money("50"),
          discount_allocations: undefined,
        },
        "shop_money",
        "JPY",
      ),
    ).toBe(BigInt(50));
    expect(
      readOrderLineDiscount(
        {
          ...line(),
          total_discount_set: money("50"),
          discount_allocations: [],
        },
        "shop_money",
        "JPY",
      ),
    ).toBe(BigInt(0));
  });
  it("keeps presentment and shop amounts separate", () => {
    const l = {
      ...line(),
      price_set: {
        ...money("1000"),
        presentment_money: { amount: "10.00", currency_code: "USD" },
      },
      discount_allocations: [
        {
          ...allocation("100"),
          amount_set: {
            ...money("100"),
            presentment_money: { amount: "1.25", currency_code: "USD" },
          },
        },
      ],
    };
    expect(readOrderLineDiscount(l, "shop_money", "JPY")).toBe(BigInt(100));
    expect(readOrderLineDiscount(l, "presentment_money", "USD")).toBe(
      BigInt(125),
    );
    expect(() =>
      readOrderLineDiscount(line(), "presentment_money", "USD"),
    ).toThrow(/currency/);
  });
  it.each(["-1", "1.1", "NaN", "1e2", "1001"])(
    "rejects unsafe JPY allocation %s",
    (value) => {
      expect(() =>
        readOrderLineDiscount(
          { ...line(), discount_allocations: [allocation(value)] },
          "shop_money",
          "JPY",
        ),
      ).toThrow();
    },
  );
  it("accepts exact trailing zeros and bounds against full quantity gross", () => {
    expect(
      readOrderLineDiscount(
        {
          ...line(),
          quantity: 2,
          discount_allocations: [allocation("1500.00")],
        },
        "shop_money",
        "JPY",
      ),
    ).toBe(BigInt(1500));
  });
  it("rejects malformed allocation evidence rather than stripping it", () => {
    const event = order();
    expect(
      orderSchema.safeParse({
        ...event,
        line_items: [
          {
            ...line(),
            discount_allocations: [{ discount_application_index: 0 }],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      orderSchema.safeParse({
        ...event,
        line_items: [{ ...line(), discount_allocations: null }],
      }).success,
    ).toBe(false);
  });
  it("does not retain arbitrary webhook customer fields", () => {
    const parsed = orderSchema.parse({
      ...order(),
      secret: "discard",
      line_items: [{ ...line(), unrelated: "discard" }],
    });
    expect(parsed).not.toHaveProperty("secret");
    expect(parsed.line_items[0]).not.toHaveProperty("unrelated");
  });
});
