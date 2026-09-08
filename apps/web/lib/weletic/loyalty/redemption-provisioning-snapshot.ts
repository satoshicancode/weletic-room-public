import {
  canonicalizeShopifyCustomerId,
  createShopifyDerivedPrivacyDigest,
  verifyShopifyDerivedPrivacyDigest,
  VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN,
} from "@/lib/weletic/shopify/privacy-identity";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DEFAULT_REWARD_PURCHASE_POLICY,
  loyaltyPurchasePolicySchema,
  readLoyaltyPurchasePolicy,
} from "./purchase-policy";

const NullableDecimalStringSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/)
  .nullable();

export const LoyaltyRedemptionProvisioningSnapshotSchema = z
  .object({
    version: z.literal(1),
    rewardDefinitionId: z.string().min(1),
    name: z.string(),
    description: z.string().nullable(),
    rewardType: z.enum([
      "amount_off",
      "percentage_off",
      "free_shipping",
      "free_product",
      "gift_card",
      "store_credit",
    ]),
    salesChannel: z.enum(["online_store", "pos", "both"]).optional(),
    purchasePolicy: loyaltyPurchasePolicySchema.optional(),
    pointsCost: z.string().regex(/^\d+$/),
    discountValue: NullableDecimalStringSchema,
    maxDiscountValue: NullableDecimalStringSchema,
    minOrderAmount: NullableDecimalStringSchema,
    appliesToResource: z.string().nullable(),
    entitledCollectionIds: z.array(z.string()),
    entitledProductIds: z.array(z.string()),
    entitledVariantIds: z.array(z.string()),
    combinesWithProductDiscounts: z.boolean(),
    combinesWithOrderDiscounts: z.boolean(),
    combinesWithShippingDiscounts: z.boolean(),
    usageLimit: z.number().int().nonnegative().nullable(),
    usageLimitPerCustomer: z.number().int().min(0).max(1).nullable(),
    expiresInDays: z.number().int().nonnegative().nullable(),
    shopCurrency: z.string().regex(/^[A-Z]{3}$/),
    currencyVerifiedAt: z.string().datetime().nullable().optional(),
    customerSelectionDigest: z
      .string()
      .refine(
        (value) =>
          /^[A-F0-9]{64}$/.test(value) ||
          VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN.test(value),
        "Invalid customer selection digest.",
      ),
    startsAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    contentDigest: z.string().regex(/^[A-F0-9]{64}$/),
  })
  .strict();

export type LoyaltyRedemptionProvisioningSnapshot = z.infer<
  typeof LoyaltyRedemptionProvisioningSnapshotSchema
>;

type SnapshotContent = Omit<
  LoyaltyRedemptionProvisioningSnapshot,
  "contentDigest"
>;

type RewardDefinitionForSnapshot = {
  id: string;
  name: string;
  description?: string | null;
  rewardType: unknown;
  salesChannel?: unknown;
  purchasePolicy?: unknown;
  discountValue?: unknown;
  maxDiscountValue?: unknown;
  minOrderAmount?: unknown;
  appliesToResource?: string | null;
  entitledCollectionIds?: unknown;
  entitledProductIds?: unknown;
  entitledVariantIds?: unknown;
  combinesWithProductDiscounts?: boolean;
  combinesWithOrderDiscounts?: boolean;
  combinesWithShippingDiscounts?: boolean;
  usageLimit?: number | null;
  usageLimitPerCustomer?: number | null;
};

function nullableDecimal(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function stringArray(value: unknown, field: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be a string array.`);
  }
  return [...new Set(value)].sort();
}

function getContentDigest(snapshot: SnapshotContent) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        snapshot.version,
        snapshot.rewardDefinitionId,
        snapshot.name,
        snapshot.description,
        snapshot.rewardType,
        ...(Object.prototype.hasOwnProperty.call(snapshot, "salesChannel")
          ? [snapshot.salesChannel]
          : []),
        ...(Object.prototype.hasOwnProperty.call(snapshot, "purchasePolicy")
          ? [snapshot.purchasePolicy]
          : []),
        snapshot.pointsCost,
        snapshot.discountValue,
        snapshot.maxDiscountValue,
        snapshot.minOrderAmount,
        snapshot.appliesToResource,
        snapshot.entitledCollectionIds,
        snapshot.entitledProductIds,
        snapshot.entitledVariantIds,
        snapshot.combinesWithProductDiscounts,
        snapshot.combinesWithOrderDiscounts,
        snapshot.combinesWithShippingDiscounts,
        snapshot.usageLimit,
        snapshot.usageLimitPerCustomer,
        snapshot.expiresInDays,
        snapshot.shopCurrency,
        ...(Object.prototype.hasOwnProperty.call(snapshot, "currencyVerifiedAt")
          ? [snapshot.currencyVerifiedAt]
          : []),
        snapshot.customerSelectionDigest,
        snapshot.startsAt,
        snapshot.expiresAt,
      ]),
    )
    .digest("hex")
    .toUpperCase();
}

export function createLoyaltyRedemptionProvisioningSnapshot({
  reward,
  pointsCost,
  discountValue,
  expiresInDays,
  shopCurrency,
  currencyVerifiedAt,
  customerSelectionDigest,
  startsAt,
  expiresAt,
}: {
  reward: RewardDefinitionForSnapshot;
  pointsCost: bigint;
  discountValue: unknown;
  expiresInDays: number | null;
  shopCurrency: string;
  currencyVerifiedAt: Date;
  customerSelectionDigest: string;
  startsAt: Date;
  expiresAt: Date | null;
}): LoyaltyRedemptionProvisioningSnapshot {
  const rewardType = String(reward.rewardType);
  if (
    rewardType !== "amount_off" &&
    rewardType !== "percentage_off" &&
    rewardType !== "free_shipping" &&
    rewardType !== "free_product" &&
    rewardType !== "gift_card" &&
    rewardType !== "store_credit"
  ) {
    throw new Error(`Unsupported reward type '${rewardType}'.`);
  }

  const content: SnapshotContent = {
    version: 1,
    rewardDefinitionId: reward.id,
    name: reward.name,
    description: reward.description ?? null,
    rewardType,
    ...(reward.salesChannel === "online_store" ||
    reward.salesChannel === "pos" ||
    reward.salesChannel === "both"
      ? { salesChannel: reward.salesChannel }
      : {}),
    purchasePolicy: readLoyaltyPurchasePolicy(
      reward.purchasePolicy,
      DEFAULT_REWARD_PURCHASE_POLICY,
    ),
    pointsCost: pointsCost.toString(),
    discountValue: nullableDecimal(discountValue),
    maxDiscountValue: nullableDecimal(reward.maxDiscountValue),
    minOrderAmount: nullableDecimal(reward.minOrderAmount),
    appliesToResource: reward.appliesToResource ?? null,
    entitledCollectionIds: stringArray(
      reward.entitledCollectionIds,
      "entitledCollectionIds",
    ),
    entitledProductIds: stringArray(
      reward.entitledProductIds,
      "entitledProductIds",
    ),
    entitledVariantIds: stringArray(
      reward.entitledVariantIds,
      "entitledVariantIds",
    ),
    combinesWithProductDiscounts: Boolean(reward.combinesWithProductDiscounts),
    combinesWithOrderDiscounts: Boolean(reward.combinesWithOrderDiscounts),
    combinesWithShippingDiscounts: Boolean(
      reward.combinesWithShippingDiscounts,
    ),
    usageLimit: reward.usageLimit ?? null,
    usageLimitPerCustomer: reward.usageLimitPerCustomer ?? null,
    expiresInDays,
    shopCurrency: shopCurrency.trim().toUpperCase(),
    currencyVerifiedAt: currencyVerifiedAt.toISOString(),
    customerSelectionDigest,
    startsAt: startsAt.toISOString(),
    expiresAt: expiresAt?.toISOString() ?? null,
  };

  return { ...content, contentDigest: getContentDigest(content) };
}

export function getShopifyCustomerSelectionDigest({
  storeId,
  shopifyCustomerId,
}: {
  storeId: string;
  shopifyCustomerId: string;
}) {
  return createShopifyDerivedPrivacyDigest({
    purpose: "customer_selection",
    values: [storeId.trim(), canonicalizeShopifyCustomerId(shopifyCustomerId)],
  });
}

export function matchesShopifyCustomerSelectionDigest({
  digest,
  storeId,
  shopifyCustomerId,
}: {
  digest: string;
  storeId: string;
  shopifyCustomerId: string;
}) {
  if (/^[A-F0-9]{64}$/.test(digest)) {
    const legacyDigest = createHash("sha256")
      .update(JSON.stringify([storeId, shopifyCustomerId]))
      .digest("hex")
      .toUpperCase();
    return legacyDigest === digest;
  }
  return verifyShopifyDerivedPrivacyDigest({
    encodedDigest: digest,
    purpose: "customer_selection",
    values: [storeId.trim(), canonicalizeShopifyCustomerId(shopifyCustomerId)],
  });
}

export function parseLoyaltyRedemptionProvisioningSnapshot(
  value: unknown,
): LoyaltyRedemptionProvisioningSnapshot {
  const snapshot = LoyaltyRedemptionProvisioningSnapshotSchema.parse(value);
  const { contentDigest, ...content } = snapshot;
  if (contentDigest !== getContentDigest(content)) {
    throw new Error("Loyalty redemption provisioning snapshot is corrupted.");
  }
  return snapshot;
}

export function readLoyaltyRedemptionProvisioningSnapshot(
  metadata: unknown,
): LoyaltyRedemptionProvisioningSnapshot | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const value = (metadata as Record<string, unknown>).provisioningSnapshot;
  return value ? parseLoyaltyRedemptionProvisioningSnapshot(value) : null;
}

export function getRewardDefinitionFromProvisioningSnapshot({
  snapshot,
  provisioningName,
}: {
  snapshot: LoyaltyRedemptionProvisioningSnapshot;
  provisioningName: string;
}) {
  return {
    id: snapshot.rewardDefinitionId,
    name: provisioningName,
    rewardType: snapshot.rewardType,
    salesChannel: snapshot.salesChannel,
    purchasePolicy: snapshot.purchasePolicy ?? DEFAULT_REWARD_PURCHASE_POLICY,
    discountValue: snapshot.discountValue,
    maxDiscountValue: snapshot.maxDiscountValue,
    minOrderAmount: snapshot.minOrderAmount,
    appliesToResource: snapshot.appliesToResource,
    entitledCollectionIds: snapshot.entitledCollectionIds,
    entitledProductIds: snapshot.entitledProductIds,
    entitledVariantIds: snapshot.entitledVariantIds,
    combinesWithProductDiscounts: snapshot.combinesWithProductDiscounts,
    combinesWithOrderDiscounts: snapshot.combinesWithOrderDiscounts,
    combinesWithShippingDiscounts: snapshot.combinesWithShippingDiscounts,
    usageLimit: snapshot.usageLimit,
    usageLimitPerCustomer: snapshot.usageLimitPerCustomer,
    expiresInDays: snapshot.expiresInDays,
  };
}

export function assertProvisioningReplayMatchesSnapshot({
  snapshot,
  pointsCostOverride,
  discountValueOverride,
  expiresInDays,
  storeId,
  shopifyCustomerId,
}: {
  snapshot: LoyaltyRedemptionProvisioningSnapshot;
  pointsCostOverride?: bigint | number;
  discountValueOverride?: number | string;
  expiresInDays?: number | null;
  storeId: string;
  shopifyCustomerId: string;
}) {
  if (
    pointsCostOverride !== undefined &&
    BigInt(pointsCostOverride) !== BigInt(snapshot.pointsCost)
  ) {
    throw new Error(
      "Redemption idempotency key was replayed with a different points cost.",
    );
  }
  if (
    discountValueOverride !== undefined &&
    String(discountValueOverride) !== snapshot.discountValue
  ) {
    throw new Error(
      "Redemption idempotency key was replayed with a different discount value.",
    );
  }
  if (expiresInDays !== undefined && expiresInDays !== snapshot.expiresInDays) {
    throw new Error(
      "Redemption idempotency key was replayed with a different expiry policy.",
    );
  }
  if (
    !matchesShopifyCustomerSelectionDigest({
      digest: snapshot.customerSelectionDigest,
      storeId,
      shopifyCustomerId,
    })
  ) {
    throw new Error(
      "Redemption idempotency replay resolved a different Shopify customer.",
    );
  }
}
