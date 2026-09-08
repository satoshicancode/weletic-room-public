import {
  ShopperRewardProvisionPayloadSchema,
  VoucherPrivacyCleanupPayloadSchema,
} from "@/lib/weletic/loyalty/outbox";
import {
  createLoyaltyDiscountProvisioningIdentity,
  getLoyaltyDiscountOwnershipFingerprint,
  getPersistedLoyaltyDiscountProvisioningIdentity,
  mergeLoyaltyDiscountOwnershipMetadata,
} from "@/lib/weletic/loyalty/redemption-discount-identity";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const legacy = {
  storeId: "store",
  redemptionId: "redemption",
  accountId: "account",
  rewardDefinitionId: "reward",
  discountCode: "wl-code",
};
const direct = {
  storeId: "store",
  redemptionId: "redemption",
  ownerKind: "shopper" as const,
  shopperId: "shopper",
  fulfillmentSource: "review_incentive_v1",
  fulfillmentReference: "claim",
  rewardDefinitionId: "reward",
  discountCode: "wl-code",
};

describe("shared coupon ownership compatibility", () => {
  it("accepts legacy and shopper cleanup IDs but rejects mixed owners and personal data", () => {
    const ids = { cleanupId: "cleanup", redemptionId: "redemption" };
    for (const owner of [
      { accountId: "account" },
      { ownerKind: "shopper", shopperId: "shopper" },
    ]) {
      expect(
        VoucherPrivacyCleanupPayloadSchema.safeParse({ ...ids, ...owner })
          .success,
      ).toBe(true);
      expect(
        VoucherPrivacyCleanupPayloadSchema.safeParse({
          ...ids,
          ...owner,
          email: "private@example.test",
        }).success,
      ).toBe(false);
    }
    for (const owner of [
      { accountId: null },
      { shopperId: "shopper" },
      { ownerKind: "shopper", shopperId: "shopper", accountId: "account" },
    ])
      expect(
        VoucherPrivacyCleanupPayloadSchema.safeParse({ ...ids, ...owner })
          .success,
      ).toBe(false);
  });
  it("preserves historical account fingerprints and identity version exactly", () => {
    const original = createHash("sha256")
      .update(
        JSON.stringify(["store", "redemption", "account", "reward", "WL-CODE"]),
      )
      .digest("hex")
      .slice(0, 24)
      .toUpperCase();
    expect(getLoyaltyDiscountOwnershipFingerprint(legacy)).toBe(original);
    expect(
      createLoyaltyDiscountProvisioningIdentity({
        identity: legacy,
        rewardName: "Reward",
      }),
    ).toMatchObject({ version: 1, fingerprint: original });
  });
  it("binds shopper ownership to its store, recipient, source and exact claim", () => {
    const fingerprint = getLoyaltyDiscountOwnershipFingerprint(direct);
    expect(fingerprint).not.toBe(
      getLoyaltyDiscountOwnershipFingerprint(legacy),
    );
    for (const patch of [
      { storeId: "other" },
      { shopperId: "other" },
      { fulfillmentSource: "other" },
      { fulfillmentReference: "other" },
    ])
      expect(
        getLoyaltyDiscountOwnershipFingerprint({ ...direct, ...patch }),
      ).not.toBe(fingerprint);
  });
  it("replays a v2 ownership snapshot only for the same shopper claim", () => {
    const ownership = createLoyaltyDiscountProvisioningIdentity({
      identity: direct,
      rewardName: "Reward",
    });
    const metadata = mergeLoyaltyDiscountOwnershipMetadata({
      ownership,
      metadata: { rewardSnapshot: { name: "Reward" } },
    });
    expect(ownership.version).toBe(2);
    expect(
      getPersistedLoyaltyDiscountProvisioningIdentity({
        identity: direct,
        metadata,
      }),
    ).toEqual(ownership);
    expect(() =>
      getPersistedLoyaltyDiscountProvisioningIdentity({
        identity: legacy,
        metadata,
      }),
    ).toThrow("ownership metadata");
  });
  it("requires generation-bound ID-only jobs without a fabricated account", () => {
    const payload = {
      redemptionId: "redemption",
      claimId: "claim",
      installationGeneration: "g1",
    };
    expect(ShopperRewardProvisionPayloadSchema.safeParse(payload).success).toBe(
      true,
    );
    expect(
      ShopperRewardProvisionPayloadSchema.safeParse({
        ...payload,
        accountId: "account",
      }).success,
    ).toBe(false);
    expect(
      ShopperRewardProvisionPayloadSchema.safeParse({
        ...payload,
        installationGeneration: null,
      }).success,
    ).toBe(false);
  });
});
