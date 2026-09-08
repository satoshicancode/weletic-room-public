import {
  ShopifyEcommerceRewardConfig,
  ShopifyRewardActivation,
  ShopifyRewardCollectionOverride,
  ShopifyRewardProductOverride,
  ShopifyRewardSegment,
  ShopifyRewardVariantOverride,
  ShopifySubscriptionCommissionMode,
} from "@/lib/zod/schemas/shopify-ecommerce-reward";

export type ShopifyRewardLifecycleMode = "draft" | "active" | "scheduled";

export type ShopifyRewardSegmentDraft = Omit<ShopifyRewardSegment, "rate"> & {
  rate: string;
};

export type ShopifyRewardCollectionOverrideDraft = Omit<
  ShopifyRewardCollectionOverride,
  "returningRate" | "newRate" | "segmentRate"
> & {
  returningRate: string;
  newRate?: string;
  segmentRate?: string;
};

export type ShopifyRewardProductOverrideDraft = Omit<
  ShopifyRewardProductOverride,
  "returningRate" | "newRate" | "segmentRate"
> & {
  returningRate: string;
  newRate?: string;
  segmentRate?: string;
};

export type ShopifyRewardVariantOverrideDraft = Omit<
  ShopifyRewardVariantOverride,
  "returningRate" | "newRate" | "segmentRate"
> & {
  returningRate: string;
  newRate?: string;
  segmentRate?: string;
};

export type ShopifyRewardOverrideDraft =
  | ShopifyRewardCollectionOverrideDraft
  | ShopifyRewardProductOverrideDraft
  | ShopifyRewardVariantOverrideDraft;

export type ShopifyRewardOverrideScope = "variant" | "product" | "collection";

type ShopifyRewardOverrideTarget = {
  id: string;
  title: string;
};

export function retargetShopifyRewardOverrideDraft({
  override,
  scope,
  target,
}: {
  override: ShopifyRewardOverrideDraft;
  scope: "product";
  target: ShopifyRewardOverrideTarget;
}): ShopifyRewardProductOverrideDraft;
export function retargetShopifyRewardOverrideDraft({
  override,
  scope,
  target,
}: {
  override: ShopifyRewardOverrideDraft;
  scope: "variant";
  target: ShopifyRewardOverrideTarget;
}): ShopifyRewardVariantOverrideDraft;
export function retargetShopifyRewardOverrideDraft({
  override,
  scope,
  target,
}: {
  override: ShopifyRewardOverrideDraft;
  scope: "collection";
  target: ShopifyRewardOverrideTarget;
}): ShopifyRewardCollectionOverrideDraft;
export function retargetShopifyRewardOverrideDraft({
  override,
  scope,
  target,
}: {
  override: ShopifyRewardOverrideDraft;
  scope: ShopifyRewardOverrideScope;
  target: ShopifyRewardOverrideTarget;
}): ShopifyRewardOverrideDraft {
  const rates = {
    returningRate: override.returningRate,
    ...(override.newRate === undefined ? {} : { newRate: override.newRate }),
    ...(override.segmentRate === undefined
      ? {}
      : { segmentRate: override.segmentRate }),
  };

  if (scope === "product") {
    return {
      ...target,
      ...rates,
      image:
        "image" in override && override.id === target.id
          ? override.image ?? null
          : null,
    };
  }

  return {
    ...target,
    ...rates,
  };
}

export interface ShopifyEcommerceRewardDraft {
  lifecycleMode: ShopifyRewardLifecycleMode;
  startsAt: string;
  endsAt: string;
  customerSegmentMode: ShopifyEcommerceRewardConfig["customerSegmentMode"];
  baseRateType: ShopifyEcommerceRewardConfig["baseRateType"];
  baseReturningRate: string;
  baseNewRate: string;
  shopifySegment: ShopifyRewardSegmentDraft | null;
  collectionOverrides: ShopifyRewardCollectionOverrideDraft[];
  productOverrides: ShopifyRewardProductOverrideDraft[];
  variantOverrides: ShopifyRewardVariantOverrideDraft[];
  subscriptionMode: ShopifySubscriptionCommissionMode;
  recurringOrderCount: string;
}

export const toShopifyRewardRateDraft = (value: number) => String(value);

export const getShopifyRewardLifecycleMode = (
  activation: ShopifyRewardActivation,
): ShopifyRewardLifecycleMode =>
  !activation.published
    ? "draft"
    : activation.startsAt || activation.endsAt
      ? "scheduled"
      : "active";

export const toShopifyRewardDateTimeDraft = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const parseShopifyRewardDateTimeDraft = (value: string) => {
  if (value.trim() === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const toOptionalRateDraft = (value?: number) =>
  value === undefined ? undefined : String(value);

export const parseShopifyRewardRateDraft = (value: string | undefined) => {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
    ? parsed
    : null;
};

export const isValidShopifyRewardRateDraft = (value: string | undefined) =>
  parseShopifyRewardRateDraft(value) !== null;

export const parseShopifyRecurringOrderCountDraft = (value: string) => {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
};

export const toShopifyCollectionOverrideDraft = (
  override: ShopifyRewardCollectionOverride,
): ShopifyRewardCollectionOverrideDraft => ({
  ...override,
  returningRate: toShopifyRewardRateDraft(override.returningRate),
  newRate: toOptionalRateDraft(override.newRate),
  segmentRate: toOptionalRateDraft(override.segmentRate),
});

export const toShopifyProductOverrideDraft = (
  override: ShopifyRewardProductOverride,
): ShopifyRewardProductOverrideDraft => ({
  ...override,
  returningRate: toShopifyRewardRateDraft(override.returningRate),
  newRate: toOptionalRateDraft(override.newRate),
  segmentRate: toOptionalRateDraft(override.segmentRate),
});

export const toShopifyVariantOverrideDraft = (
  override: ShopifyRewardVariantOverride,
): ShopifyRewardVariantOverrideDraft => ({
  ...override,
  returningRate: toShopifyRewardRateDraft(override.returningRate),
  newRate: toOptionalRateDraft(override.newRate),
  segmentRate: toOptionalRateDraft(override.segmentRate),
});

export function validateShopifyEcommerceRewardDraft(
  draft: ShopifyEcommerceRewardDraft,
) {
  const startsAt = parseShopifyRewardDateTimeDraft(draft.startsAt);
  const endsAt = parseShopifyRewardDateTimeDraft(draft.endsAt);
  const lifecycleValid =
    draft.lifecycleMode !== "scheduled" ||
    (startsAt !== null &&
      (draft.endsAt.trim() === "" ||
        (endsAt !== null && new Date(endsAt) > new Date(startsAt))));
  const secondaryBaseRate =
    draft.customerSegmentMode === "shopify_segment"
      ? draft.shopifySegment?.rate
      : draft.baseNewRate;
  const baseRatesValid =
    isValidShopifyRewardRateDraft(draft.baseReturningRate) &&
    (draft.customerSegmentMode === "none" ||
      isValidShopifyRewardRateDraft(secondaryBaseRate));
  const segmentValid =
    draft.customerSegmentMode !== "shopify_segment" || !!draft.shopifySegment;
  const overridesValid = [
    ...draft.variantOverrides,
    ...draft.productOverrides,
    ...draft.collectionOverrides,
  ].every(
    (override) =>
      isValidShopifyRewardRateDraft(override.returningRate) &&
      (draft.customerSegmentMode === "none" ||
        isValidShopifyRewardRateDraft(
          draft.customerSegmentMode === "new_vs_returning"
            ? override.newRate ?? draft.baseNewRate
            : override.segmentRate ??
                draft.shopifySegment?.rate ??
                draft.baseNewRate,
        )),
  );
  const subscriptionValid =
    draft.subscriptionMode !== "limited_recurring_orders" ||
    parseShopifyRecurringOrderCountDraft(draft.recurringOrderCount) !== null;

  return {
    lifecycleValid,
    baseRatesValid,
    segmentValid,
    overridesValid,
    subscriptionValid,
    valid:
      lifecycleValid &&
      baseRatesValid &&
      segmentValid &&
      overridesValid &&
      subscriptionValid,
  };
}

export function serializeShopifyEcommerceRewardDraft({
  draft,
  fallbackConfig,
}: {
  draft: ShopifyEcommerceRewardDraft;
  fallbackConfig: ShopifyEcommerceRewardConfig;
}): ShopifyEcommerceRewardConfig | null {
  if (!validateShopifyEcommerceRewardDraft(draft).valid) return null;

  const baseReturningRate = parseShopifyRewardRateDraft(
    draft.baseReturningRate,
  )!;
  const baseNewRate =
    parseShopifyRewardRateDraft(draft.baseNewRate) ??
    fallbackConfig.baseNewRate;
  const segmentRate = draft.shopifySegment
    ? parseShopifyRewardRateDraft(draft.shopifySegment.rate) ??
      fallbackConfig.shopifySegment?.rate ??
      baseNewRate
    : null;
  const startsAt = parseShopifyRewardDateTimeDraft(draft.startsAt);
  const endsAt = parseShopifyRewardDateTimeDraft(draft.endsAt);

  return {
    type: "shopify_ecommerce",
    activation:
      draft.lifecycleMode === "draft"
        ? { published: false, startsAt: null, endsAt: null }
        : draft.lifecycleMode === "active"
          ? { published: true, startsAt: null, endsAt: null }
          : { published: true, startsAt: startsAt!, endsAt },
    customerSegmentMode: draft.customerSegmentMode,
    baseRateType: draft.baseRateType,
    baseReturningRate,
    baseNewRate,
    shopifySegment:
      draft.shopifySegment && segmentRate !== null
        ? { ...draft.shopifySegment, rate: segmentRate }
        : null,
    collectionOverrides: draft.collectionOverrides.map((override) => ({
      ...override,
      returningRate: parseShopifyRewardRateDraft(override.returningRate)!,
      newRate:
        override.newRate === undefined
          ? undefined
          : parseShopifyRewardRateDraft(override.newRate) ?? undefined,
      segmentRate:
        override.segmentRate === undefined
          ? undefined
          : parseShopifyRewardRateDraft(override.segmentRate) ?? undefined,
    })),
    productOverrides: draft.productOverrides.map((override) => ({
      ...override,
      returningRate: parseShopifyRewardRateDraft(override.returningRate)!,
      newRate:
        override.newRate === undefined
          ? undefined
          : parseShopifyRewardRateDraft(override.newRate) ?? undefined,
      segmentRate:
        override.segmentRate === undefined
          ? undefined
          : parseShopifyRewardRateDraft(override.segmentRate) ?? undefined,
    })),
    variantOverrides: draft.variantOverrides.map((override) => ({
      ...override,
      returningRate: parseShopifyRewardRateDraft(override.returningRate)!,
      newRate:
        override.newRate === undefined
          ? undefined
          : parseShopifyRewardRateDraft(override.newRate) ?? undefined,
      segmentRate:
        override.segmentRate === undefined
          ? undefined
          : parseShopifyRewardRateDraft(override.segmentRate) ?? undefined,
    })),
    subscriptionRules: {
      mode: draft.subscriptionMode,
      recurringOrderCount:
        draft.subscriptionMode === "limited_recurring_orders"
          ? parseShopifyRecurringOrderCountDraft(draft.recurringOrderCount)
          : null,
    },
  };
}
