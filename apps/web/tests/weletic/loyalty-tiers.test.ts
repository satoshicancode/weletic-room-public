import { calculateEligibleOrderPoints } from "@/lib/weletic/loyalty/earn";
import { describe, expect, it } from "vitest";

describe("Weletic Customer Loyalty VIP Tiers Engine", () => {
  interface SimulatedTier {
    id: string;
    name: string;
    slug: string;
    tierOrder: number;
    minSpendThreshold: bigint;
    minPointsThreshold: bigint;
    pointsMultiplier: number;
    entryBonusPoints: bigint;
    perks: string[];
  }

  interface SimulatedAccount {
    id: string;
    storeId: string;
    currentTierId: string;
    rolling12mSpend: bigint;
    lifetimePointsEarned: bigint;
    balance: bigint;
  }

  interface SimulatedTierHistory {
    id: string;
    accountId: string;
    fromTierId: string | null;
    toTierId: string;
    changeReason: string;
    effectiveAt: Date;
  }

  const createTierTestHarness = () => {
    const tiers: SimulatedTier[] = [
      {
        id: "tier_bronze",
        name: "Bronze",
        slug: "bronze",
        tierOrder: 1,
        minSpendThreshold: BigInt(0),
        minPointsThreshold: BigInt(0),
        pointsMultiplier: 1.0,
        entryBonusPoints: BigInt(0),
        perks: ["1x points per dollar", "Birthday gift"],
      },
      {
        id: "tier_silver",
        name: "Silver",
        slug: "silver",
        tierOrder: 2,
        minSpendThreshold: BigInt(20000), // $200
        minPointsThreshold: BigInt(200),
        pointsMultiplier: 1.25,
        entryBonusPoints: BigInt(50),
        perks: ["1.25x points per dollar", "Free standard shipping"],
      },
      {
        id: "tier_gold",
        name: "Gold",
        slug: "gold",
        tierOrder: 3,
        minSpendThreshold: BigInt(50000), // $500
        minPointsThreshold: BigInt(500),
        pointsMultiplier: 1.5,
        entryBonusPoints: BigInt(100),
        perks: [
          "1.5x points per dollar",
          "Free express shipping",
          "VIP exclusive drops",
        ],
      },
    ];

    const accounts = new Map<string, SimulatedAccount>();
    const history: SimulatedTierHistory[] = [];

    const evaluateTier = (accountId: string) => {
      const account = accounts.get(accountId);
      if (!account) throw new Error("Account not found");

      const sortedTiers = [...tiers].sort((a, b) => b.tierOrder - a.tierOrder);
      let qualifyingTier = sortedTiers[sortedTiers.length - 1];

      for (const tier of sortedTiers) {
        const spendPassed = account.rolling12mSpend >= tier.minSpendThreshold;
        const pointsPassed =
          account.lifetimePointsEarned >= tier.minPointsThreshold;

        if (spendPassed && pointsPassed) {
          qualifyingTier = tier;
          break;
        }
      }

      const previousTier = tiers.find((t) => t.id === account.currentTierId);
      const tierChanged =
        !previousTier || previousTier.id !== qualifyingTier.id;

      if (tierChanged) {
        const isUpgrade =
          !previousTier || qualifyingTier.tierOrder > previousTier.tierOrder;

        history.push({
          id: `th_${history.length + 1}`,
          accountId,
          fromTierId: previousTier ? previousTier.id : null,
          toTierId: qualifyingTier.id,
          changeReason: "threshold_reached",
          effectiveAt: new Date(),
        });

        account.currentTierId = qualifyingTier.id;

        if (isUpgrade && qualifyingTier.entryBonusPoints > BigInt(0)) {
          account.balance += qualifyingTier.entryBonusPoints;
        }
      }

      const nextTier =
        tiers
          .filter((t) => t.tierOrder > qualifyingTier.tierOrder)
          .sort((a, b) => a.tierOrder - b.tierOrder)[0] || null;

      let progress: {
        nextTierName: string;
        spendRemaining: bigint;
        pointsRemaining: bigint;
      } | null = null;
      if (nextTier) {
        progress = {
          nextTierName: nextTier.name,
          spendRemaining:
            nextTier.minSpendThreshold > account.rolling12mSpend
              ? nextTier.minSpendThreshold - account.rolling12mSpend
              : BigInt(0),
          pointsRemaining:
            nextTier.minPointsThreshold > account.lifetimePointsEarned
              ? nextTier.minPointsThreshold - account.lifetimePointsEarned
              : BigInt(0),
        };
      }

      return {
        currentTier: qualifyingTier,
        tierChanged,
        nextTier,
        progress,
      };
    };

    return {
      tiers,
      accounts,
      history,
      evaluateTier,
    };
  };

  it("evaluates account tier progression and awards upgrade bonus points", () => {
    const harness = createTierTestHarness();

    // 1. Initial Bronze account
    harness.accounts.set("acc_1", {
      id: "acc_1",
      storeId: "store_1",
      currentTierId: "tier_bronze",
      rolling12mSpend: BigInt(0),
      lifetimePointsEarned: BigInt(0),
      balance: BigInt(0),
    });

    const res1 = harness.evaluateTier("acc_1");
    expect(res1.currentTier.name).toBe("Bronze");
    expect(res1.tierChanged).toBe(false);
    expect(res1.nextTier?.name).toBe("Silver");
    expect(res1.progress?.spendRemaining).toBe(BigInt(20000)); // $200 remaining

    // 2. Member spends $250 and earns 250 points -> Silver Upgrade
    const account = harness.accounts.get("acc_1")!;
    account.rolling12mSpend = BigInt(25000);
    account.lifetimePointsEarned = BigInt(250);

    const res2 = harness.evaluateTier("acc_1");
    expect(res2.tierChanged).toBe(true);
    expect(res2.currentTier.name).toBe("Silver");
    expect(res2.nextTier?.name).toBe("Gold");
    expect(res2.progress?.spendRemaining).toBe(BigInt(25000)); // $500 - $250 = $250 remaining
    expect(account.balance).toBe(BigInt(50)); // Received 50 points entry bonus

    // 3. Member spends additional $300 (total $550 spend, 550 points) -> Gold Upgrade
    account.rolling12mSpend = BigInt(55000);
    account.lifetimePointsEarned = BigInt(550);

    const res3 = harness.evaluateTier("acc_1");
    expect(res3.tierChanged).toBe(true);
    expect(res3.currentTier.name).toBe("Gold");
    expect(res3.nextTier).toBeNull(); // Reached highest tier
    expect(account.balance).toBe(BigInt(150)); // 50 (Silver) + 100 (Gold) = 150 points

    // 4. Verify audit history records
    expect(harness.history).toHaveLength(2);
    expect(harness.history[0].toTierId).toBe("tier_silver");
    expect(harness.history[1].toTierId).toBe("tier_gold");
  });

  it("calculates order points earning multiplied by VIP tier rate", () => {
    // Standard rate = 1 point per $1
    // Bronze: 1.0x -> $100 = 100 points
    const bronzePoints = calculateEligibleOrderPoints({
      netAmountCents: BigInt(10000), // $100
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.0,
    });
    expect(bronzePoints).toBe(BigInt(100));

    // Silver: 1.25x -> $100 = 125 points
    const silverPoints = calculateEligibleOrderPoints({
      netAmountCents: BigInt(10000), // $100
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.25,
    });
    expect(silverPoints).toBe(BigInt(125));

    // Gold: 1.5x -> $100 = 150 points
    const goldPoints = calculateEligibleOrderPoints({
      netAmountCents: BigInt(10000), // $100
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.5,
    });
    expect(goldPoints).toBe(BigInt(150));

    // Gold with JPY (zero-decimal currency): ¥10,000 * 1.5 = 15,000 points
    const goldJpyPoints = calculateEligibleOrderPoints({
      netAmountCents: BigInt(10000), // ¥10,000
      currency: "JPY",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.5,
    });
    expect(goldJpyPoints).toBe(BigInt(15000));
  });
});
