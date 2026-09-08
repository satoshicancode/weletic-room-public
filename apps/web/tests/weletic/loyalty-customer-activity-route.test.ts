import {
  signWeleticShopifyRequest,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
} from "@/lib/weletic/shopify/service-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storeFindUnique: vi.fn(),
  limit: vi.fn(),
  claim: vi.fn(),
  resolveStore: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: mocks.storeFindUnique },
  },
}));

vi.mock("@/lib/upstash", () => ({
  ratelimit: vi.fn(() => ({ limit: mocks.limit })),
}));

vi.mock("@/lib/weletic/loyalty/earning-actions", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/weletic/loyalty/earning-actions")
  >("@/lib/weletic/loyalty/earning-actions");
  return { ...actual, claimCustomerIntentActivity: mocks.claim };
});

vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  resolveShopifyStoreByDomain: mocks.resolveStore,
}));

const secret = "test-shopify-service-secret-with-32-characters";

function signedRequest(body: Record<string, unknown>, signature = true) {
  const bodyText = JSON.stringify(body);
  const timestamp = String(Date.now());
  const path =
    "/api/internal/shopify/loyalty/customer/activity/claim?shop=test-shop.myshopify.com";
  return new Request(`https://app.weletic.com${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [WELETIC_SHOPIFY_TIMESTAMP_HEADER]: timestamp,
      [WELETIC_SHOPIFY_SIGNATURE_HEADER]: signature
        ? signWeleticShopifyRequest({
            timestamp,
            method: "POST",
            path,
            body: bodyText,
            secret,
          })
        : "0".repeat(64),
    },
    body: bodyText,
  });
}

describe("customer activity claim internal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    mocks.resolveStore.mockResolvedValue({ storeId: "store_1" });
    mocks.storeFindUnique.mockResolvedValue({ id: "store_1" });
    mocks.limit.mockResolvedValue({ success: true });
    mocks.claim.mockResolvedValue({
      awarded: true,
      pointsAwarded: "50",
      pointsBalance: "150",
      ruleId: "wrule_1",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a request without the trusted gateway signature", async () => {
    const { POST } = await import(
      "../../app/api/internal/shopify/loyalty/customer/activity/claim/route"
    );
    const response = await POST(
      signedRequest(
        {
          shop: "test-shop.myshopify.com",
          shopifyCustomerId: "1001",
          ruleId: "wrule_1",
          claimKey: "claim_12345",
        },
        false,
      ),
    );
    expect(response.status).toBe(401);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it("rate-limits the verified customer and forwards only validated fields", async () => {
    const { POST } = await import(
      "../../app/api/internal/shopify/loyalty/customer/activity/claim/route"
    );
    const response = await POST(
      signedRequest({
        shop: "test-shop.myshopify.com",
        shopifyCustomerId: "1001",
        ruleId: "wrule_1",
        claimKey: "claim_12345",
      }),
    );

    expect(response.status).toBe(200);
    expect(mocks.limit).toHaveBeenCalledOnce();
    expect(String(mocks.limit.mock.calls[0][0])).not.toContain("1001");
    expect(mocks.claim).toHaveBeenCalledWith({
      storeId: "store_1",
      shopifyCustomerId: "1001",
      ruleId: "wrule_1",
      claimKey: "claim_12345",
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { awarded: true, pointsAwarded: "50" },
    });
  });

  it("fails closed when abuse-rate-limit storage is unavailable", async () => {
    mocks.limit.mockRejectedValue(new Error("redis unavailable"));
    const { POST } = await import(
      "../../app/api/internal/shopify/loyalty/customer/activity/claim/route"
    );
    const response = await POST(
      signedRequest({
        shop: "test-shop.myshopify.com",
        shopifyCustomerId: "1001",
        ruleId: "wrule_1",
        claimKey: "claim_12345",
      }),
    );
    expect(response.status).toBe(503);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
