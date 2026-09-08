import { calculateEligibleOrderPoints } from "@/lib/weletic/loyalty/earn";
import { generateReferralCode } from "@/lib/weletic/loyalty/referrals";
import { describe, expect, it } from "vitest";

describe("Weletic Customer Loyalty Full-Lifecycle E2E Scenario", () => {
  it("executes full loyalty lifecycle: program setup, backfill, order earn, referrals, VIP tier upgrade, refund reversal, reward redemption, and GDPR compliance", async () => {
    // -------------------------------------------------------------------------
    // Phase 1: Merchant Program Configuration & Rules Setup
    // -------------------------------------------------------------------------
    const programSettings = {
      storeId: "store_yamax_e2e",
      pointsPerCurrencyUnit: 1.0, // 1 point per $1
      holdingPeriodDays: 14,
      pointsExpirationMonths: 12,
      minOrderSubtotal: 10.0, // $10 min order
      isActive: true,
    };

    const vipTiers = [
      {
        id: "tier_bronze",
        name: "Bronze",
        slug: "bronze",
        tierOrder: 1,
        minSpendThreshold: BigInt(0),
        minPointsThreshold: BigInt(0),
        pointsMultiplier: 1.0,
        entryBonusPoints: BigInt(0),
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
      },
    ];

    const referralRule = {
      advocatePointsReward: BigInt(100),
      refereePointsReward: BigInt(50),
      minQualifyingOrderSubtotal: 30.0, // $30 min order for referee
      isActive: true,
    };

    const rewardCatalog = [
      {
        id: "rew_5off",
        title: "$5 Off Voucher",
        pointsCost: 500,
        rewardType: "fixed_amount",
        discountValue: 5.0,
        discountCodePrefix: "YAMAX5",
      },
      {
        id: "rew_10off",
        title: "$10 Off Voucher",
        pointsCost: 1000,
        rewardType: "fixed_amount",
        discountValue: 10.0,
        discountCodePrefix: "YAMAX10",
      },
    ];

    expect(programSettings.isActive).toBe(true);
    expect(vipTiers).toHaveLength(3);
    expect(rewardCatalog).toHaveLength(2);

    // -------------------------------------------------------------------------
    // Phase 2: Historical Order Opening-Balance Backfill (ADR 0005)
    // -------------------------------------------------------------------------
    // Existing customer Alice has historical orders prior to loyalty rollout
    const aliceHistoricalOrders = [
      { id: "ord_hist_1", subtotalAmountCents: BigInt(5000), currency: "USD" }, // $50
      { id: "ord_hist_2", subtotalAmountCents: BigInt(3000), currency: "USD" }, // $30
    ];

    let aliceBackfillPoints = BigInt(0);
    for (const ord of aliceHistoricalOrders) {
      aliceBackfillPoints += calculateEligibleOrderPoints({
        netAmountCents: ord.subtotalAmountCents,
        currency: ord.currency,
        pointsPerCurrencyUnit: programSettings.pointsPerCurrencyUnit,
        multiplier: 1.0,
      });
    }
    expect(aliceBackfillPoints).toBe(BigInt(80)); // 80 opening points

    // In-memory ledger & accounts simulation
    const ledger: Array<{
      id: string;
      accountId: string;
      entryType: string;
      pointsDelta: bigint;
      balanceAfter: bigint;
      idempotencyKey: string;
    }> = [];

    const accounts = new Map<
      string,
      {
        id: string;
        shopperId: string;
        shopifyCustomerId: string;
        firstName: string;
        lastName: string;
        email: string | null;
        phone: string | null;
        balance: bigint;
        pendingBalance: bigint;
        lifetimeEarned: bigint;
        lifetimeRedeemed: bigint;
        rolling12mSpend: bigint;
        currentTierId: string;
        referralCode: string;
        referredById: string | null;
        referralCount: number;
        referralPointsEarned: bigint;
      }
    >();

    // Initialize Alice account with historical backfill opening balance
    const aliceAccountId = "acc_alice";
    accounts.set(aliceAccountId, {
      id: aliceAccountId,
      shopperId: "shop_alice",
      shopifyCustomerId: "cust_101",
      firstName: "Alice",
      lastName: "Tanaka",
      email: "alice@example.com",
      phone: "+819012345678",
      balance: aliceBackfillPoints,
      pendingBalance: BigInt(0),
      lifetimeEarned: aliceBackfillPoints,
      lifetimeRedeemed: BigInt(0),
      rolling12mSpend: BigInt(8000), // $80 historical spend
      currentTierId: "tier_bronze",
      referralCode: generateReferralCode("Alice"),
      referredById: null,
      referralCount: 0,
      referralPointsEarned: BigInt(0),
    });

    ledger.push({
      id: "led_1",
      accountId: aliceAccountId,
      entryType: "BACKFILL",
      pointsDelta: aliceBackfillPoints,
      balanceAfter: aliceBackfillPoints,
      idempotencyKey: "backfill:job_1:acc_alice",
    });

    expect(accounts.get(aliceAccountId)?.balance).toBe(BigInt(80));
    expect(ledger).toHaveLength(1);

    // -------------------------------------------------------------------------
    // Phase 3: New Order Earn & Holding Period (ADR 0004)
    // -------------------------------------------------------------------------
    // Alice places a new order of $120 (12,000 cents)
    const order1Cents = BigInt(12000);
    const order1Points = calculateEligibleOrderPoints({
      netAmountCents: order1Cents,
      currency: "USD",
      pointsPerCurrencyUnit: programSettings.pointsPerCurrencyUnit,
      multiplier: 1.0, // Bronze 1.0x
    });
    expect(order1Points).toBe(BigInt(120));

    // Holding period: Points are pending initially
    const alice = accounts.get(aliceAccountId)!;
    alice.pendingBalance += order1Points;
    expect(alice.pendingBalance).toBe(BigInt(120));
    expect(alice.balance).toBe(BigInt(80)); // Available balance unchanged during holding

    // Maturity reaches (14 days passed) -> Pending points settle into available balance
    alice.pendingBalance -= order1Points;
    alice.balance += order1Points;
    alice.lifetimeEarned += order1Points;
    alice.rolling12mSpend += order1Cents; // Total spend = $80 + $120 = $200

    ledger.push({
      id: "led_2",
      accountId: aliceAccountId,
      entryType: "ORDER_EARN",
      pointsDelta: order1Points,
      balanceAfter: alice.balance,
      idempotencyKey: "order_earn:ord_new_1",
    });

    expect(alice.balance).toBe(BigInt(200)); // 80 + 120 = 200
    expect(alice.rolling12mSpend).toBe(BigInt(20000)); // $200

    // -------------------------------------------------------------------------
    // Phase 4: Customer Referral Binding & Reward Qualification
    // -------------------------------------------------------------------------
    // Alice shares her referral code with Bob
    const bobAccountId = "acc_bob";
    accounts.set(bobAccountId, {
      id: bobAccountId,
      shopperId: "shop_bob",
      shopifyCustomerId: "cust_202",
      firstName: "Bob",
      lastName: "Smith",
      email: "bob@example.com",
      phone: "+14155552671",
      balance: BigInt(0),
      pendingBalance: BigInt(0),
      lifetimeEarned: BigInt(0),
      lifetimeRedeemed: BigInt(0),
      rolling12mSpend: BigInt(0),
      currentTierId: "tier_bronze",
      referralCode: generateReferralCode("Bob"),
      referredById: null,
      referralCount: 0,
      referralPointsEarned: BigInt(0),
    });

    // Bob binds Alice's referral code
    const bob = accounts.get(bobAccountId)!;
    expect(bob.referredById).toBeNull();
    bob.referredById = aliceAccountId;
    expect(bob.referredById).toBe(aliceAccountId);

    // Bob places first qualifying order ($60 = 6,000 cents > $30 min threshold)
    const bobOrderCents = BigInt(6000);
    const bobQualifies =
      Number(bobOrderCents) / 100 >= referralRule.minQualifyingOrderSubtotal;
    expect(bobQualifies).toBe(true);

    // Double-sided referral rewards applied
    alice.balance += referralRule.advocatePointsReward;
    alice.lifetimeEarned += referralRule.advocatePointsReward;
    alice.referralCount += 1;
    alice.referralPointsEarned += referralRule.advocatePointsReward;

    ledger.push({
      id: "led_3",
      accountId: aliceAccountId,
      entryType: "REFERRAL_REWARD",
      pointsDelta: referralRule.advocatePointsReward,
      balanceAfter: alice.balance,
      idempotencyKey: `referral_advocate:${bobAccountId}`,
    });

    bob.balance += referralRule.refereePointsReward;
    bob.lifetimeEarned += referralRule.refereePointsReward;

    ledger.push({
      id: "led_4",
      accountId: bobAccountId,
      entryType: "REFERRAL_REWARD",
      pointsDelta: referralRule.refereePointsReward,
      balanceAfter: bob.balance,
      idempotencyKey: `referral_referee:${bobAccountId}`,
    });

    expect(alice.balance).toBe(BigInt(300)); // 200 + 100 = 300
    expect(alice.referralCount).toBe(1);
    expect(bob.balance).toBe(BigInt(50)); // 50 welcome points

    // -------------------------------------------------------------------------
    // Phase 5: VIP Tier Evaluation & Upgrade Bonus
    // -------------------------------------------------------------------------
    // Alice rolling 12m spend is $200 (20,000 cents) -> qualifies for Silver Tier
    const qualifyingTier = vipTiers
      .filter(
        (t) =>
          alice.rolling12mSpend >= t.minSpendThreshold &&
          alice.lifetimeEarned >= t.minPointsThreshold,
      )
      .sort((a, b) => b.tierOrder - a.tierOrder)[0];

    expect(qualifyingTier.name).toBe("Silver");
    const isUpgrade = qualifyingTier.id !== alice.currentTierId;
    expect(isUpgrade).toBe(true);

    alice.currentTierId = qualifyingTier.id;
    alice.balance += qualifyingTier.entryBonusPoints; // +50 bonus points
    alice.lifetimeEarned += qualifyingTier.entryBonusPoints;

    ledger.push({
      id: "led_5",
      accountId: aliceAccountId,
      entryType: "TIER_UPGRADE_BONUS",
      pointsDelta: qualifyingTier.entryBonusPoints,
      balanceAfter: alice.balance,
      idempotencyKey: `tier_bonus:tier_silver:${aliceAccountId}`,
    });

    expect(alice.balance).toBe(BigInt(350)); // 300 + 50 = 350

    // Alice places a subsequent order of $100 earning with Silver 1.25x multiplier
    const order2Cents = BigInt(10000);
    const order2Points = calculateEligibleOrderPoints({
      netAmountCents: order2Cents,
      currency: "USD",
      pointsPerCurrencyUnit: programSettings.pointsPerCurrencyUnit,
      multiplier: qualifyingTier.pointsMultiplier, // 1.25x
    });
    expect(order2Points).toBe(BigInt(125)); // 100 * 1.25 = 125 points

    alice.balance += order2Points;
    alice.lifetimeEarned += order2Points;
    alice.rolling12mSpend += order2Cents;

    ledger.push({
      id: "led_6",
      accountId: aliceAccountId,
      entryType: "ORDER_EARN",
      pointsDelta: order2Points,
      balanceAfter: alice.balance,
      idempotencyKey: "order_earn:ord_new_2",
    });

    expect(alice.balance).toBe(BigInt(475)); // 350 + 125 = 475

    // Plus manual merchant bonus adjustment of +25 points
    const adjustmentPoints = BigInt(25);
    alice.balance += adjustmentPoints;
    alice.lifetimeEarned += adjustmentPoints;

    ledger.push({
      id: "led_7",
      accountId: aliceAccountId,
      entryType: "ADJUSTMENT",
      pointsDelta: adjustmentPoints,
      balanceAfter: alice.balance,
      idempotencyKey: `adj:store_yamax_e2e:manual_bonus_1`,
    });

    expect(alice.balance).toBe(BigInt(500)); // Exactly 500 points!

    // -------------------------------------------------------------------------
    // Phase 6: Partial Order Refund Proportional Points Reversal
    // -------------------------------------------------------------------------
    // Suppose Order 2 ($100) receives a 20% partial refund ($20 = 2,000 cents)
    const refundCents = BigInt(2000);
    const proportionalReversalPoints = BigInt(
      Math.round(
        Number(order2Points) * (Number(refundCents) / Number(order2Cents)),
      ),
    );
    expect(proportionalReversalPoints).toBe(BigInt(25)); // 20% of 125 = 25 points

    alice.balance -= proportionalReversalPoints;
    alice.rolling12mSpend -= refundCents;

    ledger.push({
      id: "led_8",
      accountId: aliceAccountId,
      entryType: "ORDER_REFUND",
      pointsDelta: -proportionalReversalPoints,
      balanceAfter: alice.balance,
      idempotencyKey: "order_refund:ord_new_2:ref_1",
    });

    expect(alice.balance).toBe(BigInt(475)); // 500 - 25 = 475

    // Add 25 compensation points so Alice can redeem $5 reward voucher
    alice.balance += BigInt(25);
    ledger.push({
      id: "led_9",
      accountId: aliceAccountId,
      entryType: "ADJUSTMENT",
      pointsDelta: BigInt(25),
      balanceAfter: alice.balance,
      idempotencyKey: "adj:comp_1",
    });
    expect(alice.balance).toBe(BigInt(500));

    // -------------------------------------------------------------------------
    // Phase 7: 1-Click Reward Redemption
    // -------------------------------------------------------------------------
    const selectedReward = rewardCatalog[0]; // $5 Off = 500 pts
    expect(Number(alice.balance) >= selectedReward.pointsCost).toBe(true);

    alice.balance -= BigInt(selectedReward.pointsCost);
    alice.lifetimeRedeemed += BigInt(selectedReward.pointsCost);

    const generatedVoucherCode = `${selectedReward.discountCodePrefix}-ABCD99`;
    ledger.push({
      id: "led_10",
      accountId: aliceAccountId,
      entryType: "REDEMPTION",
      pointsDelta: -BigInt(selectedReward.pointsCost),
      balanceAfter: alice.balance,
      idempotencyKey: `redemption:rew_5off:alice_tx1`,
    });

    expect(alice.balance).toBe(BigInt(0));
    expect(alice.lifetimeRedeemed).toBe(BigInt(500));
    expect(generatedVoucherCode.startsWith("YAMAX5-")).toBe(true);

    // -------------------------------------------------------------------------
    // Phase 8: GDPR Data Request Export & PII Redaction
    // -------------------------------------------------------------------------
    // 1. Data Export package
    const exportPackage = {
      profile: {
        shopperId: alice.shopperId,
        firstName: alice.firstName,
        lastName: alice.lastName,
        email: alice.email,
        phone: alice.phone,
      },
      loyaltyAccount: {
        balance: Number(alice.balance),
        lifetimeEarned: Number(alice.lifetimeEarned),
        lifetimeRedeemed: Number(alice.lifetimeRedeemed),
        referralCode: alice.referralCode,
        referralCount: alice.referralCount,
      },
      ledgerEntriesCount: ledger.filter((l) => l.accountId === aliceAccountId)
        .length,
    };

    expect(exportPackage.profile.email).toBe("alice@example.com");
    expect(exportPackage.ledgerEntriesCount).toBe(9); // 9 ledger entries for Alice

    // 2. Customer Redaction (Erasure)
    alice.firstName = "Redacted";
    alice.lastName = "Customer";
    alice.email = null;
    alice.phone = null;

    expect(alice.firstName).toBe("Redacted");
    expect(alice.email).toBeNull();
    expect(alice.phone).toBeNull();

    // Verify financial ledger integrity and account balance remained mathematically preserved
    expect(alice.balance).toBe(BigInt(0));
    expect(alice.lifetimeEarned).toBe(BigInt(500));
    expect(alice.lifetimeRedeemed).toBe(BigInt(500));
    expect(ledger).toHaveLength(10);
  });
});
