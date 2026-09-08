import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { ReviewError } from "./contracts";

const querySchema = z.object({
  productId: z.string().regex(/^(?:gid:\/\/shopify\/Product\/)?[1-9][0-9]*$/),
  sort: z.enum(["newest", "highest", "lowest"]).default("newest"),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  cursor: z.string().max(2048).optional(),
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
  if (query.cursor) {
    try {
      const cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
      if (
        cursor.storeId !== storeId ||
        cursor.productId !== product.id ||
        cursor.sort !== query.sort ||
        cursor.filter !== (query.rating ?? null)
      )
        throw new Error("Cursor scope mismatch");
      const chronology = [
        { createdAt: { lt: new Date(cursor.createdAt) } },
        { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
      ];
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
      const where = {
        storeId,
        productId: product.id,
        status: "published" as const,
        store: {
          complianceState: "active" as const,
          reviewSettings: { enabled: true },
        },
        shopper: { privacyTombstones: { none: {} } },
      };
      const [aggregate, groups, rows] = await Promise.all([
        tx.weleticProductReview.aggregate({
          where,
          _sum: { rating: true },
          _count: { rating: true },
        }),
        tx.weleticProductReview.groupBy({
          by: ["rating"],
          where,
          _count: { _all: true },
        }),
        tx.weleticProductReview.findMany({
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
            rating: true,
            title: true,
            body: true,
            displayName: true,
            merchantReply: true,
            verifiedPurchase: true,
            incentivized: true,
            createdAt: true,
            media: {
              where: { status: "uploaded" },
              select: { id: true },
              orderBy: { id: "asc" },
            },
          },
        }),
      ]);
      const items = rows.slice(0, query.limit);
      const last = items.at(-1);
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
                }),
              ).toString("base64url")
            : null,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
