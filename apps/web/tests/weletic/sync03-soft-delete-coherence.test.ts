import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Mock withCron to execute handler directly without QStash token verification
vi.mock("@/lib/cron/with-cron", () => ({
  withCron: (handler: any) => async (req: Request, ctx?: any) => {
    const rawBody = await req.text();
    return handler({
      req,
      rawBody,
      params: (await ctx?.params) || {},
      searchParams: {},
    });
  },
}));

// Mock withPartnerProfile
vi.mock("@/lib/auth/partner", () => ({
  withPartnerProfile: (handler: any) => {
    return async (
      req: Request,
      ctx: { params?: Promise<Record<string, string>> } = {},
    ) => {
      const params = (await ctx?.params) || {};
      const url = new URL(req.url, "http://localhost");
      const searchParams = Object.fromEntries(url.searchParams.entries());
      return handler({
        req,
        params,
        searchParams,
        partner: { id: "partner_p1", name: "Partner One" },
        session: {},
        partnerUser: { userId: "user_u1", role: "member" },
      });
    };
  },
}));

const mocks = vi.hoisted(() => ({
  createDiscountCode: vi.fn(),
  findUniqueLink: vi.fn(),
  findUniqueEnrollment: vi.fn(),
  findFirstEnrollment: vi.fn(),
  findManyProducts: vi.fn(),
  findFirstProduct: vi.fn(),
  countProducts: vi.fn(),
  findManyEnrollments: vi.fn(),
  findManyMarkets: vi.fn(),
  findManyRules: vi.fn(),
  findUniqueDiscount: vi.fn(),
  qstashPublish: vi.fn(),
  logAndRespond: vi.fn((message: string, options?: any) => {
    return new Response(JSON.stringify({ message }), {
      status: options?.status || 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
}));

vi.mock("@/lib/discounts/create-discount-code", () => ({
  createDiscountCode: mocks.createDiscountCode,
}));

vi.mock("@/lib/cron", () => ({
  CRON_BATCH_SIZE: 100,
  qstash: {
    publishJSON: mocks.qstashPublish,
  },
}));

vi.mock("@/lib/discounts/discount-provider", () => ({
  getDiscountProvider: vi.fn(() => ({
    assertDiscountIntegration: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@/lib/cron/enqueue-batch-jobs", () => ({
  enqueueBatchJobs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../app/(ee)/api/cron/utils", () => ({
  logAndRespond: mocks.logAndRespond,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    link: {
      findUnique: mocks.findUniqueLink,
    },
    discount: {
      findUnique: mocks.findUniqueDiscount,
    },
    programEnrollment: {
      findUnique: mocks.findUniqueEnrollment,
      findFirst: mocks.findFirstEnrollment,
      findMany: mocks.findManyEnrollments,
    },
    weleticShopifyProduct: {
      findMany: mocks.findManyProducts,
      findFirst: mocks.findFirstProduct,
      count: mocks.countProducts,
    },
    weleticShopifyMarket: {
      findMany: mocks.findManyMarkets,
    },
    weleticCommissionRule: {
      findMany: mocks.findManyRules,
    },
  },
}));

import { getProgramEnrollmentOrThrow } from "@/lib/api/programs/get-program-enrollment-or-throw";
import { DiscountProviderError } from "@/lib/discounts/discount-error";
import { POST as queueBatchesCron } from "../../app/(ee)/api/cron/discount-codes/create/queue-batches/route";
import { POST as createDiscountCodeCron } from "../../app/(ee)/api/cron/discount-codes/create/route";
import { GET as getPartnerProductById } from "../../app/(ee)/api/partner-profile/programs/[programId]/products/[productId]/route";
import { GET as getPartnerProducts } from "../../app/(ee)/api/partner-profile/programs/[programId]/products/route";

describe("SYNC-03: Soft-Delete Coherence (Invariant 2 Compliance)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // 1. Cron Route: POST /api/cron/discount-codes/create
  // =========================================================================
  describe("1. Automated Discount Code Creation Cron Route", () => {
    it("1.1: Re-provisions code when existing discount code is soft-deleted (disabledAt !== null)", async () => {
      mocks.findUniqueLink.mockResolvedValueOnce({
        id: "link_with_disabled_code",
        discountCode: {
          id: "dc_old",
          code: "EXPIRED_CODE",
          disabledAt: new Date("2026-08-01T00:00:00Z"),
        },
        partnerGroupDefaultLinkId: "link_with_disabled_code",
        programEnrollment: {
          partner: { id: "partner_1", name: "Partner One" },
          program: { id: "prog_1" },
          discount: { id: "disc_1", provider: "shopify", programId: "prog_1" },
        },
        project: { id: "ws_1", shopifyStoreId: "yamaxdev.myshopify.com" },
      });

      const response = await createDiscountCodeCron(
        new NextRequest("http://localhost/api/cron/discount-codes/create", {
          method: "POST",
          body: JSON.stringify({ linkId: "link_with_disabled_code" }),
        }),
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toBe(
        "Discount code created for link link_with_disabled_code.",
      );
      expect(mocks.createDiscountCode).toHaveBeenCalledTimes(1);
      expect(mocks.createDiscountCode).toHaveBeenCalledWith(
        expect.objectContaining({
          link: expect.objectContaining({ id: "link_with_disabled_code" }),
        }),
      );
    });

    it("1.2: Skips code creation when existing discount code is active (disabledAt === null)", async () => {
      mocks.findUniqueLink.mockResolvedValueOnce({
        id: "link_with_active_code",
        discountCode: {
          id: "dc_active",
          code: "ACTIVE_SUMMER",
          disabledAt: null,
        },
        partnerGroupDefaultLinkId: "link_with_active_code",
        programEnrollment: {
          partner: { id: "partner_1", name: "Partner One" },
          program: { id: "prog_1" },
          discount: { id: "disc_1", provider: "shopify", programId: "prog_1" },
        },
        project: { id: "ws_1", shopifyStoreId: "yamaxdev.myshopify.com" },
      });

      const response = await createDiscountCodeCron(
        new NextRequest("http://localhost/api/cron/discount-codes/create", {
          method: "POST",
          body: JSON.stringify({ linkId: "link_with_active_code" }),
        }),
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toContain(
        "already has an active discount code. Skipping...",
      );
      expect(mocks.createDiscountCode).not.toHaveBeenCalled();
    });

    it("1.3: Provisions code when link has no discount code (discountCode: null)", async () => {
      mocks.findUniqueLink.mockResolvedValueOnce({
        id: "link_no_code",
        discountCode: null,
        partnerGroupDefaultLinkId: "link_no_code",
        programEnrollment: {
          partner: { id: "partner_2", name: "Partner Two" },
          program: { id: "prog_1" },
          discount: { id: "disc_1", provider: "shopify", programId: "prog_1" },
        },
        project: { id: "ws_1", shopifyStoreId: "yamaxdev.myshopify.com" },
      });

      const response = await createDiscountCodeCron(
        new NextRequest("http://localhost/api/cron/discount-codes/create", {
          method: "POST",
          body: JSON.stringify({ linkId: "link_no_code" }),
        }),
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toBe("Discount code created for link link_no_code.");
      expect(mocks.createDiscountCode).toHaveBeenCalledTimes(1);
    });

    it("1.4: Skips non-default links cleanly", async () => {
      mocks.findUniqueLink.mockResolvedValueOnce({
        id: "link_non_default",
        discountCode: null,
        partnerGroupDefaultLinkId: null,
        programEnrollment: {
          partner: { id: "partner_3", name: "Partner Three" },
          program: { id: "prog_1" },
          discount: { id: "disc_1" },
        },
        project: { id: "ws_1" },
      });

      const response = await createDiscountCodeCron(
        new NextRequest("http://localhost/api/cron/discount-codes/create", {
          method: "POST",
          body: JSON.stringify({ linkId: "link_non_default" }),
        }),
        { params: Promise.resolve({}) },
      );

      const data = await response.json();
      expect(data.message).toContain("is not a default link. Skipping...");
      expect(mocks.createDiscountCode).not.toHaveBeenCalled();
    });

    it("1.5: Catches non-recoverable discount errors gracefully without 500 error", async () => {
      mocks.findUniqueLink.mockResolvedValueOnce({
        id: "link_failing",
        discountCode: null,
        partnerGroupDefaultLinkId: "link_failing",
        programEnrollment: {
          partner: { id: "partner_4", name: "Partner Four" },
          program: { id: "prog_1" },
          discount: { id: "disc_1" },
        },
        project: { id: "ws_1" },
      });

      mocks.createDiscountCode.mockRejectedValueOnce(
        new DiscountProviderError(
          "shopify",
          "INVALID_DISCOUNT_CONFIG",
          "Shopify coupon limit exceeded",
        ),
      );

      const response = await createDiscountCodeCron(
        new NextRequest("http://localhost/api/cron/discount-codes/create", {
          method: "POST",
          body: JSON.stringify({ linkId: "link_failing" }),
        }),
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toBe("Shopify coupon limit exceeded");
    });
  });

  // =========================================================================
  // 2. Cron Queue Batches: POST /api/cron/discount-codes/create/queue-batches
  // =========================================================================
  describe("2. Batch Queueing for Links with Soft-Deleted Codes", () => {
    it("2.1: Enqueues links with soft-deleted discount codes via OR query filter", async () => {
      mocks.findUniqueDiscount.mockResolvedValueOnce({
        id: "disc_1",
        provider: "shopify",
        autoProvisionEnabledAt: new Date("2026-08-01T00:00:00Z"),
        program: {
          id: "prog_1",
          workspace: {
            id: "ws_1",
            shopifyStoreId: "store.myshopify.com",
          },
        },
      });

      mocks.findManyEnrollments.mockResolvedValueOnce([
        {
          id: "enr_1",
          partnerId: "part_1",
          discountId: "disc_1",
          links: [{ id: "link_null_code" }, { id: "link_soft_deleted_code" }],
        },
      ]);

      const response = await queueBatchesCron(
        new NextRequest(
          "http://localhost/api/cron/discount-codes/create/queue-batches",
          {
            method: "POST",
            body: JSON.stringify({
              discountId: "disc_1",
            }),
          },
        ),
        { params: Promise.resolve({}) },
      );

      expect(response.status).toBe(200);
      // Verify query used OR condition for soft-deleted discount codes
      expect(mocks.findManyEnrollments).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({
            links: expect.objectContaining({
              where: expect.objectContaining({
                OR: [
                  { discountCode: null },
                  { discountCode: { disabledAt: { not: null } } },
                ],
              }),
            }),
          }),
        }),
      );
    });
  });

  // =========================================================================
  // 3. Partner Products Catalog API: GET /api/partner-profile/programs/[programId]/products
  // =========================================================================
  describe("3. Partner Catalog Products API", () => {
    const sampleProduct = {
      id: "prod_1",
      externalId: "ext_prod_1",
      title: "Yamax Flow Leggings",
      handle: "yamax-flow-leggings",
      descriptionHtml: "<p>Comfortable high-waist</p>",
      featuredImageUrl: "https://example.com/img.png",
      vendor: "Yamax",
      productType: "Leggings",
      collectionExternalIds: ["col_1"],
      variants: [
        {
          id: "var_1",
          title: "S / Black",
          sku: "YMX-FL-BLK-S",
          imageUrl: null,
          shopPrice: BigInt(6000),
          shopCompareAtPrice: null,
          shopCurrency: "USD",
          marketPrices: [],
        },
      ],
      translations: [],
    };

    it("3.1: Returns partnerCode: null when attached discount code is soft-deleted (does not leak)", async () => {
      mocks.findUniqueEnrollment.mockResolvedValueOnce({
        programId: "prog_1",
        program: { id: "prog_1", accountingCurrency: "USD" },
        links: [
          {
            id: "link_1",
            discountCode: {
              id: "dc_1",
              code: "EXPIRED_CODE",
              disabledAt: new Date("2026-08-01T00:00:00Z"),
            },
          },
        ],
        partnerGroup: {
          discount: { id: "disc_1", type: "percentage", amount: 10 },
          saleReward: null,
        },
      });

      mocks.findManyProducts.mockResolvedValueOnce([sampleProduct]);
      mocks.countProducts.mockResolvedValueOnce(1);
      mocks.findManyMarkets.mockResolvedValueOnce([]);
      mocks.findManyRules.mockResolvedValueOnce([]);

      const response = await getPartnerProducts(
        new NextRequest(
          "http://localhost/api/partner-profile/programs/prog_1/products",
        ),
        { params: Promise.resolve({ programId: "prog_1" }) },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.products).toHaveLength(1);
      // Soft-deleted code must NOT be leaked
      expect(data.products[0].customerDiscount.couponCode).toBeNull();
    });

    it("3.2: Returns active partnerCode when discount code is active (disabledAt === null)", async () => {
      mocks.findUniqueEnrollment.mockResolvedValueOnce({
        programId: "prog_1",
        program: { id: "prog_1", accountingCurrency: "USD" },
        links: [
          {
            id: "link_2",
            discountCode: {
              id: "dc_2",
              code: "ACTIVE_PROMO",
              disabledAt: null,
            },
          },
        ],
        partnerGroup: {
          discount: { id: "disc_1", type: "percentage", amount: 10 },
          saleReward: null,
        },
      });

      mocks.findManyProducts.mockResolvedValueOnce([sampleProduct]);
      mocks.countProducts.mockResolvedValueOnce(1);
      mocks.findManyMarkets.mockResolvedValueOnce([]);
      mocks.findManyRules.mockResolvedValueOnce([]);

      const response = await getPartnerProducts(
        new NextRequest(
          "http://localhost/api/partner-profile/programs/prog_1/products",
        ),
        { params: Promise.resolve({ programId: "prog_1" }) },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.products[0].customerDiscount.couponCode).toBe("ACTIVE_PROMO");
    });

    it("3.3: Selects the active discount code when partner has multiple links (one disabled, one active)", async () => {
      mocks.findUniqueEnrollment.mockResolvedValueOnce({
        programId: "prog_1",
        program: { id: "prog_1", accountingCurrency: "USD" },
        links: [
          {
            id: "link_old",
            discountCode: {
              id: "dc_old",
              code: "OLD_DISABLED",
              disabledAt: new Date("2026-01-01T00:00:00Z"),
            },
          },
          {
            id: "link_new",
            discountCode: {
              id: "dc_new",
              code: "NEW_ACTIVE",
              disabledAt: null,
            },
          },
        ],
        partnerGroup: {
          discount: { id: "disc_1", type: "percentage", amount: 10 },
          saleReward: null,
        },
      });

      mocks.findManyProducts.mockResolvedValueOnce([sampleProduct]);
      mocks.countProducts.mockResolvedValueOnce(1);
      mocks.findManyMarkets.mockResolvedValueOnce([]);
      mocks.findManyRules.mockResolvedValueOnce([]);

      const response = await getPartnerProducts(
        new NextRequest(
          "http://localhost/api/partner-profile/programs/prog_1/products",
        ),
        { params: Promise.resolve({ programId: "prog_1" }) },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.products[0].customerDiscount.couponCode).toBe("NEW_ACTIVE");
    });
  });

  // =========================================================================
  // 4. Partner Single Product API: GET /api/partner-profile/programs/[programId]/products/[productId]
  // =========================================================================
  describe("4. Partner Single Product API", () => {
    const singleProduct = {
      id: "prod_1",
      externalId: "ext_prod_1",
      title: "Yamax Flow Leggings",
      handle: "yamax-flow-leggings",
      descriptionHtml: "<p>Comfortable high-waist</p>",
      featuredImageUrl: "https://example.com/img.png",
      vendor: "Yamax",
      productType: "Leggings",
      collectionExternalIds: ["col_1"],
      variants: [
        {
          id: "var_1",
          title: "S / Black",
          sku: "YMX-FL-BLK-S",
          imageUrl: null,
          shopPrice: BigInt(6000),
          shopCompareAtPrice: null,
          shopCurrency: "USD",
          marketPrices: [],
        },
      ],
      translations: [],
    };

    it("4.1: Returns customerDiscount.partnerCode: null when code is soft-deleted", async () => {
      mocks.findUniqueEnrollment.mockResolvedValueOnce({
        programId: "prog_1",
        program: { id: "prog_1", accountingCurrency: "USD" },
        links: [
          {
            id: "link_1",
            discountCode: {
              code: "DISABLED_ON_PRODUCT",
              disabledAt: new Date("2026-07-01T00:00:00Z"),
            },
          },
        ],
        partnerGroup: {
          discount: { id: "disc_1", type: "percentage", amount: 10 },
          saleReward: null,
        },
      });

      mocks.findFirstProduct.mockResolvedValueOnce(singleProduct);
      mocks.findManyMarkets.mockResolvedValueOnce([]);
      mocks.findManyRules.mockResolvedValueOnce([]);

      const response = await getPartnerProductById(
        new NextRequest(
          "http://localhost/api/partner-profile/programs/prog_1/products/prod_1",
        ),
        {
          params: Promise.resolve({ programId: "prog_1", productId: "prod_1" }),
        },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.product.customerDiscount.couponCode).toBeNull();
    });

    it("4.2: Returns active customerDiscount.partnerCode in single product view", async () => {
      mocks.findUniqueEnrollment.mockResolvedValueOnce({
        programId: "prog_1",
        program: { id: "prog_1", accountingCurrency: "USD" },
        links: [
          {
            id: "link_active",
            discountCode: {
              code: "ACTIVE_ON_PRODUCT",
              disabledAt: null,
            },
          },
        ],
        partnerGroup: {
          discount: { id: "disc_1", type: "percentage", amount: 15 },
          saleReward: null,
        },
      });

      mocks.findFirstProduct.mockResolvedValueOnce(singleProduct);
      mocks.findManyMarkets.mockResolvedValueOnce([]);
      mocks.findManyRules.mockResolvedValueOnce([]);

      const response = await getPartnerProductById(
        new NextRequest(
          "http://localhost/api/partner-profile/programs/prog_1/products/prod_1",
        ),
        {
          params: Promise.resolve({ programId: "prog_1", productId: "prod_1" }),
        },
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.product.customerDiscount.couponCode).toBe(
        "ACTIVE_ON_PRODUCT",
      );
    });
  });

  // =========================================================================
  // 5. getProgramEnrollmentOrThrow Link Soft-Delete Filtering
  // =========================================================================
  describe("5. getProgramEnrollmentOrThrow Invariant 2 Enforcement", () => {
    it("5.1: Applies status='active' filter to links.discountCode.where", async () => {
      mocks.findUniqueEnrollment.mockResolvedValueOnce({
        id: "enr_test",
        partnerId: "partner_p1",
        programId: "prog_1",
        links: [],
      });

      await getProgramEnrollmentOrThrow({
        partnerId: "partner_p1",
        programId: "prog_1",
        status: "active",
        include: {
          links: true,
        },
      });

      expect(mocks.findUniqueEnrollment).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            links: expect.objectContaining({
              include: {
                discountCode: {
                  where: { disabledAt: null },
                },
              },
            }),
          }),
        }),
      );
    });

    it("5.2: Preserves caller's links.where filter options while injecting discountCodesWhere", async () => {
      mocks.findUniqueEnrollment.mockResolvedValueOnce({
        id: "enr_test",
        partnerId: "partner_p1",
        programId: "prog_1",
        links: [],
      });

      await getProgramEnrollmentOrThrow({
        partnerId: "partner_p1",
        programId: "prog_1",
        status: "active",
        include: {
          links: {
            where: { disabledAt: null },
            include: { discountCode: true },
          },
        },
      });

      expect(mocks.findUniqueEnrollment).toHaveBeenCalledWith(
        expect.objectContaining({
          include: expect.objectContaining({
            links: expect.objectContaining({
              where: { disabledAt: null },
              include: {
                discountCode: {
                  where: { disabledAt: null },
                },
              },
            }),
          }),
        }),
      );
    });
  });
});
