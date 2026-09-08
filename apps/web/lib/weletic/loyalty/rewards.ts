import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import type { LoyaltyMaintenancePermit } from "@/lib/weletic/loyalty/maintenance-write-fence";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import {
  assertExpectedLoyaltyDiscountNode,
  assertLoyaltyDiscountLookupMissIsTerminal,
  canonicalizeLoyaltyDiscountCode,
  getPrivacySafeLoyaltyDiscountMetadata,
} from "@/lib/weletic/loyalty/redemption-discount-identity";
import { mergeRedemptionMetadataTimestamp } from "@/lib/weletic/loyalty/redemption-metadata";
import { provisionDiscountSaga } from "@/lib/weletic/loyalty/saga";
import {
  deactivateDiscount,
  lookupDiscountByCode,
  resolveShopifyOfflineCredentials,
} from "@/lib/weletic/loyalty/shopify-discounts";
import { hasShopifyCustomerRedactionTombstone } from "@/lib/weletic/loyalty/shopper-privacy";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import {
  Prisma,
  WeleticPointsLedgerEntryType,
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
  WeleticRewardExchangeType,
  WeleticRewardSalesChannel,
  WeleticRewardStatus,
  WeleticRewardType,
} from "@prisma/client";
import {
  assertAccountBackedReward,
  assertRewardAccountRelation,
} from "./reward-ownership";

export interface CreateRewardDefinitionParams {
  storeId: string;
  name: string;
  description?: string | null;
  rewardType: WeleticRewardType;
  salesChannel?: WeleticRewardSalesChannel;
  exchangeType?: WeleticRewardExchangeType;
  pointsCost: bigint | number;
  tx?: Prisma.TransactionClient;
  pointsStep?: bigint | number | null;
  minPointsCost?: bigint | number | null;
  maxPointsCost?: bigint | number | null;
  discountValue?: number | string | null;
  maxDiscountValue?: number | string | null;
  minOrderAmount?: number | string | null;
  shopifyPriceRuleId?: string | null;
  appliesToResource?: string | null;
  entitledProductIds?: string[] | null;
  entitledVariantIds?: string[] | null;
  entitledCollectionIds?: string[] | null;
  combinesWithOrderDiscounts?: boolean;
  combinesWithProductDiscounts?: boolean;
  combinesWithShippingDiscounts?: boolean;
  usageLimit?: number | null;
  usageLimitPerCustomer?: number | null;
  expiresInDays?: number | null;
}

export function isProvisionableShopifyRewardType(
  rewardType: WeleticRewardType,
) {
  return Object.values(WeleticRewardType).includes(rewardType);
}

const SHOPIFY_PRODUCT_ID = /^(?:\d+|gid:\/\/shopify\/Product\/\d+)$/;
const SHOPIFY_VARIANT_ID = /^(?:\d+|gid:\/\/shopify\/ProductVariant\/\d+)$/;
const MAX_FREE_PRODUCT_ELIGIBILITY_IDS = 100;

export class RewardDefinitionConflictError extends Error {
  constructor() {
    super(
      "The reward changed while this update was being applied. Reload it and retry.",
    );
    this.name = "RewardDefinitionConflictError";
  }
}

export function isValidFreeProductRewardScope({
  productIds,
  variantIds,
  collectionIds,
}: {
  productIds: unknown;
  variantIds: unknown;
  collectionIds?: unknown;
}) {
  const products = Array.isArray(productIds) ? productIds : [];
  const variants = Array.isArray(variantIds) ? variantIds : [];
  const collections = Array.isArray(collectionIds) ? collectionIds : [];

  return (
    collections.length === 0 &&
    products.length <= MAX_FREE_PRODUCT_ELIGIBILITY_IDS &&
    variants.length <= MAX_FREE_PRODUCT_ELIGIBILITY_IDS &&
    products.length + variants.length > 0 &&
    products.every(
      (id) => typeof id === "string" && SHOPIFY_PRODUCT_ID.test(id.trim()),
    ) &&
    variants.every(
      (id) => typeof id === "string" && SHOPIFY_VARIANT_ID.test(id.trim()),
    )
  );
}

export function isValidPercentageRewardValue(value: unknown) {
  const normalized =
    value instanceof Prisma.Decimal
      ? value.toString()
      : typeof value === "number" || typeof value === "string"
        ? String(value).trim()
        : "";
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return false;
  const numericValue = Number(normalized);
  return (
    Number.isFinite(numericValue) && numericValue >= 1 && numericValue <= 100
  );
}

export function isValidPositiveMinorUnitValue(value: unknown) {
  const normalized =
    value instanceof Prisma.Decimal
      ? value.toString()
      : typeof value === "number" || typeof value === "string"
        ? String(value).trim()
        : "";
  if (!/^\d+(?:\.0+)?$/.test(normalized)) return false;
  return BigInt(normalized.split(".")[0]) > BigInt(0);
}

export function isValidUsageLimitPerCustomer(value: unknown) {
  if (value === null || value === undefined || value === "") return true;
  const normalized = Number(value);
  return (
    Number.isSafeInteger(normalized) && (normalized === 0 || normalized === 1)
  );
}

type ProvisionableRewardDefinition = {
  rewardType: WeleticRewardType;
  salesChannel?: WeleticRewardSalesChannel;
  discountValue: unknown;
  maxDiscountValue: unknown;
  minOrderAmount?: unknown;
  entitledProductIds: unknown;
  entitledVariantIds: unknown;
  entitledCollectionIds: unknown;
  usageLimit?: number | null;
  usageLimitPerCustomer?: number | null;
};

export function isDiscountCodeRewardType(rewardType: WeleticRewardType) {
  return [
    WeleticRewardType.amount_off,
    WeleticRewardType.percentage_off,
    WeleticRewardType.free_shipping,
    WeleticRewardType.free_product,
  ].some((candidate: WeleticRewardType) => candidate === rewardType);
}

/**
 * Returns whether a reward has all inputs required by the Shopify discount
 * dispatcher. Keep this predicate shared by customer catalogs, referral-rule
 * validation, and qualification so an invalid reward cannot be selected and
 * only fail after a financial state transition has committed.
 */
export function isRewardDefinitionProvisionable(
  reward: ProvisionableRewardDefinition,
) {
  if (
    reward.salesChannel &&
    reward.salesChannel !== WeleticRewardSalesChannel.online_store &&
    reward.rewardType !== WeleticRewardType.amount_off &&
    reward.rewardType !== WeleticRewardType.percentage_off
  ) {
    return false;
  }
  if (
    reward.minOrderAmount != null &&
    Number(reward.minOrderAmount) > 0 &&
    !isValidPositiveMinorUnitValue(reward.minOrderAmount)
  ) {
    return false;
  }
  if (!isValidUsageLimitPerCustomer(reward.usageLimitPerCustomer)) {
    return false;
  }
  if (
    reward.usageLimit != null &&
    (!Number.isSafeInteger(reward.usageLimit) || reward.usageLimit < 1)
  ) {
    return false;
  }
  switch (reward.rewardType) {
    case WeleticRewardType.amount_off:
    case WeleticRewardType.gift_card:
    case WeleticRewardType.store_credit:
      return isValidPositiveMinorUnitValue(reward.discountValue);
    case WeleticRewardType.percentage_off:
      return isValidPercentageRewardValue(reward.discountValue);
    case WeleticRewardType.free_shipping:
      return true;
    case WeleticRewardType.free_product:
      return (
        isValidPositiveMinorUnitValue(reward.maxDiscountValue) &&
        isValidFreeProductRewardScope({
          productIds: reward.entitledProductIds,
          variantIds: reward.entitledVariantIds,
          collectionIds: reward.entitledCollectionIds,
        })
      );
    default:
      return false;
  }
}

export function isReferralCouponProvisionable(
  reward: ProvisionableRewardDefinition,
) {
  return (
    (reward.salesChannel === WeleticRewardSalesChannel.online_store ||
      reward.salesChannel === WeleticRewardSalesChannel.both) &&
    isDiscountCodeRewardType(reward.rewardType) &&
    isRewardDefinitionProvisionable(reward)
  );
}

export function validateIncrementalRewardConfig({
  rewardType,
  exchangeType,
  pointsCost,
  pointsStep,
  minPointsCost,
  maxPointsCost,
}: {
  rewardType: WeleticRewardType;
  exchangeType: WeleticRewardExchangeType;
  pointsCost: bigint | number;
  pointsStep?: bigint | number | null;
  minPointsCost?: bigint | number | null;
  maxPointsCost?: bigint | number | null;
}) {
  if (exchangeType !== WeleticRewardExchangeType.incremental) return;
  if (rewardType !== WeleticRewardType.amount_off || pointsStep == null) {
    throw new Error(
      "Incremental redemption is supported only for amount-off rewards with a point step.",
    );
  }
  const step = BigInt(pointsStep);
  const minimum = BigInt(minPointsCost ?? pointsCost);
  const maximum = maxPointsCost == null ? null : BigInt(maxPointsCost);
  if (
    step <= BigInt(0) ||
    minimum <= BigInt(0) ||
    minimum % step !== BigInt(0) ||
    (maximum !== null && (maximum < minimum || maximum % step !== BigInt(0)))
  ) {
    throw new Error(
      "Incremental point limits must be positive multiples of the point step.",
    );
  }
}

export async function createRewardDefinition(
  params: CreateRewardDefinitionParams,
) {
  validateIncrementalRewardConfig({
    rewardType: params.rewardType,
    exchangeType: params.exchangeType ?? WeleticRewardExchangeType.fixed,
    pointsCost: params.pointsCost,
    pointsStep: params.pointsStep,
    minPointsCost: params.minPointsCost,
    maxPointsCost: params.maxPointsCost,
  });
  if (!isValidUsageLimitPerCustomer(params.usageLimitPerCustomer)) {
    throw new Error(
      "Shopify supports only unlimited or once-per-customer native loyalty vouchers.",
    );
  }
  if (
    params.salesChannel &&
    params.salesChannel !== WeleticRewardSalesChannel.online_store &&
    params.rewardType !== WeleticRewardType.amount_off &&
    params.rewardType !== WeleticRewardType.percentage_off
  ) {
    throw new Error(
      "Shopify POS rewards support amount-off and percentage-off discount codes only.",
    );
  }
  if (
    [
      WeleticRewardType.amount_off,
      WeleticRewardType.gift_card,
      WeleticRewardType.store_credit,
    ].some((candidate: WeleticRewardType) => candidate === params.rewardType) &&
    !isValidPositiveMinorUnitValue(params.discountValue)
  ) {
    throw new Error(
      "Amount-off, gift-card, and store-credit rewards require a positive value in minor currency units.",
    );
  }
  if (
    params.rewardType === WeleticRewardType.percentage_off &&
    !isValidPercentageRewardValue(params.discountValue)
  ) {
    throw new Error("Percentage rewards must be between 1 and 100.");
  }
  if (
    params.rewardType === WeleticRewardType.free_product &&
    !isValidFreeProductRewardScope({
      productIds: params.entitledProductIds,
      variantIds: params.entitledVariantIds,
      collectionIds: params.entitledCollectionIds,
    })
  ) {
    throw new Error(
      "Free product rewards require at least one valid Shopify product or variant ID, support at most 100 IDs per list, and do not support collection-only targeting.",
    );
  }
  if (
    params.rewardType === WeleticRewardType.free_product &&
    !isValidPositiveMinorUnitValue(params.maxDiscountValue)
  ) {
    throw new Error(
      "Free product rewards require a positive maximum discount value in minor currency units.",
    );
  }

  const db = params.tx ?? prisma;
  return await db.weleticRewardDefinition.create({
    data: {
      id: createWeleticId("wreward_"),
      storeId: params.storeId,
      name: params.name,
      description: params.description ?? null,
      rewardType: params.rewardType,
      salesChannel:
        params.salesChannel ?? WeleticRewardSalesChannel.online_store,
      exchangeType: params.exchangeType ?? WeleticRewardExchangeType.fixed,
      pointsCost: BigInt(params.pointsCost),
      pointsStep:
        params.pointsStep !== undefined && params.pointsStep !== null
          ? BigInt(params.pointsStep)
          : null,
      minPointsCost:
        params.minPointsCost !== undefined && params.minPointsCost !== null
          ? BigInt(params.minPointsCost)
          : null,
      maxPointsCost:
        params.maxPointsCost !== undefined && params.maxPointsCost !== null
          ? BigInt(params.maxPointsCost)
          : null,
      discountValue: params.discountValue
        ? new Prisma.Decimal(params.discountValue)
        : null,
      maxDiscountValue: params.maxDiscountValue
        ? new Prisma.Decimal(params.maxDiscountValue)
        : null,
      minOrderAmount: params.minOrderAmount
        ? new Prisma.Decimal(params.minOrderAmount)
        : null,
      shopifyPriceRuleId: params.shopifyPriceRuleId ?? null,
      appliesToResource: params.appliesToResource ?? "entire_order",
      entitledProductIds: params.entitledProductIds
        ? (params.entitledProductIds as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      entitledVariantIds: params.entitledVariantIds
        ? (params.entitledVariantIds as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      entitledCollectionIds: params.entitledCollectionIds
        ? (params.entitledCollectionIds as unknown as Prisma.InputJsonValue)
        : Prisma.DbNull,
      combinesWithOrderDiscounts: Boolean(params.combinesWithOrderDiscounts),
      combinesWithProductDiscounts: Boolean(
        params.combinesWithProductDiscounts,
      ),
      combinesWithShippingDiscounts: Boolean(
        params.combinesWithShippingDiscounts,
      ),
      usageLimit: params.usageLimit ?? null,
      usageLimitPerCustomer: params.usageLimitPerCustomer ?? 1,
      expiresInDays: params.expiresInDays ?? null,
      status: WeleticRewardStatus.active,
    },
  });
}

export async function updateRewardDefinition({
  id,
  storeId,
  data,
  tx,
}: {
  id: string;
  storeId: string;
  data: Partial<{
    name: string;
    description: string | null;
    rewardType: WeleticRewardType;
    salesChannel: WeleticRewardSalesChannel;
    exchangeType: WeleticRewardExchangeType;
    pointsCost: bigint | number;
    pointsStep: bigint | number | null;
    minPointsCost: bigint | number | null;
    maxPointsCost: bigint | number | null;
    discountValue: number | string | null;
    maxDiscountValue: number | string | null;
    minOrderAmount: number | string | null;
    status: WeleticRewardStatus;
    shopifyPriceRuleId: string | null;
    appliesToResource: string | null;
    entitledProductIds: string[] | null;
    entitledVariantIds: string[] | null;
    entitledCollectionIds: string[] | null;
    combinesWithOrderDiscounts: boolean;
    combinesWithProductDiscounts: boolean;
    combinesWithShippingDiscounts: boolean;
    usageLimit: number | null;
    usageLimitPerCustomer: number | null;
    expiresInDays: number | null;
  }>;
  tx?: Prisma.TransactionClient;
}) {
  const db = tx ?? prisma;
  const existing = await db.weleticRewardDefinition.findUnique({
    where: { id },
    select: {
      storeId: true,
      rewardType: true,
      salesChannel: true,
      exchangeType: true,
      pointsCost: true,
      pointsStep: true,
      minPointsCost: true,
      maxPointsCost: true,
      status: true,
      discountValue: true,
      maxDiscountValue: true,
      entitledProductIds: true,
      entitledVariantIds: true,
      entitledCollectionIds: true,
      updatedAt: true,
    },
  });
  if (!existing || existing.storeId !== storeId) {
    throw new Error("Reward definition not found for this store.");
  }

  validateIncrementalRewardConfig({
    rewardType: data.rewardType ?? existing.rewardType,
    exchangeType: data.exchangeType ?? existing.exchangeType,
    pointsCost: data.pointsCost ?? existing.pointsCost,
    pointsStep:
      data.pointsStep !== undefined ? data.pointsStep : existing.pointsStep,
    minPointsCost:
      data.minPointsCost !== undefined
        ? data.minPointsCost
        : existing.minPointsCost,
    maxPointsCost:
      data.maxPointsCost !== undefined
        ? data.maxPointsCost
        : existing.maxPointsCost,
  });

  const nextRewardType = data.rewardType ?? existing.rewardType;
  const nextSalesChannel =
    data.salesChannel ??
    existing.salesChannel ??
    WeleticRewardSalesChannel.online_store;
  const nextStatus = data.status ?? existing.status;
  const nextDiscountValue =
    data.discountValue !== undefined
      ? data.discountValue
      : existing.discountValue;
  if (!isValidUsageLimitPerCustomer(data.usageLimitPerCustomer)) {
    throw new Error(
      "Shopify supports only unlimited or once-per-customer native loyalty vouchers.",
    );
  }
  if (
    nextSalesChannel !== WeleticRewardSalesChannel.online_store &&
    nextRewardType !== WeleticRewardType.amount_off &&
    nextRewardType !== WeleticRewardType.percentage_off
  ) {
    throw new Error(
      "Shopify POS rewards support amount-off and percentage-off discount codes only.",
    );
  }
  if (
    [
      WeleticRewardType.amount_off,
      WeleticRewardType.gift_card,
      WeleticRewardType.store_credit,
    ].some((candidate: WeleticRewardType) => candidate === nextRewardType) &&
    nextStatus === WeleticRewardStatus.active &&
    !isValidPositiveMinorUnitValue(nextDiscountValue)
  ) {
    throw new Error(
      "Amount-off, gift-card, and store-credit rewards require a positive value in minor currency units.",
    );
  }
  if (
    nextRewardType === WeleticRewardType.percentage_off &&
    !isValidPercentageRewardValue(nextDiscountValue)
  ) {
    throw new Error("Percentage rewards must be between 1 and 100.");
  }
  if (
    nextRewardType === WeleticRewardType.free_product &&
    !isValidFreeProductRewardScope({
      productIds:
        data.entitledProductIds !== undefined
          ? data.entitledProductIds
          : existing.entitledProductIds,
      variantIds:
        data.entitledVariantIds !== undefined
          ? data.entitledVariantIds
          : existing.entitledVariantIds,
      collectionIds:
        data.entitledCollectionIds !== undefined
          ? data.entitledCollectionIds
          : existing.entitledCollectionIds,
    })
  ) {
    throw new Error(
      "Free product rewards require at least one valid Shopify product or variant ID, support at most 100 IDs per list, and do not support collection-only targeting.",
    );
  }
  const nextMaxDiscountValue =
    data.maxDiscountValue !== undefined
      ? data.maxDiscountValue
      : existing.maxDiscountValue;
  if (
    nextRewardType === WeleticRewardType.free_product &&
    nextStatus === WeleticRewardStatus.active &&
    !isValidPositiveMinorUnitValue(nextMaxDiscountValue)
  ) {
    throw new Error(
      "Free product rewards require a positive maximum discount value in minor currency units.",
    );
  }
  const guards: Prisma.WeleticRewardDefinitionWhereInput[] = [];
  if (
    data.rewardType === WeleticRewardType.percentage_off &&
    data.discountValue === undefined
  ) {
    guards.push({
      discountValue: {
        gte: new Prisma.Decimal(1),
        lte: new Prisma.Decimal(100),
      },
    });
  }
  if (
    data.rewardType === undefined &&
    data.discountValue !== undefined &&
    !isValidPercentageRewardValue(data.discountValue)
  ) {
    guards.push({ rewardType: { not: WeleticRewardType.percentage_off } });
  }
  try {
    return await db.weleticRewardDefinition.update({
      where: {
        id,
        storeId,
        updatedAt: existing.updatedAt,
        ...(guards.length > 0 ? { AND: guards } : {}),
      },
      data: {
        name: data.name,
        description: data.description,
        rewardType: data.rewardType,
        salesChannel: data.salesChannel,
        exchangeType: data.exchangeType,
        pointsCost:
          data.pointsCost !== undefined ? BigInt(data.pointsCost) : undefined,
        pointsStep:
          data.pointsStep !== undefined
            ? data.pointsStep !== null
              ? BigInt(data.pointsStep)
              : null
            : undefined,
        minPointsCost:
          data.minPointsCost !== undefined
            ? data.minPointsCost !== null
              ? BigInt(data.minPointsCost)
              : null
            : undefined,
        maxPointsCost:
          data.maxPointsCost !== undefined
            ? data.maxPointsCost !== null
              ? BigInt(data.maxPointsCost)
              : null
            : undefined,
        discountValue:
          data.discountValue !== undefined
            ? data.discountValue
              ? new Prisma.Decimal(data.discountValue)
              : null
            : undefined,
        maxDiscountValue:
          data.maxDiscountValue !== undefined
            ? data.maxDiscountValue
              ? new Prisma.Decimal(data.maxDiscountValue)
              : null
            : undefined,
        minOrderAmount:
          data.minOrderAmount !== undefined
            ? data.minOrderAmount
              ? new Prisma.Decimal(data.minOrderAmount)
              : null
            : undefined,
        status: data.status,
        shopifyPriceRuleId: data.shopifyPriceRuleId,
        appliesToResource: data.appliesToResource,
        entitledProductIds:
          data.entitledProductIds !== undefined
            ? data.entitledProductIds
              ? (data.entitledProductIds as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull
            : undefined,
        entitledVariantIds:
          data.entitledVariantIds !== undefined
            ? data.entitledVariantIds
              ? (data.entitledVariantIds as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull
            : undefined,
        entitledCollectionIds:
          data.entitledCollectionIds !== undefined
            ? data.entitledCollectionIds
              ? (data.entitledCollectionIds as unknown as Prisma.InputJsonValue)
              : Prisma.DbNull
            : undefined,
        combinesWithOrderDiscounts: data.combinesWithOrderDiscounts,
        combinesWithProductDiscounts: data.combinesWithProductDiscounts,
        combinesWithShippingDiscounts: data.combinesWithShippingDiscounts,
        usageLimit: data.usageLimit,
        usageLimitPerCustomer: data.usageLimitPerCustomer,
        expiresInDays: data.expiresInDays,
      },
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "P2025"
    ) {
      throw new RewardDefinitionConflictError();
    }
    throw error;
  }
}

/** Containment is permitted even for unsupported legacy terms. It cannot
 * activate or rewrite a definition, issue/deactivate an artifact, or alter
 * financial history. Caller authorizes, fingerprints and fences the store.
 */
export async function containRewardDefinition({
  tx,
  storeId,
  id,
  status,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  id: string;
  status: "inactive" | "archived";
}) {
  if (status !== "inactive" && status !== "archived")
    throw new RewardDefinitionConflictError();
  const result = await tx.weleticRewardDefinition.updateMany({
    where: {
      id,
      storeId,
      ...(status === "inactive"
        ? { status: { not: "archived" as const } }
        : {}),
    },
    data: { status },
  });
  if (result.count !== 1) throw new RewardDefinitionConflictError();
}

export async function listRewardDefinitions({
  storeId,
  status,
  provisionableOnly = false,
}: {
  storeId: string;
  status?: WeleticRewardStatus;
  provisionableOnly?: boolean;
}) {
  const rewards = await prisma.weleticRewardDefinition.findMany({
    where: {
      storeId,
      ...(status ? { status } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  if (!provisionableOnly) return rewards;

  return rewards.filter(isRewardDefinitionProvisionable);
}

export function isRewardAvailableOnSalesChannel(
  reward: { salesChannel?: WeleticRewardSalesChannel | null },
  channel: "online_store" | "pos",
) {
  const configuredChannel =
    reward.salesChannel ?? WeleticRewardSalesChannel.online_store;
  return (
    configuredChannel === WeleticRewardSalesChannel.both ||
    configuredChannel === channel
  );
}

export async function getRewardDefinition(id: string) {
  return await prisma.weleticRewardDefinition.findUnique({
    where: { id },
  });
}

export interface RedeemRewardParams {
  storeId: string;
  accountId: string;
  rewardDefinitionId: string;
  discountCode?: string;
  expiresInDays?: number;
  customFetch?: typeof fetch;
  shopDomain?: string;
  accessToken?: string;
  pointsCostOverride?: bigint | number;
  discountValueOverride?: number | string;
  notifyStoreCreditOwner?: boolean;
  idempotencyKey: string;
  expiresAt?: Date;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
  tx?: Prisma.TransactionClient;
}

export class RedemptionProvisioningPendingError extends Error {
  constructor(
    public redemptionId: string,
    message: string,
  ) {
    super(message);
    this.name = "RedemptionProvisioningPendingError";
  }
}

/**
 * Executes a reward redemption through the recoverable 4-phase distributed saga.
 */
export async function redeemReward(params: RedeemRewardParams) {
  const sagaResult = await provisionDiscountSaga({
    storeId: params.storeId,
    accountId: params.accountId,
    rewardDefinitionId: params.rewardDefinitionId,
    discountCode: params.discountCode,
    expiresInDays: params.expiresInDays,
    customFetch: params.customFetch,
    shopDomain: params.shopDomain,
    accessToken: params.accessToken,
    pointsCostOverride: params.pointsCostOverride,
    discountValueOverride: params.discountValueOverride,
    notifyStoreCreditOwner: params.notifyStoreCreditOwner,
    idempotencyKey: params.idempotencyKey,
    expiresAt: params.expiresAt,
    loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
  });

  if (!sagaResult.success) {
    if (
      sagaResult.status === WeleticRedemptionStatus.provisioning &&
      sagaResult.compensated === false
    ) {
      throw new RedemptionProvisioningPendingError(
        sagaResult.redemptionId,
        "Shopify is still confirming this voucher. Retry with the same idempotency key; points remain reserved and have not been refunded.",
      );
    }
    throw new Error(
      `Redemption failed${sagaResult.compensated ? " and was compensated" : ""}: ${sagaResult.error || "Unknown provisioning error"}`,
    );
  }

  const redemption = await prisma.weleticRewardRedemption.findUnique({
    where: { id: sagaResult.redemptionId },
    include: { rewardDefinition: true },
  });
  if (!redemption?.ledgerEntryId) {
    throw new Error(
      `Issued redemption ${sagaResult.redemptionId} is missing its durable ledger entry`,
    );
  }

  const ledgerEntry = await prisma.weleticPointsLedgerEntry.findUnique({
    where: { id: redemption.ledgerEntryId },
  });
  if (!ledgerEntry) {
    throw new Error(
      `Ledger entry ${redemption.ledgerEntryId} for redemption ${redemption.id} was not found`,
    );
  }

  return {
    redemption,
    discountCode: sagaResult.discountCode,
    shopifyDiscountId: sagaResult.shopifyDiscountId,
    status: sagaResult.status,
    ledgerEntry,
  };
}

/**
 * Cancels an active or issued reward redemption, restores points to customer balance,
 * and deactivates/deletes the discount in Shopify.
 */
export async function cancelRewardRedemption({
  storeId,
  redemptionId,
  reason,
  customFetch,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  redemptionId: string;
  reason?: string;
  customFetch?: typeof fetch;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const identity = await prisma.weleticRewardRedemption.findFirst({
    where: { id: redemptionId, storeId },
    select: {
      account: {
        select: {
          storeId: true,
          shopper: { select: { shopifyCustomerId: true } },
          store: { select: { projectId: true } },
        },
      },
    },
  });
  if (!identity) {
    throw new Error(`Redemption ${redemptionId} not found.`);
  }
  assertRewardAccountRelation(identity);
  if (identity.account.storeId !== storeId) {
    throw new Error(
      "Redemption account does not belong to this Shopify store.",
    );
  }

  return withShopifyCustomerSettlementLocks({
    storeId,
    workspaceId: identity.account.store.projectId,
    shopifyCustomerId: identity.account.shopper.shopifyCustomerId,
    fn: () =>
      cancelRewardRedemptionUnlocked({
        storeId,
        redemptionId,
        reason,
        customFetch,
        loyaltyMaintenancePermit,
      }),
  });
}

async function cancelRewardRedemptionUnlocked({
  storeId,
  redemptionId,
  reason,
  customFetch,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  redemptionId: string;
  reason?: string;
  customFetch?: typeof fetch;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const localCancellation = await prisma.$transaction(async (tx) => {
    await assertShopifyStoreAcceptsOperationalWrites({
      storeId,
      action: "reward_redemption_cancel",
      loyaltyMaintenancePermit,
      tx,
    });
    const redemption = await tx.weleticRewardRedemption.findUnique({
      where: { id: redemptionId },
      include: { account: true, rewardDefinition: true },
    });

    if (!redemption) {
      throw new Error(`Redemption ${redemptionId} not found.`);
    }
    assertAccountBackedReward(redemption);
    assertRewardAccountRelation(redemption);

    if (redemption.storeId !== storeId) {
      throw new Error("Redemption does not belong to this Shopify store.");
    }
    if (redemption.account.storeId !== storeId) {
      throw new Error(
        "Redemption account does not belong to this Shopify store.",
      );
    }

    if (
      redemption.artifactKind !== WeleticRewardArtifactKind.discount_code &&
      redemption.status !== WeleticRedemptionStatus.cancelled &&
      redemption.status !== WeleticRedemptionStatus.failed
    ) {
      throw new Error(
        "Gift-card and store-credit rewards cannot be automatically cancelled because the value might already have been spent. Reconcile the Shopify financial instrument before restoring points.",
      );
    }

    // Re-read after taking the customer settlement lock. If redaction won the
    // race, financial restoration and remote voucher cleanup still complete,
    // but no customer context is recreated after the privacy scrub snapshot.
    const privacyRedacted =
      redemption.account.status === "closed" ||
      hasShopifyCustomerRedactionTombstone(redemption.account.metadata);

    if (redemption.status === WeleticRedemptionStatus.cancelled) {
      const ledgerEntry = await tx.weleticPointsLedgerEntry.findUnique({
        where: {
          storeId_idempotencyKey: {
            storeId,
            idempotencyKey: `redeem_cancel:${redemption.id}`,
          },
        },
      });
      if (!ledgerEntry) {
        throw new Error(
          `Cancelled redemption ${redemption.id} is missing its refund ledger entry.`,
        );
      }
      const deactivationJob = await enqueueOutboxJob({
        storeId,
        jobType: "REDEMPTION_RECOVERY",
        payload: {
          redemptionId: redemption.id,
          accountId: redemption.accountId,
          rewardDefinitionId: redemption.rewardDefinitionId,
          pointsCost: redemption.pointsSpent.toString(),
          shopifyDiscountCode: redemption.shopifyDiscountCode,
          artifactKind: redemption.artifactKind,
          attemptCount: 0,
          sagaPhase: "compensating",
        },
        idempotencyKey: `discount_deactivate:${redemption.id}`,
        tx,
      });
      return {
        redemption,
        ledgerEntry,
        shopifyDiscountId: redemption.shopifyDiscountId,
        deactivationJobId: deactivationJob.job.id,
      };
    }

    if (
      redemption.status === WeleticRedemptionStatus.used ||
      redemption.status === WeleticRedemptionStatus.expired ||
      redemption.status === WeleticRedemptionStatus.failed
    ) {
      throw new Error(
        `Cannot cancel redemption with status '${redemption.status}'.`,
      );
    }

    const canonicalDiscountCode = canonicalizeLoyaltyDiscountCode(
      redemption.shopifyDiscountCode,
    );
    if (
      redemption.settlementQuarantinedAt != null ||
      redemption.shopifyDiscountCodeCanonical !== canonicalDiscountCode
    ) {
      throw new Error(
        `Cannot cancel quarantined redemption ${redemption.id}; exact Shopify identity reconciliation is required before points can be restored.`,
      );
    }

    // 1. Atomically claim cancellation so an order-paid webhook cannot mark the
    // voucher used while this transaction restores its points.
    const cancelledAt = new Date();
    const cancellationMetadata = privacyRedacted
      ? getPrivacySafeLoyaltyDiscountMetadata(redemption.metadata)
      : mergeRedemptionMetadataTimestamp(
          redemption.metadata,
          "cancelledAt",
          cancelledAt,
        );
    const compensationReason = privacyRedacted
      ? "Reward cancellation after customer redaction."
      : reason || "Manually cancelled";
    const transition = await tx.weleticRewardRedemption.updateMany({
      where: {
        id: redemptionId,
        storeId,
        status: {
          in: [
            WeleticRedemptionStatus.provisioning,
            WeleticRedemptionStatus.issued,
            WeleticRedemptionStatus.active,
          ],
        },
        shopifyDiscountCode: redemption.shopifyDiscountCode,
        shopifyDiscountCodeCanonical: canonicalDiscountCode,
        settlementQuarantinedAt: null,
      },
      data: {
        status: WeleticRedemptionStatus.cancelled,
        compensationReason,
        metadata: cancellationMetadata,
      },
    });
    if (transition.count === 0) {
      const latest = await tx.weleticRewardRedemption.findUnique({
        where: { id: redemptionId },
        select: { status: true },
      });
      throw new Error(
        `Cannot cancel redemption with status '${latest?.status ?? "unknown"}'.`,
      );
    }

    // 2. Restore points to account via MANUAL_ADJUSTMENT ledger entry
    const ledgerEntry = await appendPointsLedgerEntry({
      storeId,
      accountId: redemption.accountId,
      entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
      pointsDelta: redemption.pointsSpent,
      referenceType: "REWARD_REDEMPTION_CANCEL",
      referenceId: redemption.id,
      idempotencyKey: `redeem_cancel:${redemption.id}`,
      reason: privacyRedacted
        ? "Reward points restored after customer redaction."
        : reason ||
          `Cancelled reward redemption for ${redemption.rewardDefinition.name}`,
      metadata: privacyRedacted
        ? { privacyRedacted: true }
        : {
            redemptionId: redemption.id,
            discountCode: redemption.shopifyDiscountCode,
          },
      tx,
    });

    // 3. Enqueue Customer Metafields sync
    if (!privacyRedacted) {
      await enqueueOutboxJob({
        storeId,
        jobType: "METAFIELD_SYNC",
        payload: {
          accountId: redemption.accountId,
          triggerReason: "reward_redemption_cancelled",
        },
        idempotencyKey: `metafield_sync:cancel:${redemption.id}`,
        loyaltyMaintenancePermit,
        tx,
      });
    }

    // Always enqueue cleanup, even if the Shopify GID is not known yet. A
    // transport failure can happen after Shopify creates the deterministic
    // code but before the create response reaches Weletic; the worker can
    // reconcile by code and deactivate that remote voucher.
    const deactivationJob = await enqueueOutboxJob({
      storeId,
      jobType: "REDEMPTION_RECOVERY",
      payload: {
        redemptionId: redemption.id,
        accountId: redemption.accountId,
        rewardDefinitionId: redemption.rewardDefinitionId,
        pointsCost: redemption.pointsSpent.toString(),
        shopifyDiscountCode: redemption.shopifyDiscountCode,
        artifactKind: redemption.artifactKind,
        attemptCount: 0,
        sagaPhase: "compensating",
      },
      idempotencyKey: `discount_deactivate:${redemption.id}`,
      tx,
    });

    return {
      redemption: {
        ...redemption,
        status: WeleticRedemptionStatus.cancelled,
        compensationReason,
        metadata: cancellationMetadata,
      },
      ledgerEntry,
      shopifyDiscountId: redemption.shopifyDiscountId,
      deactivationJobId: deactivationJob.job.id,
    };
  });

  let deactivationPending = Boolean(localCancellation.deactivationJobId);
  if (localCancellation.deactivationJobId) {
    try {
      await assertShopifyStoreAcceptsOperationalWrites({
        storeId,
        action: "reward_redemption_cancel_remote",
        loyaltyMaintenancePermit,
      });
      const creds = await resolveShopifyOfflineCredentials({ storeId });
      let discountId = localCancellation.shopifyDiscountId;
      if (!discountId) {
        const recovered = await lookupDiscountByCode(
          creds.shopDomain,
          creds.accessToken,
          localCancellation.redemption.shopifyDiscountCode,
          customFetch,
        );
        if (!recovered) {
          assertLoyaltyDiscountLookupMissIsTerminal({
            redemptionId: localCancellation.redemption.id,
            discountCode: localCancellation.redemption.shopifyDiscountCode,
            metadata: localCancellation.redemption.metadata,
          });
        } else {
          assertExpectedLoyaltyDiscountNode({
            identity: {
              storeId,
              redemptionId: localCancellation.redemption.id,
              accountId: localCancellation.redemption.accountId,
              rewardDefinitionId:
                localCancellation.redemption.rewardDefinitionId,
              discountCode: localCancellation.redemption.shopifyDiscountCode,
            },
            metadata: localCancellation.redemption.metadata,
            remote: recovered,
          });
          discountId = recovered.id;
        }
      }
      if (discountId) {
        const deactivated = await deactivateDiscount(
          creds.shopDomain,
          creds.accessToken,
          discountId,
          customFetch,
        );
        if (!deactivated) {
          throw new Error(
            `Shopify did not confirm discount deactivation for ${redemptionId}`,
          );
        }
      }
      // The durable worker owns the audited CAS completion and reconciliation
      // issue lifecycle. Inline deactivation is only a latency optimization;
      // the worker will verify the idempotent remote state before completing.
    } catch {
      // The durable recovery job owns retries; local cancellation and points
      // restoration are already committed atomically.
    }
  }

  return {
    redemption: localCancellation.redemption,
    ledgerEntry: localCancellation.ledgerEntry,
    deactivationPending,
  };
}
