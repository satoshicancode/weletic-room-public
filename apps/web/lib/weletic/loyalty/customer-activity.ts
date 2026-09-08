import { prisma } from "@/lib/prisma";

export type CustomerActivityType = "points" | "referrals" | "vip";

export interface GetCustomerActivityPageParams {
  storeId: string;
  shopifyCustomerId: string;
  type?: CustomerActivityType;
  page?: number;
  limit?: number;
  cursor?: string;
}

export interface CustomerActivityPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  nextCursor?: string | null;
  mode?: "page" | "cursor";
}

export interface CustomerActivityPageResult {
  type: CustomerActivityType;
  activities: Array<Record<string, any>>;
  pagination: CustomerActivityPagination;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MAX_PRISMA_SKIP = 2_147_483_647;

type CustomerActivityCursor =
  | { v: 1; type: "points"; sequenceNumber: number; id: string }
  | { v: 1; type: "referrals"; timestamp: string; id: string }
  | { v: 1; type: "vip"; timestamp: string; id: string };

export class InvalidCustomerActivityCursorError extends Error {
  constructor() {
    super("Invalid customer activity cursor.");
    this.name = "InvalidCustomerActivityCursorError";
  }
}

function encodeActivityCursor(cursor: CustomerActivityCursor) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeActivityCursor(
  value: string,
  expectedType: CustomerActivityType,
): CustomerActivityCursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      decoded.v !== 1 ||
      decoded.type !== expectedType ||
      typeof decoded.id !== "string" ||
      decoded.id.length === 0
    ) {
      throw new InvalidCustomerActivityCursorError();
    }
    if (
      expectedType === "points" &&
      (!Number.isSafeInteger(decoded.sequenceNumber) ||
        Number(decoded.sequenceNumber) < 0)
    ) {
      throw new InvalidCustomerActivityCursorError();
    }
    if (
      expectedType !== "points" &&
      (typeof decoded.timestamp !== "string" ||
        !Number.isFinite(Date.parse(decoded.timestamp)))
    ) {
      throw new InvalidCustomerActivityCursorError();
    }
    return decoded as CustomerActivityCursor;
  } catch (error) {
    if (error instanceof InvalidCustomerActivityCursorError) throw error;
    throw new InvalidCustomerActivityCursorError();
  }
}

export function parseCustomerActivityType(
  value: unknown,
): CustomerActivityType {
  if (value === "referrals" || value === "vip") {
    return value;
  }
  return "points";
}

export function parsePositiveInteger(
  value: unknown,
  defaultValue: number,
  max?: number,
): number {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const str = String(value).trim();
  if (!/^[1-9]\d*$/.test(str)) {
    return defaultValue;
  }
  const parsed = Number(str);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return defaultValue;
  }
  if (max !== undefined && parsed > max) {
    return max;
  }
  return parsed;
}

export async function getCustomerActivityPage({
  storeId,
  shopifyCustomerId,
  type = "points",
  page = 1,
  limit = DEFAULT_LIMIT,
  cursor,
}: GetCustomerActivityPageParams): Promise<CustomerActivityPageResult> {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(MAX_LIMIT, Math.max(1, limit));
  const skip = (safePage - 1) * safeLimit;
  const cursorMode = cursor !== undefined;
  const decodedCursor = cursor ? decodeActivityCursor(cursor, type) : undefined;

  if (!cursorMode && (!Number.isSafeInteger(skip) || skip > MAX_PRISMA_SKIP)) {
    return {
      type,
      activities: [],
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: 0,
        totalPages: 0,
        hasMore: false,
      },
    };
  }

  const normalizedCustomerId = String(shopifyCustomerId).trim();

  // 1. Resolve shopper and primary account
  const shopper = await prisma.weleticShopper.findUnique({
    where: {
      storeId_shopifyCustomerId: {
        storeId,
        shopifyCustomerId: normalizedCustomerId,
      },
    },
    include: {
      loyaltyAccount: {
        select: { id: true, status: true },
      },
    },
  });

  const account = shopper?.loyaltyAccount;
  if (
    !shopper ||
    !account ||
    (account.status !== "active" && account.status !== "suspended")
  ) {
    return {
      type,
      activities: [],
      pagination: {
        page: safePage,
        limit: safeLimit,
        total: 0,
        totalPages: 0,
        hasMore: false,
        ...(cursorMode ? { mode: "cursor" as const, nextCursor: null } : {}),
      },
    };
  }

  // 2. Query based on activity type
  if (type === "referrals") {
    const where = {
      storeId,
      advocateAccountId: account.id,
    };

    if (cursorMode) {
      const position = decodedCursor as
        | Extract<CustomerActivityCursor, { type: "referrals" }>
        | undefined;
      const referrals = await prisma.weleticLoyaltyReferral.findMany({
        where: {
          ...where,
          ...(position
            ? {
                OR: [
                  { createdAt: { lt: new Date(position.timestamp) } },
                  {
                    createdAt: new Date(position.timestamp),
                    id: { lt: position.id },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: safeLimit + 1,
        include: { refereeAccount: { include: { shopper: true } } },
      });
      const hasMore = referrals.length > safeLimit;
      const visible = referrals.slice(0, safeLimit);
      const last = visible.at(-1);
      return {
        type,
        activities: visible.map((r) => ({
          id: r.id,
          status: r.status,
          refereeName: r.refereeAccount?.shopper?.firstName || "Friend",
          advocatePointsAwarded: r.advocatePointsAwarded.toString(),
          refereePointsAwarded: r.refereePointsAwarded.toString(),
          rewardedAt: r.rewardedAt,
          createdAt: r.createdAt,
        })),
        pagination: {
          page: 1,
          limit: safeLimit,
          total: 0,
          totalPages: 0,
          hasMore,
          mode: "cursor",
          nextCursor:
            hasMore && last
              ? encodeActivityCursor({
                  v: 1,
                  type: "referrals",
                  timestamp: last.createdAt.toISOString(),
                  id: last.id,
                })
              : null,
        },
      };
    }

    const [total, referrals] = await Promise.all([
      prisma.weleticLoyaltyReferral.count({ where }),
      prisma.weleticLoyaltyReferral.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: safeLimit,
        include: {
          refereeAccount: {
            include: { shopper: true },
          },
        },
      }),
    ]);

    const activities = referrals.map((r) => ({
      id: r.id,
      status: r.status,
      refereeName: r.refereeAccount?.shopper?.firstName || "Friend",
      advocatePointsAwarded: r.advocatePointsAwarded.toString(),
      refereePointsAwarded: r.refereePointsAwarded.toString(),
      rewardedAt: r.rewardedAt,
      createdAt: r.createdAt,
    }));

    return {
      type,
      activities,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
        hasMore: safePage * safeLimit < total,
      },
    };
  }

  if (type === "vip") {
    const where = {
      accountId: account.id,
    };

    if (cursorMode) {
      const position = decodedCursor as
        | Extract<CustomerActivityCursor, { type: "vip" }>
        | undefined;
      const histories = await prisma.weleticLoyaltyTierHistory.findMany({
        where: {
          ...where,
          ...(position
            ? {
                OR: [
                  { effectiveAt: { lt: new Date(position.timestamp) } },
                  {
                    effectiveAt: new Date(position.timestamp),
                    id: { lt: position.id },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
        take: safeLimit + 1,
        include: {
          fromTier: { select: { id: true, name: true } },
          toTier: { select: { id: true, name: true } },
        },
      });
      const hasMore = histories.length > safeLimit;
      const visible = histories.slice(0, safeLimit);
      const last = visible.at(-1);
      return {
        type,
        activities: visible.map((entry) => ({
          id: entry.id,
          fromTier: entry.fromTier,
          toTier: entry.toTier,
          changeReason: entry.changeReason,
          qualifyingSpendSnapshot:
            entry.qualifyingSpendSnapshot?.toString() ?? null,
          qualifyingPointsSnapshot:
            entry.qualifyingPointsSnapshot?.toString() ?? null,
          effectiveAt: entry.effectiveAt,
        })),
        pagination: {
          page: 1,
          limit: safeLimit,
          total: 0,
          totalPages: 0,
          hasMore,
          mode: "cursor",
          nextCursor:
            hasMore && last
              ? encodeActivityCursor({
                  v: 1,
                  type: "vip",
                  timestamp: last.effectiveAt.toISOString(),
                  id: last.id,
                })
              : null,
        },
      };
    }

    const [total, histories] = await Promise.all([
      prisma.weleticLoyaltyTierHistory.count({ where }),
      prisma.weleticLoyaltyTierHistory.findMany({
        where,
        orderBy: [{ effectiveAt: "desc" }, { id: "desc" }],
        skip,
        take: safeLimit,
        include: {
          fromTier: { select: { id: true, name: true } },
          toTier: { select: { id: true, name: true } },
        },
      }),
    ]);

    const activities = histories.map((entry) => ({
      id: entry.id,
      fromTier: entry.fromTier,
      toTier: entry.toTier,
      changeReason: entry.changeReason,
      qualifyingSpendSnapshot:
        entry.qualifyingSpendSnapshot?.toString() ?? null,
      qualifyingPointsSnapshot:
        entry.qualifyingPointsSnapshot?.toString() ?? null,
      effectiveAt: entry.effectiveAt,
    }));

    return {
      type,
      activities,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.ceil(total / safeLimit),
        hasMore: safePage * safeLimit < total,
      },
    };
  }

  // Default: Points ledger entries
  const where = {
    storeId,
    accountId: account.id,
  };

  if (cursorMode) {
    const position = decodedCursor as
      | Extract<CustomerActivityCursor, { type: "points" }>
      | undefined;
    const ledgerEntries = await prisma.weleticPointsLedgerEntry.findMany({
      where: {
        ...where,
        ...(position
          ? {
              OR: [
                { sequenceNumber: { lt: position.sequenceNumber } },
                {
                  sequenceNumber: position.sequenceNumber,
                  id: { lt: position.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ sequenceNumber: "desc" }, { id: "desc" }],
      take: safeLimit + 1,
      select: {
        id: true,
        sequenceNumber: true,
        entryType: true,
        pointsDelta: true,
        balanceAfter: true,
        reason: true,
        referenceType: true,
        referenceId: true,
        createdAt: true,
      },
    });
    const hasMore = ledgerEntries.length > safeLimit;
    const visible = ledgerEntries.slice(0, safeLimit);
    const last = visible.at(-1);
    return {
      type: "points",
      activities: visible.map((entry) => ({
        id: entry.id,
        entryType: entry.entryType,
        pointsDelta: entry.pointsDelta.toString(),
        balanceAfter: entry.balanceAfter.toString(),
        reason: entry.reason,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        createdAt: entry.createdAt,
      })),
      pagination: {
        page: 1,
        limit: safeLimit,
        total: 0,
        totalPages: 0,
        hasMore,
        mode: "cursor",
        nextCursor:
          hasMore && last
            ? encodeActivityCursor({
                v: 1,
                type: "points",
                sequenceNumber: last.sequenceNumber,
                id: last.id,
              })
            : null,
      },
    };
  }

  const [total, ledgerEntries] = await Promise.all([
    prisma.weleticPointsLedgerEntry.count({ where }),
    prisma.weleticPointsLedgerEntry.findMany({
      where,
      orderBy: [{ sequenceNumber: "desc" }, { createdAt: "desc" }],
      skip,
      take: safeLimit,
      select: {
        id: true,
        entryType: true,
        pointsDelta: true,
        balanceAfter: true,
        reason: true,
        referenceType: true,
        referenceId: true,
        createdAt: true,
      },
    }),
  ]);

  const activities = ledgerEntries.map((entry) => ({
    id: entry.id,
    entryType: entry.entryType,
    pointsDelta: entry.pointsDelta.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    reason: entry.reason,
    referenceType: entry.referenceType,
    referenceId: entry.referenceId,
    createdAt: entry.createdAt,
  }));

  return {
    type: "points",
    activities,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit),
      hasMore: safePage * safeLimit < total,
    },
  };
}
