import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { prisma } from "@/lib/prisma";
import { getWeleticShopifyInstallation } from "./get-installation";
import { writeShopifyCustomerSegmentCache } from "./privacy-cache";
import { hasShopifyCustomerPrivacyTombstone } from "./privacy-identity";
import { withShopifyStoreOperationalWriteFence } from "./store-compliance-state";

export interface ShopifyCustomerSegment {
  id: string;
  name: string;
}

export async function getShopifyCustomerOrderHistory({
  workspaceId,
  customerId,
}: {
  workspaceId: string;
  customerId: string;
}) {
  const installation = await getWeleticShopifyInstallation(workspaceId);
  const data = await shopifyAdminGraphql<{
    customer: {
      numberOfOrders: string | number;
      orders: { nodes: Array<{ id: string }> };
    } | null;
  }>({
    shopifyStoreId: installation.shopDomain,
    accessToken: installation.accessToken,
    apiVersion: "2026-07",
    query: `#graphql
      query WeleticCustomerOrderHistory($customerId: ID!) {
        customer(id: $customerId) {
          numberOfOrders
          orders(first: 250, sortKey: CREATED_AT) { nodes { id } }
        }
      }
    `,
    variables: { customerId },
  });
  if (!data.customer) {
    throw new Error(`Shopify customer ${customerId} was not found.`);
  }

  const numberOfOrders = Number(data.customer.numberOfOrders);
  if (!Number.isSafeInteger(numberOfOrders) || numberOfOrders < 0) {
    throw new Error(`Invalid Shopify lifetime order count for ${customerId}.`);
  }

  return {
    numberOfOrders,
    visibleOrderIds: data.customer.orders.nodes.map(({ id }) => id),
  };
}

export async function listShopifyCustomerSegments({
  workspaceId,
  query,
}: {
  workspaceId: string;
  query?: string;
}) {
  const installation = await getWeleticShopifyInstallation(workspaceId);
  const data = await shopifyAdminGraphql<{
    segments: { nodes: ShopifyCustomerSegment[] };
  }>({
    shopifyStoreId: installation.shopDomain,
    accessToken: installation.accessToken,
    apiVersion: "2026-07",
    query: `#graphql
      query WeleticCustomerSegments($query: String) {
        segments(first: 100, query: $query) {
          nodes { id name }
        }
      }
    `,
    variables: query ? { query: `name:*${query.trim()}*` } : undefined,
  });
  return data.segments.nodes;
}

export async function setShopifyCustomerSegmentMembership({
  workspaceId,
  customerId,
  segmentId,
  member,
  storeId,
  expectedInstallationGeneration,
}: {
  workspaceId: string;
  customerId: string;
  segmentId: string;
  member: boolean;
  storeId?: string;
  expectedInstallationGeneration?: string | null;
}) {
  const effectiveStoreId =
    storeId ??
    (
      await prisma.weleticShopifyStore.findUnique({
        where: { projectId: workspaceId },
        select: { id: true },
      })
    )?.id;
  if (!effectiveStoreId) {
    throw new Error(
      "A Shopify store is required to isolate customer segment cache state.",
    );
  }
  await withShopifyStoreOperationalWriteFence({
    storeId: effectiveStoreId,
    action: "customer_segment_cache_write",
    expectedInstallationGeneration,
    operation: async (tx) => {
      if (
        await hasShopifyCustomerPrivacyTombstone({
          storeId: effectiveStoreId,
          shopifyCustomerId: customerId,
          tx,
        })
      ) {
        return;
      }
      // Keep the short, atomic Redis cache publication inside the durable
      // store-row fence. A freeze/reconnect must linearize before this write or
      // after it; it can no longer land between a plain guard and the cache.
      await writeShopifyCustomerSegmentCache({
        storeId: effectiveStoreId,
        workspaceId,
        customerId,
        segmentId,
        member,
      });
    },
  });
}

export async function getShopifyCustomerSegmentIds({
  workspaceId,
  customerId,
  segmentIds,
}: {
  workspaceId: string;
  customerId: string;
  segmentIds: string[];
}) {
  if (segmentIds.length === 0) return [];
  const canonicalEntries = segmentIds.flatMap((segmentId) => {
    const canonicalId = /^gid:\/\/shopify\/Segment\/\d+$/.test(segmentId)
      ? segmentId
      : /^\d+$/.test(segmentId)
        ? `gid://shopify/Segment/${segmentId}`
        : null;
    return canonicalId ? [{ segmentId, canonicalId }] : [];
  });
  const canonicalSegmentIds = [
    ...new Set(canonicalEntries.map(({ canonicalId }) => canonicalId)),
  ];
  if (canonicalSegmentIds.length === 0) return [];
  const installation = await getWeleticShopifyInstallation(workspaceId);
  const data = await shopifyAdminGraphql<{
    customerSegmentMembership: {
      memberships: Array<{ segmentId: string; isMember: boolean }>;
    };
  }>({
    shopifyStoreId: installation.shopDomain,
    accessToken: installation.accessToken,
    apiVersion: "2026-07",
    query: `#graphql
      query WeleticCustomerSegmentMembership(
        $customerId: ID!
        $segmentIds: [ID!]!
      ) {
        customerSegmentMembership(
          customerId: $customerId
          segmentIds: $segmentIds
        ) {
          memberships { segmentId isMember }
        }
      }
    `,
    variables: { customerId, segmentIds: canonicalSegmentIds },
  });
  const membershipBySegment = new Map(
    data.customerSegmentMembership.memberships.map((membership) => [
      membership.segmentId,
      membership.isMember,
    ]),
  );
  await Promise.all(
    canonicalEntries.map(({ segmentId, canonicalId }) =>
      setShopifyCustomerSegmentMembership({
        workspaceId,
        customerId,
        segmentId,
        member: membershipBySegment.get(canonicalId) ?? false,
      }),
    ),
  );
  return canonicalEntries.flatMap(({ segmentId, canonicalId }) =>
    membershipBySegment.get(canonicalId) === true ? [segmentId] : [],
  );
}
