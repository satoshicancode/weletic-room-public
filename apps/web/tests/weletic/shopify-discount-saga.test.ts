import { prisma } from "@/lib/prisma";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import {
  createLoyaltyMaintenanceLeaseMetadata,
  createLoyaltyMaintenanceOwnerPermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import {
  assertLoyaltyDiscountLookupMissIsTerminal,
  createLoyaltyDiscountProvisioningIdentity,
  LoyaltyDiscountReconciliationRequiredError,
} from "@/lib/weletic/loyalty/redemption-discount-identity";
import {
  createLoyaltyRedemptionProvisioningSnapshot,
  getShopifyCustomerSelectionDigest,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import { getReferralCouponIdempotencyKey } from "@/lib/weletic/loyalty/referral-coupon";
import {
  compensateDiscountSaga,
  provisionDiscountSaga,
  reconcileGenericProvisioningDiscount,
  sweepStuckSagaRedemptions,
} from "@/lib/weletic/loyalty/saga";
import {
  createBasicDiscount,
  createBxgyDiscount,
  createFreeProductDiscount,
  createFreeShippingDiscount,
  deactivateDiscount,
  deleteDiscount,
  lookupDiscountByCode,
  matchesLoyaltyRewardDiscountConfiguration,
  provisionLoyaltyRewardDiscount,
  resolveShopifyOfflineCredentials,
  shopifyAdminGraphqlRequest,
  ShopifyDiscountError,
  type ShopifyDiscountConfiguration,
} from "@/lib/weletic/loyalty/shopify-discounts";
import {
  WeleticRedemptionStatus,
  WeleticRewardStatus,
  WeleticRewardType,
} from "@prisma/client";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

describe("uncertain Shopify discount reconciliation", () => {
  it("never treats a post-create lookup miss as proof of remote absence", () => {
    expect(() =>
      assertLoyaltyDiscountLookupMissIsTerminal({
        redemptionId: "wredemp_uncertain",
        discountCode: "WL-UNCERTAIN",
        metadata: {
          remoteProvisionAttemptedAt: "2026-08-29T00:00:00.000Z",
          remoteProvisionReconcileUntil: "2026-08-29T00:02:00.000Z",
        },
        now: new Date("2026-08-29T00:10:00.000Z"),
      }),
    ).toThrow(LoyaltyDiscountReconciliationRequiredError);
  });
});

// Mock prisma and dependencies
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    weleticRewardDefinition: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticRewardRedemption: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticPointsLedgerEntry: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    weleticShopifyStore: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    project: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticShopifyAppSession: {
      findFirst: vi.fn(),
    },
    installedIntegration: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (cb) => {
      if (typeof cb === "function") {
        return await cb(prisma);
      }
      return cb;
    }),
  },
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: vi.fn().mockImplementation(async (params) => {
    return {
      id: `wpledger_mock_${Date.now()}`,
      sequenceNumber: 1,
      pointsDelta: params.pointsDelta,
      balanceAfter: BigInt(1000) + BigInt(params.pointsDelta),
      ...params,
    };
  }),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => {
  const enqueueOutboxJob = vi.fn().mockImplementation(async (params) => {
    return {
      id: `woutbox_mock_${Date.now()}`,
      ...params,
    };
  });
  return {
    enqueueOutboxJob,
    enqueueOutboxJobFromProgramTransaction: enqueueOutboxJob,
  };
});

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

// The runtime dependency is a Vitest mock; erase PrismaPromise's production
// call signature so async raw-query fixtures retain their natural Promise type.
const queryRawMock = prisma.$queryRaw as unknown as Mock;

describe("Shopify GraphQL Discount Adapters & 4-Phase Distributed Saga (Milestone 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockReset();
    vi.mocked(prisma.weleticRewardDefinition.findUnique).mockReset();
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockReset();
    vi.mocked(prisma.weleticRewardRedemption.create).mockReset();
    queryRawMock.mockImplementation(async (statement: any) => {
      const sql = statement.strings?.join(" ") || "";
      const tenantId = statement.values?.[0] || "store_test";
      if (sql.includes("FROM WeleticShopifyStore")) {
        return [{ id: tenantId, complianceState: "active" }] as never;
      }
      if (sql.includes("FROM WeleticLoyaltyProgram")) {
        return [
          {
            id: `program_${tenantId}`,
            storeId: tenantId,
            status: "active",
            killSwitchActive: false,
          },
        ] as never;
      }
      throw new Error(`Unexpected raw-query fixture: ${sql}`);
    });
    delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    vi.stubEnv("SHOPIFY_APP_URL", "");
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
      complianceState: "active",
    } as any);
    vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockImplementation(
      (async ({ where }: any) => ({
        id: where.id,
        storeId: where.storeId,
        status: "active",
        metadata: null,
        shopper: { shopifyCustomerId: `customer_${where.id}` },
        store: { projectId: `workspace_${where.storeId}` },
      })) as any,
    );
    vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockImplementation(
      (async ({ where }: any) => ({
        id: where.id,
        storeId: where.storeId,
        qualifyingOrderId: where.qualifyingOrderId,
        status: "qualified",
        metadata: {},
      })) as any,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe("1. Offline Token Resolution (resolveShopifyOfflineCredentials)", () => {
    it("uses SHOPIFY_ADMIN_ACCESS_TOKEN when environment variable is present", async () => {
      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat_env_token_override";
      const creds = await resolveShopifyOfflineCredentials({
        shopDomain: "mystore.myshopify.com",
      });

      expect(creds.accessToken).toBe("shpat_env_token_override");
      expect(creds.shopDomain).toBe("mystore.myshopify.com");
      expect(creds.source).toBe("env_override");
    });

    it("uses the tenant-scoped Shopify app token authority in production", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("SHOPIFY_APP_URL", "https://shopify.weletic.com");
      vi.stubEnv(
        "WELETIC_SHOPIFY_SERVICE_SECRET",
        "test-shopify-service-secret-with-32-characters",
      );
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_authority",
        shopDomain: "authority.myshopify.com",
        projectId: "workspace_authority",
      } as any);
      const authorityFetch = vi.fn().mockResolvedValue(
        Response.json({
          shop: "authority.myshopify.com",
          accessToken: "fresh-authority-token",
          scope: "read_discounts,write_discounts",
          expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
        }),
      );

      const creds = await resolveShopifyOfflineCredentials({
        storeId: "store_authority",
        tokenAuthorityFetch: authorityFetch as typeof fetch,
      });

      expect(creds).toMatchObject({
        shopDomain: "authority.myshopify.com",
        accessToken: "fresh-authority-token",
        scope: "read_discounts,write_discounts",
        source: "token_authority",
      });
      expect(prisma.weleticShopifyAppSession.findFirst).not.toHaveBeenCalled();
      expect(prisma.installedIntegration.findFirst).not.toHaveBeenCalled();
    });

    it.each([
      { body: {}, code: "NETWORK_ERROR" },
      { body: { code: "SESSION_MISSING" }, code: "AUTH_EXPIRED" },
    ])(
      "does not fall back to stale credentials after an authority $code",
      async ({ body, code }) => {
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("SHOPIFY_APP_URL", "https://shopify.weletic.com");
        vi.stubEnv(
          "WELETIC_SHOPIFY_SERVICE_SECRET",
          "test-shopify-service-secret-with-32-characters",
        );
        vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
          id: "store_authority_missing",
          shopDomain: "authority-missing.myshopify.com",
          projectId: "workspace_authority_missing",
        } as any);

        await expect(
          resolveShopifyOfflineCredentials({
            storeId: "store_authority_missing",
            tokenAuthorityFetch: vi
              .fn()
              .mockResolvedValue(
                Response.json(body, { status: 404 }),
              ) as typeof fetch,
          }),
        ).rejects.toMatchObject({ code });
        expect(
          prisma.weleticShopifyAppSession.findFirst,
        ).not.toHaveBeenCalled();
        expect(prisma.installedIntegration.findFirst).not.toHaveBeenCalled();
      },
    );

    it("throws AUTH_EXPIRED when no offline token is found", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_123",
        shopDomain: "yamaxdev.myshopify.com",
        projectId: "proj_123",
      } as any);
      vi.mocked(
        prisma.weleticShopifyAppSession.findFirst,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce(
        null,
      );

      await expect(
        resolveShopifyOfflineCredentials({ storeId: "store_123" }),
      ).rejects.toThrowError(ShopifyDiscountError);
    });

    it("resolves a store ID only through its exact unique tenant key", async () => {
      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "offline_exact";
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_exact",
        shopDomain: "exact.myshopify.com",
        projectId: "workspace_exact",
      } as any);

      const creds = await resolveShopifyOfflineCredentials({
        storeId: "store_exact",
      });

      expect(prisma.weleticShopifyStore.findUnique).toHaveBeenCalledWith({
        where: { id: "store_exact" },
        select: {
          id: true,
          shopDomain: true,
          projectId: true,
          installationGeneration: true,
        },
      });
      expect(prisma.weleticShopifyStore.findFirst).not.toHaveBeenCalled();
      expect(creds.shopDomain).toBe("exact.myshopify.com");
    });

    it("rejects a caller-supplied domain that does not match the exact store", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_exact",
        shopDomain: "exact.myshopify.com",
        projectId: "workspace_exact",
      } as any);

      await expect(
        resolveShopifyOfflineCredentials({
          storeId: "store_exact",
          shopDomain: "other.myshopify.com",
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("fails closed when legacy integration credentials are not bound to a shop", async () => {
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        id: "store_legacy_unbound",
        shopDomain: "legacy-unbound.myshopify.com",
        projectId: "workspace_legacy_unbound",
      } as any);
      vi.mocked(
        prisma.weleticShopifyAppSession.findFirst,
      ).mockResolvedValueOnce(null);
      vi.mocked(prisma.installedIntegration.findFirst).mockResolvedValueOnce({
        credentials: {
          accessToken: "shpat_unbound_token",
          scope: "write_discounts",
        },
      } as any);

      await expect(
        resolveShopifyOfflineCredentials({
          storeId: "store_legacy_unbound",
          customFetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              data: {
                shop: { myshopifyDomain: "other-store.myshopify.com" },
              },
            }),
          }) as any,
        }),
      ).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    });

    it("never uses a global environment token as a production tenant credential", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("SHOPIFY_ADMIN_ACCESS_TOKEN", "unsafe_global_token");
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce(
        null,
      );

      await expect(
        resolveShopifyOfflineCredentials({ storeId: "missing_store" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("ignores caller-supplied credentials in production provisioning", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("SHOPIFY_APP_URL", "https://shopify.weletic.com");
      vi.stubEnv(
        "WELETIC_SHOPIFY_SERVICE_SECRET",
        "test-shopify-service-secret-with-32-characters",
      );
      vi.mocked(prisma.weleticShopifyStore.findUnique)
        .mockResolvedValueOnce({
          id: "store_authority",
          shopDomain: "authority.myshopify.com",
          projectId: "workspace_authority",
        } as any)
        .mockResolvedValueOnce({ shopCurrency: "USD" } as any);
      const authorityFetch = vi.fn().mockResolvedValue(
        Response.json({
          shop: "authority.myshopify.com",
          accessToken: "fresh-authority-token",
          scope: "write_discounts",
          expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
        }),
      );
      vi.stubGlobal("fetch", authorityFetch);
      const shopifyFetch = vi.fn().mockResolvedValue(
        Response.json({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/authority",
                codeDiscount: {
                  title: "Authority discount",
                  status: "ACTIVE",
                  codes: { nodes: [{ code: "AUTHORITY10" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      );

      await provisionLoyaltyRewardDiscount({
        storeId: "store_authority",
        shopDomain: "attacker.myshopify.com",
        accessToken: "stale-or-cross-tenant-token",
        rewardDefinition: {
          id: "reward_authority",
          name: "Authority discount",
          rewardType: "amount_off",
          discountValue: 1000,
        },
        discountCode: "AUTHORITY10",
        customFetch: shopifyFetch as typeof fetch,
      });

      expect(authorityFetch).toHaveBeenCalledOnce();
      expect(String(shopifyFetch.mock.calls[0][0])).toContain(
        "authority.myshopify.com",
      );
      expect(shopifyFetch.mock.calls[0][1].headers).toMatchObject({
        "X-Shopify-Access-Token": "fresh-authority-token",
      });
    });
  });

  describe("2. Shopify GraphQL Discount Adapters (API 2026-07)", () => {
    it("creates fixed amount discount via discountCodeBasicCreate mutation", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/11223344",
                codeDiscount: {
                  title: "$10 Off Voucher (WL-TEST10)",
                  status: "ACTIVE",
                  codes: { nodes: [{ id: "code_1", code: "WL-TEST10" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      const result = await createBasicDiscount({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        code: "WL-TEST10",
        title: "$10 Off Voucher (WL-TEST10)",
        valueType: "fixed_amount",
        value: 10.0,
        minimumRequirement: { quantity: 2 },
        customFetch: mockFetch as any,
      });

      expect(result.id).toBe("gid://shopify/DiscountCodeNode/11223344");
      expect(result.code).toBe("WL-TEST10");
      expect(result.status).toBe("ACTIVE");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.query).toContain("discountCodeBasicCreate");
      expect(
        requestBody.variables.basicCodeDiscount.customerGets.value
          .discountAmount.amount,
      ).toBe("10.00");
      expect(
        requestBody.variables.basicCodeDiscount.minimumRequirement.quantity
          .greaterThanOrEqualToQuantity,
      ).toBe("2");
      expect(
        requestBody.variables.basicCodeDiscount.customerGets,
      ).not.toHaveProperty("appliesOnOneTimePurchase");
      expect(
        requestBody.variables.basicCodeDiscount.customerGets,
      ).not.toHaveProperty("appliesOnSubscription");
    });

    it("writes exact first-N subscription eligibility into native discounts", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/subscription",
                codeDiscount: {
                  title: "Subscription reward",
                  status: "ACTIVE",
                  codes: { nodes: [{ code: "WL-SUB" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });
      await createBasicDiscount({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        code: "WL-SUB",
        title: "Subscription reward",
        valueType: "fixed_amount",
        value: 10,
        appliesOnOneTimePurchase: false,
        appliesOnSubscription: true,
        recurringCycleLimit: 3,
        customFetch: mockFetch as any,
      });
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.variables.basicCodeDiscount).toMatchObject({
        recurringCycleLimit: 3,
        customerGets: {
          appliesOnOneTimePurchase: false,
          appliesOnSubscription: true,
        },
      });
    });

    it.each([
      {
        name: "top-level errors even when partial data contains a node",
        envelope: {
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/ambiguous-partial",
                codeDiscount: {
                  title: "Ambiguous partial",
                  status: "ACTIVE",
                  codes: { nodes: [{ code: "WL-AMBIGUOUS" }] },
                },
              },
              userErrors: [],
            },
          },
          errors: [{ message: "Mutation response could not be completed" }],
        },
      },
      {
        name: "payload user errors after dispatch",
        envelope: {
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: null,
              userErrors: [
                { message: "Mutation payload failed", code: "INVALID" },
              ],
            },
          },
        },
      },
      {
        name: "a missing mutation node",
        envelope: {
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: null,
              userErrors: [],
            },
          },
        },
      },
    ])(
      "classifies $name as an uncertain remote create",
      async ({ envelope }) => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => envelope,
        });

        await expect(
          createBasicDiscount({
            shopDomain: "store.myshopify.com",
            accessToken: "shpat_test_token",
            code: "WL-AMBIGUOUS",
            title: "Ambiguous partial",
            valueType: "fixed_amount",
            value: 10,
            customFetch: mockFetch as any,
          }),
        ).rejects.toMatchObject({ code: "REMOTE_OUTCOME_UNKNOWN" });
      },
    );

    it("targets products and variants in a capped native Basic discount", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/free-item-cap",
                codeDiscount: {
                  title: "Free item up to $50",
                  status: "ACTIVE",
                  codes: {
                    nodes: [{ id: "code_cap", code: "WL-FREE-CAP" }],
                  },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      await createBasicDiscount({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        code: "WL-FREE-CAP",
        title: "Free item up to $50",
        valueType: "fixed_amount",
        value: "50",
        productGids: ["12345", "gid://shopify/Product/12345"],
        variantGids: ["67890", "gid://shopify/ProductVariant/67890"],
        customFetch: mockFetch as any,
      });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(
        requestBody.variables.basicCodeDiscount.customerGets.items,
      ).toEqual({
        products: {
          productsToAdd: ["gid://shopify/Product/12345"],
          productVariantsToAdd: ["gid://shopify/ProductVariant/67890"],
        },
      });
      expect(
        requestBody.variables.basicCodeDiscount.customerGets.value,
      ).toEqual({
        discountAmount: { amount: "50", appliesOnEachItem: false },
      });
    });

    it("creates percentage off discount via discountCodeBasicCreate mutation", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/55667788",
                codeDiscount: {
                  title: "20% Off Voucher (WL-20OFF)",
                  status: "ACTIVE",
                  codes: { nodes: [{ id: "code_2", code: "WL-20OFF" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      const result = await createBasicDiscount({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        code: "WL-20OFF",
        title: "20% Off Voucher (WL-20OFF)",
        valueType: "percentage",
        value: 20,
        customFetch: mockFetch as any,
      });

      expect(result.id).toBe("gid://shopify/DiscountCodeNode/55667788");
      expect(result.code).toBe("WL-20OFF");

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(
        requestBody.variables.basicCodeDiscount.customerGets.value.percentage,
      ).toBe(0.2);
    });

    it("normalizes 1% exactly and rejects percentage values outside 1-100", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/one-percent",
                codeDiscount: {
                  title: "One Percent",
                  status: "ACTIVE",
                  codes: { nodes: [{ id: "code_1pct", code: "WL-1PCT" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      await createBasicDiscount({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        code: "WL-1PCT",
        title: "One Percent",
        valueType: "percentage",
        value: 1,
        customFetch: mockFetch as any,
      });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(
        requestBody.variables.basicCodeDiscount.customerGets.value.percentage,
      ).toBe(0.01);

      for (const value of [0, 0.99, 100.01]) {
        await expect(
          createBasicDiscount({
            shopDomain: "store.myshopify.com",
            accessToken: "shpat_test_token",
            code: "WL-INVALID-PCT",
            title: "Invalid Percentage",
            valueType: "percentage",
            value,
            customFetch: vi.fn() as any,
          }),
        ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      }
    });

    it("uses one canonical percentage fraction for creation and recovery matching", async () => {
      const startsAt = new Date("2026-08-29T00:00:00.556Z");
      const expiresAt = new Date("2026-09-05T00:00:00.556Z");
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/canonical-percentage",
                codeDiscount: {
                  title: "Canonical Percentage",
                  status: "ACTIVE",
                  codes: { nodes: [{ code: "WL-CANONICAL-PCT" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      await createBasicDiscount({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        code: "WL-CANONICAL-PCT",
        title: "Canonical Percentage",
        valueType: "percentage",
        value: "33.333",
        startsAt,
        customFetch: mockFetch as any,
      });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(
        requestBody.variables.basicCodeDiscount.customerGets.value.percentage,
      ).toBe(0.3333);

      const remote = {
        id: "gid://shopify/DiscountCodeNode/canonical-percentage",
        code: "WL-CANONICAL-PCT",
        title: "Canonical Percentage",
        status: "ACTIVE",
        configuration: {
          kind: "basic" as const,
          startsAt: "2026-08-29T00:00:00Z",
          endsAt: "2026-09-05T00:00:00Z",
          usageLimit: 1,
          appliesOncePerCustomer: true,
          appliesOnOneTimePurchase: true,
          appliesOnSubscription: false,
          recurringCycleLimit: 1,
          combinesWith: {
            orderDiscounts: false,
            productDiscounts: false,
            shippingDiscounts: false,
          },
          customerSelection: { kind: "all" as const },
          minimumRequirement: null,
          basicValue: { kind: "percentage" as const, percentage: 0.3333 },
          basicItems: { kind: "all" as const },
        },
      };
      const rewardDefinition = {
        id: "reward_percentage",
        name: "Canonical Percentage",
        rewardType: "percentage_off",
        discountValue: "33.333",
        appliesToResource: "entire_order",
        usageLimit: 1,
        usageLimitPerCustomer: 1,
      };
      const matches = (
        configuration: ShopifyDiscountConfiguration = remote.configuration,
      ) =>
        matchesLoyaltyRewardDiscountConfiguration({
          remote: { ...remote, configuration },
          rewardDefinition,
          startsAt,
          expiresAt,
          expectedShopCurrency: "USD",
        });

      expect(matches()).toBe(true);
      expect(
        matches({
          ...remote.configuration,
          startsAt: "2026-08-29T00:00:00.123Z",
        }),
      ).toBe(false);
      expect(
        matches({
          ...remote.configuration,
          startsAt: "2026-08-29T00:00:01Z",
        }),
      ).toBe(false);
      expect(
        matches({
          ...remote.configuration,
          endsAt: "2026-09-05T00:00:01Z",
        }),
      ).toBe(false);
      expect(
        matches({ ...remote.configuration, appliesOnOneTimePurchase: false }),
      ).toBe(false);
      expect(
        matches({ ...remote.configuration, appliesOnSubscription: true }),
      ).toBe(false);
      expect(
        matches({ ...remote.configuration, recurringCycleLimit: null }),
      ).toBe(false);
      expect(matches({ ...remote.configuration, recurringCycleLimit: 2 })).toBe(
        false,
      );
    });

    it("matches Shopify item scopes after canonicalizing duplicate entitlement IDs", () => {
      const startsAt = new Date("2026-08-29T00:00:00.000Z");
      expect(
        matchesLoyaltyRewardDiscountConfiguration({
          remote: {
            id: "gid://shopify/DiscountCodeNode/duplicate-entitlements",
            code: "WL-DUPLICATE-SCOPE",
            title: "Duplicate scope",
            status: "ACTIVE",
            configuration: {
              kind: "basic",
              startsAt: startsAt.toISOString(),
              endsAt: null,
              usageLimit: 1,
              appliesOncePerCustomer: true,
              appliesOnOneTimePurchase: true,
              appliesOnSubscription: false,
              recurringCycleLimit: 1,
              combinesWith: {
                orderDiscounts: false,
                productDiscounts: false,
                shippingDiscounts: false,
              },
              customerSelection: { kind: "all" },
              minimumRequirement: null,
              basicValue: { kind: "percentage", percentage: 0.2 },
              basicItems: {
                kind: "products",
                productIds: ["gid://shopify/Product/12345"],
                variantIds: ["gid://shopify/ProductVariant/67890"],
                truncated: false,
              },
            },
          },
          rewardDefinition: {
            id: "reward_duplicate_scope",
            name: "Duplicate scope",
            rewardType: "percentage_off",
            discountValue: "20",
            appliesToResource: "specific_products",
            entitledProductIds: ["12345", "12345"],
            entitledVariantIds: ["67890", "67890"],
            entitledCollectionIds: [],
            usageLimit: 1,
            usageLimitPerCustomer: 1,
          },
          startsAt,
          expiresAt: null,
          expectedShopCurrency: "USD",
        }),
      ).toBe(true);
    });

    it("creates Free Shipping discount via discountCodeFreeShippingCreate mutation", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeFreeShippingCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/99001122",
                codeDiscount: {
                  title: "Free Shipping Voucher (WL-SHIPFREE)",
                  status: "ACTIVE",
                  codes: { nodes: [{ id: "code_3", code: "WL-SHIPFREE" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      const result = await createFreeShippingDiscount({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        code: "WL-SHIPFREE",
        title: "Free Shipping Voucher (WL-SHIPFREE)",
        destinationCountries: ["US", "CA"],
        maximumShippingPrice: 15.0,
        customFetch: mockFetch as any,
      });

      expect(result.id).toBe("gid://shopify/DiscountCodeNode/99001122");
      expect(result.code).toBe("WL-SHIPFREE");

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.query).toContain("discountCodeFreeShippingCreate");
      expect(
        requestBody.variables.freeShippingCodeDiscount.destination.countries
          .add,
      ).toEqual(["US", "CA"]);
      expect(
        requestBody.variables.freeShippingCodeDiscount.destination.countries
          .includeRestOfWorld,
      ).toBe(false);
      expect(requestBody.variables.freeShippingCodeDiscount).not.toHaveProperty(
        "appliesOnOneTimePurchase",
      );
      expect(requestBody.variables.freeShippingCodeDiscount).not.toHaveProperty(
        "appliesOnSubscription",
      );
      expect(
        requestBody.variables.freeShippingCodeDiscount.maximumShippingPrice,
      ).toBe("15.00");
    });

    it("creates Buy X Get Y (BXGY) Free Gift discount via discountCodeBxgyCreate mutation", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBxgyCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/33445566",
                codeDiscount: {
                  title: "Free Gift Product (WL-FREEGIFT)",
                  status: "ACTIVE",
                  codes: { nodes: [{ id: "code_4", code: "WL-FREEGIFT" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      const result = await createBxgyDiscount({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        code: "WL-FREEGIFT",
        title: "Free Gift Product (WL-FREEGIFT)",
        buyQuantity: 1,
        buyProductGids: ["gid://shopify/Product/12345"],
        getQuantity: 1,
        getProductGids: ["gid://shopify/Product/12345"],
        discountEffectType: "percentage",
        discountEffectValue: 100,
        customFetch: mockFetch as any,
      });

      expect(result.id).toBe("gid://shopify/DiscountCodeNode/33445566");
      expect(result.code).toBe("WL-FREEGIFT");

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.query).toContain("discountCodeBxgyCreate");
      expect(
        requestBody.variables.bxgyCodeDiscount.customerBuys.value.quantity,
      ).toBe("1");
      expect(
        requestBody.variables.bxgyCodeDiscount.customerGets.value
          .discountOnQuantity.quantity,
      ).toBe("1");
    });

    it("preserves three-decimal fixed-amount BXGY effects", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBxgyCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/33445567",
                codeDiscount: {
                  title: "KWD 5.001 BXGY (WL-BXGY-KWD)",
                  status: "ACTIVE",
                  codes: {
                    nodes: [{ id: "code_5", code: "WL-BXGY-KWD" }],
                  },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      await createBxgyDiscount({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        code: "WL-BXGY-KWD",
        title: "KWD 5.001 BXGY (WL-BXGY-KWD)",
        buyProductGids: ["gid://shopify/Product/12345"],
        getProductGids: ["gid://shopify/Product/12345"],
        discountEffectType: "fixed_amount",
        discountEffectValue: 5.001,
        customFetch: mockFetch as any,
      });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(
        requestBody.variables.bxgyCodeDiscount.customerGets.value
          .discountOnQuantity.effect,
      ).toEqual({ amount: "5.001" });
      expect(requestBody.variables.bxgyCodeDiscount.customerBuys.items).toEqual(
        {
          products: { productsToAdd: ["gid://shopify/Product/12345"] },
        },
      );
      expect(requestBody.variables.bxgyCodeDiscount.customerGets.items).toEqual(
        {
          products: { productsToAdd: ["gid://shopify/Product/12345"] },
        },
      );
    });

    it("rejects BXGY scopes that mix products and collections", async () => {
      const mockFetch = vi.fn();

      await expect(
        createBxgyDiscount({
          shopDomain: "store.myshopify.com",
          accessToken: "shpat_test_token",
          code: "WL-MIXED-BXGY",
          title: "Mixed BXGY",
          buyProductGids: ["gid://shopify/Product/12345"],
          buyCollectionGids: ["gid://shopify/Collection/456"],
          getProductGids: ["gid://shopify/Product/12345"],
          discountEffectType: "percentage",
          discountEffectValue: 100,
          customFetch: mockFetch as any,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("normalizes a 1% BXGY effect to Shopify's 0.01 fraction", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBxgyCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/bxgy-one-percent",
                codeDiscount: {
                  title: "One Percent BXGY",
                  status: "ACTIVE",
                  codes: { nodes: [{ id: "code_bxgy_1", code: "BXGY-1" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      await createBxgyDiscount({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        code: "BXGY-1",
        title: "One Percent BXGY",
        buyProductGids: ["gid://shopify/Product/12345"],
        getProductGids: ["gid://shopify/Product/12345"],
        discountEffectType: "percentage",
        discountEffectValue: 1,
        customFetch: mockFetch as any,
      });

      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(
        requestBody.variables.bxgyCodeDiscount.customerGets.value
          .discountOnQuantity.effect,
      ).toEqual({ percentage: 0.01 });
    });

    it("rejects BXGY discounts without buy and reward item scopes", async () => {
      const mockFetch = vi.fn();

      await expect(
        createBxgyDiscount({
          shopDomain: "store.myshopify.com",
          accessToken: "shpat_test_token",
          code: "WL-INVALID-BXGY",
          title: "Invalid BXGY",
          buyQuantity: 1,
          getQuantity: 1,
          discountEffectType: "percentage",
          discountEffectValue: 100,
          customFetch: mockFetch as any,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("rejects BXGY percentage effects below one percent", async () => {
      const mockFetch = vi.fn();

      await expect(
        createBxgyDiscount({
          shopDomain: "store.myshopify.com",
          accessToken: "shpat_test_token",
          code: "WL-BXGY-SUB-ONE",
          title: "Invalid Sub-One BXGY",
          buyProductGids: ["gid://shopify/Product/12345"],
          getProductGids: ["gid://shopify/Product/12345"],
          discountEffectType: "percentage",
          discountEffectValue: 0.99,
          customFetch: mockFetch as any,
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("creates a customer-scoped free-product app discount with versioned function config", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeAppCreate: {
              codeAppDiscount: {
                discountId: "gid://shopify/DiscountCodeNode/12345",
                title: "Free Socks",
                status: "ACTIVE",
                codes: { nodes: [{ code: "WL-FREE-SOCKS" }] },
              },
              userErrors: [],
            },
          },
        }),
      });

      const result = await createFreeProductDiscount({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        code: "wl-free-socks",
        title: "Free Socks",
        productGids: ["12345"],
        variantGids: ["gid://shopify/ProductVariant/67890"],
        quantity: 1,
        minimumSubtotal: "20.00",
        customerSelection: { customerIds: ["100"] },
        customFetch: mockFetch as any,
      });

      expect(result).toMatchObject({
        id: "gid://shopify/DiscountCodeNode/12345",
        code: "WL-FREE-SOCKS",
      });
      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      const input = requestBody.variables.codeAppDiscount;
      expect(input.functionHandle).toBe("weletic-free-product");
      expect(input.discountClasses).toEqual(["PRODUCT"]);
      expect(input.context).toEqual({
        customers: { add: ["gid://shopify/Customer/100"] },
      });
      expect(JSON.parse(input.metafields[0].value)).toEqual({
        version: 1,
        productIds: ["gid://shopify/Product/12345"],
        variantIds: ["gid://shopify/ProductVariant/67890"],
        quantity: 1,
        message: "Free Socks",
        minimumSubtotal: "20.00",
      });
    });

    it("converts loyalty money from minor units using the store currency", async () => {
      const successResponse = (code: string) => ({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: `gid://shopify/DiscountCodeNode/${code}`,
                codeDiscount: {
                  title: code,
                  status: "ACTIVE",
                  codes: { nodes: [{ id: `id_${code}`, code }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      const usdFetch = vi.fn().mockResolvedValueOnce(successResponse("USD5"));
      await provisionLoyaltyRewardDiscount({
        storeId: "store_usd",
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        rewardDefinition: {
          id: "reward_usd",
          name: "$5 Off",
          rewardType: "amount_off",
          discountValue: 500,
          minOrderAmount: 2000,
        },
        discountCode: "USD5",
        customFetch: usdFetch as any,
      });
      const usdBody = JSON.parse(usdFetch.mock.calls[0][1].body);
      expect(
        usdBody.variables.basicCodeDiscount.customerGets.value.discountAmount
          .amount,
      ).toBe("5.00");
      expect(
        usdBody.variables.basicCodeDiscount.minimumRequirement.subtotal
          .greaterThanOrEqualToSubtotal,
      ).toBe("20.00");

      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        shopCurrency: "JPY",
      } as any);
      const jpyFetch = vi.fn().mockResolvedValueOnce(successResponse("JPY500"));
      await provisionLoyaltyRewardDiscount({
        storeId: "store_jpy",
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        rewardDefinition: {
          id: "reward_jpy",
          name: "¥500 Off",
          rewardType: "amount_off",
          discountValue: 500,
          minOrderAmount: 2000,
        },
        discountCode: "JPY500",
        customFetch: jpyFetch as any,
      });
      const jpyBody = JSON.parse(jpyFetch.mock.calls[0][1].body);
      expect(
        jpyBody.variables.basicCodeDiscount.customerGets.value.discountAmount
          .amount,
      ).toBe("500");
      expect(
        jpyBody.variables.basicCodeDiscount.minimumRequirement.subtotal
          .greaterThanOrEqualToSubtotal,
      ).toBe("2000");

      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
        shopCurrency: "KWD",
      } as any);
      const kwdFetch = vi
        .fn()
        .mockResolvedValueOnce(successResponse("KWD-FIVE"));
      await provisionLoyaltyRewardDiscount({
        storeId: "store_kwd",
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        rewardDefinition: {
          id: "reward_kwd",
          name: "KWD 5.001 Off",
          rewardType: "amount_off",
          discountValue: 5001,
          minOrderAmount: 20001,
        },
        discountCode: "KWD-FIVE",
        customFetch: kwdFetch as any,
      });
      const kwdBody = JSON.parse(kwdFetch.mock.calls[0][1].body);
      expect(
        kwdBody.variables.basicCodeDiscount.customerGets.value.discountAmount
          .amount,
      ).toBe("5.001");
      expect(
        kwdBody.variables.basicCodeDiscount.minimumRequirement.subtotal
          .greaterThanOrEqualToSubtotal,
      ).toBe("20.001");
    });

    it("keeps a variant-only loyalty reward scoped to that Shopify variant", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/variant-only",
                codeDiscount: {
                  title: "Variant reward",
                  status: "ACTIVE",
                  codes: { nodes: [{ id: "c1", code: "VARIANT10" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      await provisionLoyaltyRewardDiscount({
        storeId: "store_variant_only",
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        rewardDefinition: {
          id: "reward_variant_only",
          name: "Variant reward",
          rewardType: "percentage_off",
          discountValue: 10,
          appliesToResource: "specific_products",
          entitledProductIds: [],
          entitledVariantIds: ["gid://shopify/ProductVariant/67890"],
          entitledCollectionIds: [],
        },
        discountCode: "VARIANT10",
        customFetch: mockFetch as any,
      });

      const input = JSON.parse(mockFetch.mock.calls[0][1].body).variables
        .basicCodeDiscount;
      expect(input.customerGets.items).toEqual({
        products: {
          productVariantsToAdd: ["gid://shopify/ProductVariant/67890"],
        },
      });
      expect(input.customerGets.items).not.toHaveProperty("all");
    });

    it("rejects native voucher limits above once per customer", async () => {
      const mockFetch = vi.fn();

      await expect(
        provisionLoyaltyRewardDiscount({
          storeId: "store_invalid_customer_limit",
          shopDomain: "store.myshopify.com",
          accessToken: "shpat_test_token",
          rewardDefinition: {
            id: "reward_invalid_customer_limit",
            name: "Invalid customer limit",
            rewardType: "amount_off",
            discountValue: 500,
            usageLimitPerCustomer: 2,
          },
          discountCode: "INVALID-LIMIT",
          customFetch: mockFetch as any,
        }),
      ).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message:
          "Shopify native discounts support only unlimited or once-per-customer usage.",
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fails closed when free-product scope is missing at provisioning time", async () => {
      await expect(
        provisionLoyaltyRewardDiscount({
          storeId: "store_corrupt_reward",
          shopDomain: "store.myshopify.com",
          accessToken: "shpat_test_token",
          rewardDefinition: {
            id: "reward_corrupt",
            name: "Corrupt Free Product",
            rewardType: "free_product",
            maxDiscountValue: 5000,
            entitledProductIds: [],
            entitledVariantIds: [],
          },
          discountCode: "CORRUPT-FREE",
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    });

    it("looks up discount node by code via codeDiscountNodeByCode query", async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            codeDiscountNodeByCode: {
              id: "gid://shopify/DiscountCodeNode/77889900",
              codeDiscount: {
                title: "Existing Promo (PROMO10)",
                status: "ACTIVE",
                codes: { nodes: [{ id: "c1", code: "PROMO10" }] },
              },
            },
          },
        }),
      });

      const result = await lookupDiscountByCode(
        "store.myshopify.com",
        "shpat_token",
        "PROMO10",
        mockFetch as any,
      );

      expect(result).not.toBeNull();
      expect(result?.id).toBe("gid://shopify/DiscountCodeNode/77889900");
      expect(result?.code).toBe("PROMO10");
    });

    it("bounds the total duration of an in-flight Shopify GraphQL request", async () => {
      const hangingFetch = vi.fn(
        async (_url: string, init: RequestInit | undefined) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () =>
                reject(
                  Object.assign(new Error("aborted"), { name: "AbortError" }),
                ),
              { once: true },
            );
          }),
      );

      await expect(
        shopifyAdminGraphqlRequest({
          shopDomain: "store.myshopify.com",
          accessToken: "shpat_token",
          query: "query Ping { shop { id } }",
          customFetch: hangingFetch as any,
          maxRetries: 0,
          requestTimeoutMs: 25,
        }),
      ).rejects.toMatchObject({
        code: "NETWORK_ERROR",
        message: "Shopify Admin GraphQL request timed out after 25ms.",
      });
      expect(hangingFetch).toHaveBeenCalledTimes(1);
      expect(hangingFetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it("treats a verified missing discount as idempotent deactivation success", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              discountCodeDeactivate: {
                codeDiscountNode: null,
                userErrors: [{ message: "Discount is already gone" }],
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ data: { codeDiscountNode: null } }),
        });

      await expect(
        deactivateDiscount(
          "store.myshopify.com",
          "shpat_token",
          "111",
          mockFetch as any,
        ),
      ).resolves.toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(JSON.parse(mockFetch.mock.calls[1][1].body).query).toContain(
        "CodeDiscountNodeStatus",
      );
    });

    it("treats a verified inactive discount as idempotent deactivation success", async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              discountCodeDeactivate: {
                codeDiscountNode: null,
                userErrors: [{ message: "Discount cannot be deactivated" }],
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/111",
                codeDiscount: { status: "EXPIRED" },
              },
            },
          }),
        });

      await expect(
        deactivateDiscount(
          "store.myshopify.com",
          "shpat_token",
          "111",
          mockFetch as any,
        ),
      ).resolves.toBe(true);
    });

    it("deactivates and deletes discounts via GraphQL mutations", async () => {
      const mockFetchDeactivate = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeDeactivate: {
              codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/111" },
              userErrors: [],
            },
          },
        }),
      });

      const deactResult = await deactivateDiscount(
        "store.myshopify.com",
        "shpat_token",
        "111",
        mockFetchDeactivate as any,
      );
      expect(deactResult).toBe(true);

      const mockFetchDelete = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeDelete: {
              deletedCodeDiscountId: "gid://shopify/DiscountCodeNode/111",
              userErrors: [],
            },
          },
        }),
      });

      const delResult = await deleteDiscount(
        "store.myshopify.com",
        "shpat_token",
        "111",
        mockFetchDelete as any,
      );
      expect(delResult).toBe(true);
    });
  });

  describe("3. 4-Phase Distributed Discount Provisioning Saga (provisionDiscountSaga)", () => {
    it("provisions free-product rewards through the full reservation saga", async () => {
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: "account_free_product",
        storeId: "store_free_product",
        cachedPointsBalance: BigInt(500),
        status: "active",
        program: { id: "prog_1", status: "active", killSwitchActive: false },
        shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
      } as any);
      vi.mocked(
        prisma.weleticRewardDefinition.findUnique,
      ).mockResolvedValueOnce({
        id: "reward_free_product",
        storeId: "store_free_product",
        name: "Free Socks",
        rewardType: WeleticRewardType.free_product,
        pointsCost: BigInt(100),
        maxDiscountValue: 5000,
        status: WeleticRewardStatus.active,
        entitledProductIds: ["gid://shopify/Product/12345"],
        entitledVariantIds: [],
      } as any);
      vi.mocked(prisma.weleticRewardRedemption.create).mockResolvedValueOnce({
        id: "wredemp_free_product",
        storeId: "store_free_product",
        accountId: "account_free_product",
        rewardDefinitionId: "reward_free_product",
        pointsSpent: BigInt(100),
        shopifyDiscountCode: "WL-FREE-SOCKS",
        status: WeleticRedemptionStatus.provisioning,
      } as any);
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/free-product",
                codeDiscount: {
                  title: "Free Socks (WL-FREE-SOCKS)",
                  status: "ACTIVE",
                  codes: {
                    nodes: [{ id: "code-free-product", code: "WL-FREE-SOCKS" }],
                  },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      const result = await provisionDiscountSaga({
        storeId: "store_free_product",
        accountId: "account_free_product",
        rewardDefinitionId: "reward_free_product",
        discountCode: "WL-FREE-SOCKS",
        idempotencyKey: "saga-free-product-1",
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        customFetch: mockFetch as any,
      });

      expect(result.success).toBe(true);
      expect(result.shopifyDiscountId).toBe(
        "gid://shopify/DiscountCodeNode/free-product",
      );
      const requestBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(requestBody.query).toContain("discountCodeBasicCreate");
      expect(requestBody.query).not.toContain("discountCodeAppCreate");
      expect(requestBody.variables.basicCodeDiscount.customerGets).toEqual({
        value: {
          discountAmount: { amount: "50.00", appliesOnEachItem: false },
        },
        items: {
          products: {
            productsToAdd: ["gid://shopify/Product/12345"],
          },
        },
      });
      expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({ pointsDelta: BigInt(-100) }),
      );
    });

    it("lets the maintenance owner reserve, provision, and finalize a redemption", async () => {
      const storeId = "store_test_saga";
      const accountId = "acc_test_saga";
      const rewardDefinitionId = "reward_def_10off";
      const maintenanceMetadata = createLoyaltyMaintenanceLeaseMetadata({
        existingMetadata: null,
        ownerToken: "o".repeat(64),
        runMarker: "a1-owner-redemption-lifecycle",
        fixtureEmails: ["a1-owner@example.test"],
        acquiredAt: new Date("2026-08-30T00:00:00.000Z"),
        recoveryAfter: new Date("2026-08-30T01:00:00.000Z"),
      });
      const loyaltyMaintenancePermit = createLoyaltyMaintenanceOwnerPermit({
        storeId,
        metadata: maintenanceMetadata as any,
        ownerToken: "o".repeat(64),
      });
      queryRawMock.mockImplementation(async (statement: any) => {
        const sql = statement.strings?.join(" ") || "";
        if (sql.includes("FROM WeleticShopifyStore")) {
          return [{ id: storeId, complianceState: "active" }] as never;
        }
        if (sql.includes("FROM WeleticLoyaltyProgram")) {
          return [
            {
              id: "prog_1",
              storeId,
              status: "active",
              killSwitchActive: false,
              metadata: maintenanceMetadata,
            },
          ] as never;
        }
        throw new Error(`Unexpected raw-query fixture: ${sql}`);
      });

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(500),
        status: "active",
        program: { id: "prog_1", status: "active", killSwitchActive: false },
        shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
      } as any);

      vi.mocked(
        prisma.weleticRewardDefinition.findUnique,
      ).mockResolvedValueOnce({
        id: rewardDefinitionId,
        storeId,
        name: "$5 Off Reward",
        rewardType: WeleticRewardType.amount_off,
        pointsCost: BigInt(100),
        discountValue: 500,
        status: WeleticRewardStatus.active,
        expiresInDays: 30,
      } as any);

      vi.mocked(prisma.weleticRewardRedemption.create).mockResolvedValueOnce({
        id: "wredemp_saga_1",
        storeId,
        accountId,
        rewardDefinitionId,
        pointsSpent: BigInt(100),
        shopifyDiscountCode: "WL-SAGA001",
        status: WeleticRedemptionStatus.provisioning,
      } as any);

      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/999888777",
                codeDiscount: {
                  title: "$5 Off Reward (WL-SAGA001)",
                  status: "ACTIVE",
                  codes: { nodes: [{ id: "c1", code: "WL-SAGA001" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      const sagaResult = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId,
        discountCode: "WL-SAGA001",
        idempotencyKey: "saga-happy-path-1",
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        customFetch: mockFetch as any,
        loyaltyMaintenancePermit,
      });

      expect(sagaResult.success).toBe(true);
      expect(sagaResult.status).toBe(WeleticRedemptionStatus.issued);
      expect(sagaResult.shopifyDiscountId).toBe(
        "gid://shopify/DiscountCodeNode/999888777",
      );
      expect(sagaResult.pointsSpent).toBe(BigInt(100));

      // Verify redemption was updated to issued
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: "wredemp_saga_1",
            status: WeleticRedemptionStatus.provisioning,
          }),
          data: expect.objectContaining({
            status: WeleticRedemptionStatus.issued,
            shopifyDiscountId: "gid://shopify/DiscountCodeNode/999888777",
          }),
        }),
      );
    });

    it("does not escape to the global credential resolver while the program transaction is open", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("SHOPIFY_APP_URL", "https://shopify.weletic.com");
      vi.stubEnv(
        "WELETIC_SHOPIFY_SERVICE_SECRET",
        "test-shopify-service-secret-with-32-characters",
      );
      const storeId = "store_pool_bound";
      const accountId = "acc_pool_bound";
      const rewardDefinitionId = "reward_pool_bound";
      let transactionDepth = 0;
      (prisma.$transaction as any).mockImplementation(
        async (callback: (tx: typeof prisma) => Promise<unknown>) => {
          transactionDepth += 1;
          try {
            return await callback(prisma);
          } finally {
            transactionDepth -= 1;
          }
        },
      );
      queryRawMock.mockImplementation(async (statement: any) => {
        const sql = statement.strings?.join(" ") ?? "";
        if (sql.includes("FROM WeleticShopifyStore")) {
          return [
            {
              id: storeId,
              complianceState: "active",
              shopCurrency: "USD",
              currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
              installationGeneration: "sgen_pool_bound",
            },
          ];
        }
        if (sql.includes("FROM WeleticLoyaltyProgram")) {
          return [
            {
              id: "program_pool_bound",
              storeId,
              status: "active",
              killSwitchActive: false,
            },
          ];
        }
        throw new Error(`Unexpected raw-query fixture: ${sql}`);
      });
      (prisma.weleticShopifyStore.findUnique as any).mockImplementation(
        async ({ select }: any) => {
          if (select?.shopDomain) {
            if (transactionDepth > 0) {
              throw new Error(
                "global Shopify credential lookup escaped into a locked transaction",
              );
            }
            return {
              id: storeId,
              projectId: `workspace_${storeId}`,
              shopDomain: "pool-bound.myshopify.com",
              installationGeneration: "sgen_pool_bound",
            };
          }
          return {
            id: storeId,
            complianceState: "active",
            shopCurrency: "USD",
            currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
            installationGeneration: "sgen_pool_bound",
          };
        },
      );
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(500),
        status: "active",
        metadata: null,
        program: { id: "program_pool_bound" },
        shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
      } as any);
      vi.mocked(prisma.weleticRewardDefinition.findUnique).mockResolvedValue({
        id: rewardDefinitionId,
        storeId,
        name: "$5 pool-bound reward",
        rewardType: WeleticRewardType.amount_off,
        pointsCost: BigInt(100),
        discountValue: 500,
        status: WeleticRewardStatus.active,
      } as any);
      vi.mocked(prisma.weleticRewardRedemption.create).mockResolvedValue({
        id: "wredemp_pool_bound",
        storeId,
        accountId,
        rewardDefinitionId,
        pointsSpent: BigInt(100),
        shopifyDiscountCode: "WL-POOL-BOUND",
        shopifyDiscountCodeCanonical: "WL-POOL-BOUND",
        status: WeleticRedemptionStatus.provisioning,
      } as any);
      const authorityFetch = vi.fn().mockResolvedValue(
        Response.json({
          shop: "pool-bound.myshopify.com",
          accessToken: "fresh-pool-bound-token",
          scope: "write_discounts",
          expiresAt: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
        }),
      );
      vi.stubGlobal("fetch", authorityFetch);
      const shopifyFetch = vi.fn().mockResolvedValue(
        Response.json({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/pool-bound",
                codeDiscount: {
                  title: "$5 pool-bound reward",
                  status: "ACTIVE",
                  codes: { nodes: [{ code: "WL-POOL-BOUND" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      );
      vi.stubEnv(
        "WELETIC_SHOPIFY_PRIVACY_HMAC_KEYS",
        `current:${Buffer.alloc(32, 0x11).toString("base64")}`,
      );

      await expect(
        provisionDiscountSaga({
          storeId,
          accountId,
          rewardDefinitionId,
          discountCode: "WL-POOL-BOUND",
          idempotencyKey: "pool-bound-provisioning",
          customFetch: shopifyFetch as typeof fetch,
        }),
      ).resolves.toMatchObject({ success: true });
      expect(authorityFetch).toHaveBeenCalledOnce();
      expect(shopifyFetch).toHaveBeenCalledOnce();
    });

    it("compensates without a Shopify write when disable wins after reservation but before remote create", async () => {
      const storeId = "store_disable_race";
      const accountId = "acc_disable_race";
      const rewardDefinitionId = "reward_disable_race";
      const redemptionId = "wredemp_disable_race";
      let programLockCount = 0;
      queryRawMock.mockImplementation(async (statement: any) => {
        const sql = statement.strings?.join(" ") || "";
        if (sql.includes("FROM WeleticShopifyStore")) {
          return [{ id: storeId, complianceState: "active" }] as never;
        }
        if (sql.includes("FROM WeleticLoyaltyProgram")) {
          programLockCount += 1;
          return [
            {
              id: "program_disable_race",
              storeId,
              status: programLockCount < 4 ? "active" : "disabled",
              killSwitchActive: programLockCount >= 4,
            },
          ] as never;
        }
        throw new Error(`Unexpected raw-query fixture: ${sql}`);
      });
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(500),
        status: "active",
        metadata: null,
        program: { id: "program_disable_race" },
        shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
      } as any);
      vi.mocked(prisma.weleticRewardDefinition.findUnique).mockResolvedValue({
        id: rewardDefinitionId,
        storeId,
        name: "$5 disable-race reward",
        rewardType: WeleticRewardType.amount_off,
        pointsCost: BigInt(100),
        discountValue: 500,
        status: WeleticRewardStatus.active,
        expiresInDays: null,
      } as any);
      let reservedRedemption = {
        id: redemptionId,
        storeId,
        accountId,
        rewardDefinitionId,
        pointsSpent: BigInt(100),
        shopifyDiscountCode: "WL-DISABLE-RACE",
        shopifyDiscountCodeCanonical: "WL-DISABLE-RACE",
        shopifyDiscountId: null,
        status: WeleticRedemptionStatus.provisioning,
        metadata: {},
        expiresAt: null,
      } as any;
      (prisma.weleticRewardRedemption.findUnique as any)
        .mockResolvedValueOnce(null)
        .mockImplementation(async () => reservedRedemption);
      vi.mocked(prisma.weleticRewardRedemption.create).mockResolvedValue(
        reservedRedemption,
      );
      (prisma.weleticRewardRedemption.updateMany as any).mockImplementation(
        async ({ data }: any) => {
          reservedRedemption = { ...reservedRedemption, ...data };
          return { count: 1 };
        },
      );
      const remoteFetch = vi.fn();

      const result = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId,
        discountCode: "WL-DISABLE-RACE",
        idempotencyKey: "disable-race-after-reservation",
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        customFetch: remoteFetch as any,
      });

      expect(result).toMatchObject({
        success: false,
        redemptionId,
        status: WeleticRedemptionStatus.failed,
        compensated: true,
      });
      // Compensation rechecks the already-held program generation before its
      // operational metafield enqueue without acquiring the store row late.
      expect(programLockCount).toBe(6);
      expect(remoteFetch).not.toHaveBeenCalled();
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: redemptionId,
            storeId,
            status: WeleticRedemptionStatus.provisioning,
          }),
          data: expect.objectContaining({
            metadata: expect.objectContaining({
              remoteProvisionAttemptedAt: expect.any(String),
            }),
          }),
        }),
      );
      expect(
        vi
          .mocked(prisma.weleticRewardRedemption.updateMany)
          .mock.calls.some(
            ([args]) =>
              args.data.metadata !== undefined &&
              !(
                "remoteProvisionAttemptedAt" in
                (args.data.metadata as Record<string, unknown>)
              ) &&
              !(
                "remoteProvisionPreparationId" in
                (args.data.metadata as Record<string, unknown>)
              ),
          ),
      ).toBe(true);
      expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId,
          accountId,
          pointsDelta: BigInt(100),
          idempotencyKey: `saga_compensate:${redemptionId}`,
        }),
      );
    });

    it("defers for maintenance before Shopify without rewriting ambiguity metadata", async () => {
      const storeId = "store_maintenance_race";
      const accountId = "acc_maintenance_race";
      const rewardDefinitionId = "reward_maintenance_race";
      const redemptionId = "wredemp_maintenance_race";
      const maintenanceMetadata = createLoyaltyMaintenanceLeaseMetadata({
        existingMetadata: null,
        ownerToken: "m".repeat(64),
        runMarker: "saga-metadata-deferral",
        fixtureEmails: ["saga-maintenance@example.test"],
        acquiredAt: new Date("2026-08-30T00:00:00.000Z"),
        recoveryAfter: new Date("2026-08-30T01:00:00.000Z"),
      });
      let programLockCount = 0;
      queryRawMock.mockImplementation(async (statement: any) => {
        const sql = statement.strings?.join(" ") || "";
        if (sql.includes("FROM WeleticShopifyStore")) {
          return [
            {
              id: storeId,
              complianceState: "active",
              shopCurrency: "USD",
              currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
            },
          ] as never;
        }
        if (sql.includes("FROM WeleticLoyaltyProgram")) {
          programLockCount += 1;
          return [
            {
              id: "program_maintenance_race",
              storeId,
              status: "active",
              killSwitchActive: false,
              metadata: programLockCount >= 4 ? maintenanceMetadata : null,
            },
          ] as never;
        }
        throw new Error(`Unexpected raw-query fixture: ${sql}`);
      });
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(500),
        status: "active",
        metadata: null,
        program: { id: "program_maintenance_race" },
        shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
      } as any);
      vi.mocked(prisma.weleticRewardDefinition.findUnique).mockResolvedValue({
        id: rewardDefinitionId,
        storeId,
        name: "$5 maintenance-race reward",
        rewardType: WeleticRewardType.amount_off,
        pointsCost: BigInt(100),
        discountValue: 500,
        status: WeleticRewardStatus.active,
        expiresInDays: null,
      } as any);
      let reservedRedemption = {
        id: redemptionId,
        storeId,
        accountId,
        rewardDefinitionId,
        pointsSpent: BigInt(100),
        shopifyDiscountCode: "WL-MAINTENANCE-RACE",
        shopifyDiscountCodeCanonical: "WL-MAINTENANCE-RACE",
        shopifyDiscountId: null,
        status: WeleticRedemptionStatus.provisioning,
        metadata: {},
        settlementQuarantinedAt: null,
        expiresAt: null,
      } as any;
      const persistedMetadataWrites: string[] = [];
      (prisma.weleticRewardRedemption.findUnique as any)
        .mockResolvedValueOnce(null)
        .mockImplementation(async () => reservedRedemption);
      vi.mocked(prisma.weleticRewardRedemption.create).mockResolvedValue(
        reservedRedemption,
      );
      (prisma.weleticRewardRedemption.updateMany as any).mockImplementation(
        async ({ data }: any) => {
          if (data.metadata !== undefined) {
            persistedMetadataWrites.push(JSON.stringify(data.metadata));
          }
          reservedRedemption = { ...reservedRedemption, ...data };
          return { count: 1 };
        },
      );
      const remoteFetch = vi.fn();

      await expect(
        provisionDiscountSaga({
          storeId,
          accountId,
          rewardDefinitionId,
          discountCode: "WL-MAINTENANCE-RACE",
          idempotencyKey: "maintenance-race-after-reservation",
          shopDomain: "store.myshopify.com",
          accessToken: "shpat_test_token",
          customFetch: remoteFetch as any,
        }),
      ).rejects.toThrow(
        "Loyalty operational writes are blocked by a maintenance lease",
      );

      expect(programLockCount).toBe(4);
      expect(remoteFetch).not.toHaveBeenCalled();
      expect(persistedMetadataWrites).toHaveLength(1);
      expect(JSON.stringify(reservedRedemption.metadata)).toBe(
        persistedMetadataWrites[0],
      );
      expect(reservedRedemption.metadata).toMatchObject({
        remoteProvisionAttemptedAt: expect.any(String),
        remoteProvisionPreparationId: expect.any(String),
      });
      expect(
        vi
          .mocked(appendPointsLedgerEntry)
          .mock.calls.some(
            ([args]) =>
              args.idempotencyKey === `saga_compensate:${redemptionId}`,
          ),
      ).toBe(false);
    });

    it("fails before Shopify create when an ABA currency refresh advances the generation", async () => {
      const storeId = "store_currency_generation_race";
      const accountId = "account_currency_generation_race";
      const rewardDefinitionId = "reward_currency_generation_race";
      const redemptionId = "wredemp_currency_generation_race";
      queryRawMock.mockImplementation(async (statement: any) => {
        const sql = statement.strings?.join(" ") || "";
        if (sql.includes("FROM WeleticShopifyStore")) {
          return [
            {
              id: storeId,
              complianceState: "active",
              shopCurrency: "USD",
              currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
            },
          ] as never;
        }
        if (sql.includes("FROM WeleticLoyaltyProgram")) {
          return [
            {
              id: "program_currency_generation_race",
              storeId,
              status: "active",
              killSwitchActive: false,
            },
          ] as never;
        }
        throw new Error(`Unexpected raw-query fixture: ${sql}`);
      });
      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: storeId,
        complianceState: "active",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-30T01:00:00.000Z"),
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(500),
        status: "active",
        metadata: null,
        program: { id: "program_currency_generation_race" },
        shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
      } as any);
      vi.mocked(prisma.weleticRewardDefinition.findUnique).mockResolvedValue({
        id: rewardDefinitionId,
        storeId,
        name: "Currency generation reward",
        rewardType: WeleticRewardType.amount_off,
        pointsCost: BigInt(100),
        discountValue: 500,
        status: WeleticRewardStatus.active,
        expiresInDays: null,
      } as any);
      const reservedRedemption = {
        id: redemptionId,
        storeId,
        accountId,
        rewardDefinitionId,
        pointsSpent: BigInt(100),
        shopifyDiscountCode: "WL-CURRENCY-RACE",
        shopifyDiscountCodeCanonical: "WL-CURRENCY-RACE",
        shopifyDiscountId: null,
        status: WeleticRedemptionStatus.provisioning,
        metadata: {},
        expiresAt: null,
      } as any;
      vi.mocked(prisma.weleticRewardRedemption.findUnique)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(reservedRedemption);
      vi.mocked(prisma.weleticRewardRedemption.create).mockResolvedValue(
        reservedRedemption,
      );
      const remoteFetch = vi.fn();

      const result = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId,
        discountCode: "WL-CURRENCY-RACE",
        idempotencyKey: "currency-race-after-reservation",
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        customFetch: remoteFetch as any,
      });

      expect(result).toMatchObject({
        success: false,
        redemptionId,
        status: WeleticRedemptionStatus.failed,
        compensated: true,
      });
      expect(result.error).toContain("no longer matches USD");
      expect(remoteFetch).not.toHaveBeenCalled();
      expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId,
          pointsDelta: BigInt(100),
          idempotencyKey: `saga_compensate:${redemptionId}`,
        }),
      );
    });

    it("returns an existing issued redemption before rechecking the post-debit balance", async () => {
      const storeId = "store_idempotent_replay";
      const accountId = "acc_idempotent_replay";
      const rewardDefinitionId = "reward_idempotent_replay";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(0),
        status: "active",
        program: { id: "prog_1", status: "disabled", killSwitchActive: true },
        shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
      } as any);
      vi.mocked(
        prisma.weleticRewardRedemption.findUnique,
      ).mockResolvedValueOnce({
        id: "wredemp_replay_1",
        storeId,
        accountId,
        rewardDefinitionId,
        pointsSpent: BigInt(100),
        shopifyDiscountCode: "WL-REPLAY01",
        shopifyDiscountId: "gid://shopify/DiscountCodeNode/replay-1",
        idempotencyKey: "checkout-attempt-1",
        status: WeleticRedemptionStatus.issued,
        expiresAt: null,
      } as any);

      const result = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId,
        idempotencyKey: "checkout-attempt-1",
      });

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          redemptionId: "wredemp_replay_1",
          status: WeleticRedemptionStatus.issued,
          pointsSpent: BigInt(100),
        }),
      );
      expect(prisma.weleticRewardRedemption.create).not.toHaveBeenCalled();
      expect(prisma.weleticRewardDefinition.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      ["explicit discount code", { discountCode: "WL-DIFFERENT" }, null],
      [
        "absolute expiry",
        { expiresAt: new Date("2026-10-01T00:00:00.000Z") },
        new Date("2026-09-30T00:00:00.000Z"),
      ],
    ])(
      "rejects idempotency replay when the %s changes",
      async (_field, requestOverrides, existingExpiresAt) => {
        const storeId = "store_idempotent_conflict";
        const accountId = "acc_idempotent_conflict";
        const rewardDefinitionId = "reward_idempotent_conflict";
        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: accountId,
          storeId,
          cachedPointsBalance: BigInt(0),
          status: "active",
          program: { id: "prog_1", status: "active", killSwitchActive: false },
          shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
        } as any);
        vi.mocked(
          prisma.weleticRewardRedemption.findUnique,
        ).mockResolvedValueOnce({
          id: "wredemp_conflict",
          storeId,
          accountId,
          rewardDefinitionId,
          pointsSpent: BigInt(100),
          shopifyDiscountCode: "WL-ORIGINAL",
          shopifyDiscountId: "gid://shopify/DiscountCodeNode/conflict",
          idempotencyKey: "idempotency-conflict-key",
          status: WeleticRedemptionStatus.issued,
          expiresAt: existingExpiresAt,
        } as any);

        await expect(
          provisionDiscountSaga({
            storeId,
            accountId,
            rewardDefinitionId,
            idempotencyKey: "idempotency-conflict-key",
            ...requestOverrides,
          }),
        ).rejects.toThrow(
          "Redemption idempotency key was reused for another request.",
        );
        expect(
          prisma.weleticRewardDefinition.findUnique,
        ).not.toHaveBeenCalled();
      },
    );

    it("replays a provisioning redemption from its immutable economics instead of a changed reward", async () => {
      const storeId = "store_snapshot_replay";
      const accountId = "acc_snapshot_replay";
      const rewardDefinitionId = "reward_snapshot_replay";
      const redemptionId = "wredemp_snapshot_replay";
      const discountCode = "WL-SNAPSHOT";
      const startsAt = new Date("2026-08-29T00:00:00.000Z");
      const expiresAt = new Date("2026-09-28T00:00:00.000Z");
      const originalReward = {
        id: rewardDefinitionId,
        name: "$5 Original Reward",
        description: "Immutable customer promise",
        rewardType: WeleticRewardType.amount_off,
        discountValue: 500,
        maxDiscountValue: null,
        minOrderAmount: 1000,
        appliesToResource: null,
        entitledCollectionIds: [],
        entitledProductIds: [],
        entitledVariantIds: [],
        combinesWithProductDiscounts: false,
        combinesWithOrderDiscounts: false,
        combinesWithShippingDiscounts: false,
        usageLimit: 1,
        usageLimitPerCustomer: 1,
      };
      const ownership = createLoyaltyDiscountProvisioningIdentity({
        identity: {
          storeId,
          redemptionId,
          accountId,
          rewardDefinitionId,
          discountCode,
        },
        rewardName: originalReward.name,
      });
      const provisioningSnapshot = createLoyaltyRedemptionProvisioningSnapshot({
        reward: originalReward,
        pointsCost: BigInt(100),
        discountValue: originalReward.discountValue,
        expiresInDays: 30,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
        customerSelectionDigest: getShopifyCustomerSelectionDigest({
          storeId,
          shopifyCustomerId: "gid://shopify/Customer/100",
        }),
        startsAt,
        expiresAt,
      });
      const metadata = {
        rewardSnapshot: {
          name: originalReward.name,
          rewardType: originalReward.rewardType,
        },
        shopifyDiscountOwnership: ownership,
        provisioningSnapshot,
      };

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(400),
        status: "active",
        program: { id: "prog_1", status: "active", killSwitchActive: false },
        shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
      } as any);
      vi.mocked(
        prisma.weleticRewardRedemption.findUnique,
      ).mockResolvedValueOnce({
        id: redemptionId,
        storeId,
        accountId,
        rewardDefinitionId,
        pointsSpent: BigInt(100),
        shopifyDiscountCode: discountCode,
        shopifyDiscountId: null,
        idempotencyKey: "snapshot-replay-key",
        status: WeleticRedemptionStatus.provisioning,
        expiresAt,
        metadata,
      } as any);
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/snapshot-replay",
                codeDiscount: {
                  title: ownership.expectedTitle,
                  status: "ACTIVE",
                  codes: { nodes: [{ id: "c1", code: discountCode }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      });

      const result = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId,
        idempotencyKey: "snapshot-replay-key",
        customFetch: mockFetch as any,
      });

      expect(result.success).toBe(true);
      const request = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(
        request.variables.basicCodeDiscount.customerGets.value.discountAmount
          .amount,
      ).toBe("5.00");
      expect(
        request.variables.basicCodeDiscount.minimumRequirement.subtotal
          .greaterThanOrEqualToSubtotal,
      ).toBe("10.00");
      expect(request.variables.basicCodeDiscount.title).toBe(
        ownership.expectedTitle,
      );
      expect(request.variables.basicCodeDiscount.startsAt).toBe(
        startsAt.toISOString(),
      );
      expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
      expect(prisma.weleticRewardDefinition.findUnique).not.toHaveBeenCalled();
    });

    it.each(["INACTIVE", "EXPIRED"])(
      "compensates an owned %s voucher on direct replay without rekeying or another remote mutation",
      async (remoteStatus) => {
        const storeId = `store_direct_${remoteStatus.toLowerCase()}`;
        const accountId = `account_direct_${remoteStatus.toLowerCase()}`;
        const rewardDefinitionId = `reward_direct_${remoteStatus.toLowerCase()}`;
        const redemptionId = `wredemp_direct_${remoteStatus.toLowerCase()}`;
        const discountCode = `WL-DIRECT-${remoteStatus}`;
        const startsAt = new Date("2026-08-29T00:00:00.000Z");
        const reward = {
          id: rewardDefinitionId,
          name: "Direct replay reward",
          rewardType: WeleticRewardType.amount_off,
          discountValue: 500,
          usageLimit: 1,
          usageLimitPerCustomer: 1,
        };
        const ownership = createLoyaltyDiscountProvisioningIdentity({
          identity: {
            storeId,
            redemptionId,
            accountId,
            rewardDefinitionId,
            discountCode,
          },
          rewardName: reward.name,
        });
        const provisioningSnapshot =
          createLoyaltyRedemptionProvisioningSnapshot({
            reward,
            pointsCost: BigInt(100),
            discountValue: 500,
            expiresInDays: null,
            shopCurrency: "USD",
            currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
            customerSelectionDigest: getShopifyCustomerSelectionDigest({
              storeId,
              shopifyCustomerId: "gid://shopify/Customer/100",
            }),
            startsAt,
            expiresAt: null,
          });
        const redemption = {
          id: redemptionId,
          storeId,
          accountId,
          rewardDefinitionId,
          pointsSpent: BigInt(100),
          shopifyDiscountCode: discountCode,
          shopifyDiscountCodeCanonical: discountCode,
          shopifyDiscountId: null,
          idempotencyKey: `direct-${remoteStatus.toLowerCase()}-replay`,
          status: WeleticRedemptionStatus.provisioning,
          expiresAt: null,
          metadata: {
            rewardSnapshot: {
              name: reward.name,
              rewardType: reward.rewardType,
            },
            shopifyDiscountOwnership: ownership,
            provisioningSnapshot,
            remoteProvisionAttemptedAt: "2026-08-29T00:00:00.000Z",
            remoteProvisionReconcileUntil: "2026-08-29T00:02:00.000Z",
          },
        } as any;
        vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
          id: accountId,
          storeId,
          cachedPointsBalance: BigInt(400),
          status: "active",
          metadata: null,
          program: { id: `program_${storeId}` },
          shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
        } as any);
        vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
          redemption,
        );

        const remoteFetch = vi.fn(async (_url: string, init: any) => {
          const request = JSON.parse(init.body);
          if (request.query.includes("discountCodeBasicCreate")) {
            return {
              ok: true,
              json: async () => ({
                data: {
                  discountCodeBasicCreate: {
                    codeDiscountNode: null,
                    userErrors: [
                      {
                        field: ["basicCodeDiscount", "code"],
                        message: "Code has already been taken",
                        code: "TAKEN",
                      },
                    ],
                  },
                },
              }),
            };
          }
          if (request.query.includes("codeDiscountNodeByCode")) {
            return {
              ok: true,
              json: async () => ({
                data: {
                  codeDiscountNodeByCode: {
                    id: `gid://shopify/DiscountCodeNode/${remoteStatus.toLowerCase()}`,
                    codeDiscount: {
                      title: ownership.expectedTitle,
                      status: remoteStatus,
                      codes: { nodes: [{ id: "code_1", code: discountCode }] },
                    },
                  },
                },
              }),
            };
          }
          throw new Error(`Unexpected Shopify request: ${request.query}`);
        });

        const result = await provisionDiscountSaga({
          storeId,
          accountId,
          rewardDefinitionId,
          idempotencyKey: redemption.idempotencyKey,
          shopDomain: "store.myshopify.com",
          accessToken: "shpat_test_token",
          customFetch: remoteFetch as any,
        });

        expect(result).toMatchObject({
          success: false,
          redemptionId,
          shopifyDiscountId: `gid://shopify/DiscountCodeNode/${remoteStatus.toLowerCase()}`,
          status: WeleticRedemptionStatus.failed,
          compensated: true,
        });
        const remoteQueries = remoteFetch.mock.calls.map(
          ([_, init]) => JSON.parse((init as any).body).query,
        );
        expect(
          remoteQueries.filter((query) =>
            query.includes("discountCodeBasicCreate"),
          ),
        ).toHaveLength(1);
        expect(
          remoteQueries.some((query) =>
            query.includes("DiscountCodeDeactivate"),
          ),
        ).toBe(false);
        expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              id: redemptionId,
              shopifyDiscountCode: discountCode,
              shopifyDiscountCodeCanonical: discountCode,
            }),
            data: {
              shopifyDiscountId: `gid://shopify/DiscountCodeNode/${remoteStatus.toLowerCase()}`,
            },
          }),
        );
        expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId,
            pointsDelta: BigInt(100),
            idempotencyKey: `saga_compensate:${redemptionId}`,
          }),
        );
      },
    );

    it("does not refund an ambiguous provisioning replay when the program was disabled before reconciliation", async () => {
      const storeId = "store_ambiguous_disabled";
      const accountId = "acc_ambiguous_disabled";
      const rewardDefinitionId = "reward_ambiguous_disabled";
      const redemptionId = "wredemp_ambiguous_disabled";
      const discountCode = "WL-AMBIGUOUS";
      const startsAt = new Date("2026-08-29T00:00:00.000Z");
      const reward = {
        id: rewardDefinitionId,
        name: "Ambiguous reward",
        rewardType: WeleticRewardType.amount_off,
        discountValue: 500,
        usageLimit: 1,
        usageLimitPerCustomer: 1,
      };
      const ownership = createLoyaltyDiscountProvisioningIdentity({
        identity: {
          storeId,
          redemptionId,
          accountId,
          rewardDefinitionId,
          discountCode,
        },
        rewardName: reward.name,
      });
      const provisioningSnapshot = createLoyaltyRedemptionProvisioningSnapshot({
        reward,
        pointsCost: BigInt(100),
        discountValue: 500,
        expiresInDays: null,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
        customerSelectionDigest: getShopifyCustomerSelectionDigest({
          storeId,
          shopifyCustomerId: "gid://shopify/Customer/100",
        }),
        startsAt,
        expiresAt: null,
      });
      const metadata = {
        rewardSnapshot: { name: reward.name, rewardType: reward.rewardType },
        shopifyDiscountOwnership: ownership,
        provisioningSnapshot,
        remoteProvisionAttemptedAt: "2026-08-29T00:00:00.000Z",
        remoteProvisionReconcileUntil: "2026-08-29T00:02:00.000Z",
      };
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(400),
        status: "active",
        metadata: null,
        program: { id: "program_ambiguous_disabled" },
        shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
      } as any);
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
        id: redemptionId,
        storeId,
        accountId,
        rewardDefinitionId,
        pointsSpent: BigInt(100),
        shopifyDiscountCode: discountCode,
        shopifyDiscountId: null,
        idempotencyKey: "ambiguous-disabled-replay",
        status: WeleticRedemptionStatus.provisioning,
        expiresAt: null,
        metadata,
      } as any);
      queryRawMock.mockImplementation(async (statement: any) => {
        const sql = statement.strings?.join(" ") || "";
        if (sql.includes("FROM WeleticShopifyStore")) {
          return [{ id: storeId, complianceState: "active" }] as never;
        }
        if (sql.includes("FROM WeleticLoyaltyProgram")) {
          return [
            {
              id: "program_ambiguous_disabled",
              storeId,
              status: "disabled",
              killSwitchActive: true,
            },
          ] as never;
        }
        throw new Error(`Unexpected raw-query fixture: ${sql}`);
      });
      const remoteFetch = vi.fn();

      const result = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId,
        idempotencyKey: "ambiguous-disabled-replay",
        customFetch: remoteFetch as any,
      });

      expect(result).toMatchObject({
        success: false,
        redemptionId,
        status: WeleticRedemptionStatus.provisioning,
        compensated: false,
      });
      expect(remoteFetch).not.toHaveBeenCalled();
      expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(prisma.weleticRewardRedemption.updateMany)
          .mock.calls.some(
            ([args]) =>
              (args.data as any)?.status === WeleticRedemptionStatus.failed,
          ),
      ).toBe(false);
    });

    it("blocks a pre-redaction provisioning retry before any Shopify call", async () => {
      const storeId = "store_redacted_retry";
      const accountId = "acc_redacted_retry";
      const rewardDefinitionId = "reward_redacted_retry";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(400),
        status: "closed",
        metadata: {
          shopifyCustomerRedaction: {
            status: "redacted",
            redactedAt: "2026-08-29T00:00:00.000Z",
            source: "shopify_customers_redact",
          },
        },
        program: { id: "prog_1", status: "active", killSwitchActive: false },
        shopper: { shopifyCustomerId: "customer_redacted_retry" },
      } as any);
      const customFetch = vi.fn();

      await expect(
        provisionDiscountSaga({
          storeId,
          accountId,
          rewardDefinitionId,
          idempotencyKey: "pre-redaction-request",
          customFetch: customFetch as any,
        }),
      ).rejects.toThrow(
        "Loyalty account acc_redacted_retry is not active (closed).",
      );
      expect(prisma.weleticRewardRedemption.findUnique).not.toHaveBeenCalled();
      expect(prisma.weleticRewardRedemption.create).not.toHaveBeenCalled();
      expect(customFetch).not.toHaveBeenCalled();
    });

    it("keeps points reserved when an HTTP 500 leaves the Shopify create outcome ambiguous", async () => {
      const storeId = "store_test_saga";
      const accountId = "acc_test_saga";
      const rewardDefinitionId = "reward_def_10off";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(500),
        status: "active",
        program: { id: "prog_1", status: "active", killSwitchActive: false },
        shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
      } as any);

      vi.mocked(
        prisma.weleticRewardDefinition.findUnique,
      ).mockResolvedValueOnce({
        id: rewardDefinitionId,
        storeId,
        name: "$5 Off Reward",
        rewardType: WeleticRewardType.amount_off,
        pointsCost: BigInt(100),
        discountValue: 500,
        status: WeleticRewardStatus.active,
      } as any);

      vi.mocked(prisma.weleticRewardRedemption.create).mockResolvedValueOnce({
        id: "wredemp_fail_1",
        storeId,
        accountId,
        rewardDefinitionId,
        pointsSpent: BigInt(100),
        shopifyDiscountCode: "WL-FAIL001",
        status: WeleticRedemptionStatus.provisioning,
      } as any);

      // Injected Phase 2 GraphQL failure (HTTP 500 error)
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const sagaResult = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId,
        discountCode: "WL-FAIL001",
        idempotencyKey: "saga-ambiguous-failure-1",
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        customFetch: mockFetch as any,
      });

      expect(sagaResult.success).toBe(false);
      expect(sagaResult.compensated).toBe(false);
      expect(sagaResult.status).toBe(WeleticRedemptionStatus.provisioning);

      expect(
        vi
          .mocked(prisma.weleticRewardRedemption.updateMany)
          .mock.calls.some(
            ([args]) =>
              (args.data as any)?.status === WeleticRedemptionStatus.failed,
          ),
      ).toBe(false);
      expect(appendPointsLedgerEntry).not.toHaveBeenCalledWith(
        expect.objectContaining({ pointsDelta: BigInt(100) }),
      );
    });

    it("keeps points reserved when a dispatched create returns only payload errors", async () => {
      const storeId = "store_ambiguous_payload";
      const accountId = "acc_ambiguous_payload";
      const rewardDefinitionId = "reward_ambiguous_payload";

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: accountId,
        storeId,
        cachedPointsBalance: BigInt(500),
        status: "active",
        metadata: null,
        program: { id: "prog_ambiguous_payload" },
        shopper: { shopifyCustomerId: "gid://shopify/Customer/100" },
      } as any);
      vi.mocked(prisma.weleticRewardDefinition.findUnique).mockResolvedValue({
        id: rewardDefinitionId,
        storeId,
        name: "$5 Off Reward",
        rewardType: WeleticRewardType.amount_off,
        pointsCost: BigInt(100),
        discountValue: 500,
        status: WeleticRewardStatus.active,
      } as any);
      vi.mocked(prisma.weleticRewardRedemption.create).mockResolvedValue({
        id: "wredemp_ambiguous_payload",
        storeId,
        accountId,
        rewardDefinitionId,
        pointsSpent: BigInt(100),
        shopifyDiscountCode: "WL-AMBIGUOUS-PAYLOAD",
        shopifyDiscountCodeCanonical: "WL-AMBIGUOUS-PAYLOAD",
        status: WeleticRedemptionStatus.provisioning,
      } as any);
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: null,
              userErrors: [
                {
                  field: ["basicCodeDiscount"],
                  message: "Shopify could not return a create result",
                  code: "INTERNAL",
                },
              ],
            },
          },
        }),
      });

      const result = await provisionDiscountSaga({
        storeId,
        accountId,
        rewardDefinitionId,
        discountCode: "WL-AMBIGUOUS-PAYLOAD",
        idempotencyKey: "ambiguous-payload-result",
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_test_token",
        customFetch: mockFetch as any,
      });

      expect(result).toMatchObject({
        success: false,
        status: WeleticRedemptionStatus.provisioning,
        compensated: false,
      });
      expect(
        vi
          .mocked(prisma.weleticRewardRedemption.updateMany)
          .mock.calls.some(
            ([args]) =>
              (args.data as any)?.status === WeleticRedemptionStatus.failed,
          ),
      ).toBe(false);
      expect(appendPointsLedgerEntry).not.toHaveBeenCalledWith(
        expect.objectContaining({ pointsDelta: BigInt(100) }),
      );
    });

    it("keeps a post-redaction compensation generic and suppresses customer sync", async () => {
      const redemption = {
        id: "wredemp_redacted_compensation",
        storeId: "store_redacted_compensation",
        accountId: "account_redacted_compensation",
        rewardDefinitionId: "reward_redacted_compensation",
        pointsSpent: BigInt(125),
        shopifyDiscountCode: "WL-PRIVATE-CODE",
        status: WeleticRedemptionStatus.issued,
        metadata: { customerEmail: "stale@example.com" },
      } as any;
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
        redemption,
      );
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: redemption.accountId,
        storeId: redemption.storeId,
        status: "closed",
        metadata: {
          shopifyCustomerRedaction: {
            status: "redacted",
            redactedAt: "2026-08-29T00:00:00.000Z",
            source: "shopify_customers_redact",
          },
        },
      } as any);
      vi.mocked(
        prisma.weleticRewardRedemption.updateMany,
      ).mockResolvedValueOnce({ count: 1 } as any);

      await compensateDiscountSaga({
        redemptionId: redemption.id,
        reason: "Discount deleted in Shopify Admin",
        targetStatus: WeleticRedemptionStatus.cancelled,
      });

      expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: redemption.storeId,
          accountId: redemption.accountId,
          pointsDelta: BigInt(125),
          reason: "Loyalty redemption compensation after account closure.",
          metadata: { redemptionId: redemption.id },
        }),
      );
      expect(enqueueOutboxJob).not.toHaveBeenCalled();
    });

    it("refuses automatic compensation while canonical identity is quarantined", async () => {
      const redemption = {
        id: "wredemp_quarantined_compensation",
        storeId: "store_quarantined_compensation",
        accountId: "account_quarantined_compensation",
        rewardDefinitionId: "reward_quarantined_compensation",
        pointsSpent: BigInt(125),
        shopifyDiscountCode: "WL-QUARANTINED",
        shopifyDiscountCodeCanonical: "WL-QUARANTINED",
        settlementQuarantinedAt: new Date("2026-08-30T00:00:00.000Z"),
        status: WeleticRedemptionStatus.issued,
        metadata: null,
      } as any;
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
        redemption,
      );

      await expect(
        compensateDiscountSaga({
          redemptionId: redemption.id,
          reason: "Discount deleted in Shopify Admin",
          targetStatus: WeleticRedemptionStatus.cancelled,
        }),
      ).rejects.toThrow("exact Shopify identity reconciliation is required");

      expect(prisma.weleticLoyaltyAccount.findFirst).not.toHaveBeenCalled();
      expect(prisma.weleticRewardRedemption.updateMany).not.toHaveBeenCalled();
      expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
    });
  });

  describe("4. Outbox Recovery Worker Sweeper (sweepStuckSagaRedemptions)", () => {
    beforeEach(() => {
      (prisma.weleticShopifyStore.findUnique as any).mockImplementation(
        (query: any) =>
          ({
            id: query.where.id,
            shopDomain: `${query.where.id}.myshopify.com`,
            projectId: `workspace_${query.where.id}`,
            complianceState: "active",
            shopCurrency: "USD",
            currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
          }) as any,
      );
    });

    it("heals stuck provisioning redemption when remote discount exists in Shopify", async () => {
      const storeId = "store_heal_test";
      const redemptionId = "wredemp_stuck_1";
      const ownership = createLoyaltyDiscountProvisioningIdentity({
        identity: {
          storeId,
          redemptionId,
          accountId: "acc_1",
          rewardDefinitionId: "rdef_1",
          discountCode: "WL-HEAL001",
        },
        rewardName: "Voucher",
      });
      const startsAt = new Date("2026-08-29T00:00:00.000Z");
      const provisioningSnapshot = createLoyaltyRedemptionProvisioningSnapshot({
        reward: {
          id: "rdef_1",
          name: "Voucher",
          rewardType: WeleticRewardType.amount_off,
          discountValue: 500,
          usageLimit: 1,
          usageLimitPerCustomer: 1,
        },
        pointsCost: BigInt(200),
        discountValue: 500,
        expiresInDays: null,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
        customerSelectionDigest: getShopifyCustomerSelectionDigest({
          storeId,
          shopifyCustomerId: "gid://shopify/Customer/123",
        }),
        startsAt,
        expiresAt: null,
      });

      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat_override";
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
        id: "acc_1",
        storeId,
        status: "active",
        metadata: null,
        shopper: { shopifyCustomerId: "gid://shopify/Customer/123" },
        store: { projectId: `workspace_${storeId}` },
      } as any);

      vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
        {
          id: redemptionId,
          storeId,
          accountId: "acc_1",
          rewardDefinitionId: "rdef_1",
          pointsSpent: BigInt(200),
          shopifyDiscountCode: "WL-HEAL001",
          status: WeleticRedemptionStatus.provisioning,
          metadata: {
            rewardSnapshot: { name: "Voucher" },
            shopifyDiscountOwnership: ownership,
            provisioningSnapshot,
          },
          expiresAt: null,
          createdAt: new Date(Date.now() - 300_000), // 5 minutes ago
        } as any,
      ]);
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
        id: redemptionId,
        storeId,
        accountId: "acc_1",
        rewardDefinitionId: "rdef_1",
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-HEAL001",
        shopifyDiscountId: null,
        status: WeleticRedemptionStatus.provisioning,
        expiresAt: null,
        metadata: {
          rewardSnapshot: { name: "Voucher" },
          shopifyDiscountOwnership: ownership,
          provisioningSnapshot,
        },
      } as any);

      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            codeDiscountNodeByCode: {
              id: "gid://shopify/DiscountCodeNode/777666555",
              codeDiscount: {
                __typename: "DiscountCodeBasic",
                title: ownership.expectedTitle,
                status: "ACTIVE",
                startsAt: startsAt.toISOString(),
                endsAt: null,
                usageLimit: 1,
                appliesOncePerCustomer: true,
                recurringCycleLimit: 1,
                combinesWith: {
                  orderDiscounts: false,
                  productDiscounts: false,
                  shippingDiscounts: false,
                },
                customerSelection: {
                  __typename: "DiscountCustomers",
                  customers: [{ id: "gid://shopify/Customer/123" }],
                },
                minimumRequirement: null,
                customerGets: {
                  appliesOnOneTimePurchase: true,
                  appliesOnSubscription: false,
                  value: {
                    __typename: "DiscountAmount",
                    amount: { amount: "5.00", currencyCode: "USD" },
                    appliesOnEachItem: false,
                  },
                  items: {
                    __typename: "AllDiscountItems",
                    allItems: true,
                  },
                },
                codes: { nodes: [{ id: "c1", code: "WL-HEAL001" }] },
              },
            },
          },
        }),
      });

      const report = await sweepStuckSagaRedemptions({
        olderThanMinutes: 2,
        storeId,
        customFetch: mockFetch as any,
      });

      expect(report.checked).toBe(1);
      expect(report.healed).toBe(1);
      expect(report.compensated).toBe(0);

      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: redemptionId,
            storeId,
            status: WeleticRedemptionStatus.provisioning,
          }),
          data: expect.objectContaining({
            status: WeleticRedemptionStatus.issued,
            shopifyDiscountId: "gid://shopify/DiscountCodeNode/777666555",
          }),
        }),
      );
    });

    it("deactivates and compensates instead of adopting when the program is disabled during recovery", async () => {
      const storeId = "store_disabled_recovery";
      const redemption = {
        id: "wredemp_disabled_recovery",
        storeId,
        accountId: "acc_disabled_recovery",
        rewardDefinitionId: "reward_disabled_recovery",
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-DISABLED-RECOVERY",
        shopifyDiscountId: null,
        status: WeleticRedemptionStatus.provisioning,
        expiresAt: null,
        metadata: {},
      } as any;
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
        redemption,
      );
      queryRawMock.mockResolvedValue([
        {
          id: "program_disabled_recovery",
          storeId,
          status: "disabled",
          killSwitchActive: true,
        },
      ] as never);
      const customFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            discountCodeDeactivate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/disabled-recovery",
                codeDiscount: { status: "INACTIVE" },
              },
              userErrors: [],
            },
          },
        }),
      });

      await expect(
        reconcileGenericProvisioningDiscount({
          redemption,
          remoteDiscount: {
            id: "gid://shopify/DiscountCodeNode/disabled-recovery",
            code: redemption.shopifyDiscountCode,
            title: "Disabled recovery",
            status: "ACTIVE",
          },
          accountIsActive: true,
          configurationMatches: true,
          shopDomain: "store.myshopify.com",
          accessToken: "shpat_test_token",
          customFetch: customFetch as any,
        }),
      ).resolves.toBe("compensated");

      expect(customFetch).toHaveBeenCalledTimes(1);
      expect(customFetch.mock.calls[0][1].body).toContain(
        "DiscountCodeDeactivate",
      );
      expect(
        vi
          .mocked(prisma.weleticRewardRedemption.updateMany)
          .mock.calls.some(
            ([args]) =>
              (args.data as any)?.status === WeleticRedemptionStatus.issued,
          ),
      ).toBe(false);
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: redemption.id,
            storeId,
            accountId: redemption.accountId,
            status: WeleticRedemptionStatus.provisioning,
          }),
          data: {
            shopifyDiscountId:
              "gid://shopify/DiscountCodeNode/disabled-recovery",
          },
        }),
      );
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: redemption.id }),
          data: expect.objectContaining({
            status: WeleticRedemptionStatus.failed,
          }),
        }),
      );
      const [programLockStatement] = queryRawMock.mock.calls[0];
      expect(
        (programLockStatement as { strings: readonly string[] }).strings.join(
          " ",
        ),
      ).toContain("FOR UPDATE");
    });

    it("converges an owned inactive generic discount without another Shopify mutation", async () => {
      const storeId = "store_inactive_recovery";
      const redemption = {
        id: "wredemp_inactive_recovery",
        storeId,
        accountId: "acc_inactive_recovery",
        rewardDefinitionId: "reward_inactive_recovery",
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-INACTIVE-RECOVERY",
        shopifyDiscountId: null,
        status: WeleticRedemptionStatus.provisioning,
        expiresAt: null,
        metadata: {},
      } as any;
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
        redemption,
      );
      queryRawMock.mockResolvedValue([
        {
          id: "program_inactive_recovery",
          storeId,
          status: "disabled",
          killSwitchActive: true,
        },
      ] as never);
      const customFetch = vi.fn();

      await expect(
        reconcileGenericProvisioningDiscount({
          redemption,
          remoteDiscount: {
            id: "gid://shopify/DiscountCodeNode/inactive-recovery",
            code: redemption.shopifyDiscountCode,
            title: "Inactive recovery",
            status: "INACTIVE",
          },
          accountIsActive: true,
          configurationMatches: false,
          shopDomain: "store.myshopify.com",
          accessToken: "shpat_test_token",
          customFetch: customFetch as any,
        }),
      ).resolves.toBe("compensated");

      expect(customFetch).not.toHaveBeenCalled();
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WeleticRedemptionStatus.failed,
          }),
        }),
      );
    });

    it("never adopts a referral coupon through the generic code-only sweeper path", async () => {
      const storeId = "store_referral_sweep";
      const redemptionId = "wredemp_referral_sweep";
      const referralId = "wreferral_sweep";
      const qualificationOrderId = "worder_sweep";
      const accountId = "wacc_referral_sweep";
      const rewardDefinitionId = "wreward_referral_sweep";
      const discountCode = "WLR-REFERRAL-SWEEP";
      const idempotencyKey = getReferralCouponIdempotencyKey({
        referralId,
        qualificationOrderId,
        side: "advocate",
      });
      const redemption = {
        id: redemptionId,
        storeId,
        accountId,
        rewardDefinitionId,
        pointsSpent: BigInt(0),
        shopifyDiscountCode: discountCode,
        shopifyDiscountId: null,
        idempotencyKey,
        status: WeleticRedemptionStatus.provisioning,
        expiresAt: null,
        createdAt: new Date(Date.now() - 300_000),
        metadata: {
          referralId,
          qualificationOrderId,
          referralSide: "advocate",
          rewardSnapshot: {
            name: "Referral voucher",
            description: null,
            rewardType: "amount_off",
          },
        },
      };
      vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
        redemption as any,
      ]);
      vi.mocked(
        prisma.weleticRewardRedemption.findUnique,
      ).mockResolvedValueOnce(redemption as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
        id: accountId,
        storeId,
        status: "active",
        metadata: null,
        shopper: { shopifyCustomerId: "gid://shopify/Customer/123" },
        store: { projectId: `workspace_${storeId}` },
      } as any);
      vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValueOnce(
        {
          id: rewardDefinitionId,
          storeId,
          status: WeleticRewardStatus.active,
          exchangeType: "fixed",
          name: "Referral voucher",
          description: null,
          rewardType: WeleticRewardType.amount_off,
        } as any,
      );

      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      vi.spyOn(
        shopifyDiscounts,
        "resolveShopifyOfflineCredentials",
      ).mockResolvedValueOnce({
        shopDomain: "store.myshopify.com",
        accessToken: "shpat_token",
        source: "app_session",
      });
      const lookupSpy = vi.spyOn(shopifyDiscounts, "lookupDiscountByCode");
      const provisionSpy = vi.spyOn(
        shopifyDiscounts,
        "provisionLoyaltyRewardDiscount",
      );

      const report = await sweepStuckSagaRedemptions({
        olderThanMinutes: 2,
        storeId,
      });

      expect(report).toEqual({
        checked: 1,
        healed: 0,
        compensated: 0,
        errors: 1,
      });
      // Invalid dedicated recovery metadata fails before any generic code-only
      // lookup can accidentally adopt a same-code Shopify discount.
      expect(lookupSpy).not.toHaveBeenCalled();
      expect(provisionSpy).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(prisma.weleticRewardRedemption.updateMany)
          .mock.calls.some(
            ([args]) =>
              (args.data as any)?.status === WeleticRedemptionStatus.issued,
          ),
      ).toBe(false);
    });

    it("does not resurrect a redemption cancelled while a recovery lookup is in flight", async () => {
      const storeId = "store_heal_race";
      const redemptionId = "wredemp_heal_race";
      const ownership = createLoyaltyDiscountProvisioningIdentity({
        identity: {
          storeId,
          redemptionId,
          accountId: "acc_race",
          rewardDefinitionId: "rdef_race",
          discountCode: "WL-RACE001",
        },
        rewardName: "Voucher",
      });
      const startsAt = new Date("2026-08-29T01:00:00.000Z");
      const provisioningSnapshot = createLoyaltyRedemptionProvisioningSnapshot({
        reward: {
          id: "rdef_race",
          name: "Voucher",
          rewardType: WeleticRewardType.amount_off,
          discountValue: 500,
          usageLimit: 1,
          usageLimitPerCustomer: 1,
        },
        pointsCost: BigInt(200),
        discountValue: 500,
        expiresInDays: null,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
        customerSelectionDigest: getShopifyCustomerSelectionDigest({
          storeId,
          shopifyCustomerId: "gid://shopify/Customer/456",
        }),
        startsAt,
        expiresAt: null,
      });

      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat_override";
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
        id: "acc_race",
        storeId,
        status: "active",
        metadata: null,
        shopper: { shopifyCustomerId: "gid://shopify/Customer/456" },
        store: { projectId: `workspace_${storeId}` },
      } as any);
      vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
        {
          id: redemptionId,
          storeId,
          accountId: "acc_race",
          rewardDefinitionId: "rdef_race",
          pointsSpent: BigInt(200),
          shopifyDiscountCode: "WL-RACE001",
          status: WeleticRedemptionStatus.provisioning,
          metadata: {
            rewardSnapshot: { name: "Voucher" },
            shopifyDiscountOwnership: ownership,
            provisioningSnapshot,
          },
          expiresAt: null,
          createdAt: new Date(Date.now() - 300_000),
        } as any,
      ]);
      vi.mocked(
        prisma.weleticRewardRedemption.updateMany,
      ).mockResolvedValueOnce({ count: 0 } as any);
      vi.mocked(
        prisma.weleticRewardRedemption.findUnique,
      ).mockResolvedValueOnce({
        id: redemptionId,
        storeId,
        accountId: "acc_race",
        rewardDefinitionId: "rdef_race",
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-RACE001",
        shopifyDiscountId: null,
        status: WeleticRedemptionStatus.cancelled,
        metadata: {
          rewardSnapshot: { name: "Voucher" },
          shopifyDiscountOwnership: ownership,
        },
      } as any);

      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              codeDiscountNodeByCode: {
                id: "gid://shopify/DiscountCodeNode/race",
                codeDiscount: {
                  __typename: "DiscountCodeBasic",
                  title: ownership.expectedTitle,
                  status: "ACTIVE",
                  startsAt: startsAt.toISOString(),
                  endsAt: null,
                  usageLimit: 1,
                  appliesOncePerCustomer: true,
                  recurringCycleLimit: 1,
                  combinesWith: {
                    orderDiscounts: false,
                    productDiscounts: false,
                    shippingDiscounts: false,
                  },
                  customerSelection: {
                    __typename: "DiscountCustomers",
                    customers: [{ id: "gid://shopify/Customer/456" }],
                  },
                  minimumRequirement: null,
                  customerGets: {
                    appliesOnOneTimePurchase: true,
                    appliesOnSubscription: false,
                    value: {
                      __typename: "DiscountAmount",
                      amount: { amount: "5.00", currencyCode: "USD" },
                      appliesOnEachItem: false,
                    },
                    items: {
                      __typename: "AllDiscountItems",
                      allItems: true,
                    },
                  },
                  codes: { nodes: [{ id: "c1", code: "WL-RACE001" }] },
                },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              discountCodeDeactivate: {
                codeDiscountNode: {
                  id: "gid://shopify/DiscountCodeNode/race",
                },
                userErrors: [],
              },
            },
          }),
        });

      const report = await sweepStuckSagaRedemptions({
        olderThanMinutes: 2,
        storeId,
        customFetch: mockFetch as any,
      });

      expect(report.healed).toBe(0);
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            id: redemptionId,
            storeId,
            accountId: "acc_race",
            status: WeleticRedemptionStatus.cancelled,
            shopifyDiscountId: null,
          }),
          data: { shopifyDiscountId: "gid://shopify/DiscountCodeNode/race" },
        }),
      );
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][1].body).toContain(
        "DiscountCodeDeactivate",
      );
    });

    it("compensates stuck provisioning redemption when remote discount is missing in Shopify", async () => {
      const storeId = "store_comp_test";
      const redemptionId = "wredemp_stuck_2";

      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat_override";

      vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
        {
          id: redemptionId,
          storeId,
          accountId: "acc_2",
          rewardDefinitionId: "rdef_2",
          pointsSpent: BigInt(300),
          shopifyDiscountCode: "WL-LOST002",
          status: WeleticRedemptionStatus.provisioning,
          createdAt: new Date(Date.now() - 300_000),
        } as any,
      ]);

      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
        id: redemptionId,
        storeId,
        accountId: "acc_2",
        pointsSpent: BigInt(300),
        shopifyDiscountCode: "WL-LOST002",
        status: WeleticRedemptionStatus.provisioning,
      } as any);

      // Shopify GraphQL returns null for discount lookup
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            codeDiscountNodeByCode: null,
          },
        }),
      });

      const report = await sweepStuckSagaRedemptions({
        olderThanMinutes: 2,
        storeId,
        customFetch: mockFetch as any,
      });

      expect(report.checked).toBe(1);
      expect(report.healed).toBe(0);
      expect(report.compensated).toBe(1);

      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: redemptionId }),
          data: expect.objectContaining({
            status: WeleticRedemptionStatus.failed,
          }),
        }),
      );
    });

    it("never heals a generic provisioning redemption after customer redaction", async () => {
      const storeId = "store_closed_sweep";
      process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat_override";
      const ownership = createLoyaltyDiscountProvisioningIdentity({
        identity: {
          storeId,
          redemptionId: "wredemp_closed_sweep",
          accountId: "acc_closed_sweep",
          rewardDefinitionId: "reward_closed_sweep",
          discountCode: "WL-CLOSED-SWEEP",
        },
        rewardName: "Closed sweep",
      });
      const redemption = {
        id: "wredemp_closed_sweep",
        storeId,
        accountId: "acc_closed_sweep",
        rewardDefinitionId: "reward_closed_sweep",
        pointsSpent: BigInt(200),
        shopifyDiscountCode: "WL-CLOSED-SWEEP",
        shopifyDiscountId: null,
        status: WeleticRedemptionStatus.provisioning,
        metadata: {
          rewardSnapshot: { name: "Closed sweep" },
          shopifyDiscountOwnership: ownership,
        },
        createdAt: new Date(Date.now() - 300_000),
      } as any;
      vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
        redemption,
      ]);
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
        redemption,
      );
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
        id: redemption.accountId,
        storeId,
        status: "closed",
        metadata: {
          shopifyCustomerRedaction: {
            status: "redacted",
            redactedAt: "2026-08-29T00:00:00.000Z",
            source: "shopify_customers_redact",
          },
        },
        shopper: { shopifyCustomerId: "customer_closed_sweep" },
        store: { projectId: "workspace_closed_sweep" },
      } as any);
      const customFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              codeDiscountNodeByCode: {
                id: "gid://shopify/DiscountCodeNode/closed-sweep",
                codeDiscount: {
                  title: ownership.expectedTitle,
                  status: "ACTIVE",
                  codes: { nodes: [{ code: "WL-CLOSED-SWEEP" }] },
                },
              },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            data: {
              discountCodeDeactivate: {
                codeDiscountNode: {
                  id: "gid://shopify/DiscountCodeNode/closed-sweep",
                },
                userErrors: [],
              },
            },
          }),
        });

      await expect(
        sweepStuckSagaRedemptions({
          storeId,
          olderThanMinutes: 2,
          customFetch: customFetch as any,
        }),
      ).resolves.toMatchObject({ healed: 0, compensated: 1, errors: 0 });
      expect(
        vi
          .mocked(prisma.weleticRewardRedemption.updateMany)
          .mock.calls.some(
            ([args]) =>
              (args.data as any)?.status === WeleticRedemptionStatus.issued,
          ),
      ).toBe(false);
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: WeleticRedemptionStatus.failed,
          }),
        }),
      );
    });
  });
});
