import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { calculateMemberCohortAttribution } from "@/lib/weletic/loyalty/analytics";
import { loyaltySuccessResponse } from "@/lib/weletic/loyalty/response";
import { Prisma } from "@prisma/client";

function parseOptionalDate(value: string | undefined, field: string) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new DubApiError({
      code: "bad_request",
      message: `${field} must be a valid date.`,
    });
  }
  return parsed;
}

// GET /api/shopify/loyalty/admin/analytics/cohorts - Owner-only cohort metrics in accounting currency
export const GET = withWorkspace(
  async ({ workspace, searchParams }) => {
    if (workspace.users[0]?.role !== "owner") {
      throw new DubApiError({
        code: "forbidden",
        message: "Only workspace owners can view loyalty cohort economics.",
      });
    }

    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
      select: {
        id: true,
        program: { select: { accountingCurrency: true } },
      },
    });
    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const startDate = parseOptionalDate(searchParams.startDate, "startDate");
    const endDate = parseOptionalDate(searchParams.endDate, "endDate");
    if (startDate && endDate && startDate > endDate) {
      throw new DubApiError({
        code: "bad_request",
        message: "startDate must not be after endDate.",
      });
    }
    const result = await prisma.$transaction(
      (tx) =>
        calculateMemberCohortAttribution({
          storeId: store.id,
          currency: store.program.accountingCurrency,
          dateRange:
            startDate || endDate
              ? {
                  startDate,
                  endDate,
                }
              : undefined,
          tx,
        }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return loyaltySuccessResponse(result, { headers: COMMON_CORS_HEADERS });
  },
  { requiredPermissions: ["loyalty.read"] },
);

export const OPTIONS = () =>
  new Response(null, { status: 204, headers: COMMON_CORS_HEADERS });
