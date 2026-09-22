import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ReviewError } from "./contracts";
import { buildStoreReviewPublicPrivacySql } from "./privacy-public-sql";

const querySchema = z
  .object({
    rating: z.coerce.number().int().min(1).max(5).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(10),
    cursor: z.string().min(1).max(2048).optional(),
  })
  .strict();
const cursorSchema = z
  .object({
    v: z.literal(1),
    scope: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string().datetime(),
    id: z.string().min(1).max(191),
  })
  .strict();

/** Live SQL projection: totals and pagination share one privacy predicate and
 * repeatable-read snapshot. No external/cached summary can survive erasure.
 * A signed gateway must resolve storeId; this service grants no write authority.
 */
export async function getPublicStoreReviews(storeId: string, input: unknown) {
  const query = querySchema.parse(input);
  return prisma.$transaction(
    async (tx) => {
      const store = await tx.weleticShopifyStore.findUnique({
        where: { id: storeId },
        select: {
          installationGeneration: true,
          complianceState: true,
          storeAccessState: true,
          reviewSettings: { select: { enabled: true } },
          storeReviewSettings: { select: { enabled: true } },
        },
      });
      if (
        !store?.installationGeneration ||
        store.complianceState !== "active" ||
        store.storeAccessState !== "active" ||
        !store.reviewSettings?.enabled ||
        !store.storeReviewSettings?.enabled
      )
        throw new ReviewError("unavailable", "Store reviews unavailable");
      const scope = createHash("sha256")
        .update(
          JSON.stringify([
            "store-review-page-v1",
            storeId,
            store.installationGeneration,
            query.rating ?? null,
          ]),
        )
        .digest("hex");
      let after = Prisma.sql`1 = 1`;
      if (query.cursor) {
        try {
          const bytes = Buffer.from(query.cursor, "base64url");
          if (bytes.toString("base64url") !== query.cursor) throw new Error();
          const cursor = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
          if (cursor.scope !== scope) throw new Error();
          const date = new Date(cursor.createdAt);
          after = Prisma.sql`(r.createdAt < ${date} OR (r.createdAt = ${date} AND r.id < ${cursor.id}))`;
        } catch {
          throw new ReviewError("bad_request", "Invalid store review cursor");
        }
      }
      const privacy = buildStoreReviewPublicPrivacySql({
        storeId,
        installationGeneration: store.installationGeneration,
      });
      const unknown = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT r.id FROM ${privacy.from} WHERE ${privacy.unknown} LIMIT 1`);
      if (unknown.length)
        throw new ReviewError("unavailable", "Store reviews unavailable");
      const groups = await tx.$queryRaw<
        Array<{ rating: number; count: bigint }>
      >(Prisma.sql`
      SELECT r.rating, COUNT(*) AS count FROM ${privacy.from}
      WHERE ${privacy.eligible} GROUP BY r.rating`);
      let count = 0;
      let sum = 0;
      const distribution: Record<string, number> = {
        "1": 0,
        "2": 0,
        "3": 0,
        "4": 0,
        "5": 0,
      };
      for (const group of groups) {
        const size = Number(group.count);
        if (
          !Number.isInteger(group.rating) ||
          group.rating < 1 ||
          group.rating > 5 ||
          !Number.isSafeInteger(size) ||
          size < 0
        )
          throw new ReviewError(
            "unavailable",
            "Store review totals unavailable",
          );
        distribution[group.rating] = size;
        count += size;
        sum += group.rating * size;
      }
      if (!Number.isSafeInteger(count) || !Number.isSafeInteger(sum))
        throw new ReviewError("unavailable", "Store review totals unavailable");
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          rating: number;
          title: string;
          body: string;
          displayName: string;
          merchantReply: string | null;
          locale: string;
          createdAt: Date;
          source: string;
          requestId: string | null;
          verifiedPurchase: boolean | number;
          incentivized: boolean | number;
        }>
      >(Prisma.sql`
      SELECT r.id, r.rating, r.title, r.body, r.displayName, r.merchantReply,
        r.locale, r.createdAt, r.source, r.requestId, r.verifiedPurchase, r.incentivized
      FROM ${privacy.from} WHERE ${privacy.eligible} AND ${after}
        AND ${query.rating ? Prisma.sql`r.rating = ${query.rating}` : Prisma.sql`1 = 1`}
      ORDER BY r.createdAt DESC, r.id DESC LIMIT ${query.limit + 1}`);
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        summary: {
          count,
          average: count ? Number((sum / count).toFixed(2)) : null,
          distribution,
        },
        items: page.map((row) => ({
          id: row.id,
          rating: row.rating,
          title: row.title,
          body: row.body,
          displayName: row.displayName,
          merchantReply: row.merchantReply,
          locale: row.locale,
          createdAt: row.createdAt,
          verifiedPurchase:
            row.source === "invitation" &&
            !!row.requestId &&
            !!row.verifiedPurchase,
          incentivized:
            row.source === "invitation" &&
            !!row.requestId &&
            !!row.incentivized,
        })),
        nextCursor:
          rows.length > query.limit && last
            ? Buffer.from(
                JSON.stringify({
                  v: 1,
                  scope,
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
