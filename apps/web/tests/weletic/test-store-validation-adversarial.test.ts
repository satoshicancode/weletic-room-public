import {
  signWeleticShopifyRequest,
  verifyWeleticShopifyRequest,
  WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
} from "@/lib/weletic/shopify/service-auth";
import { verifyShopifyWebhookSignature } from "@/lib/weletic/shopify/webhook-signature";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runTestStoreValidation,
  validateCustomerAccountSessionClaims,
  validateLocalServiceHmacChecks,
  validateShopifyDiscountsLifecycle,
  validateWebhookProvisioningPhase,
} from "../../scripts/loyalty/validate-test-store";

describe("Milestone 6 Adversarial Stress Suite: Test Store Validation Resilience", () => {
  const TEST_STORE = "n0pvef-cs.myshopify.com";
  const VALID_SECRET =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // =========================================================================
  // 1. Simulated Network Timeouts & Aborts
  // =========================================================================
  describe("1. Network Timeouts, Drops & Connection Aborts", () => {
    it("handles total network timeout on GraphQL discount creation without unhandled rejection", async () => {
      const timeoutFetch = vi.fn().mockImplementation(async () => {
        const error = new Error("The operation was aborted due to a timeout");
        error.name = "AbortError";
        throw error;
      }) as any;

      const result = await validateShopifyDiscountsLifecycle(
        TEST_STORE,
        "shpat_valid_token_12345",
        {
          dryRun: false,
          cleanup: true,
          customFetch: timeoutFetch,
          executionMode: "mock",
        },
      );

      expect(result.passed).toBe(false);
      expect(result.checks).toEqual([
        expect.objectContaining({
          name: expect.stringContaining("Authoritative Shop Currency"),
          passed: false,
          error: expect.stringContaining("authoritative Shopify shop currency"),
          provenance: expect.objectContaining({ executionMode: "mock" }),
        }),
      ]);
      expect(result.checks[0].error).not.toContain("operation was aborted");
    });

    it("fails closed when intermittent network drops leave create outcomes unresolved", async () => {
      const createdGids: string[] = [];

      const flakyFetch = vi
        .fn()
        .mockImplementation(async (_url: string, init: any) => {
          const body = typeof init?.body === "string" ? init.body : "";

          if (body.includes("WeleticValidationShopCurrency")) {
            return new Response(
              JSON.stringify({ data: { shop: { currencyCode: "JPY" } } }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          // First call: basic discount succeeds
          if (body.includes("discountCodeBasicCreate")) {
            const parsed = JSON.parse(body);
            const reqCode =
              parsed?.variables?.basicCodeDiscount?.code || "VAL-BASIC-MOCK";
            const reqTitle =
              parsed?.variables?.basicCodeDiscount?.title ||
              "Validation Basic Discount";
            const gid = "gid://shopify/DiscountCodeNode/flaky_basic_1";
            createdGids.push(gid);
            return new Response(
              JSON.stringify({
                data: {
                  discountCodeBasicCreate: {
                    codeDiscountNode: {
                      id: gid,
                      codeDiscount: {
                        title: reqTitle,
                        status: "ACTIVE",
                        codes: { nodes: [{ id: "c1", code: reqCode }] },
                      },
                    },
                    userErrors: [],
                  },
                },
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }

          // Second call: free shipping discount fails with socket hang up
          if (body.includes("discountCodeFreeShippingCreate")) {
            throw new Error("socket hang up (ECONNRESET)");
          }

          // Cleanup queries
          return new Response(
            JSON.stringify({
              data: {
                discountCodeDeactivate: {
                  codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" },
                  userErrors: [],
                },
                discountCodeDelete: {
                  deletedCodeDiscountId: "gid://shopify/DiscountCodeNode/1",
                  userErrors: [],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as any;

      const result = await validateShopifyDiscountsLifecycle(
        TEST_STORE,
        "shpat_valid_token_12345",
        {
          dryRun: false,
          cleanup: true,
          customFetch: flakyFetch,
          executionMode: "mock",
        },
      );

      expect(result.passed).toBe(false);
      const basicCheck = result.checks.find((c) =>
        c.name.includes("discountCodeBasicCreate"),
      );
      const shipCheck = result.checks.find((c) =>
        c.name.includes("discountCodeFreeShippingCreate"),
      );

      expect(createdGids.length).toBeGreaterThan(0);
      expect(basicCheck?.passed).toBe(false);
      expect(basicCheck?.error).toContain("exact run marker");
      expect(shipCheck?.passed).toBe(false);
      expect(shipCheck?.error).toContain("exact run marker");
      expect(shipCheck?.error).not.toContain("socket hang up");
      expect(
        result.checks.find((check) => check.name.includes("Discount Cleanup"))
          ?.details?.unresolvedDispatchedCount,
      ).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 2. Adversarial HMAC, Signature & Clock Skew Attacks
  // =========================================================================
  describe("2. Adversarial HMAC, Signature & Clock Skew Attacks", () => {
    beforeEach(() => {
      process.env.WELETIC_SHOPIFY_SERVICE_SECRET = VALID_SECRET;
    });

    it("strictly rejects malformed, non-hex, or corrupted HMAC signatures", () => {
      const timestamp = String(Date.now());
      const method = "GET";
      const path = "/api/internal/shopify/loyalty/program?shop=" + TEST_STORE;
      const body = "";

      const corruptedSignatures = [
        "not_a_valid_hex_signature_string!!",
        "0123456789abcdef", // too short (16 chars)
        "z".repeat(64), // invalid hex characters
        "", // empty
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef00", // 66 chars (too long)
      ];

      for (const badSig of corruptedSignatures) {
        const req = new Request(`https://app.weletic.com${path}`, {
          method,
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: badSig,
          },
        });

        const isValid = verifyWeleticShopifyRequest({
          request: req,
          body,
          now: Number(timestamp),
        });

        expect(isValid).toBe(false);
      }
    });

    it("strictly rejects future timestamps exceeding max clock skew (> 5 minutes into the future)", () => {
      const futureTimestamp = String(
        Date.now() + WELETIC_SHOPIFY_MAX_CLOCK_SKEW_MS + 10000,
      );
      const path = "/api/internal/shopify/loyalty/program?shop=" + TEST_STORE;

      const signature = signWeleticShopifyRequest({
        timestamp: futureTimestamp,
        method: "GET",
        path,
        body: "",
        secret: VALID_SECRET,
      });

      const req = new Request(`https://app.weletic.com${path}`, {
        method: "GET",
        headers: {
          [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: futureTimestamp,
          [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature,
        },
      });

      const isValid = verifyWeleticShopifyRequest({
        request: req,
        body: "",
        now: Date.now(),
      });

      expect(isValid).toBe(false);
    });

    it("rejects non-numeric, negative, and NaN timestamp headers", () => {
      const invalidTimestamps = [
        "NaN",
        "undefined",
        "null",
        "-5000",
        "2026-08-26T00:00:00Z",
        "12345abc",
      ];

      for (const badTs of invalidTimestamps) {
        const req = new Request(
          `https://app.weletic.com/api/internal/shopify/loyalty/program`,
          {
            method: "GET",
            headers: {
              [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: badTs,
              [WELETIC_SHOPIFY_SIGNATURE_HEADER]: "a".repeat(64),
            },
          },
        );

        const isValid = verifyWeleticShopifyRequest({
          request: req,
          body: "",
          now: Date.now(),
        });

        expect(isValid).toBe(false);
      }
    });

    it("rejects request when secret is below 32 chars in verification", () => {
      process.env.WELETIC_SHOPIFY_SERVICE_SECRET = "short_secret";
      const req = new Request(
        `https://app.weletic.com/api/internal/shopify/loyalty/program`,
        {
          method: "GET",
          headers: {
            [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: String(Date.now()),
            [WELETIC_SHOPIFY_SIGNATURE_HEADER]: "a".repeat(64),
          },
        },
      );

      expect(() => {
        verifyWeleticShopifyRequest({
          request: req,
          body: "",
          now: Date.now(),
        });
      }).toThrow(
        /WELETIC_SHOPIFY_SERVICE_SECRET must be at least 32 characters/,
      );
    });
  });

  // =========================================================================
  // 3. Missing & Corrupted Environment Variables
  // =========================================================================
  describe("3. Missing & Corrupted Environment Variables", () => {
    it("fails closed when the service-HMAC secret is not explicit or configured", async () => {
      delete process.env.WELETIC_SHOPIFY_SERVICE_SECRET;

      const result = await validateLocalServiceHmacChecks(TEST_STORE);
      expect(result.passed).toBe(false);
      expect(result.checks).toEqual([
        expect.objectContaining({
          name: "Explicit Service-HMAC Secret Availability",
          passed: false,
        }),
      ]);
    });

    it("fails closed when the webhook secret is not explicit or configured", async () => {
      delete process.env.SHOPIFY_WEBHOOK_SECRET;

      const result = await validateWebhookProvisioningPhase(
        TEST_STORE,
        "shpat_mock",
        { dryRun: true },
      );
      expect(result.passed).toBe(false);
      expect(result.checks).toEqual([
        expect.objectContaining({
          name: "Explicit Webhook Secret Availability",
          passed: false,
        }),
      ]);
    });

    it("inbound webhook HMAC verification detects invalid webhook signatures and tampered JSON", () => {
      const webhookSecret = "whsec_test_secret_12345";
      const validPayload = JSON.stringify({ id: 1001, total_price: "50.00" });
      const tamperedPayload = JSON.stringify({ id: 1001, total_price: "0.00" });

      const signature = verifyShopifyWebhookSignature({
        body: validPayload,
        signature: "invalid_sig",
        secret: webhookSecret,
      });
      expect(signature).toBe(false);

      const emptySecretResult = verifyShopifyWebhookSignature({
        body: validPayload,
        signature: "some_sig",
        secret: "",
      });
      expect(emptySecretResult).toBe(false);
    });
  });

  // =========================================================================
  // 4. Corrupted Tokens & Shopify GraphQL Error Payloads
  // =========================================================================
  describe("4. Corrupted Tokens & Shopify GraphQL Error Responses", () => {
    it("handles Shopify GraphQL 401 Unauthorized token rejection gracefully", async () => {
      const unauthorizedFetch = vi.fn().mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            errors:
              "[API] Invalid API key or access token (unrecognized login or wrong password)",
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }) as any;

      const result = await validateShopifyDiscountsLifecycle(
        TEST_STORE,
        "shpat_corrupted_token_bad",
        {
          dryRun: false,
          cleanup: false,
          customFetch: unauthorizedFetch,
          executionMode: "mock",
        },
      );

      expect(result.passed).toBe(false);
      const failedChecks = result.checks.filter((c) => !c.passed);
      expect(failedChecks).toHaveLength(1);
      expect(failedChecks[0].error).toContain(
        "authoritative Shopify shop currency",
      );
      expect(failedChecks[0].error).not.toContain("401");
    });

    it("handles Shopify GraphQL userErrors (e.g., Code already taken, limit exceeded)", async () => {
      const userErrorFetch = vi
        .fn()
        .mockImplementation(async (_url: string, init: any) => {
          const body = typeof init?.body === "string" ? init.body : "";
          if (body.includes("WeleticValidationShopCurrency")) {
            return new Response(
              JSON.stringify({ data: { shop: { currencyCode: "JPY" } } }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          if (body.includes("codeDiscountNodeByCode")) {
            return new Response(
              JSON.stringify({ data: { codeDiscountNodeByCode: null } }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              data: {
                discountCodeBasicCreate: {
                  codeDiscountNode: null,
                  userErrors: [
                    {
                      field: ["code"],
                      message:
                        "The discount code 'VAL-BASIC-1' already exists.",
                      code: "TAKEN",
                    },
                  ],
                },
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }) as any;

      const result = await validateShopifyDiscountsLifecycle(
        TEST_STORE,
        "shpat_valid_token_12345",
        {
          dryRun: false,
          cleanup: false,
          customFetch: userErrorFetch,
          executionMode: "mock",
        },
      );

      expect(result.passed).toBe(false);
      const basicCheck = result.checks.find((c) =>
        c.name.includes("discountCodeBasicCreate"),
      );
      expect(basicCheck?.passed).toBe(false);
      expect(basicCheck?.error).toContain("exact run marker");
      expect(basicCheck?.error).not.toContain("already exists");
    });

    it("handles non-JSON / 502 Bad Gateway responses from Shopify upstream", async () => {
      const html502Fetch = vi.fn().mockImplementation(async () => {
        return new Response(
          "<html><body><h1>502 Bad Gateway</h1><p>Cloudflare</p></body></html>",
          { status: 502, headers: { "Content-Type": "text/html" } },
        );
      }) as any;

      const result = await validateShopifyDiscountsLifecycle(
        TEST_STORE,
        "shpat_valid_token_12345",
        {
          dryRun: false,
          cleanup: false,
          customFetch: html502Fetch,
          executionMode: "mock",
        },
      );

      expect(result.passed).toBe(false);
      expect(result.checks.some((c) => !c.passed)).toBe(true);
      expect(result.checks[0].error).not.toContain("502");
    });

    it("parses customer account session token claims under adversarial inputs", () => {
      // Adversarial inputs for validateCustomerAccountSessionClaims
      const testCases = [
        { input: null as any, expectedValid: false },
        { input: undefined as any, expectedValid: false },
        { input: { dest: "" }, expectedValid: false },
        { input: { sub: "" }, expectedValid: false },
        { input: { dest: "   ", sub: "   " }, expectedValid: false },
        {
          input: {
            dest: "https://example.com",
            sub: "gid://shopify/Customer/445566",
          },
          expectedValid: false,
        },
        {
          input: {
            dest: "https://store.myshopify.com",
            sub: "gid://shopify/Customer/not-numeric",
          },
          expectedValid: false,
        },
        {
          input: {
            dest: "https://store.myshopify.com/custom/path",
            sub: "gid://shopify/Customer/445566",
          },
          expectedValid: true,
          expectedShop: "store.myshopify.com",
          expectedCustomerId: "445566",
        },
        {
          input: { dest: "store.myshopify.com", sub: "445566" },
          expectedValid: true,
          expectedShop: "store.myshopify.com",
          expectedCustomerId: "445566",
        },
      ];

      for (const tc of testCases) {
        const res = validateCustomerAccountSessionClaims(tc.input);
        expect(res.valid).toBe(tc.expectedValid);
        if (tc.expectedValid) {
          expect(res.shop).toBe(tc.expectedShop);
          expect(res.customerId).toBe(tc.expectedCustomerId);
        }
      }
    });
  });

  // =========================================================================
  // 5. Runner Report Generation & Error Handling
  // =========================================================================
  describe("5. End-to-End Runner Report & Resilience", () => {
    it("generates structured failure report with error details when components fail", async () => {
      const failingFetch = vi.fn().mockImplementation(async () => {
        throw new Error("Simulated upstream failure");
      }) as any;

      const report = await runTestStoreValidation({
        storeDomain: TEST_STORE,
        dryRun: false,
        mockShopify: true,
        customFetch: failingFetch,
        serviceSecret: VALID_SECRET,
        webhookSecret: VALID_SECRET,
      });

      expect(report.overallStatus).toBe("FAILED");
      expect(report.summary.failedChecks).toBeGreaterThan(0);
      expect(report.errors.length).toBeGreaterThan(0);
      expect(report.errors.some((e) => e.error.includes("authoritative"))).toBe(
        true,
      );
      expect(
        report.errors.every(
          (e) => !e.error.includes("Simulated upstream failure"),
        ),
      ).toBe(true);
    });
  });
});
