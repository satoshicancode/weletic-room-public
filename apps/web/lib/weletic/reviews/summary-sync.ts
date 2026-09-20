import { prisma } from "@/lib/prisma";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import {
  resolveShopifyOfflineCredentials,
  shopifyAdminGraphqlRequest,
} from "@/lib/weletic/loyalty/shopify-discounts";
import { withDistributedLock } from "@/lib/weletic/redis-lock";
import { assertShopifyStoreMatchesInstallationGeneration } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import { ReviewError } from "./contracts";
import { buildReviewPublicPrivacySql } from "./privacy-public-sql";

export async function enqueueReviewSummaryPage({
  storeId,
  generation,
  revision,
  afterProductId,
}: {
  storeId: string;
  generation: string | null;
  revision: string;
  afterProductId?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const store = await assertShopifyStoreMatchesInstallationGeneration({
      storeId,
      expectedInstallationGeneration: generation,
      action: "review_summary_fanout",
      tx,
    });
    if (store.complianceState !== "active") return;
    const products = await tx.weleticShopifyProduct.findMany({
      where: {
        storeId,
        nativeReviews: { some: {} },
        ...(afterProductId ? { id: { gt: afterProductId } } : {}),
      },
      orderBy: { id: "asc" },
      take: 50,
      select: { id: true },
    });
    for (const product of products)
      await enqueueOutboxJob({
        tx,
        storeId,
        jobType: "REVIEW_SUMMARY_SYNC",
        payload: { productId: product.id },
        idempotencyKey: `review_summary_fanout:${revision}:${product.id}`,
      });
    const last = products.at(-1);
    if (products.length === 50 && last)
      await enqueueOutboxJob({
        tx,
        storeId,
        jobType: "REVIEW_SUMMARY_SYNC",
        payload: { productId: "*", afterProductId: last.id, revision },
        idempotencyKey: `review_summary_page:${revision}:${last.id}`,
      });
  });
}

// Serialize only remote projection writers. Every worker reads current published
// reviews after acquisition, so delayed jobs cannot replay an obsolete payload.
export async function syncProductReviewSummary(
  storeId: string,
  productId: string,
  expectedInstallationGeneration: string | null,
) {
  return withDistributedLock({
    key: `weletic:reviews:summary:${storeId}:${productId}`,
    ttlSeconds: 300,
    fn: async () => {
      const store = await assertShopifyStoreMatchesInstallationGeneration({
        storeId,
        expectedInstallationGeneration,
        action: "native_review_summary_sync",
      });
      if (
        store.complianceState !== "active" ||
        store.storeAccessState !== "active"
      )
        return;
      if (!store.installationGeneration)
        throw new ReviewError(
          "unavailable",
          "Review summary generation unavailable",
        );
      const product = await prisma.weleticShopifyProduct.findFirst({
        where: { id: productId, storeId },
        select: { externalId: true },
      });
      if (!product) return;
      const summary = await prisma.$transaction(
        async (tx) => {
          const current = await assertShopifyStoreMatchesInstallationGeneration(
            {
              storeId,
              expectedInstallationGeneration,
              action: "native_review_summary_read",
              tx,
            },
          );
          if (
            current.complianceState !== "active" ||
            current.storeAccessState !== "active"
          )
            throw new ReviewError(
              "unavailable",
              "Review summary store unavailable",
            );
          const privacy = buildReviewPublicPrivacySql({
            storeId,
            productId,
            installationGeneration: store.installationGeneration!,
          });
          const unknown = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT r.id FROM ${privacy.from} WHERE ${privacy.unknown} LIMIT 1`);
          if (unknown.length)
            throw new ReviewError(
              "unavailable",
              "Review summary privacy coverage unavailable",
            );
          const groups = await tx.$queryRaw<
            Array<{ rating: number; count: bigint }>
          >(Prisma.sql`
          SELECT r.rating, COUNT(*) AS count FROM ${privacy.from}
          WHERE ${privacy.eligible} GROUP BY r.rating`);
          let count = 0;
          let sum = 0;
          for (const group of groups) {
            const quantity = Number(group.count);
            if (
              !Number.isSafeInteger(quantity) ||
              quantity < 0 ||
              !Number.isInteger(group.rating) ||
              group.rating < 1 ||
              group.rating > 5
            )
              throw new ReviewError(
                "unavailable",
                "Review summary totals unavailable",
              );
            count += quantity;
            sum += quantity * group.rating;
          }
          if (!Number.isSafeInteger(count) || !Number.isSafeInteger(sum))
            throw new ReviewError(
              "unavailable",
              "Review summary totals unavailable",
            );
          return { _count: { rating: count }, _sum: { rating: sum } };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      const credentials = await resolveShopifyOfflineCredentials({ storeId });
      // Recheck after credential resolution; never hold a SQL transaction across
      // the provider request. Remote projection remains eventually consistent.
      const latest = await assertShopifyStoreMatchesInstallationGeneration({
        storeId,
        expectedInstallationGeneration,
        action: "native_review_summary_publish",
      });
      if (
        latest.complianceState !== "active" ||
        latest.storeAccessState !== "active"
      )
        return;
      const count = summary._count.rating;
      const query = count
        ? `mutation ReviewRating($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }`
        : `mutation ReviewRatingEmpty($metafields: [MetafieldsSetInput!]!, $delete: [MetafieldIdentifierInput!]!) {
      metafieldsDelete(metafields: $delete) { userErrors { message } }
      metafieldsSet(metafields: $metafields) { userErrors { message } }
    }`;
      const metafields = [
        {
          ownerId: product.externalId,
          namespace: "reviews",
          key: "rating_count",
          type: "number_integer",
          value: String(count),
        },
      ];
      if (count)
        metafields.push({
          ownerId: product.externalId,
          namespace: "reviews",
          key: "rating",
          type: "rating",
          value: JSON.stringify({
            value: ((summary._sum.rating ?? 0) / count).toFixed(2),
            scale_min: "1.0",
            scale_max: "5.0",
          }),
        });
      const response = await shopifyAdminGraphqlRequest<{
        metafieldsSet: { userErrors: Array<{ message: string }> } | null;
        metafieldsDelete?: { userErrors: Array<{ message: string }> } | null;
      }>({
        shopDomain: credentials.shopDomain,
        accessToken: credentials.accessToken,
        query,
        requestTimeoutMs: 8000,
        maxRetries: 0,
        variables: {
          metafields,
          ...(count
            ? {}
            : {
                delete: [
                  {
                    ownerId: product.externalId,
                    namespace: "reviews",
                    key: "rating",
                  },
                ],
              }),
        },
      });
      if (
        !response.metafieldsSet ||
        response.metafieldsSet.userErrors.length ||
        (!count &&
          (!response.metafieldsDelete ||
            response.metafieldsDelete.userErrors.length))
      ) {
        throw new ReviewError(
          "unavailable",
          "Shopify rating metafields update failed",
        );
      }
    },
  });
}
