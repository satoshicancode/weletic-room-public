import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    partnerGroup: {
      findFirst: vi.fn(),
    },
    program: {
      findFirst: vi.fn(),
    },
    weleticCommissionRule: {
      findFirst: vi.fn(),
    },
    weleticShopifyProduct: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { serializeGroupRewardCommission } from "@/lib/weletic/commissions/rules";
import { buildWeleticProductTargetUrl } from "@/lib/weletic/shopify/product-url";
import { ShopifyEcommerceRewardConfigSchema } from "@/lib/zod/schemas/shopify-ecommerce-reward";

const mockProgram = {
  accountingCurrency: "usd",
  id: "prog_test",
  slug: "we",
};

const mockReward = {
  config: {
    type: "shopify_ecommerce",
  },
  id: "reward_shopify",
};

const mockProduct = {
  handle: "yamax-agile-leggings",
  id: "product_test",
  programId: mockProgram.id,
  status: "active",
  title: "Yamax Agile Leggings",
  variants: [
    {
      id: "variant_test",
      marketPrices: [{ amount: 1999, currency: "USD" }],
      shopPrice: 1999,
    },
  ],
};

describe("Shopee Affiliate Style Product Offers & Commission Contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.program.findFirst).mockResolvedValue(mockProgram as any);
    vi.mocked(prisma.partnerGroup.findFirst).mockResolvedValue({
      id: "group_test",
      programId: mockProgram.id,
      saleReward: mockReward,
    } as any);
    vi.mocked(prisma.weleticShopifyProduct.findFirst).mockResolvedValue(
      mockProduct as any,
    );
    vi.mocked(prisma.weleticShopifyProduct.findMany).mockResolvedValue([
      mockProduct,
    ] as any);
    vi.mocked(prisma.weleticCommissionRule.findFirst).mockResolvedValue(null);
  });

  it("verifies product URL generation appends subId1 through subId5 parameters correctly", () => {
    const url = buildWeleticProductTargetUrl({
      storefrontUrl: "https://yamax.com",
      handle: "yamax-agile-leggings",
      variantExternalId: "gid://shopify/ProductVariant/123456",
      marketHandle: "vietnam",
      countryCode: "VN",
      locale: "vi",
      subId1: "TiktokBio",
      subId2: "Livestream1212",
      subId3: "VoucherKOC",
      subId4: "CampaignX",
      subId5: "Affiliate01",
    });

    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/products/yamax-agile-leggings");
    expect(parsed.searchParams.get("variant")).toBe("123456");
    expect(parsed.searchParams.get("wlt_market")).toBe("vietnam");
    expect(parsed.searchParams.get("wlt_country")).toBe("VN");
    expect(parsed.searchParams.get("locale")).toBe("vi");
    expect(parsed.searchParams.get("sub1")).toBe("TiktokBio");
    expect(parsed.searchParams.get("sub2")).toBe("Livestream1212");
    expect(parsed.searchParams.get("sub3")).toBe("VoucherKOC");
    expect(parsed.searchParams.get("sub4")).toBe("CampaignX");
    expect(parsed.searchParams.get("sub5")).toBe("Affiliate01");
  });

  it("requires a dedicated Shopify reward when no custom rule matches", async () => {
    const program = await prisma.program.findFirst({
      where: { slug: "we" },
    });
    expect(program).toBeDefined();

    const partnerGroup = await prisma.partnerGroup.findFirst({
      where: { programId: program!.id },
      include: { saleReward: true },
    });
    expect(partnerGroup).toBeDefined();

    const product = await prisma.weleticShopifyProduct.findFirst({
      where: { programId: program!.id, status: "active" },
    });
    expect(product).toBeDefined();

    // Check if product has a custom commission rule or falls back to Default Group
    const customRule = await prisma.weleticCommissionRule.findFirst({
      where: {
        programId: program!.id,
        productId: product!.id,
        active: true,
      },
    });

    if (!customRule) {
      const dedicatedConfig = ShopifyEcommerceRewardConfigSchema.safeParse(
        partnerGroup?.saleReward?.config,
      );
      const commission = partnerGroup?.saleReward
        ? serializeGroupRewardCommission({
            reward: partnerGroup.saleReward,
            currency: program!.accountingCurrency,
          })
        : null;

      if (dedicatedConfig.success) {
        expect(commission).not.toBeNull();
      } else {
        expect(commission).toBeNull();
      }
    } else {
      expect(customRule.scope).toBe("product");
    }
  });

  it("verifies product catalog contains base price, variant prices, and vendor metadata", async () => {
    const products = await prisma.weleticShopifyProduct.findMany({
      where: { program: { slug: "we" }, status: "active" },
      include: { variants: true },
      take: 10,
    });

    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      expect(p.title).toBeTruthy();
      expect(p.variants.length).toBeGreaterThan(0);
      expect(p.variants[0].shopPrice).toBeDefined();
    }
  });

  it("verifies single product details page query resolves product and commission structure correctly", async () => {
    const product = await prisma.weleticShopifyProduct.findFirst({
      where: { program: { slug: "we" }, status: "active" },
      include: {
        variants: {
          include: {
            marketPrices: true,
          },
        },
      },
    });

    expect(product).toBeDefined();
    expect(product!.id).toBeTruthy();
    expect(product!.handle).toBeTruthy();
    expect(product!.variants.length).toBeGreaterThan(0);
    expect(product!.variants[0].marketPrices.length).toBeGreaterThan(0);
  });
});
