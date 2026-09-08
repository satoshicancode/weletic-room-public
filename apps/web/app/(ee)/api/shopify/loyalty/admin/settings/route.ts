import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { publishLoyaltyEarnPolicyRevision } from "@/lib/weletic/loyalty/earn-policy-revision";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { loyaltySuccessResponse } from "@/lib/weletic/loyalty/response";
import {
  LoyaltySettingsValidationError,
  readNonNegativeInteger as validateNonNegativeInteger,
  readNullablePositiveBigInt as validateNullablePositiveBigInt,
  readPositiveDecimal as validatePositiveDecimal,
} from "@/lib/weletic/loyalty/settings-validation";
import {
  LoyaltySettingsWriteError,
  writeValidatedLoyaltySettingsInTransaction,
} from "@/lib/weletic/loyalty/settings-writer";
import { normalizeCurrency } from "@/lib/weletic/money";

const MAX_LOYALTY_HOLDING_PERIOD_DAYS = 365;
// Preserve the workspace API's error contract while sharing transport-neutral
// numeric validation with the embedded Shopify configuration gateway.
function asWorkspaceValidation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LoyaltySettingsValidationError)
      throw new DubApiError({ code: "bad_request", message: error.message });
    throw error;
  }
}

const readNullablePositiveBigInt = (value: unknown, field: string) =>
  asWorkspaceValidation(() => validateNullablePositiveBigInt(value, field));
const readPositiveDecimal = (value: unknown, field: string) =>
  asWorkspaceValidation(() => validatePositiveDecimal(value, field));
const readNonNegativeInteger = (
  value: unknown,
  field: string,
  maximum?: number,
) =>
  asWorkspaceValidation(() =>
    validateNonNegativeInteger(value, field, maximum),
  );

// GET /api/shopify/loyalty/admin/settings - Fetch loyalty program settings
export const GET = withWorkspace(
  async ({ workspace }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
      include: { program: { select: { accountingCurrency: true } } },
    });

    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const storeId = store.id;
    let program = await prisma.weleticLoyaltyProgram.findUnique({
      where: { storeId },
      include: {
        store: {
          select: {
            id: true,
            shopDomain: true,
            shopCurrency: true,
          },
        },
        referralRules: {
          where: { isActive: true },
          take: 1,
        },
      },
    });

    if (!program) {
      program = await withActiveStoreLoyaltyMutation({
        storeId,
        action: "loyalty_admin_settings_initialize",
        operation: async (tx) => {
          // Recheck after the store write fence: another request may have
          // initialized the program while this request waited for it.
          const existing = await tx.weleticLoyaltyProgram.findUnique({
            where: { storeId },
            include: {
              store: {
                select: { id: true, shopDomain: true, shopCurrency: true },
              },
              referralRules: { where: { isActive: true }, take: 1 },
            },
          });
          if (existing) return existing;
          const created = await tx.weleticLoyaltyProgram.create({
            data: {
              id: createWeleticId("wprog_"),
              storeId,
              name: "Customer Loyalty Program",
              status: "draft",
            },
            include: {
              store: {
                select: {
                  id: true,
                  shopDomain: true,
                  shopCurrency: true,
                },
              },
              referralRules: true,
            },
          });
          await publishLoyaltyEarnPolicyRevision({
            tx,
            storeId,
            programId: created.id,
            reason: "loyalty_program_initialized",
          });
          return created;
        },
      });
    }

    return loyaltySuccessResponse(
      {
        ...program,
        accountingCurrency: store.program.accountingCurrency,
      },
      {
        headers: COMMON_CORS_HEADERS,
      },
    );
  },
  {
    requiredPermissions: ["loyalty.read"],
  },
);

// POST /api/shopify/loyalty/admin/settings - Update loyalty program configuration (Owner guarded for sensitive status/kill switch)
export const POST = withWorkspace(
  async ({ workspace, req }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
      include: { program: { select: { accountingCurrency: true } } },
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
      name,
      status,
      pointNameSingular,
      pointNamePlural,
      pointsPerCurrencyUnit,
      liabilityValuationCurrency,
      liabilityMinorUnitsNumerator,
      liabilityPointsDenominator,
      holdingPeriodDays,
      pointsExpiryMonths,
      pointsExpiryDays,
      pointsExpiryWarningDays,
      pointsExpiryLastChanceDays,
      pointsExpiryWarningEnabled,
      pointsExpiryLastChanceEnabled,
      killSwitchActive,
      vipMilestoneMode,
      vipTimeframe,
      vipDowngradeGraceDays,
      vipGracePeriodDays,
      vipAutoDowngradeEnabled,
      expectedInstallationGeneration,
      expectedStatus,
    } = body;
    if (
      status !== undefined &&
      !["draft", "test", "active", "disabled"].includes(status)
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "status must be draft, test, active, or disabled.",
      });
    }
    if (
      expectedInstallationGeneration !== undefined &&
      (typeof expectedInstallationGeneration !== "string" ||
        expectedInstallationGeneration.length < 1 ||
        expectedInstallationGeneration.length > 64)
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "Invalid expected installation generation",
      });
    }
    if (
      expectedStatus !== undefined &&
      !["not_configured", "draft", "test", "active", "disabled"].includes(
        expectedStatus,
      )
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "Invalid expected program status",
      });
    }
    const parsedHoldingPeriodDays = readNonNegativeInteger(
      holdingPeriodDays,
      "holdingPeriodDays",
      MAX_LOYALTY_HOLDING_PERIOD_DAYS,
    );
    const parsedPointsPerCurrencyUnit = readPositiveDecimal(
      pointsPerCurrencyUnit,
      "pointsPerCurrencyUnit",
    );
    const valuationFieldsPresent = [
      "liabilityValuationCurrency",
      "liabilityMinorUnitsNumerator",
      "liabilityPointsDenominator",
    ].some((field) => Object.prototype.hasOwnProperty.call(body, field));
    const valuationFieldsAllPresent = [
      "liabilityValuationCurrency",
      "liabilityMinorUnitsNumerator",
      "liabilityPointsDenominator",
    ].every((field) => Object.prototype.hasOwnProperty.call(body, field));
    if (valuationFieldsPresent && !valuationFieldsAllPresent) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "Liability valuation currency, numerator, and denominator must be updated together.",
      });
    }
    const parsedLiabilityNumerator = readNullablePositiveBigInt(
      liabilityMinorUnitsNumerator,
      "liabilityMinorUnitsNumerator",
    );
    const parsedLiabilityDenominator = readNullablePositiveBigInt(
      liabilityPointsDenominator,
      "liabilityPointsDenominator",
    );
    const valuationDisabled =
      valuationFieldsPresent &&
      liabilityValuationCurrency === null &&
      parsedLiabilityNumerator === null &&
      parsedLiabilityDenominator === null;
    let normalizedValuationCurrency: string | null | undefined;
    if (valuationFieldsPresent && !valuationDisabled) {
      if (
        typeof liabilityValuationCurrency !== "string" ||
        parsedLiabilityNumerator === null ||
        parsedLiabilityNumerator === undefined ||
        parsedLiabilityDenominator === null ||
        parsedLiabilityDenominator === undefined
      ) {
        throw new DubApiError({
          code: "bad_request",
          message:
            "Liability valuation must be either fully configured or fully cleared with null values.",
        });
      }
      try {
        normalizedValuationCurrency = normalizeCurrency(
          liabilityValuationCurrency,
        );
      } catch {
        throw new DubApiError({
          code: "bad_request",
          message: "liabilityValuationCurrency must be a valid ISO 4217 code.",
        });
      }
      const accountingCurrency = normalizeCurrency(
        store.program.accountingCurrency,
      );
      if (normalizedValuationCurrency !== accountingCurrency) {
        throw new DubApiError({
          code: "bad_request",
          message: `Liability valuation currency must match program accounting currency ${accountingCurrency}.`,
        });
      }
    } else if (valuationDisabled) {
      normalizedValuationCurrency = null;
    }
    const requestedVipGraceDays = vipDowngradeGraceDays ?? vipGracePeriodDays;
    const parsedVipGraceDays = readNonNegativeInteger(
      requestedVipGraceDays,
      "vipDowngradeGraceDays",
      365,
    );
    if (
      vipMilestoneMode !== undefined &&
      !["amount_spent", "points_earned", "both"].includes(vipMilestoneMode)
    ) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "vipMilestoneMode must be amount_spent, points_earned, or both.",
      });
    }
    if (
      vipTimeframe !== undefined &&
      !["rolling_12m", "calendar_year", "lifetime"].includes(vipTimeframe)
    ) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "vipTimeframe must be rolling_12m, calendar_year, or lifetime.",
      });
    }
    if (
      vipAutoDowngradeEnabled !== undefined &&
      typeof vipAutoDowngradeEnabled !== "boolean"
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "vipAutoDowngradeEnabled must be a boolean.",
      });
    }

    const parsedExpiryMonths = readNonNegativeInteger(
      pointsExpiryMonths,
      "pointsExpiryMonths",
      24,
    );
    const parsedExpiryDays = readNonNegativeInteger(
      pointsExpiryDays,
      "pointsExpiryDays",
      730,
    );
    const parsedWarningDays = readNonNegativeInteger(
      pointsExpiryWarningDays,
      "pointsExpiryWarningDays",
      730,
    );
    const parsedLastChanceDays = readNonNegativeInteger(
      pointsExpiryLastChanceDays,
      "pointsExpiryLastChanceDays",
      730,
    );
    if (
      Number(parsedExpiryDays || 0) > 0 &&
      Number(parsedExpiryMonths || 0) > 0
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "Configure points expiry in either days or months, not both.",
      });
    }
    if (
      pointsExpiryWarningEnabled !== undefined &&
      typeof pointsExpiryWarningEnabled !== "boolean"
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "pointsExpiryWarningEnabled must be a boolean.",
      });
    }
    if (
      pointsExpiryLastChanceEnabled !== undefined &&
      typeof pointsExpiryLastChanceEnabled !== "boolean"
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "pointsExpiryLastChanceEnabled must be a boolean.",
      });
    }

    // Owner authorization guard for status change & kill switch activation
    if (
      status !== undefined ||
      killSwitchActive !== undefined ||
      valuationFieldsPresent
    ) {
      if (workspace.users[0].role !== "owner") {
        throw new DubApiError({
          code: "forbidden",
          message:
            "Only workspace owners are authorized to change program status, the kill switch, or financial valuation settings.",
        });
      }
    }

    const program = await withActiveStoreLoyaltyMutation({
      storeId,
      action: "loyalty_admin_settings_update",
      expectedInstallationGeneration,
      operation: (tx) =>
        writeValidatedLoyaltySettingsInTransaction(tx, storeId, {
          expectedStatus,
          name,
          status,
          pointNameSingular,
          pointNamePlural,
          parsedPointsPerCurrencyUnit,
          normalizedValuationCurrency,
          parsedLiabilityNumerator,
          parsedLiabilityDenominator,
          valuationFieldsPresent,
          parsedHoldingPeriodDays,
          parsedExpiryDays,
          parsedExpiryMonths,
          parsedWarningDays,
          parsedLastChanceDays,
          pointsExpiryWarningEnabled,
          pointsExpiryLastChanceEnabled,
          killSwitchActive,
          vipMilestoneMode,
          vipTimeframe,
          parsedVipGraceDays,
          vipAutoDowngradeEnabled,
        }).catch((error: unknown) => {
          if (error instanceof LoyaltySettingsWriteError)
            throw new DubApiError({ code: error.code, message: error.message });
          throw error;
        }),
    });

    return loyaltySuccessResponse(program, {
      headers: COMMON_CORS_HEADERS,
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
