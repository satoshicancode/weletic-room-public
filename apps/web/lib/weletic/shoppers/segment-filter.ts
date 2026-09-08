import type { Prisma } from "@prisma/client";
import type { ShopperSegment } from "./segment-query";

/** Filter before the bounded directory scan. Related records are independently
 * store-fenced even when a legacy scalar relation points at the wrong tenant.
 * Balances are cached settled balances (not pending points or financial value).
 */
export function shopperSegmentWhere(
  storeId: string,
  query: ShopperSegment,
): Prisma.WeleticShopperWhereInput {
  const conditions: Prisma.WeleticShopperWhereInput[] = [];
  if (query.loyalty === "not_enrolled") {
    conditions.push({ loyaltyAccount: { is: null } });
  } else if (
    query.loyalty !== "any" ||
    query.vip !== "any" ||
    query.minPoints !== "" ||
    query.maxPoints !== ""
  ) {
    conditions.push({
      loyaltyAccount: {
        is: {
          storeId,
          ...(query.loyalty !== "any" && query.loyalty !== "enrolled"
            ? { status: query.loyalty }
            : {}),
          ...(query.minPoints !== "" || query.maxPoints !== ""
            ? {
                cachedPointsBalance: {
                  ...(query.minPoints !== ""
                    ? { gte: BigInt(query.minPoints) }
                    : {}),
                  ...(query.maxPoints !== ""
                    ? { lte: BigInt(query.maxPoints) }
                    : {}),
                },
              }
            : {}),
          ...(query.vip === "unassigned" ? { currentTierId: null } : {}),
          ...(query.vip === "assigned"
            ? {
                currentTier: {
                  is: { deletedAt: null, program: { is: { storeId } } },
                },
              }
            : {}),
        },
      },
    });
  }
  if (query.purchase !== "any") {
    const order: Prisma.WeleticCommerceOrderWhereInput = {
      storeId,
      status: { in: ["paid", "partially_refunded"] },
      ...(query.purchasedFrom || query.purchasedBefore
        ? {
            occurredAt: {
              ...(query.purchasedFrom
                ? { gte: new Date(`${query.purchasedFrom}T00:00:00.000Z`) }
                : {}),
              ...(query.purchasedBefore
                ? { lt: new Date(`${query.purchasedBefore}T00:00:00.000Z`) }
                : {}),
            },
          }
        : {}),
    };
    conditions.push({
      orders:
        query.purchase === "has_order" ? { some: order } : { none: order },
    });
  }
  return { AND: conditions };
}
