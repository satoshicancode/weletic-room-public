import type { RewardProps } from "@/lib/types";
import {
  isShopifyRewardActiveAt,
  ShopifyEcommerceRewardConfigSchema,
} from "@/lib/zod/schemas/shopify-ecommerce-reward";

/**
 * Keep generic Dub rewards visible while respecting the lifecycle configured
 * by the dedicated Shopify eCommerce reward editor.
 */
export const isRewardAvailableAt = (
  reward: Pick<RewardProps, "config">,
  at = new Date(),
) => {
  if (
    !reward.config ||
    typeof reward.config !== "object" ||
    Array.isArray(reward.config) ||
    reward.config.type !== "shopify_ecommerce"
  ) {
    return true;
  }

  const parsed = ShopifyEcommerceRewardConfigSchema.safeParse(reward.config);
  return parsed.success && isShopifyRewardActiveAt(parsed.data.activation, at);
};
