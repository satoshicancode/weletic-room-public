import { decimalToMinorUnits } from "@/lib/weletic/money";
import {
  getShopifyRewardConfigCore,
  isShopifyRewardActiveAt,
  sameShopifyRewardResourceId,
  ShopifyEcommerceRewardConfigSchema,
  type ShopifyEcommerceRewardConfig,
} from "@/lib/zod/schemas/shopify-ecommerce-reward";

export type ShopifyCustomerClassification = "new" | "returning" | "unknown";
export type ShopifySubscriptionCycle =
  | "not_subscription"
  | "unknown"
  | "first"
  | "recurring";
export type ShopifyRewardSource =
  | "default_group"
  | "collection"
  | "product"
  | "variant"
  | "subscription";

export interface ShopifyRewardProductContext {
  productId?: string | null;
  productExternalId?: string | null;
  variantId?: string | null;
  variantExternalId?: string | null;
  collectionExternalIds?: string[];
}

export interface ShopifyRewardCustomerContext {
  classification: ShopifyCustomerClassification;
  segmentIds?: string[];
}

export interface ShopifyRewardSubscriptionContext {
  sellingPlanId?: string | null;
  subscriptionSeriesKey?: string | null;
  sequence?: number | null;
  cycle: ShopifySubscriptionCycle;
}

export interface ResolvedShopifyCommission {
  configHash: string;
  source: ShopifyRewardSource;
  sourceId: string | null;
  specificity: 1 | 2 | 3 | 4;
  priority: number;
  type: "percentage" | "fixed";
  basisPoints: number | null;
  fixedAmount: bigint | null;
  customerClassification: ShopifyCustomerClassification;
  matchedSegmentId: string | null;
  subscriptionCycle: ShopifySubscriptionCycle;
  sellingPlanId: string | null;
}

export const sameShopifyId = sameShopifyRewardResourceId;

export const hashShopifyRewardConfig = (
  config: ShopifyEcommerceRewardConfig,
) => {
  const str = JSON.stringify(getShopifyRewardConfigCore(config));
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0))
    .toString(16)
    .padStart(14, "0");
};

const toMoneyRule = ({
  rate,
  config,
  accountingCurrency,
}: {
  rate: number;
  config: ShopifyEcommerceRewardConfig;
  accountingCurrency: string;
}) =>
  config.baseRateType === "flat"
    ? {
        type: "fixed" as const,
        basisPoints: null,
        fixedAmount: decimalToMinorUnits(String(rate), accountingCurrency),
      }
    : {
        type: "percentage" as const,
        basisPoints: Math.round(rate * 100),
        fixedAmount: null,
      };

export function resolveShopifyEcommerceCommission({
  rawConfig,
  accountingCurrency,
  productContext,
  customerContext,
  subscriptionContext = { cycle: "not_subscription" },
  occurredAt = new Date(),
}: {
  rawConfig: unknown;
  accountingCurrency: string;
  productContext?: ShopifyRewardProductContext;
  customerContext: ShopifyRewardCustomerContext;
  subscriptionContext?: ShopifyRewardSubscriptionContext;
  occurredAt?: Date;
}): ResolvedShopifyCommission | null {
  const parsed = ShopifyEcommerceRewardConfigSchema.safeParse(rawConfig);
  if (!parsed.success) return null;
  const config = parsed.data;
  if (!isShopifyRewardActiveAt(config.activation, occurredAt)) return null;
  const configHash = hashShopifyRewardConfig(config);

  // A selling plan exists, but Shopify did not expose enough metadata to
  // distinguish a subscription from pre-order/try-before-you-buy. Retrying
  // transport failures happens upstream; an inaccessible node fails closed.
  if (subscriptionContext.cycle === "unknown") return null;

  if (subscriptionContext.cycle === "recurring") {
    const { mode, recurringOrderCount } = config.subscriptionRules;
    const sequence = subscriptionContext.sequence;
    const isEligible =
      mode === "every_recurring_order" ||
      (mode === "limited_recurring_orders" &&
        recurringOrderCount !== null &&
        typeof sequence === "number" &&
        Number.isInteger(sequence) &&
        sequence >= 2 &&
        sequence <= recurringOrderCount + 1);

    if (!isEligible) {
      return {
        configHash,
        source: "subscription",
        sourceId: subscriptionContext.sellingPlanId ?? null,
        specificity: 1,
        priority: 0,
        ...toMoneyRule({ rate: 0, config, accountingCurrency }),
        customerClassification: customerContext.classification,
        matchedSegmentId: null,
        subscriptionCycle: "recurring",
        sellingPlanId: subscriptionContext.sellingPlanId ?? null,
      };
    }
  }

  const segment = config.shopifySegment;
  const isSegmentMember = Boolean(
    config.customerSegmentMode === "shopify_segment" &&
      segment &&
      customerContext.segmentIds?.some((segmentId) =>
        sameShopifyId("Segment", segment.id, segmentId),
      ),
  );
  const isNew =
    config.customerSegmentMode === "new_vs_returning" &&
    customerContext.classification === "new";

  const rateFor = (override?: {
    returningRate: number;
    newRate?: number;
    segmentRate?: number;
  }) => {
    if (isSegmentMember && segment) {
      return override?.segmentRate ?? segment.rate;
    }
    if (isNew) return override?.newRate ?? config.baseNewRate;
    return override?.returningRate ?? config.baseReturningRate;
  };

  const variantOverride = productContext
    ? config.variantOverrides.find(
        (override) =>
          sameShopifyId(
            "ProductVariant",
            override.id,
            productContext.variantId,
          ) ||
          sameShopifyId(
            "ProductVariant",
            override.id,
            productContext.variantExternalId,
          ),
      )
    : undefined;
  if (variantOverride) {
    return {
      configHash,
      source: "variant",
      sourceId: variantOverride.id,
      specificity: 4,
      priority: Math.max(
        10,
        1000 - config.variantOverrides.indexOf(variantOverride) * 10,
      ),
      ...toMoneyRule({
        rate: rateFor(variantOverride),
        config,
        accountingCurrency,
      }),
      customerClassification: customerContext.classification,
      matchedSegmentId: isSegmentMember && segment ? segment.id : null,
      subscriptionCycle: subscriptionContext.cycle,
      sellingPlanId: subscriptionContext.sellingPlanId ?? null,
    };
  }

  const productOverride = productContext
    ? config.productOverrides.find(
        (override) =>
          sameShopifyId("Product", override.id, productContext.productId) ||
          sameShopifyId(
            "Product",
            override.id,
            productContext.productExternalId,
          ),
      )
    : undefined;
  if (productOverride) {
    return {
      configHash,
      source: "product",
      sourceId: productOverride.id,
      specificity: 3,
      priority: Math.max(
        10,
        1000 - config.productOverrides.indexOf(productOverride) * 10,
      ),
      ...toMoneyRule({
        rate: rateFor(productOverride),
        config,
        accountingCurrency,
      }),
      customerClassification: customerContext.classification,
      matchedSegmentId: isSegmentMember && segment ? segment.id : null,
      subscriptionCycle: subscriptionContext.cycle,
      sellingPlanId: subscriptionContext.sellingPlanId ?? null,
    };
  }

  const collectionOverride = productContext
    ? config.collectionOverrides.find((override) =>
        productContext.collectionExternalIds?.some((collectionId) =>
          sameShopifyId("Collection", override.id, collectionId),
        ),
      )
    : undefined;
  if (collectionOverride) {
    return {
      configHash,
      source: "collection",
      sourceId: collectionOverride.id,
      specificity: 2,
      priority: Math.max(
        10,
        1000 - config.collectionOverrides.indexOf(collectionOverride) * 10,
      ),
      ...toMoneyRule({
        rate: rateFor(collectionOverride),
        config,
        accountingCurrency,
      }),
      customerClassification: customerContext.classification,
      matchedSegmentId: isSegmentMember && segment ? segment.id : null,
      subscriptionCycle: subscriptionContext.cycle,
      sellingPlanId: subscriptionContext.sellingPlanId ?? null,
    };
  }

  return {
    configHash,
    source: "default_group",
    sourceId: null,
    specificity: 1,
    priority: 0,
    ...toMoneyRule({ rate: rateFor(), config, accountingCurrency }),
    customerClassification: customerContext.classification,
    matchedSegmentId: isSegmentMember && segment ? segment.id : null,
    subscriptionCycle: subscriptionContext.cycle,
    sellingPlanId: subscriptionContext.sellingPlanId ?? null,
  };
}
