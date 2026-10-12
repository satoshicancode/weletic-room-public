import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatPosRewardValue,
  isPosReward,
  isPosWalletReward,
  posWalletArtifactCode,
} from "../../../../packages/shopify-app/extensions/weletic-pos-loyalty/src/Modal";

const { authenticatePos } = vi.hoisted(() => ({
  authenticatePos: vi.fn(),
}));

vi.mock("../../../../packages/shopify-app/app/shopify.server", () => ({
  authenticate: {
    public: {
      pos: authenticatePos,
    },
  },
}));

const serviceSecret = "test-shopify-service-secret-with-32-characters";

describe("Shopify POS loyalty extension", () => {
  const extensionDir = path.resolve(
    __dirname,
    "../../../../packages/shopify-app/extensions/weletic-pos-loyalty",
  );

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("declares Shopify POS tile and modal targets", () => {
    const manifest = fs.readFileSync(
      path.join(extensionDir, "shopify.extension.toml"),
      "utf8",
    );
    expect(manifest).toContain('target = "pos.home.tile.render"');
    expect(manifest).toContain('target = "pos.home.modal.render"');
    expect(manifest).toContain('api_version = "2026-10"');
  });

  it("only presents amount and percentage rewards enabled for POS", () => {
    const base = {
      id: "reward-1",
      name: "POS reward",
      pointsCost: "500",
      discountValue: 1000,
      canRedeem: true,
    } as const;
    expect(
      isPosReward({
        ...base,
        rewardType: "amount_off",
        salesChannel: "pos",
      }),
    ).toBe(true);
    expect(
      isPosReward({
        ...base,
        rewardType: "percentage_off",
        salesChannel: "both",
      }),
    ).toBe(true);
    expect(
      isPosReward({
        ...base,
        rewardType: "amount_off",
        salesChannel: "online_store",
      }),
    ).toBe(false);
  });

  it("never exposes store-credit references as POS codes", () => {
    expect(
      posWalletArtifactCode({
        id: "credit-1",
        rewardName: "Store credit",
        artifactKind: "store_credit",
        artifactCode: "internal-reference",
        discountCode: "legacy-reference",
        status: "available",
      }),
    ).toBeNull();
    expect(
      posWalletArtifactCode({
        id: "discount-1",
        rewardName: "POS discount",
        artifactKind: "discount_code",
        artifactCode: "WLPOS123",
        status: "available",
      }),
    ).toBe("WLPOS123");
  });

  it("keeps issued POS coupons usable after their catalog definition is archived", () => {
    expect(
      isPosWalletReward({
        id: "archived-definition-coupon",
        rewardDefinitionId: "archived-reward",
        rewardName: "Archived POS reward",
        salesChannel: "pos",
        artifactKind: "discount_code",
        artifactCode: "WLPOS-ARCHIVED",
        status: "available",
      }),
    ).toBe(true);
    expect(
      isPosWalletReward({
        id: "online-coupon",
        rewardName: "Online reward",
        salesChannel: "online_store",
        artifactKind: "discount_code",
        artifactCode: "WL-ONLINE",
        status: "available",
      }),
    ).toBe(false);
  });

  it("formats POS reward economics from integer minor units", () => {
    expect(
      formatPosRewardValue(
        {
          id: "amount-1",
          name: "$10 off",
          rewardType: "amount_off",
          salesChannel: "pos",
          pointsCost: "500",
          discountValue: 1000,
          canRedeem: true,
        },
        "USD",
      ),
    ).toBe("$10.00");
    expect(
      formatPosRewardValue(
        {
          id: "percent-1",
          name: "15% off",
          rewardType: "percentage_off",
          salesChannel: "pos",
          pointsCost: "500",
          discountValue: 15,
          canRedeem: true,
        },
        "USD",
      ),
    ).toBe("15% off");
  });

  it("authenticates the POS gateway and pins catalog and redemption traffic to POS", async () => {
    vi.stubEnv("WELETIC_API_URL", "https://app.weletic.com");
    vi.stubEnv("WELETIC_SHOPIFY_SERVICE_SECRET", serviceSecret);
    authenticatePos.mockResolvedValue({
      sessionToken: { dest: "https://pos-shop.myshopify.com" },
      cors: (response: Response) => response,
    });

    const forwardedRequests: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        forwardedRequests.push(new Request(input, init));
        return Response.json({ data: { rewards: [] } });
      }),
    );

    const { action, loader } = await import(
      "../../../../packages/shopify-app/app/routes/api.pos.loyalty"
    );
    const { createPosCustomerBindingToken, verifyPosCustomerBindingToken } =
      await import("../../../../packages/shopify-app/app/pos-binding.server");
    const loaderResponse = await loader({
      request: new Request(
        "https://shopify.weletic.com/api/pos/loyalty?customerId=1001",
      ),
      params: {},
    } as any);
    const loaderData = (await loaderResponse.json()) as any;
    expect(loaderData.customerBindingToken).toBeDefined();
    const validToken = loaderData.customerBindingToken;

    const actionResponse = await action({
      request: new Request("https://shopify.weletic.com/api/pos/loyalty", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shopifyCustomerId: "1001",
          customerBindingToken: validToken,
          rewardDefinitionId: "reward_pos",
          idempotencyKey: "trusted-pos-redemption-1",
          redemptionChannel: "online_store",
        }),
      }),
      params: {},
    } as any);

    expect(loaderResponse.status).toBe(200);
    expect(actionResponse.status).toBe(200);
    expect(
      new URL(forwardedRequests[0].url).searchParams.get("redemptionChannel"),
    ).toBe("pos");
    await expect(forwardedRequests[1].json()).resolves.toMatchObject({
      shop: "pos-shop.myshopify.com",
      shopifyCustomerId: "1001",
      rewardDefinitionId: "reward_pos",
      redemptionChannel: "pos",
    });

    // Fails closed if token is missing
    const missingTokenResponse = await action({
      request: new Request("https://shopify.weletic.com/api/pos/loyalty", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shopifyCustomerId: "1001",
          rewardDefinitionId: "reward_pos",
          idempotencyKey: "untrusted-pos-redemption-missing",
        }),
      }),
      params: {},
    } as any);
    expect(missingTokenResponse.status).toBe(403);
    const missingBody = (await missingTokenResponse.json()) as any;
    expect(missingBody.error.code).toBe("invalid_customer_binding");

    // Fails closed if customerId does not match token (caller spoofing attempt)
    const spoofedCustomerResponse = await action({
      request: new Request("https://shopify.weletic.com/api/pos/loyalty", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shopifyCustomerId: "9999",
          customerBindingToken: validToken,
          rewardDefinitionId: "reward_pos",
          idempotencyKey: "untrusted-pos-redemption-spoof",
        }),
      }),
      params: {},
    } as any);
    expect(spoofedCustomerResponse.status).toBe(403);
    const spoofedBody = (await spoofedCustomerResponse.json()) as any;
    expect(spoofedBody.error.code).toBe("invalid_customer_binding");

    // Fails closed if signature is tampered
    const tamperedResponse = await action({
      request: new Request("https://shopify.weletic.com/api/pos/loyalty", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          shopifyCustomerId: "1001",
          customerBindingToken: `${validToken.slice(0, -6)}ffffff`,
          rewardDefinitionId: "reward_pos",
          idempotencyKey: "untrusted-pos-redemption-tamper",
        }),
      }),
      params: {},
    } as any);
    expect(tamperedResponse.status).toBe(403);
    const tamperedBody = (await tamperedResponse.json()) as any;
    expect(tamperedBody.error.code).toBe("invalid_customer_binding");
  });

  it("fails closed in production environment when service secret is missing", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevSecret = process.env.WELETIC_SHOPIFY_SERVICE_SECRET;
    const prevShopifySecret = process.env.SHOPIFY_API_SECRET;

    try {
      (process.env as any).NODE_ENV = "production";
      delete (process.env as any).WELETIC_SHOPIFY_SERVICE_SECRET;
      delete (process.env as any).SHOPIFY_API_SECRET;

      const { createPosCustomerBindingToken } = await import(
        "../../../../packages/shopify-app/app/pos-binding.server"
      );

      expect(() =>
        createPosCustomerBindingToken("shop.myshopify.com", "cust_123"),
      ).toThrow("Missing POS customer binding secret in production environment");
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevSecret) process.env.WELETIC_SHOPIFY_SERVICE_SECRET = prevSecret;
      if (prevShopifySecret) process.env.SHOPIFY_API_SECRET = prevShopifySecret;
    }
  });
});
