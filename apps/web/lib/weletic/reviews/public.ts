import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { hasShopifyCustomerPrivacyTombstone } from "../shopify/privacy-identity";
import { ReviewError } from "./contracts";
import { buildReviewPublicPrivacySql } from "./privacy-public-sql";
import { projectManualReviewTranslation } from "./translation-projection";

const querySchema = z.object({
  productId: z.string().regex(/^(?:gid:\/\/shopify\/Product\/)?[1-9][0-9]*$/),
  sort: z.enum(["newest", "highest", "lowest"]).default("newest"),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: z.string().max(2048).optional(),
  locale: z.enum(["en", "ja", "vi"]).optional(),
});
const cursorSchema = z
  .object({
    v: z.literal(1),
    storeId: z.string(),
    productId: z.string(),
    sort: z.enum(["newest", "highest", "lowest"]),
    filter: z.number().nullable(),
    rating: z.number().int().min(1).max(5),
    createdAt: z.string().datetime(),
    id: z.string().max(191),
    locale: z.enum(["en", "ja", "vi"]).nullable().optional(),
  })
  .strict();

export async function getPublicProductReviews(storeId: string, input: unknown) {
  const query = querySchema.parse(input);
  const externalId = query.productId.startsWith("gid:")
    ? query.productId
    : `gid://shopify/Product/${query.productId}`;
  const product = await prisma.weleticShopifyProduct.findFirst({
    where: {
      storeId,
      externalId,
      status: "active",
      store: { complianceState: "active", reviewSettings: { enabled: true } },
    },
    select: { id: true },
  });
  if (!product)
    throw new ReviewError("not_found", "Product reviews unavailable");
  let after: Prisma.WeleticProductReviewWhereInput = {};
  let afterSql = Prisma.sql`1 = 1`;
  if (query.cursor) {
    try {
      const cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
      if (
        cursor.storeId !== storeId ||
        cursor.productId !== product.id ||
        cursor.sort !== query.sort ||
        cursor.filter !== (query.rating ?? null) ||
        (cursor.locale ?? null) !== (query.locale ?? null)
      )
        throw new Error("Cursor scope mismatch");
      const chronology = [
        { createdAt: { lt: new Date(cursor.createdAt) } },
        { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
      ];
      const chronologySql = Prisma.sql`(r.createdAt < ${new Date(cursor.createdAt)} OR
        (r.createdAt = ${new Date(cursor.createdAt)} AND r.id < ${cursor.id}))`;
      afterSql =
        query.sort === "newest"
          ? chronologySql
          : Prisma.sql`(
        ${query.sort === "highest" ? Prisma.sql`r.rating < ${cursor.rating}` : Prisma.sql`r.rating > ${cursor.rating}`}
        OR (r.rating = ${cursor.rating} AND ${chronologySql}))`;
      after =
        query.sort === "newest"
          ? { OR: chronology }
          : {
              OR: [
                {
                  rating:
                    query.sort === "highest"
                      ? { lt: cursor.rating }
                      : { gt: cursor.rating },
                },
                { rating: cursor.rating, OR: chronology },
              ],
            };
    } catch {
      throw new ReviewError("bad_request", "Invalid review cursor");
    }
  }
  return prisma.$transaction(
    async (tx) => {
      const store = await tx.weleticShopifyStore.findUnique({
        where: { id: storeId },
        select: {
          installationGeneration: true,
          complianceState: true,
          storeAccessState: true,
        },
      });
      if (
        !store?.installationGeneration ||
        store.complianceState !== "active" ||
        store.storeAccessState !== "active"
      )
        throw new ReviewError("unavailable", "Product reviews unavailable");
      const privacy = buildReviewPublicPrivacySql({
        storeId,
        productId: product.id,
        installationGeneration: store.installationGeneration,
      });
      const unknown = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT r.id FROM ${privacy.from} WHERE ${privacy.unknown} LIMIT 1`);
      if (unknown.length)
        throw new ReviewError("unavailable", "Product reviews unavailable");
      const statistics = await tx.$queryRaw<
        Array<{ rating: number; count: bigint }>
      >(Prisma.sql`
        SELECT r.rating, COUNT(*) AS count FROM ${privacy.from}
        WHERE ${privacy.eligible} GROUP BY r.rating`);
      const groups = statistics.map(({ rating, count }) => ({
        rating,
        _count: { _all: Number(count) },
      }));
      const total = groups.reduce((sum, group) => sum + group._count._all, 0);
      const ratingSum = groups.reduce(
        (sum, group) => sum + group.rating * group._count._all,
        0,
      );
      if (
        !Number.isSafeInteger(total) ||
        !Number.isSafeInteger(ratingSum) ||
        groups.some(
          (group) =>
            !Number.isSafeInteger(group._count._all) ||
            group._count._all < 0 ||
            !Number.isInteger(group.rating) ||
            group.rating < 1 ||
            group.rating > 5,
        )
      )
        throw new ReviewError(
          "unavailable",
          "Product review totals unavailable",
        );
      const aggregate = {
        _count: { rating: total },
        _sum: { rating: ratingSum },
      };
      const candidates = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT r.id FROM ${privacy.from} WHERE ${privacy.eligible}
          AND ${query.rating ? Prisma.sql`r.rating = ${query.rating}` : Prisma.sql`1 = 1`}
          AND ${afterSql}
        ORDER BY ${query.sort === "highest" ? Prisma.sql`r.rating DESC,` : query.sort === "lowest" ? Prisma.sql`r.rating ASC,` : Prisma.empty}
          r.createdAt DESC, r.id DESC LIMIT ${query.limit + 1}`);
      const where = {
        id: { in: candidates.map((row) => row.id) },
        storeId,
        productId: product.id,
        status: "published" as const,
        redactedAt: null,
        product: { storeId, status: "active" as const },
        store: {
          complianceState: "active" as const,
          reviewSettings: { enabled: true },
        },
        shopper: { storeId, privacyTombstones: { none: {} } },
      };
      const rows = await tx.weleticProductReview.findMany({
        where: {
          ...where,
          ...(query.rating ? { rating: query.rating } : {}),
          ...after,
        },
        orderBy: [
          ...(query.sort === "newest"
            ? []
            : [
                {
                  rating:
                    query.sort === "highest"
                      ? ("desc" as const)
                      : ("asc" as const),
                },
              ]),
          { createdAt: "desc" },
          { id: "desc" },
        ],
        take: query.limit + 1,
        select: {
          id: true,
          storeId: true,
          version: true,
          status: true,
          redactedAt: true,
          rating: true,
          title: true,
          body: true,
          displayName: true,
          merchantReply: true,
          verifiedPurchase: true,
          incentivized: true,
          createdAt: true,
          shopper: { select: { shopifyCustomerId: true, email: true } },
          translations: {
            where: {
              storeId,
              locale: query.locale ?? "__original__",
              status: "active",
              redactedAt: null,
            },
            take: 1,
            select: {
              storeId: true,
              reviewId: true,
              locale: true,
              status: true,
              redactedAt: true,
              sourceReviewVersion: true,
              sourceDigest: true,
              sourceLocale: true,
              title: true,
              body: true,
            },
          },
          media: {
            where: { status: "uploaded" },
            select: { id: true },
            orderBy: { id: "asc" },
          },
        },
      });
      const pageRows = rows.slice(0, query.limit);
      // Never return internal identity/digest fields via object spread.
      const last = pageRows.at(-1);
      const items: Array<
        Pick<
          (typeof rows)[number],
          | "id"
          | "rating"
          | "title"
          | "body"
          | "displayName"
          | "merchantReply"
          | "verifiedPurchase"
          | "incentivized"
          | "createdAt"
          | "media"
        > & {
          translation?: {
            locale: "en" | "ja" | "vi";
            original: { title: string; body: string };
          };
        }
      > = [];
      for (const row of pageRows) {
        if (
          await hasShopifyCustomerPrivacyTombstone({
            tx,
            storeId,
            shopifyCustomerId: row.shopper.shopifyCustomerId,
            email: row.shopper.email,
          })
        )
          throw new ReviewError("unavailable", "Product reviews unavailable");
        const projection = projectManualReviewTranslation({
          storeId,
          source: row,
          translation: row.translations[0] ?? null,
          locale: query.locale ?? "",
        });
        if (!projection) continue;
        items.push({
          id: row.id,
          rating: row.rating,
          title: projection.title,
          body: projection.body,
          displayName: row.displayName,
          merchantReply: row.merchantReply,
          verifiedPurchase: row.verifiedPurchase,
          incentivized: row.incentivized,
          createdAt: row.createdAt,
          media: row.media,
          ...(projection.translated && query.locale
            ? {
                translation: {
                  locale: query.locale,
                  original: { title: row.title, body: row.body },
                },
              }
            : {}),
        });
      }
      return {
        summary: {
          count: aggregate._count.rating,
          average: aggregate._count.rating
            ? Number(
                (
                  (aggregate._sum.rating ?? 0) / aggregate._count.rating
                ).toFixed(2),
              )
            : null,
          distribution: Object.fromEntries(
            [1, 2, 3, 4, 5].map((rating) => [
              rating,
              groups.find((g) => g.rating === rating)?._count._all ?? 0,
            ]),
          ),
        },
        items,
        nextCursor:
          rows.length > query.limit && last
            ? Buffer.from(
                JSON.stringify({
                  v: 1,
                  storeId,
                  productId: product.id,
                  sort: query.sort,
                  filter: query.rating ?? null,
                  rating: last.rating,
                  createdAt: last.createdAt.toISOString(),
                  id: last.id,
                  locale: query.locale ?? null,
                }),
              ).toString("base64url")
            : null,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
