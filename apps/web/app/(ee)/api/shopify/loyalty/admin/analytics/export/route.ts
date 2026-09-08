import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  exportLoyaltyMetricsCsv,
  exportLoyaltyMetricsJson,
} from "@/lib/weletic/loyalty/analytics";
import { resolveLoyaltyFinancialConfiguration } from "@/lib/weletic/loyalty/analytics-financial";
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

// GET /api/shopify/loyalty/admin/analytics/export?format=json|csv - Owner-only exact export
export const GET = withWorkspace(
  async ({ workspace, searchParams }) => {
    if (workspace.users[0]?.role !== "owner") {
      throw new DubApiError({
        code: "forbidden",
        message: "Only workspace owners can export loyalty analytics.",
      });
    }
    const format = searchParams.format || "json";
    if (format !== "json" && format !== "csv") {
      throw new DubApiError({
        code: "bad_request",
        message: "format must be json or csv.",
      });
    }

    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
      select: {
        id: true,
        program: { select: { accountingCurrency: true } },
        loyaltyProgram: {
          select: {
            liabilityValuationCurrency: true,
            liabilityMinorUnitsNumerator: true,
            liabilityPointsDenominator: true,
          },
        },
      },
    });
    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const financialConfiguration = resolveLoyaltyFinancialConfiguration({
      accountingCurrency: store.program.accountingCurrency,
      liabilityValuationCurrency:
        store.loyaltyProgram?.liabilityValuationCurrency,
      liabilityMinorUnitsNumerator:
        store.loyaltyProgram?.liabilityMinorUnitsNumerator,
      liabilityPointsDenominator:
        store.loyaltyProgram?.liabilityPointsDenominator,
    });
    if (!financialConfiguration.valuation) {
      throw new DubApiError({
        code: "conflict",
        message:
          financialConfiguration.reason ||
          "Exact loyalty financial valuation is not configured.",
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
    const commonParams = {
      storeId: store.id,
      currency: financialConfiguration.accountingCurrency,
      liabilityMinorUnitsNumerator:
        financialConfiguration.valuation.minorUnitsNumerator,
      liabilityPointsDenominator:
        financialConfiguration.valuation.pointsDenominator,
      dateRange:
        startDate || endDate
          ? {
              startDate,
              endDate,
            }
          : undefined,
      callerRole: "owner" as const,
    };
    const validationResult = await prisma.$transaction(
      (tx) => exportLoyaltyMetricsJson({ ...commonParams, tx }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const dataQualityFailure =
      validationResult.healthMetrics.financialDataQuality.status !==
        "available" ||
      validationResult.cohortAttribution?.dataQuality.status !== "available";
    if (dataQualityFailure) {
      throw new DubApiError({
        code: "conflict",
        message:
          validationResult.healthMetrics.financialDataQuality.reason ||
          validationResult.cohortAttribution?.dataQuality.reason ||
          "Order accounting currencies failed loyalty analytics reconciliation.",
      });
    }

    if (format === "csv") {
      const csv = await exportLoyaltyMetricsCsv(commonParams, validationResult);
      return new Response(csv, {
        headers: {
          ...COMMON_CORS_HEADERS,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition":
            'attachment; filename="weletic-loyalty-analytics.csv"',
        },
      });
    }

    return loyaltySuccessResponse(validationResult, {
      headers: COMMON_CORS_HEADERS,
    });
  },
  { requiredPermissions: ["loyalty.read"] },
);

export const OPTIONS = () =>
  new Response(null, { status: 204, headers: COMMON_CORS_HEADERS });
