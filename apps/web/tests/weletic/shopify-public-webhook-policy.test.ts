import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PUBLIC_LOYALTY_API_ORIGIN,
  PUBLIC_LOYALTY_APP_ORIGIN,
  PUBLIC_LOYALTY_CLIENT_ID,
} from "../../../../packages/shopify-app/app/public-runtime-policy.mjs";
import {
  ensureShopifySegmentWebhooksRegistered,
  ensureShopifyWebhooksRegistered,
  resolveShopifyWebhookCallbackUrl,
} from "../../lib/weletic/shopify/provision-webhooks";
import { resolvePublicShopifyWebhookCallback } from "../../lib/weletic/shopify/public-webhook-policy";

const transport = vi.hoisted(() => vi.fn());
const legacy = vi.hoisted(() => ({ fallback: "https://legacy.example" }));
vi.mock("@dub/utils", () => ({
  get APP_DOMAIN_WITH_NGROK() {
    return legacy.fallback;
  },
}));
vi.mock("@/lib/integrations/shopify/admin-graphql", () => ({
  shopifyAdminGraphql: transport,
}));

const callback = `${PUBLIC_LOYALTY_API_ORIGIN}/api/shopify/integration/webhook`;
function fixture(): Record<string, string> {
  return {
    SHOPIFY_API_KEY: PUBLIC_LOYALTY_CLIENT_ID,
    SHOPIFY_APP_URL: PUBLIC_LOYALTY_APP_ORIGIN,
    NEXT_PUBLIC_APP_DOMAIN: PUBLIC_LOYALTY_API_ORIGIN,
    SHOPIFY_WEBHOOK_URL: callback,
    DEV_WEBHOOK_URL: "",
    WELETIC_ISOLATED_DEVELOPMENT: "",
    NODE_ENV: "production",
  };
}
function configure(env = fixture()) {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}
beforeEach(() => {
  transport.mockReset();
  legacy.fallback = "https://legacy.example";
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("public webhook callback routing", () => {
  it("uses the reviewed explicit configuration even in NODE_ENV development", () => {
    configure({ ...fixture(), NODE_ENV: "development" });
    expect(resolveShopifyWebhookCallbackUrl()).toBe(callback);
    expect(resolveShopifyWebhookCallbackUrl(callback)).toBe(callback);
  });

  it.each([
    ["SHOPIFY_API_KEY", ""],
    ["SHOPIFY_API_KEY", "custom-app"],
    ["SHOPIFY_APP_URL", "https://shopify.weletic.com"],
    ["NEXT_PUBLIC_APP_DOMAIN", "https://app.weletic.com"],
    ["NEXT_PUBLIC_APP_DOMAIN", `${PUBLIC_LOYALTY_API_ORIGIN}/wrong`],
    ["SHOPIFY_WEBHOOK_URL", ""],
    [
      "SHOPIFY_WEBHOOK_URL",
      "https://app.weletic.com/api/shopify/integration/webhook",
    ],
    [
      "SHOPIFY_WEBHOOK_URL",
      "http://app.localhost:8890/api/shopify/integration/webhook",
    ],
    ["SHOPIFY_WEBHOOK_URL", `${callback}?query=secret`],
    ["SHOPIFY_WEBHOOK_URL", `${callback}#fragment`],
    ["SHOPIFY_WEBHOOK_URL", `${callback}/`],
    ["SHOPIFY_WEBHOOK_URL", `${PUBLIC_LOYALTY_API_ORIGIN}/other`],
    [
      "SHOPIFY_WEBHOOK_URL",
      "https://user:secret@loyalty-api-dev.weletic.com/api/shopify/integration/webhook",
    ],
    ["DEV_WEBHOOK_URL", "https://dev-webhook.weletic.com"],
    ["WELETIC_ISOLATED_DEVELOPMENT", "1"],
    ["WELETIC_ISOLATED_DEVELOPMENT", "true"],
  ])(
    "rejects unsafe %s for both provisioning paths before transport",
    async (key, value) => {
      configure({ ...fixture(), [key]: value });
      await expect(
        ensureShopifyWebhooksRegistered({
          shopDomain: "synthetic.myshopify.com",
          accessToken: "synthetic-token",
        }),
      ).rejects.toThrow(/^Unsafe public Shopify webhook configuration$/);
      await expect(
        ensureShopifySegmentWebhooksRegistered({
          shopDomain: "synthetic.myshopify.com",
          accessToken: "synthetic-token",
          segmentId: "gid://shopify/Segment/1",
        }),
      ).rejects.toThrow(/^Unsafe public Shopify webhook configuration$/);
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "https://app.weletic.com/api/shopify/integration/webhook",
    `${callback}?override=1`,
  ])("rejects explicit override %j", (override) => {
    configure();
    expect(() => resolveShopifyWebhookCallbackUrl(override)).toThrow(
      "Unsafe public Shopify webhook configuration",
    );
  });

  it("requires public identity when any public endpoint selects this policy", () => {
    for (const key of [
      "SHOPIFY_APP_URL",
      "SHOPIFY_WEBHOOK_URL",
      "NEXT_PUBLIC_APP_DOMAIN",
      "DEV_WEBHOOK_URL",
    ]) {
      expect(() =>
        resolvePublicShopifyWebhookCallback({ [key]: callback }),
      ).toThrow();
    }
    expect(() => resolvePublicShopifyWebhookCallback({}, callback)).toThrow();
  });

  it("preserves custom explicit and development fallback behavior", () => {
    configure({
      ...fixture(),
      SHOPIFY_API_KEY: "custom",
      SHOPIFY_APP_URL: "https://shopify.weletic.com",
      SHOPIFY_WEBHOOK_URL: "",
      NEXT_PUBLIC_APP_DOMAIN: "https://app.weletic.com",
      NODE_ENV: "development",
    });
    expect(resolveShopifyWebhookCallbackUrl()).toBe(
      "https://dev-webhook.weletic.com/api/shopify/integration/webhook",
    );
    expect(
      resolveShopifyWebhookCallbackUrl("https://legacy.example/callback"),
    ).toBe("https://legacy.example/callback");
  });

  it.each(["scheme_less_domain", "preview_fallback", "trailing_dot"])(
    "rejects public endpoints introduced by legacy normalization: %s",
    async (source) => {
      configure({
        ...fixture(),
        SHOPIFY_API_KEY: "custom-app",
        SHOPIFY_APP_URL: "https://shopify.weletic.com",
        SHOPIFY_WEBHOOK_URL: "",
        NEXT_PUBLIC_APP_DOMAIN:
          source === "scheme_less_domain" ? "loyalty-api-dev.weletic.com" : "",
      });
      // Synthetic resolved value of APP_DOMAIN_WITH_NGROK; covers any source
      // (ngrok/preview/default) without duplicating the upstream resolver.
      if (source === "preview_fallback")
        legacy.fallback = PUBLIC_LOYALTY_API_ORIGIN;
      if (source === "trailing_dot")
        legacy.fallback = `${PUBLIC_LOYALTY_API_ORIGIN}.`;
      const args = {
        shopDomain: "synthetic.myshopify.com",
        accessToken: "synthetic-token",
      };
      await expect(ensureShopifyWebhooksRegistered(args)).rejects.toThrow(
        "Unsafe public Shopify webhook configuration",
      );
      await expect(
        ensureShopifySegmentWebhooksRegistered({
          ...args,
          segmentId: "gid://shopify/Segment/1",
        }),
      ).rejects.toThrow("Unsafe public Shopify webhook configuration");
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "sends and audits only the public URI (segment=%s)",
    async (segment) => {
      configure();
      const filter = segment ? 'segmentId:"gid://shopify/Segment/1"' : null;
      transport.mockImplementation(async ({ query, variables }) => {
        if (query.includes("WeleticAuditWebhookSubscriptions"))
          return {
            webhookSubscriptions: {
              nodes: variables.topics.map((topic: string) => ({
                topic,
                uri: callback,
                format: "JSON",
                filter,
              })),
            },
          };
        return {
          webhookSubscriptionCreate: {
            userErrors: [],
            webhookSubscription: { topic: variables.topic },
          },
        };
      });
      const args = {
        shopDomain: "synthetic.myshopify.com",
        accessToken: "synthetic-token",
      };
      const result = segment
        ? await ensureShopifySegmentWebhooksRegistered({
            ...args,
            segmentId: "gid://shopify/Segment/1",
          })
        : await ensureShopifyWebhooksRegistered(args);
      expect(result.success).toBe(true);
      expect(result.callbackUrl).toBe(callback);
      const mutations = transport.mock.calls.filter(
        ([request]) => request.variables.webhookSubscription,
      );
      expect(mutations).toHaveLength(segment ? 2 : 16);
      for (const [request] of mutations)
        expect(request.variables.webhookSubscription.uri).toBe(callback);
    },
  );
});
