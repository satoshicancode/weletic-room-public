import {
  getShopifyCustomerDiscountSummary,
  getShopifyDiscountConfig,
} from "@/ui/partners/discounts/shopify-discount-summary";
import { describe, expect, it } from "vitest";

describe("Shopify discount summaries", () => {
  it("parses legacy JSON configuration without exposing the raw value", () => {
    expect(
      getShopifyDiscountConfig({
        description: JSON.stringify({
          type: "amount_off_products",
          productIds: ["product-1", "product-2"],
          collectionIds: ["collection-1"],
        }),
      }),
    ).toEqual({
      type: "amount_off_products",
      productIds: ["product-1", "product-2"],
      collectionIds: ["collection-1"],
    });
  });

  it("falls back safely when a legacy description is not configuration JSON", () => {
    expect(
      getShopifyDiscountConfig({ description: "New users get 10% off" }),
    ).toEqual({
      type: "amount_off_order",
      productIds: [],
      collectionIds: [],
    });
  });

  it("describes an order discount and duration in customer language", () => {
    expect(
      getShopifyCustomerDiscountSummary({
        amount: 10,
        type: "percentage",
        maxDuration: 6,
        config: {
          type: "amount_off_order",
          productIds: [],
          collectionIds: [],
        },
      }),
    ).toEqual({
      benefit: "Customers get 10% off the entire order for 6 months.",
      scope: "Applies to all products in the order.",
    });
  });

  it("summarizes selected product and collection scope", () => {
    expect(
      getShopifyCustomerDiscountSummary({
        amount: 20,
        type: "percentage",
        maxDuration: 0,
        config: {
          type: "amount_off_products",
          productIds: ["product-1", "product-2"],
          collectionIds: ["collection-1"],
        },
      }),
    ).toEqual({
      benefit:
        "Customers get 20% off eligible products on their first purchase.",
      scope: "Applies to 2 selected products and 1 selected collection.",
    });
  });

  it("describes buy-X-get-Y and free-shipping configurations", () => {
    expect(
      getShopifyCustomerDiscountSummary({
        amount: 0,
        type: "percentage",
        maxDuration: null,
        config: {
          type: "bxgy",
          productIds: [],
          collectionIds: [],
          bxgy: {
            buyQuantity: 2,
            getQuantity: 1,
            discountType: "percentage",
            discountValue: 100,
          },
        },
      }).benefit,
    ).toBe(
      "Customers get 1 item free after buying 2 qualifying items for their lifetime.",
    );

    expect(
      getShopifyCustomerDiscountSummary({
        amount: 0,
        type: "percentage",
        maxDuration: 1,
        config: {
          type: "free_shipping",
          productIds: [],
          collectionIds: [],
        },
      }).benefit,
    ).toBe("Customers get free shipping for 1 month.");

    expect(
      getShopifyCustomerDiscountSummary({
        amount: 0,
        type: "flat",
        maxDuration: 1,
        config: {
          type: "bxgy",
          productIds: [],
          collectionIds: [],
          bxgy: {
            buyQuantity: 1,
            getQuantity: 1,
            discountType: "amount",
            discountValue: 5,
          },
        },
      }).benefit,
    ).toBe(
      "Customers get $5 off 1 item after buying 1 qualifying item for 1 month.",
    );
  });
});
