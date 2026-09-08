import { prisma } from "@/lib/prisma";
import { listRewardDefinitions } from "@/lib/weletic/loyalty/rewards";
import { resolveShopifyStoreByDomain } from "@/lib/weletic/shopify/store-resolver";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../app/api/internal/shopify/loyalty/program/route";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const PROGRAM_URL =
  "https://app.example.test/api/internal/shopify/loyalty/program?shop=n0pvef-cs.myshopify.com";

function rewardDefinition(overrides: Record<string, unknown> = {}) {
  return {
    id: "reward_1",
    storeId: "store_1",
    name: "Welcome ¥500 off",
    description: "First qualifying order",
    rewardType: "amount_off",
    salesChannel: "online_store",
    exchangeType: "fixed",
    pointsCost: BigInt(500),
    pointsStep: null,
    minPointsCost: null,
    maxPointsCost: null,
    discountValue: "500",
    maxDiscountValue: null,
    minOrderAmount: "1000",
    appliesToResource: "entire_order",
    entitledCollectionIds: [],
    entitledProductIds: [],
    entitledVariantIds: [],
    combinesWithProductDiscounts: false,
    combinesWithOrderDiscounts: false,
    combinesWithShippingDiscounts: false,
    usageLimit: null,
    usageLimitPerCustomer: 1,
    expiresInDays: 30,
    shopifyPriceRuleId: "gid://shopify/PriceRule/private",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

function referralRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "ref_1",
    isActive: true,
    advocateRewardKind: "points",
    advocatePointsReward: BigInt(500),
    advocateRewardDefinitionId: null,
    refereeRewardKind: "coupon",
    refereePointsReward: BigInt(0),
    refereeRewardDefinitionId: "reward_1",
    minQualifyingOrderSubtotal: { toString: () => "1000" },
    ...overrides,
  };
}

async function getProgramPayload() {
  const response = await GET(new Request(PROGRAM_URL));
  expect(response.status).toBe(200);
  return response.json();
}

vi.mock("server-only", () => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: { findUnique: vi.fn() },
    weleticLoyaltyProgram: { findUnique: vi.fn() },
    weleticLoyaltyTier: { findMany: vi.fn() },
    weleticLoyaltyEarningRule: { findMany: vi.fn() },
    weleticLoyaltyReferralRule: { findFirst: vi.fn() },
  },
}));

vi.mock("@/lib/weletic/loyalty/rewards", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/weletic/loyalty/rewards")
  >("@/lib/weletic/loyalty/rewards");
  return { ...actual, listRewardDefinitions: vi.fn() };
});

vi.mock("@/lib/weletic/shopify/service-auth", () => ({
  readWeleticShopifyRequestBody: vi.fn(async () => ""),
  verifyWeleticShopifyRequest: vi.fn(() => true),
}));

vi.mock("@/lib/weletic/shopify/store-resolver", () => ({
  resolveShopifyStoreByDomain: vi.fn(),
}));

describe("public Shopify loyalty program contract", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    vi.mocked(resolveShopifyStoreByDomain).mockResolvedValue({
      storeId: "store_1",
    } as any);
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      id: "store_1",
      shopCurrency: "JPY",
    } as any);
    vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue({
      id: "wprog_private",
      storeId: "store_1",
      name: "Yamax Points",
      pointNameSingular: "Coin",
      pointNamePlural: "Coins",
      pointsPerCurrencyUnit: { toString: () => "5" },
      vipMilestoneMode: "points_earned",
      vipTimeframe: "calendar_year",
      status: "active",
      killSwitchActive: false,
      metadata: { maintenanceLeaseDigest: "must-not-leak" },
      surfaceFlags: { internal: true },
      branding: {
        launcherText: "Yamax Rewards",
        launcherPosition: "bottom_left",
        launcherIcon: "crown",
        primaryColor: "#123456",
        headerTextColor: "#ffffff",
        panelTitle: "Yamax Club",
        panelWelcomeSubtitle: "Welcome back",
        heroImageUrl: "https://cdn.example.com/yamax.jpg",
        enableFloatingLauncher: false,
      },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    } as any);
    vi.mocked(prisma.weleticLoyaltyTier.findMany).mockResolvedValue([
      {
        id: "tier_1",
        programId: "wprog_private",
        name: "Gold",
        slug: "gold",
        tierOrder: 1,
        minSpendThreshold: BigInt(0),
        minPointsThreshold: BigInt(5000),
        pointsMultiplier: { toString: () => "1.5" },
        entryBonusPoints: BigInt(250),
        perks: ["Early access"],
        iconUrl: null,
        color: "#ffd700",
        criteria: { internalSegment: "vip-private" },
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ] as any);
    vi.mocked(prisma.weleticLoyaltyEarningRule.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticLoyaltyReferralRule.findFirst).mockResolvedValue(
      referralRule() as any,
    );
    vi.mocked(listRewardDefinitions).mockResolvedValue([
      rewardDefinition(),
    ] as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an explicit shopper-safe DTO and normalized live branding", async () => {
    const payload = await getProgramPayload();

    expect(payload.data.program).toEqual({
      name: "Yamax Points",
      pointNameSingular: "Coin",
      pointNamePlural: "Coins",
      pointsPerCurrencyUnit: "5",
      vipMilestoneMode: "points_earned",
      vipTimeframe: "calendar_year",
      isActive: true,
    });
    expect(payload.data.branding).toMatchObject({
      launcherText: "Yamax Rewards",
      launcherPosition: "bottom_left",
      launcherIcon: "crown",
      primaryColor: "#123456",
      panelTitle: "Yamax Club",
      enableFloatingLauncher: false,
    });
    expect(payload.data.tiers[0]).toEqual({
      id: "tier_1",
      name: "Gold",
      slug: "gold",
      tierOrder: 1,
      minSpendThreshold: "0",
      minPointsThreshold: "5000",
      pointsMultiplier: "1.5",
      entryBonusPoints: "250",
      perks: ["Early access"],
      iconUrl: null,
      color: "#ffd700",
    });
    expect(payload.data.rewards[0]).not.toHaveProperty("storeId");
    expect(payload.data.rewards[0]).not.toHaveProperty("shopifyPriceRuleId");
    expect(payload.data.program).not.toHaveProperty("metadata");
    expect(payload.data.program).not.toHaveProperty("surfaceFlags");
    expect(payload.data.referralOffer).toMatchObject({
      friendClaimEnabled: true,
      friendRewardKind: "coupon",
      friendRewardName: "Welcome ¥500 off",
      friendPointsReward: "0",
      advocateRewardKind: "points",
      advocatePointsReward: "500",
    });
    expect(payload.data.referralOffer).not.toHaveProperty(
      "refereeRewardDefinitionId",
    );
    expect(payload.data.referralOffer).not.toHaveProperty(
      "advocateRewardDefinitionId",
    );
    expect(prisma.weleticLoyaltyProgram.findUnique).toHaveBeenCalledWith({
      where: { storeId: "store_1" },
      select: expect.not.objectContaining({
        metadata: true,
        surfaceFlags: true,
        storeId: true,
      }),
    });
  });

  it("does not publish POS-only rewards in the online catalog", async () => {
    vi.mocked(listRewardDefinitions).mockResolvedValueOnce([
      rewardDefinition({ id: "reward_1", salesChannel: "online_store" }),
      rewardDefinition({ id: "reward_pos", salesChannel: "pos" }),
      rewardDefinition({ id: "reward_both", salesChannel: "both" }),
    ] as any);

    const payload = await getProgramPayload();

    expect(
      payload.data.rewards.map((reward: { id: string }) => reward.id),
    ).toEqual(["reward_1", "reward_both"]);
    expect(JSON.stringify(payload.data.rewards)).not.toContain("reward_pos");
  });

  it("filters malformed legacy tier perks to shopper-safe strings", async () => {
    vi.mocked(prisma.weleticLoyaltyTier.findMany).mockResolvedValueOnce([
      {
        id: "tier_legacy",
        name: "Legacy Gold",
        slug: "legacy-gold",
        tierOrder: 1,
        minSpendThreshold: BigInt(0),
        minPointsThreshold: BigInt(5000),
        pointsMultiplier: { toString: () => "1.5" },
        entryBonusPoints: BigInt(250),
        perks: [
          "Early access",
          { label: "must-not-leak" },
          42,
          null,
          ["nested legacy value"],
          "Free shipping",
        ],
        iconUrl: null,
        color: "#ffd700",
      },
    ] as any);

    const payload = await getProgramPayload();
    expect(payload.data.tiers[0].perks).toEqual([
      "Early access",
      "Free shipping",
    ]);
  });

  it("publishes only earning rules inside the half-open effective window", async () => {
    vi.mocked(prisma.weleticLoyaltyEarningRule.findMany).mockResolvedValueOnce([
      {
        id: "rule_current",
        name: "Current action",
        description: null,
        triggerCode: "account_created",
        ruleType: "fixed_points",
        multiplier: 1,
        fixedPoints: BigInt(25),
        maxEventsPerCustomer: 1,
        limitInterval: "lifetime",
        conditions: null,
        startAt: new Date("2026-06-15T12:00:00.000Z"),
        endAt: new Date("2026-06-16T00:00:00.000Z"),
      },
      {
        id: "rule_future",
        name: "Future action",
        description: null,
        triggerCode: "account_created",
        ruleType: "fixed_points",
        multiplier: 1,
        fixedPoints: BigInt(25),
        startAt: new Date("2026-06-15T12:00:00.001Z"),
        endAt: null,
      },
      {
        id: "rule_expired",
        name: "Expired action",
        description: null,
        triggerCode: "account_created",
        ruleType: "fixed_points",
        multiplier: 1,
        fixedPoints: BigInt(25),
        startAt: null,
        endAt: new Date("2026-06-15T12:00:00.000Z"),
      },
    ] as any);

    const payload = await getProgramPayload();

    expect(
      payload.data.earningRules.map((rule: { id: string }) => rule.id),
    ).toEqual(["rule_current"]);
    expect(prisma.weleticLoyaltyEarningRule.findMany).toHaveBeenCalledWith({
      where: {
        program: { storeId: "store_1" },
        isActive: true,
        deletedAt: null,
        OR: [{ startAt: null }, { startAt: { lte: NOW } }],
        AND: [{ OR: [{ endAt: null }, { endAt: { gt: NOW } }] }],
      },
      orderBy: { createdAt: "asc" },
    });
  });

  it("accepts fixed provisionable coupon rewards on both referral sides", async () => {
    vi.mocked(
      prisma.weleticLoyaltyReferralRule.findFirst,
    ).mockResolvedValueOnce(
      referralRule({
        advocateRewardKind: "coupon",
        advocatePointsReward: BigInt(0),
        advocateRewardDefinitionId: "reward_advocate",
        refereeRewardDefinitionId: "reward_friend",
      }) as any,
    );
    vi.mocked(listRewardDefinitions).mockResolvedValueOnce([
      rewardDefinition({
        id: "reward_advocate",
        name: "Advocate 10% off",
        rewardType: "percentage_off",
        discountValue: "10",
      }),
      rewardDefinition({
        id: "reward_friend",
        name: "Friend ¥500 off",
        salesChannel: "both",
      }),
    ] as any);

    const payload = await getProgramPayload();

    expect(payload.data.referralOffer).toMatchObject({
      friendClaimEnabled: true,
      advocateRewardKind: "coupon",
      advocateRewardName: "Advocate 10% off",
      friendRewardKind: "coupon",
      friendRewardName: "Friend ¥500 off",
    });
  });

  it("keeps a valid points friend reward visible but not anonymously claimable", async () => {
    vi.mocked(
      prisma.weleticLoyaltyReferralRule.findFirst,
    ).mockResolvedValueOnce(
      referralRule({
        refereeRewardKind: "points",
        refereePointsReward: BigInt(100),
        refereeRewardDefinitionId: null,
      }) as any,
    );

    const payload = await getProgramPayload();

    expect(payload.data.referralOffer).toMatchObject({
      friendClaimEnabled: false,
      friendRewardKind: "points",
      friendPointsReward: "100",
    });
  });

  it.each([
    {
      label: "zero advocate points",
      rule: referralRule({ advocatePointsReward: BigInt(0) }),
      rewards: [rewardDefinition()],
    },
    {
      label: "zero friend points",
      rule: referralRule({
        refereeRewardKind: "points",
        refereePointsReward: BigInt(0),
        refereeRewardDefinitionId: null,
      }),
      rewards: [rewardDefinition()],
    },
    {
      label: "missing advocate coupon",
      rule: referralRule({
        advocateRewardKind: "coupon",
        advocatePointsReward: BigInt(0),
        advocateRewardDefinitionId: "missing_reward",
      }),
      rewards: [rewardDefinition()],
    },
    {
      label: "missing friend coupon",
      rule: referralRule({ refereeRewardDefinitionId: "missing_reward" }),
      rewards: [rewardDefinition()],
    },
    ...(["advocate", "friend"] as const).flatMap((side) =>
      [
        {
          suffix: "incremental amount-off",
          reward: rewardDefinition({ exchangeType: "incremental" }),
        },
        {
          suffix: "POS-only coupon",
          reward: rewardDefinition({ salesChannel: "pos" }),
        },
        {
          suffix: "gift card",
          reward: rewardDefinition({ rewardType: "gift_card" }),
        },
        {
          suffix: "store credit",
          reward: rewardDefinition({ rewardType: "store_credit" }),
        },
        {
          suffix: "invalid fixed amount-off definition",
          reward: rewardDefinition({ discountValue: null }),
        },
      ].map(({ suffix, reward }) => {
        const invalidReward = { ...reward, id: `reward_${side}` };
        return {
          label: `${side} ${suffix}`,
          rule:
            side === "advocate"
              ? referralRule({
                  advocateRewardKind: "coupon",
                  advocatePointsReward: BigInt(0),
                  advocateRewardDefinitionId: invalidReward.id,
                })
              : referralRule({
                  refereeRewardDefinitionId: invalidReward.id,
                }),
          rewards:
            side === "advocate"
              ? [rewardDefinition(), invalidReward]
              : [invalidReward],
        };
      }),
    ),
  ])("rejects a referral offer with $label", async ({ rule, rewards }) => {
    vi.mocked(
      prisma.weleticLoyaltyReferralRule.findFirst,
    ).mockResolvedValueOnce(rule as any);
    vi.mocked(listRewardDefinitions).mockResolvedValueOnce(rewards as any);

    const payload = await getProgramPayload();

    expect(payload.data.referralOffer).toBeNull();
    expect(payload.data.referralOffer?.friendClaimEnabled ?? false).toBe(false);
  });

  it("keeps the inactive program contract explicit for storefront gating", async () => {
    vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValueOnce({
      name: "Paused Rewards",
      pointNameSingular: "Point",
      pointNamePlural: "Points",
      pointsPerCurrencyUnit: { toString: () => "1" },
      vipMilestoneMode: "points_earned",
      vipTimeframe: "calendar_year",
      status: "paused",
      killSwitchActive: false,
      branding: null,
    } as any);

    const payload = await getProgramPayload();
    expect(payload.data.program).toMatchObject({
      name: "Paused Rewards",
      isActive: false,
    });
    expect(payload.data.referralOffer.friendClaimEnabled).toBe(false);
  });
});
