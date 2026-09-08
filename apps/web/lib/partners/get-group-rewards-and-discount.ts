import { GroupProps, RewardProps } from "@/lib/types";
import { isRewardAvailableAt } from "@/lib/weletic/commissions/reward-availability";

// Determines the rewards and discount for the partner group
export function getGroupRewardsAndDiscount({
  clickReward,
  saleReward,
  leadReward,
  discount,
}: Pick<GroupProps, "clickReward" | "saleReward" | "leadReward" | "discount">) {
  const rewards = [clickReward, saleReward, leadReward].filter(
    (r): r is RewardProps => r != null && isRewardAvailableAt(r),
  );

  return {
    rewards,
    discount: discount ?? null,
  };
}
