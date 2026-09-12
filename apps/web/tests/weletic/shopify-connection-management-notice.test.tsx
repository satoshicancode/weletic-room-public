import { ShopifyConnectionManagementNotice } from "@/ui/weletic/shopify/connection-management-notice";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("Shopify-native connection management guidance", () => {
  it("directs store-scoped management to Shopify without asserting active installation", () => {
    const html = renderToStaticMarkup(
      createElement(ShopifyConnectionManagementNotice),
    );
    expect(html).toContain("managed through Shopify Admin");
    expect(html).toContain("not a Weletic installer");
    expect(html).toContain("authentication alone does not activate loyalty");
    expect(html).toContain('href="https://admin.shopify.com/"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("opens in a new tab");
    expect(html).not.toContain("Enabled by");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<form");
  });
});
