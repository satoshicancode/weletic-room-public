import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runTestStoreValidation,
  validateCustomerAccountSessionClaims,
  validateDomainResolution,
  validateLocalServiceHmacChecks,
  validateShopifyDiscountsLifecycle,
  validateStaticCustomerAccountClaimChecks,
  validateWebhookProvisioningPhase,
} from "../../scripts/loyalty/validate-test-store";

const validationMockState = vi.hoisted(() => ({
  lookupCounts: new Map<string, number>(),
  createInputs: new Map<string, any>(),
  exactNodePresence: new Map<string, boolean>(),
  foreignPreflightPrefix: null as string | null,
  foreignPreflightGid: "gid://shopify/DiscountCodeNode/9999",
  foreignCleanupPrefix: null as string | null,
  missingAfterVerificationPrefix: null as string | null,
  shopCurrencyCode: "JPY",
  basicAmountOverride: null as number | null,
  basicCurrencyOverride: null as string | null,
  percentageOverride: null as number | null,
  shippingDestinationOverride: null as string | null,
  bxgyPercentageOverride: null as number | null,
  normalizeStartsAtToSeconds: false,
}));

const mockProjectData = {
  id: "proj_test_store",
  name: "Test Store Project",
  shopifyStoreId: "n0pvef-cs.myshopify.com",
  defaultProgramId: "wprog_test_store",
  installedIntegrations: [
    {
      id: "inst_1",
      integrationId: "clyq5a1a1000008l412345678",
      credentials: {
        shop: "n0pvef-cs.myshopify.com",
        accessToken: "shpat_mock_test_token_12345",
        installationGeneration: "sgen_test_store",
        shopVerifiedAt: "2026-08-28T00:00:00.000Z",
        shopVerificationTokenHash:
          "6e9adad2553121938c7243c850b3f9e9c122bb43bdb449e1bbde5b0da6bd9bcb",
      },
    },
  ],
  weleticShopifyStore: {
    id: "wstore_test_store",
    shopDomain: "n0pvef-cs.myshopify.com",
    installationGeneration: "sgen_test_store",
  },
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: {
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where?.shopifyStoreId === "n0pvef-cs.myshopify.com") {
          return mockProjectData;
        }
        return null;
      }),
      findFirst: vi.fn().mockImplementation(async () => mockProjectData),
    },
    installedIntegration: {
      findUnique: vi.fn().mockResolvedValue({
        id: "inst_1",
        projectId: "proj_test_store",
        credentials: {
          shop: "n0pvef-cs.myshopify.com",
          accessToken: "shpat_mock_test_token_12345",
          installationGeneration: "sgen_test_store",
          shopVerifiedAt: "2026-08-28T00:00:00.000Z",
          shopVerificationTokenHash:
            "6e9adad2553121938c7243c850b3f9e9c122bb43bdb449e1bbde5b0da6bd9bcb",
        },
      }),
      findMany: vi.fn().mockResolvedValue([
        {
          id: "inst_1",
          projectId: "proj_test_store",
          integration: { id: "clyq5a1a1000008l412345678", name: "Shopify" },
          credentials: {
            shop: "n0pvef-cs.myshopify.com",
            accessToken: "shpat_mock_test_token_12345",
            installationGeneration: "sgen_test_store",
            shopVerifiedAt: "2026-08-28T00:00:00.000Z",
            shopVerificationTokenHash:
              "6e9adad2553121938c7243c850b3f9e9c122bb43bdb449e1bbde5b0da6bd9bcb",
          },
        },
      ]),
    },
    weleticShopifyStore: {
      findUnique: vi.fn().mockResolvedValue({
        id: "wstore_test_store",
        projectId: "proj_test_store",
        shopDomain: "n0pvef-cs.myshopify.com",
        installationGeneration: "sgen_test_store",
        program: { id: "wprog_test_store", status: "active" },
      }),
      findFirst: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([
      {
        id: "wstore_test_store",
        projectId: "proj_test_store",
        installationGeneration: "sgen_test_store",
      },
    ]),
    $transaction: vi.fn(async (callback: (tx: any) => unknown) =>
      callback({
        $queryRaw: vi.fn().mockResolvedValue([
          {
            id: "wstore_test_store",
            projectId: "proj_test_store",
            installationGeneration: "sgen_test_store",
          },
        ]),
        installedIntegration: {
          findUnique: vi.fn().mockResolvedValue({
            id: "inst_1",
            projectId: "proj_test_store",
            credentials: {
              shop: "n0pvef-cs.myshopify.com",
              accessToken: "shpat_mock_test_token_12345",
              installationGeneration: "sgen_test_store",
              shopVerifiedAt: "2026-08-28T00:00:00.000Z",
              shopVerificationTokenHash:
                "6e9adad2553121938c7243c850b3f9e9c122bb43bdb449e1bbde5b0da6bd9bcb",
            },
          }),
        },
      }),
    ),
  },
}));

vi.mock("@/lib/encryption", () => ({
  decryptOrPassthrough: vi.fn((val: string) => val),
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", () => {
  const discountGidForCode = (code: string) =>
    code.startsWith("VAL-PERCENT-")
      ? "gid://shopify/DiscountCodeNode/1004"
      : code.startsWith("VAL-SHIP-")
        ? "gid://shopify/DiscountCodeNode/1002"
        : code.startsWith("VAL-BXGY-")
          ? "gid://shopify/DiscountCodeNode/1003"
          : "gid://shopify/DiscountCodeNode/1001";
  const titleForCode = (code: string) => {
    if (code.startsWith("VAL-PERCENT-")) {
      return `Validation Percentage Discount ${code.replace("VAL-PERCENT-", "")}`;
    }
    if (code.startsWith("VAL-SHIP-")) {
      return `Validation Free Shipping ${code.replace("VAL-SHIP-", "")}`;
    }
    if (code.startsWith("VAL-BXGY-")) {
      return `Validation BXGY Free Gift ${code.replace("VAL-BXGY-", "")}`;
    }
    return `Validation Basic Discount ${code.replace("VAL-BASIC-", "")}`;
  };
  const normalizedStartsAt = (value: string) =>
    validationMockState.normalizeStartsAtToSeconds
      ? new Date(value).toISOString().replace(".000Z", "Z")
      : value;
  const commonConfiguration = (input: any) => ({
    startsAt: normalizedStartsAt(input.startsAt),
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
  });

  return {
    shopifyAdminGraphqlRequest: vi
      .fn()
      .mockImplementation(async (params: any) => {
        if (params.query.includes("WeleticValidationShopCurrency")) {
          return {
            shop: { currencyCode: validationMockState.shopCurrencyCode },
          };
        }
        if (params.query.includes("WeleticValidationProduct")) {
          return {
            products: {
              nodes: [{ id: "gid://shopify/Product/validation-product" }],
            },
          };
        }
        if (params.query.includes("WeleticValidationNodeById")) {
          return {
            node: validationMockState.exactNodePresence.get(params.variables.id)
              ? { id: params.variables.id }
              : null,
          };
        }
        if (params.query.includes("WeleticValidationBxgyReadback")) {
          const code = params.variables.code;
          const input = validationMockState.createInputs.get(code);
          if (!input) return { codeDiscountNodeByCode: null };
          return {
            codeDiscountNodeByCode: {
              id: discountGidForCode(code),
              codeDiscount: {
                __typename: "DiscountCodeBxgy",
                title: titleForCode(code),
                status: "ACTIVE",
                startsAt: normalizedStartsAt(input.startsAt),
                endsAt: null,
                usageLimit: 1,
                usesPerOrderLimit: 1,
                appliesOncePerCustomer: true,
                combinesWith: {
                  orderDiscounts: false,
                  productDiscounts: false,
                  shippingDiscounts: false,
                },
                customerSelection: {
                  __typename: "DiscountCustomerAll",
                  allCustomers: true,
                },
                customerBuys: {
                  value: { quantity: "1" },
                  items: {
                    products: {
                      nodes: [{ id: input.buyProductGids[0] }],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
                customerGets: {
                  value: {
                    quantity: { quantity: "1" },
                    effect: {
                      __typename: "DiscountPercentage",
                      percentage:
                        validationMockState.bxgyPercentageOverride ?? 1,
                    },
                  },
                  items: {
                    products: {
                      nodes: [{ id: input.getProductGids[0] }],
                      pageInfo: { hasNextPage: false },
                    },
                  },
                },
                codes: { nodes: [{ code }] },
              },
            },
          };
        }
        throw new Error("Unexpected mocked Shopify Admin GraphQL query");
      }),
    resolveShopifyOfflineCredentials: vi.fn().mockResolvedValue({
      shopDomain: "n0pvef-cs.myshopify.com",
      accessToken: "shpat_mock_test_token_12345",
    }),
    createBasicDiscount: vi.fn().mockImplementation(async (params: any) => {
      validationMockState.createInputs.set(params.code, params);
      return {
        id: discountGidForCode(params.code),
        code: params.code,
        title: params.title,
        status: "ACTIVE",
      };
    }),
    createFreeShippingDiscount: vi
      .fn()
      .mockImplementation(async (params: any) => {
        validationMockState.createInputs.set(params.code, params);
        return {
          id: discountGidForCode(params.code),
          code: params.code,
          title: params.title,
          status: "ACTIVE",
        };
      }),
    createBxgyDiscount: vi.fn().mockImplementation(async (params: any) => {
      validationMockState.createInputs.set(params.code, params);
      return {
        id: discountGidForCode(params.code),
        code: params.code,
        title: params.title,
        status: "ACTIVE",
      };
    }),
    lookupDiscountByCode: vi
      .fn()
      .mockImplementation(
        async (_shop: string, _token: string, code: string) => {
          const lookupCount =
            (validationMockState.lookupCounts.get(code) || 0) + 1;
          validationMockState.lookupCounts.set(code, lookupCount);
          if (
            lookupCount === 1 &&
            validationMockState.foreignPreflightPrefix &&
            code.startsWith(validationMockState.foreignPreflightPrefix)
          ) {
            return {
              id: validationMockState.foreignPreflightGid,
              code,
              title: "Foreign merchant discount",
              status: "ACTIVE",
            };
          }
          if (lookupCount === 1) return null;
          if (
            lookupCount >= 3 &&
            validationMockState.missingAfterVerificationPrefix &&
            code.startsWith(validationMockState.missingAfterVerificationPrefix)
          ) {
            return null;
          }
          const input = validationMockState.createInputs.get(code);
          if (!input) return null;
          const common = commonConfiguration(input);
          if (
            lookupCount >= 4 &&
            validationMockState.foreignCleanupPrefix &&
            code.startsWith(validationMockState.foreignCleanupPrefix)
          ) {
            return {
              id: validationMockState.foreignPreflightGid,
              code,
              title: titleForCode(code),
              status: "ACTIVE",
              configuration: {
                kind: "basic",
                ...common,
                basicItems: { kind: "all" },
                basicValue: {
                  kind: "amount",
                  amount: "10",
                  currencyCode: "JPY",
                  appliesOnEachItem: false,
                },
              },
            };
          }
          if (code.startsWith("VAL-PERCENT-")) {
            return {
              id: discountGidForCode(code),
              code,
              title: titleForCode(code),
              status: "ACTIVE",
              configuration: {
                kind: "basic",
                ...common,
                basicItems: { kind: "all" },
                basicValue: {
                  kind: "percentage",
                  percentage: validationMockState.percentageOverride ?? 0.1,
                },
              },
            };
          }
          if (code.startsWith("VAL-SHIP-")) {
            return {
              id: discountGidForCode(code),
              code,
              title: titleForCode(code),
              status: "ACTIVE",
              configuration: {
                kind: "free_shipping",
                ...common,
                maximumShippingPrice: null,
                shippingDestination: {
                  kind:
                    validationMockState.shippingDestinationOverride || "all",
                },
              },
            };
          }
          return {
            id: discountGidForCode(code),
            code,
            title: titleForCode(code),
            status: "ACTIVE",
            configuration: {
              kind: "basic",
              ...common,
              basicItems: { kind: "all" },
              basicValue: {
                kind: "amount",
                amount: String(validationMockState.basicAmountOverride ?? 10),
                currencyCode:
                  validationMockState.basicCurrencyOverride || "JPY",
                appliesOnEachItem: false,
              },
            },
          };
        },
      ),
    deactivateDiscount: vi.fn().mockResolvedValue(true),
    deleteDiscount: vi.fn().mockResolvedValue(true),
  };
});

describe("Milestone 6: Mocked Test Store Validator Characterization Suite", () => {
  const TEST_STORE = "n0pvef-cs.myshopify.com";
  const TEST_SECRET =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  beforeEach(() => {
    vi.clearAllMocks();
    validationMockState.lookupCounts.clear();
    validationMockState.createInputs.clear();
    validationMockState.exactNodePresence.clear();
    validationMockState.foreignPreflightPrefix = null;
    validationMockState.foreignCleanupPrefix = null;
    validationMockState.missingAfterVerificationPrefix = null;
    validationMockState.shopCurrencyCode = "JPY";
    validationMockState.basicAmountOverride = null;
    validationMockState.basicCurrencyOverride = null;
    validationMockState.percentageOverride = null;
    validationMockState.shippingDestinationOverride = null;
    validationMockState.bxgyPercentageOverride = null;
    validationMockState.normalizeStartsAtToSeconds = false;
  });

  // =========================================================================
  // Phase 1: Store Domain & Workspace Resolution
  // =========================================================================
  describe("Phase 1: Store Domain & Workspace Canonical Resolution", () => {
    it("validates domain normalization across URL protocols, cases, and whitespace", async () => {
      const result = await validateDomainResolution(TEST_STORE, {
        dryRun: true,
      });
      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(2);
      expect(result.checks[0].name).toBe("Domain String Normalization");
      expect(result.checks[0].passed).toBe(true);
    });

    it("resolves mocked persisted store, workspace, and offline-credential records", async () => {
      const result = await validateDomainResolution(TEST_STORE, {
        dryRun: false,
        mockShopify: true,
      });
      expect(result.passed).toBe(true);
      expect(result.checks[1].name).toBe(
        "Canonical Store Resolution (DB / InstalledIntegration)",
      );
      expect(result.checks[1].passed).toBe(true);
    });
  });

  // =========================================================================
  // Phase 2: Local service-HMAC cryptographic checks
  // =========================================================================
  describe("Phase 2: Local Service-HMAC Cryptographic Checks", () => {
    it("verifies canonical HMAC SHA-256 signatures with 64-char hex digests", async () => {
      const result = await validateLocalServiceHmacChecks(
        TEST_STORE,
        TEST_SECRET,
      );
      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(3);

      const signCheck = result.checks.find((c) =>
        c.name.includes("Local Service-HMAC"),
      );
      expect(signCheck?.passed).toBe(true);
    });

    it("strictly rejects requests exceeding max clock skew (> 5 minutes)", async () => {
      const result = await validateLocalServiceHmacChecks(
        TEST_STORE,
        TEST_SECRET,
      );
      const skewCheck = result.checks.find((c) =>
        c.name.includes("Clock-Skew"),
      );
      expect(skewCheck?.passed).toBe(true);
    });

    it("detects and rejects body tampering on mutating POST requests", async () => {
      const result = await validateLocalServiceHmacChecks(
        TEST_STORE,
        TEST_SECRET,
      );
      const tamperCheck = result.checks.find((c) =>
        c.name.includes("Payload-Tamper"),
      );
      expect(tamperCheck?.passed).toBe(true);
    });
  });

  // =========================================================================
  // Phase 3: Static Customer Account claim parser checks
  // =========================================================================
  describe("Phase 3: Static Customer Account Claim Parser Checks", () => {
    it("extracts and normalizes shop domain and numeric customer ID from GID", () => {
      const parsed = validateCustomerAccountSessionClaims({
        dest: `https://${TEST_STORE}`,
        sub: "gid://shopify/Customer/1234567890",
      });

      expect(parsed.valid).toBe(true);
      expect(parsed.shop).toBe(TEST_STORE);
      expect(parsed.customerId).toBe("1234567890");
    });

    it("rejects tokens missing dest or sub claims", () => {
      expect(
        validateCustomerAccountSessionClaims({
          sub: "gid://shopify/Customer/1",
        }).valid,
      ).toBe(false);
      expect(
        validateCustomerAccountSessionClaims({ dest: `https://${TEST_STORE}` })
          .valid,
      ).toBe(false);
      expect(validateCustomerAccountSessionClaims({}).valid).toBe(false);
      expect(
        validateCustomerAccountSessionClaims({
          dest: "https://example.com",
          sub: "gid://shopify/Customer/1",
        }).valid,
      ).toBe(false);
      expect(
        validateCustomerAccountSessionClaims({
          dest: `https://${TEST_STORE}`,
          sub: "gid://shopify/Customer/not-numeric",
        }).valid,
      ).toBe(false);
    });

    it("executes the static parser checks without claiming JWT verification", async () => {
      const result = await validateStaticCustomerAccountClaimChecks(TEST_STORE);
      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(2);
      expect(result.checks.every((c) => c.passed)).toBe(true);
    });
  });

  // =========================================================================
  // Phase 4: Shopify GraphQL Admin API 2026-07 Discount Lifecycle
  // =========================================================================
  describe("Phase 4: Shopify GraphQL Admin API 2026-07 Discount Code Lifecycle", () => {
    const runLifecycle = () =>
      validateShopifyDiscountsLifecycle(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        { dryRun: false, cleanup: true, executionMode: "mock" },
      );

    it("uses mocked adapters for four exact configuration readbacks and GID-confirmed cleanup", async () => {
      const result = await runLifecycle();

      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(7);

      const checkNames = result.checks.map((c) => c.name);
      expect(checkNames).toContain(
        "Shopify GraphQL 2026-07: discountCodeBasicCreate",
      );
      expect(checkNames).toContain(
        "Shopify GraphQL 2026-07: discountCodeBasicCreate (Percentage Off)",
      );
      expect(checkNames).toContain(
        "Shopify GraphQL 2026-07: discountCodeFreeShippingCreate",
      );
      expect(checkNames).toContain(
        "Shopify GraphQL 2026-07: discountCodeBxgyCreate",
      );
      expect(checkNames).toContain(
        "Shopify GraphQL 2026-07: Authoritative Shop Currency Readback",
      );
      expect(checkNames).toContain(
        "Shopify GraphQL 2026-07: Independent Exact Configuration Readback",
      );
      expect(checkNames).toContain("Discount Cleanup (Deactivate & Delete)");

      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      expect(shopifyDiscounts.createBasicDiscount).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ valueType: "percentage", value: 10 }),
      );
      expect(shopifyDiscounts.lookupDiscountByCode).toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        expect.stringMatching(/^VAL-PERCENT-[A-F0-9]{32}$/),
        undefined,
      );
      const readbackCheck = result.checks.find((check) =>
        check.name.includes("Independent Exact Configuration Readback"),
      );
      expect(readbackCheck?.details).toMatchObject({
        expectedCount: 4,
        exactReadbackCount: 4,
      });
      expect(result.provenance).toMatchObject({
        source: "mocked-shopify-adapter",
        executionMode: "mock",
        live: false,
      });
      expect(
        result.checks.every(
          (check) => check.provenance?.source === "mocked-shopify-adapter",
        ),
      ).toBe(true);
      expect(shopifyDiscounts.shopifyAdminGraphqlRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("WeleticValidationShopCurrency"),
        }),
      );
      expect(shopifyDiscounts.shopifyAdminGraphqlRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("WeleticValidationBxgyReadback"),
        }),
      );
      expect(shopifyDiscounts.shopifyAdminGraphqlRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining("WeleticValidationNodeById"),
          variables: { id: "gid://shopify/DiscountCodeNode/1001" },
        }),
      );
    });

    it("accepts Shopify whole-second timestamp canonicalization", async () => {
      validationMockState.normalizeStartsAtToSeconds = true;

      const result = await runLifecycle();

      expect(result.passed).toBe(true);
      expect(
        result.checks.find((check) =>
          check.name.includes("Independent Exact Configuration Readback"),
        )?.details,
      ).toMatchObject({ expectedCount: 4, exactReadbackCount: 4 });
    });

    it("fails the percentage capability check when Shopify reads back different economics", async () => {
      validationMockState.percentageOverride = 0.2;
      const result = await runLifecycle();

      const percentageCheck = result.checks.find((check) =>
        check.name.includes("Percentage Off"),
      );
      expect(percentageCheck).toMatchObject({ passed: false });
      expect(result.passed).toBe(false);
    });

    it("fails free-shipping validation when the independent immutable configuration differs", async () => {
      validationMockState.shippingDestinationOverride = "countries";
      const result = await runLifecycle();

      expect(
        result.checks.find((check) =>
          check.name.includes("discountCodeFreeShippingCreate"),
        ),
      ).toMatchObject({ passed: false });
      expect(result.passed).toBe(false);
    });

    it("fails BXGY validation when the independently read back economics differ", async () => {
      validationMockState.bxgyPercentageOverride = 0.5;
      const result = await runLifecycle();

      expect(
        result.checks.find((check) =>
          check.name.includes("discountCodeBxgyCreate"),
        ),
      ).toMatchObject({ passed: false });
      expect(result.passed).toBe(false);
    });

    it("never treats a foreign percentage lookup identity as cleanup authority", async () => {
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      validationMockState.foreignPreflightPrefix = "VAL-PERCENT-";
      const foreignGid = validationMockState.foreignPreflightGid;
      const result = await runLifecycle();

      expect(result.passed).toBe(false);
      expect(shopifyDiscounts.deactivateDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        foreignGid,
        undefined,
      );
      expect(shopifyDiscounts.deleteDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        foreignGid,
        undefined,
      );
      expect(shopifyDiscounts.createBasicDiscount).toHaveBeenCalledTimes(1);
    });

    it("does not grant cleanup authority to a create result with a mismatched run-marker title", async () => {
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      const untrustedGid = "gid://shopify/DiscountCodeNode/7777";
      vi.mocked(
        shopifyDiscounts.createFreeShippingDiscount,
      ).mockImplementationOnce(async (params) => {
        validationMockState.createInputs.set(params.code, params);
        return {
          id: untrustedGid,
          code: params.code,
          title: "Unrelated merchant discount",
          status: "ACTIVE",
        } as any;
      });

      const result = await runLifecycle();

      expect(result.passed).toBe(false);
      expect(shopifyDiscounts.deactivateDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        untrustedGid,
        undefined,
      );
      expect(shopifyDiscounts.deleteDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        untrustedGid,
        undefined,
      );
    });

    it("never mutates a foreign ID returned by the final cleanup lookup", async () => {
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      validationMockState.foreignCleanupPrefix = "VAL-BASIC-";
      validationMockState.exactNodePresence.set(
        "gid://shopify/DiscountCodeNode/1001",
        true,
      );

      const result = await runLifecycle();

      expect(result.passed).toBe(false);
      expect(shopifyDiscounts.deactivateDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        "gid://shopify/DiscountCodeNode/1001",
        undefined,
      );
      expect(shopifyDiscounts.deleteDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        "gid://shopify/DiscountCodeNode/1001",
        undefined,
      );
      expect(shopifyDiscounts.deactivateDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        validationMockState.foreignPreflightGid,
        undefined,
      );
      expect(shopifyDiscounts.deleteDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        validationMockState.foreignPreflightGid,
        undefined,
      );
    });

    it("fails cleanup when delete returns true but exact node(id) remains", async () => {
      validationMockState.exactNodePresence.set(
        "gid://shopify/DiscountCodeNode/1001",
        true,
      );
      const result = await runLifecycle();
      const cleanupCheck = result.checks.find((check) =>
        check.name.includes("Discount Cleanup"),
      );

      expect(cleanupCheck).toMatchObject({ passed: false });
      expect(result.passed).toBe(false);
    });

    it.each(["false", "throw"] as const)(
      "accepts delete %s only when exact node(id) is absent",
      async (outcome) => {
        const shopifyDiscounts = await import(
          "@/lib/weletic/loyalty/shopify-discounts"
        );
        if (outcome === "false") {
          vi.mocked(shopifyDiscounts.deleteDiscount).mockResolvedValueOnce(
            false,
          );
        } else {
          vi.mocked(shopifyDiscounts.deleteDiscount).mockRejectedValueOnce(
            new Error("response lost after delete dispatch"),
          );
        }

        const result = await runLifecycle();
        const cleanupCheck = result.checks.find((check) =>
          check.name.includes("Discount Cleanup"),
        );
        expect(cleanupCheck).toMatchObject({ passed: true });
        expect(result.passed).toBe(true);
      },
    );

    it.each(["false", "throw"] as const)(
      "still attempts delete after deactivate %s and trusts only exact node absence",
      async (outcome) => {
        const shopifyDiscounts = await import(
          "@/lib/weletic/loyalty/shopify-discounts"
        );
        if (outcome === "false") {
          vi.mocked(shopifyDiscounts.deactivateDiscount).mockResolvedValueOnce(
            false,
          );
        } else {
          vi.mocked(shopifyDiscounts.deactivateDiscount).mockRejectedValueOnce(
            new Error("response lost after deactivate dispatch"),
          );
        }

        const result = await runLifecycle();
        expect(shopifyDiscounts.deleteDiscount).toHaveBeenCalledWith(
          TEST_STORE,
          "shpat_mock_test_token_12345",
          "gid://shopify/DiscountCodeNode/1001",
          undefined,
        );
        expect(
          result.checks.find((check) =>
            check.name.includes("Discount Cleanup"),
          ),
        ).toMatchObject({ passed: true });
        expect(result.passed).toBe(true);
      },
    );

    it("fails cleanup when code lookup is missing but exact create-returned node remains", async () => {
      validationMockState.missingAfterVerificationPrefix = "VAL-BASIC-";
      validationMockState.exactNodePresence.set(
        "gid://shopify/DiscountCodeNode/1001",
        true,
      );

      const result = await runLifecycle();
      const cleanupCheck = result.checks.find((check) =>
        check.name.includes("Discount Cleanup"),
      );
      expect(cleanupCheck).toMatchObject({ passed: false });
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      expect(shopifyDiscounts.deleteDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        "gid://shopify/DiscountCodeNode/1001",
        undefined,
      );
      expect(result.passed).toBe(false);
    });

    it("recovers a post-commit basic-create response loss through exact marker/config reconciliation", async () => {
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      vi.mocked(shopifyDiscounts.createBasicDiscount).mockImplementationOnce(
        async (params) => {
          validationMockState.createInputs.set(params.code, params);
          throw new Error("response lost after create commit");
        },
      );

      const result = await runLifecycle();
      const basicCheck = result.checks.find(
        (check) =>
          check.name === "Shopify GraphQL 2026-07: discountCodeBasicCreate",
      );
      expect(basicCheck).toMatchObject({
        passed: true,
        details: { outcome: "reconciled-after-unknown-create" },
      });
      expect(shopifyDiscounts.deleteDiscount).toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        "gid://shopify/DiscountCodeNode/1001",
        undefined,
      );
      expect(result.passed).toBe(true);
    });

    it("recovers a post-commit BXGY response loss only after exact product/economics readback", async () => {
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      vi.mocked(shopifyDiscounts.createBxgyDiscount).mockImplementationOnce(
        async (params) => {
          validationMockState.createInputs.set(params.code, params);
          throw new Error("response lost after BXGY create commit");
        },
      );

      const result = await runLifecycle();
      const bxgyCheck = result.checks.find((check) =>
        check.name.includes("discountCodeBxgyCreate"),
      );
      expect(bxgyCheck).toMatchObject({
        passed: true,
        details: { outcome: "reconciled-after-unknown-create" },
      });
      expect(result.passed).toBe(true);
    });

    it("fails cleanup and never mutates an unresolved post-dispatch create", async () => {
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      validationMockState.basicAmountOverride = 999;
      vi.mocked(shopifyDiscounts.createBasicDiscount).mockImplementationOnce(
        async (params) => {
          validationMockState.createInputs.set(params.code, params);
          throw new Error("response lost after create commit");
        },
      );

      const result = await runLifecycle();
      const cleanupCheck = result.checks.find((check) =>
        check.name.includes("Discount Cleanup"),
      );
      expect(cleanupCheck).toMatchObject({
        passed: false,
        details: { unresolvedDispatchedCount: 1 },
      });
      expect(shopifyDiscounts.deactivateDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        "gid://shopify/DiscountCodeNode/1001",
        undefined,
      );
      expect(shopifyDiscounts.deleteDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        "gid://shopify/DiscountCodeNode/1001",
        undefined,
      );
      expect(result.passed).toBe(false);
    });

    it("does not authorize unknown amount-off cleanup when readback currency differs from the live shop currency", async () => {
      const shopifyDiscounts = await import(
        "@/lib/weletic/loyalty/shopify-discounts"
      );
      validationMockState.basicCurrencyOverride = "USD";
      vi.mocked(shopifyDiscounts.createBasicDiscount).mockImplementationOnce(
        async (params) => {
          validationMockState.createInputs.set(params.code, params);
          throw new Error("response lost after create commit");
        },
      );

      const result = await runLifecycle();
      const basicCheck = result.checks.find(
        (check) =>
          check.name === "Shopify GraphQL 2026-07: discountCodeBasicCreate",
      );
      expect(basicCheck).toMatchObject({
        passed: false,
        details: { outcome: "unresolved" },
      });
      expect(shopifyDiscounts.deactivateDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        "gid://shopify/DiscountCodeNode/1001",
        undefined,
      );
      expect(shopifyDiscounts.deleteDiscount).not.toHaveBeenCalledWith(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        "gid://shopify/DiscountCodeNode/1001",
        undefined,
      );
      expect(result.passed).toBe(false);
    });
  });

  // =========================================================================
  // Phase 5: Webhook Auto-Provisioning & Reconciliation
  // =========================================================================
  describe("Phase 5: Webhook Provisioning & Local Body-HMAC Checks", () => {
    it("skips live provisioning in dry-run and checks the local body-HMAC primitive", async () => {
      const result = await validateWebhookProvisioningPhase(
        TEST_STORE,
        "shpat_mock_test_token_12345",
        { dryRun: true, webhookSecret: TEST_SECRET },
      );

      expect(result.passed).toBe(true);
      expect(result.checks).toHaveLength(2);

      const provCheck = result.checks.find((c) =>
        c.name.includes("Webhook Provisioning"),
      );
      expect(provCheck?.skipped).toBe(true);

      const sigCheck = result.checks.find((c) =>
        c.name.includes("Local Webhook Body-HMAC"),
      );
      expect(sigCheck?.passed).toBe(true);
    });
  });

  // =========================================================================
  // Overall End-to-End Characterization Runner
  // =========================================================================
  describe("Overall Test Store Validation Runner", () => {
    it("runs all 5 phases and returns WARNING when live checks are skipped", async () => {
      const report = await runTestStoreValidation({
        storeDomain: TEST_STORE,
        mockShopify: true,
        customFetch: vi.fn() as any,
        serviceSecret: TEST_SECRET,
        webhookSecret: TEST_SECRET,
      });

      expect(report.storeDomain).toBe(TEST_STORE);
      expect(report.executionMode).toBe("mock");
      expect(report.overallStatus).toBe("WARNING");
      expect(report.summary.totalChecks).toBeGreaterThanOrEqual(14);
      expect(report.summary.failedChecks).toBe(0);
      expect(report.summary.skippedChecks).toBeGreaterThan(0);
      expect(report.errors).toHaveLength(0);
      expect(report.phases.domainResolution.passed).toBe(true);
      expect(report.phases.localServiceHmacChecks.passed).toBe(true);
      expect(report.phases.staticCustomerAccountClaimChecks.passed).toBe(true);
      expect(report.phases.graphqlDiscounts.passed).toBe(true);
      expect(report.phases.webhookProvisioning.passed).toBe(true);
      expect(report.phases.graphqlDiscounts.provenance).toMatchObject({
        source: "mocked-shopify-adapter",
        executionMode: "mock",
        live: false,
      });
      expect(
        Object.values(report.phases).every(
          (phase) =>
            phase.provenance &&
            phase.checks.every((check) => Boolean(check.provenance)),
        ),
      ).toBe(true);
    });
  });
});
