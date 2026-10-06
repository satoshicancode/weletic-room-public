import { getRewardAmount } from "@/lib/partners/get-reward-amount";
import { RewardProps } from "@/lib/types";

/* 
  Calculate the commission earned for a sale
*/
export const calculateSaleEarnings = ({
  reward,
  sale,
}: {
  reward: Pick<RewardProps, "type" | "amountInCents" | "amountInPercentage">;
  sale: { quantity: number; amount: number | bigint };
}) => {
  if (!reward) {
    return 0;
  }

  const amount = getRewardAmount(reward);

  if (reward.type === "flat") {
    return sale.quantity * amount;
  } else if (reward.type === "percentage") {
    return Number(sale.amount) * (amount / 100);
  }

  return 0;
};
