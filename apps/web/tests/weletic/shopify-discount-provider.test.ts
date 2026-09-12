import { DiscountProviderError } from "@/lib/discounts/discount-error";
import {
  formatShopifyGid,
  parseShopifyDiscountConfig,
  shopifyDiscountProvider,
} from "@/lib/discounts/discount-provider-shopify";
import { shopifyCredentialVerificationHash } from "@/lib/weletic/shopify/store-resolver";
import { Discount, Project } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { legacyCredentialSqlFixture } from "./helpers/legacy-credential-sql-fixture";

const rawSql = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/weletic/shopify/credential-source", () => ({
  readShopifyCredentialSource: vi.fn(async () => ({ source: "legacy" })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyAppSession: {
      findFirst: vi.fn(),
    },
    installedIntegration: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(),
    },
    $queryRaw: rawSql.read,
    $executeRaw: rawSql.write,
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/encryption", () => ({
  decryptOrPassthrough: (val: string) => val,
}));

vi.mock("@/lib/integrations/shopify/admin-graphql", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/integrations/shopify/admin-graphql")
  >("@/lib/integrations/shopify/admin-graphql");
  return {
    ...actual,
    shopifyAdminGraphql: vi.fn(),
  };
});

import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { prisma } from "@/lib/prisma";

describe("Shopify Discount Provider & Utilities", () => {
  const mockWorkspace: Pick<Project, "id" | "shopifyStoreId"> = {
    id: "ws_123",
    shopifyStoreId: "yamax-demo.myshopify.com",
  };

  const mockInstallation = {
    id: "inst_1",
    projectId: "ws_123",
    integrationId: "shopify",
    credentials: {
      shop: "yamax-demo.myshopify.com",
      accessToken: "shpat_test_access_token_123",
      scope: "read_products,write_discounts",
      shopVerifiedAt: "2026-08-28T00:00:00.000Z",
      installationGeneration: "sgen_one",
      shopVerificationTokenHash: shopifyCredentialVerificationHash(
        "shpat_test_access_token_123",
      ),
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    vi.mocked(shopifyAdminGraphql).mockReset();
    vi.mocked(prisma.weleticShopifyAppSession.findFirst).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValue(
      mockInstallation as any,
    );
    vi.mocked(prisma.installedIntegration.findUnique).mockResolvedValue(
      mockInstallation as any,
    );
    vi.mocked(prisma.installedIntegration.update).mockResolvedValue({} as any);
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      id: "wstore_1",
      projectId: "ws_123",
      shopDomain: "yamax-demo.myshopify.com",
      complianceState: "active",
      installationGeneration: "sgen_one",
    } as any);
    const fixture = legacyCredentialSqlFixture({
      readStore: () =>
        prisma.weleticShopifyStore.findUnique({ where: { id: "wstore_1" } }),
      readInstallation: (id) =>
        prisma.installedIntegration.findUnique({ where: { id } }),
    });
    rawSql.read.mockImplementation(fixture.queryRaw);
    rawSql.write.mockImplementation(fixture.executeRaw);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback({
        $queryRaw: prisma.$queryRaw,
        $executeRaw: prisma.$executeRaw,
        installedIntegration: {
          findUnique: prisma.installedIntegration.findUnique,
          update: prisma.installedIntegration.update,
        },
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe("formatShopifyGid", () => {
    it("formats raw numeric or string ID to product GID", () => {
      expect(formatShopifyGid("Product", "789102")).toBe(
        "gid://shopify/Product/789102",
      );
      expect(formatShopifyGid("Product", "sprod_yamax_1")).toBe(
        "gid://shopify/Product/sprod_yamax_1",
      );
    });

    it("formats raw numeric or string ID to collection GID", () => {
      expect(formatShopifyGid("Collection", "scoll_leggings")).toBe(
        "gid://shopify/Collection/scoll_leggings",
      );
    });

    it("preserves already formatted GID", () => {
      expect(formatShopifyGid("Product", "gid://shopify/Product/12345")).toBe(
        "gid://shopify/Product/12345",
      );
      expect(
        formatShopifyGid("Collection", "gid://shopify/Collection/54321"),
      ).toBe("gid://shopify/Collection/54321");
    });
  });

  describe("parseShopifyDiscountConfig", () => {
    it("returns discount.shopifyConfig if present", () => {
      const discount = {
        id: "disc_1",
        amount: 20,
        type: "percentage" as const,
        provider: "shopify" as const,
        shopifyConfig: {
          type: "bxgy" as const,
          productIds: ["sprod_1"],
          collectionIds: [],
          bxgy: {
            buyQuantity: 2,
            getQuantity: 1,
            discountType: "percentage" as const,
            discountValue: 100,
          },
        },
      };

      const config = parseShopifyDiscountConfig(discount as any);
      expect(config.type).toBe("bxgy");
      expect(config.bxgy?.buyQuantity).toBe(2);
      expect(config.productIds).toEqual(["sprod_1"]);
    });

    it("parses valid JSON from discount.description", () => {
      const discount = {
        id: "disc_2",
        amount: 0,
        type: "flat" as const,
        provider: "shopify" as const,
        description: JSON.stringify({
          type: "free_shipping",
          freeShipping: {
            minimumSubtotal: 6000,
            maximumShippingPrice: 800,
          },
        }),
      };

      const config = parseShopifyDiscountConfig(discount as any);
      expect(config.type).toBe("free_shipping");
      expect(config.freeShipping?.minimumSubtotal).toBe(6000);
      expect(config.freeShipping?.maximumShippingPrice).toBe(800);
    });

    it("falls back safely to amount_off_order for null or invalid JSON description", () => {
      const discount = {
        id: "disc_3",
        amount: 15,
        type: "percentage" as const,
        provider: "shopify" as const,
        description: "not-json-string",
      };

      const config = parseShopifyDiscountConfig(discount as any);
      expect(config.type).toBe("amount_off_order");
    });
  });

  describe("createDiscountCode", () => {
    it("never uses a global Admin API token as a production tenant credential", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("SHOPIFY_ADMIN_ACCESS_TOKEN", "unsafe_global_token");
      vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce(
        null,
      );

      await expect(
        shopifyDiscountProvider.createDiscountCode({
          workspace: mockWorkspace,
          discount: {
            id: "disc_production_env",
            amount: 20,
            type: "percentage",
            maxDuration: null,
          },
          code: "unsafe-env",
        }),
      ).rejects.toMatchObject({
        providerCode: "INTEGRATION_NOT_AVAILABLE",
      });
      expect(shopifyAdminGraphql).not.toHaveBeenCalled();
    });

    it("rejects an installed credential that belongs to another store", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: { shop: { myshopifyDomain: "other-store.myshopify.com" } },
          }),
        }),
      );
      vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
        ...mockInstallation,
        credentials: {
          ...mockInstallation.credentials,
          shop: "other-store.myshopify.com",
        },
      } as any);

      await expect(
        shopifyDiscountProvider.createDiscountCode({
          workspace: mockWorkspace,
          discount: {
            id: "disc_cross_tenant",
            amount: 20,
            type: "percentage",
            maxDuration: null,
          },
          code: "cross-tenant",
        }),
      ).rejects.toMatchObject({ providerCode: "AUTH_EXPIRED" });
      expect(shopifyAdminGraphql).not.toHaveBeenCalled();
    });

    it("verifies and upgrades a legacy credential before using it", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            data: {
              shop: {
                myshopifyDomain: "yamax-demo.myshopify.com",
                currencyCode: "USD",
              },
            },
          }),
        }),
      );
      vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
        ...mockInstallation,
        credentials: {
          accessToken: "shpat_test_access_token_123",
          scope: "read_products,write_discounts",
        },
      } as any);
      vi.mocked(prisma.installedIntegration.findUnique).mockResolvedValueOnce({
        id: "inst_1",
        projectId: "ws_123",
        credentials: {
          accessToken: "shpat_test_access_token_123",
          scope: "read_products,write_discounts",
        },
      } as any);

      await expect(
        shopifyDiscountProvider.assertDiscountIntegration({
          workspace: { ...mockWorkspace, stripeConnectId: null },
        }),
      ).resolves.toBeUndefined();
      expect(prisma.installedIntegration.update).toHaveBeenCalledWith({
        where: { id: "inst_1" },
        select: { id: true },
        data: {
          credentials: expect.objectContaining({
            shop: "yamax-demo.myshopify.com",
            installationGeneration: "sgen_one",
          }),
        },
      });
    });

    it("creates Amount Off Order discount with discountCodeBasicCreate", async () => {
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        discountCodeBasicCreate: {
          codeDiscountNode: {
            id: "gid://shopify/DiscountCodeNode/1001",
            codeDiscount: {
              codes: {
                nodes: [{ code: "YAMAX20" }],
              },
            },
          },
          userErrors: [],
        },
      });

      const discount: Discount = {
        id: "disc_order",
        amount: 20,
        type: "percentage",
        maxDuration: 0,
        provider: "shopify",
        description: null,
        couponId: null,
        couponTestId: null,
        autoProvisionEnabledAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any;

      const result = await shopifyDiscountProvider.createDiscountCode({
        workspace: mockWorkspace,
        discount,
        code: "yamax20",
      });

      expect(result.code).toBe("YAMAX20");
      expect(shopifyAdminGraphql).toHaveBeenCalledWith(
        expect.objectContaining({
          shopifyStoreId: "yamax-demo.myshopify.com",
          accessToken: "shpat_test_access_token_123",
          variables: expect.objectContaining({
            basicCodeDiscount: expect.objectContaining({
              code: "YAMAX20",
              customerGets: expect.objectContaining({
                items: { all: true },
                value: { percentage: 0.2 },
              }),
            }),
          }),
        }),
      );
    });

    it("creates Amount Off Products discount with item scope", async () => {
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        discountCodeBasicCreate: {
          codeDiscountNode: {
            id: "gid://shopify/DiscountCodeNode/1002",
            codeDiscount: {
              codes: {
                nodes: [{ code: "LEGGINGS15" }],
              },
            },
          },
          userErrors: [],
        },
      });

      const discount: Discount = {
        id: "disc_prod",
        amount: 1500,
        type: "flat",
        provider: "shopify",
        description: JSON.stringify({
          type: "amount_off_products",
          productIds: ["sprod_1", "gid://shopify/Product/sprod_2"],
        }),
      } as any;

      const result = await shopifyDiscountProvider.createDiscountCode({
        workspace: mockWorkspace,
        discount,
        code: "leggings15",
      });

      expect(result.code).toBe("LEGGINGS15");
      expect(shopifyAdminGraphql).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({
            basicCodeDiscount: expect.objectContaining({
              customerGets: expect.objectContaining({
                items: {
                  products: {
                    productsToAdd: [
                      "gid://shopify/Product/sprod_1",
                      "gid://shopify/Product/sprod_2",
                    ],
                  },
                },
                value: {
                  discountAmount: {
                    amount: "15.00",
                    appliesOnEachItem: false,
                  },
                },
              }),
            }),
          }),
        }),
      );
    });

    it("creates BXGY discount with discountCodeBxgyCreate", async () => {
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        discountCodeBxgyCreate: {
          codeDiscountNode: {
            id: "gid://shopify/DiscountCodeNode/1003",
            codeDiscount: {
              codes: {
                nodes: [{ code: "BUY2GET1" }],
              },
            },
          },
          userErrors: [],
        },
      });

      const discount: Discount = {
        id: "disc_bxgy",
        amount: 100,
        type: "percentage",
        provider: "shopify",
        description: JSON.stringify({
          type: "bxgy",
          productIds: ["sprod_legging"],
          bxgy: {
            buyQuantity: 2,
            getQuantity: 1,
            discountType: "percentage",
            discountValue: 100,
          },
        }),
      } as any;

      const result = await shopifyDiscountProvider.createDiscountCode({
        workspace: mockWorkspace,
        discount,
        code: "buy2get1",
      });

      expect(result.code).toBe("BUY2GET1");
      expect(shopifyAdminGraphql).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({
            bxgyCodeDiscount: expect.objectContaining({
              customerBuys: expect.objectContaining({
                items: {
                  products: {
                    productsToAdd: ["gid://shopify/Product/sprod_legging"],
                  },
                },
                value: { quantity: "2" },
              }),
              customerGets: expect.objectContaining({
                items: {
                  products: {
                    productsToAdd: ["gid://shopify/Product/sprod_legging"],
                  },
                },
                value: {
                  discountOnQuantity: {
                    quantity: "1",
                    effect: { percentage: 1 },
                  },
                },
              }),
            }),
          }),
        }),
      );
    });

    it("rejects BXGY discounts without product or collection scope", async () => {
      const discount: Discount = {
        id: "disc_bxgy_invalid",
        amount: 100,
        type: "percentage",
        maxDuration: null,
        provider: "shopify",
        description: JSON.stringify({
          type: "bxgy",
          productIds: [],
          collectionIds: [],
          bxgy: {
            buyQuantity: 1,
            getQuantity: 1,
            discountType: "percentage",
            discountValue: 100,
          },
        }),
      } as any;

      await expect(
        shopifyDiscountProvider.createDiscountCode({
          workspace: mockWorkspace,
          discount,
          code: "invalid-bxgy",
        }),
      ).rejects.toMatchObject({
        providerCode: "INVALID_DISCOUNT_CONFIG",
      });
      expect(shopifyAdminGraphql).not.toHaveBeenCalled();
    });

    it("creates Free Shipping discount with discountCodeFreeShippingCreate", async () => {
      vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
        discountCodeFreeShippingCreate: {
          codeDiscountNode: {
            id: "gid://shopify/DiscountCodeNode/1004",
            codeDiscount: {
              codes: {
                nodes: [{ code: "FREESHIP" }],
              },
            },
          },
          userErrors: [],
        },
      });

      const discount: Discount = {
        id: "disc_freeship",
        amount: 0,
        type: "flat",
        provider: "shopify",
        description: JSON.stringify({
          type: "free_shipping",
          freeShipping: {
            minimumSubtotal: 6000,
            maximumShippingPrice: 800,
          },
        }),
      } as any;

      const result = await shopifyDiscountProvider.createDiscountCode({
        workspace: mockWorkspace,
        discount,
        code: "freeship",
      });

      expect(result.code).toBe("FREESHIP");
      expect(shopifyAdminGraphql).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: expect.objectContaining({
            freeShippingCodeDiscount: expect.objectContaining({
              destination: { all: true },
              minimumRequirement: {
                subtotal: {
                  greaterThanOrEqualToSubtotal: "60.00",
                },
              },
              maximumShippingPrice: "8.00",
            }),
          }),
        }),
      );
    });

    it("retries with suffix on code collision up to 3 attempts", async () => {
      // 1st call fails with code already exists userError
      vi.mocked(shopifyAdminGraphql)
        .mockResolvedValueOnce({
          discountCodeBasicCreate: {
            codeDiscountNode: null,
            userErrors: [
              {
                field: ["basicCodeDiscount", "code"],
                message: "Discount code already exists",
                code: "TAKEN",
              },
            ],
          },
        })
        // 2nd call succeeds with retried code
        .mockResolvedValueOnce({
          discountCodeBasicCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/1005",
              codeDiscount: {
                codes: {
                  nodes: [{ code: "SAVE20AB" }],
                },
              },
            },
            userErrors: [],
          },
        });

      const discount: Discount = {
        id: "disc_retry",
        amount: 20,
        type: "percentage",
        provider: "shopify",
      } as any;

      const result = await shopifyDiscountProvider.createDiscountCode({
        workspace: mockWorkspace,
        discount,
        code: "SAVE20",
        shouldRetry: true,
      });

      expect(result.code).toBe("SAVE20AB");
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(2);
    });

    it("throws DiscountProviderError when Shopify integration is missing", async () => {
      const discount: Discount = {
        id: "disc_err",
        amount: 10,
        type: "percentage",
        provider: "shopify",
      } as any;

      const emptyWorkspace: Pick<Project, "id" | "shopifyStoreId"> = {
        id: "ws_empty",
        shopifyStoreId: null,
      };

      await expect(
        shopifyDiscountProvider.createDiscountCode({
          workspace: emptyWorkspace,
          discount,
          code: "TEST10",
        }),
      ).rejects.toThrow(DiscountProviderError);
    });
  });

  describe("disableDiscountCode", () => {
    it("finds discount node by code and deletes it", async () => {
      vi.mocked(shopifyAdminGraphql)
        .mockResolvedValueOnce({
          codeDiscountNodeByCode: {
            id: "gid://shopify/DiscountCodeNode/9999",
          },
        })
        .mockResolvedValueOnce({
          discountCodeDelete: {
            deletedCodeDiscountId: "gid://shopify/DiscountCodeNode/9999",
            userErrors: [],
          },
        });

      const result = await shopifyDiscountProvider.disableDiscountCode({
        workspace: mockWorkspace,
        code: "YAMAX20",
      });

      expect(result?.id).toBe("gid://shopify/DiscountCodeNode/9999");
      expect(shopifyAdminGraphql).toHaveBeenCalledTimes(2);
    });
  });
});
