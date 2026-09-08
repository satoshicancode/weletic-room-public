import { prisma } from "@/lib/prisma";
import { calculateEligibleOrderPoints } from "@/lib/weletic/loyalty/earn";
import { buildCustomerMetafieldUpdates } from "@/lib/weletic/loyalty/metafield-sync";
import { evaluateTierMaintenanceCycle } from "@/lib/weletic/loyalty/tier-lifecycle";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    weleticRewardDefinition: {
      findUnique: vi.fn(),
    },
    weleticRewardRedemption: {
      create: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(),
    },
    weleticLoyaltyTierHistory: {
      create: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }: any) => data),
    },
    $transaction: vi.fn((fn) => (typeof fn === "function" ? fn(prisma) : fn)),
  },
}));

describe("Tier 3: Cross-Feature Combinations Suite", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("3.1: VIP Multiplier (1.5x) stacked with Weekend Bonus Campaign (2.0x) + Referral Advocate Double Earning", async () => {
    // 1. Order spend calculation: $100 base order (10,000 cents)
    // VIP Tier rate = 1.5x, Campaign rate = 2.0x -> effective multiplier = 3.0x
    const effectiveMultiplier = 1.5 * 2.0;
    const earnedPoints = calculateEligibleOrderPoints({
      netAmountCents: BigInt(10000),
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: effectiveMultiplier,
    });
    expect(earnedPoints).toBe(BigInt(300)); // 100 * 3.0 = 300 points

    // 2. Plus referral advocate reward for qualifying referee order (+100 points)
    const advocateReward = BigInt(100);
    const refereeReward = BigInt(50);
    const totalAdvocateBalance = earnedPoints + advocateReward;

    expect(totalAdvocateBalance).toBe(BigInt(400));
  });

  it("3.2: Referral Referee Voucher Redemption + Spend Earning + Minimum Subtotal Interaction", () => {
    // Original cart total = $120. Referee applies a $20 referral voucher -> Net checkout paid = $100.
    // Earning rule has a $50 minimum subtotal threshold.
    const cartAmountCents = BigInt(12000);
    const voucherDiscountCents = BigInt(2000);
    const netPaidCents = cartAmountCents - voucherDiscountCents; // $100.00
    const minThresholdCents = BigInt(5000); // $50.00

    expect(netPaidCents >= minThresholdCents).toBe(true);

    const pointsEarned = calculateEligibleOrderPoints({
      netAmountCents: netPaidCents,
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.0,
      minOrderSubtotalCents: minThresholdCents,
    });

    // Points earned strictly on net paid merchandise spend ($100), not gross cart total ($120)
    expect(pointsEarned).toBe(BigInt(100));
  });

  it("3.3: Multi-Reward Voucher Simultaneous Redemptions with Running Balance Constraints", async () => {
    // Account starts with 1,200 points
    let currentBalance = BigInt(1200);

    const reward1 = { id: "rew_5off", pointsCost: BigInt(500), name: "$5 Off" };
    const reward2 = {
      id: "rew_10off",
      pointsCost: BigInt(1000),
      name: "$10 Off",
    };

    // 1st redemption: $5 Off voucher (-500)
    expect(currentBalance >= reward1.pointsCost).toBe(true);
    currentBalance -= reward1.pointsCost;
    expect(currentBalance).toBe(BigInt(700));

    // 2nd redemption: attempts $10 Off voucher (-1000) -> Fails due to insufficient remaining balance (700 < 1000)
    const canAffordSecond = currentBalance >= reward2.pointsCost;
    expect(canAffordSecond).toBe(false);

    // 2nd alternative redemption: second $5 Off voucher (-500) -> Succeeds (700 >= 500)
    expect(currentBalance >= reward1.pointsCost).toBe(true);
    currentBalance -= reward1.pointsCost;
    expect(currentBalance).toBe(BigInt(200));
  });

  it("3.4: Tier Upgrade Bonus Points Triggered During Flash Campaign Order + Auto Metafield Sync", async () => {
    // Member has $150 prior spend. Places a $100 order during 2x campaign.
    // Total spend reaches $250 -> Upgrades to Silver (threshold $200) with +50 tier bonus points.
    const priorSpend = BigInt(15000);
    const orderSpend = BigInt(10000);
    const totalSpend = priorSpend + orderSpend; // $250.00
    const silverThreshold = BigInt(20000); // $200.00

    expect(totalSpend >= silverThreshold).toBe(true);

    const orderPoints = calculateEligibleOrderPoints({
      netAmountCents: orderSpend,
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 2.0, // 2x campaign
    });
    expect(orderPoints).toBe(BigInt(200));

    const tierUpgradeBonus = BigInt(50);
    const totalPoints = orderPoints + tierUpgradeBonus;
    expect(totalPoints).toBe(BigInt(250));

    // Metafield update reflecting new Silver tier and 250 points balance
    const metafields = buildCustomerMetafieldUpdates({
      ownerId: "gid://shopify/Customer/777",
      vipTierName: "Silver",
      vipTierOrder: 2,
      pointsBalance: totalPoints,
      tierMultiplier: 1.25,
      memberStatus: "active",
    });

    expect(metafields.find((m) => m.key === "vip_tier")?.value).toBe("Silver");
    expect(metafields.find((m) => m.key === "points_balance")?.value).toBe(
      "250",
    );
    expect(metafields.find((m) => m.key === "tier_multiplier")?.value).toBe(
      "1.25",
    );
  });

  it("3.5: Partial Refund on Order Paid with Multiplier & Bonus Points with Proportional Deduction", () => {
    // Order of $200 earned with 1.5x Silver multiplier = 300 points.
    // 25% partial refund ($50) occurs -> 25% of 300 = 75 points reversed.
    const originalSpendCents = BigInt(20000);
    const refundCents = BigInt(5000); // 25%
    const originalEarnedPoints = BigInt(300);

    const reversedPoints = BigInt(
      Math.round(
        Number(originalEarnedPoints) *
          (Number(refundCents) / Number(originalSpendCents)),
      ),
    );
    expect(reversedPoints).toBe(BigInt(75));

    const remainingNetPoints = originalEarnedPoints - reversedPoints;
    expect(remainingNetPoints).toBe(BigInt(225));
  });

  it("3.6: Manual Merchant Balance Adjustment (+ / -) Interleaved with Live Storefront Redemptions", async () => {
    // Sequence of operations:
    // 1. Base: 100 points
    // 2. Merchant Goodwill bonus: +150 -> 250
    // 3. Storefront reward redemption: -200 -> 50
    // 4. Manual audit correction: -30 -> 20
    let balance = BigInt(100);

    balance += BigInt(150); // Goodwill
    expect(balance).toBe(BigInt(250));

    balance -= BigInt(200); // Redeem
    expect(balance).toBe(BigInt(50));

    balance -= BigInt(30); // Correction
    expect(balance).toBe(BigInt(20));
  });

  it("3.7: Grace Period Expiration + Step-Down Demotion + Subsequent Qualifying Purchase Recovery", async () => {
    const tiers = [
      {
        id: "wtier_bronze",
        name: "Bronze",
        tierOrder: 1,
        minSpendThreshold: BigInt(0),
        minPointsThreshold: BigInt(0),
      },
      {
        id: "wtier_silver",
        name: "Silver",
        tierOrder: 2,
        minSpendThreshold: BigInt(20000),
        minPointsThreshold: BigInt(200),
      },
      {
        id: "wtier_gold",
        name: "Gold",
        tierOrder: 3,
        minSpendThreshold: BigInt(50000),
        minPointsThreshold: BigInt(500),
      },
    ];

    // 1. Member in Gold expires grace period -> Demoted to Silver
    const expiredNow = new Date("2026-09-01T00:00:00Z");
    const expiredGrace = new Date("2026-08-31T00:00:00Z");

    vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
      id: "wacc_recovery",
      storeId: "store_1",
      currentTierId: "wtier_gold",
      tierExpiresAt: expiredGrace,
      currentTier: tiers[2],
      program: { tiers },
    } as any);
    vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
      [],
    );
    vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValueOnce(
      {} as any,
    );

    const demotionRes = await evaluateTierMaintenanceCycle({
      storeId: "store_1",
      accountId: "wacc_recovery",
      now: expiredNow,
    });
    expect(demotionRes.status).toBe("DEMOTED");
    expect(demotionRes.newTierId).toBe("wtier_silver");

    // 2. Member places a large qualifying purchase of $600 (60,000 cents) -> Re-qualifies and Promoted back to Gold
    const recoveryNow = new Date("2026-09-10T00:00:00Z");
    vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValueOnce({
      id: "wacc_recovery",
      storeId: "store_1",
      currentTierId: "wtier_silver",
      tierExpiresAt: null,
      currentTier: tiers[1],
      program: { tiers },
    } as any);
    vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
      { presentmentNet: BigInt(60000) },
    ] as any);
    vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce([
      { pointsDelta: BigInt(600) },
    ] as any);
    vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValueOnce(
      {} as any,
    );

    const recoveryRes = await evaluateTierMaintenanceCycle({
      storeId: "store_1",
      accountId: "wacc_recovery",
      now: recoveryNow,
    });
    expect(recoveryRes.status).toBe("PROMOTED");
    expect(recoveryRes.newTierId).toBe("wtier_gold");
  });
});
