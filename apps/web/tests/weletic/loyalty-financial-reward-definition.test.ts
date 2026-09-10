import {
  createLoyaltyRedemptionProvisioningSnapshot,
  parseLoyaltyRedemptionProvisioningSnapshot,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import {
  createReferralCouponRewardSnapshot,
  parseReferralCouponRewardSnapshotForIdentity,
} from "@/lib/weletic/loyalty/referral-coupon-snapshot";
import {
  isReferralCouponProvisionable,
  isRewardDefinitionProvisionable,
} from "@/lib/weletic/loyalty/rewards";
import { WeleticRewardSalesChannel, WeleticRewardType } from "@prisma/client";
import { describe, expect, it } from "vitest";

function reward(overrides: Record<string, unknown>) {
  return {
    rewardType: WeleticRewardType.amount_off,
    salesChannel: WeleticRewardSalesChannel.online_store,
    discountValue: "500",
    maxDiscountValue: null,
    minOrderAmount: null,
    entitledProductIds: [],
    entitledVariantIds: [],
    entitledCollectionIds: [],
    usageLimit: null,
    usageLimitPerCustomer: 1,
    ...overrides,
  };
}

const referralIdentity = {
  storeId: "store_reward_channel",
  referralId: "wreferral_reward_channel",
  qualificationOrderId: "worder_reward_channel",
  accountId: "waccount_reward_channel",
  rewardDefinitionId: "wreward_reward_channel",
  side: "advocate" as const,
};

function referralReward(overrides: Record<string, unknown> = {}) {
  return {
    id: referralIdentity.rewardDefinitionId,
    name: "$5 referral reward",
    description: null,
    rewardType: WeleticRewardType.amount_off,
    discountValue: "500",
    maxDiscountValue: null,
    minOrderAmount: null,
    appliesToResource: "entire_order",
    entitledCollectionIds: [],
    entitledProductIds: [],
    entitledVariantIds: [],
    combinesWithProductDiscounts: false,
    combinesWithOrderDiscounts: false,
    combinesWithShippingDiscounts: false,
    usageLimit: 1,
    usageLimitPerCustomer: 1,
    expiresInDays: 30,
    ...overrides,
  };
}

function referralSnapshot(overrides: Record<string, unknown> = {}) {
  return createReferralCouponRewardSnapshot({
    identity: referralIdentity,
    reward: referralReward(overrides),
    qualifiedAt: new Date("2026-09-01T00:00:00.000Z"),
    shopCurrency: "USD",
    currencyVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
    shopifyCustomerId: "123",
  });
}

describe("financial and POS reward definitions", () => {
  it.each([WeleticRewardType.gift_card, WeleticRewardType.store_credit])(
    "accepts a positive fixed amount for %s",
    (rewardType) => {
      expect(
        isRewardDefinitionProvisionable(
          reward({ rewardType, discountValue: "2500" }),
        ),
      ).toBe(true);
      expect(
        isRewardDefinitionProvisionable(
          reward({ rewardType, discountValue: null }),
        ),
      ).toBe(false);
    },
  );

  it("supports amount and percentage codes in Shopify POS", () => {
    expect(
      isRewardDefinitionProvisionable(
        reward({
          rewardType: WeleticRewardType.amount_off,
          salesChannel: WeleticRewardSalesChannel.both,
        }),
      ),
    ).toBe(true);
    expect(
      isRewardDefinitionProvisionable(
        reward({
          rewardType: WeleticRewardType.percentage_off,
          discountValue: "15",
          salesChannel: WeleticRewardSalesChannel.pos,
        }),
      ),
    ).toBe(true);
    expect(
      isRewardDefinitionProvisionable(
        reward({
          rewardType: WeleticRewardType.free_shipping,
          salesChannel: WeleticRewardSalesChannel.pos,
        }),
      ),
    ).toBe(false);
  });

  it("keeps referral coupons limited to online-capable discount-code artifacts", () => {
    expect(
      isReferralCouponProvisionable(
        reward({ rewardType: WeleticRewardType.gift_card }),
      ),
    ).toBe(false);
    expect(
      isReferralCouponProvisionable(
        reward({ rewardType: WeleticRewardType.amount_off }),
      ),
    ).toBe(true);
    expect(
      isReferralCouponProvisionable(
        reward({ salesChannel: WeleticRewardSalesChannel.both }),
      ),
    ).toBe(true);
    expect(
      isReferralCouponProvisionable(
        reward({ salesChannel: WeleticRewardSalesChannel.pos }),
      ),
    ).toBe(false);
  });

  it.each(["fixed", "incremental"])(
    "persists immutable %s exchange provenance",
    (exchangeType) => {
      const snapshot = createLoyaltyRedemptionProvisioningSnapshot({
        reward: {
          id: "reward_exchange",
          name: "Reward",
          rewardType: "amount_off",
          exchangeType,
        },
        pointsCost: BigInt(500),
        discountValue: "500",
        expiresInDays: null,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-09-01T00:00:00Z"),
        customerSelectionDigest: "A".repeat(64),
        startsAt: new Date("2026-09-01T00:00:00Z"),
        expiresAt: null,
      });
      expect(
        parseLoyaltyRedemptionProvisioningSnapshot(snapshot).exchangeType,
      ).toBe(exchangeType);
      expect(() =>
        parseLoyaltyRedemptionProvisioningSnapshot({
          ...snapshot,
          exchangeType: exchangeType === "fixed" ? "incremental" : "fixed",
        }),
      ).toThrow();
      const { exchangeType: omitted, ...stripped } = snapshot;
      expect(omitted).toBe(exchangeType);
      expect(() =>
        parseLoyaltyRedemptionProvisioningSnapshot(stripped),
      ).toThrow();
    },
  );

  it("persists immutable financial economics in the redemption snapshot", () => {
    const snapshot = createLoyaltyRedemptionProvisioningSnapshot({
      reward: {
        id: "reward_store_credit",
        name: "$10 store credit",
        description: null,
        rewardType: WeleticRewardType.store_credit,
        salesChannel: WeleticRewardSalesChannel.both,
        discountValue: "1000",
      },
      pointsCost: BigInt(1000),
      discountValue: "1000",
      expiresInDays: null,
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-09-01T00:00:00.000Z"),
      customerSelectionDigest: "A".repeat(64),
      startsAt: new Date("2026-09-01T00:00:00.000Z"),
      expiresAt: null,
    });

    expect(parseLoyaltyRedemptionProvisioningSnapshot(snapshot)).toMatchObject({
      rewardType: "store_credit",
      salesChannel: "both",
      pointsCost: "1000",
      discountValue: "1000",
      shopCurrency: "USD",
    });
    expect(
      parseLoyaltyRedemptionProvisioningSnapshot(snapshot).exchangeType,
    ).toBeUndefined();
  });

  it("keeps standard redemption snapshots without a legacy sales channel parse-compatible", () => {
    const legacySnapshot = {
      version: 1,
      rewardDefinitionId: "reward_legacy_amount",
      name: "$5 discount",
      description: null,
      rewardType: "amount_off",
      pointsCost: "500",
      discountValue: "500",
      maxDiscountValue: null,
      minOrderAmount: null,
      appliesToResource: null,
      entitledCollectionIds: [],
      entitledProductIds: [],
      entitledVariantIds: [],
      combinesWithProductDiscounts: false,
      combinesWithOrderDiscounts: false,
      combinesWithShippingDiscounts: false,
      usageLimit: null,
      usageLimitPerCustomer: null,
      expiresInDays: 30,
      shopCurrency: "USD",
      currencyVerifiedAt: "2026-09-01T00:00:00.000Z",
      customerSelectionDigest: "B".repeat(64),
      startsAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      contentDigest:
        "DA6ACC1A0B803FF36C50845B79C8414EC59739AE18B522A70DCADA4B7054D32D",
    };

    expect(legacySnapshot).not.toHaveProperty("salesChannel");
    expect(
      parseLoyaltyRedemptionProvisioningSnapshot(legacySnapshot),
    ).not.toHaveProperty("salesChannel");
  });

  it("persists the referral coupon sales channel in its immutable snapshot", () => {
    const snapshot = referralSnapshot({
      salesChannel: WeleticRewardSalesChannel.online_store,
    });

    expect(snapshot).toMatchObject({ salesChannel: "online_store" });
    expect(
      parseReferralCouponRewardSnapshotForIdentity(snapshot, referralIdentity),
    ).toMatchObject({ salesChannel: "online_store" });
  });
  it.each(["fixed", "incremental"])(
    "preserves immutable referral %s exchange provenance",
    (exchangeType) => {
      const snapshot = referralSnapshot({ exchangeType });
      expect(
        parseReferralCouponRewardSnapshotForIdentity(snapshot, referralIdentity)
          .exchangeType,
      ).toBe(exchangeType);
      expect(() =>
        parseReferralCouponRewardSnapshotForIdentity(
          {
            ...snapshot,
            exchangeType: exchangeType === "fixed" ? "incremental" : "fixed",
          },
          referralIdentity,
        ),
      ).toThrow();
      const { exchangeType: omitted, ...stripped } = snapshot;
      expect(omitted).toBe(exchangeType);
      expect(() =>
        parseReferralCouponRewardSnapshotForIdentity(
          stripped,
          referralIdentity,
        ),
      ).toThrow();
    },
  );
  it("keeps missing referral exchange unknown and refuses invalid values", () => {
    expect(
      parseReferralCouponRewardSnapshotForIdentity(
        referralSnapshot(),
        referralIdentity,
      ).exchangeType,
    ).toBeUndefined();
    expect(() => referralSnapshot({ exchangeType: "variable" })).toThrow();
    expect(() => referralSnapshot({ exchangeType: null })).toThrow();
  });

  it("keeps referral snapshots without a legacy sales channel parse-compatible", () => {
    const legacySnapshot = {
      version: 1,
      rewardDefinitionId: referralIdentity.rewardDefinitionId,
      name: "$5 referral reward",
      description: null,
      rewardType: "amount_off",
      discountValue: "500",
      maxDiscountValue: null,
      minOrderAmount: null,
      appliesToResource: "entire_order",
      entitledCollectionIds: [],
      entitledProductIds: [],
      entitledVariantIds: [],
      combinesWithProductDiscounts: false,
      combinesWithOrderDiscounts: false,
      combinesWithShippingDiscounts: false,
      usageLimit: 1,
      usageLimitPerCustomer: 1,
      expiresInDays: 30,
      shopCurrency: "USD",
      currencyVerifiedAt: "2026-09-01T00:00:00.000Z",
      customerSelectionDigest: "C".repeat(64),
      startsAt: "2026-09-01T00:00:00.000Z",
      qualifiedAt: "2026-09-01T00:00:00.000Z",
      expiresAt: "2026-10-01T00:00:00.000Z",
      discountCode: "WLR-D53BE71205CA7D18737E1A79",
      ownershipFingerprint: "D53BE71205CA7D18737E1A79",
      provisioningName: "$5 referral reward [WLR:D53BE71205CA7D18737E1A79]",
      expectedTitle:
        "$5 referral reward [WLR:D53BE71205CA7D18737E1A79] (WLR-D53BE71205CA7D18737E1A79)",
      contentDigest:
        "29424292742EF3C65FA7BA005AA8DFF7F9861D16D742AA1C78D2D80D4B689FD8",
    };

    expect(legacySnapshot).not.toHaveProperty("salesChannel");
    expect(
      parseReferralCouponRewardSnapshotForIdentity(
        legacySnapshot,
        referralIdentity,
      ),
    ).not.toHaveProperty("salesChannel");
  });
});
