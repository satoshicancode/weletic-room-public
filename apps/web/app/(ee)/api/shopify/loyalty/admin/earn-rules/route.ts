import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  CUSTOMER_INTENT_TRIGGER_CODES,
  isCustomerIntentTriggerCode,
  validateCustomerIntentConditions,
} from "@/lib/weletic/loyalty/earning-actions";
import {
  EarningRuleWriteError,
  retireEarningRuleInTransaction,
  writeEarningRuleInTransaction,
} from "@/lib/weletic/loyalty/earning-rule-writer";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { loyaltySuccessResponse } from "@/lib/weletic/loyalty/response";
import { reviewRewardConditionsSchema } from "@/lib/weletic/loyalty/review-rewards";
import { Prisma } from "@prisma/client";

async function asWorkspaceWrite<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof EarningRuleWriteError)
      throw new DubApiError({ code: error.code, message: error.message });
    throw error;
  }
}

const SUPPORTED_TRIGGER_CODES = [
  "order_paid",
  "account_created",
  "birthday",
  "product_review",
  ...CUSTOMER_INTENT_TRIGGER_CODES,
] as const;

type SupportedTriggerCode = (typeof SUPPORTED_TRIGGER_CODES)[number];

function parseTriggerCode(value: unknown): SupportedTriggerCode {
  const triggerCode = String(value || "order_paid") as SupportedTriggerCode;
  if (!SUPPORTED_TRIGGER_CODES.includes(triggerCode)) {
    throw new DubApiError({
      code: "bad_request",
      message: `Unsupported earning trigger. Use one of: ${SUPPORTED_TRIGGER_CODES.join(", ")}.`,
    });
  }
  return triggerCode;
}

function parseOptionalPositiveBigInt(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = BigInt(value as string | number | bigint);
    if (parsed <= BigInt(0)) throw new Error("not positive");
    return parsed;
  } catch {
    throw new DubApiError({
      code: "bad_request",
      message: `${field} must be a positive integer.`,
    });
  }
}

function parseOptionalNonNegativeDecimal(value: unknown, field: string) {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = new Prisma.Decimal(value as Prisma.Decimal.Value);
    if (!parsed.isFinite() || parsed.lt(0)) throw new Error("negative");
    return parsed;
  } catch {
    throw new DubApiError({
      code: "bad_request",
      message: `${field} must be a non-negative decimal.`,
    });
  }
}

export const GET = withWorkspace(
  async ({ workspace }) => {
    const store = await prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspace.id },
    });

    if (!store) {
      throw new DubApiError({
        code: "not_found",
        message: "Shopify store not connected to this workspace.",
      });
    }

    const program = await prisma.weleticLoyaltyProgram.findUnique({
      where: { storeId: store.id },
      include: {
        earningRules: {
          where: { deletedAt: null },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!program) {
      return loyaltySuccessResponse(
        { rules: [] },
        { headers: COMMON_CORS_HEADERS },
      );
    }

    return loyaltySuccessResponse(
      {
        rules: program.earningRules,
        programId: program.id,
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.read"],
  },
);

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
      ruleId,
      name,
      description = null,
      triggerCode: requestedTriggerCode = "order_paid",
      multiplier = 1.0,
      fixedPoints = null,
      priority = 0,
      maxPointsPerEvent = null,
      minOrderSubtotal = null,
      excludeDiscountedItems = false,
      excludeTaxesAndShipping = true,
      maxEventsPerCustomer,
      limitInterval,
      conditions = null,
      isActive = true,
    } = body;

    if (!name) {
      throw new DubApiError({
        code: "bad_request",
        message: "Field 'name' is required.",
      });
    }

    const triggerCode = parseTriggerCode(requestedTriggerCode);
    const isOrderRule = triggerCode === "order_paid";
    const isReviewRule = triggerCode === "product_review";
    if (typeof isActive !== "boolean") {
      throw new DubApiError({
        code: "bad_request",
        message: "Earning rule 'isActive' must be a boolean.",
      });
    }
    const parsedMultiplier = Number(multiplier);
    const parsedFixedPoints = parseOptionalPositiveBigInt(
      fixedPoints,
      "fixedPoints",
    );
    const parsedMaxPointsPerEvent = parseOptionalPositiveBigInt(
      maxPointsPerEvent,
      "maxPointsPerEvent",
    );
    const parsedMinOrderSubtotal = parseOptionalNonNegativeDecimal(
      minOrderSubtotal,
      "minOrderSubtotal",
    );
    const parsedPriority = Number(priority);

    if (!Number.isFinite(parsedMultiplier) || parsedMultiplier <= 0) {
      throw new DubApiError({
        code: "bad_request",
        message: "Earning rules require a positive multiplier.",
      });
    }
    if (!Number.isSafeInteger(parsedPriority)) {
      throw new DubApiError({
        code: "bad_request",
        message: "Earning rule priority must be a safe integer.",
      });
    }
    if (isOrderRule && excludeTaxesAndShipping !== true) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "Order earning currently requires taxes and shipping to be excluded so refund clawbacks remain line-auditable.",
      });
    }
    if (
      !isOrderRule &&
      (!parsedFixedPoints || parsedFixedPoints <= BigInt(0))
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "Non-order earning rules require positive fixedPoints.",
      });
    }

    const parsedLimitInterval = String(
      limitInterval || (isReviewRule ? "monthly" : "lifetime"),
    );
    if (
      !isOrderRule &&
      !["lifetime", "monthly", "calendar_year"].includes(parsedLimitInterval)
    ) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "Non-order earning limits must use lifetime, monthly, or calendar_year.",
      });
    }
    const parsedMaxEvents = Number(
      maxEventsPerCustomer ?? (isReviewRule ? 2 : 1),
    );
    if (
      !isOrderRule &&
      (!Number.isInteger(parsedMaxEvents) ||
        parsedMaxEvents < 1 ||
        parsedMaxEvents > 100)
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "Earning limits must allow between 1 and 100 events.",
      });
    }

    let normalizedConditions: Record<string, unknown> | null = null;
    if (isCustomerIntentTriggerCode(triggerCode)) {
      try {
        normalizedConditions = validateCustomerIntentConditions({
          triggerCode,
          conditions,
        });
      } catch (error) {
        throw new DubApiError({
          code: "bad_request",
          message:
            error instanceof Error
              ? error.message
              : "Invalid earning action configuration.",
        });
      }
    } else if (isReviewRule) {
      try {
        normalizedConditions = reviewRewardConditionsSchema.parse(
          conditions ?? {},
        );
      } catch (error) {
        throw new DubApiError({
          code: "bad_request",
          message:
            error instanceof Error
              ? error.message
              : "Invalid product review configuration.",
        });
      }
    }

    const ruleData = {
      name,
      description,
      triggerCode,
      ruleType: isOrderRule ? "multiplier" : "fixed_points",
      priority: parsedPriority,
      multiplier: new Prisma.Decimal(isOrderRule ? parsedMultiplier : 1),
      fixedPoints: isOrderRule ? null : parsedFixedPoints,
      maxPointsPerEvent: parsedMaxPointsPerEvent,
      maxEventsPerCustomer: isOrderRule ? null : parsedMaxEvents,
      limitInterval: isOrderRule
        ? null
        : triggerCode === "birthday"
          ? "calendar_year"
          : triggerCode === "account_created"
            ? "lifetime"
            : parsedLimitInterval,
      conditions: normalizedConditions
        ? (normalizedConditions as Prisma.InputJsonValue)
        : Prisma.DbNull,
      minOrderSubtotal: isOrderRule ? parsedMinOrderSubtotal : null,
      excludeDiscountedItems: Boolean(excludeDiscountedItems),
      excludeTaxesAndShipping: true,
      isActive: Boolean(isActive),
    } satisfies Prisma.WeleticLoyaltyEarningRuleUncheckedUpdateInput;
    const rule = await withActiveStoreLoyaltyMutation({
      storeId,
      action: "loyalty_earning_rule_write",
      operation: (tx) =>
        asWorkspaceWrite(() =>
          writeEarningRuleInTransaction({ tx, storeId, ruleId, ruleData }),
        ),
    });

    return loyaltySuccessResponse(
      {
        success: true,
        rule,
      },
      { headers: COMMON_CORS_HEADERS },
    );
  },
  {
    requiredPermissions: ["loyalty.write"],
  },
);

export const DELETE = withWorkspace(
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

    const ruleId = searchParams.ruleId || searchParams.id;

    if (!ruleId) {
      throw new DubApiError({
        code: "bad_request",
        message: "Missing required parameter: 'ruleId' or 'id'.",
      });
    }

    const program = await prisma.weleticLoyaltyProgram.findUnique({
      where: { storeId: store.id },
    });

    if (!program) {
      throw new DubApiError({
        code: "not_found",
        message: "Loyalty program not found.",
      });
    }

    const existing = await prisma.weleticLoyaltyEarningRule.findFirst({
      where: { id: ruleId, programId: program.id, deletedAt: null },
    });

    if (!existing) {
      throw new DubApiError({
        code: "not_found",
        message: `Earning rule '${ruleId}' not found for this store.`,
      });
    }

    await withActiveStoreLoyaltyMutation({
      storeId: store.id,
      action: "loyalty_earning_rule_delete",
      operation: (tx) =>
        asWorkspaceWrite(() =>
          retireEarningRuleInTransaction({ tx, storeId: store.id, ruleId }),
        ),
    });

    return loyaltySuccessResponse(
      { success: true, deletedRuleId: ruleId },
      { headers: COMMON_CORS_HEADERS },
    );
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
