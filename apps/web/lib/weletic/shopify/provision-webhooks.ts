import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { APP_DOMAIN_WITH_NGROK } from "@dub/utils";
import { resolvePublicShopifyWebhookCallback } from "./public-webhook-policy";

export const SHOPIFY_CANONICAL_WEBHOOK_TOPICS = [
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
] as const;

export type ShopifyCanonicalWebhookTopic =
  (typeof SHOPIFY_CANONICAL_WEBHOOK_TOPICS)[number];

export function resolveShopifyWebhookCallbackUrl(customUrl?: string): string {
  const publicCallback = resolvePublicShopifyWebhookCallback(
    process.env,
    customUrl,
  );
  if (publicCallback !== null) return publicCallback;
  const legacyCallback = resolveLegacyWebhookCallbackUrl(customUrl);
  // Legacy normalization and preview fallbacks can introduce a public host
  // that was absent from the raw configuration. Validate the effective target.
  return (
    resolvePublicShopifyWebhookCallback(process.env, legacyCallback) ??
    legacyCallback
  );
}

function resolveLegacyWebhookCallbackUrl(customUrl?: string): string {
  if (customUrl) return customUrl;
  if (process.env.DEV_WEBHOOK_URL) {
    return `${process.env.DEV_WEBHOOK_URL.replace(/\/+$/, "")}/api/shopify/integration/webhook`;
  }
  if (process.env.NODE_ENV === "development") {
    return "https://dev-webhook.weletic.com/api/shopify/integration/webhook";
  }
  const appDomain = process.env.NEXT_PUBLIC_APP_DOMAIN;
  const baseUrl = appDomain
    ? appDomain.startsWith("http://") || appDomain.startsWith("https://")
      ? appDomain
      : `https://${appDomain}`
    : APP_DOMAIN_WITH_NGROK;
  return `${baseUrl.replace(/\/+$/, "")}/api/shopify/integration/webhook`;
}

export interface ProvisionWebhooksResult {
  success: boolean;
  callbackUrl: string;
  registered: string[];
  skipped: string[];
  failed: Array<{ topic: string; error: string }>;
}

const SEGMENT_WEBHOOK_TOPICS = [
  "CUSTOMER_JOINED_SEGMENT",
  "CUSTOMER_LEFT_SEGMENT",
] as const;

const CREATE_WEBHOOK_MUTATION = `#graphql
  mutation WeleticCreateWebhook($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
      userErrors {
        field
        message
      }
      webhookSubscription {
        id
        topic
      }
    }
  }
`;

const AUDIT_WEBHOOK_SUBSCRIPTIONS_QUERY = `#graphql
  query WeleticAuditWebhookSubscriptions($first: Int!, $topics: [WebhookSubscriptionTopic!]) {
    webhookSubscriptions(first: $first, topics: $topics) {
      nodes {
        id
        topic
        format
        uri
        filter
      }
    }
  }
`;

type AuditedWebhookSubscription = {
  id: string;
  topic: string;
  format: string;
  uri: string;
  filter: string | null;
};

async function auditExactWebhookSubscriptions({
  shopDomain,
  accessToken,
  callbackUrl,
  topics,
  expectedFilters,
  allowSdkFallback = true,
}: {
  shopDomain: string;
  accessToken: string;
  callbackUrl: string;
  topics: readonly string[];
  expectedFilters?: ReadonlyMap<string, string | null>;
  allowSdkFallback?: boolean;
}) {
  if (topics.length === 0) return new Set<string>();
  const response = await shopifyAdminGraphql<{
    webhookSubscriptions: { nodes: AuditedWebhookSubscription[] } | null;
  }>({
    shopifyStoreId: shopDomain,
    accessToken,
    apiVersion: "2026-07",
    query: AUDIT_WEBHOOK_SUBSCRIPTIONS_QUERY,
    variables: { first: 250, topics },
    allowSdkFallback,
  });
  const nodes = response.webhookSubscriptions?.nodes;
  if (!Array.isArray(nodes)) {
    throw new Error("Shopify returned no auditable webhook subscriptions.");
  }
  return new Set(
    nodes
      .filter(
        (node) =>
          topics.includes(node.topic) &&
          node.format === "JSON" &&
          node.uri === callbackUrl &&
          node.filter === (expectedFilters?.get(node.topic) ?? null),
      )
      .map(({ topic }) => topic),
  );
}

/**
 * Automatically provisions all canonical Shopify webhook subscriptions
 * for any workspace / store, ensuring multi-tenant coverage and strict idempotency.
 */
export async function ensureShopifyWebhooksRegistered({
  shopDomain,
  accessToken,
  callbackUrl: explicitCallbackUrl,
  allowSdkFallback = true,
}: {
  shopDomain: string;
  accessToken: string;
  callbackUrl?: string;
  /** Disable when the caller holds installation/session locks: SDK recovery
   * needs those locks and must not substitute a different credential. */
  allowSdkFallback?: boolean;
}): Promise<ProvisionWebhooksResult> {
  const callbackUrl = resolveShopifyWebhookCallbackUrl(explicitCallbackUrl);
  const registered: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ topic: string; error: string }> = [];

  for (const topic of SHOPIFY_CANONICAL_WEBHOOK_TOPICS) {
    try {
      const response = await shopifyAdminGraphql<{
        webhookSubscriptionCreate: {
          userErrors: Array<{ field: string[]; message: string }>;
          webhookSubscription: { id: string; topic: string } | null;
        };
      }>({
        shopifyStoreId: shopDomain,
        accessToken,
        apiVersion: "2026-07",
        query: CREATE_WEBHOOK_MUTATION,
        allowSdkFallback,
        variables: {
          topic,
          webhookSubscription: {
            uri: callbackUrl,
            format: "JSON",
          },
        },
      });

      const userErrors = response.webhookSubscriptionCreate?.userErrors ?? [];
      const isAlreadyTaken = userErrors.some((err) => {
        const msg = err.message?.toLowerCase() || "";
        return (
          msg.includes("already been taken") ||
          msg.includes("already exists") ||
          msg.includes("has already been taken")
        );
      });

      if (
        response.webhookSubscriptionCreate?.webhookSubscription?.topic === topic
      ) {
        registered.push(topic);
      } else if (response.webhookSubscriptionCreate?.webhookSubscription) {
        failed.push({
          topic,
          error: "Shopify confirmed a different webhook topic.",
        });
      } else if (isAlreadyTaken) {
        skipped.push(topic);
      } else if (userErrors.length > 0) {
        failed.push({
          topic,
          error: userErrors.map((e) => e.message).join("; "),
        });
      } else {
        failed.push({
          topic,
          error: "Empty or invalid response from Shopify Webhook API",
        });
      }
    } catch (err) {
      failed.push({
        topic,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const candidates = [...registered, ...skipped];
  if (candidates.length > 0) {
    try {
      const verified = await auditExactWebhookSubscriptions({
        shopDomain,
        accessToken,
        callbackUrl,
        topics: candidates,
        allowSdkFallback,
      });
      for (const topic of candidates) {
        if (!verified.has(topic)) {
          failed.push({
            topic,
            error:
              "Exact JSON webhook subscription for the canonical callback could not be verified.",
          });
        }
      }
      for (let index = registered.length - 1; index >= 0; index--) {
        if (!verified.has(registered[index])) registered.splice(index, 1);
      }
      for (let index = skipped.length - 1; index >= 0; index--) {
        if (!verified.has(skipped[index])) skipped.splice(index, 1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const topic of candidates) {
        failed.push({
          topic,
          error: `Exact webhook subscription audit failed: ${message}`,
        });
      }
      registered.length = 0;
      skipped.length = 0;
    }
  }

  const success =
    failed.length === 0 &&
    registered.length + skipped.length ===
      SHOPIFY_CANONICAL_WEBHOOK_TOPICS.length;
  return {
    success,
    callbackUrl,
    registered,
    skipped,
    failed,
  };
}

export async function ensureShopifySegmentWebhooksRegistered({
  shopDomain,
  accessToken,
  segmentId,
  callbackUrl: explicitCallbackUrl,
}: {
  shopDomain: string;
  accessToken: string;
  segmentId: string;
  callbackUrl?: string;
}): Promise<ProvisionWebhooksResult> {
  const callbackUrl = resolveShopifyWebhookCallbackUrl(explicitCallbackUrl);
  const registered: string[] = [];
  const skipped: string[] = [];
  const failed: Array<{ topic: string; error: string }> = [];
  const segmentFilter = `segmentId:\"${segmentId}\"`;

  for (const topic of SEGMENT_WEBHOOK_TOPICS) {
    try {
      const response = await shopifyAdminGraphql<{
        webhookSubscriptionCreate: {
          userErrors: Array<{ field: string[]; message: string }>;
          webhookSubscription: { id: string; topic: string } | null;
        };
      }>({
        shopifyStoreId: shopDomain,
        accessToken,
        apiVersion: "2026-07",
        query: CREATE_WEBHOOK_MUTATION,
        variables: {
          topic,
          webhookSubscription: {
            uri: callbackUrl,
            format: "JSON",
            filter: segmentFilter,
          },
        },
      });
      const userErrors = response.webhookSubscriptionCreate?.userErrors ?? [];
      const alreadyRegistered = userErrors.some((error) =>
        /already (been taken|exists)|has already been taken/i.test(
          error.message,
        ),
      );
      if (
        response.webhookSubscriptionCreate?.webhookSubscription?.topic === topic
      ) {
        registered.push(topic);
      } else if (response.webhookSubscriptionCreate?.webhookSubscription) {
        failed.push({
          topic,
          error: "Shopify confirmed a different webhook topic.",
        });
      } else if (alreadyRegistered) {
        skipped.push(topic);
      } else {
        failed.push({
          topic,
          error:
            userErrors.map((error) => error.message).join("; ") ||
            "Empty or invalid response from Shopify Webhook API",
        });
      }
    } catch (error) {
      failed.push({
        topic,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const candidates = [...registered, ...skipped];
  if (candidates.length > 0) {
    try {
      const verified = await auditExactWebhookSubscriptions({
        shopDomain,
        accessToken,
        callbackUrl,
        topics: candidates,
        expectedFilters: new Map(
          candidates.map((topic) => [topic, segmentFilter]),
        ),
      });
      for (const topic of candidates) {
        if (!verified.has(topic)) {
          failed.push({
            topic,
            error:
              "Exact filtered JSON webhook subscription for the segment callback could not be verified.",
          });
        }
      }
      for (let index = registered.length - 1; index >= 0; index--) {
        if (!verified.has(registered[index])) registered.splice(index, 1);
      }
      for (let index = skipped.length - 1; index >= 0; index--) {
        if (!verified.has(skipped[index])) skipped.splice(index, 1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const topic of candidates) {
        failed.push({
          topic,
          error: `Exact segment webhook subscription audit failed: ${message}`,
        });
      }
      registered.length = 0;
      skipped.length = 0;
    }
  }

  return {
    success:
      failed.length === 0 &&
      registered.length + skipped.length === SEGMENT_WEBHOOK_TOPICS.length,
    callbackUrl,
    registered,
    skipped,
    failed,
  };
}
