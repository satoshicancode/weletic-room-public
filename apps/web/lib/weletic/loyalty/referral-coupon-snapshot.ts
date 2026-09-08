import { createHash } from "node:crypto";
import { z } from "zod";

import { getShopifyCustomerSelectionDigest } from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import { VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN } from "@/lib/weletic/shopify/privacy-identity";

const REFERRAL_COUPON_IDENTITY_HEX_LENGTH = 24;
const SHOPIFY_DISCOUNT_TITLE_MAX_LENGTH = 255;

const NullableDecimalStringSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d+)?$/)
  .nullable();

export const ReferralCouponRewardSnapshotSchema = z
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
    ]),
    salesChannel: z.enum(["online_store", "pos", "both"]).optional(),
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
    usageLimitPerCustomer: z.number().int().nonnegative().nullable(),
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
    qualifiedAt: z.string().datetime(),
    expiresAt: z.string().datetime().nullable(),
    discountCode: z.string().min(1),
    ownershipFingerprint: z.string().regex(/^[A-F0-9]{24}$/),
    provisioningName: z.string().min(1),
    expectedTitle: z.string().min(1),
    contentDigest: z.string().regex(/^[A-F0-9]{64}$/),
  })
  .strict();

export type ReferralCouponRewardSnapshot = z.infer<
  typeof ReferralCouponRewardSnapshotSchema
>;

type ReferralCouponRewardSnapshotContent = Omit<
  ReferralCouponRewardSnapshot,
  "contentDigest"
>;

export function getReferralCouponRewardSnapshotContentDigest(
  snapshot: ReferralCouponRewardSnapshotContent,
) {
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
        snapshot.qualifiedAt,
        snapshot.expiresAt,
        snapshot.discountCode,
        snapshot.ownershipFingerprint,
        snapshot.provisioningName,
        snapshot.expectedTitle,
      ]),
    )
    .digest("hex")
    .toUpperCase();
}

export type ReferralCouponIdentity = {
  storeId: string;
  referralId: string;
  qualificationOrderId: string;
  accountId: string;
  rewardDefinitionId: string;
  side: "advocate" | "referee";
};

type ReferralCouponRewardDefinition = {
  id: string;
  name: string;
  description: string | null;
  rewardType: unknown;
  salesChannel?: unknown;
  discountValue: unknown;
  maxDiscountValue: unknown;
  minOrderAmount: unknown;
  appliesToResource: string | null;
  entitledCollectionIds: unknown;
  entitledProductIds: unknown;
  entitledVariantIds: unknown;
  combinesWithProductDiscounts: boolean;
  combinesWithOrderDiscounts: boolean;
  combinesWithShippingDiscounts: boolean;
  usageLimit: number | null;
  usageLimitPerCustomer: number | null;
  expiresInDays: number | null;
};

function getNullableDecimalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function getStringArray(value: unknown, fieldName: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Referral coupon ${fieldName} must be a string array.`);
  }
  return [...new Set(value)].sort();
}

export function getReferralCouponIdentityFingerprint(
  identity: ReferralCouponIdentity,
) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.storeId,
        identity.referralId,
        identity.qualificationOrderId,
        identity.accountId,
        identity.rewardDefinitionId,
        identity.side,
      ]),
    )
    .digest("hex")
    .slice(0, REFERRAL_COUPON_IDENTITY_HEX_LENGTH)
    .toUpperCase();
}

export function getReferralCouponDiscountCode(
  identity: ReferralCouponIdentity,
) {
  return `WLR-${getReferralCouponIdentityFingerprint(identity)}`;
}

export function getReferralCouponProvisioningIdentity(
  identity: ReferralCouponIdentity & {
    rewardName: string;
    discountCode: string;
  },
) {
  const fingerprint = getReferralCouponIdentityFingerprint(identity);
  const ownershipSuffix = ` [WLR:${fingerprint}]`;
  const codeSuffix = ` (${identity.discountCode})`;
  const maximumBaseLength =
    SHOPIFY_DISCOUNT_TITLE_MAX_LENGTH -
    ownershipSuffix.length -
    codeSuffix.length;
  const rewardName = identity.rewardName.trim() || "Referral reward";
  const baseName = rewardName.slice(0, maximumBaseLength).trimEnd();
  const provisioningName = `${baseName}${ownershipSuffix}`;
  return {
    fingerprint,
    provisioningName,
    expectedTitle: `${provisioningName}${codeSuffix}`,
  };
}

export function createReferralCouponRewardSnapshot({
  identity,
  reward,
  qualifiedAt,
  shopCurrency,
  currencyVerifiedAt,
  shopifyCustomerId,
}: {
  identity: ReferralCouponIdentity;
  reward: ReferralCouponRewardDefinition;
  qualifiedAt: Date;
  shopCurrency: string;
  currencyVerifiedAt: Date;
  shopifyCustomerId: string;
}): ReferralCouponRewardSnapshot {
  if (reward.id !== identity.rewardDefinitionId) {
    throw new Error(
      "Referral coupon reward definition does not match its qualification identity.",
    );
  }
  if (!Number.isFinite(qualifiedAt.getTime())) {
    throw new Error("Referral coupon qualification timestamp is invalid.");
  }

  const discountCode = getReferralCouponDiscountCode(identity);
  const ownership = getReferralCouponProvisioningIdentity({
    ...identity,
    rewardName: reward.name,
    discountCode,
  });
  const expiresAt =
    typeof reward.expiresInDays === "number" && reward.expiresInDays > 0
      ? new Date(
          qualifiedAt.getTime() + reward.expiresInDays * 86_400_000,
        ).toISOString()
      : null;
  const rewardType = ReferralCouponRewardSnapshotSchema.shape.rewardType.parse(
    reward.rewardType,
  );
  const salesChannel =
    reward.salesChannel === undefined
      ? undefined
      : ReferralCouponRewardSnapshotSchema.shape.salesChannel
          .unwrap()
          .parse(reward.salesChannel);
  const appliesToResource = reward.appliesToResource ?? null;
  const appliesToEntireOrder = appliesToResource === "entire_order";
  const normalizedShopCurrency = shopCurrency.trim().toUpperCase();
  const startsAt = qualifiedAt.toISOString();

  const snapshotContent: ReferralCouponRewardSnapshotContent = {
    version: 1,
    rewardDefinitionId: reward.id,
    name: reward.name,
    description: reward.description,
    rewardType,
    ...(salesChannel ? { salesChannel } : {}),
    discountValue: getNullableDecimalString(reward.discountValue),
    maxDiscountValue: getNullableDecimalString(reward.maxDiscountValue),
    minOrderAmount: getNullableDecimalString(reward.minOrderAmount),
    appliesToResource,
    entitledCollectionIds: appliesToEntireOrder
      ? []
      : getStringArray(reward.entitledCollectionIds, "entitledCollectionIds"),
    entitledProductIds: appliesToEntireOrder
      ? []
      : getStringArray(reward.entitledProductIds, "entitledProductIds"),
    entitledVariantIds: appliesToEntireOrder
      ? []
      : getStringArray(reward.entitledVariantIds, "entitledVariantIds"),
    combinesWithProductDiscounts: reward.combinesWithProductDiscounts,
    combinesWithOrderDiscounts: reward.combinesWithOrderDiscounts,
    combinesWithShippingDiscounts: reward.combinesWithShippingDiscounts,
    usageLimit: reward.usageLimit,
    usageLimitPerCustomer: reward.usageLimitPerCustomer,
    expiresInDays: reward.expiresInDays,
    shopCurrency: normalizedShopCurrency,
    currencyVerifiedAt: currencyVerifiedAt.toISOString(),
    customerSelectionDigest: getShopifyCustomerSelectionDigest({
      storeId: identity.storeId,
      shopifyCustomerId,
    }),
    startsAt,
    qualifiedAt: startsAt,
    expiresAt,
    discountCode,
    ownershipFingerprint: ownership.fingerprint,
    provisioningName: ownership.provisioningName,
    expectedTitle: ownership.expectedTitle,
  };
  return ReferralCouponRewardSnapshotSchema.parse({
    ...snapshotContent,
    contentDigest:
      getReferralCouponRewardSnapshotContentDigest(snapshotContent),
  });
}

export function parseReferralCouponRewardSnapshotForIdentity(
  value: unknown,
  identity: ReferralCouponIdentity,
): ReferralCouponRewardSnapshot {
  const snapshot = ReferralCouponRewardSnapshotSchema.parse(value);
  const discountCode = getReferralCouponDiscountCode(identity);
  const ownership = getReferralCouponProvisioningIdentity({
    ...identity,
    rewardName: snapshot.name,
    discountCode,
  });
  const qualifiedAt = new Date(snapshot.qualifiedAt);
  const expectedExpiresAt =
    snapshot.expiresInDays !== null && snapshot.expiresInDays > 0
      ? new Date(
          qualifiedAt.getTime() + snapshot.expiresInDays * 86_400_000,
        ).toISOString()
      : null;
  const { contentDigest, ...snapshotContent } = snapshot;

  if (
    snapshot.rewardDefinitionId !== identity.rewardDefinitionId ||
    snapshot.discountCode !== discountCode ||
    snapshot.ownershipFingerprint !== ownership.fingerprint ||
    snapshot.provisioningName !== ownership.provisioningName ||
    snapshot.expectedTitle !== ownership.expectedTitle ||
    snapshot.startsAt !== snapshot.qualifiedAt ||
    snapshot.expiresAt !== expectedExpiresAt ||
    contentDigest !==
      getReferralCouponRewardSnapshotContentDigest(snapshotContent)
  ) {
    throw new Error(
      "Referral coupon reward snapshot does not match its immutable qualification identity.",
    );
  }

  return snapshot;
}
