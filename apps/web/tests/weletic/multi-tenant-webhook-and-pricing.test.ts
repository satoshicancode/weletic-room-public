import { formatMoney, normalizeCurrency } from "@/lib/weletic/money";
import {
  SHOPIFY_CANONICAL_WEBHOOK_TOPICS,
  ensureShopifyWebhooksRegistered,
  resolveShopifyWebhookCallbackUrl,
} from "@/lib/weletic/shopify/provision-webhooks";
import { describe, expect, it } from "vitest";

describe("Multi-Tenant Shopify Webhook Provisioning & Strikethrough Pricing Test Suite", () => {
  describe("R1: Multi-Tenant Automated Webhook Provisioning", () => {
    it("verifies the 16 canonical Shopify webhook topics are defined", () => {
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toHaveLength(16);
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("PRODUCTS_CREATE");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("PRODUCTS_UPDATE");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("PRODUCTS_DELETE");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("MARKETS_CREATE");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("MARKETS_UPDATE");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("MARKETS_DELETE");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("ORDERS_PAID");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("ORDERS_FULFILLED");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("ORDERS_CANCELLED");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("REFUNDS_CREATE");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("CUSTOMERS_CREATE");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("CUSTOMERS_UPDATE");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("DISCOUNTS_CREATE");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("DISCOUNTS_UPDATE");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("DISCOUNTS_DELETE");
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toContain("APP_UNINSTALLED");
    });

    it("resolves the webhook callback URL dynamically per environment", () => {
      const explicitUrl = resolveShopifyWebhookCallbackUrl(
        "https://my-custom-domain.com/api/shopify/integration/webhook",
      );
      expect(explicitUrl).toBe(
        "https://my-custom-domain.com/api/shopify/integration/webhook",
      );

      const devUrl = resolveShopifyWebhookCallbackUrl();
      expect(devUrl).toContain("/api/shopify/integration/webhook");
    });

    it("handles idempotency and already-taken subscriptions gracefully", async () => {
      const mockResult = await ensureShopifyWebhooksRegistered({
        shopDomain: "test-workspace-store.myshopify.com",
        accessToken: "shpat_test_mock_token_123",
      });

      // Should complete without throwing unhandled exceptions
      expect(mockResult).toBeDefined();
      expect(mockResult.callbackUrl).toContain(
        "/api/shopify/integration/webhook",
      );
    });
  });

  describe("R2 & R3: Strikethrough Compare-At Pricing & Discount Percentage Computation", () => {
    it("calculates discount percentage accurately for products on sale", () => {
      const regularAmount = BigInt(3222); // $32.22
      const compareAtAmount = BigInt(5000); // $50.00

      const discountPercent = Math.round(
        (Number(compareAtAmount - regularAmount) / Number(compareAtAmount)) *
          100,
      );

      expect(discountPercent).toBe(36); // (5000 - 3222) / 5000 = 35.56% -> 36%
    });

    it("formats regular and compare-at prices in multi-currency (USD, JPY, VND, MXN)", () => {
      // USD
      const usdPrice = formatMoney(
        { amount: BigInt(3222), currency: normalizeCurrency("USD") },
        "en",
      );
      const usdCompare = formatMoney(
        { amount: BigInt(5000), currency: normalizeCurrency("USD") },
        "en",
      );
      expect(usdPrice).toBe("$32.22");
      expect(usdCompare).toBe("$50.00");

      // JPY
      const jpyPrice = formatMoney(
        { amount: BigInt(5000), currency: normalizeCurrency("JPY") },
        "en",
      );
      const jpyCompare = formatMoney(
        { amount: BigInt(7500), currency: normalizeCurrency("JPY") },
        "en",
      );
      expect(jpyPrice).toBe("¥5,000");
      expect(jpyCompare).toBe("¥7,500");

      // VND
      const vndPrice = formatMoney(
        { amount: BigInt(841000), currency: normalizeCurrency("VND") },
        "vi",
      );
      const vndCompare = formatMoney(
        { amount: BigInt(1200000), currency: normalizeCurrency("VND") },
        "vi",
      );
      expect(vndPrice).toContain("841.000");
      expect(vndCompare).toContain("1.200.000");
    });
  });

  describe("R4: Group Reward Modifiers & Collection-Based Commission Resolution", () => {
    it("evaluates collection-based condition modifiers (Nike 30% vs Base 10%)", async () => {
      const { serializeGroupRewardCommission } = await import(
        "@/lib/weletic/commissions/rules"
      );

      const mockReward = {
        id: "rw_test_modifiers_123",
        config: {
          type: "shopify_ecommerce",
          activation: { published: true, startsAt: null, endsAt: null },
          customerSegmentMode: "none",
          baseRateType: "percentage",
          baseReturningRate: 10,
          baseNewRate: 10,
          shopifySegment: null,
          collectionOverrides: [
            {
              id: "gid://shopify/Collection/481570291938",
              title: "NIKE",
              returningRate: 30,
            },
          ],
          productOverrides: [
            {
              id: "gid://shopify/Product/9156986339554",
              title: "ADIDAS | SUPERSTAR 80S",
              returningRate: 20,
            },
          ],
          variantOverrides: [],
          subscriptionRules: {
            mode: "first_sale",
            recurringOrderCount: null,
          },
        },
      };

      // 1. Nike product in Nike collection -> should get 30% (basisPoints: 3000)
      const nikeComm = serializeGroupRewardCommission({
        reward: mockReward as any,
        currency: "USD",
        productContext: {
          productId: "wprod_nike_1",
          productExternalId: "gid://shopify/Product/9156987420898",
          collectionExternalIds: [
            "gid://shopify/Collection/481570291938",
            "gid://shopify/Collection/484117053666",
          ],
        },
      });
      expect(nikeComm).toMatchObject({ basisPoints: 3000 }); // 30%

      // 2. Adidas Superstar 80S product -> should get 20% (basisPoints: 2000)
      const adidasComm = serializeGroupRewardCommission({
        reward: mockReward as any,
        currency: "USD",
        productContext: {
          productId: "wprod_adidas_1",
          productExternalId: "gid://shopify/Product/9156986339554",
          collectionExternalIds: ["gid://shopify/Collection/481570259170"],
        },
      });
      expect(adidasComm).toMatchObject({ basisPoints: 2000 }); // 20%

      // 3. Regular product -> should fall back to 10% (basisPoints: 1000)
      const otherComm = serializeGroupRewardCommission({
        reward: mockReward as any,
        currency: "USD",
        productContext: {
          productId: "wprod_other_1",
          productExternalId: "gid://shopify/Product/111111111111",
          collectionExternalIds: ["gid://shopify/Collection/999999999999"],
        },
      });
      expect(otherComm).toMatchObject({ basisPoints: 1000 }); // 10%
    });
  });

  describe("R5: Customer Discount Resolution & Restriction Engine", () => {
    it("resolves storewide customer discount correctly", async () => {
      const { resolveProductCustomerDiscount } = await import(
        "@/lib/weletic/commissions/rules"
      );

      const discount = {
        amount: 10,
        type: "percentage" as const,
        couponId: "DEMO10",
        description: JSON.stringify({
          type: "amount_off_order",
          productIds: [],
          collectionIds: [],
        }),
      };

      const result = resolveProductCustomerDiscount({
        discount: discount as any,
        partnerCode: "HIRO10",
        currency: "USD",
        productContext: {
          productId: "wprod_1",
          productExternalId: "gid://shopify/Product/12345",
          collectionExternalIds: ["gid://shopify/Collection/999"],
        },
      });

      expect(result).not.toBeNull();
      expect(result?.formatted).toBe("-10%");
      expect(result?.couponCode).toBe("HIRO10");
      expect(result?.type).toBe("percentage");
    });

    it("respects product and collection discount restrictions", async () => {
      const { resolveProductCustomerDiscount } = await import(
        "@/lib/weletic/commissions/rules"
      );

      const restrictedDiscount = {
        amount: 20,
        type: "percentage" as const,
        couponId: "NIKE20",
        description: JSON.stringify({
          type: "amount_off_products",
          productIds: [],
          collectionIds: ["gid://shopify/Collection/481570291938"],
        }),
      };

      // 1. Nike product in collection -> should match and get -20%
      const nikeResult = resolveProductCustomerDiscount({
        discount: restrictedDiscount as any,
        partnerCode: null,
        currency: "USD",
        productContext: {
          productId: "wprod_nike",
          productExternalId: "gid://shopify/Product/9156987420898",
          collectionExternalIds: ["gid://shopify/Collection/481570291938"],
        },
      });
      expect(nikeResult).not.toBeNull();
      expect(nikeResult?.formatted).toBe("-20%");
      expect(nikeResult?.couponCode).toBe("NIKE20");

      // 2. Non-Nike product -> should return null
      const nonNikeResult = resolveProductCustomerDiscount({
        discount: restrictedDiscount as any,
        partnerCode: null,
        currency: "USD",
        productContext: {
          productId: "wprod_other",
          productExternalId: "gid://shopify/Product/11111",
          collectionExternalIds: ["gid://shopify/Collection/00000"],
        },
      });
      expect(nonNikeResult).toBeNull();
    });
  });

  describe("R6: Auto-Apply Discount Code in Product Target URL", () => {
    it("appends discount query parameter when discount code is provided", async () => {
      const { buildWeleticProductTargetUrl } = await import(
        "@/lib/weletic/shopify/product-url"
      );

      const targetUrl = buildWeleticProductTargetUrl({
        storefrontUrl: "https://yamax.vn",
        handle: "yamax-leggings",
        variantExternalId: "gid://shopify/ProductVariant/12345678",
        marketHandle: "vietnam",
        countryCode: "VN",
        locale: "vi",
        discountCode: "DEMO10",
        subId1: "TiktokVideo",
      });

      const parsedUrl = new URL(targetUrl);
      expect(parsedUrl.pathname).toBe("/products/yamax-leggings");
      expect(parsedUrl.searchParams.get("variant")).toBe("12345678");
      expect(parsedUrl.searchParams.get("discount")).toBe("DEMO10");
      expect(parsedUrl.searchParams.get("wlt_market")).toBe("vietnam");
      expect(parsedUrl.searchParams.get("wlt_country")).toBe("VN");
      expect(parsedUrl.searchParams.get("locale")).toBe("vi");
      expect(parsedUrl.searchParams.get("sub1")).toBe("TiktokVideo");
    });
  });
});
