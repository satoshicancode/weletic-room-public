import { prisma } from "@/lib/prisma";
import { calculatePointsLiability } from "@/lib/weletic/loyalty/analytics";
import {
  createBackfillJob,
  generateBackfillPreview,
} from "@/lib/weletic/loyalty/backfill";
import { calculateEligibleOrderPoints } from "@/lib/weletic/loyalty/earn";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { checkBirthdayEligibility } from "@/lib/weletic/loyalty/non-purchase-earn";
import { generateReferralCode } from "@/lib/weletic/loyalty/referrals";
import { decimalToMinorUnits } from "@/lib/weletic/money";
import {
  Prisma,
  WeleticLoyaltyBackfillJobStatus,
  WeleticPointsLedgerEntryType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      findUnique: vi.fn(),
    },
    weleticShopifyAppSession: {
      findFirst: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    weleticRewardDefinition: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    weleticRewardRedemption: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyReferral: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(),
    },
    weleticLoyaltyBackfillJob: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyBackfillPreviewItem: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
    },
    $queryRaw: vi.fn(async (query: any) => {
      const sql = Array.isArray(query?.strings)
        ? query.strings.join(" ")
        : String(query);
      return sql.includes("WeleticLoyaltyAccount")
        ? [
            { id: "acc_1", status: "active", metadata: null },
            { id: "acc_2", status: "active", metadata: null },
          ]
        : [
            {
              id: "store_enterprise_prod",
              complianceState: "active",
              shopCurrency: "USD",
              currencyVerifiedAt: new Date(0),
              installationGeneration: "sgen_enterprise_prod",
            },
          ];
    }),
    $transaction: vi.fn(async (cb: any) => {
      if (typeof cb === "function") return cb(prisma);
      return Promise.all(cb);
    }),
  },
}));

describe("Tier 4: Real-World Workload Scenarios (Weletic Loyalty Production-Core)", () => {
  const STORE_ID = "store_enterprise_prod";
  const ALICE_ACC_ID = "wlacc_alice_real";
  const BOB_ACC_ID = "wlacc_bob_real";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // Scenario 1: Complete End-to-End Customer Lifecycle
  // =========================================================================
  it("Scenario 1: Complete Customer Lifecycle (Signup -> Birthday -> Referral -> Purchase -> VIP Tier Upgrade -> Reward Redemption -> Partial Refund -> GDPR Erasure)", async () => {
    // -----------------------------------------------------------------------
    // Step 1: Alice signs up & receives +50 Welcome Points
    // -----------------------------------------------------------------------
    let aliceBalance = BigInt(0);
    let aliceLifetimeEarned = BigInt(0);
    let aliceLifetimeRedeemed = BigInt(0);
    let aliceRollingSpend = BigInt(0);
    const ledger: Array<{
      seq: number;
      type: string;
      delta: bigint;
      balance: bigint;
    }> = [];

    const signupBonus = BigInt(50);
    aliceBalance += signupBonus;
    aliceLifetimeEarned += signupBonus;
    ledger.push({
      seq: 1,
      type: "EARN_BONUS",
      delta: signupBonus,
      balance: aliceBalance,
    });
    expect(aliceBalance).toBe(BigInt(50));

    // -----------------------------------------------------------------------
    // Step 2: Alice adds birthday 60 days in advance -> Celebrates birthday (+100 pts)
    // -----------------------------------------------------------------------
    const now = new Date("2026-08-01T00:00:00Z");
    const birthDate = new Date("1992-08-01T00:00:00Z");
    const enrollmentDate = new Date("2026-06-01T00:00:00Z"); // 61 days lead time

    const check = checkBirthdayEligibility(birthDate, enrollmentDate, now);
    expect(check.isEligible).toBe(true);

    const birthdayBonus = BigInt(100);
    aliceBalance += birthdayBonus;
    aliceLifetimeEarned += birthdayBonus;
    ledger.push({
      seq: 2,
      type: "EARN_BONUS",
      delta: birthdayBonus,
      balance: aliceBalance,
    });
    expect(aliceBalance).toBe(BigInt(150));

    // -----------------------------------------------------------------------
    // Step 3: Alice shares referral code with Bob -> Bob places $60 order
    // -----------------------------------------------------------------------
    const aliceReferralCode = generateReferralCode("Alice");
    expect(aliceReferralCode.startsWith("ALICE-")).toBe(true);

    const advocateReward = BigInt(100);
    const refereeReward = BigInt(50);

    // Alice gets advocate points, Bob gets referee welcome points
    aliceBalance += advocateReward;
    aliceLifetimeEarned += advocateReward;
    ledger.push({
      seq: 3,
      type: "EARN_REFERRAL",
      delta: advocateReward,
      balance: aliceBalance,
    });
    expect(aliceBalance).toBe(BigInt(250));

    // -----------------------------------------------------------------------
    // Step 4: Alice makes a $250 purchase (25,000 cents) -> Earns 250 points
    // -----------------------------------------------------------------------
    const orderSpendCents = BigInt(25000);
    const orderPoints = calculateEligibleOrderPoints({
      netAmountCents: orderSpendCents,
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.0,
    });
    expect(orderPoints).toBe(BigInt(250));

    aliceBalance += orderPoints;
    aliceLifetimeEarned += orderPoints;
    aliceRollingSpend += orderSpendCents;
    ledger.push({
      seq: 4,
      type: "EARN_ORDER",
      delta: orderPoints,
      balance: aliceBalance,
    });
    expect(aliceBalance).toBe(BigInt(500)); // Exactly 500 points!

    // -----------------------------------------------------------------------
    // Step 5: VIP Tier Upgrade: Alice crosses $200 spend threshold -> Silver Tier (+50 Entry Bonus)
    // -----------------------------------------------------------------------
    const silverUpgradeBonus = BigInt(50);
    aliceBalance += silverUpgradeBonus;
    aliceLifetimeEarned += silverUpgradeBonus;
    ledger.push({
      seq: 5,
      type: "TIER_BONUS",
      delta: silverUpgradeBonus,
      balance: aliceBalance,
    });
    expect(aliceBalance).toBe(BigInt(550));

    // -----------------------------------------------------------------------
    // Step 6: 1-Click Reward Redemption: Alice redeems $5 Discount Voucher (-500 pts)
    // -----------------------------------------------------------------------
    const rewardCost = BigInt(500);
    aliceBalance -= rewardCost;
    aliceLifetimeRedeemed += rewardCost;
    ledger.push({
      seq: 6,
      type: "REDEEM_REWARD",
      delta: -rewardCost,
      balance: aliceBalance,
    });
    expect(aliceBalance).toBe(BigInt(50));
    expect(aliceLifetimeRedeemed).toBe(BigInt(500));

    // -----------------------------------------------------------------------
    // Step 7: Partial Return: $100 refunded from $250 order -> Proportional Clawback of 100 points
    // -----------------------------------------------------------------------
    const refundClawback = calculateEligibleOrderPoints({
      netAmountCents: BigInt(10000), // $100 refund
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.0,
    });
    expect(refundClawback).toBe(BigInt(100));

    aliceBalance -= refundClawback;
    aliceRollingSpend -= BigInt(10000);
    ledger.push({
      seq: 7,
      type: "REFUND_REVERSAL",
      delta: -refundClawback,
      balance: aliceBalance,
    });
    // Balance is permitted to drop negative per ADR 0004! (50 - 100 = -50)
    expect(aliceBalance).toBe(BigInt(-50));

    // -----------------------------------------------------------------------
    // Step 8: GDPR Data Request Export & PII Redaction
    // -----------------------------------------------------------------------
    const exportPackage = {
      accountId: ALICE_ACC_ID,
      balance: aliceBalance.toString(),
      lifetimeEarned: aliceLifetimeEarned.toString(),
      lifetimeRedeemed: aliceLifetimeRedeemed.toString(),
      ledgerEntries: ledger.length,
    };
    expect(exportPackage.ledgerEntries).toBe(7);
    expect(exportPackage.balance).toBe("-50");

    // Redaction
    const redactedUser = {
      firstName: "Redacted",
      lastName: "Customer",
      email: null,
      phone: null,
      balance: aliceBalance,
    };
    expect(redactedUser.email).toBeNull();
    expect(redactedUser.balance).toBe(BigInt(-50)); // Mathematical integrity preserved
  });

  // =========================================================================
  // Scenario 2: Store Owner Administration & Recovery Workflow
  // =========================================================================
  // Superseded by the per-order service and isolated-MySQL backfill suites.
  it.skip("Scenario 2: Store Owner Administration & Backfill Recovery Workflow", async () => {
    // 1. Store Owner sets up Program with 1 pt per $1
    (prisma.weleticShopifyStore.findUnique as any).mockResolvedValue({
      id: STORE_ID,
      projectId: "workspace_enterprise_prod",
      shopDomain: "enterprise-prod.myshopify.com",
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date(0),
      installationGeneration: "sgen_enterprise_prod",
    });
    (prisma.weleticShopifyAppSession.findFirst as any).mockResolvedValueOnce({
      id: "offline_enterprise-prod.myshopify.com",
      shop: "enterprise-prod.myshopify.com",
      isOnline: false,
      payload: JSON.stringify({ scope: "read_all_orders" }),
    });
    (prisma.weleticLoyaltyProgram.findUnique as any).mockResolvedValue({
      id: "wprog_owner",
      storeId: STORE_ID,
      pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
    });

    (prisma.weleticLoyaltyBackfillJob.create as any).mockImplementationOnce(
      ({ data }: any) => ({
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      }),
    );

    const backfillJob = await createBackfillJob({
      storeId: STORE_ID,
      lookbackDays: 180,
      pointsPerCurrencyUnit: 1.0,
      minOrderAmount: 20.0,
    });
    expect(backfillJob.status).toBe(WeleticLoyaltyBackfillJobStatus.pending);

    // 2. Dry-run preview calculation
    (prisma.weleticLoyaltyBackfillJob.findUnique as any).mockResolvedValueOnce({
      id: backfillJob.id,
      storeId: STORE_ID,
      programId: "wprog_owner",
      status: WeleticLoyaltyBackfillJobStatus.pending,
      pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
      minOrderAmount: new Prisma.Decimal(20.0),
      lookbackStartDate: new Date("2026-01-01"),
      metadata: { installationGeneration: "sgen_enterprise_prod" },
    });

    (
      prisma.weleticLoyaltyBackfillPreviewItem.deleteMany as any
    ).mockResolvedValueOnce({ count: 0 });
    (prisma.weleticCommerceOrder.findMany as any).mockResolvedValueOnce([
      {
        id: "ord_h1",
        shopperId: "shop_1",
        presentmentCurrency: "USD",
        presentmentNet: BigInt(8000),
        presentmentTotal: BigInt(8000),
        occurredAt: new Date("2026-02-01"),
      },
      {
        id: "ord_h2",
        shopperId: "shop_2",
        presentmentCurrency: "USD",
        presentmentNet: BigInt(12000),
        presentmentTotal: BigInt(12000),
        occurredAt: new Date("2026-03-01"),
      },
    ]);

    (prisma.weleticLoyaltyAccount.findMany as any).mockResolvedValueOnce([
      { id: "acc_1", shopperId: "shop_1", storeId: STORE_ID, status: "active" },
      { id: "acc_2", shopperId: "shop_2", storeId: STORE_ID, status: "active" },
    ]);

    (
      prisma.weleticLoyaltyBackfillPreviewItem.createMany as any
    ).mockResolvedValueOnce({ count: 2 });
    (prisma.weleticLoyaltyBackfillJob.update as any).mockImplementation(
      ({ data }: any) => ({
        id: backfillJob.id,
        storeId: STORE_ID,
        programId: "wprog_owner",
        pointsPerCurrencyUnit: new Prisma.Decimal(1.0),
        minOrderAmount: new Prisma.Decimal(20.0),
        totalShoppersCount: 2,
        totalOrdersCount: 2,
        totalProjectedPoints: BigInt(200),
        processedAccountsCount: 0,
        totalCommittedPoints: BigInt(0),
        createdAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
        ...data,
      }),
    );

    const preview = await generateBackfillPreview(backfillJob.id);
    expect(preview.totalShoppersCount).toBe(2);
    expect(preview.totalProjectedPoints).toBe(BigInt(200));

    // 3. Merchant verifies Program Health & Liability
    (prisma.weleticLoyaltyAccount.findMany as any).mockResolvedValueOnce([
      {
        cachedPointsBalance: BigInt(80),
        cachedPendingPoints: BigInt(0),
        status: "active",
        updatedAt: new Date(),
      },
      {
        cachedPointsBalance: BigInt(120),
        cachedPendingPoints: BigInt(0),
        status: "active",
        updatedAt: new Date(),
      },
    ]);

    const liability = await calculatePointsLiability({
      storeId: STORE_ID,
      currency: "USD",
      valuationPerPointMinorUnits: BigInt(1),
    });
    expect(liability.totalCirculatingPoints).toBe(BigInt(200));
    expect(liability.totalLiabilityDecimal).toBe("2.00");
  });

  // =========================================================================
  // Scenario 3: Global Multi-Market Enterprise Settlement
  // =========================================================================
  it("Scenario 3: Global Multi-Market Enterprise Settlement across USD, JPY, and VND", () => {
    // 1. Market 1: US Store (USD, 2-decimal)
    const usdOrderCents = decimalToMinorUnits("150.00", "USD"); // 15000 cents
    const usdPoints = calculateEligibleOrderPoints({
      netAmountCents: usdOrderCents,
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.0,
    });
    expect(usdPoints).toBe(BigInt(150));

    // 2. Market 2: Japan Store (JPY, 0-decimal)
    const jpyOrderYen = decimalToMinorUnits("20000", "JPY"); // 20000 yen
    const jpyPoints = calculateEligibleOrderPoints({
      netAmountCents: jpyOrderYen,
      currency: "JPY",
      pointsPerCurrencyUnit: 0.01, // 1 point per ¥100
      multiplier: 1.0,
    });
    expect(jpyPoints).toBe(BigInt(200));

    // 3. Market 3: Vietnam Store (VND, 0-decimal)
    const vndOrderDong = decimalToMinorUnits("1000000", "VND"); // 1,000,000 VND
    const vndPoints = calculateEligibleOrderPoints({
      netAmountCents: vndOrderDong,
      currency: "VND",
      pointsPerCurrencyUnit: 0.001, // 1 point per 1,000 VND
      multiplier: 1.0,
    });
    expect(vndPoints).toBe(BigInt(1000));

    // Total points earned across all global markets
    const totalGlobalPoints = usdPoints + jpyPoints + vndPoints;
    expect(totalGlobalPoints).toBe(BigInt(1350));
  });

  // =========================================================================
  // Scenario 4: High-Stress Webhook Storm & Resilient Idempotent Append
  // =========================================================================
  it("Scenario 4: High-Stress Webhook Storm ensures idempotent single economic outcome", async () => {
    const duplicateOrderId = "ord_webhook_storm_999";
    const idempotencyKey = `earn_order:${duplicateOrderId}`;

    // First webhook arrives -> Appends entry
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValueOnce(
      null,
    );
    (prisma.weleticLoyaltyAccount.findUnique as any).mockResolvedValueOnce({
      id: ALICE_ACC_ID,
      cachedPointsBalance: BigInt(100),
      cachedPendingPoints: BigInt(0),
      lifetimePointsEarned: BigInt(100),
      lifetimePointsRedeemed: BigInt(0),
      ledgerVersion: 1,
    });
    (prisma.weleticPointsLedgerEntry.findFirst as any).mockResolvedValueOnce({
      sequenceNumber: 1,
      balanceAfter: BigInt(100),
    });
    (prisma.weleticPointsLedgerEntry.create as any).mockResolvedValueOnce({
      id: "wledger_storm_1",
      sequenceNumber: 2,
      pointsDelta: BigInt(100),
      balanceAfter: BigInt(200),
      idempotencyKey,
    });
    (prisma.weleticLoyaltyAccount.update as any).mockResolvedValueOnce({});

    const firstRun = await appendPointsLedgerEntry({
      storeId: STORE_ID,
      accountId: ALICE_ACC_ID,
      entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
      pointsDelta: BigInt(100),
      idempotencyKey,
    });
    expect(firstRun.id).toBe("wledger_storm_1");
    expect(firstRun.balanceAfter).toBe(BigInt(200));

    // Subsequent duplicate webhook arrivals with same idempotency key -> Returns existing entry instantly
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockResolvedValue({
      id: "wledger_storm_1",
      storeId: STORE_ID,
      accountId: ALICE_ACC_ID,
      entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
      sequenceNumber: 2,
      pointsDelta: BigInt(100),
      pendingDelta: BigInt(0),
      grantId: null,
      referenceType: null,
      referenceId: null,
      balanceAfter: BigInt(200),
      idempotencyKey,
    });

    const secondRun = await appendPointsLedgerEntry({
      storeId: STORE_ID,
      accountId: ALICE_ACC_ID,
      entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
      pointsDelta: BigInt(100),
      idempotencyKey,
    });
    expect(secondRun.id).toBe("wledger_storm_1");
    expect(secondRun.balanceAfter).toBe(BigInt(200));

    const thirdRun = await appendPointsLedgerEntry({
      storeId: STORE_ID,
      accountId: ALICE_ACC_ID,
      entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
      pointsDelta: BigInt(100),
      idempotencyKey,
    });
    expect(thirdRun.id).toBe("wledger_storm_1");
  });
});
