import type { WeleticRewardDefinition } from "@prisma/client";
import {
  DEFAULT_REWARD_PURCHASE_POLICY,
  loyaltyPurchasePolicySchema,
} from "./purchase-policy";
import { rewardCatalogFieldsSchema } from "./reward-catalog-contract";

function projectIds(value: unknown, resource: string): unknown {
  if (value === null) return [];
  if (!Array.isArray(value)) return value;
  return value.map((id: unknown) =>
    typeof id === "string" && /^[1-9]\d*$/.test(id)
      ? `gid://shopify/${resource}/${id}`
      : id,
  );
}

/** Minimal editor projection, never raw Prisma/JSON or provider identity. */
export function projectRewardCatalogEntry(reward: WeleticRewardDefinition) {
  const purchasePolicy = loyaltyPurchasePolicySchema.safeParse(
    reward.purchasePolicy ?? DEFAULT_REWARD_PURCHASE_POLICY,
  );
  const parsed = rewardCatalogFieldsSchema.safeParse({
    name: reward.name,
    description: reward.description,
    rewardType: reward.rewardType,
    salesChannel: reward.salesChannel,
    exchangeType: reward.exchangeType,
    pointsCost: reward.pointsCost.toString(),
    pointsStep: reward.pointsStep?.toString() ?? null,
    minPointsCost: reward.minPointsCost?.toString() ?? null,
    maxPointsCost: reward.maxPointsCost?.toString() ?? null,
    discountValue: reward.discountValue?.toString() ?? null,
    maxDiscountValue: reward.maxDiscountValue?.toString() ?? null,
    minOrderAmount: reward.minOrderAmount?.toString() ?? null,
    appliesToResource: reward.appliesToResource,
    entitledProductIds: projectIds(reward.entitledProductIds, "Product"),
    entitledVariantIds: projectIds(reward.entitledVariantIds, "ProductVariant"),
    entitledCollectionIds: projectIds(
      reward.entitledCollectionIds,
      "Collection",
    ),
    combinesWithOrderDiscounts: reward.combinesWithOrderDiscounts,
    combinesWithProductDiscounts: reward.combinesWithProductDiscounts,
    combinesWithShippingDiscounts: reward.combinesWithShippingDiscounts,
    usageLimit: reward.usageLimit,
    usageLimitPerCustomer: reward.usageLimitPerCustomer,
    expiresInDays: reward.expiresInDays,
    ...(purchasePolicy.success ? purchasePolicy.data : {}),
    status: reward.status,
  });
  // Older scope names, POS definitions, zero-point direct-incentive definitions,
  // and provider-backed legacy rewards need their own deliberate migration.
  const editable =
    parsed.success &&
    purchasePolicy.success &&
    reward.shopifyPriceRuleId === null;
  return {
    id: reward.id,
    name: reward.name,
    rewardType: reward.rewardType,
    status: reward.status,
    fields: editable && parsed.success ? parsed.data : null,
    editUnavailableReason: editable
      ? null
      : ("legacy_configuration_requires_review" as const),
  };
}
