import { z } from "zod";

export const shopperProfileQuerySchema = z.object({
  shopperId: z.string().min(1).max(191),
  section: z
    .enum([
      "overview",
      "purchases",
      "points",
      "referrals",
      "reviews",
      "rewards",
      "review_requests",
    ])
    .default("overview"),
  cursor: z.string().max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ShopperProfileQuery = z.infer<typeof shopperProfileQuerySchema>;

const cursorSchema = z
  .object({
    v: z.literal(1),
    storeId: z.string(),
    shopperId: z.string(),
    section: shopperProfileQuerySchema.shape.section,
    generation: z.string(),
    createdAt: z.string().datetime(),
    sequenceNumber: z.number().int().nonnegative().optional(),
    id: z.string().min(1).max(191),
  })
  .strict()
  .refine(
    (value) =>
      (value.section === "points") === (value.sequenceNumber !== undefined),
  );

export class ShopperProfileError extends Error {
  constructor(public code: "not_found" | "bad_request") {
    super(
      code === "not_found"
        ? "Shopper unavailable"
        : "Invalid shopper profile query",
    );
  }
}

export type ShopperProfileScope<
  S extends ShopperProfileQuery["section"] = ShopperProfileQuery["section"],
> = {
  storeId: string;
  shopperId: string;
  section: S;
  generation: string;
};

function decodeCursor(scope: ShopperProfileScope, cursor?: string) {
  if (!cursor) return null;
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new Error();
    const decoded = cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
    if (
      Object.entries(scope).some(
        ([key, value]) => decoded[key as keyof typeof scope] !== value,
      )
    )
      throw new Error();
    return decoded;
  } catch {
    throw new ShopperProfileError("bad_request");
  }
}

export function shopperProfileChronology(
  scope: ShopperProfileScope,
  cursor?: string,
) {
  const decoded = decodeCursor(scope, cursor);
  return decoded
    ? {
        OR: [
          { createdAt: { lt: new Date(decoded.createdAt) } },
          { createdAt: new Date(decoded.createdAt), id: { lt: decoded.id } },
        ],
      }
    : {};
}

export function shopperProfileSequence(
  scope: ShopperProfileScope,
  cursor?: string,
) {
  const decoded = decodeCursor(scope, cursor);
  if (!decoded) return {};
  if (decoded.sequenceNumber === undefined)
    throw new ShopperProfileError("bad_request");
  return {
    OR: [
      { sequenceNumber: { lt: decoded.sequenceNumber } },
      { sequenceNumber: decoded.sequenceNumber, id: { lt: decoded.id } },
    ],
  };
}

export function shopperProfilePage<
  S extends ShopperProfileQuery["section"],
  T extends { id: string; createdAt: Date; sequenceNumber?: number },
  U,
>(scope: ShopperProfileScope<S>, rows: T[], limit: number, map: (row: T) => U) {
  const selected = rows.slice(0, limit);
  const last = selected.at(-1);
  const hasMore = rows.length > limit;
  return {
    section: scope.section,
    items: selected.map(map),
    pagination: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                ...scope,
                id: last.id,
                createdAt: last.createdAt.toISOString(),
                ...(scope.section === "points"
                  ? { sequenceNumber: last.sequenceNumber }
                  : {}),
              }),
            ).toString("base64url")
          : null,
    },
  };
}
