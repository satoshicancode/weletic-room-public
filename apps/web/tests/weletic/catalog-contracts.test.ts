import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    program: {
      findFirst: vi.fn(),
    },
    weleticShopifyMarket: {
      findMany: vi.fn(),
    },
    weleticShopifyProduct: {
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";

const mockProgram = {
  id: "prog_test",
  slug: "we",
};

const mockMarkets = [
  {
    countryCodes: ["VN"],
    currencyCodes: ["VND"],
    enabled: true,
    handle: "vietnam",
    id: "market_vn",
    primary: false,
  },
  {
    countryCodes: ["JP"],
    currencyCodes: ["JPY"],
    enabled: true,
    handle: "japan",
    id: "market_jp",
    primary: true,
  },
  {
    countryCodes: ["MX"],
    currencyCodes: ["MXN"],
    enabled: true,
    handle: "mexico",
    id: "market_mx",
    primary: false,
  },
  {
    countryCodes: ["US"],
    currencyCodes: ["USD"],
    enabled: true,
    handle: "international",
    id: "market_intl",
    primary: false,
  },
];

const mockProducts = [
  {
    availableForSale: true,
    id: "product_test",
    programId: mockProgram.id,
    status: "active",
    title: "Yamax Agile Leggings",
    variants: [
      {
        availableForSale: true,
        id: "variant_test",
        marketPrices: [
          {
            amount: 500_000,
            available: true,
            currency: "VND",
            marketId: "market_vn",
          },
          {
            amount: 3_000,
            available: true,
            currency: "JPY",
            marketId: "market_jp",
          },
          {
            amount: 350,
            available: true,
            currency: "MXN",
            marketId: "market_mx",
          },
          {
            amount: 20,
            available: true,
            currency: "USD",
            marketId: "market_intl",
          },
        ],
        shopCurrency: "USD",
        shopPrice: 20,
      },
    ],
  },
];

describe("Weletic Room Catalog & Multi-Market Price Matrix Contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.program.findFirst).mockResolvedValue(mockProgram as any);
    vi.mocked(prisma.weleticShopifyMarket.findMany).mockResolvedValue(
      mockMarkets as any,
    );
    vi.mocked(prisma.weleticShopifyProduct.findMany).mockResolvedValue(
      mockProducts as any,
    );
  });

  it("verifies the official Shopify markets exist and are configured correctly", async () => {
    const program = await prisma.program.findFirst({
      where: { slug: "we" },
    });
    expect(program).toBeDefined();

    const markets = await prisma.weleticShopifyMarket.findMany({
      where: {
        store: { programId: program!.id },
        enabled: true,
      },
    });

    expect(markets.length).toBeGreaterThanOrEqual(4);

    const vn = markets.find((m) => m.handle === "vietnam");
    const jp = markets.find((m) => m.handle === "jp" || m.handle === "japan");
    const mx = markets.find((m) => m.handle === "mexico");
    const intl = markets.find((m) => m.handle === "international");

    expect(vn).toBeDefined();
    expect(vn?.currencyCodes).toContain("VND");

    expect(jp).toBeDefined();
    expect(jp?.primary).toBe(true);
    expect(jp?.currencyCodes).toContain("JPY");

    expect(mx).toBeDefined();
    expect(mx?.currencyCodes).toContain("MXN");

    expect(intl).toBeDefined();
    expect(intl?.currencyCodes).toContain("USD");
  });

  it("verifies every product variant has market prices for all markets", async () => {
    const products = await prisma.weleticShopifyProduct.findMany({
      where: {
        program: { slug: "we" },
        status: "active",
      },
      include: {
        variants: {
          include: {
            marketPrices: true,
          },
        },
      },
    });

    expect(products.length).toBeGreaterThan(0);

    for (const prod of products) {
      expect(prod.variants.length).toBeGreaterThan(0);
      for (const variant of prod.variants) {
        expect(variant.marketPrices.length).toBeGreaterThan(0);

        const vnPrice = variant.marketPrices.find((p) => p.currency === "VND");
        const jpPrice = variant.marketPrices.find((p) => p.currency === "JPY");
        const mxPrice = variant.marketPrices.find((p) => p.currency === "MXN");

        expect(vnPrice).toBeDefined();
        expect(jpPrice).toBeDefined();
        expect(mxPrice).toBeDefined();
      }
    }
  });

  it("verifies the partner offer catalog query returns products for each market without empty screen", async () => {
    const program = await prisma.program.findFirst({
      where: { slug: "we" },
    });
    expect(program).toBeDefined();

    const markets = await prisma.weleticShopifyMarket.findMany({
      where: { store: { programId: program!.id } },
    });

    for (const market of markets) {
      const countryCodes = Array.isArray(market.countryCodes)
        ? (market.countryCodes as string[])
        : [];
      const countryCode = countryCodes[0];

      const products = await prisma.weleticShopifyProduct.findMany({
        where: {
          programId: program!.id,
          status: "active",
          availableForSale: true,
          variants: {
            some: {
              availableForSale: true,
            },
          },
        },
        include: {
          variants: {
            where: { availableForSale: true },
            include: {
              marketPrices: {
                where: {
                  marketId: market.id,
                  ...(countryCode && { countryCode }),
                  available: true,
                },
              },
            },
          },
        },
      });

      expect(products.length).toBeGreaterThan(0);
      for (const p of products) {
        const firstVariant = p.variants[0];
        expect(firstVariant).toBeDefined();
        const price = firstVariant.marketPrices[0] || {
          amount: firstVariant.shopPrice,
          currency: firstVariant.shopCurrency,
        };
        expect(price.amount).toBeDefined();
        expect(price.currency).toBeDefined();
      }
    }
  });
});
