import { prisma } from "@/lib/prisma";
import { reserveCheckoutPoints } from "@/lib/weletic/loyalty/checkout";
import { redeemReward } from "@/lib/weletic/loyalty/rewards";
import { WeleticRewardStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopper: { findUnique: vi.fn() },
    weleticRewardDefinition: { findUnique: vi.fn() },
  },
}));

vi.mock("@/lib/weletic/loyalty/rewards", () => ({
  redeemReward: vi.fn(),
  cancelRewardRedemption: vi.fn(),
}));

describe("checkout loyalty minor-unit contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(redeemReward).mockResolvedValue({
      redemption: {
        id: "redemption_1",
        pointsSpent: BigInt(100),
        expiresAt: new Date("2026-08-28T12:00:00.000Z"),
      },
      discountCode: "WELETIC-TEST",
    } as any);
  });

  it.each([
    { currency: "USD", discountMinor: "500" },
    { currency: "JPY", discountMinor: "500" },
    { currency: "KWD", discountMinor: "5001" },
  ])(
    "preserves canonical $currency minor units during checkout reservation",
    async ({ currency, discountMinor }) => {
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
        loyaltyAccount: { id: "account_1" },
        store: {
          shopCurrency: currency,
          shopDomain: "store.myshopify.com",
        },
      } as any);
      vi.mocked(
        prisma.weleticRewardDefinition.findUnique,
      ).mockResolvedValueOnce({
        id: "reward_incremental",
        storeId: "store_1",
        status: WeleticRewardStatus.active,
        exchangeType: "incremental",
        rewardType: "amount_off",
        pointsCost: BigInt(100),
        minPointsCost: BigInt(100),
        maxPointsCost: BigInt(100),
        pointsStep: BigInt(100),
        discountValue: discountMinor,
        maxDiscountValue: null,
      } as any);

      const result = await reserveCheckoutPoints({
        storeId: "store_1",
        shopifyCustomerId: "customer_1",
        rewardDefinitionId: "reward_incremental",
        pointsRequested: BigInt(100),
        checkoutToken: `checkout-${currency}`,
        orderSubtotalMinor: BigInt(100_000),
      });

      expect(result.discountAmountMinor).toBe(discountMinor);
      expect(result.currency).toBe(currency);
      expect(redeemReward).toHaveBeenCalledWith(
        expect.objectContaining({ discountValueOverride: discountMinor }),
      );
    },
  );

  it("rejects a fractional minor-unit reward before provisioning", async () => {
    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
      loyaltyAccount: { id: "account_1" },
      store: { shopCurrency: "USD", shopDomain: "store.myshopify.com" },
    } as any);
    vi.mocked(prisma.weleticRewardDefinition.findUnique).mockResolvedValueOnce({
      id: "reward_fractional",
      storeId: "store_1",
      status: WeleticRewardStatus.active,
      exchangeType: "incremental",
      rewardType: "amount_off",
      pointsCost: BigInt(100),
      minPointsCost: BigInt(100),
      maxPointsCost: BigInt(100),
      pointsStep: BigInt(100),
      discountValue: "5.5",
      maxDiscountValue: null,
    } as any);

    await expect(
      reserveCheckoutPoints({
        storeId: "store_1",
        shopifyCustomerId: "customer_1",
        rewardDefinitionId: "reward_fractional",
        pointsRequested: BigInt(100),
        checkoutToken: "checkout-fractional",
      }),
    ).rejects.toThrow("integer number of minor currency units");
    expect(redeemReward).not.toHaveBeenCalled();
  });
});
