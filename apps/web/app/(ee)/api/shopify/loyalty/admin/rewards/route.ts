import { COMMON_CORS_HEADERS } from "@/lib/api/cors";
import { DubApiError } from "@/lib/api/errors";
import { parseRequestBody } from "@/lib/api/utils";
import { withWorkspace } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { withActiveStoreLoyaltyMutation } from "@/lib/weletic/loyalty/merchant-write-fence";
import { loyaltySuccessResponse } from "@/lib/weletic/loyalty/response";
import {
  createRewardDefinition,
  isValidFreeProductRewardScope,
  isValidPercentageRewardValue,
  isValidPositiveMinorUnitValue,
  isValidUsageLimitPerCustomer,
  listRewardDefinitions,
  RewardDefinitionConflictError,
  updateRewardDefinition,
} from "@/lib/weletic/loyalty/rewards";
import {
  WeleticRewardExchangeType,
  WeleticRewardSalesChannel,
  WeleticRewardStatus,
  WeleticRewardType,
} from "@prisma/client";

function serializeReward(reward: any) {
  return {
    ...reward,
    pointsCost: reward.pointsCost.toString(),
    pointsStep: reward.pointsStep?.toString() ?? null,
    minPointsCost: reward.minPointsCost?.toString() ?? null,
    maxPointsCost: reward.maxPointsCost?.toString() ?? null,
    discountValue: reward.discountValue?.toString() ?? null,
    maxDiscountValue: reward.maxDiscountValue?.toString() ?? null,
    minOrderAmount: reward.minOrderAmount?.toString() ?? null,
  };
}

function validateExchangeConfig({
  exchangeType,
  rewardType,
  pointsCost,
  pointsStep,
  minPointsCost,
  maxPointsCost,
}: {
  exchangeType: WeleticRewardExchangeType;
  rewardType: WeleticRewardType;
  pointsCost: unknown;
  pointsStep: unknown;
  minPointsCost: unknown;
  maxPointsCost: unknown;
}) {
  if (exchangeType !== WeleticRewardExchangeType.incremental) return;
  if (rewardType !== WeleticRewardType.amount_off) {
    throw new DubApiError({
      code: "bad_request",
      message:
        "Incremental redemption is currently supported for amount-off rewards only.",
    });
  }
  let step: bigint;
  let minimum: bigint;
  let maximum: bigint | null;
  try {
    step = BigInt(pointsStep as any);
    minimum = BigInt((minPointsCost ?? pointsCost) as any);
    maximum =
      maxPointsCost === null ||
      maxPointsCost === undefined ||
      maxPointsCost === ""
        ? null
        : BigInt(maxPointsCost as any);
  } catch {
    throw new DubApiError({
      code: "bad_request",
      message: "Incremental rewards require integer point step and limits.",
    });
  }
  if (
    step <= BigInt(0) ||
    minimum <= BigInt(0) ||
    minimum % step !== BigInt(0) ||
    (maximum !== null && (maximum < minimum || maximum % step !== BigInt(0)))
  ) {
    throw new DubApiError({
      code: "bad_request",
      message:
        "Incremental point limits must be positive multiples of pointsStep.",
    });
  }
}

function validateRewardValueAndChannel({
  rewardType,
  salesChannel,
  discountValue,
  status = WeleticRewardStatus.active,
}: {
  rewardType: WeleticRewardType;
  salesChannel: WeleticRewardSalesChannel;
  discountValue: unknown;
  status?: WeleticRewardStatus;
}) {
  if (!Object.values(WeleticRewardSalesChannel).includes(salesChannel)) {
    throw new DubApiError({
      code: "bad_request",
      message: "salesChannel must be online_store, pos, or both.",
    });
  }
  if (
    salesChannel !== WeleticRewardSalesChannel.online_store &&
    rewardType !== WeleticRewardType.amount_off &&
    rewardType !== WeleticRewardType.percentage_off
  ) {
    throw new DubApiError({
      code: "bad_request",
      message:
        "Shopify POS rewards support amount-off and percentage-off discount codes only.",
    });
  }
  if (
    [
      WeleticRewardType.amount_off,
      WeleticRewardType.gift_card,
      WeleticRewardType.store_credit,
    ].some((candidate: WeleticRewardType) => candidate === rewardType) &&
    status === WeleticRewardStatus.active &&
    !isValidPositiveMinorUnitValue(discountValue)
  ) {
    throw new DubApiError({
      code: "bad_request",
      message:
        "Amount-off, gift-card, and store-credit rewards require a positive value in minor currency units.",
    });
  }
}

// GET /api/shopify/loyalty/admin/rewards - List rewards catalog for merchant store
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

    const statusParam = searchParams.status as WeleticRewardStatus | undefined;
    const rewards = await listRewardDefinitions({
      storeId: store.id,
      status: statusParam,
    });

    return loyaltySuccessResponse(rewards.map(serializeReward), {
      headers: COMMON_CORS_HEADERS,
    });
  },
  {
    requiredPermissions: ["loyalty.read"],
  },
);

// POST /api/shopify/loyalty/admin/rewards - Create a new reward definition
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

    const body = await parseRequestBody(req);
    const {
      name,
      description,
      rewardType,
      salesChannel = WeleticRewardSalesChannel.online_store,
      exchangeType = WeleticRewardExchangeType.fixed,
      pointsCost,
      pointsStep,
      minPointsCost,
      maxPointsCost,
      discountValue,
      maxDiscountValue,
      minOrderAmount,
      shopifyPriceRuleId,
      entitledProductIds,
      entitledVariantIds,
      entitledCollectionIds,
      usageLimit,
      usageLimitPerCustomer,
      expiresInDays,
      appliesToResource,
      combinesWithOrderDiscounts,
      combinesWithProductDiscounts,
      combinesWithShippingDiscounts,
    } = body;

    if (!name || !rewardType || pointsCost === undefined) {
      throw new DubApiError({
        code: "bad_request",
        message: "Fields 'name', 'rewardType', and 'pointsCost' are required.",
      });
    }
    if (!isValidUsageLimitPerCustomer(usageLimitPerCustomer)) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "usageLimitPerCustomer must be 0 (unlimited) or 1 (once per customer).",
      });
    }
    validateExchangeConfig({
      exchangeType,
      rewardType,
      pointsCost,
      pointsStep,
      minPointsCost,
      maxPointsCost,
    });
    validateRewardValueAndChannel({
      rewardType: rewardType as WeleticRewardType,
      salesChannel: salesChannel as WeleticRewardSalesChannel,
      discountValue,
    });
    if (
      rewardType === WeleticRewardType.free_product &&
      !isValidFreeProductRewardScope({
        productIds: entitledProductIds,
        variantIds: entitledVariantIds,
        collectionIds: entitledCollectionIds,
      })
    ) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "Free product rewards require at least one valid Shopify product or variant ID, support at most 100 IDs per list, and do not support collection-only targeting.",
      });
    }
    if (
      rewardType === WeleticRewardType.free_product &&
      !isValidPositiveMinorUnitValue(maxDiscountValue)
    ) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "Free product rewards require a positive maximum discount value in minor currency units.",
      });
    }
    if (
      rewardType === WeleticRewardType.percentage_off &&
      !isValidPercentageRewardValue(discountValue)
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "Percentage rewards must be between 1 and 100.",
      });
    }

    const reward = await withActiveStoreLoyaltyMutation({
      storeId: store.id,
      action: "loyalty_reward_create",
      operation: (tx) =>
        createRewardDefinition({
          tx,
          storeId: store.id,
          name,
          description,
          rewardType: rewardType as WeleticRewardType,
          salesChannel: salesChannel as WeleticRewardSalesChannel,
          exchangeType: exchangeType as WeleticRewardExchangeType,
          pointsCost: BigInt(pointsCost),
          pointsStep,
          minPointsCost,
          maxPointsCost,
          discountValue,
          maxDiscountValue,
          minOrderAmount,
          shopifyPriceRuleId,
          entitledProductIds,
          entitledVariantIds,
          entitledCollectionIds,
          usageLimit: usageLimit !== undefined ? Number(usageLimit) : undefined,
          usageLimitPerCustomer:
            usageLimitPerCustomer !== undefined
              ? Number(usageLimitPerCustomer)
              : undefined,
          expiresInDays:
            expiresInDays !== undefined ? Number(expiresInDays) : undefined,
          appliesToResource,
          combinesWithOrderDiscounts,
          combinesWithProductDiscounts,
          combinesWithShippingDiscounts,
        }),
    });

    return loyaltySuccessResponse(serializeReward(reward), {
      headers: COMMON_CORS_HEADERS,
    });
  },
  {
    requiredPermissions: ["loyalty.write"],
  },
);

// PUT /api/shopify/loyalty/admin/rewards - Update an existing reward definition
export const PUT = withWorkspace(
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

    const body = await parseRequestBody(req);
    const {
      id,
      rewardId,
      name,
      description,
      rewardType,
      salesChannel,
      exchangeType,
      pointsCost,
      pointsStep,
      minPointsCost,
      maxPointsCost,
      discountValue,
      maxDiscountValue,
      minOrderAmount,
      status,
      shopifyPriceRuleId,
      entitledProductIds,
      entitledVariantIds,
      entitledCollectionIds,
      usageLimit,
      usageLimitPerCustomer,
      expiresInDays,
      appliesToResource,
      combinesWithOrderDiscounts,
      combinesWithProductDiscounts,
      combinesWithShippingDiscounts,
    } = body;

    const targetId = id || rewardId;
    if (!targetId) {
      throw new DubApiError({
        code: "bad_request",
        message: "Missing required field: 'id' or 'rewardId'.",
      });
    }
    if (!isValidUsageLimitPerCustomer(usageLimitPerCustomer)) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "usageLimitPerCustomer must be 0 (unlimited) or 1 (once per customer).",
      });
    }

    const existing = await prisma.weleticRewardDefinition.findFirst({
      where: { id: targetId, storeId: store.id },
    });
    if (!existing) {
      throw new DubApiError({
        code: "not_found",
        message: `Reward definition '${targetId}' not found for this store.`,
      });
    }
    const nextRewardType =
      (rewardType as WeleticRewardType | undefined) ?? existing.rewardType;
    const nextSalesChannel =
      (salesChannel as WeleticRewardSalesChannel | undefined) ??
      existing.salesChannel;
    const nextStatus =
      (status as WeleticRewardStatus | undefined) ?? existing.status;
    const nextExchangeType =
      (exchangeType as WeleticRewardExchangeType | undefined) ??
      existing.exchangeType;
    validateExchangeConfig({
      exchangeType: nextExchangeType,
      rewardType: nextRewardType,
      pointsCost: pointsCost ?? existing.pointsCost,
      pointsStep: pointsStep ?? existing.pointsStep,
      minPointsCost: minPointsCost ?? existing.minPointsCost,
      maxPointsCost:
        maxPointsCost !== undefined ? maxPointsCost : existing.maxPointsCost,
    });
    const nextDiscountValue =
      discountValue !== undefined ? discountValue : existing.discountValue;
    const nextMaxDiscountValue =
      maxDiscountValue !== undefined
        ? maxDiscountValue
        : existing.maxDiscountValue;
    validateRewardValueAndChannel({
      rewardType: nextRewardType,
      salesChannel: nextSalesChannel,
      discountValue: nextDiscountValue,
      status: nextStatus,
    });
    if (
      nextRewardType === WeleticRewardType.percentage_off &&
      !isValidPercentageRewardValue(nextDiscountValue)
    ) {
      throw new DubApiError({
        code: "bad_request",
        message: "Percentage rewards must be between 1 and 100.",
      });
    }
    if (
      nextRewardType === WeleticRewardType.free_product &&
      !isValidFreeProductRewardScope({
        productIds:
          entitledProductIds !== undefined
            ? entitledProductIds
            : existing.entitledProductIds,
        variantIds:
          entitledVariantIds !== undefined
            ? entitledVariantIds
            : existing.entitledVariantIds,
        collectionIds:
          entitledCollectionIds !== undefined
            ? entitledCollectionIds
            : existing.entitledCollectionIds,
      })
    ) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "Free product rewards require at least one valid Shopify product or variant ID, support at most 100 IDs per list, and do not support collection-only targeting.",
      });
    }
    if (
      nextRewardType === WeleticRewardType.free_product &&
      nextStatus === WeleticRewardStatus.active &&
      !isValidPositiveMinorUnitValue(nextMaxDiscountValue)
    ) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "Free product rewards require a positive maximum discount value in minor currency units.",
      });
    }

    let reward;
    try {
      reward = await withActiveStoreLoyaltyMutation({
        storeId: store.id,
        action: "loyalty_reward_update",
        operation: (tx) =>
          updateRewardDefinition({
            tx,
            id: targetId,
            storeId: store.id,
            data: {
              name,
              description,
              rewardType: rewardType as WeleticRewardType | undefined,
              salesChannel: salesChannel as
                | WeleticRewardSalesChannel
                | undefined,
              exchangeType: exchangeType as
                | WeleticRewardExchangeType
                | undefined,
              pointsCost:
                pointsCost !== undefined ? BigInt(pointsCost) : undefined,
              pointsStep,
              minPointsCost,
              maxPointsCost,
              discountValue,
              maxDiscountValue,
              minOrderAmount,
              status: status as WeleticRewardStatus | undefined,
              shopifyPriceRuleId,
              entitledProductIds,
              entitledVariantIds,
              entitledCollectionIds,
              usageLimit:
                usageLimit !== undefined ? Number(usageLimit) : undefined,
              usageLimitPerCustomer:
                usageLimitPerCustomer !== undefined
                  ? Number(usageLimitPerCustomer)
                  : undefined,
              expiresInDays:
                expiresInDays !== undefined ? Number(expiresInDays) : undefined,
              appliesToResource,
              combinesWithOrderDiscounts,
              combinesWithProductDiscounts,
              combinesWithShippingDiscounts,
            },
          }),
      });
    } catch (error) {
      if (error instanceof RewardDefinitionConflictError) {
        throw new DubApiError({
          code: "conflict",
          message: error.message,
        });
      }
      throw error;
    }

    return loyaltySuccessResponse(serializeReward(reward), {
      headers: COMMON_CORS_HEADERS,
    });
  },
  {
    requiredPermissions: ["loyalty.write"],
  },
);

// DELETE /api/shopify/loyalty/admin/rewards - Archive reward definition
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

    const id = searchParams.id || searchParams.rewardId;

    if (!id) {
      throw new DubApiError({
        code: "bad_request",
        message: "Missing required parameter: 'id' or 'rewardId'.",
      });
    }

    const existing = await prisma.weleticRewardDefinition.findFirst({
      where: { id, storeId: store.id },
    });
    if (!existing) {
      throw new DubApiError({
        code: "not_found",
        message: `Reward definition '${id}' not found for this store.`,
      });
    }

    await withActiveStoreLoyaltyMutation({
      storeId: store.id,
      action: "loyalty_reward_archive",
      operation: (tx) =>
        tx.weleticRewardDefinition.update({
          where: { id, storeId: store.id },
          data: { status: WeleticRewardStatus.archived },
        }),
    });

    return loyaltySuccessResponse(
      { success: true, archivedId: id },
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
