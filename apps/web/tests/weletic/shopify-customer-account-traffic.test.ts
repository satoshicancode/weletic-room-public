import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authenticateCustomerAccount } = vi.hoisted(() => ({
  authenticateCustomerAccount: vi.fn(),
}));

vi.mock("../../../../packages/shopify-app/app/shopify.server", () => ({
  authenticate: {
    public: {
      customerAccount: authenticateCustomerAccount,
    },
  },
}));

const serviceSecret = "test-shopify-service-secret-with-32-characters";

describe("Shopify New Customer Account Token Claim Validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function validateCustomerAccountClaims(sessionToken: {
    dest?: string;
    sub?: string;
  }) {
    if (!sessionToken?.dest || !sessionToken?.sub) {
      return { valid: false, error: "Missing dest or sub claims" };
    }

    let shop: string;
    try {
      const url = new URL(
        sessionToken.dest.startsWith("http")
          ? sessionToken.dest
          : `https://${sessionToken.dest}`,
      );
      shop = url.hostname.toLowerCase();
    } catch {
      shop = sessionToken.dest.toLowerCase().trim();
    }

    let customerId = sessionToken.sub;
    if (customerId.startsWith("gid://shopify/Customer/")) {
      customerId = customerId.replace("gid://shopify/Customer/", "");
    }

    if (!shop || !customerId) {
      return { valid: false, error: "Unable to normalize shop or customerId" };
    }

    return { valid: true, shop, customerId };
  }

  it("validates and extracts shop and customerId from Customer Account claims", () => {
    const claims = {
      dest: "https://n0pvef-cs.myshopify.com",
      sub: "gid://shopify/Customer/123456789",
    };

    const result = validateCustomerAccountClaims(claims);
    expect(result.valid).toBe(true);
    expect(result.shop).toBe("n0pvef-cs.myshopify.com");
    expect(result.customerId).toBe("123456789");
  });

  it("rejects token claims missing dest or sub", () => {
    expect(
      validateCustomerAccountClaims({ sub: "gid://shopify/Customer/123" })
        .valid,
    ).toBe(false);
    expect(
      validateCustomerAccountClaims({ dest: "https://n0pvef-cs.myshopify.com" })
        .valid,
    ).toBe(false);
    expect(validateCustomerAccountClaims({}).valid).toBe(false);
  });

  it("binds each authenticated request to its own customer wallet", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", serviceSecret);

    authenticateCustomerAccount.mockImplementation(
      async (request: Request) => ({
        sessionToken: {
          dest: "https://n0pvef-cs.myshopify.com",
          sub: `gid://shopify/Customer/${request.headers.get("x-test-customer-id")}`,
        },
        cors: (response: Response) => response,
      }),
    );

    const forwardedCustomerIds: string[] = [];
    const forwardedRedemptionChannels: string[] = [];
    const forwardedRequestIds: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const forwarded = new Request(input, init);
        const customerId = new URL(forwarded.url).searchParams.get(
          "customerId",
        );
        forwardedCustomerIds.push(String(customerId));
        forwardedRedemptionChannels.push(
          String(new URL(forwarded.url).searchParams.get("redemptionChannel")),
        );
        forwardedRequestIds.push(
          String(forwarded.headers.get("x-weletic-request-id")),
        );
        return Response.json(
          {
            data: {
              rewardWallet: [
                {
                  id: `reward-${customerId}`,
                  discountCode: `WL-${customerId}`,
                },
              ],
            },
          },
          { headers: { "Server-Timing": "core_total;dur=12.5" } },
        );
      }),
    );

    const { loader } = await import(
      "../../../../packages/shopify-app/app/routes/api.customer-account.$"
    );
    const loadForCustomer = async (customerId: string) => {
      const response = await loader({
        request: new Request(
          "https://shopify.weletic.com/api/customer-account/loyalty/customer",
          { headers: { "x-test-customer-id": customerId } },
        ),
        params: { "*": "customer" },
      } as any);
      return { response, body: await response.json() };
    };

    const customerA = await loadForCustomer("1001");
    const customerB = await loadForCustomer("2002");

    expect(forwardedCustomerIds).toEqual(["1001", "2002"]);
    expect(forwardedRedemptionChannels).toEqual([
      "online_store",
      "online_store",
    ]);
    expect(customerA.body.data.rewardWallet).toEqual([
      { id: "reward-1001", discountCode: "WL-1001" },
    ]);
    expect(customerB.body.data.rewardWallet).toEqual([
      { id: "reward-2002", discountCode: "WL-2002" },
    ]);
    expect(JSON.stringify(customerA.body)).not.toContain("WL-2002");
    expect(JSON.stringify(customerB.body)).not.toContain("WL-1001");
    expect(forwardedRequestIds).toHaveLength(2);
    expect(forwardedRequestIds[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(customerA.response.headers.get("x-weletic-request-id")).toBe(
      forwardedRequestIds[0],
    );
    expect(customerA.response.headers.get("Server-Timing")).toContain(
      "core_total;dur=12.5",
    );
    expect(customerA.response.headers.get("Server-Timing")).toContain(
      "shopify_gateway;dur=",
    );
  });

  it("pins authenticated online redemptions to online_store", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", serviceSecret);
    authenticateCustomerAccount.mockResolvedValue({
      sessionToken: {
        dest: "https://n0pvef-cs.myshopify.com",
        sub: "gid://shopify/Customer/1001",
      },
      cors: (response: Response) => response,
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
      "../../../../packages/shopify-app/app/routes/api.customer-account.$"
    );
    const response = await action({
      request: new Request(
        "https://shopify.weletic.com/api/customer-account/loyalty/customer/redeem",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            rewardDefinitionId: "pos_only_reward",
            idempotencyKey: "customer-account-redemption-1",
            redemptionChannel: "pos",
            shop: "attacker.myshopify.com",
            shopifyCustomerId: "attacker-customer",
          }),
        },
      ),
      params: { "*": "customer/redeem" },
    } as any);

    expect(response.status).toBe(200);
    await expect(forwardedRequest!.json()).resolves.toEqual({
      rewardDefinitionId: "pos_only_reward",
      idempotencyKey: "customer-account-redemption-1",
      shop: "n0pvef-cs.myshopify.com",
      shopifyCustomerId: "1001",
      redemptionChannel: "online_store",
    });
  });
});
