import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { getWeleticShopifyInstallation } from "./get-installation";

const numericShopifyId = (value: string | number) =>
  String(value).split("/").pop() ?? String(value);

const collectionGid = (value: string) => {
  if (/^gid:\/\/shopify\/Collection\/\d+$/.test(value)) return value;
  return /^\d+$/.test(value) ? `gid://shopify/Collection/${value}` : null;
};

const chunk = <T>(values: T[], size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );

// Keep membership requests compact even for unusually large orders/configs.
const PRODUCT_BATCH_SIZE = 100;
const COLLECTION_BATCH_SIZE = 50;
const GRAPHQL_CONCURRENCY = 3;

async function mapWithConcurrency<T>(
  values: T[],
  worker: (value: T) => Promise<void>,
) {
  let nextIndex = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(GRAPHQL_CONCURRENCY, values.length) },
      async () => {
        while (nextIndex < values.length) {
          const value = values[nextIndex++];
          await worker(value);
        }
      },
    ),
  );
}

type SellingPlanCategory =
  | "SUBSCRIPTION"
  | "PRE_ORDER"
  | "TRY_BEFORE_YOU_BUY"
  | "OTHER";

interface ShopifyConnectionPage<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface RawOrderLineContext {
  id: string;
  product: { id: string; tags: string[] } | null;
  variant: { id: string } | null;
  sellingPlan: { sellingPlanId: string | null; name: string } | null;
}

export interface ShopifyOrderLineContext {
  lineItemId: string;
  sellingPlanId: string | null;
  sellingPlanName: string | null;
  sellingPlanCategory: SellingPlanCategory | null;
  subscriptionSeriesKey: string | null;
  collectionExternalIds: string[];
  productTags: string[];
}

export async function getShopifyOrderLineContext({
  workspaceId,
  orderId,
  relevantCollectionIds = [],
}: {
  workspaceId: string;
  orderId: string | number;
  relevantCollectionIds?: string[];
}) {
  const installation = await getWeleticShopifyInstallation(workspaceId);
  const orderGid = `gid://shopify/Order/${numericShopifyId(orderId)}`;
  const orderLines: RawOrderLineContext[] = [];
  let after: string | null = null;

  do {
    const data = await shopifyAdminGraphql<{
      order: {
        lineItems: ShopifyConnectionPage<RawOrderLineContext>;
      } | null;
    }>({
      shopifyStoreId: installation.shopDomain,
      accessToken: installation.accessToken,
      apiVersion: "2026-07",
      query: `#graphql
        query WeleticOrderLineContext($orderId: ID!, $after: String) {
          order(id: $orderId) {
            lineItems(first: 250, after: $after) {
              nodes {
                id
                product { id tags }
                variant { id }
                sellingPlan { sellingPlanId name }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
        }
      `,
      variables: { orderId: orderGid, after },
    });
    if (!data.order) break;
    orderLines.push(...data.order.lineItems.nodes);
    after = data.order.lineItems.pageInfo.hasNextPage
      ? data.order.lineItems.pageInfo.endCursor
      : null;
  } while (after);

  const productIds = [
    ...new Set(
      orderLines
        .map((line) => line.product?.id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const collectionIds = [
    ...new Set(
      relevantCollectionIds
        .map(collectionGid)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const collectionsByProduct = new Map<string, Set<string>>(
    productIds.map((id) => [id, new Set<string>()]),
  );
  const sellingPlanIds = [
    ...new Set(
      orderLines
        .map((line) => line.sellingPlan?.sellingPlanId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const sellingPlanCategories = new Map<string, SellingPlanCategory>();
  for (const sellingPlanBatch of chunk(sellingPlanIds, 250)) {
    const data = await shopifyAdminGraphql<{
      nodes: Array<{
        id: string;
        category: SellingPlanCategory | null;
      } | null>;
    }>({
      shopifyStoreId: installation.shopDomain,
      accessToken: installation.accessToken,
      apiVersion: "2026-07",
      query: `#graphql
          query WeleticSellingPlanCategories($sellingPlanIds: [ID!]!) {
            nodes(ids: $sellingPlanIds) {
              ... on SellingPlan { id category }
            }
          }
        `,
      variables: { sellingPlanIds: sellingPlanBatch },
    });
    for (const node of data.nodes) {
      if (node?.category) sellingPlanCategories.set(node.id, node.category);
    }
  }

  // Product.inCollection is an exact scalar lookup. Batching both dimensions
  // avoids the one-request-per-product waterfall while fetching only the
  // memberships that can affect settlement.
  const membershipBatches = chunk(productIds, PRODUCT_BATCH_SIZE).flatMap(
    (productBatch) =>
      chunk(collectionIds, COLLECTION_BATCH_SIZE).map((collectionBatch) => ({
        productBatch,
        collectionBatch,
      })),
  );
  await mapWithConcurrency(
    membershipBatches,
    async ({ productBatch, collectionBatch }) => {
      const declarations = collectionBatch
        .map((_, index) => `$collectionId${index}: ID!`)
        .join(", ");
      const selections = collectionBatch
        .map(
          (_, index) =>
            `collection${index}: inCollection(id: $collectionId${index})`,
        )
        .join("\n");
      const variables = Object.fromEntries(
        collectionBatch.map((id, index) => [`collectionId${index}`, id]),
      );
      const data = await shopifyAdminGraphql<{
        nodes: Array<
          ({ id: string } & Record<string, string | boolean>) | null
        >;
      }>({
        shopifyStoreId: installation.shopDomain,
        accessToken: installation.accessToken,
        apiVersion: "2026-07",
        query: `#graphql
          query WeleticProductCollectionMemberships(
            $productIds: [ID!]!, ${declarations}
          ) {
            nodes(ids: $productIds) {
              ... on Product {
                id
                ${selections}
              }
            }
          }
        `,
        variables: { productIds: productBatch, ...variables },
      });

      for (const node of data.nodes) {
        if (!node) continue;
        const memberships = collectionsByProduct.get(node.id);
        if (!memberships) continue;
        collectionBatch.forEach((collectionId, index) => {
          if (node[`collection${index}`]) memberships.add(collectionId);
        });
      }
    },
  );

  return new Map(
    orderLines.map((line) => [
      numericShopifyId(line.id),
      {
        lineItemId: numericShopifyId(line.id),
        sellingPlanId: line.sellingPlan?.sellingPlanId ?? null,
        sellingPlanName: line.sellingPlan?.name ?? null,
        sellingPlanCategory: line.sellingPlan?.sellingPlanId
          ? sellingPlanCategories.get(line.sellingPlan.sellingPlanId) ?? null
          : null,
        subscriptionSeriesKey:
          line.sellingPlan?.sellingPlanId &&
          sellingPlanCategories.get(line.sellingPlan.sellingPlanId) ===
            "SUBSCRIPTION" &&
          (line.variant?.id ?? line.product?.id)
            ? `selling-plan:${line.sellingPlan.sellingPlanId}:item:${
                line.variant?.id ?? line.product!.id
              }`
            : null,
        collectionExternalIds: line.product
          ? [...(collectionsByProduct.get(line.product.id) ?? [])]
          : [],
        productTags: line.product?.tags ?? [],
      } satisfies ShopifyOrderLineContext,
    ]),
  );
}
