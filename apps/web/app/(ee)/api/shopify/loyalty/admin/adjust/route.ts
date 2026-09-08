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

// POST /api/shopify/loyalty/admin/adjust - Perform a manual points balance adjustment (Owner Only)
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

    const key = idempotencyKey || `admin_adj:${targetAccountId}:${Date.now()}`;

    const ledgerEntry = await withActiveStoreLoyaltyMutation({
      storeId,
      action: "loyalty_admin_manual_adjustment",
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
