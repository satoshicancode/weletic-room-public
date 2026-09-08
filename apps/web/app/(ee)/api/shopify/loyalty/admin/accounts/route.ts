import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import {
  assertActiveLoyaltyAccountForMutation,
  withActiveStoreLoyaltyMutation,
} from "@/lib/weletic/loyalty/merchant-write-fence";
import { loyaltySuccessResponse } from "@/lib/weletic/loyalty/response";
import { evaluateTierMaintenanceCycle } from "@/lib/weletic/loyalty/tier-lifecycle";
import { WeleticPointsLedgerEntryType } from "@prisma/client";

// GET /api/shopify/loyalty/admin/accounts - Search shopper accounts with pagination and filters
export const GET = withWorkspace(
  async ({ workspace, searchParams }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
    });

    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const storeId = store.id;
    const query = searchParams.query || searchParams.search;
    const accountId = searchParams.accountId;
    const tierId = searchParams.tierId;
    const page = Math.max(1, Number(searchParams.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(searchParams.limit) || 20));
    const skip = (page - 1) * limit;

    if (accountId) {
      const account = await prisma.weleticLoyaltyAccount.findFirst({
        where: { id: accountId, storeId },
        include: {
          shopper: true,
          currentTier: true,
          ledgerEntries: {
            orderBy: { createdAt: "desc" },
            take: 50,
          },
          redemptions: {
            orderBy: { createdAt: "desc" },
            take: 20,
          },
          tierHistory: {
            orderBy: { effectiveAt: "desc" },
            take: 10,
          },
        },
      });

      if (!account) {
        throw new DubApiError({
          code: "not_found",
          message: `Loyalty account '${accountId}' not found.`,
        });
      }

      return loyaltySuccessResponse(
        {
          id: account.id,
          storeId: account.storeId,
          status: account.status,
          pointsBalance: account.cachedPointsBalance.toString(),
          cachedPointsBalance: account.cachedPointsBalance.toString(),
          balance: account.cachedPointsBalance.toString(),
          pendingPoints: account.cachedPendingPoints.toString(),
          lifetimeEarned: account.lifetimePointsEarned.toString(),
          lifetimeEarnedPoints: account.lifetimePointsEarned.toString(),
          lifetimeRedeemed: account.lifetimePointsRedeemed.toString(),
          lifetimeRedeemedPoints: account.lifetimePointsRedeemed.toString(),
          referralCode: account.referralCode,
          referralCount: account.referralCount,
          tier: account.currentTier?.name ?? null,
          currentTier: account.currentTier
            ? {
                id: account.currentTier.id,
                name: account.currentTier.name,
                pointsMultiplier:
                  account.currentTier.pointsMultiplier.toString(),
              }
            : null,
          shopper: {
            id: account.shopper.id,
            shopifyCustomerId: account.shopper.shopifyCustomerId,
            firstName: account.shopper.firstName,
            lastName: account.shopper.lastName,
            email: account.shopper.email,
            phone: account.shopper.phone,
            ordersCount: account.shopper.ordersCount,
            totalSpent: account.shopper.totalSpent.toString(),
          },
          customer: {
            id: account.shopper.id,
            shopifyCustomerId: account.shopper.shopifyCustomerId,
            firstName: account.shopper.firstName,
            lastName: account.shopper.lastName,
            email: account.shopper.email,
            phone: account.shopper.phone,
            ordersCount: account.shopper.ordersCount,
            totalSpent: account.shopper.totalSpent.toString(),
          },
          ledgerEntries: account.ledgerEntries.map((e) => ({
            id: e.id,
            sequenceNumber: e.sequenceNumber,
            entryType: e.entryType,
            pointsDelta: e.pointsDelta.toString(),
            balanceAfter: e.balanceAfter.toString(),
            referenceType: e.referenceType,
            referenceId: e.referenceId,
            reason: e.reason,
            createdAt: e.createdAt,
          })),
          redemptions: account.redemptions.map((r) => ({
            id: r.id,
            pointsSpent: r.pointsSpent.toString(),
            shopifyDiscountCode: r.shopifyDiscountCode,
            status: r.status,
            createdAt: r.createdAt,
          })),
          tierHistory: account.tierHistory.map((t) => ({
            id: t.id,
            toTierId: t.toTierId,
            changeReason: t.changeReason,
            effectiveAt: t.effectiveAt,
          })),
          enrolledAt: account.enrolledAt,
        },
        { headers: COMMON_CORS_HEADERS },
      );
    }

    const whereClause: any = {
      storeId,
      ...(tierId ? { currentTierId: tierId } : {}),
      ...(query
        ? {
            OR: [
              { referralCode: { contains: query } },
              {
                shopper: {
                  OR: [
                    { firstName: { contains: query } },
                    { lastName: { contains: query } },
                    { email: { contains: query } },
                    { shopifyCustomerId: { contains: query } },
                  ],
                },
              },
            ],
          }
        : {}),
    };

    const [total, accounts] = await Promise.all([
      prisma.weleticLoyaltyAccount.count({ where: whereClause }),
      prisma.weleticLoyaltyAccount.findMany({
        where: whereClause,
        include: {
          shopper: {
            select: {
              id: true,
              shopifyCustomerId: true,
              firstName: true,
              lastName: true,
              email: true,
              phone: true,
              ordersCount: true,
              totalSpent: true,
            },
          },
          currentTier: {
            select: {
              id: true,
              name: true,
              pointsMultiplier: true,
            },
          },
        },
        orderBy: { enrolledAt: "desc" },
        skip,
        take: limit,
      }),
    ]);

    const pagination = {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    return loyaltySuccessResponse(
      {
        ...pagination,
        pagination,
        accounts: accounts.map((a) => ({
          id: a.id,
          status: a.status,
          pointsBalance: a.cachedPointsBalance?.toString() ?? "0",
          cachedPointsBalance: a.cachedPointsBalance?.toString() ?? "0",
          balance: a.cachedPointsBalance?.toString() ?? "0",
          pendingPoints: a.cachedPendingPoints?.toString() ?? "0",
          lifetimeEarned: a.lifetimePointsEarned?.toString() ?? "0",
          lifetimeEarnedPoints: a.lifetimePointsEarned?.toString() ?? "0",
          referralCode: a.referralCode,
          referralCount: a.referralCount ?? 0,
          tier: a.currentTier?.name ?? null,
          currentTier: a.currentTier
            ? {
                id: a.currentTier.id,
                name: a.currentTier.name,
                pointsMultiplier:
                  a.currentTier.pointsMultiplier?.toString() ?? "1.0",
              }
            : null,
          multiplier: a.currentTier?.pointsMultiplier?.toString() ?? "1.0",
          customer: {
            id: a.shopper?.id,
            shopifyCustomerId: a.shopper?.shopifyCustomerId,
            firstName: a.shopper?.firstName,
            lastName: a.shopper?.lastName,
            email: a.shopper?.email,
            phone: (a.shopper as any)?.phone,
            ordersCount: a.shopper?.ordersCount ?? 0,
            totalSpent: a.shopper?.totalSpent?.toString() ?? "0",
          },
          shopper: {
            id: a.shopper?.id,
            shopifyCustomerId: a.shopper?.shopifyCustomerId,
            firstName: a.shopper?.firstName,
            lastName: a.shopper?.lastName,
            email: a.shopper?.email,
            phone: (a.shopper as any)?.phone,
            ordersCount: a.shopper?.ordersCount ?? 0,
            totalSpent: a.shopper?.totalSpent?.toString() ?? "0",
          },
          enrolledAt: a.enrolledAt,
        })),
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.read"],
  },
);

// POST /api/shopify/loyalty/admin/accounts - Handle manual balance adjustments (Owner Only)
export const POST = withWorkspace(
  async ({ workspace, req, session }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
    });

    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const storeId = store.id;
    const body = await parseRequestBody(req);
    const {
      accountId,
      shopperId,
      shopifyCustomerId,
      pointsDelta,
      reason,
      notes,
      idempotencyKey,
    } = body;

    if (pointsDelta === undefined || Number(pointsDelta) === 0) {
      throw new DubApiError({
        code: "bad_request",
        message: "A non-zero 'pointsDelta' is required.",
      });
    }

    // Resolve target loyalty account
    let targetAccountId = accountId;
    if (!targetAccountId) {
      const shopper = await prisma.weleticShopper.findFirst({
        where: {
          storeId,
          ...(shopperId ? { id: shopperId } : {}),
          ...(shopifyCustomerId
            ? { shopifyCustomerId: String(shopifyCustomerId) }
            : {}),
        },
        include: { loyaltyAccount: true },
      });

      if (!shopper || !shopper.loyaltyAccount) {
        throw new DubApiError({
          code: "not_found",
          message: "Target customer loyalty account not found.",
        });
      }
      targetAccountId = shopper.loyaltyAccount.id;
    } else {
      const existing = await prisma.weleticLoyaltyAccount.findFirst({
        where: { id: targetAccountId, storeId },
      });
      if (!existing) {
        throw new DubApiError({
          code: "not_found",
          message: "Target customer loyalty account not found for this store.",
        });
      }
    }

    const key =
      idempotencyKey || `admin_acc_adj:${targetAccountId}:${Date.now()}`;

    const ledgerEntry = await withActiveStoreLoyaltyMutation({
      storeId,
      action: "loyalty_admin_account_adjustment",
      operation: async (tx, installationGeneration) => {
        await assertActiveLoyaltyAccountForMutation({
          tx,
          storeId,
          accountId: targetAccountId,
        });
        const entry = await appendPointsLedgerEntry({
          storeId,
          accountId: targetAccountId,
          entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
          pointsDelta: BigInt(pointsDelta),
          idempotencyKey: key,
          reason: reason || "Merchant manual points adjustment",
          metadata: {
            notes,
            adjustedBy: session?.user?.email || "admin",
            timestamp: new Date().toISOString(),
          },
          tx,
        });
        await evaluateTierMaintenanceCycle({
          storeId,
          accountId: targetAccountId,
          expectedInstallationGeneration: installationGeneration,
          tx,
        });
        return entry;
      },
    });

    return loyaltySuccessResponse(
      {
        success: true,
        ledgerEntryId: ledgerEntry.id,
        accountId: targetAccountId,
        entryType: ledgerEntry.entryType,
        pointsDelta: ledgerEntry.pointsDelta.toString(),
        balanceAfter: ledgerEntry.balanceAfter.toString(),
        newBalance: ledgerEntry.balanceAfter.toString(),
        reason: ledgerEntry.reason,
        createdAt: ledgerEntry.createdAt,
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.write"],
    requiredRoles: ["owner"],
  },
);

export const OPTIONS = () => {
  return new Response(null, {
    status: 204,
    headers: COMMON_CORS_HEADERS,
  });
};
