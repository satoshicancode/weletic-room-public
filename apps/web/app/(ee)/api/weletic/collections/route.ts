import { getDefaultProgramIdOrThrow } from "@/lib/api/programs/get-default-program-id-or-throw";
import { withWorkspace } from "@/lib/auth";
import { shopifyAdminGraphql } from "@/lib/integrations/shopify/admin-graphql";
import { prisma } from "@/lib/prisma";
import { getWeleticShopifyInstallation } from "@/lib/weletic/shopify/get-installation";
import { NextResponse } from "next/server";
import * as z from "zod/v4";

export const GET = withWorkspace(async ({ workspace, searchParams }) => {
  const { q } = z
    .object({
      q: z.string().optional(),
    })
    .parse(searchParams);

  const query = q?.trim();
  const programId = getDefaultProgramIdOrThrow(workspace);

  // 1. Try Shopify Admin GraphQL if installation is present
  try {
    const installation = await getWeleticShopifyInstallation(workspace.id);
    const data = await shopifyAdminGraphql<{
      collections: {
        nodes: Array<{
          id: string;
          title: string;
          handle: string;
          productsCount?: { count: number } | number;
        }>;
      };
    }>({
      shopifyStoreId: installation.shopDomain,
      accessToken: installation.accessToken,
      query: `#graphql
        query WeleticCollections($query: String) {
          collections(first: 100, query: $query) {
            nodes {
              id
              title
              handle
              productsCount {
                count
              }
            }
          }
        }
      `,
      variables: query ? { query: `title:*${query}*` } : undefined,
    });

    if (data?.collections?.nodes) {
      let collections = data.collections.nodes.map((node) => ({
        id: node.id,
        title: node.title,
        handle: node.handle,
        productsCount:
          typeof node.productsCount === "object" && node.productsCount !== null
            ? node.productsCount.count
            : typeof node.productsCount === "number"
              ? node.productsCount
              : undefined,
      }));

      if (query) {
        const lowerQ = query.toLowerCase();
        collections = collections.filter(
          (c) =>
            c.title.toLowerCase().includes(lowerQ) ||
            c.handle.toLowerCase().includes(lowerQ),
        );
      }

      return NextResponse.json(collections);
    }
  } catch {
    // If Shopify GraphQL is not accessible or workspace has no credentials, fall back to synced products
  }

  // 2. Fallback: dynamically extract collections from workspace synced products
  const products = await prisma.weleticShopifyProduct.findMany({
    where: { programId, status: "active" },
    select: { collectionExternalIds: true, vendor: true, productType: true },
  });

  const collectionIds = new Set<string>();
  for (const product of products) {
    if (Array.isArray(product.collectionExternalIds)) {
      for (const id of product.collectionExternalIds) {
        if (typeof id === "string" && id.trim()) {
          collectionIds.add(id.trim());
        }
      }
    }
  }

  let collections = Array.from(collectionIds).map((id) => {
    const match = id.match(/gid:\/\/shopify\/Collection\/(\d+)/);
    const label = match ? `Collection #${match[1]}` : id;
    return {
      id,
      title: label,
      handle: label.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    };
  });

  if (query) {
    const lowerQ = query.toLowerCase();
    collections = collections.filter(
      (c) =>
        c.title.toLowerCase().includes(lowerQ) ||
        c.handle.toLowerCase().includes(lowerQ),
    );
  }

  return NextResponse.json(collections);
});
