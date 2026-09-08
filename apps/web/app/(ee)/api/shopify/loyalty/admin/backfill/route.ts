import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import {
  cancelBackfillJob,
  commitBackfillJob,
  createBackfillJob,
  generateBackfillPreview,
  getBackfillJob,
} from "@/lib/weletic/loyalty/backfill";
import { publishLoyaltyEarnPolicyRevision } from "@/lib/weletic/loyalty/earn-policy-revision";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import {
  loyaltyErrorResponse,
  loyaltySuccessResponse,
} from "@/lib/weletic/loyalty/response";

const BACKFILL_COMMITS_TEMPORARILY_DISABLED = true;

// GET /api/shopify/loyalty/admin/backfill - Get backfill job details or list store jobs
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
    const jobId = searchParams.jobId || searchParams.id;

    if (jobId) {
      const job = await getBackfillJob(jobId);
      if (!job || job.storeId !== storeId) {
        throw new DubApiError({
          code: "not_found",
          message: `Backfill job '${jobId}' not found for this store.`,
        });
      }
      return loyaltySuccessResponse(
        {
          id: job.id,
          storeId: job.storeId,
          programId: job.programId,
          status: job.status,
          lookbackDays: job.lookbackDays,
          pointsPerCurrencyUnit: job.pointsPerCurrencyUnit.toString(),
          totalShoppersCount: job.totalShoppersCount,
          totalOrdersCount: job.totalOrdersCount,
          totalProjectedPoints: job.totalProjectedPoints.toString(),
          processedAccountsCount: job.processedAccountsCount,
          totalCommittedPoints: job.totalCommittedPoints.toString(),
          previewMode:
            job.orderSnapshots.length > 0
              ? "per_order_immutable"
              : "legacy_account_aggregate",
          previewItemsCount:
            job.orderSnapshots.length > 0
              ? job.orderSnapshots.length
              : job.previewItems.length,
          previewItems:
            job.orderSnapshots.length > 0
              ? job.orderSnapshots.slice(0, 50).map((p) => ({
                  id: p.id,
                  shopperId: p.shopperId,
                  accountId: p.accountId,
                  orderId: p.orderId,
                  orderVersion: p.orderVersion,
                  orderStatus: p.orderStatus,
                  orderHash: p.orderHash,
                  policyRevisionId: p.policyRevisionId,
                  ordersCount: 1,
                  eligibleSpend: p.eligibleSpend.toString(),
                  refundedSpend: p.refundedSpend.toString(),
                  orderTotalAmount: p.orderTotalAmount.toString(),
                  currency: p.currency,
                  projectedPoints: p.projectedPoints.toString(),
                  lineAllocations: p.lineAllocations,
                }))
              : job.previewItems.slice(0, 50).map((p) => ({
                  id: p.id,
                  shopperId: p.shopperId,
                  accountId: p.accountId,
                  ordersCount: p.ordersCount,
                  eligibleSpend: p.eligibleSpend.toString(),
                  currency: p.currency,
                  projectedPoints: p.projectedPoints.toString(),
                  committedLedgerEntryId: p.committedLedgerEntryId,
                })),
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          completedAt: job.completedAt,
        },
        { headers: COMMON_CORS_HEADERS },
      );
    }

    const jobs = await prisma.weleticLoyaltyBackfillJob.findMany({
      where: { storeId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    return loyaltySuccessResponse(
      jobs.map((j) => ({
        id: j.id,
        status: j.status,
        lookbackDays: j.lookbackDays,
        totalShoppersCount: j.totalShoppersCount,
        totalOrdersCount: j.totalOrdersCount,
        totalProjectedPoints: j.totalProjectedPoints.toString(),
        totalCommittedPoints: j.totalCommittedPoints.toString(),
        createdAt: j.createdAt,
        completedAt: j.completedAt,
      })),
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.read"],
  },
);

// POST /api/shopify/loyalty/admin/backfill - Execute backfill actions (preview, commit, cancel)
export const POST = withWorkspace(
  async ({ workspace, req }) => {
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
      action,
      jobId,
      lookbackDays,
      pointsPerCurrencyUnit,
      minOrderAmount,
    } = body;

    const resolvedAction = action || (jobId ? "commit" : "preview");

    // Owner authorization guard for destructive/liability mutations
    if (resolvedAction === "commit" || resolvedAction === "cancel") {
      if (workspace.users[0].role !== "owner") {
        throw new DubApiError({
          code: "forbidden",
          message:
            "Only workspace owners are authorized to commit or cancel backfill jobs.",
        });
      }
    }

    if (resolvedAction === "preview" || resolvedAction === "create") {
      let program = await prisma.weleticLoyaltyProgram.findUnique({
        where: { storeId },
      });

      if (!program) {
        program = await withActiveStoreLoyaltyMutation({
          storeId,
          action: "loyalty_backfill_program_initialize",
          operation: async (tx) => {
            const existing = await tx.weleticLoyaltyProgram.findUnique({
              where: { storeId },
            });
            if (existing) return existing;
            const created = await tx.weleticLoyaltyProgram.create({
              data: {
                id: createWeleticId("wprog_"),
                storeId,
                name: "Customer Loyalty Program",
                status: "draft",
              },
            });
            await publishLoyaltyEarnPolicyRevision({
              tx,
              storeId,
              programId: created.id,
              reason: "loyalty_program_initialized_from_backfill",
            });
            return created;
          },
        });
      }

      const job = await createBackfillJob({
        storeId,
        programId: program.id,
        lookbackDays:
          lookbackDays !== undefined ? Number(lookbackDays) : undefined,
        pointsPerCurrencyUnit:
          pointsPerCurrencyUnit !== undefined
            ? Number(pointsPerCurrencyUnit)
            : undefined,
        minOrderAmount:
          minOrderAmount !== undefined ? Number(minOrderAmount) : undefined,
      });

      const preview = await generateBackfillPreview(job.id);
      const previewItems =
        await prisma.weleticLoyaltyBackfillOrderSnapshot.findMany({
          where: { jobId: job.id },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: 10,
        });

      return loyaltySuccessResponse(
        {
          success: true,
          jobId: job.id,
          status: preview.status,
          totalShoppersCount: preview.totalShoppersCount,
          totalOrdersCount: preview.totalOrdersCount,
          totalProjectedPoints: preview.totalProjectedPoints.toString(),
          previewMode: "per_order_immutable",
          previewItemsCount: preview.totalOrdersCount,
          previewItemsSample: previewItems.map((p) => ({
            shopperId: p.shopperId,
            orderId: p.orderId,
            orderVersion: p.orderVersion,
            orderStatus: p.orderStatus,
            orderHash: p.orderHash,
            policyRevisionId: p.policyRevisionId,
            ordersCount: 1,
            eligibleSpend: p.eligibleSpend.toString(),
            refundedSpend: p.refundedSpend.toString(),
            orderTotalAmount: p.orderTotalAmount.toString(),
            currency: p.currency,
            projectedPoints: p.projectedPoints.toString(),
            lineAllocations: p.lineAllocations,
          })),
        },
        { headers: COMMON_CORS_HEADERS },
      );
    }

    if (resolvedAction === "commit") {
      if (!jobId) {
        throw new DubApiError({
          code: "bad_request",
          message: "Missing required 'jobId' to commit backfill.",
        });
      }

      const existingJob = await prisma.weleticLoyaltyBackfillJob.findUnique({
        where: { id: jobId },
      });
      if (!existingJob || existingJob.storeId !== storeId) {
        throw new DubApiError({
          code: "not_found",
          message: `Backfill job '${jobId}' not found for this store.`,
        });
      }

      if (BACKFILL_COMMITS_TEMPORARILY_DISABLED) {
        return loyaltyErrorResponse(
          "backfill_commits_temporarily_disabled",
          "Historical backfill commits are temporarily disabled until staged schema validation and the zero-finding repair release gate pass. Preview and job inspection remain available.",
          503,
          undefined,
          { headers: COMMON_CORS_HEADERS },
        );
      }

      const result = await commitBackfillJob(jobId);

      return loyaltySuccessResponse(
        {
          success: true,
          jobId: result.id,
          status: result.status,
          processedAccountsCount: result.processedAccountsCount,
          totalCommittedPoints: result.totalCommittedPoints.toString(),
          completedAt: result.completedAt,
        },
        { headers: COMMON_CORS_HEADERS },
      );
    }

    if (resolvedAction === "cancel") {
      if (!jobId) {
        throw new DubApiError({
          code: "bad_request",
          message: "Missing required 'jobId' to cancel backfill.",
        });
      }

      const existingJob = await prisma.weleticLoyaltyBackfillJob.findUnique({
        where: { id: jobId },
      });
      if (!existingJob || existingJob.storeId !== storeId) {
        throw new DubApiError({
          code: "not_found",
          message: `Backfill job '${jobId}' not found for this store.`,
        });
      }

      const result = await cancelBackfillJob(jobId);

      return loyaltySuccessResponse(
        {
          success: true,
          jobId: result.id,
          status: result.status,
        },
        { headers: COMMON_CORS_HEADERS },
      );
    }

    throw new DubApiError({
      code: "bad_request",
      message: `Invalid action: '${resolvedAction}'. Must be 'preview', 'commit', or 'cancel'.`,
    });
  },
  {
    requiredPermissions: ["loyalty.write"],
  },
);

export const OPTIONS = () => {
  return new Response(null, {
    status: 204,
    headers: COMMON_CORS_HEADERS,
  });
};
