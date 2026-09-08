import { constructDiscountAmount } from "@/lib/api/sales/construct-discount-amount";
import {
  ShopifyDiscountConfig,
  shopifyDiscountConfigSchema,
} from "@/lib/zod/schemas/discount";
import { pluralize } from "@dub/utils";

const DEFAULT_SHOPIFY_DISCOUNT_CONFIG: ShopifyDiscountConfig = {
  type: "amount_off_order",
  productIds: [],
  collectionIds: [],
};

export function getShopifyDiscountConfig({
  config,
  description,
}: {
  config?: ShopifyDiscountConfig | null;
  description?: string | null;
}): ShopifyDiscountConfig {
  const directConfig = shopifyDiscountConfigSchema.safeParse(config);

  if (directConfig.success) {
    return directConfig.data;
  }

  if (description) {
    try {
      const parsedDescription = shopifyDiscountConfigSchema.safeParse(
        JSON.parse(description),
      );

      if (parsedDescription.success) {
        return parsedDescription.data;
      }
    } catch {}
  }

  return {
    ...DEFAULT_SHOPIFY_DISCOUNT_CONFIG,
    productIds: [],
    collectionIds: [],
  };
}

export function getShopifyCustomerDiscountSummary({
  amount,
  type,
  maxDuration,
  config,
}: {
  amount: number;
  type: "flat" | "percentage";
  maxDuration: number | null;
  config: ShopifyDiscountConfig;
}): {
  benefit: string;
  scope: string;
} {
  const duration = getDurationPhrase(maxDuration);

  if (config.type === "free_shipping") {
    return {
      benefit: `Customers get free shipping ${duration}.`,
      scope:
        "Applies to eligible orders and shipping rates configured in Shopify.",
    };
  }

  if (config.type === "bxgy") {
    const buyQuantity = config.bxgy?.buyQuantity ?? 1;
    const getQuantity = config.bxgy?.getQuantity ?? 1;
    const discountValue = config.bxgy?.discountValue ?? 100;
    const amountReward =
      config.bxgy?.discountType === "amount"
        ? constructDiscountAmount({
            amount: discountValue * 100,
            type: "flat",
          })
        : null;
    const rewardDescription = amountReward
      ? `${amountReward} off ${getQuantity} ${pluralize("item", getQuantity)}`
      : `${getQuantity} ${pluralize("item", getQuantity)} ${
          discountValue === 100 ? "free" : `${discountValue}% off`
        }`;

    return {
      benefit: `Customers get ${rewardDescription} after buying ${buyQuantity} qualifying ${pluralize("item", buyQuantity)} ${duration}.`,
      scope: "Applies to qualifying and reward items configured in Shopify.",
    };
  }

  const discountAmount = constructDiscountAmount({ amount, type });

  if (config.type === "amount_off_products") {
    return {
      benefit: `Customers get ${discountAmount} off eligible products ${duration}.`,
      scope: getSelectedScope(config),
    };
  }

  return {
    benefit: `Customers get ${discountAmount} off the entire order ${duration}.`,
    scope: "Applies to all products in the order.",
  };
}

function getDurationPhrase(maxDuration: number | null): string {
  if (maxDuration === null) {
    return "for their lifetime";
  }

  if (maxDuration === 0) {
    return "on their first purchase";
  }

  return `for ${maxDuration} ${pluralize("month", maxDuration)}`;
}

function getSelectedScope(config: ShopifyDiscountConfig): string {
  const productCount = config.productIds.length;
  const collectionCount = config.collectionIds.length;
  const selectedScopes = [
    productCount > 0
      ? `${productCount} selected ${pluralize("product", productCount)}`
      : null,
    collectionCount > 0
      ? `${collectionCount} selected ${pluralize("collection", collectionCount)}`
      : null,
  ].filter(Boolean);

  return selectedScopes.length > 0
    ? `Applies to ${selectedScopes.join(" and ")}.`
    : "Applies to eligible products configured in Shopify.";
}
