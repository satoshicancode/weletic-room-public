import { createHash } from "node:crypto";

/** Existing economic identity; preserve this encoding for issued coupons. */
export function getReferralCouponIdempotencyKey({
  referralId,
  qualificationOrderId,
  side,
}: {
  referralId: string;
  qualificationOrderId: string;
  side: "advocate" | "referee";
}) {
  const digest = createHash("sha256")
    .update(`${referralId}:${qualificationOrderId}:${side}`)
    .digest("hex")
    .slice(0, 24);
  return `referral_coupon:${digest}`;
}
