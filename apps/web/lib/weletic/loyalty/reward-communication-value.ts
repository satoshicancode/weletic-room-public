import { minorUnitsToDecimal } from "../money";
import type { RewardRedeemedCommunication } from "./reward-redeemed-communication-contract";

/** Financial snapshot values are minor units, not display-currency amounts. */
export function rewardCommunicationValue(
  reward: RewardRedeemedCommunication["reward"],
  locale: "en" | "ja" | "vi",
) {
  if (reward.type === "free_shipping")
    return { en: "Free shipping", ja: "送料無料", vi: "Miễn phí vận chuyển" }[
      locale
    ];
  if (reward.type === "free_product")
    return { en: "Free product", ja: "無料商品", vi: "Sản phẩm miễn phí" }[
      locale
    ];
  if (reward.type === "percentage_off") {
    if (!reward.value || !/^\d+(?:\.\d+)?$/.test(reward.value))
      throw new Error("Reward communication value unavailable");
    const [whole, fraction = ""] = reward.value.split(".");
    if (
      BigInt(whole) > BigInt(100) ||
      (BigInt(whole) === BigInt(100) && /[1-9]/.test(fraction)) ||
      !/[1-9]/.test(reward.value)
    )
      throw new Error("Reward communication value unavailable");
    return `${reward.value}%`;
  }
  if (!reward.value || !/^\d+(?:\.0+)?$/.test(reward.value))
    throw new Error("Reward communication value unavailable");
  const value = BigInt(reward.value.split(".")[0]);
  if (value <= BigInt(0))
    throw new Error("Reward communication value unavailable");
  return `${minorUnitsToDecimal(value, reward.currency)} ${reward.currency}`;
}
