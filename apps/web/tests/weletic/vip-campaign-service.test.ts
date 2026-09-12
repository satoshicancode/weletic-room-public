import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mutateVipCampaignStateInTransaction,
  readVipCampaignStateInTransaction,
} from "../../lib/weletic/loyalty/vip-campaign-service";

const mocks = vi.hoisted(() => ({
  programFind: vi.fn(),
  programUpsert: vi.fn(),
  programUpdate: vi.fn(),
  historyFind: vi.fn(),
  tierCreate: vi.fn(),
  tierUpdate: vi.fn(),
  accountCount: vi.fn(),
  campaignCreate: vi.fn(),
  campaignUpdate: vi.fn(),
  publish: vi.fn(),
}));
vi.mock("../../lib/weletic/loyalty/earn-policy-revision", () => ({
  publishLoyaltyEarnPolicyRevision: mocks.publish,
}));

const tx = {
  weleticLoyaltyProgram: {
    findUnique: mocks.programFind,
    upsert: mocks.programUpsert,
    update: mocks.programUpdate,
  },
  weleticLoyaltyTierHistory: { findMany: mocks.historyFind },
  weleticLoyaltyTier: {
    create: mocks.tierCreate,
    update: mocks.tierUpdate,
  },
  weleticLoyaltyAccount: { count: mocks.accountCount },
  weleticLoyaltyBonusCampaign: {
    create: mocks.campaignCreate,
    update: mocks.campaignUpdate,
  },
} as unknown as Prisma.TransactionClient;

const tier = {
  id: "wtier_gold1",
  name: "Gold",
  slug: "gold",
  tierOrder: 1,
  minSpendThreshold: BigInt(0),
  minPointsThreshold: BigInt(0),
  pointsMultiplier: new Prisma.Decimal("1.5"),
  entryBonusPoints: BigInt(100),
  gracePeriodDays: null,
  perks: ["Early access"],
  iconUrl: null,
  color: "#FFD700",
  deletedAt: null,
};
const runningCampaign = {
  id: "wcamp_running1",
  name: "Double points",
  description: null,
  multiplier: new Prisma.Decimal("2"),
  startAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
  endAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  isActive: true,
  eligibleTierIds: [],
  eligibleSkus: [],
  eligibleCollectionIds: [],
};
const program = {
  id: "wprog_a",
  vipMilestoneMode: "amount_spent",
  vipTimeframe: "rolling_12m",
  vipDowngradeGraceDays: 30,
  vipAutoDowngradeEnabled: true,
  tiers: [tier],
  bonusCampaigns: [runningCampaign],
};
const context = {
  tx,
  storeId: "wstore_a",
  installationGeneration: "generation-a",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.programFind.mockResolvedValue(program);
  mocks.programUpsert.mockResolvedValue(program);
  mocks.programUpdate.mockResolvedValue(program);
  mocks.historyFind.mockResolvedValue([]);
  mocks.tierCreate.mockResolvedValue({ ...tier, id: "wtier_new1" });
  mocks.tierUpdate.mockResolvedValue(tier);
  mocks.accountCount.mockResolvedValue(0);
  mocks.campaignCreate.mockResolvedValue({
    ...runningCampaign,
    id: "wcamp_new1",
  });
  mocks.campaignUpdate.mockResolvedValue(runningCampaign);
  mocks.publish.mockResolvedValue(undefined);
});

async function fence() {
  return {
    expectedInstallationGeneration: context.installationGeneration,
    expectedRevision: (
      await readVipCampaignStateInTransaction(tx, context.storeId)
    ).revision,
  };
}

describe("transaction-local VIP and campaign service", () => {
  it("projects no-tier restoration without looking up a fabricated tier", async () => {
    mocks.historyFind.mockResolvedValue([
      {
        id: "wtier_history1",
        fromTierId: tier.id,
        toTierId: null,
        changeReason: "manual_override",
        effectiveAt: new Date("2026-09-09T00:00:00.000Z"),
      },
    ]);
    const view = await readVipCampaignStateInTransaction(tx, context.storeId);
    expect(view.tierHistory[0]).toMatchObject({
      fromTierName: "Gold",
      toTierId: null,
      toTierName: null,
    });
  });
  it("keeps empty reads side-effect free and binds revisions to the store", async () => {
    mocks.programFind.mockResolvedValue(null);
    const first = await readVipCampaignStateInTransaction(tx, "wstore_a");
    const second = await readVipCampaignStateInTransaction(tx, "wstore_b");
    expect(first.tiers).toEqual([]);
    expect(first.campaigns).toEqual([]);
    expect(first.revision).not.toBe(second.revision);
    expect(mocks.programUpsert).not.toHaveBeenCalled();
  });

  it("rejects installation changes before reading or writing state", async () => {
    await expect(
      mutateVipCampaignStateInTransaction({
        ...context,
        request: {
          operation: "save_policy",
          input: {
            expectedInstallationGeneration: "old-generation",
            expectedRevision: "a".repeat(64),
            policy: {
              milestoneMode: "amount_spent",
              timeframe: "rolling_12m",
              downgradeGraceDays: 30,
              autoDowngradeEnabled: true,
            },
          },
        },
      }),
    ).rejects.toThrow();
    expect(mocks.programFind).not.toHaveBeenCalled();
    expect(mocks.programUpdate).not.toHaveBeenCalled();
  });

  it("rejects stale revisions and cross-store resource IDs", async () => {
    const input = {
      expectedInstallationGeneration: context.installationGeneration,
      expectedRevision: "f".repeat(64),
      tierId: "wtier_other1",
      tier: {
        name: tier.name,
        slug: tier.slug,
        tierOrder: tier.tierOrder,
        minSpendThreshold: tier.minSpendThreshold.toString(),
        minPointsThreshold: tier.minPointsThreshold.toString(),
        pointsMultiplier: Number(tier.pointsMultiplier),
        entryBonusPoints: tier.entryBonusPoints.toString(),
        gracePeriodDays: tier.gracePeriodDays,
        perks: tier.perks,
        iconUrl: tier.iconUrl,
        color: tier.color,
      },
    };
    await expect(
      mutateVipCampaignStateInTransaction({
        ...context,
        request: { operation: "save_tier", input },
      }),
    ).rejects.toThrow();
    await expect(
      mutateVipCampaignStateInTransaction({
        ...context,
        request: {
          operation: "save_tier",
          input: { ...input, ...(await fence()) },
        },
      }),
    ).rejects.toThrow();
    expect(mocks.tierUpdate).not.toHaveBeenCalled();
  });

  it("rejects non-increasing tier hierarchy", async () => {
    await expect(
      mutateVipCampaignStateInTransaction({
        ...context,
        request: {
          operation: "save_tier",
          input: {
            ...(await fence()),
            tierId: null,
            tier: {
              name: "Silver",
              slug: "silver",
              tierOrder: 2,
              minSpendThreshold: "0",
              minPointsThreshold: "100",
              pointsMultiplier: 1.25,
              entryBonusPoints: "0",
              gracePeriodDays: null,
              perks: [],
              iconUrl: null,
              color: null,
            },
          },
        },
      }),
    ).rejects.toThrow();
    expect(mocks.tierCreate).not.toHaveBeenCalled();
  });

  it("keeps running campaign economics immutable while allowing containment", async () => {
    const state = await readVipCampaignStateInTransaction(tx, context.storeId);
    const current = state.campaigns[0].fields;
    await expect(
      mutateVipCampaignStateInTransaction({
        ...context,
        request: {
          operation: "save_campaign",
          input: {
            ...(await fence()),
            campaignId: runningCampaign.id,
            campaign: { ...current, multiplier: 3 },
          },
        },
      }),
    ).rejects.toThrow(/multiplier/i);
    await mutateVipCampaignStateInTransaction({
      ...context,
      request: {
        operation: "save_campaign",
        input: {
          ...(await fence()),
          campaignId: runningCampaign.id,
          campaign: { ...current, isActive: false },
        },
      },
    });
    expect(mocks.campaignUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
});
