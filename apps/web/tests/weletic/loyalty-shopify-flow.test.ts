import {
  buildKlaviyoProfileAttributes,
  buildOmnisendProfileAttributes,
  sanitizeNonPiiProperties,
} from "@/lib/weletic/loyalty/esp-payload-formatters";
import {
  dispatchShopifyFlowTrigger,
  SHOPIFY_FLOW_MAX_PAYLOAD_BYTES,
  SHOPIFY_FLOW_TRIGGER_HANDLES,
  ShopifyFlowDispatchError,
  validateAndNormalizeFlowPayload,
} from "@/lib/weletic/loyalty/flow-triggers";
import { FlowTriggerPayloadSchema } from "@/lib/weletic/loyalty/outbox";
import { describe, expect, it, vi } from "vitest";

const asFetch = (implementation: ReturnType<typeof vi.fn>) =>
  implementation as unknown as typeof fetch;

describe("native Shopify Flow contracts", () => {
  it("uses the four immutable published handles", () => {
    expect(Object.values(SHOPIFY_FLOW_TRIGGER_HANDLES)).toEqual([
      "weletic-points-earned",
      "weletic-vip-tier-changed",
      "weletic-reward-redeemed",
      "weletic-points-expiring-soon",
    ]);
  });

  it("maps point events to exact Flow keys without losing BigInt precision", () => {
    const payload = validateAndNormalizeFlowPayload(
      SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED,
      {
        customerGid: "gid://shopify/Customer/123456789",
        pointsDelta: BigInt("9007199254740993"),
        pointsBalance: BigInt("9007199254741000"),
        reason: "order_purchase",
        orderId: null,
      },
    );

    expect(payload).toEqual({
      customer_id: 123456789,
      "Points delta": "9007199254740993",
      "Points balance": "9007199254741000",
      Reason: "order_purchase",
      "Order id": "",
    });
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(
      SHOPIFY_FLOW_MAX_PAYLOAD_BYTES,
    );
  });

  it("maps tier, reward, and expiry payloads to manifest field names", () => {
    expect(
      validateAndNormalizeFlowPayload(
        SHOPIFY_FLOW_TRIGGER_HANDLES.VIP_TIER_CHANGED,
        {
          customerGid: "Customer/42",
          previousTier: "Silver",
          newTier: "Gold",
          multiplier: "1.5",
        },
      ),
    ).toEqual({
      customer_id: 42,
      "Previous tier": "Silver",
      "New tier": "Gold",
      Multiplier: "1.5",
    });
    expect(
      validateAndNormalizeFlowPayload(
        SHOPIFY_FLOW_TRIGGER_HANDLES.REWARD_REDEEMED,
        {
          customerGid: "42",
          rewardType: "amount_off",
          discountCode: "SAVE-10",
          pointsSpent: "1000",
        },
      ),
    ).toMatchObject({ customer_id: 42, "Points spent": "1000" });
    expect(
      validateAndNormalizeFlowPayload(
        SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EXPIRING_SOON,
        {
          customerGid: "42",
          pointsExpiring: "500",
          expiryDate: "2026-12-01T00:00:00+00:00",
          urgency: "last_chance",
        },
      ),
    ).toMatchObject({
      customer_id: 42,
      "Points expiring": "500",
      "Expiry date": "2026-12-01T00:00:00.000Z",
      Urgency: "last_chance",
    });
  });

  it("rejects nonnumeric and unsafe Shopify customer references", () => {
    const base = {
      pointsDelta: 1,
      pointsBalance: 1,
      reason: "test",
    };
    expect(() =>
      validateAndNormalizeFlowPayload(
        SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED,
        { ...base, customerGid: "gid://shopify/Customer/not-a-number" },
      ),
    ).toThrow();
    expect(() =>
      validateAndNormalizeFlowPayload(
        SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED,
        { ...base, customerGid: "9007199254740993" },
      ),
    ).toThrow(/safe integer/);
  });

  it("dispatches exact payloads through the production GraphQL service", async () => {
    const customFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { flowTriggerReceive: { userErrors: [] } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await dispatchShopifyFlowTrigger({
      shopDomain: "shop.myshopify.com",
      offlineToken: "test-token",
      handle: SHOPIFY_FLOW_TRIGGER_HANDLES.REWARD_REDEEMED,
      payload: {
        customerGid: "42",
        rewardType: "amount_off",
        discountCode: "SAVE-10",
        pointsSpent: "1000",
      },
      customFetch: asFetch(customFetch),
    });

    expect(result.success).toBe(true);
    const request = customFetch.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      variables: { handle: string; payload: Record<string, unknown> };
    };
    expect(body.variables.handle).toBe("weletic-reward-redeemed");
    expect(body.variables.payload.customer_id).toBe(42);
  });

  it("classifies terminal client failures and transient transport failures", async () => {
    const terminalFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            flowTriggerReceive: {
              userErrors: [{ field: ["handle"], message: "Unknown handle" }],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const request = {
      shopDomain: "shop.myshopify.com",
      offlineToken: "test-token",
      handle: SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED,
      payload: {
        customerGid: "42",
        pointsDelta: "10",
        pointsBalance: "20",
        reason: "test",
      },
    } as const;

    await expect(
      dispatchShopifyFlowTrigger({
        ...request,
        customFetch: asFetch(terminalFetch),
      }),
    ).rejects.toMatchObject({ retryable: false });

    const missingFetch = vi
      .fn()
      .mockResolvedValue(new Response("Not found", { status: 404 }));
    await expect(
      dispatchShopifyFlowTrigger({
        ...request,
        customFetch: asFetch(missingFetch),
      }),
    ).rejects.toMatchObject({ retryable: false });

    const networkFetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(
      dispatchShopifyFlowTrigger({
        ...request,
        customFetch: asFetch(networkFetch),
      }),
    ).rejects.toMatchObject({
      retryable: true,
    } satisfies Partial<ShopifyFlowDispatchError>);
  });

  it("validates durable outbox events before persistence", () => {
    expect(
      FlowTriggerPayloadSchema.parse({
        accountId: "wacc_1",
        handle: SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED,
        pointsDelta: "25",
        pointsBalance: "100",
        reason: "order_purchase",
      }),
    ).toBeTruthy();
    expect(
      FlowTriggerPayloadSchema.safeParse({
        accountId: "wacc_1",
        handle: "weletic.loyalty.points_earned",
      }).success,
    ).toBe(false);
  });

  it.each([
    { code: "INTERNAL_SERVER_ERROR", retryable: true },
    { code: "THROTTLED", retryable: true },
    { code: "ACCESS_DENIED", retryable: false },
    { code: "GRAPHQL_VALIDATION_FAILED", retryable: false },
  ])(
    "classifies HTTP 200 GraphQL $code as retryable=$retryable",
    async ({ code, retryable }) => {
      const customFetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [
              { message: "GraphQL request failed", extensions: { code } },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

      await expect(
        dispatchShopifyFlowTrigger({
          shopDomain: "shop.myshopify.com",
          offlineToken: "test-token",
          handle: SHOPIFY_FLOW_TRIGGER_HANDLES.POINTS_EARNED,
          payload: {
            customerGid: "42",
            pointsDelta: "10",
            pointsBalance: "20",
            reason: "test",
          },
          customFetch: asFetch(customFetch),
        }),
      ).rejects.toMatchObject({ retryable });
      expect(customFetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe("deferred ESP payload formatters", () => {
  it("retains only pure, PII-filtered payload formatting", () => {
    expect(
      sanitizeNonPiiProperties({
        email: "private@example.com",
        phoneNumber: "+8100000000",
        segment: "loyal",
      }),
    ).toEqual({ segment: "loyal" });
    expect(
      buildKlaviyoProfileAttributes({
        pointsBalance: BigInt("9007199254740993"),
      }).$points_balance,
    ).toBe("9007199254740993");
    expect(
      buildOmnisendProfileAttributes({ pointsBalance: 250 }).points_balance,
    ).toBe(250);
  });
});
