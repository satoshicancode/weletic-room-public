import { describe, expect, it } from "vitest";
import { verifyVipCampaignAcknowledgement } from "../../lib/weletic/loyalty/vip-campaign-acknowledgement";
import {
  bonusCampaignFieldsSchema,
  vipCampaignRequestSchema,
  vipTierFieldsSchema,
  type BonusCampaignFields,
  type VipTierFields,
} from "../../lib/weletic/loyalty/vip-campaign-contract";

const tier: VipTierFields = {
  name: "Gold",
  slug: "gold",
  tierOrder: 2,
  minSpendThreshold: "100000",
  minPointsThreshold: "5000",
  pointsMultiplier: 1.5,
  entryBonusPoints: "500",
  gracePeriodDays: 30,
  perks: ["Early access"],
  iconUrl: null,
  color: "#FFD700",
};
const campaign: BonusCampaignFields = {
  name: "Golden week",
  description: null,
  multiplier: 2,
  startAt: "2026-09-10T00:00:00.000Z",
  endAt: "2026-09-17T00:00:00.000Z",
  isActive: true,
  eligibleTierIds: ["wtier_gold1"],
  eligibleSkus: ["SKU-1"],
  eligibleCollectionIds: ["gid://shopify/Collection/123"],
};
const response = {
  storeId: "wstore_a",
  installationGeneration: "generation",
  revision: "b".repeat(64),
  affectedResourceId: "wprog_a",
  capabilities: { configure: true },
  policy: {
    milestoneMode: "amount_spent" as const,
    timeframe: "rolling_12m" as const,
    downgradeGraceDays: 30,
    autoDowngradeEnabled: true,
  },
  tiers: [],
  campaigns: [],
  tierHistory: [],
};

describe("VIP and campaign merchant contract", () => {
  it("preserves the supported integer threshold without float conversion", () => {
    expect(
      vipTierFieldsSchema.parse({
        ...tier,
        minSpendThreshold: "1000000000000000",
      }).minSpendThreshold,
    ).toBe("1000000000000000");
  });

  it.each(["-1", "1.1", "1e3", " 1", "01", "1000000000000001"])(
    "rejects a noncanonical or unsupported threshold %s",
    (minSpendThreshold) => {
      expect(
        vipTierFieldsSchema.safeParse({ ...tier, minSpendThreshold }).success,
      ).toBe(false);
    },
  );

  it("requires ordered, bounded schedules", () => {
    expect(bonusCampaignFieldsSchema.safeParse(campaign).success).toBe(true);
    expect(
      bonusCampaignFieldsSchema.safeParse({
        ...campaign,
        endAt: campaign.startAt,
      }).success,
    ).toBe(false);
    expect(
      bonusCampaignFieldsSchema.safeParse({
        ...campaign,
        endAt: "2026-11-17T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate-store authority and unknown write fields", () => {
    const request = {
      operation: "save_tier",
      input: {
        expectedInstallationGeneration: "generation",
        expectedRevision: "a".repeat(64),
        tierId: null,
        tier,
      },
    };
    expect(vipCampaignRequestSchema.safeParse(request).success).toBe(true);
    expect(
      vipCampaignRequestSchema.safeParse({
        ...request,
        input: { ...request.input, storeId: "other-store" },
      }).success,
    ).toBe(false);
    expect(
      vipCampaignRequestSchema.safeParse({
        ...request,
        input: { ...request.input, expectedRevision: null },
      }).success,
    ).toBe(false);
  });

  it("accepts only canonical tenant-owned tier and Shopify collection IDs", () => {
    expect(
      bonusCampaignFieldsSchema.safeParse({
        ...campaign,
        eligibleTierIds: ["other-tier"],
      }).success,
    ).toBe(false);
    expect(
      bonusCampaignFieldsSchema.safeParse({
        ...campaign,
        eligibleCollectionIds: ["123"],
      }).success,
    ).toBe(false);
  });

  it("rejects policy and retirement acknowledgements for a different write", () => {
    const policyRequest = {
      operation: "save_policy" as const,
      input: {
        expectedInstallationGeneration: "generation",
        expectedRevision: "a".repeat(64),
        policy: { ...response.policy, downgradeGraceDays: 60 },
      },
    };
    expect(() =>
      verifyVipCampaignAcknowledgement(policyRequest, response),
    ).toThrow(/policy acknowledgement/i);

    const retirementRequest = {
      operation: "retire_tier" as const,
      input: {
        expectedInstallationGeneration: "generation",
        expectedRevision: "a".repeat(64),
        tierId: "wtier_gold1",
      },
    };
    expect(() =>
      verifyVipCampaignAcknowledgement(retirementRequest, response),
    ).toThrow(/retirement acknowledgement/i);
  });
});
