import { prisma } from "@/lib/prisma";
import {
  bindCustomerReferral,
  calculateCustomerVipProgress,
  type CustomerLoyaltySummaryTimings,
  getCustomerLoyaltySummary,
  getCustomerReferralOffer,
  getCustomerRewardStatus,
  redeemCustomerPoints,
  resolveStoreId,
  validateCustomerIncrementalPointsRequest,
} from "@/lib/weletic/loyalty/customer";
import { createLoyaltyDiscountProvisioningIdentity } from "@/lib/weletic/loyalty/redemption-discount-identity";
import {
  createLoyaltyRedemptionProvisioningSnapshot,
  getShopifyCustomerSelectionDigest,
} from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import { createReferralCouponRewardSnapshot } from "@/lib/weletic/loyalty/referral-coupon-snapshot";
import { validateIncrementalRewardConfig } from "@/lib/weletic/loyalty/rewards";
import {
  WeleticRedemptionStatus,
  WeleticRewardExchangeType,
  WeleticRewardSalesChannel,
  WeleticRewardType,
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticShopifyCustomerPrivacyTombstone: {
      findFirst: vi.fn(),
    },
    weleticShopper: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticRewardDefinition: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    weleticRewardRedemption: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    weleticLoyaltyTier: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findUnique: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }: any) => data),
      update: vi.fn(),
    },
    $transaction: vi.fn((fn) => (typeof fn === "function" ? fn(prisma) : fn)),
  },
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

describe("Customer Loyalty APIs & Surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      id: "store_123",
      shopDomain: "test-shop.myshopify.com",
      projectId: "workspace_123",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
      complianceState: "active",
    } as any);
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValue([]);
    vi.mocked(
      prisma.weleticShopifyCustomerPrivacyTombstone.findFirst,
    ).mockResolvedValue(null);
    vi.mocked(prisma.weleticLoyaltyReferral.count).mockResolvedValue(0);
    vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockImplementation(
      (async ({ where }: any) => ({
        count: Array.isArray(where?.id?.in) ? where.id.in.length : 1,
      })) as any,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  });

  function mockFullSummaryLifecycle({
    programStatus,
    killSwitchActive,
    referralRule,
    wallet = [],
    accountStatus = "active",
    branding = { panelWelcomeSubtitle: "" },
  }: {
    programStatus: string;
    killSwitchActive: boolean;
    referralRule: Record<string, unknown>;
    wallet?: Array<Record<string, unknown>>;
    accountStatus?: string;
    branding?: Record<string, unknown>;
  }) {
    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
      id: "shopper_lifecycle",
      shopifyCustomerId: "customer_lifecycle",
      firstName: "Hiro",
      email: "hiro@example.com",
      store: {
        id: "store_123",
        shopDomain: "test-shop.myshopify.com",
        shopCurrency: "USD",
      },
      loyaltyAccount: {
        id: "account_lifecycle",
        storeId: "store_123",
        status: accountStatus,
        metadata: null,
        currentTierId: null,
        referralCode: null,
        cachedPointsBalance: BigInt(900),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(900),
        lifetimePointsRedeemed: BigInt(0),
        enrolledAt: new Date("2026-01-01T00:00:00.000Z"),
        tierHistory: [],
        program: {
          id: "program_lifecycle",
          status: programStatus,
          killSwitchActive,
          name: "Lifecycle Rewards",
          pointNameSingular: "Point",
          pointNamePlural: "Points",
          pointsExpiryMonths: 12,
          pointsExpiryDays: 365,
          pointsExpiryWarningDays: 30,
          pointsExpiryLastChanceDays: 3,
          vipMilestoneMode: "points_earned",
          vipTimeframe: "lifetime",
          branding,
          earningRules: [{ id: "earning_mutation" }],
          bonusCampaigns: [{ id: "campaign_mutation" }],
          referralRules: [referralRule],
        },
      },
    } as any);
    vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
      id: "account_lifecycle",
      storeId: "store_123",
      status: accountStatus,
      metadata: null,
      currentTier: null,
      currentTierId: null,
      tierSpendRolling12Months: BigInt(0),
      lifetimePointsEarned: BigInt(900),
      referralCode: null,
      referralPointsEarned: BigInt(0),
      _count: { advocateReferrals: 0 },
      advocateReferrals: [],
      program: { id: "program_lifecycle", tiers: [] },
    } as any);
    vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([]);
    (prisma.weleticRewardRedemption.findMany as any).mockImplementation(
      async (args: any) => (args.where.OR ? wallet : []),
    );
  }

  function summaryRewardDefinition({
    id,
    salesChannel,
  }: {
    id: string;
    salesChannel: WeleticRewardSalesChannel;
  }) {
    return {
      id,
      storeId: "store_123",
      name: id,
      description: null,
      rewardType: WeleticRewardType.amount_off,
      exchangeType: WeleticRewardExchangeType.fixed,
      salesChannel,
      pointsCost: BigInt(500),
      pointsStep: null,
      minPointsCost: null,
      maxPointsCost: null,
      discountValue: 500,
      maxDiscountValue: null,
      minOrderAmount: null,
      appliesToResource: "entire_order",
      entitledCollectionIds: [],
      entitledProductIds: [],
      entitledVariantIds: [],
      combinesWithProductDiscounts: false,
      combinesWithOrderDiscounts: false,
      combinesWithShippingDiscounts: false,
      usageLimit: null,
      usageLimitPerCustomer: 1,
      expiresInDays: null,
      status: "active",
    };
  }

  it("calculates VIP progress according to spend, points, or both milestones", () => {
    const common = {
      currentSpend: BigInt(7_500),
      spendThreshold: BigInt(10_000),
      currentPoints: BigInt(400),
      pointsThreshold: BigInt(1_000),
    };

    expect(
      calculateCustomerVipProgress({
        ...common,
        milestoneMode: "amount_spent",
      }).percent,
    ).toBe(75);
    expect(
      calculateCustomerVipProgress({
        ...common,
        milestoneMode: "points_earned",
      }).percent,
    ).toBe(40);
    expect(
      calculateCustomerVipProgress({ ...common, milestoneMode: "both" }),
    ).toEqual({
      milestoneMode: "both",
      percent: 40,
      spendRemaining: "2500",
      pointsRemaining: "600",
    });
  });

  it("validates incremental amount-off reward boundaries", () => {
    expect(() =>
      validateIncrementalRewardConfig({
        rewardType: WeleticRewardType.amount_off,
        exchangeType: WeleticRewardExchangeType.incremental,
        pointsCost: 500,
        pointsStep: 100,
        minPointsCost: 500,
        maxPointsCost: 2_000,
      }),
    ).not.toThrow();
    expect(() =>
      validateIncrementalRewardConfig({
        rewardType: WeleticRewardType.free_shipping,
        exchangeType: WeleticRewardExchangeType.incremental,
        pointsCost: 500,
        pointsStep: 100,
      }),
    ).toThrow("supported only for amount-off rewards");
    expect(() =>
      validateIncrementalRewardConfig({
        rewardType: WeleticRewardType.amount_off,
        exchangeType: WeleticRewardExchangeType.incremental,
        pointsCost: 500,
        pointsStep: 100,
        minPointsCost: 550,
      }),
    ).toThrow("positive multiples of the point step");
  });

  it("validates customer incremental selections without Number coercion", () => {
    expect(
      validateCustomerIncrementalPointsRequest({
        pointsRequested: "9007199254740993",
        minimum: BigInt("9007199254740993"),
        maximum: BigInt("9007199254741003"),
        step: BigInt(1),
      }),
    ).toBe(BigInt("9007199254740993"));
    expect(() =>
      validateCustomerIncrementalPointsRequest({
        pointsRequested: "0",
        minimum: BigInt(500),
        maximum: BigInt(1500),
        step: BigInt(100),
      }),
    ).toThrow("step or limits");
    expect(() =>
      validateCustomerIncrementalPointsRequest({
        pointsRequested: "550",
        minimum: BigInt(500),
        maximum: BigInt(1500),
        step: BigInt(100),
      }),
    ).toThrow("step or limits");
    expect(() =>
      validateCustomerIncrementalPointsRequest({
        pointsRequested: "500.0",
        minimum: BigInt(500),
        maximum: BigInt(1500),
        step: BigInt(100),
      }),
    ).toThrow("whole-number string");
  });

  it("withholds inactive or invalid customer referral offers", () => {
    const activeRule = {
      isActive: true,
      advocateRewardKind: "coupon" as const,
      advocatePointsReward: BigInt(0),
      advocateRewardDefinitionId: "reward_coupon",
      refereeRewardKind: "points" as const,
      refereePointsReward: BigInt(250),
      refereeRewardDefinitionId: null,
      minQualifyingOrderSubtotal: { toString: () => "5000" },
      maxReferralsPerAdvocate: 20,
    };
    const rewards = [
      {
        id: "reward_coupon",
        name: "$10 Voucher",
        exchangeType: WeleticRewardExchangeType.fixed,
        rewardType: WeleticRewardType.amount_off,
        salesChannel: WeleticRewardSalesChannel.online_store,
        discountValue: 1_000,
        maxDiscountValue: null,
        minOrderAmount: null,
        entitledCollectionIds: [],
        entitledProductIds: [],
        entitledVariantIds: [],
        usageLimit: null,
        usageLimitPerCustomer: 1,
      },
    ];

    expect(
      getCustomerReferralOffer({
        programStatus: "active",
        killSwitchActive: false,
        rule: activeRule,
        rewards,
      }),
    ).toMatchObject({
      advocateRewardKind: "coupon",
      advocateRewardName: "$10 Voucher",
      refereeRewardKind: "points",
      refereePointsReward: "250",
    });
    expect(
      getCustomerReferralOffer({
        programStatus: "disabled",
        killSwitchActive: false,
        rule: activeRule,
        rewards,
      }),
    ).toBeNull();
    expect(
      getCustomerReferralOffer({
        programStatus: "active",
        killSwitchActive: false,
        rule: activeRule,
        rewards: [
          {
            ...rewards[0],
            rewardType: WeleticRewardType.gift_card,
          },
        ],
      }),
    ).toBeNull();
    expect(
      getCustomerReferralOffer({
        programStatus: "active",
        killSwitchActive: true,
        rule: activeRule,
        rewards,
      }),
    ).toBeNull();
    expect(
      getCustomerReferralOffer({
        programStatus: "active",
        killSwitchActive: false,
        rule: { ...activeRule, advocateRewardDefinitionId: "missing" },
        rewards,
      }),
    ).toBeNull();
    expect(
      getCustomerReferralOffer({
        programStatus: "active",
        killSwitchActive: false,
        rule: {
          ...activeRule,
          advocateRewardKind: "points",
          advocateRewardDefinitionId: null,
          advocatePointsReward: BigInt(0),
        },
        rewards,
      }),
    ).toBeNull();
  });

  it("resolves store ID from shop domain", async () => {
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
      id: "store_123",
      shopDomain: "test-shop.myshopify.com",
    } as any);

    const storeId = await resolveStoreId({
      shopDomain: "test-shop.myshopify.com",
    });
    expect(storeId).toBe("store_123");
  });

  it("returns guest summary when shopper is not yet enrolled", async () => {
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
      id: "store_123",
      shopDomain: "test-shop.myshopify.com",
    } as any);

    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce(null);

    const result = await getCustomerLoyaltySummary({
      storeId: "store_123",
      shopifyCustomerId: "cust_guest_999",
    });

    expect(result).toMatchObject({
      isEnrolled: false,
      pointsBalance: "0",
      rewards: [],
      rewardWallet: [],
    });
  });

  it.each([
    { label: "paused", programStatus: "paused", killSwitchActive: false },
    {
      label: "kill-switched",
      programStatus: "active",
      killSwitchActive: true,
    },
  ])(
    "preserves the issued wallet but suppresses $label program mutations",
    async ({ programStatus, killSwitchActive }) => {
      mockFullSummaryLifecycle({
        programStatus,
        killSwitchActive,
        referralRule: {
          isActive: true,
          advocateRewardKind: "points",
          advocatePointsReward: BigInt(100),
          advocateRewardDefinitionId: null,
          refereeRewardKind: "points",
          refereePointsReward: BigInt(100),
          refereeRewardDefinitionId: null,
          minQualifyingOrderSubtotal: null,
          maxReferralsPerAdvocate: null,
        },
        wallet: [
          {
            id: "issued_before_pause",
            rewardDefinitionId: "legacy_reward",
            pointsSpent: BigInt(500),
            shopifyDiscountCode: "WL-ISSUED",
            artifactKind: null,
            status: WeleticRedemptionStatus.issued,
            orderId: null,
            expiresAt: null,
            usedAt: null,
            ledgerEntryId: null,
            metadata: {
              rewardSnapshot: {
                name: "Issued before pause",
                rewardType: "amount_off",
              },
            },
            createdAt: new Date("2026-01-15T00:00:00.000Z"),
            updatedAt: new Date("2026-01-15T00:00:00.000Z"),
          },
        ],
      });

      const summary = await getCustomerLoyaltySummary({
        storeId: "store_123",
        shopifyCustomerId: "customer_lifecycle",
      });

      expect(summary.isEnrolled).toBe(true);
      if (!summary.isEnrolled) throw new Error("Expected enrolled summary.");
      expect(summary.program).toMatchObject({
        isActive: false,
        branding: { subtitle: "" },
      });
      expect(summary.rewards).toEqual([]);
      expect(summary.waysToEarn).toEqual([]);
      expect(summary.activeCampaigns).toEqual([]);
      expect(summary.birthday?.enabled).toBe(false);
      expect(summary.referral).toMatchObject({
        referralCode: null,
        referralShareUrl: null,
        offer: null,
      });
      expect(summary.rewardWallet).toEqual([
        expect.objectContaining({
          id: "issued_before_pause",
          rewardName: "Issued before pause",
          status: "available",
        }),
      ]);
      expect(prisma.weleticRewardDefinition.findMany).not.toHaveBeenCalled();
      expect(prisma.weleticLoyaltyAccount.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(["suspended", "closed"])(
    "preserves the issued wallet but suppresses %s account participation",
    async (accountStatus) => {
      mockFullSummaryLifecycle({
        programStatus: "active",
        killSwitchActive: false,
        accountStatus,
        referralRule: {
          isActive: true,
          advocateRewardKind: "points",
          advocatePointsReward: BigInt(100),
          advocateRewardDefinitionId: null,
          refereeRewardKind: "points",
          refereePointsReward: BigInt(100),
          refereeRewardDefinitionId: null,
          minQualifyingOrderSubtotal: null,
          maxReferralsPerAdvocate: null,
        },
        wallet: [
          {
            id: `issued_before_${accountStatus}`,
            rewardDefinitionId: "legacy_reward",
            pointsSpent: BigInt(500),
            shopifyDiscountCode: "WL-ISSUED",
            artifactKind: null,
            status: WeleticRedemptionStatus.issued,
            orderId: null,
            expiresAt: null,
            usedAt: null,
            ledgerEntryId: null,
            metadata: {
              rewardSnapshot: {
                name: "Issued before account restriction",
                rewardType: "amount_off",
              },
            },
            createdAt: new Date("2026-01-15T00:00:00.000Z"),
            updatedAt: new Date("2026-01-15T00:00:00.000Z"),
          },
        ],
      });

      const summary = await getCustomerLoyaltySummary({
        storeId: "store_123",
        shopifyCustomerId: "customer_lifecycle",
      });

      expect(summary.isEnrolled).toBe(true);
      if (!summary.isEnrolled) throw new Error("Expected enrolled summary.");
      expect(summary.program?.isActive).toBe(true);
      expect(summary.account).toMatchObject({
        status: accountStatus,
        canParticipate: false,
      });
      expect(summary.rewards).toEqual([]);
      expect(summary.waysToEarn).toEqual([]);
      expect(summary.activeCampaigns).toEqual([]);
      expect(summary.birthday?.enabled).toBe(false);
      expect(summary.referral).toMatchObject({
        referralCode: null,
        referralShareUrl: null,
        offer: null,
      });
      expect(summary.rewardWallet).toEqual([
        expect.objectContaining({
          id: `issued_before_${accountStatus}`,
          status: "available",
        }),
      ]);
      expect(prisma.weleticRewardDefinition.findMany).not.toHaveBeenCalled();
    },
  );

  it("normalizes unsafe migrated branding before returning customer data", async () => {
    mockFullSummaryLifecycle({
      programStatus: "active",
      killSwitchActive: false,
      branding: {
        panelTitle: "x".repeat(101),
        panelWelcomeSubtitle: "x".repeat(301),
        heroImageUrl: "https://user:password@cdn.example.com/hero.jpg",
        primaryColor: "#fff",
      },
      referralRule: {
        isActive: false,
        advocateRewardKind: "points",
        advocatePointsReward: BigInt(0),
        advocateRewardDefinitionId: null,
        refereeRewardKind: "points",
        refereePointsReward: BigInt(0),
        refereeRewardDefinitionId: null,
        minQualifyingOrderSubtotal: null,
        maxReferralsPerAdvocate: null,
      },
    });
    vi.mocked(prisma.weleticRewardDefinition.findMany).mockResolvedValue([]);

    const summary = await getCustomerLoyaltySummary({
      storeId: "store_123",
      shopifyCustomerId: "customer_lifecycle",
    });

    expect(summary.isEnrolled).toBe(true);
    if (!summary.isEnrolled) throw new Error("Expected enrolled summary.");
    expect(summary.program?.branding).toEqual({
      title: "Lifecycle Rewards",
      subtitle: "Earn points, level up, and unlock exclusive discounts.",
      heroImageUrl: null,
      primaryColor: "#059669",
    });
  });

  it.each([
    {
      label: "online customer",
      redemptionChannel: WeleticRewardSalesChannel.online_store,
      visibleRewardIds: ["reward_online", "reward_both"],
    },
    {
      label: "trusted POS session",
      redemptionChannel: WeleticRewardSalesChannel.pos,
      visibleRewardIds: ["reward_pos", "reward_both"],
    },
  ])(
    "returns only channel-eligible rewards to a $label catalog",
    async ({ redemptionChannel, visibleRewardIds }) => {
      mockFullSummaryLifecycle({
        programStatus: "active",
        killSwitchActive: false,
        referralRule: {
          isActive: false,
          advocateRewardKind: "points",
          advocatePointsReward: BigInt(0),
          advocateRewardDefinitionId: null,
          refereeRewardKind: "points",
          refereePointsReward: BigInt(0),
          refereeRewardDefinitionId: null,
          minQualifyingOrderSubtotal: null,
          maxReferralsPerAdvocate: null,
        },
      });
      vi.mocked(prisma.weleticRewardDefinition.findMany).mockResolvedValue([
        summaryRewardDefinition({
          id: "reward_online",
          salesChannel: WeleticRewardSalesChannel.online_store,
        }),
        summaryRewardDefinition({
          id: "reward_pos",
          salesChannel: WeleticRewardSalesChannel.pos,
        }),
        summaryRewardDefinition({
          id: "reward_both",
          salesChannel: WeleticRewardSalesChannel.both,
        }),
      ] as any);

      const summary = await getCustomerLoyaltySummary({
        storeId: "store_123",
        shopifyCustomerId: "customer_lifecycle",
        redemptionChannel,
      });

      expect(summary.isEnrolled).toBe(true);
      if (!summary.isEnrolled) throw new Error("Expected enrolled summary.");
      expect(summary.rewards.map((reward) => reward.id)).toEqual(
        visibleRewardIds,
      );
    },
  );

  it("validates a coupon referral offer before provisioning its identity or link", async () => {
    mockFullSummaryLifecycle({
      programStatus: "active",
      killSwitchActive: false,
      referralRule: {
        isActive: true,
        advocateRewardKind: "coupon",
        advocatePointsReward: BigInt(0),
        advocateRewardDefinitionId: "missing_coupon",
        refereeRewardKind: "points",
        refereePointsReward: BigInt(100),
        refereeRewardDefinitionId: null,
        minQualifyingOrderSubtotal: null,
        maxReferralsPerAdvocate: null,
      },
    });
    vi.mocked(prisma.weleticRewardDefinition.findMany).mockResolvedValue([
      {
        id: "different_coupon",
        storeId: "store_123",
        name: "Different coupon",
        description: null,
        rewardType: WeleticRewardType.amount_off,
        exchangeType: WeleticRewardExchangeType.fixed,
        salesChannel: "online_store",
        pointsCost: BigInt(500),
        pointsStep: null,
        minPointsCost: null,
        maxPointsCost: null,
        discountValue: 500,
        maxDiscountValue: null,
        minOrderAmount: null,
        appliesToResource: "entire_order",
        entitledCollectionIds: [],
        entitledProductIds: [],
        entitledVariantIds: [],
        combinesWithProductDiscounts: false,
        combinesWithOrderDiscounts: false,
        combinesWithShippingDiscounts: false,
        usageLimit: null,
        usageLimitPerCustomer: 1,
        expiresInDays: null,
        status: "active",
      },
    ] as any);

    const summary = await getCustomerLoyaltySummary({
      storeId: "store_123",
      shopifyCustomerId: "customer_lifecycle",
    });

    expect(summary.isEnrolled).toBe(true);
    if (!summary.isEnrolled) throw new Error("Expected enrolled summary.");
    expect(summary.program).toMatchObject({
      isActive: true,
      branding: { subtitle: "" },
    });
    expect(summary.rewards).toHaveLength(1);
    expect(summary.referral).toMatchObject({
      referralCode: null,
      referralShareUrl: null,
      offer: null,
    });
    expect(prisma.weleticLoyaltyAccount.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
  });

  it("starts independent summary reads concurrently and reports stage timings", async () => {
    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
      id: "shopper_parallel",
      firstName: "Hiro",
      store: {
        id: "store_123",
        shopDomain: "test-shop.myshopify.com",
        shopCurrency: "USD",
      },
      loyaltyAccount: {
        id: "account_parallel",
        status: "active",
        referralCode: "HIRO-FAST",
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(0),
        lifetimePointsRedeemed: BigInt(0),
        enrolledAt: new Date("2026-01-01T00:00:00.000Z"),
        program: {
          status: "active",
          killSwitchActive: false,
          earningRules: [],
          bonusCampaigns: [],
          referralRules: [],
        },
      },
    } as any);

    let resolveTier!: (value: any) => void;
    const blockedTierRead = new Promise<any>((resolve) => {
      resolveTier = resolve;
    });
    vi.mocked(prisma.weleticLoyaltyAccount.findUnique)
      .mockImplementationOnce(() => blockedTierRead as any)
      .mockResolvedValueOnce({
        referralCode: "HIRO-FAST",
        referralCount: 0,
        referralPointsEarned: BigInt(0),
        _count: { advocateReferrals: 80 },
        advocateReferrals: [],
      } as any);
    vi.mocked(prisma.weleticLoyaltyReferral.count).mockResolvedValueOnce(75);
    vi.mocked(prisma.weleticRewardDefinition.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([]);

    const timingReports: CustomerLoyaltySummaryTimings[] = [];
    const summaryPromise = getCustomerLoyaltySummary({
      storeId: "store_123",
      shopifyCustomerId: "parallel_customer",
      onTiming: (timings) => timingReports.push(timings),
    });

    await vi.waitFor(() => {
      expect(prisma.weleticRewardDefinition.findMany).toHaveBeenCalledOnce();
      expect(prisma.$transaction).toHaveBeenCalledOnce();
    });

    resolveTier({
      currentTier: null,
      program: { tiers: [] },
      tierSpendRolling12Months: BigInt(0),
      lifetimePointsEarned: BigInt(0),
    });
    const result = await summaryPromise;

    expect(result.isEnrolled).toBe(true);
    expect(result.referral?.qualifiedReferrals).toBe(75);
    expect(result.referral?.totalReferrals).toBe(80);
    expect(timingReports).toHaveLength(1);
    expect(timingReports[0]).toMatchObject({
      resolveStore: expect.any(Number),
      loadShopper: expect.any(Number),
      loadSummary: expect.any(Number),
      loadLegacyMetadata: expect.any(Number),
      total: expect.any(Number),
    });
  });

  it("maps customer-safe redemption states and treats overdue codes as expired", () => {
    expect(
      getCustomerRewardStatus({
        status: WeleticRedemptionStatus.issued,
        expiresAt: new Date("2026-03-01T00:00:00.000Z"),
        now: new Date("2026-03-02T00:00:00.000Z"),
      }),
    ).toBe("expired");
    expect(
      getCustomerRewardStatus({
        status: WeleticRedemptionStatus.active,
        expiresAt: new Date("2026-03-03T00:00:00.000Z"),
        now: new Date("2026-03-02T00:00:00.000Z"),
      }),
    ).toBe("available");
    expect(
      getCustomerRewardStatus({
        status: WeleticRedemptionStatus.used,
        expiresAt: null,
      }),
    ).toBe("used");
    expect(() =>
      getCustomerRewardStatus({
        status: WeleticRedemptionStatus.provisioning,
        expiresAt: null,
      }),
    ).toThrow("not customer-visible");
    expect(() =>
      getCustomerRewardStatus({
        status: WeleticRedemptionStatus.failed,
        expiresAt: null,
      }),
    ).toThrow("not customer-visible");
  });

  it("retrieves the full summary and selects the canonical newest referral rule", async () => {
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      id: "store_123",
      shopDomain: "test-shop.myshopify.com",
    } as any);

    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
      id: "shop_1",
      storeId: "store_123",
      shopifyCustomerId: "cust_123",
      firstName: "Hiron",
      lastName: "Nguyen",
      email: "hiron@example.com",
      store: {
        id: "store_123",
        shopDomain: "yamax-active.myshopify.com",
        shopCurrency: "USD",
      },
      loyaltyAccount: {
        id: "acc_1",
        storeId: "store_123",
        status: "active",
        cachedPointsBalance: BigInt(500),
        cachedPendingPoints: BigInt(50),
        lifetimePointsEarned: BigInt(800),
        lifetimePointsRedeemed: BigInt(300),
        referralCode: "HIRON123",
        enrolledAt: new Date("2026-01-01"),
        currentTier: {
          id: "tier_gold",
          name: "Gold Member",
          pointsMultiplier: 1.25,
        },
        tierExpiresAt: new Date("2027-12-31T00:00:00.000Z"),
        tierHistory: [
          {
            id: "tier-history-1",
            fromTier: { id: "tier_bronze", name: "Bronze" },
            toTier: { id: "tier_gold", name: "Gold Member" },
            changeReason: "threshold_reached",
            qualifyingSpendSnapshot: BigInt(50_000),
            qualifyingPointsSnapshot: BigInt(500),
            effectiveAt: new Date("2026-02-01T00:00:00.000Z"),
          },
        ],
        program: {
          id: "prog_1",
          status: "active",
          killSwitchActive: false,
          name: "Yamax Points",
          pointNameSingular: "Coin",
          pointNamePlural: "Coins",
          pointsExpiryMonths: 12,
          vipMilestoneMode: "points_earned",
          vipTimeframe: "calendar_year",
          branding: {
            panelTitle: "Yamax Loyalty Hub",
            panelWelcomeSubtitle: "Earn and spend Yamax Coins.",
            heroImageUrl: "https://cdn.example.com/yamax-loyalty.jpg",
            primaryColor: "#0f5bd8",
          },
          earningRules: [],
          bonusCampaigns: [],
          referralRules: [
            {
              id: "rule_newest",
              createdAt: new Date("2026-02-01T00:00:00.000Z"),
              updatedAt: new Date("2026-02-01T00:00:00.000Z"),
              isActive: true,
              advocateRewardKind: "coupon",
              advocatePointsReward: BigInt(0),
              advocateRewardDefinitionId: "reward_10_off",
              refereeRewardKind: "points",
              refereePointsReward: BigInt(250),
              refereeRewardDefinitionId: null,
              minQualifyingOrderSubtotal: "5000",
              maxReferralsPerAdvocate: 20,
            },
            {
              id: "rule_older_but_recently_edited",
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-08-01T00:00:00.000Z"),
              isActive: true,
              advocateRewardKind: "points",
              advocatePointsReward: BigInt(999),
              advocateRewardDefinitionId: null,
              refereeRewardKind: "points",
              refereePointsReward: BigInt(999),
              refereeRewardDefinitionId: null,
              minQualifyingOrderSubtotal: "9999",
              maxReferralsPerAdvocate: 99,
            },
          ],
        },
      },
    } as any);

    vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
      id: "acc_1",
      storeId: "store_123",
      programId: "prog_1",
      currentTierId: "tier_gold",
      referralCode: "HIRON123",
      referralCount: 3,
      referralPointsEarned: BigInt(300),
      _count: { advocateReferrals: 13 },
      advocateReferrals: [],
      tierSpendRolling12Months: BigInt(50000),
      tierPointsRolling12Months: BigInt(500),
      currentTier: {
        id: "tier_gold",
        name: "Gold Member",
        tierOrder: 2,
        pointsMultiplier: 1.25,
        minSpendThreshold: BigInt(50000),
        minPointsThreshold: BigInt(500),
      },
      program: {
        id: "prog_1",
        tiers: [
          {
            id: "tier_bronze",
            name: "Bronze",
            slug: "bronze",
            tierOrder: 1,
            pointsMultiplier: 1,
            minSpendThreshold: BigInt(0),
            minPointsThreshold: BigInt(0),
            entryBonusPoints: BigInt(0),
            perks: ["Member offers"],
            iconUrl: null,
            color: null,
          },
          {
            id: "tier_gold",
            name: "Gold Member",
            slug: "gold",
            tierOrder: 2,
            pointsMultiplier: 1.25,
            minSpendThreshold: BigInt(50_000),
            minPointsThreshold: BigInt(500),
            entryBonusPoints: BigInt(100),
            perks: ["Priority support"],
            iconUrl: null,
            color: "#d4af37",
          },
        ],
      },
    } as any);

    vi.mocked(prisma.weleticLoyaltyTier.findMany).mockResolvedValue([
      {
        id: "tier_gold",
        name: "Gold Member",
        tierOrder: 2,
        pointsMultiplier: 1.25,
        minSpendThreshold: BigInt(50000),
        minPointsThreshold: BigInt(500),
      },
    ] as any);

    vi.mocked(prisma.weleticLoyaltyReferral.count).mockResolvedValue(2);
    vi.mocked(prisma.weleticLoyaltyReferral.aggregate).mockResolvedValue({
      _sum: { advocatePointsAwarded: BigInt(300) },
    } as any);

    vi.mocked(prisma.weleticRewardDefinition.findMany).mockResolvedValue([
      {
        id: "reward_10_off",
        storeId: "store_123",
        name: "$10 Voucher",
        description: "$10 off your order",
        rewardType: "amount_off",
        exchangeType: "fixed",
        salesChannel: "online_store",
        pointsCost: BigInt(500),
        discountValue: 2_000,
        minOrderAmount: 25_000,
        expiresInDays: 90,
        usageLimitPerCustomer: 1,
        appliesToResource: "entire_order",
        status: "active",
      },
      {
        id: "reward_25_off",
        storeId: "store_123",
        name: "$25 Voucher",
        description: "$25 off your order",
        rewardType: "amount_off",
        exchangeType: "fixed",
        pointsCost: BigInt(1000),
        discountValue: 25,
        minOrderAmount: 100,
        status: "active",
      },
      {
        id: "reward_incremental",
        storeId: "store_123",
        name: "Choose your discount",
        description: "Redeem from 500 points",
        rewardType: "amount_off",
        exchangeType: "incremental",
        pointsCost: BigInt(1000),
        pointsStep: BigInt(100),
        minPointsCost: BigInt(500),
        maxPointsCost: BigInt(2000),
        discountValue: 10,
        minOrderAmount: 50,
        status: "active",
      },
    ] as any);

    (prisma.weleticPointsLedgerEntry.findMany as any).mockImplementation(
      async (args: any) =>
        args?.where?.id?.in
          ? ([
              {
                id: "ledger_used",
                metadata: {
                  rewardName: "$10 Voucher at issuance",
                  rewardType: "amount_off",
                },
              },
            ] as any)
          : ([
              {
                id: "entry_1",
                entryType: "EARN_ORDER",
                pointsDelta: BigInt(250),
                balanceAfter: BigInt(500),
                reason: "Order points",
                referenceType: "COMMERCE_ORDER",
                referenceId: "order_123",
                createdAt: new Date("2026-02-01"),
              },
            ] as any),
    );

    const standardIssuanceReward = {
      id: "reward_10_off",
      name: "$10 Voucher at issuance",
      description: "$10 off when this coupon was issued",
      rewardType: "amount_off",
      salesChannel: "online_store",
      maxDiscountValue: null,
      minOrderAmount: 5_000,
      appliesToResource: "selected_products",
      entitledCollectionIds: [],
      entitledProductIds: ["gid://shopify/Product/1"],
      entitledVariantIds: [],
      combinesWithProductDiscounts: false,
      combinesWithOrderDiscounts: true,
      combinesWithShippingDiscounts: false,
      usageLimit: null,
      usageLimitPerCustomer: 1,
    };
    const issuanceTerms = createLoyaltyRedemptionProvisioningSnapshot({
      reward: standardIssuanceReward,
      pointsCost: BigInt(500),
      discountValue: 1_000,
      expiresInDays: 30,
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-02-10T00:00:00.000Z"),
      customerSelectionDigest: getShopifyCustomerSelectionDigest({
        storeId: "store_123",
        shopifyCustomerId: "cust_123",
      }),
      startsAt: new Date("2026-02-10T00:00:00.000Z"),
      expiresAt: new Date("2030-12-31T00:00:00.000Z"),
    });
    const mismatchedRewardIssuanceTerms =
      createLoyaltyRedemptionProvisioningSnapshot({
        reward: {
          ...standardIssuanceReward,
          id: "reward_attached_from_another_definition",
          name: "Wrong reward snapshot",
        },
        pointsCost: BigInt(500),
        discountValue: 1_000,
        expiresInDays: 30,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-02-10T00:00:00.000Z"),
        customerSelectionDigest: getShopifyCustomerSelectionDigest({
          storeId: "store_123",
          shopifyCustomerId: "cust_123",
        }),
        startsAt: new Date("2026-02-10T00:00:00.000Z"),
        expiresAt: new Date("2030-12-31T00:00:00.000Z"),
      });
    const mismatchedCustomerIssuanceTerms =
      createLoyaltyRedemptionProvisioningSnapshot({
        reward: standardIssuanceReward,
        pointsCost: BigInt(500),
        discountValue: 1_000,
        expiresInDays: 30,
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-02-10T00:00:00.000Z"),
        customerSelectionDigest: getShopifyCustomerSelectionDigest({
          storeId: "store_123",
          shopifyCustomerId: "another_customer",
        }),
        startsAt: new Date("2026-02-10T00:00:00.000Z"),
        expiresAt: new Date("2030-12-31T00:00:00.000Z"),
      });
    const referralIdentity = {
      storeId: "store_123",
      referralId: "referral_immutable_terms",
      qualificationOrderId: "order_referral_immutable_terms",
      accountId: "acc_1",
      rewardDefinitionId: "reward_10_off",
      side: "advocate" as const,
    };
    const referralIssuanceTerms = createReferralCouponRewardSnapshot({
      identity: referralIdentity,
      reward: {
        id: "reward_10_off",
        name: "Referral voucher at qualification",
        description: "Referral terms captured when qualified",
        rewardType: "amount_off",
        salesChannel: "online_store",
        discountValue: 1_000,
        maxDiscountValue: null,
        minOrderAmount: 7_500,
        appliesToResource: "selected_products",
        entitledCollectionIds: [],
        entitledProductIds: ["gid://shopify/Product/referral-snapshot"],
        entitledVariantIds: [],
        combinesWithProductDiscounts: false,
        combinesWithOrderDiscounts: true,
        combinesWithShippingDiscounts: false,
        usageLimit: null,
        usageLimitPerCustomer: 1,
        expiresInDays: 30,
      },
      qualifiedAt: new Date("2029-01-01T00:00:00.000Z"),
      shopCurrency: "EUR",
      currencyVerifiedAt: new Date("2029-01-01T00:00:00.000Z"),
      shopifyCustomerId: "cust_123",
    });
    const corruptedReferralIdentity = {
      ...referralIdentity,
      referralId: "referral_corrupted_terms",
      qualificationOrderId: "order_referral_corrupted_terms",
    };
    const corruptedReferralIssuanceTerms = {
      ...createReferralCouponRewardSnapshot({
        identity: corruptedReferralIdentity,
        reward: {
          id: "reward_10_off",
          name: "Corrupted referral voucher",
          description: null,
          rewardType: "amount_off",
          salesChannel: "online_store",
          discountValue: 1_000,
          maxDiscountValue: null,
          minOrderAmount: 8_000,
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
        },
        qualifiedAt: new Date("2029-01-01T00:00:00.000Z"),
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2029-01-01T00:00:00.000Z"),
        shopifyCustomerId: "cust_123",
      }),
      // Deliberately leave the original content digest in place.
      minOrderAmount: "999999",
    };
    const standardOwnership = ({
      redemptionId,
      discountCode,
      rewardName = standardIssuanceReward.name,
    }: {
      redemptionId: string;
      discountCode: string;
      rewardName?: string;
    }) =>
      createLoyaltyDiscountProvisioningIdentity({
        identity: {
          storeId: "store_123",
          redemptionId,
          accountId: "acc_1",
          rewardDefinitionId: "reward_10_off",
          discountCode,
        },
        rewardName,
      });
    const availableRedemption = {
      id: "redemp_available",
      rewardDefinitionId: "reward_10_off",
      pointsSpent: BigInt(500),
      shopifyDiscountCode: "WL-AVAILABLE",
      status: WeleticRedemptionStatus.issued,
      orderId: null,
      expiresAt: new Date("2030-12-31T00:00:00.000Z"),
      usedAt: null,
      ledgerEntryId: "ledger_available",
      metadata: {
        rewardSnapshot: {
          name: standardIssuanceReward.name,
          description: "Unsigned edited display description",
          rewardType: "amount_off",
          salesChannel: "both",
        },
        provisioningSnapshot: issuanceTerms,
        shopifyDiscountOwnership: standardOwnership({
          redemptionId: "redemp_available",
          discountCode: "WL-AVAILABLE",
        }),
      },
      createdAt: new Date("2026-02-10T00:00:00.000Z"),
      updatedAt: new Date("2026-02-10T00:00:00.000Z"),
      rewardDefinition: {
        name: "$20 Voucher after merchant edit",
        description: "$20 off after merchant edit",
        rewardType: "amount_off",
      },
    };
    const mismatchedRewardStandardRedemption = {
      ...availableRedemption,
      id: "redemp_mismatched_standard_reward",
      shopifyDiscountCode: "WL-WRONG-REWARD",
      ledgerEntryId: null,
      metadata: {
        rewardSnapshot: {
          name: "Wrong reward snapshot",
          description: "Unsigned wrong reward description",
          rewardType: "amount_off",
          salesChannel: "both",
        },
        provisioningSnapshot: mismatchedRewardIssuanceTerms,
        shopifyDiscountOwnership: standardOwnership({
          redemptionId: "redemp_mismatched_standard_reward",
          discountCode: "WL-WRONG-REWARD",
          rewardName: "Wrong reward snapshot",
        }),
      },
    };
    const mismatchedCustomerStandardRedemption = {
      ...availableRedemption,
      id: "redemp_mismatched_standard_customer",
      shopifyDiscountCode: "WL-WRONG-CUSTOMER",
      ledgerEntryId: null,
      metadata: {
        rewardSnapshot: {
          name: "Unsigned wrong customer name",
          description: "Unsigned wrong customer description",
          rewardType: "amount_off",
          salesChannel: "both",
        },
        provisioningSnapshot: mismatchedCustomerIssuanceTerms,
        shopifyDiscountOwnership: standardOwnership({
          redemptionId: "redemp_mismatched_standard_customer",
          discountCode: "WL-WRONG-CUSTOMER",
        }),
      },
    };
    const mismatchedPointsStandardRedemption = {
      ...availableRedemption,
      id: "redemp_mismatched_standard_points",
      pointsSpent: BigInt(501),
      shopifyDiscountCode: "WL-WRONG-POINTS",
      ledgerEntryId: null,
      metadata: {
        rewardSnapshot: {
          name: standardIssuanceReward.name,
          rewardType: "amount_off",
        },
        provisioningSnapshot: issuanceTerms,
        shopifyDiscountOwnership: standardOwnership({
          redemptionId: "redemp_mismatched_standard_points",
          discountCode: "WL-WRONG-POINTS",
        }),
      },
    };
    const mismatchedExpiryStandardRedemption = {
      ...availableRedemption,
      id: "redemp_mismatched_standard_expiry",
      shopifyDiscountCode: "WL-WRONG-EXPIRY",
      expiresAt: new Date("2031-01-01T00:00:00.000Z"),
      ledgerEntryId: null,
      metadata: {
        rewardSnapshot: {
          name: standardIssuanceReward.name,
          rewardType: "amount_off",
        },
        provisioningSnapshot: issuanceTerms,
        shopifyDiscountOwnership: standardOwnership({
          redemptionId: "redemp_mismatched_standard_expiry",
          discountCode: "WL-WRONG-EXPIRY",
        }),
      },
    };
    const mismatchedOwnershipStandardRedemption = {
      ...availableRedemption,
      id: "redemp_mismatched_standard_ownership",
      shopifyDiscountCode: "WL-WRONG-OWNERSHIP",
      ledgerEntryId: null,
      metadata: {
        rewardSnapshot: {
          name: standardIssuanceReward.name,
          rewardType: "amount_off",
        },
        provisioningSnapshot: issuanceTerms,
        // Simulates copying an otherwise valid issuance snapshot and ownership
        // object onto a different redemption row.
        shopifyDiscountOwnership:
          availableRedemption.metadata.shopifyDiscountOwnership,
      },
    };
    const referralRedemption = {
      ...availableRedemption,
      id: "redemp_referral_snapshot",
      pointsSpent: BigInt(0),
      shopifyDiscountCode: referralIssuanceTerms.discountCode,
      expiresAt: new Date(referralIssuanceTerms.expiresAt!),
      ledgerEntryId: null,
      metadata: {
        referralId: referralIdentity.referralId,
        qualificationOrderId: referralIdentity.qualificationOrderId,
        referralSide: referralIdentity.side,
        rewardSnapshot: referralIssuanceTerms,
      },
    };
    const corruptedReferralRedemption = {
      ...availableRedemption,
      id: "redemp_referral_corrupted_snapshot",
      pointsSpent: BigInt(0),
      shopifyDiscountCode: corruptedReferralIssuanceTerms.discountCode,
      expiresAt: new Date(corruptedReferralIssuanceTerms.expiresAt!),
      ledgerEntryId: null,
      metadata: {
        referralId: corruptedReferralIdentity.referralId,
        qualificationOrderId: corruptedReferralIdentity.qualificationOrderId,
        referralSide: corruptedReferralIdentity.side,
        rewardSnapshot: corruptedReferralIssuanceTerms,
      },
    };
    const usedRedemption = {
      id: "redemp_used",
      rewardDefinitionId: "reward_10_off",
      pointsSpent: BigInt(500),
      shopifyDiscountCode: "WL-USED",
      status: WeleticRedemptionStatus.used,
      orderId: "shopify-order-123",
      expiresAt: null,
      usedAt: new Date("2026-02-09T00:00:00.000Z"),
      ledgerEntryId: "ledger_used",
      metadata: { orderName: "#1001" },
      createdAt: new Date("2026-02-08T00:00:00.000Z"),
      updatedAt: new Date("2026-02-09T00:00:00.000Z"),
      rewardDefinition: {
        name: "$20 Voucher after merchant edit",
        description: "$20 off after merchant edit",
        rewardType: "amount_off",
      },
    };
    const legacyUnknownRedemption = {
      id: "redemp_legacy_unknown",
      rewardDefinitionId: "reward_10_off",
      pointsSpent: BigInt(500),
      shopifyDiscountCode: "WL-LEGACY",
      status: WeleticRedemptionStatus.cancelled,
      orderId: null,
      expiresAt: null,
      usedAt: null,
      ledgerEntryId: null,
      metadata: null,
      createdAt: new Date("2026-02-06T00:00:00.000Z"),
      updatedAt: new Date("2026-02-07T00:00:00.000Z"),
    };
    const cancelledRedemption = {
      id: "redemp_cancelled",
      rewardDefinitionId: "reward_10_off",
      pointsSpent: BigInt(500),
      shopifyDiscountCode: "WL-CANCELLED",
      status: WeleticRedemptionStatus.cancelled,
      orderId: null,
      expiresAt: null,
      usedAt: null,
      ledgerEntryId: null,
      metadata: {
        cancelledAt: "2026-02-08T00:00:00.000Z",
        rewardSnapshot: {
          name: "$10 Voucher at issuance",
          rewardType: "amount_off",
        },
      },
      createdAt: new Date("2026-02-05T00:00:00.000Z"),
      // A later recovery write must not change the customer-visible date.
      updatedAt: new Date("2026-12-01T00:00:00.000Z"),
    };

    (prisma.weleticRewardRedemption.findMany as any).mockImplementation(
      async (args: any) => {
        if (args.where.OR) {
          return [
            availableRedemption,
            mismatchedRewardStandardRedemption,
            mismatchedCustomerStandardRedemption,
            mismatchedPointsStandardRedemption,
            mismatchedExpiryStandardRedemption,
            mismatchedOwnershipStandardRedemption,
            referralRedemption,
            corruptedReferralRedemption,
          ] as any;
        }
        if (args.where.expiresAt?.lte) {
          // Defensive duplicate simulates a lifecycle transition across reads;
          // the wallet must never emit the same coupon twice.
          return [availableRedemption] as any;
        }
        if (args.where.status === WeleticRedemptionStatus.used) {
          return [usedRedemption] as any;
        }
        if (args.where.status === WeleticRedemptionStatus.cancelled) {
          return [cancelledRedemption, legacyUnknownRedemption] as any;
        }
        return [] as any;
      },
    );

    const summary = await getCustomerLoyaltySummary({
      storeId: "store_123",
      shopifyCustomerId: "cust_123",
    });

    expect(summary.isEnrolled).toBe(true);
    if (!summary.isEnrolled) {
      throw new Error("Expected an enrolled customer summary.");
    }
    expect(summary.account?.pointsBalance).toBe("500");
    expect(summary.account?.pendingPoints).toBe("50");
    expect(summary.referral?.referralCode).toBe("HIRON123");
    expect(summary.referral?.totalReferrals).toBe(13);
    expect(summary.referral?.qualifiedReferrals).toBe(2);
    expect(summary.referral?.referralShareUrl).toBe(
      "https://yamax-active.myshopify.com?ref=HIRON123",
    );
    expect(summary.program).toMatchObject({
      isActive: true,
      name: "Yamax Points",
      pointNameSingular: "Coin",
      pointNamePlural: "Coins",
      vipTimeframe: "calendar_year",
      currency: "USD",
      branding: {
        title: "Yamax Loyalty Hub",
        subtitle: "Earn and spend Yamax Coins.",
        heroImageUrl: "https://cdn.example.com/yamax-loyalty.jpg",
      },
    });
    expect(summary.tier?.allTiers).toHaveLength(2);
    expect(summary.tier?.tierExpiresAt).toEqual(
      new Date("2027-12-31T00:00:00.000Z"),
    );
    expect(summary.tier?.history).toEqual([
      expect.objectContaining({
        id: "tier-history-1",
        changeReason: "threshold_reached",
        qualifyingSpendSnapshot: "50000",
        qualifyingPointsSnapshot: "500",
      }),
    ]);
    expect(summary.referral?.offer).toMatchObject({
      advocateRewardKind: "coupon",
      advocateRewardName: "$10 Voucher",
      refereeRewardKind: "points",
      refereePointsReward: "250",
      minQualifyingOrderSubtotal: "5000",
      maxReferralsPerAdvocate: 20,
    });
    const referralRuleQuery = (
      vi.mocked(prisma.weleticShopper.findUnique).mock.calls[0][0] as any
    ).include.loyaltyAccount.include.program.include.referralRules;
    expect(referralRuleQuery).toEqual({
      where: { isActive: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 1,
    });
    expect(summary.rewards).toHaveLength(3);
    expect(summary.rewards[0].canRedeem).toBe(true);
    expect(summary.rewards[0].minOrderAmount).toBe("25000");
    expect(summary.rewards[1].canRedeem).toBe(false); // 1000 pts needed, has 500
    expect(summary.rewards[2].canRedeem).toBe(true); // incremental minimum is 500
    expect(summary.recentActivity).toHaveLength(1);
    expect(summary.recentActivity[0].pointsDelta).toBe("250");
    expect(summary.rewardWallet).toEqual([
      expect.objectContaining({
        id: "redemp_available",
        rewardName: "$10 Voucher at issuance",
        rewardDescription: "$10 off when this coupon was issued",
        salesChannel: "online_store",
        termsSource: "issuance_snapshot",
        termsSnapshot: expect.objectContaining({
          version: 1,
          rewardType: "amount_off",
          salesChannel: "online_store",
          currency: "USD",
          minOrderAmount: "5000",
          expiresInDays: 30,
          usageLimitPerCustomer: 1,
          appliesToResource: "selected_products",
          entitlementCount: 1,
          combinesWithOrderDiscounts: true,
        }),
        discountCode: "WL-AVAILABLE",
        status: "available",
        applyUrl:
          "https://yamax-active.myshopify.com/discount/WL-AVAILABLE?redirect=/cart",
      }),
      expect.objectContaining({
        id: "redemp_mismatched_standard_reward",
        rewardName: "Loyalty reward",
        rewardDescription: null,
        rewardType: "legacy",
        salesChannel: null,
        termsSource: "unavailable",
        termsSnapshot: null,
        applyUrl: null,
      }),
      expect.objectContaining({
        id: "redemp_mismatched_standard_customer",
        rewardName: "Loyalty reward",
        rewardDescription: null,
        rewardType: "legacy",
        salesChannel: null,
        termsSource: "unavailable",
        termsSnapshot: null,
      }),
      expect.objectContaining({
        id: "redemp_mismatched_standard_points",
        rewardName: "Loyalty reward",
        rewardType: "legacy",
        termsSource: "unavailable",
        termsSnapshot: null,
      }),
      expect.objectContaining({
        id: "redemp_mismatched_standard_expiry",
        rewardName: "Loyalty reward",
        rewardType: "legacy",
        termsSource: "unavailable",
        termsSnapshot: null,
      }),
      expect.objectContaining({
        id: "redemp_mismatched_standard_ownership",
        rewardName: "Loyalty reward",
        rewardType: "legacy",
        termsSource: "unavailable",
        termsSnapshot: null,
      }),
      expect.objectContaining({
        id: "redemp_referral_snapshot",
        rewardName: "Referral voucher at qualification",
        rewardDescription: "Referral terms captured when qualified",
        termsSource: "issuance_snapshot",
        termsSnapshot: expect.objectContaining({
          version: 1,
          rewardType: "amount_off",
          salesChannel: "online_store",
          currency: "EUR",
          minOrderAmount: "7500",
          expiresInDays: 30,
          usageLimitPerCustomer: 1,
          appliesToResource: "selected_products",
          entitlementCount: 1,
          combinesWithOrderDiscounts: true,
        }),
        discountCode: referralIssuanceTerms.discountCode,
        status: "available",
      }),
      expect.objectContaining({
        id: "redemp_referral_corrupted_snapshot",
        rewardName: "Loyalty reward",
        rewardDescription: null,
        rewardType: "legacy",
        termsSource: "unavailable",
        termsSnapshot: null,
        discountCode: corruptedReferralIssuanceTerms.discountCode,
        status: "available",
        applyUrl: null,
      }),
      expect.objectContaining({
        id: "redemp_used",
        rewardName: "$10 Voucher at issuance",
        termsSource: "legacy",
        termsSnapshot: null,
        discountCode: "WL-USED",
        status: "used",
        statusDate: new Date("2026-02-09T00:00:00.000Z"),
        orderId: "shopify-order-123",
        orderName: "#1001",
        applyUrl: null,
      }),
      expect.objectContaining({
        id: "redemp_cancelled",
        rewardName: "$10 Voucher at issuance",
        status: "cancelled",
        statusDate: new Date("2026-02-08T00:00:00.000Z"),
      }),
      expect.objectContaining({
        id: "redemp_legacy_unknown",
        rewardName: "Loyalty reward",
        rewardDescription: null,
        rewardType: "legacy",
        termsSource: "legacy",
        termsSnapshot: null,
        status: "cancelled",
        statusDate: null,
      }),
    ]);
    const issuedTermsSnapshot = summary.rewardWallet.find(
      (reward) => reward.id === "redemp_available",
    )?.termsSnapshot;
    expect(issuedTermsSnapshot).not.toHaveProperty("customerSelectionDigest");
    expect(issuedTermsSnapshot).not.toHaveProperty("contentDigest");
    expect(issuedTermsSnapshot).not.toHaveProperty("entitledProductIds");
    expect(JSON.stringify(issuedTermsSnapshot)).not.toContain(
      issuanceTerms.customerSelectionDigest,
    );
    const referralTermsSnapshot = summary.rewardWallet.find(
      (reward) => reward.id === "redemp_referral_snapshot",
    )?.termsSnapshot;
    expect(referralTermsSnapshot).not.toHaveProperty("customerSelectionDigest");
    expect(referralTermsSnapshot).not.toHaveProperty("contentDigest");
    expect(referralTermsSnapshot).not.toHaveProperty("discountCode");
    expect(referralTermsSnapshot).not.toHaveProperty("ownershipFingerprint");
    expect(JSON.stringify(referralTermsSnapshot)).not.toContain(
      referralIssuanceTerms.customerSelectionDigest,
    );
    expect(
      (summary.rewardWallet as Array<{ id: string }>).filter(
        (reward) => reward.id === "redemp_available",
      ),
    ).toHaveLength(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "RepeatableRead",
    });
    expect(prisma.weleticRewardRedemption.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: "store_123",
          accountId: "acc_1",
          status: {
            in: expect.arrayContaining([WeleticRedemptionStatus.issued]),
          },
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        }),
      }),
    );
    expect(
      (
        vi.mocked(prisma.weleticRewardRedemption.findMany).mock
          .calls[0][0] as any
      ).take,
    ).toBeUndefined();
    expect(prisma.weleticRewardRedemption.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: "store_123",
          accountId: "acc_1",
          status: WeleticRedemptionStatus.used,
        }),
        orderBy: [{ usedAt: "desc" }, { updatedAt: "desc" }],
        take: 50,
      }),
    );
    expect(prisma.weleticRewardRedemption.findMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: "store_123",
          accountId: "acc_1",
          status: WeleticRedemptionStatus.expired,
        }),
        orderBy: [{ expiresAt: "desc" }, { updatedAt: "desc" }],
        take: 50,
      }),
    );
    expect(prisma.weleticRewardRedemption.findMany).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: "store_123",
          accountId: "acc_1",
          status: WeleticRedemptionStatus.cancelled,
        }),
        orderBy: { updatedAt: "desc" },
        take: 50,
      }),
    );
    expect(prisma.weleticRewardRedemption.findMany).toHaveBeenNthCalledWith(
      5,
      expect.objectContaining({
        where: expect.objectContaining({
          storeId: "store_123",
          accountId: "acc_1",
          status: {
            in: expect.arrayContaining([WeleticRedemptionStatus.issued]),
          },
          expiresAt: { lte: expect.any(Date) },
        }),
        orderBy: { expiresAt: "desc" },
        take: 50,
      }),
    );
    const rewardQueryContract = JSON.stringify(
      vi.mocked(prisma.weleticRewardRedemption.findMany).mock.calls,
    );
    expect(rewardQueryContract).not.toContain(
      WeleticRedemptionStatus.provisioning,
    );
    expect(rewardQueryContract).not.toContain(WeleticRedemptionStatus.failed);
  });

  it("redeems points for discount voucher successfully", async () => {
    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValue({
      id: "shop_1",
      storeId: "store_123",
      shopifyCustomerId: "cust_123",
      loyaltyAccount: {
        id: "acc_1",
        storeId: "store_123",
        status: "active",
        cachedPointsBalance: BigInt(500),
      },
    } as any);

    vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
      id: "acc_1",
      storeId: "store_123",
      status: "active",
      cachedPointsBalance: BigInt(500),
      cachedPendingPoints: BigInt(0),
      lifetimePointsEarned: BigInt(500),
      lifetimePointsRedeemed: BigInt(0),
      ledgerVersion: 2,
      shopper: { shopifyCustomerId: "gid://shopify/Customer/123" },
      program: {
        id: "prog_1",
        status: "active",
        killSwitchActive: false,
      },
    } as any);
    vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
      id: "acc_1",
      storeId: "store_123",
      status: "active",
      metadata: null,
      shopper: { shopifyCustomerId: "cust_123" },
      store: { projectId: "workspace_123" },
    } as any);

    const fixedReward = {
      id: "reward_10",
      storeId: "store_123",
      name: "$10 Discount",
      rewardType: "amount_off",
      pointsCost: BigInt(200),
      discountValue: 1000,
      exchangeType: "fixed",
      minPointsCost: null,
      maxPointsCost: null,
      pointsStep: null,
      expiresInDays: null,
      status: "active",
    } as any;
    vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValue(
      fixedReward,
    );
    vi.mocked(prisma.weleticRewardDefinition.findUnique).mockResolvedValue(
      fixedReward,
    );

    let redemptionState: any = {
      id: "redemp_1",
      storeId: "store_123",
      accountId: "acc_1",
      rewardDefinitionId: "reward_10",
      pointsSpent: BigInt(200),
      shopifyDiscountCode: "WL-DISCOUNT10",
      status: "provisioning",
      expiresAt: null,
      ledgerEntryId: null,
    };

    (prisma.weleticRewardRedemption.create as any).mockImplementation(
      async ({ data }: any) => {
        redemptionState = { ...redemptionState, ...data };
        return redemptionState;
      },
    );
    (prisma.weleticRewardRedemption.update as any).mockImplementation(
      async ({ data }: any) => {
        redemptionState = { ...redemptionState, ...data };
        return redemptionState;
      },
    );
    (prisma.weleticRewardRedemption.findUnique as any).mockImplementation(
      async ({ where }: any) =>
        where?.storeId_idempotencyKey ? null : redemptionState,
    );

    vi.mocked(prisma.weleticPointsLedgerEntry.findFirst).mockResolvedValue({
      sequenceNumber: 2,
      balanceAfter: BigInt(500),
    } as any);

    const ledgerEntry = {
      id: "ledger_redeem_1",
      sequenceNumber: 3,
      pointsDelta: BigInt(-200),
      balanceAfter: BigInt(300),
    } as any;
    vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValue(
      ledgerEntry,
    );
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockImplementation(
      async ({ where }: any) => (where?.id ? ledgerEntry : null),
    );

    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = "shpat_test_token";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: {
                id: "gid://shopify/DiscountCodeNode/10",
                codeDiscount: {
                  title: "$10 Discount (WL-DISCOUNT10)",
                  status: "ACTIVE",
                  codes: { nodes: [{ code: "WL-DISCOUNT10" }] },
                },
              },
              userErrors: [],
            },
          },
        }),
      }),
    );

    const result = await redeemCustomerPoints({
      storeId: "store_123",
      shopifyCustomerId: "cust_123",
      rewardDefinitionId: "reward_10",
      discountCode: "WL-DISCOUNT10",
      idempotencyKey: "customer-redeem-success-1",
    });

    expect(result.success).toBe(true);
    expect(result.discountCode).toBe("WL-DISCOUNT10");
    expect(result.pointsSpent).toBe("200");
    expect(result.newBalance).toBe("300");
    expect(prisma.weleticRewardRedemption.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          rewardSnapshot: {
            name: "$10 Discount",
            rewardType: "amount_off",
          },
          provisioningSnapshot: expect.objectContaining({
            rewardDefinitionId: "reward_10",
            pointsCost: "200",
          }),
          shopifyDiscountOwnership: expect.objectContaining({
            version: 1,
          }),
        }),
      }),
    });
    expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          rewardName: "$10 Discount",
          rewardType: "amount_off",
        }),
      }),
    });
  });

  it("enforces the configured Shopify sales channel before redemption", async () => {
    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValue({
      id: "shopper_channel",
      storeId: "store_123",
      email: "channel@example.com",
      shopifyCustomerId: "cust_channel",
      loyaltyAccount: { id: "acc_channel" },
    } as any);
    vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValue({
      id: "reward_online_only",
      storeId: "store_123",
      name: "Online only",
      rewardType: "amount_off",
      salesChannel: "online_store",
      exchangeType: "fixed",
      pointsCost: BigInt(100),
      discountValue: 500,
      status: "active",
    } as any);

    await expect(
      redeemCustomerPoints({
        storeId: "store_123",
        shopifyCustomerId: "cust_channel",
        rewardDefinitionId: "reward_online_only",
        idempotencyKey: "pos-channel-guard-1",
        redemptionChannel: "pos",
      }),
    ).rejects.toThrow("Reward is not available in Shopify POS.");
    expect(prisma.weleticRewardRedemption.create).not.toHaveBeenCalled();
  });

  it("treats an internal redemption without a trusted POS channel as online", async () => {
    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValue({
      id: "shopper_online_channel",
      storeId: "store_123",
      email: "online@example.com",
      shopifyCustomerId: "cust_online_channel",
      loyaltyAccount: { id: "acc_online_channel" },
    } as any);
    vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValue({
      id: "reward_pos_only",
      storeId: "store_123",
      name: "POS only",
      rewardType: "amount_off",
      salesChannel: "pos",
      exchangeType: "fixed",
      pointsCost: BigInt(100),
      discountValue: 500,
      status: "active",
    } as any);

    await expect(
      redeemCustomerPoints({
        storeId: "store_123",
        shopifyCustomerId: "cust_online_channel",
        rewardDefinitionId: "reward_pos_only",
        idempotencyKey: "online-channel-guard-1",
      }),
    ).rejects.toThrow("Reward is only available in Shopify POS.");
    expect(prisma.weleticRewardRedemption.create).not.toHaveBeenCalled();
  });

  it("binds customer referral code successfully", async () => {
    vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValue({
      id: "shop_referee",
      storeId: "store_123",
      shopifyCustomerId: "cust_referee",
      loyaltyAccount: {
        id: "acc_referee",
        storeId: "store_123",
      },
    } as any);

    vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
      id: "acc_advocate",
      storeId: "store_123",
      shopperId: "shop_advocate",
      referralCode: "ADVOCATE777",
      status: "active",
      shopper: { firstName: "Advocate" },
    } as any);

    vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
      id: "acc_referee",
      storeId: "store_123",
      shopperId: "shop_referee",
      referredById: null,
      status: "active",
    } as any);

    vi.mocked(prisma.weleticLoyaltyReferralRule.findFirst).mockResolvedValue({
      id: "rule_1",
      programId: "prog_1",
      isActive: true,
      advocatePointsReward: BigInt(100),
      refereePointsReward: BigInt(50),
    } as any);

    vi.mocked(prisma.weleticLoyaltyReferral.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.weleticLoyaltyReferral.create).mockResolvedValue({
      id: "ref_1",
      storeId: "store_123",
      advocateAccountId: "acc_advocate",
      refereeShopperId: "shop_referee",
      refereeAccountId: "acc_referee",
      status: "pending",
    } as any);

    const result = await bindCustomerReferral({
      storeId: "store_123",
      shopifyCustomerId: "cust_referee",
      referralCode: "ADVOCATE777",
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe("pending");
    expect(result.status).toBe("pending");
  });
});
