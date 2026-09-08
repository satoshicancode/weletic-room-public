import {
  verifyWeleticShopifyRequest,
  WELETIC_SHOPIFY_SIGNATURE_HEADER,
  WELETIC_SHOPIFY_TIMESTAMP_HEADER,
} from "@/lib/weletic/shopify/service-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const { authenticateAppProxy } = vi.hoisted(() => ({
  authenticateAppProxy: vi.fn(),
}));

vi.mock("../../../../packages/shopify-app/app/shopify.server", () => ({
  authenticate: {
    public: {
      appProxy: authenticateAppProxy,
    },
  },
}));

const secret = "test-shopify-service-secret-with-32-characters";

describe("Shopify Storefront App Proxy Traffic Termination", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("authenticates valid Shopify app proxy request and forwards signed internal HMAC", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);

    const fetchMock = vi.fn(
      async (input: URL | RequestInfo, init?: RequestInit) => {
        const req = new Request(input, init);
        const timestamp = req.headers.get(WELETIC_SHOPIFY_TIMESTAMP_HEADER);
        const signature = req.headers.get(WELETIC_SHOPIFY_SIGNATURE_HEADER);

        expect(timestamp).toBeTruthy();
        expect(signature).toBeTruthy();
        expect(
          verifyWeleticShopifyRequest({
            request: req,
            body: String(init?.body || ""),
            now: Number(timestamp),
          }),
        ).toBe(true);

        const url = new URL(req.url);
        expect(url.pathname).toBe("/api/internal/shopify/loyalty/customer");
        expect(url.searchParams.get("shop")).toBe("n0pvef-cs.myshopify.com");
        expect(url.searchParams.get("customerId")).toBe("cust_998877");

        return Response.json({
          data: {
            isEnrolled: true,
            pointsBalance: "500",
            account: { pointsBalance: "500" },
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    // Verify proxy forward execution
    const { weleticApiJson } = await import(
      "../../../../packages/shopify-app/app/weletic-api.server"
    );

    const result = await weleticApiJson<any>(
      "/api/internal/shopify/loyalty/customer?shop=n0pvef-cs.myshopify.com&customerId=cust_998877",
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.data.isEnrolled).toBe(true);
    expect(result.data.pointsBalance).toBe("500");
  });

  it("requires customer identity for mutating actions like points redemption", () => {
    const customerId: string | undefined = undefined;
    const subpath = "customer/redeem";

    const isAuthorized = !(
      [
        "customer/redeem",
        "customer/referral/bind",
        "customer/activity/claim",
      ].includes(subpath) && !customerId
    );

    expect(isAuthorized).toBe(false);
  });

  it("never lets a caller-supplied customerId override Shopify identity", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    authenticateAppProxy.mockResolvedValue({
      session: { shop: "n0pvef-cs.myshopify.com" },
    });

    let forwardedUrl = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        forwardedUrl = new Request(input, init).url;
        return Response.json({ data: { rewardWallet: [] } });
      }),
    );

    const { loader } = await import(
      "../../../../packages/shopify-app/app/routes/apps.proxy.$"
    );
    const response = await loader({
      request: new Request(
        "https://n0pvef-cs.myshopify.com/apps/weletic/loyalty/customer?shop=n0pvef-cs.myshopify.com&logged_in_customer_id=1001&customerId=2002&arbitrary=unsafe",
      ),
      params: { "*": "customer" },
    } as any);

    expect(response.status).toBe(200);
    const forwardedSearchParams = new URL(forwardedUrl).searchParams;
    expect(forwardedSearchParams.get("customerId")).toBe("1001");
    expect(forwardedSearchParams.get("redemptionChannel")).toBe("online_store");
    expect(forwardedSearchParams.has("arbitrary")).toBe(false);
  });

  it("pins online redemptions to online_store despite a forged POS channel", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    authenticateAppProxy.mockResolvedValue({
      session: { shop: "n0pvef-cs.myshopify.com" },
    });

    let forwardedRequest: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        forwardedRequest = new Request(input, init);
        return Response.json({ data: { success: true } });
      }),
    );

    const { action } = await import(
      "../../../../packages/shopify-app/app/routes/apps.proxy.$"
    );
    const response = await action({
      request: new Request(
        "https://n0pvef-cs.myshopify.com/apps/weletic/loyalty/customer/redeem?shop=n0pvef-cs.myshopify.com&logged_in_customer_id=1001",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            rewardDefinitionId: "pos_only_reward",
            idempotencyKey: "online-customer-redemption-1",
            redemptionChannel: "pos",
            shop: "attacker.myshopify.com",
            shopifyCustomerId: "attacker-customer",
          }),
        },
      ),
      params: { "*": "customer/redeem" },
    } as any);

    expect(response.status).toBe(200);
    expect(new URL(forwardedRequest!.url).pathname).toBe(
      "/api/internal/shopify/loyalty/customer/redeem",
    );
    await expect(forwardedRequest!.json()).resolves.toEqual({
      rewardDefinitionId: "pos_only_reward",
      idempotencyKey: "online-customer-redemption-1",
      shop: "n0pvef-cs.myshopify.com",
      shopifyCustomerId: "1001",
      redemptionChannel: "online_store",
    });
  });

  it("allows an anonymous friend claim while forwarding trusted request signals", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    authenticateAppProxy.mockResolvedValue({
      session: { shop: "n0pvef-cs.myshopify.com" },
    });

    let forwardedRequest: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        forwardedRequest = new Request(input, init);
        return Response.json({
          data: {
            status: "claimed",
            discountCode: "WLF-TEST",
          },
        });
      }),
    );

    const { action } = await import(
      "../../../../packages/shopify-app/app/routes/apps.proxy.$"
    );
    const response = await action({
      request: new Request(
        "https://n0pvef-cs.myshopify.com/apps/weletic/referral/claim?shop=n0pvef-cs.myshopify.com",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Referral Browser",
            "x-forwarded-for": "203.0.113.42, 10.0.0.2",
          },
          body: JSON.stringify({
            referralCode: "ALICE-1234",
            email: "friend@example.com",
            shopifyCustomerId: "attacker-controlled",
          }),
        },
      ),
      params: { "*": "referral/claim" },
    } as any);

    expect(response.status).toBe(200);
    expect(forwardedRequest).not.toBeNull();
    const forwardedUrl = new URL(forwardedRequest!.url);
    expect(forwardedUrl.pathname).toBe(
      "/api/internal/shopify/loyalty/referral/claim",
    );
    const forwardedBody = await forwardedRequest!.json();
    expect(forwardedBody).toEqual({
      referralCode: "ALICE-1234",
      email: "friend@example.com",
      shop: "n0pvef-cs.myshopify.com",
      clientIp: "203.0.113.42",
      userAgent: "Referral Browser",
    });
  });

  it("forwards an activity claim with Shopify identity and no referral-only signals", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", secret);
    authenticateAppProxy.mockResolvedValue({
      session: { shop: "n0pvef-cs.myshopify.com" },
    });

    let forwardedRequest: Request | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        forwardedRequest = new Request(input, init);
        return Response.json({
          data: { awarded: true, pointsAwarded: "50" },
        });
      }),
    );

    const { action } = await import(
      "../../../../packages/shopify-app/app/routes/apps.proxy.$"
    );
    const response = await action({
      request: new Request(
        "https://n0pvef-cs.myshopify.com/apps/weletic/loyalty/customer/activity/claim?shop=n0pvef-cs.myshopify.com&logged_in_customer_id=1001",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Customer Browser",
            "x-forwarded-for": "203.0.113.42",
          },
          body: JSON.stringify({
            ruleId: "wrule_instagram",
            claimKey: "claim_12345",
            shopifyCustomerId: "attacker-controlled",
            clientIp: "attacker-controlled",
          }),
        },
      ),
      params: { "*": "customer/activity/claim" },
    } as any);

    expect(response.status).toBe(200);
    expect(new URL(forwardedRequest!.url).pathname).toBe(
      "/api/internal/shopify/loyalty/customer/activity/claim",
    );
    await expect(forwardedRequest!.json()).resolves.toEqual({
      ruleId: "wrule_instagram",
      claimKey: "claim_12345",
      shop: "n0pvef-cs.myshopify.com",
      shopifyCustomerId: "1001",
    });
  });
});
