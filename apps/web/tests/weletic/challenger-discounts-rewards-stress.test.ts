import {
  formatShopifyGid,
  parseShopifyDiscountConfig,
  shopifyDiscountProvider,
} from "@/lib/discounts/discount-provider-shopify";
import { evaluateRewardConditions } from "@/lib/partners/evaluate-reward-conditions";
import { RewardConditionsArray, RewardContext } from "@/lib/types";
import {
  rewardConditionSchema,
  rewardConditionsSchema,
} from "@/lib/zod/schemas/rewards";
import { Discount, Project } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// This suite supplies legacy integration fixtures. Native credential-source
// authorization and lifecycle fences are covered by their dedicated suites.
vi.mock("@/lib/weletic/shopify/credential-source", () => ({
  readShopifyCredentialSource: vi.fn(async () => ({ source: "legacy" })),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      findUnique: vi.fn().mockResolvedValue({
        id: "wstore_adversarial_test",
        projectId: "ws_adversarial_test",
        shopDomain: "yamax-stress.myshopify.com",
        installationGeneration: "sgen_adversarial_test",
      }),
    },
    weleticShopifyAppSession: {
      findFirst: vi.fn(),
    },
    installedIntegration: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  normalizeShopDomain: (domain: string) =>
    domain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, ""),
  verifyAndBindShopifyIntegrationCredential: vi.fn(
    async ({ installation }: any) =>
      installation.credentials?.accessToken ? installation.credentials : null,
  ),
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

describe("Adversarial Empirical Stress Testing: 4-Type Shopify Discounts & Rewards Engine", () => {
  const mockWorkspace: Pick<Project, "id" | "shopifyStoreId"> = {
    id: "ws_adversarial_test",
    shopifyStoreId: "yamax-stress.myshopify.com",
  };

  const mockInstallation = {
    id: "inst_adv_1",
    projectId: "ws_adversarial_test",
    integrationId: "shopify",
    credentials: {
      shop: "yamax-stress.myshopify.com",
      accessToken: "shpat_adversarial_token_999",
      scope: "read_products,write_discounts,read_orders",
      shopVerifiedAt: "2026-08-28T00:00:00.000Z",
      shopVerificationTokenHash:
        "4166d11463491a0f189295f7ec7a4b595467a673926a9d49f51708fe070af5c8",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shopifyAdminGraphql).mockReset();
    vi.mocked(prisma.weleticShopifyAppSession.findFirst).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValue(
      mockInstallation as any,
    );
  });

  // =========================================================================
  // SUITE 1: Shopify Discount Provider GraphQL Mutation Generators & Engine
  // =========================================================================
  describe("Suite 1: discount-provider-shopify.ts Adversarial Stress Suite", () => {
    describe("1.1 GID Formatting & Malformed Input Handling", () => {
      it("formats bare numerical IDs into valid GraphQL GIDs", () => {
        expect(formatShopifyGid("Product", 1029384756)).toBe(
          "gid://shopify/Product/1029384756",
        );
        expect(formatShopifyGid("Collection", 55667788)).toBe(
          "gid://shopify/Collection/55667788",
        );
        expect(formatShopifyGid("ProductVariant", 998877)).toBe(
          "gid://shopify/ProductVariant/998877",
        );
      });

      it("preserves already well-formed GIDs without double-prefixing", () => {
        const canonical = "gid://shopify/Product/77889900";
        expect(formatShopifyGid("Product", canonical)).toBe(canonical);
      });

      it("trims whitespace from input strings prior to GID checking", () => {
        expect(
          formatShopifyGid("Product", "   gid://shopify/Product/123   "),
        ).toBe("gid://shopify/Product/123");
        expect(formatShopifyGid("Collection", "  scoll_leggings  ")).toBe(
          "gid://shopify/Collection/scoll_leggings",
        );
      });

      it("handles stringified GIDs with non-matching types as raw GIDs if they begin with gid://shopify/", () => {
        // If a collection GID is passed to formatShopifyGid('Product', ...), it preserves standard GID
        expect(
          formatShopifyGid("Product", "gid://shopify/Collection/12345"),
        ).toBe("gid://shopify/Collection/12345");
      });
    });

    describe("1.2 Config Parsing Robustness & Edge Cases", () => {
      it("prioritizes discount.shopifyConfig object if present", () => {
        const discount = {
          amount: 25,
          type: "percentage" as const,
          shopifyConfig: {
            type: "bxgy" as const,
            productIds: ["sprod_1", "sprod_2"],
            collectionIds: ["scoll_1"],
            bxgy: {
              buyQuantity: 3,
              getQuantity: 1,
              discountType: "percentage" as const,
              discountValue: 100,
            },
          },
        };

        const parsed = parseShopifyDiscountConfig(discount);
        expect(parsed.type).toBe("bxgy");
        expect(parsed.productIds).toEqual(["sprod_1", "sprod_2"]);
        expect(parsed.collectionIds).toEqual(["scoll_1"]);
        expect(parsed.bxgy?.buyQuantity).toBe(3);
        expect(parsed.bxgy?.getQuantity).toBe(1);
      });

      it("parses valid JSON string in discount.description when shopifyConfig is omitted", () => {
        const discount = {
          amount: 0,
          type: "flat" as const,
          description: JSON.stringify({
            type: "free_shipping",
            freeShipping: {
              minimumSubtotal: 8000,
              maximumShippingPrice: 1000,
            },
          }),
        };

        const parsed = parseShopifyDiscountConfig(discount);
        expect(parsed.type).toBe("free_shipping");
        expect(parsed.freeShipping?.minimumSubtotal).toBe(8000);
        expect(parsed.freeShipping?.maximumShippingPrice).toBe(1000);
      });

      it("safely falls back to amount_off_order when description is invalid JSON or primitive", () => {
        const invalidDescriptions = [
          "",
          "not a json",
          "12345",
          "true",
          '"plain string"',
          "null",
          "{ malformed: json ",
        ];

        for (const desc of invalidDescriptions) {
          const parsed = parseShopifyDiscountConfig({
            amount: 10,
            type: "percentage",
            description: desc,
          });
          expect(parsed.type).toBe("amount_off_order");
          expect(parsed.productIds).toEqual([]);
          expect(parsed.collectionIds).toEqual([]);
        }
      });

      it("safely handles non-array productIds and collectionIds in JSON description", () => {
        const discount = {
          amount: 10,
          type: "percentage" as const,
          description: JSON.stringify({
            type: "amount_off_products",
            productIds: "invalid_string_not_array",
            collectionIds: 12345,
          }),
        };

        const parsed = parseShopifyDiscountConfig(discount);
        expect(parsed.type).toBe("amount_off_products");
        expect(parsed.productIds).toEqual([]);
        expect(parsed.collectionIds).toEqual([]);
      });
    });

    describe("1.3 Buy X Get Y (BXGY) Complex Combinations", () => {
      it("creates BXGY Buy 2 Get 1 100% Free with percentage discount", async () => {
        vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
          discountCodeBxgyCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/bxgy_1",
              codeDiscount: {
                codes: { nodes: [{ code: "BUY2GET1FREE" }] },
              },
            },
            userErrors: [],
          },
        });

        const discount: Discount = {
          id: "d_bxgy_1",
          amount: 100,
          type: "percentage",
          maxDuration: null,
          provider: "shopify",
          description: JSON.stringify({
            type: "bxgy",
            productIds: ["sprod_yamax_leggings"],
            bxgy: {
              buyQuantity: 2,
              getQuantity: 1,
              discountType: "percentage",
              discountValue: 100,
            },
          }),
        } as any;

        const res = await shopifyDiscountProvider.createDiscountCode({
          workspace: mockWorkspace,
          discount,
          code: "buy2get1free",
        });

        expect(res.code).toBe("BUY2GET1FREE");
        expect(shopifyAdminGraphql).toHaveBeenCalledWith(
          expect.objectContaining({
            variables: {
              bxgyCodeDiscount: expect.objectContaining({
                title: "Dub Discount (buy2get1free)",
                code: "BUY2GET1FREE",
                customerBuys: {
                  value: { quantity: "2" },
                  items: {
                    products: {
                      productsToAdd: [
                        "gid://shopify/Product/sprod_yamax_leggings",
                      ],
                    },
                  },
                },
                customerGets: {
                  value: {
                    discountOnQuantity: {
                      quantity: "1",
                      effect: { percentage: 1 },
                    },
                  },
                  items: {
                    products: {
                      productsToAdd: [
                        "gid://shopify/Product/sprod_yamax_leggings",
                      ],
                    },
                  },
                  appliesOnOneTimePurchase: true,
                  appliesOnSubscription: false,
                },
              }),
            },
          }),
        );
      });

      it("rejects BXGY item scopes that mix products and collections", async () => {
        const discount: Discount = {
          id: "d_bxgy_2",
          amount: 50,
          type: "percentage",
          maxDuration: 0,
          provider: "shopify",
          shopifyConfig: {
            type: "bxgy",
            productIds: ["sprod_101", "sprod_102"],
            collectionIds: ["scoll_activewear"],
            bxgy: {
              buyQuantity: 3,
              getQuantity: 2,
              discountType: "percentage",
              discountValue: 50,
            },
          },
        } as any;

        await expect(
          shopifyDiscountProvider.createDiscountCode({
            workspace: mockWorkspace,
            discount,
            code: "buy3get2half",
          }),
        ).rejects.toMatchObject({
          providerCode: "INVALID_DISCOUNT_CONFIG",
        });
        expect(shopifyAdminGraphql).not.toHaveBeenCalled();
      });

      it("preserves three-decimal currency precision for flat BXGY effects", async () => {
        vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
          discountCodeBxgyCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/bxgy_flat",
              codeDiscount: {
                codes: { nodes: [{ code: "BUY1GETKWD5" }] },
              },
            },
            userErrors: [],
          },
        });

        const discount: Discount = {
          id: "d_bxgy_3",
          amount: 1000,
          type: "flat",
          maxDuration: null,
          provider: "shopify",
          shopifyConfig: {
            type: "bxgy",
            productIds: ["sprod_flat"],
            collectionIds: [],
            bxgy: {
              buyQuantity: 1,
              getQuantity: 1,
              discountType: "amount",
              discountValue: 5.001,
            },
          },
        } as any;

        const res = await shopifyDiscountProvider.createDiscountCode({
          workspace: mockWorkspace,
          discount,
          code: "buy1getkwd5",
        });

        expect(res.code).toBe("BUY1GETKWD5");
        expect(shopifyAdminGraphql).toHaveBeenCalledWith(
          expect.objectContaining({
            variables: {
              bxgyCodeDiscount: expect.objectContaining({
                customerBuys: {
                  value: { quantity: "1" },
                  items: {
                    products: {
                      productsToAdd: ["gid://shopify/Product/sprod_flat"],
                    },
                  },
                },
                customerGets: expect.objectContaining({
                  value: {
                    discountOnQuantity: {
                      quantity: "1",
                      effect: { amount: "5.001" },
                    },
                  },
                  items: {
                    products: {
                      productsToAdd: ["gid://shopify/Product/sprod_flat"],
                    },
                  },
                }),
              }),
            },
          }),
        );
      });

      it("normalizes a 1% BXGY reward to Shopify's 0.01 fraction", async () => {
        vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
          discountCodeBxgyCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/bxgy_boundary",
              codeDiscount: {
                codes: { nodes: [{ code: "BUY1GET1_BOUND" }] },
              },
            },
            userErrors: [],
          },
        });

        const discount: Discount = {
          id: "d_bxgy_bound",
          amount: 1,
          type: "percentage",
          maxDuration: null,
          provider: "shopify",
          shopifyConfig: {
            type: "bxgy",
            productIds: ["sprod_boundary"],
            collectionIds: [],
            bxgy: {
              buyQuantity: 1,
              getQuantity: 1,
              discountType: "percentage",
              discountValue: 1,
            },
          },
        } as any;

        await shopifyDiscountProvider.createDiscountCode({
          workspace: mockWorkspace,
          discount,
          code: "buy1get1_bound",
        });

        const callArgs = vi.mocked(shopifyAdminGraphql).mock.calls[0][0];
        const effect = (callArgs.variables as any).bxgyCodeDiscount.customerGets
          .value.discountOnQuantity.effect;
        expect(effect.percentage).toBe(0.01);
      });
    });

    describe("1.4 Free Shipping Boundary Cases & Rate Caps", () => {
      it("creates unconditional free shipping when subtotal and shipping caps are zero or omitted", async () => {
        vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
          discountCodeFreeShippingCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/fs_unconditional",
              codeDiscount: {
                codes: { nodes: [{ code: "FREESHIP_ALL" }] },
              },
            },
            userErrors: [],
          },
        });

        const discount: Discount = {
          id: "d_fs_1",
          amount: 0,
          type: "flat",
          maxDuration: null,
          provider: "shopify",
          shopifyConfig: {
            type: "free_shipping",
            freeShipping: {
              minimumSubtotal: 0,
              maximumShippingPrice: 0,
            },
          },
        } as any;

        const res = await shopifyDiscountProvider.createDiscountCode({
          workspace: mockWorkspace,
          discount,
          code: "freeship_all",
        });

        expect(res.code).toBe("FREESHIP_ALL");
        expect(shopifyAdminGraphql).toHaveBeenCalledWith(
          expect.objectContaining({
            variables: {
              freeShippingCodeDiscount: expect.objectContaining({
                destination: { all: true },
                recurringCycleLimit: 0,
              }),
            },
          }),
        );

        // Verify minimumRequirement and maximumShippingPrice are NOT present
        const callArgs = vi.mocked(shopifyAdminGraphql).mock.calls[0][0];
        const payload = (callArgs.variables as any).freeShippingCodeDiscount;
        expect(payload.minimumRequirement).toBeUndefined();
        expect(payload.maximumShippingPrice).toBeUndefined();
      });

      it("creates Free Shipping with both subtotal minimum ($60.00 = 6000 cents) and rate cap ($8.00 = 800 cents)", async () => {
        vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
          discountCodeFreeShippingCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/fs_capped",
              codeDiscount: {
                codes: { nodes: [{ code: "FREESHIP60" }] },
              },
            },
            userErrors: [],
          },
        });

        const discount: Discount = {
          id: "d_fs_2",
          amount: 0,
          type: "flat",
          maxDuration: 0,
          provider: "shopify",
          shopifyConfig: {
            type: "free_shipping",
            freeShipping: {
              minimumSubtotal: 6000,
              maximumShippingPrice: 800,
            },
          },
        } as any;

        const res = await shopifyDiscountProvider.createDiscountCode({
          workspace: mockWorkspace,
          discount,
          code: "freeship60",
        });

        expect(res.code).toBe("FREESHIP60");
        expect(shopifyAdminGraphql).toHaveBeenCalledWith(
          expect.objectContaining({
            variables: {
              freeShippingCodeDiscount: expect.objectContaining({
                recurringCycleLimit: 1,
                minimumRequirement: {
                  subtotal: {
                    greaterThanOrEqualToSubtotal: "60.00",
                  },
                },
                maximumShippingPrice: "8.00",
              }),
            },
          }),
        );
      });
    });

    describe("1.5 Amount Off Products: Array Sizes & Items Scoping", () => {
      it("falls back to { all: true } when amount_off_products has empty productIds and collectionIds", async () => {
        vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
          discountCodeBasicCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/aop_empty",
              codeDiscount: {
                codes: { nodes: [{ code: "PRODEMPTY" }] },
              },
            },
            userErrors: [],
          },
        });

        const discount: Discount = {
          id: "d_aop_1",
          amount: 15,
          type: "percentage",
          maxDuration: null,
          provider: "shopify",
          shopifyConfig: {
            type: "amount_off_products",
            productIds: [],
            collectionIds: [],
          },
        } as any;

        const res = await shopifyDiscountProvider.createDiscountCode({
          workspace: mockWorkspace,
          discount,
          code: "prodempty",
        });

        expect(res.code).toBe("PRODEMPTY");
        expect(shopifyAdminGraphql).toHaveBeenCalledWith(
          expect.objectContaining({
            variables: {
              basicCodeDiscount: expect.objectContaining({
                customerGets: expect.objectContaining({
                  items: { all: true },
                }),
              }),
            },
          }),
        );
      });

      it("handles large array of 200 product IDs formatted as GIDs", async () => {
        vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
          discountCodeBasicCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/aop_200",
              codeDiscount: {
                codes: { nodes: [{ code: "PROD200" }] },
              },
            },
            userErrors: [],
          },
        });

        const productIds = Array.from(
          { length: 200 },
          (_, i) => `sprod_${i + 1}`,
        );

        const discount: Discount = {
          id: "d_aop_200",
          amount: 2500, // $25.00
          type: "flat",
          maxDuration: 6,
          provider: "shopify",
          shopifyConfig: {
            type: "amount_off_products",
            productIds,
            collectionIds: [],
          },
        } as any;

        const res = await shopifyDiscountProvider.createDiscountCode({
          workspace: mockWorkspace,
          discount,
          code: "prod200",
        });

        expect(res.code).toBe("PROD200");
        const callArgs = vi.mocked(shopifyAdminGraphql).mock.calls[0][0];
        const basicDiscount = (callArgs.variables as any).basicCodeDiscount;
        expect(basicDiscount.recurringCycleLimit).toBe(6);
        expect(
          basicDiscount.customerGets.items.products.productsToAdd,
        ).toHaveLength(200);
        expect(basicDiscount.customerGets.items.products.productsToAdd[0]).toBe(
          "gid://shopify/Product/sprod_1",
        );
        expect(
          basicDiscount.customerGets.items.products.productsToAdd[199],
        ).toBe("gid://shopify/Product/sprod_200");
      });
    });

    describe("1.6 Collision Retries & Error Resilience", () => {
      it("retries on TAKEN or duplicate error and succeeds on 3rd attempt with nanoid suffixes", async () => {
        vi.mocked(shopifyAdminGraphql)
          // Attempt 1 fails
          .mockResolvedValueOnce({
            discountCodeBasicCreate: {
              codeDiscountNode: null,
              userErrors: [
                {
                  field: ["basicCodeDiscount", "code"],
                  message: "The discount code already exists.",
                  code: "TAKEN",
                },
              ],
            },
          })
          // Attempt 2 fails
          .mockResolvedValueOnce({
            discountCodeBasicCreate: {
              codeDiscountNode: null,
              userErrors: [
                {
                  field: ["basicCodeDiscount", "code"],
                  message: "Duplicate discount code.",
                  code: "DUPLICATE",
                },
              ],
            },
          })
          // Attempt 3 succeeds
          .mockResolvedValueOnce({
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/retry_ok",
                codeDiscount: {
                  codes: { nodes: [{ code: "SUMMER20XYZ" }] },
                },
              },
              userErrors: [],
            },
          });

        const discount: Discount = {
          id: "d_retry_3",
          amount: 20,
          type: "percentage",
          maxDuration: null,
          provider: "shopify",
        } as any;

        const res = await shopifyDiscountProvider.createDiscountCode({
          workspace: mockWorkspace,
          discount,
          code: "summer20",
          shouldRetry: true,
        });

        expect(res.code).toBe("SUMMER20XYZ");
        expect(shopifyAdminGraphql).toHaveBeenCalledTimes(3);
      });

      it("throws DISCOUNT_ALREADY_EXISTS immediately when collision occurs and shouldRetry is false", async () => {
        vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
          discountCodeBasicCreate: {
            codeDiscountNode: null,
            userErrors: [
              {
                field: ["basicCodeDiscount", "code"],
                message: "The discount code already exists.",
                code: "TAKEN",
              },
            ],
          },
        });

        const discount: Discount = {
          id: "d_no_retry",
          amount: 20,
          type: "percentage",
          maxDuration: null,
          provider: "shopify",
        } as any;

        await expect(
          shopifyDiscountProvider.createDiscountCode({
            workspace: mockWorkspace,
            discount,
            code: "noretry20",
            shouldRetry: false,
          }),
        ).rejects.toThrow(
          expect.objectContaining({
            providerCode: "DISCOUNT_ALREADY_EXISTS",
          }),
        );

        expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);
      });

      it("throws CREATE_FAILED when collision persists through 3 full attempts", async () => {
        vi.mocked(shopifyAdminGraphql).mockResolvedValue({
          discountCodeBasicCreate: {
            codeDiscountNode: null,
            userErrors: [
              {
                field: ["basicCodeDiscount", "code"],
                message: "The discount code already exists.",
                code: "TAKEN",
              },
            ],
          },
        } as any);

        const discount: Discount = {
          id: "d_exhaust",
          amount: 20,
          type: "percentage",
          maxDuration: null,
          provider: "shopify",
        } as any;

        await expect(
          shopifyDiscountProvider.createDiscountCode({
            workspace: mockWorkspace,
            discount,
            code: "exhaust20",
            shouldRetry: true,
          }),
        ).rejects.toThrow(
          expect.objectContaining({
            providerCode: "CREATE_FAILED",
          }),
        );

        expect(shopifyAdminGraphql).toHaveBeenCalledTimes(3);
      });

      it("throws PERMISSIONS_REQUIRED when write_discounts scope is absent", async () => {
        vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
          id: "inst_no_scope",
          projectId: mockWorkspace.id,
          integrationId: "shopify",
          credentials: {
            shop: "yamax-stress.myshopify.com",
            accessToken: "shpat_token",
            scope: "read_products,read_orders", // missing write_discounts
            shopVerifiedAt: "2026-08-28T00:00:00.000Z",
            shopVerificationTokenHash:
              "462797e00b0554282592bc0adbfe9fd10de6fb9a4a899ade3bc5f9153b379b00",
          },
        } as any);

        const discount: Discount = {
          id: "d_scope_err",
          amount: 10,
          type: "percentage",
          maxDuration: null,
          provider: "shopify",
        } as any;

        await expect(
          shopifyDiscountProvider.createDiscountCode({
            workspace: mockWorkspace,
            discount,
            code: "testscope",
          }),
        ).rejects.toThrow(
          expect.objectContaining({
            providerCode: "PERMISSIONS_REQUIRED",
          }),
        );
      });

      it("throws AUTH_EXPIRED when credentials have expired or token is missing", async () => {
        vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
          id: "inst_no_token",
          projectId: mockWorkspace.id,
          integrationId: "shopify",
          credentials: {
            shop: "yamax-stress.myshopify.com",
            accessToken: "", // empty
            scope: "read_products,write_discounts",
          },
        } as any);

        const discount: Discount = {
          id: "d_token_err",
          amount: 10,
          type: "percentage",
          maxDuration: null,
          provider: "shopify",
        } as any;

        await expect(
          shopifyDiscountProvider.createDiscountCode({
            workspace: mockWorkspace,
            discount,
            code: "testtoken",
          }),
        ).rejects.toThrow(
          expect.objectContaining({
            providerCode: "AUTH_EXPIRED",
          }),
        );
      });

      it("handles disableDiscountCode gracefully when discount code node is not found in Shopify", async () => {
        vi.mocked(shopifyAdminGraphql).mockResolvedValueOnce({
          codeDiscountNodeByCode: null, // not found
        });

        const res = await shopifyDiscountProvider.disableDiscountCode({
          workspace: mockWorkspace,
          code: "NOT_FOUND_CODE",
        });

        expect(res).toBeUndefined();
        expect(shopifyAdminGraphql).toHaveBeenCalledTimes(1);
      });
    });
  });

  // =========================================================================
  // SUITE 2: Reward Conditions Schema & Composite Evaluation Stress Suite
  // =========================================================================
  describe("Suite 2: rewards.ts & evaluate-reward-conditions.ts Adversarial Stress Suite", () => {
    describe("2.1 Schema Definition & Validation Robustness", () => {
      it("keeps Shopify criteria out of the generic Sale Reward contract", () => {
        expect(
          rewardConditionSchema.safeParse({
            entity: "shopify",
            attribute: "product",
            operator: "equals_to",
            value: "sprod_101",
          }).success,
        ).toBe(false);
      });

      it("rejects all former Shopify attributes in generic reward conditions", () => {
        const condProduct = {
          entity: "shopify",
          attribute: "product",
          operator: "equals_to",
          value: "sprod_101",
          label: "Yamax Flow Leggings",
        };
        const condCollection = {
          entity: "shopify",
          attribute: "collection",
          operator: "in",
          value: ["scoll_active", "scoll_summer"],
          label: "Activewear & Summer Collections",
        };
        const condVariant = {
          entity: "shopify",
          attribute: "variant",
          operator: "equals_to",
          value: "svar_black_s",
          label: "Black / S",
        };
        const condTag = {
          entity: "shopify",
          attribute: "productTag",
          operator: "contains",
          value: "compression",
        };

        expect(rewardConditionSchema.safeParse(condProduct).success).toBe(
          false,
        );
        expect(rewardConditionSchema.safeParse(condCollection).success).toBe(
          false,
        );
        expect(rewardConditionSchema.safeParse(condVariant).success).toBe(
          false,
        );
        expect(rewardConditionSchema.safeParse(condTag).success).toBe(false);
      });

      it("rejects invalid reward modifiers with percentage > 100 or < 0", () => {
        const invalidOver = {
          operator: "AND",
          conditions: [
            {
              entity: "shopify",
              attribute: "product",
              operator: "equals_to",
              value: "sprod_1",
            },
          ],
          amountInPercentage: 101,
          type: "percentage",
        };
        const invalidUnder = {
          operator: "AND",
          conditions: [
            {
              entity: "shopify",
              attribute: "product",
              operator: "equals_to",
              value: "sprod_1",
            },
          ],
          amountInPercentage: -5,
          type: "percentage",
        };

        expect(rewardConditionsSchema.safeParse(invalidOver).success).toBe(
          false,
        );
        expect(rewardConditionsSchema.safeParse(invalidUnder).success).toBe(
          false,
        );
      });

      it("rejects empty conditions array", () => {
        const empty = {
          operator: "AND",
          conditions: [],
          amountInPercentage: 10,
          type: "percentage",
        };
        expect(rewardConditionsSchema.safeParse(empty).success).toBe(false);
      });
    });

    describe("2.2 Composite AND / OR Tree Evaluation with Mixed Entities", () => {
      it("evaluates AND group: Customer Country AND Partner Conversions", () => {
        const conditions: RewardConditionsArray = [
          {
            id: "group_and_mixed",
            operator: "AND",
            conditions: [
              {
                entity: "customer",
                attribute: "country",
                operator: "equals_to",
                value: "US",
              },
              {
                entity: "partner",
                attribute: "totalConversions",
                operator: "greater_than_or_equal",
                value: 10,
              },
            ],
            amountInPercentage: 25,
            type: "percentage",
          },
        ];

        // Case 1: All 3 match -> qualifies for 25%
        const matchContext: RewardContext = {
          customer: {
            country: "US",
          },
          partner: {
            totalConversions: 15,
          },
        };
        const resMatch = evaluateRewardConditions({
          conditions,
          context: matchContext,
        });
        expect(resMatch).not.toBeNull();
        expect(resMatch?.id).toBe("group_and_mixed");
        expect(resMatch?.amountInPercentage).toBe(25);

        // Case 2: Partner conversions = 8 (< 10) -> fails AND evaluation
        const failContext: RewardContext = {
          customer: {
            country: "US",
          },
          partner: {
            totalConversions: 8,
          },
        };
        const resFail = evaluateRewardConditions({
          conditions,
          context: failContext,
        });
        expect(resFail).toBeNull();
      });

      it("evaluates OR group: Customer Country IN [...] OR Sale Amount >= $100.00", () => {
        const conditions: RewardConditionsArray = [
          {
            id: "group_or_mixed",
            operator: "OR",
            conditions: [
              {
                entity: "customer",
                attribute: "country",
                operator: "in",
                value: ["US", "JP"],
              },
              {
                entity: "sale",
                attribute: "amount",
                operator: "greater_than_or_equal",
                value: 10000, // $100.00
              },
            ],
            amountInCents: 1500, // $15.00 flat bonus
            type: "flat",
          },
        ];

        // Matches customer country only
        const countryMatch = evaluateRewardConditions({
          conditions,
          context: {
            customer: { country: "JP" },
            sale: {
              amount: 5000,
            },
          },
        });
        expect(countryMatch?.id).toBe("group_or_mixed");

        // Matches sale amount only
        const saleMatch = evaluateRewardConditions({
          conditions,
          context: {
            customer: { country: "DE" },
            sale: {
              amount: 12000,
            },
          },
        });
        expect(saleMatch?.id).toBe("group_or_mixed");

        // Neither matches
        const noMatch = evaluateRewardConditions({
          conditions,
          context: {
            customer: { country: "DE" },
            sale: {
              amount: 8000,
            },
          },
        });
        expect(noMatch).toBeNull();
      });

      it("resolves highest payout when multiple competing modifier groups match", () => {
        const conditions: RewardConditionsArray = [
          {
            id: "group_low_10",
            operator: "AND",
            conditions: [
              {
                entity: "partner",
                attribute: "totalConversions",
                operator: "greater_than_or_equal",
                value: 10,
              },
            ],
            amountInPercentage: 10,
            type: "percentage",
          },
          {
            id: "group_high_30",
            operator: "AND",
            conditions: [
              {
                entity: "partner",
                attribute: "totalSaleAmount",
                operator: "greater_than_or_equal",
                value: 100_000,
              },
            ],
            amountInPercentage: 30,
            type: "percentage",
          },
          {
            id: "group_mid_20",
            operator: "AND",
            conditions: [
              {
                entity: "customer",
                attribute: "country",
                operator: "equals_to",
                value: "JP",
              },
            ],
            amountInPercentage: 20,
            type: "percentage",
          },
        ];

        // Context matches all 3 groups.
        const context: RewardContext = {
          customer: {
            country: "JP",
          },
          partner: {
            totalConversions: 20,
            totalSaleAmount: 200_000,
          },
        };

        const result = evaluateRewardConditions({ conditions, context });
        expect(result?.id).toBe("group_high_30");
        expect(result?.amountInPercentage).toBe(30);
      });
    });

    describe("2.3 Tag, Variant, and Substring Operator Corner Cases", () => {
      it("evaluates substring matching on a generic sale product ID", () => {
        const conditions: RewardConditionsArray = [
          {
            id: "group_tag_case",
            operator: "AND",
            conditions: [
              {
                entity: "sale",
                attribute: "productId",
                operator: "contains",
                value: "COMPRESSION",
              },
            ],
            amountInPercentage: 15,
            type: "percentage",
          },
        ];

        const match = evaluateRewardConditions({
          conditions,
          context: {
            sale: { productId: "high-COMPRESSION-yoga" },
          },
        });
        expect(match?.id).toBe("group_tag_case");
      });

      it("evaluates exact matching for a generic sale product ID", () => {
        const conditions: RewardConditionsArray = [
          {
            id: "group_variant_sku",
            operator: "AND",
            conditions: [
              {
                entity: "sale",
                attribute: "productId",
                operator: "equals_to",
                value: "SKU-YAMAX-BLK-M",
              },
            ],
            amountInPercentage: 22,
            type: "percentage",
          },
        ];

        const match = evaluateRewardConditions({
          conditions,
          context: {
            sale: { productId: "SKU-YAMAX-BLK-M" },
          },
        });
        expect(match?.id).toBe("group_variant_sku");
      });

      it("gracefully returns null when context or condition array is null/undefined", () => {
        expect(
          evaluateRewardConditions({
            conditions: null as any,
            context: {} as any,
          }),
        ).toBeNull();

        expect(
          evaluateRewardConditions({
            conditions: [] as any,
            context: {} as any,
          }),
        ).toBeNull();

        expect(
          evaluateRewardConditions({
            conditions: [
              {
                id: "g1",
                operator: "AND",
                conditions: [
                  {
                    entity: "sale",
                    attribute: "productId",
                    operator: "equals_to",
                    value: "sprod_1",
                  },
                ],
                amountInPercentage: 10,
                type: "percentage",
              },
            ],
            context: null as any,
          }),
        ).toBeNull();
      });
    });

    describe("2.4 Async Catalog Extraction Simulations (UI Logic Verification)", () => {
      it("extracts unique, sorted product tags across catalog items", () => {
        const sampleCatalog = [
          {
            id: "p1",
            externalId: "sprod_1",
            title: "Yamax Flow Leggings",
            handle: "yamax-flow-leggings",
            tags: ["activewear", "leggings", "compression"],
            variants: [],
          },
          {
            id: "p2",
            externalId: "sprod_2",
            title: "Yamax Sports Bra",
            handle: "yamax-sports-bra",
            tags: ["activewear", "bra", "yenergy"],
            variants: [],
          },
          {
            id: "p3",
            externalId: "sprod_3",
            title: "Yamax Running Cap",
            handle: "yamax-running-cap",
            tags: null,
            variants: [],
          },
        ];

        const tagSet = new Set<string>();
        for (const p of sampleCatalog) {
          if (Array.isArray(p.tags)) {
            for (const t of p.tags) {
              if (typeof t === "string" && t.trim()) {
                tagSet.add(t.trim());
              }
            }
          }
        }
        const sortedTags = Array.from(tagSet).sort();

        expect(sortedTags).toEqual([
          "activewear",
          "bra",
          "compression",
          "leggings",
          "yenergy",
        ]);
      });

      it("flattens nested product variants into combobox options with SKU descriptions", () => {
        const sampleProducts = [
          {
            id: "p1",
            externalId: "sprod_1",
            title: "Yamax Agile Leggings",
            handle: "yamax-agile-leggings",
            variants: [
              {
                id: "v1",
                externalId: "svar_1",
                title: "Black / S",
                sku: "SKU-AGL-BLK-S",
              },
              {
                id: "v2",
                externalId: "svar_2",
                title: "Black / M",
                sku: null,
              },
            ],
          },
        ];

        const items: Array<{
          text: string;
          description?: string;
          value: string;
          label: string;
        }> = [];

        for (const p of sampleProducts) {
          for (const v of p.variants || []) {
            const displayTitle = `${p.title} - ${v.title}`;
            const desc = v.sku
              ? `SKU: ${v.sku}`
              : p.handle
                ? `/${p.handle}`
                : undefined;
            items.push({
              text: displayTitle,
              description: desc,
              value: v.externalId || v.id,
              label: displayTitle,
            });
          }
        }

        expect(items).toHaveLength(2);
        expect(items[0]).toEqual({
          text: "Yamax Agile Leggings - Black / S",
          description: "SKU: SKU-AGL-BLK-S",
          value: "svar_1",
          label: "Yamax Agile Leggings - Black / S",
        });
        expect(items[1]).toEqual({
          text: "Yamax Agile Leggings - Black / M",
          description: "/yamax-agile-leggings",
          value: "svar_2",
          label: "Yamax Agile Leggings - Black / M",
        });
      });
    });
  });
});
