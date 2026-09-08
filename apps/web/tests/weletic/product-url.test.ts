import { buildWeleticProductTargetUrl } from "@/lib/weletic/shopify/product-url";
import { describe, expect, test } from "vitest";

describe("Weletic product target URL", () => {
  test("constructs a market-aware Shopify product URL", () => {
    expect(
      buildWeleticProductTargetUrl({
        storefrontUrl: "https://www.weletic.com/ja-jp/",
        handle: "training-shirt",
        variantExternalId: "gid://shopify/ProductVariant/12345",
        marketHandle: "japan",
        countryCode: "JP",
        locale: "ja",
        subId: "youtube-review",
      }),
    ).toBe(
      "https://www.weletic.com/ja-jp/products/training-shirt?variant=12345&wlt_market=japan&wlt_country=JP&locale=ja&wlt_sub_id=youtube-review",
    );
  });
});
