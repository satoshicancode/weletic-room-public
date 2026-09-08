import { prisma } from "@/lib/prisma";
import { Prisma, WeleticRewardStatus } from "@prisma/client";
import { createHash } from "node:crypto";
import { cancelRewardRedemption, redeemReward } from "./rewards";

const CHECKOUT_RESERVATION_TTL_MS = 15 * 60 * 1000;

export async function reserveCheckoutPoints(params: {
  storeId: string;
  shopifyCustomerId: string;
  rewardDefinitionId: string;
  pointsRequested: bigint;
  checkoutToken: string;
  orderSubtotalMinor?: bigint;
}) {
  const shopper = await prisma.weleticShopper.findUnique({
    where: {
      storeId_shopifyCustomerId: {
        storeId: params.storeId,
        shopifyCustomerId: params.shopifyCustomerId,
      },
    },
    include: {
      loyaltyAccount: true,
      store: { select: { shopCurrency: true, shopDomain: true } },
    },
  });
  if (!shopper?.loyaltyAccount) {
    throw new Error("Customer loyalty account not found.");
  }

  const reward = await prisma.weleticRewardDefinition.findUnique({
    where: { id: params.rewardDefinitionId },
  });
  if (
    !reward ||
    reward.storeId !== params.storeId ||
    reward.status !== WeleticRewardStatus.active ||
    reward.exchangeType !== "incremental" ||
    reward.rewardType !== "amount_off" ||
    !reward.pointsStep ||
    !reward.discountValue
  ) {
    throw new Error("Incremental checkout reward is not available.");
  }

  const minPoints = reward.minPointsCost ?? reward.pointsCost;
  if (
    params.pointsRequested < minPoints ||
    (reward.maxPointsCost !== null &&
      params.pointsRequested > reward.maxPointsCost) ||
    params.pointsRequested % reward.pointsStep !== BigInt(0)
  ) {
    throw new Error(
      "Requested points do not satisfy the reward step or limits.",
    );
  }

  const steps = params.pointsRequested / reward.pointsStep;
  let discountValue = new Prisma.Decimal(reward.discountValue).mul(
    steps.toString(),
  );
  if (
    reward.maxDiscountValue &&
    discountValue.greaterThan(reward.maxDiscountValue)
  ) {
    discountValue = new Prisma.Decimal(reward.maxDiscountValue);
  }
  if (!discountValue.greaterThan(0)) {
    throw new Error("Calculated checkout discount must be greater than zero.");
  }

  const normalizedDiscountMinor = discountValue.toFixed();
  if (!/^\d+$/.test(normalizedDiscountMinor)) {
    throw new Error(
      "Calculated checkout discount must be an integer number of minor currency units.",
    );
  }
  const discountAmountMinor = BigInt(normalizedDiscountMinor);
  if (
    params.orderSubtotalMinor !== undefined &&
    discountAmountMinor > params.orderSubtotalMinor
  ) {
    throw new Error("Requested discount exceeds the current order subtotal.");
  }

  const checkoutDigest = createHash("sha256")
    .update(params.checkoutToken)
    .digest("hex");
  const expiresAt = new Date(Date.now() + CHECKOUT_RESERVATION_TTL_MS);
  const result = await redeemReward({
    storeId: params.storeId,
    accountId: shopper.loyaltyAccount.id,
    rewardDefinitionId: reward.id,
    pointsCostOverride: params.pointsRequested,
    discountValueOverride: discountValue.toFixed(),
    idempotencyKey: `checkout:${checkoutDigest}`,
    expiresAt,
  });

  return {
    reservationId: result.redemption.id,
    discountCode: result.discountCode,
    pointsLocked: result.redemption.pointsSpent.toString(),
    discountAmountMinor: discountAmountMinor.toString(),
    currency: shopper.store.shopCurrency,
    expiresAt: result.redemption.expiresAt,
  };
}

export async function releaseCheckoutPoints(params: {
  storeId: string;
  shopifyCustomerId: string;
  reservationId: string;
}) {
  const shopper = await prisma.weleticShopper.findUnique({
    where: {
      storeId_shopifyCustomerId: {
        storeId: params.storeId,
        shopifyCustomerId: params.shopifyCustomerId,
      },
    },
    include: { loyaltyAccount: true },
  });
  if (!shopper?.loyaltyAccount) {
    throw new Error("Customer loyalty account not found.");
  }

  const redemption = await prisma.weleticRewardRedemption.findUnique({
    where: { id: params.reservationId },
  });
  if (
    !redemption ||
    redemption.storeId !== params.storeId ||
    redemption.accountId !== shopper.loyaltyAccount.id
  ) {
    throw new Error("Checkout reservation not found.");
  }

  const result = await cancelRewardRedemption({
    storeId: params.storeId,
    redemptionId: redemption.id,
    reason: "Checkout discount was removed before order completion",
  });

  return {
    released: true,
    reservationId: result.redemption.id,
    pointsRestored: result.redemption.pointsSpent.toString(),
    deactivationPending: result.deactivationPending,
  };
}
