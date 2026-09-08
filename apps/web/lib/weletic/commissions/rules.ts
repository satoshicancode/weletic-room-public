import { divideAndRoundCommission } from "@/lib/weletic/commissions/commission-math";
import { resolveShopifyEcommerceCommission } from "@/lib/weletic/commissions/shopify-reward";
import {
  Discount,
  Reward,
  WeleticCommissionRule,
  WeleticCommissionScope,
} from "@prisma/client";

export { allocateCommissionProportionally } from "@/lib/weletic/commissions/commission-math";

export function serializeGroupRewardCommission({
  reward,
  currency,
  productContext,
  customerContext,
}: {
  reward: Pick<Reward, "id"> & {
    config?: Reward["config"] | null;
  };
  currency: string;
  productContext?: {
    productId?: string | null;
    productExternalId?: string | null;
    variantId?: string | null;
    variantExternalId?: string | null;
    collectionExternalIds?: string[];
    tags?: string[];
    vendor?: string | null;
    productType?: string | null;
  };
  customerContext?: {
    isNewCustomer?: boolean;
    ordersCount?: number;
    segmentIds?: string[];
    sellingPlanId?: string | null;
    subscriptionCycle?: "not_subscription" | "first" | "recurring";
  };
}) {
  const resolvedShopify = resolveShopifyEcommerceCommission({
    rawConfig: reward.config,
    accountingCurrency: currency,
    productContext,
    customerContext: {
      classification:
        customerContext?.isNewCustomer === true
          ? "new"
          : customerContext?.isNewCustomer === false ||
              (customerContext?.ordersCount != null &&
                customerContext.ordersCount > 1)
            ? "returning"
            : "unknown",
      segmentIds: customerContext?.segmentIds,
    },
    subscriptionContext: {
      sellingPlanId: customerContext?.sellingPlanId,
      cycle: customerContext?.subscriptionCycle ?? "not_subscription",
    },
  });

  if (!resolvedShopify) return null;

  return {
    ruleId: reward.id,
    source: resolvedShopify.source,
    type: resolvedShopify.type,
    basisPoints: resolvedShopify.basisPoints,
    fixedAmount: resolvedShopify.fixedAmount?.toString() ?? null,
    currency,
    minOrderAmount: null,
  };
}

export interface ResolvedCustomerDiscount {
  type: "percentage" | "flat";
  amount: number;
  formatted: string;
  couponCode: string | null;
}

export function resolveProductCustomerDiscount({
  discount,
  partnerCode,
  currency,
  productContext,
}: {
  discount:
    | (Pick<Discount, "amount" | "type" | "couponId"> & {
        description?: string | null;
      })
    | null
    | undefined;
  partnerCode?: string | null;
  currency?: string;
  productContext: {
    productId: string;
    productExternalId: string;
    collectionExternalIds: string[];
  };
}): ResolvedCustomerDiscount | null {
  if (!discount || discount.amount == null || discount.amount <= 0) {
    return null;
  }

  // Check product/collection restrictions if specified in description
  if (discount.description) {
    try {
      const parsed = JSON.parse(discount.description);
      if (parsed && typeof parsed === "object") {
        const productIds: string[] = Array.isArray(parsed.productIds)
          ? parsed.productIds
          : [];
        const collectionIds: string[] = Array.isArray(parsed.collectionIds)
          ? parsed.collectionIds
          : [];

        if (productIds.length > 0) {
          const matchesProduct = productIds.some(
            (id) =>
              id === productContext.productId ||
              id === productContext.productExternalId ||
              id.replace("gid://shopify/Product/", "") ===
                productContext.productExternalId.replace(
                  "gid://shopify/Product/",
                  "",
                ),
          );
          if (!matchesProduct) return null;
        }

        if (collectionIds.length > 0) {
          const matchesCollection = collectionIds.some((cid) =>
            productContext.collectionExternalIds.some(
              (pCid) =>
                pCid === cid ||
                pCid.replace("gid://shopify/Collection/", "") ===
                  cid.replace("gid://shopify/Collection/", ""),
            ),
          );
          if (!matchesCollection) return null;
        }
      }
    } catch {
      // Ignore JSON parse error
    }
  }

  const couponCode = partnerCode || discount.couponId || null;
  const formatted =
    discount.type === "percentage"
      ? `-${discount.amount}%`
      : `-${discount.amount} ${currency || ""}`.trim();

  return {
    type: discount.type === "flat" ? "flat" : "percentage",
    amount: discount.amount,
    formatted,
    couponCode,
  };
}

export interface CommissionRuleContext {
  programId: string;
  partnerId?: string | null;
  productId?: string | null;
  productExternalId?: string | null;
  variantId?: string | null;
  variantExternalId?: string | null;
  collectionExternalIds?: string[];
  productTags?: string[];
  promotionCodes?: string[];
  accountingCurrency: string;
  commissionableAmount: bigint;
  orderAmount?: bigint;
  skipOrderThreshold?: boolean;
  quantity: number;
  occurredAt: Date;
}

const specificity: Record<WeleticCommissionScope, number> = {
  program: 0,
  partner: 1,
  collection: 2,
  tag: 2,
  product: 3,
  variant: 4,
  promotion: 5,
};

function matchesRule(
  rule: WeleticCommissionRule,
  context: CommissionRuleContext,
) {
  if (rule.programId !== context.programId) return false;
  if (rule.effectiveAt > context.occurredAt) return false;
  if (rule.expiresAt && rule.expiresAt <= context.occurredAt) return false;
  if (
    !context.skipOrderThreshold &&
    rule.minOrderAmount !== null &&
    (context.orderAmount ?? context.commissionableAmount) < rule.minOrderAmount
  ) {
    return false;
  }

  switch (rule.scope) {
    case "program":
      return true;
    case "partner":
      return rule.partnerId === null || rule.partnerId === context.partnerId;
    case "collection":
      return Boolean(
        rule.collectionExternalId &&
          context.collectionExternalIds?.some(
            (id) =>
              id === rule.collectionExternalId ||
              id === `gid://shopify/Collection/${rule.collectionExternalId}` ||
              rule.collectionExternalId === `gid://shopify/Collection/${id}`,
          ),
      );
    case "tag":
      return Boolean(
        rule.tag &&
          context.productTags?.some(
            (t) => t.trim().toLowerCase() === rule.tag?.trim().toLowerCase(),
          ),
      );
    case "product":
      return Boolean(
        rule.productId &&
          (rule.productId === context.productId ||
            rule.productId === context.productExternalId ||
            (context.productId &&
              (rule.productId ===
                `gid://shopify/Product/${context.productId}` ||
                `gid://shopify/Product/${rule.productId}` ===
                  context.productId)) ||
            (context.productExternalId &&
              (rule.productId === context.productExternalId ||
                `gid://shopify/Product/${rule.productId}` ===
                  context.productExternalId))),
      );
    case "variant":
      return Boolean(
        rule.variantId &&
          (rule.variantId === context.variantId ||
            rule.variantId === context.variantExternalId ||
            (context.variantId &&
              (rule.variantId ===
                `gid://shopify/ProductVariant/${context.variantId}` ||
                `gid://shopify/ProductVariant/${rule.variantId}` ===
                  context.variantId)) ||
            (context.variantExternalId &&
              (rule.variantId === context.variantExternalId ||
                `gid://shopify/ProductVariant/${rule.variantId}` ===
                  context.variantExternalId))),
      );
    case "promotion":
      return Boolean(
        rule.promotionCode &&
          context.promotionCodes?.some(
            (code) => code.toLowerCase() === rule.promotionCode?.toLowerCase(),
          ),
      );
  }
}

export function selectCommissionRule(
  rules: WeleticCommissionRule[],
  context: CommissionRuleContext,
) {
  return rules
    .filter((rule) => matchesRule(rule, context))
    .sort(
      (left, right) =>
        specificity[right.scope] - specificity[left.scope] ||
        right.priority - left.priority ||
        right.version - left.version ||
        right.createdAt.getTime() - left.createdAt.getTime(),
    )[0];
}

export function calculateCommission({
  rule,
  context,
}: {
  rule: WeleticCommissionRule;
  context: CommissionRuleContext;
}) {
  let earnings: bigint;
  if (rule.ruleType === "percentage") {
    if (rule.basisPoints === null) {
      throw new Error(`Percentage rule ${rule.id} has no basis points`);
    }
    earnings = divideAndRoundCommission(
      context.commissionableAmount * BigInt(rule.basisPoints),
      BigInt(10_000),
    );
  } else {
    if (rule.fixedAmount === null) {
      throw new Error(`Fixed rule ${rule.id} has no fixed amount`);
    }
    if (rule.currency !== context.accountingCurrency) {
      throw new Error(
        `Fixed rule currency ${rule.currency} does not match ${context.accountingCurrency}`,
      );
    }
    earnings =
      rule.fixedAmount *
      BigInt(rule.fixedAmountMode === "item" ? context.quantity : 1);
  }

  if (
    rule.maxCommissionAmount !== null &&
    earnings > rule.maxCommissionAmount
  ) {
    earnings = rule.maxCommissionAmount;
  }
  return earnings < BigInt(0) ? BigInt(0) : earnings;
}
