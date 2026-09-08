import * as adminGraphqlModule from "@/lib/integrations/shopify/admin-graphql";
import {
  SHOPIFY_CANONICAL_WEBHOOK_TOPICS,
  ensureShopifyWebhooksRegistered,
  resolveShopifyWebhookCallbackUrl,
} from "@/lib/weletic/shopify/provision-webhooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("Requirement R1: Multi-Tenant Automated Webhook Provisioning", () => {
  const originalEnv = { ...process.env };

  function auditedSubscriptions(topics: readonly string[]) {
    return {
      webhookSubscriptions: {
        nodes: topics.map((topic) => ({
          id: `gid://shopify/WebhookSubscription/audit_${topic}`,
          topic,
          format: "JSON",
          uri: resolveShopifyWebhookCallbackUrl(),
          filter: null,
        })),
      },
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("1. Canonical Topics Definition", () => {
    it("exports the complete canonical webhook topic set", () => {
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toHaveLength(16);
      expect(SHOPIFY_CANONICAL_WEBHOOK_TOPICS).toEqual([
        "PRODUCTS_CREATE",
        "PRODUCTS_UPDATE",
        "PRODUCTS_DELETE",
        "MARKETS_CREATE",
        "MARKETS_UPDATE",
        "MARKETS_DELETE",
        "ORDERS_PAID",
        "ORDERS_FULFILLED",
        "ORDERS_CANCELLED",
        "CUSTOMERS_CREATE",
        "CUSTOMERS_UPDATE",
        "REFUNDS_CREATE",
        "DISCOUNTS_CREATE",
        "DISCOUNTS_UPDATE",
        "DISCOUNTS_DELETE",
        "APP_UNINSTALLED",
      ]);
    });
  });

  describe("2. Dynamic Callback URL Resolution", () => {
    it("respects explicit customUrl override", () => {
      const custom = "https://custom-webhook-target.com/api/shopify/webhook";
      const resolved = resolveShopifyWebhookCallbackUrl(custom);
      expect(resolved).toBe(custom);
    });

    it("prioritizes DEV_WEBHOOK_URL when provided", () => {
      delete (process.env as any).NODE_ENV;
      process.env.DEV_WEBHOOK_URL = "https://my-ngrok-tunnel.ngrok.io/";
      const resolved = resolveShopifyWebhookCallbackUrl();
      expect(resolved).toBe(
        "https://my-ngrok-tunnel.ngrok.io/api/shopify/integration/webhook",
      );
    });

    it("resolves to dev tunnel domain in development mode when DEV_WEBHOOK_URL is not set", () => {
      delete process.env.DEV_WEBHOOK_URL;
      (process.env as any).NODE_ENV = "development";
      const resolved = resolveShopifyWebhookCallbackUrl();
      expect(resolved).toBe(
        "https://dev-webhook.weletic.com/api/shopify/integration/webhook",
      );
    });

    it("resolves to NEXT_PUBLIC_APP_DOMAIN in production mode", () => {
      delete process.env.DEV_WEBHOOK_URL;
      (process.env as any).NODE_ENV = "production";
      process.env.NEXT_PUBLIC_APP_DOMAIN = "app.weletic.com";
      const resolved = resolveShopifyWebhookCallbackUrl();
      expect(resolved).toBe(
        "https://app.weletic.com/api/shopify/integration/webhook",
      );
    });

    it("handles NEXT_PUBLIC_APP_DOMAIN that already includes https protocol", () => {
      delete process.env.DEV_WEBHOOK_URL;
      (process.env as any).NODE_ENV = "production";
      process.env.NEXT_PUBLIC_APP_DOMAIN = "https://dashboard.weletic.com";
      const resolved = resolveShopifyWebhookCallbackUrl();
      expect(resolved).toBe(
        "https://dashboard.weletic.com/api/shopify/integration/webhook",
      );
    });
  });

  describe("3. Webhook Registration & GraphQL Execution", () => {
    it("successfully registers all canonical topics on a fresh Shopify store", async () => {
      const graphqlSpy = vi
        .spyOn(adminGraphqlModule, "shopifyAdminGraphql")
        .mockImplementation(async ({ query, variables }: any) => {
          if (query.includes("WeleticAuditWebhookSubscriptions")) {
            return auditedSubscriptions(variables.topics) as any;
          }
          return {
            webhookSubscriptionCreate: {
              userErrors: [],
              webhookSubscription: {
                id: `gid://shopify/WebhookSubscription/12345_${variables?.topic}`,
                topic: variables?.topic,
              },
            },
          } as any;
        });

      const result = await ensureShopifyWebhooksRegistered({
        shopDomain: "yamaxdev.myshopify.com",
        accessToken: "shpat_valid_test_token_123",
      });

      expect(result.success).toBe(true);
      expect(result.registered).toHaveLength(16);
      expect(result.registered).toEqual(SHOPIFY_CANONICAL_WEBHOOK_TOPICS);
      expect(result.skipped).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(graphqlSpy).toHaveBeenCalledTimes(17);

      // Verify the variables passed to GraphQL
      expect(graphqlSpy).toHaveBeenNthCalledWith(
        16,
        expect.objectContaining({
          shopifyStoreId: "yamaxdev.myshopify.com",
          accessToken: "shpat_valid_test_token_123",
          variables: expect.objectContaining({
            topic: "APP_UNINSTALLED",
            webhookSubscription: expect.objectContaining({
              uri: resolveShopifyWebhookCallbackUrl(),
              format: "JSON",
            }),
          }),
          apiVersion: "2026-07",
        }),
      );
    });
  });

  describe("4. Idempotency & Duplicate Handling (already been taken)", () => {
    it("gracefully classifies already-taken subscriptions as skipped without throwing error", async () => {
      const graphqlSpy = vi
        .spyOn(adminGraphqlModule, "shopifyAdminGraphql")
        .mockImplementation(async ({ query, variables }: any) => {
          if (query.includes("WeleticAuditWebhookSubscriptions")) {
            return auditedSubscriptions(variables.topics) as any;
          }
          return {
            webhookSubscriptionCreate: {
              userErrors: [
                {
                  field: ["webhookSubscription", "callbackUrl"],
                  message: `Address for this topic has already been taken: ${variables?.topic}`,
                },
              ],
              webhookSubscription: null,
            },
          } as any;
        });

      const result = await ensureShopifyWebhooksRegistered({
        shopDomain: "yamaxdev.myshopify.com",
        accessToken: "shpat_reinstall_token_456",
      });

      expect(result.success).toBe(true);
      expect(result.registered).toHaveLength(0);
      expect(result.skipped).toHaveLength(16);
      expect(result.skipped).toEqual(SHOPIFY_CANONICAL_WEBHOOK_TOPICS);
      expect(result.failed).toHaveLength(0);
      expect(graphqlSpy).toHaveBeenCalledTimes(17);
    });

    it("handles mixed results: some registered, some skipped, some failed", async () => {
      vi.spyOn(adminGraphqlModule, "shopifyAdminGraphql").mockImplementation(
        async ({ query, variables }: any) => {
          if (query.includes("WeleticAuditWebhookSubscriptions")) {
            return auditedSubscriptions(variables.topics) as any;
          }
          const topic = variables?.topic;
          if (topic === "PRODUCTS_CREATE" || topic === "ORDERS_PAID") {
            return {
              webhookSubscriptionCreate: {
                userErrors: [],
                webhookSubscription: {
                  id: `gid://shopify/WebhookSubscription/${topic}`,
                  topic,
                },
              },
            } as any;
          }

          if (topic === "DISCOUNTS_DELETE") {
            return {
              webhookSubscriptionCreate: {
                userErrors: [
                  {
                    field: ["topic"],
                    message: "Webhook topic is not allowed for this app scope",
                  },
                ],
                webhookSubscription: null,
              },
            } as any;
          }

          return {
            webhookSubscriptionCreate: {
              userErrors: [
                {
                  field: ["callbackUrl"],
                  message: "has already been taken",
                },
              ],
              webhookSubscription: null,
            },
          } as any;
        },
      );

      const result = await ensureShopifyWebhooksRegistered({
        shopDomain: "yamaxdev.myshopify.com",
        accessToken: "shpat_mixed_token_789",
      });

      expect(result.success).toBe(false);
      expect(result.registered).toEqual(["PRODUCTS_CREATE", "ORDERS_PAID"]);
      expect(result.skipped).toHaveLength(13);
      expect(result.failed).toEqual([
        {
          topic: "DISCOUNTS_DELETE",
          error: "Webhook topic is not allowed for this app scope",
        },
      ]);
    });

    it("fails closed when Shopify's duplicate response points to another callback", async () => {
      vi.spyOn(adminGraphqlModule, "shopifyAdminGraphql").mockImplementation(
        async ({ query, variables }: any) => {
          if (query.includes("WeleticAuditWebhookSubscriptions")) {
            const audit = auditedSubscriptions(variables.topics);
            audit.webhookSubscriptions.nodes[0].uri =
              "https://another-app.example/webhooks";
            return audit as any;
          }
          return {
            webhookSubscriptionCreate: {
              userErrors: [
                { field: ["callbackUrl"], message: "has already been taken" },
              ],
              webhookSubscription: null,
            },
          } as any;
        },
      );

      const result = await ensureShopifyWebhooksRegistered({
        shopDomain: "yamaxdev.myshopify.com",
        accessToken: "shpat_duplicate_wrong_callback",
      });

      expect(result.success).toBe(false);
      expect(result.skipped).toHaveLength(15);
      expect(result.failed).toEqual([
        expect.objectContaining({
          topic: SHOPIFY_CANONICAL_WEBHOOK_TOPICS[0],
          error: expect.stringContaining("could not be verified"),
        }),
      ]);
    });
  });

  describe("5. Fault Tolerance & Exception Handling", () => {
    it("catches network and server exceptions without interrupting other topics", async () => {
      let callCount = 0;
      vi.spyOn(adminGraphqlModule, "shopifyAdminGraphql").mockImplementation(
        async ({ query, variables }: any) => {
          callCount++;
          if (query.includes("WeleticAuditWebhookSubscriptions")) {
            return auditedSubscriptions(variables.topics) as any;
          }
          if (variables?.topic === "PRODUCTS_UPDATE") {
            throw new Error("HTTP 502 Bad Gateway from Shopify Admin");
          }
          return {
            webhookSubscriptionCreate: {
              userErrors: [],
              webhookSubscription: {
                id: `gid://shopify/WebhookSubscription/${variables?.topic}`,
                topic: variables?.topic,
              },
            },
          } as any;
        },
      );

      const result = await ensureShopifyWebhooksRegistered({
        shopDomain: "yamaxdev.myshopify.com",
        accessToken: "shpat_network_error_token",
      });

      expect(callCount).toBe(17);
      expect(result.success).toBe(false);
      expect(result.registered).toHaveLength(15);
      expect(result.failed).toEqual([
        {
          topic: "PRODUCTS_UPDATE",
          error: "HTTP 502 Bad Gateway from Shopify Admin",
        },
      ]);
    });

    it("handles empty GraphQL response payload safely", async () => {
      vi.spyOn(adminGraphqlModule, "shopifyAdminGraphql").mockResolvedValue({
        webhookSubscriptionCreate: null as any,
      } as any);

      const result = await ensureShopifyWebhooksRegistered({
        shopDomain: "yamaxdev.myshopify.com",
        accessToken: "shpat_empty_response",
      });

      expect(result.success).toBe(false);
      expect(result.registered).toHaveLength(0);
      expect(result.failed).toHaveLength(16);
      expect(result.failed[0].error).toContain("Empty or invalid response");
    });
  });
});
