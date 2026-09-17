import { auditPublicShopifyWebhooks } from "@/lib/weletic/shopify/audit-public-webhooks";
import {
  ensureShopifyWebhooksRegistered,
  SHOPIFY_CANONICAL_WEBHOOK_TOPICS,
} from "@/lib/weletic/shopify/provision-webhooks";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  PUBLIC_LOYALTY_API_ORIGIN,
  PUBLIC_LOYALTY_APP_ORIGIN,
  PUBLIC_LOYALTY_CLIENT_ID,
} from "../../../../packages/shopify-app/app/public-runtime-policy.mjs";

const transport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/integrations/shopify/admin-graphql", () => ({
  shopifyAdminGraphql: transport,
}));
const callback = `${PUBLIC_LOYALTY_API_ORIGIN}/api/shopify/integration/webhook`;
const args = {
  shopDomain: "synthetic.myshopify.com",
  accessToken: "synthetic-token",
};
beforeEach(() => {
  transport.mockReset();
  for (const [key, value] of Object.entries({
    SHOPIFY_API_KEY: PUBLIC_LOYALTY_CLIENT_ID,
    SHOPIFY_APP_URL: PUBLIC_LOYALTY_APP_ORIGIN,
    NEXT_PUBLIC_APP_DOMAIN: PUBLIC_LOYALTY_API_ORIGIN,
    SHOPIFY_WEBHOOK_URL: callback,
    DEV_WEBHOOK_URL: "",
    WELETIC_ISOLATED_DEVELOPMENT: "",
    WELETIC_SHOPIFY_PREVIEW: "",
    WELETIC_PREVIEW_APP_ORIGIN: "",
    WELETIC_PREVIEW_API_ORIGIN: "",
    NODE_ENV: "production",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => vi.unstubAllEnvs());

it("delegates canonical ownership without creating or claiming verified subscriptions", async () => {
  expect(await ensureShopifyWebhooksRegistered(args)).toEqual({
    success: true,
    managedBy: "app_configuration",
    callbackUrl: callback,
    registered: [],
    skipped: [],
    failed: [],
  });
  expect(transport).not.toHaveBeenCalled();
});

it("keeps all canonical topics declared in the public manifest", () => {
  const toml = readFileSync(
    "../../packages/shopify-app/shopify.app.loyalty-public.toml",
    "utf8",
  );
  const topics = toml.match(/^topics = \[(.*)\]$/m)?.[1];
  expect(topics).toBeDefined();
  const actual = JSON.parse(`[${topics}]`) as string[];
  expect(
    actual.map((topic) => topic.replaceAll("/", "_").toUpperCase()).sort(),
  ).toEqual([...SHOPIFY_CANONICAL_WEBHOOK_TOPICS].sort());
});

it("also delegates canonical topics in the isolated CLI preview", async () => {
  const api = "https://synthetic-api.trycloudflare.com";
  for (const [key, value] of Object.entries({
    WELETIC_SHOPIFY_PREVIEW: "1",
    WELETIC_ISOLATED_DEVELOPMENT: "1",
    WELETIC_PREVIEW_APP_ORIGIN: "https://synthetic-app.trycloudflare.com",
    WELETIC_PREVIEW_API_ORIGIN: api,
    SHOPIFY_APP_URL: "https://synthetic-app.trycloudflare.com",
    NEXT_PUBLIC_APP_DOMAIN: "http://app.localhost:8890",
    NEXTAUTH_URL: "http://app.localhost:8890",
    SHOPIFY_WEBHOOK_URL: `${api}/api/shopify/integration/webhook`,
    NODE_ENV: "development",
  }))
    vi.stubEnv(key, value);
  expect(await ensureShopifyWebhooksRegistered(args)).toMatchObject({
    managedBy: "app_configuration",
    registered: [],
    skipped: [],
  });
  expect(transport).not.toHaveBeenCalled();
});

it("propagates audit transport failure without inventing an empty inventory", async () => {
  transport.mockRejectedValue(new Error("transport unavailable"));
  await expect(auditPublicShopifyWebhooks(args)).rejects.toThrow(
    "transport unavailable",
  );
});

const entry = {
  id: "gid://shopify/WebhookSubscription/1",
  topic: "ORDERS_PAID",
  uri: callback,
  format: "JSON",
  filter: null,
};
it.each([false, true])(
  "audits without mutation and reports truncation=%s",
  async (hasNextPage) => {
    transport.mockResolvedValue({
      webhookSubscriptions: {
        nodes: [
          entry,
          {
            ...entry,
            id: "gid://shopify/WebhookSubscription/2",
            uri: "https://old.example/private?secret=not-to-output",
            filter: "private-filter",
            format: "XML",
          },
        ],
        pageInfo: { hasNextPage },
      },
    });
    const result = await auditPublicShopifyWebhooks(args);
    expect(result.complete).toBe(!hasNextPage);
    expect(result.credentialAppIdentity).toBe("not_verified");
    expect(result.appConfigurationCoverage).toBe("not_verified");
    expect(result.cleanupAuthorized).toBe(false);
    expect(result.subscriptions[0]).toMatchObject({
      matchesConfiguredCallback: true,
      jsonFormat: true,
      unfiltered: true,
    });
    expect(result.subscriptions[1]).toMatchObject({
      matchesConfiguredCallback: false,
      jsonFormat: false,
      unfiltered: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private|secret|synthetic-token/,
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toMatchObject({
      allowSdkFallback: false,
      shopifyStoreId: args.shopDomain,
      accessToken: args.accessToken,
    });
    expect(transport.mock.calls[0][0].query).not.toMatch(
      /mutation|webhookSubscriptionCreate|webhookSubscriptionDelete/,
    );
  },
);

it("does not infer completeness from a malformed response", async () => {
  transport.mockResolvedValue({ webhookSubscriptions: { nodes: [entry] } });
  await expect(auditPublicShopifyWebhooks(args)).rejects.toThrow();
});

it("rejects a mismatched public identity before any transport", async () => {
  vi.stubEnv("SHOPIFY_API_KEY", "custom-app");
  await expect(auditPublicShopifyWebhooks(args)).rejects.toThrow(
    "Unsafe public Shopify webhook configuration",
  );
  expect(transport).not.toHaveBeenCalled();
});
