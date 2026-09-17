import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { z } from "zod";
import { SHOPIFY_CANONICAL_WEBHOOK_TOPICS } from "./provision-webhooks";
import { resolvePublicShopifyWebhookCallback } from "./public-webhook-policy";

const responseSchema = z.object({
  webhookSubscriptions: z.object({
    nodes: z
      .array(
        z.object({
          id: z.string().regex(/^gid:\/\/shopify\/WebhookSubscription\/\d+$/),
          topic: z.enum(SHOPIFY_CANONICAL_WEBHOOK_TOPICS),
          uri: z.string(),
          format: z.string(),
          filter: z.string().nullable(),
        }),
      )
      .max(250),
    pageInfo: z.object({ hasNextPage: z.boolean() }),
  }),
});

/** Read-only, bounded shop-scoped inventory for the supplied public credential.
 * Not a deletion plan: app-scoped TOML coverage cannot be proved by this query.
 * Never exposes credentials or callback URLs (including obsolete tunnel URLs).
 */
export async function auditPublicShopifyWebhooks({
  shopDomain,
  accessToken,
}: {
  shopDomain: string;
  accessToken: string;
}) {
  const callback = resolvePublicShopifyWebhookCallback(process.env);
  if (!callback)
    throw new Error("Public webhook audit requires public runtime");
  const result = responseSchema.parse(
    await shopifyAdminGraphql({
      shopifyStoreId: shopDomain,
      accessToken,
      apiVersion: "2026-07",
      allowSdkFallback: false,
      query: `#graphql
      query WeleticPublicWebhookOverlapAudit($topics: [WebhookSubscriptionTopic!]) {
        webhookSubscriptions(first: 250, topics: $topics) {
          nodes { id topic uri format filter }
          pageInfo { hasNextPage }
        }
      }
    `,
      variables: { topics: [...SHOPIFY_CANONICAL_WEBHOOK_TOPICS] },
    }),
  );
  return {
    complete: !result.webhookSubscriptions.pageInfo.hasNextPage,
    credentialAppIdentity: "not_verified" as const,
    appConfigurationCoverage: "not_verified" as const,
    cleanupAuthorized: false as const,
    subscriptions: result.webhookSubscriptions.nodes.map((entry) => ({
      id: entry.id,
      topic: entry.topic,
      matchesConfiguredCallback: entry.uri === callback,
      jsonFormat: entry.format === "JSON",
      unfiltered: entry.filter === null || entry.filter === "",
    })),
  };
}
