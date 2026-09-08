import { beforeEach, describe, expect, it, vi } from "vitest";

const { shopifyAdminGraphql } = vi.hoisted(() => ({
  shopifyAdminGraphql: vi.fn(),
}));

vi.mock("@/lib/integrations/shopify/admin-graphql", () => ({
  shopifyAdminGraphql,
}));

vi.mock("@dub/utils", () => ({
  APP_DOMAIN_WITH_NGROK: "https://app.example.com",
}));

import { ensureShopifySegmentWebhooksRegistered } from "@/lib/weletic/shopify/provision-webhooks";

describe("Shopify segment webhook provisioning", () => {
  beforeEach(() => {
    shopifyAdminGraphql.mockReset();
  });

  it("registers joined and left topics with the required exact segment filter", async () => {
    const segmentId = "gid://shopify/Segment/123";
    const callbackUrl = "https://example.com/api/shopify/integration/webhook";
    shopifyAdminGraphql.mockImplementation(
      async ({ query, variables }: any) => {
        if (query.includes("WeleticAuditWebhookSubscriptions")) {
          return {
            webhookSubscriptions: {
              nodes: variables.topics.map((topic: string) => ({
                id: `gid://shopify/WebhookSubscription/${topic}`,
                topic,
                format: "JSON",
                uri: callbackUrl,
                filter: `segmentId:\"${segmentId}\"`,
              })),
            },
          };
        }
        return {
          webhookSubscriptionCreate: {
            userErrors: [],
            webhookSubscription: {
              id: `gid://shopify/WebhookSubscription/${variables.topic}`,
              topic: variables.topic,
            },
          },
        };
      },
    );
    const result = await ensureShopifySegmentWebhooksRegistered({
      shopDomain: "store.myshopify.com",
      accessToken: "token",
      segmentId,
      callbackUrl,
    });

    expect(result.success).toBe(true);
    expect(shopifyAdminGraphql).toHaveBeenCalledTimes(3);
    expect(
      shopifyAdminGraphql.mock.calls
        .filter(([request]) => request.variables.topic)
        .map(([request]) => request.variables.topic),
    ).toEqual(["CUSTOMER_JOINED_SEGMENT", "CUSTOMER_LEFT_SEGMENT"]);
    for (const [request] of shopifyAdminGraphql.mock.calls.slice(0, 2)) {
      expect(request.apiVersion).toBe("2026-07");
      expect(request.variables.webhookSubscription).toMatchObject({
        uri: callbackUrl,
        format: "JSON",
        filter: `segmentId:\"${segmentId}\"`,
      });
    }
    expect(shopifyAdminGraphql.mock.calls[2]?.[0].query).toContain("filter");
  });

  it("fails closed when a duplicate segment subscription has a different filter", async () => {
    const segmentId = "gid://shopify/Segment/123";
    const callbackUrl = "https://example.com/api/shopify/integration/webhook";
    shopifyAdminGraphql.mockImplementation(
      async ({ query, variables }: any) => {
        if (query.includes("WeleticAuditWebhookSubscriptions")) {
          return {
            webhookSubscriptions: {
              nodes: variables.topics.map((topic: string, index: number) => ({
                id: `gid://shopify/WebhookSubscription/${topic}`,
                topic,
                format: "JSON",
                uri: callbackUrl,
                filter:
                  index === 0
                    ? 'segmentId:"gid://shopify/Segment/another"'
                    : `segmentId:\"${segmentId}\"`,
              })),
            },
          };
        }
        return {
          webhookSubscriptionCreate: {
            userErrors: [
              { field: ["uri"], message: "Address has already been taken" },
            ],
            webhookSubscription: null,
          },
        };
      },
    );

    const result = await ensureShopifySegmentWebhooksRegistered({
      shopDomain: "store.myshopify.com",
      accessToken: "token",
      segmentId,
      callbackUrl,
    });

    expect(result.success).toBe(false);
    expect(result.skipped).toEqual(["CUSTOMER_LEFT_SEGMENT"]);
    expect(result.failed).toEqual([
      expect.objectContaining({
        topic: "CUSTOMER_JOINED_SEGMENT",
        error: expect.stringContaining("could not be verified"),
      }),
    ]);
  });

  it("fails closed when Shopify cannot audit exact segment subscriptions", async () => {
    shopifyAdminGraphql.mockImplementation(
      async ({ query, variables }: any) => {
        if (query.includes("WeleticAuditWebhookSubscriptions")) {
          throw new Error("audit unavailable");
        }
        return {
          webhookSubscriptionCreate: {
            userErrors: [],
            webhookSubscription: {
              id: `gid://shopify/WebhookSubscription/${variables.topic}`,
              topic: variables.topic,
            },
          },
        };
      },
    );

    const result = await ensureShopifySegmentWebhooksRegistered({
      shopDomain: "store.myshopify.com",
      accessToken: "token",
      segmentId: "gid://shopify/Segment/123",
      callbackUrl: "https://example.com/api/shopify/integration/webhook",
    });

    expect(result.success).toBe(false);
    expect(result.registered).toEqual([]);
    expect(result.failed).toHaveLength(2);
    expect(result.failed[0]?.error).toContain(
      "Exact segment webhook subscription audit failed",
    );
  });
});
