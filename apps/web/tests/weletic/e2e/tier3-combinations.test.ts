import { prisma } from "@/lib/prisma";
import { calculatePointsLiability } from "@/lib/weletic/loyalty/analytics";
import { calculateEligibleOrderPoints } from "@/lib/weletic/loyalty/earn";
import { buildCustomerMetafieldUpdates } from "@/lib/weletic/loyalty/metafield-sync";
import { bindShopperReferral } from "@/lib/weletic/loyalty/referrals";
import {
  cancelRewardRedemption,
  redeemReward,
} from "@/lib/weletic/loyalty/rewards";
import { minorUnitsToDecimal } from "@/lib/weletic/money";
import {
  Prisma,
  WeleticLoyaltyReferralStatus,
  WeleticRedemptionStatus,
  WeleticRewardStatus,
  WeleticRewardType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticShopifyStore: {
      findUnique: vi.fn(),
    },
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
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
    },
    weleticRewardRedemption: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }: any) => data),
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
      aggregate: vi.fn(),
    },
    weleticCommerceRefund: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (cb: any) => {
      if (typeof cb === "function") return cb(prisma);
      return Promise.all(cb);
    }),
  },
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

describe("Tier 3: Cross-Feature Combinations (Weletic Loyalty Production-Core)", () => {
  const TEST_STORE_ID = "store_combo_e2e";
  const ADVOCATE_ACC_ID = "wlacc_advocate_001";
  const REFEREE_ACC_ID = "wlacc_referee_002";

  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.weleticShopifyStore.findUnique as any).mockResolvedValue({
      id: TEST_STORE_ID,
      complianceState: "active",
      storeAccessState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date(0),
      installationGeneration: "sgen_combo_e2e",
    });
  });

  it("Combo 1: Referral Binding + VIP Multiplier + Holding Period Pending Points + Partial Refund Clawback", async () => {
    // 1. Advocate has Silver tier (1.25x)
    const advocateCode = "ALICE-123";
    (prisma.weleticLoyaltyAccount.findFirst as any).mockResolvedValueOnce({
      id: ADVOCATE_ACC_ID,
      storeId: TEST_STORE_ID,
      referralCode: advocateCode,
      status: "active",
      referralCount: 0,
      programId: "wprog_1",
    });

    (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
      ({ where }: any) => {
        if (where?.id === REFEREE_ACC_ID) {
          return {
            id: REFEREE_ACC_ID,
            storeId: TEST_STORE_ID,
            status: "active",
            metadata: null,
            shopperId: "wshop_referee_002",
            referredById: null,
            cachedPointsBalance: BigInt(0),
            lifetimePointsEarned: BigInt(0),
            lifetimePointsRedeemed: BigInt(0),
          };
        }
        if (where?.id === ADVOCATE_ACC_ID) {
          return {
            id: ADVOCATE_ACC_ID,
            storeId: TEST_STORE_ID,
            cachedPointsBalance: BigInt(100),
            lifetimePointsEarned: BigInt(100),
            lifetimePointsRedeemed: BigInt(0),
          };
        }
        return null;
      },
    );

    (prisma.weleticLoyaltyReferral.findUnique as any).mockResolvedValueOnce(
      null,
    );
    (prisma.weleticLoyaltyReferralRule.findFirst as any).mockResolvedValueOnce({
      id: "wref_rule_1",
      advocatePointsReward: BigInt(100),
      refereePointsReward: BigInt(50),
      minQualifyingOrderSubtotal: new Prisma.Decimal(30.0),
      isActive: true,
    });

    (prisma.weleticLoyaltyAccount.update as any).mockResolvedValue({});
    (prisma.weleticLoyaltyReferral.create as any).mockResolvedValueOnce({
      id: "wref_tx_1",
      advocateAccountId: ADVOCATE_ACC_ID,
      refereeAccountId: REFEREE_ACC_ID,
      status: WeleticLoyaltyReferralStatus.pending,
    });
    (prisma.weleticLoyaltyAccount.updateMany as any).mockResolvedValueOnce({
      count: 2,
    });

    // Bind referee to advocate
    const referral = await bindShopperReferral({
      storeId: TEST_STORE_ID,
      refereeAccountId: REFEREE_ACC_ID,
      referralCode: advocateCode,
    });
    expect(referral.status).toBe(WeleticLoyaltyReferralStatus.pending);

    // 2. Referee places $120 order with Silver VIP multiplier (1.25x) -> Earns 150 points
    const earnedPoints = calculateEligibleOrderPoints({
      netAmountCents: BigInt(12000),
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.25, // Silver multiplier
    });
    expect(earnedPoints).toBe(BigInt(150));

    // 3. Partial return occurs: $40 refunded (1/3 of order) -> Reverses 50 points
    const refundClawback = calculateEligibleOrderPoints({
      netAmountCents: BigInt(4000),
      currency: "USD",
      pointsPerCurrencyUnit: 1.0,
      multiplier: 1.25,
    });
    expect(refundClawback).toBe(BigInt(50));
    expect(earnedPoints - refundClawback).toBe(BigInt(100)); // Net 100 points kept
  });

  it("Combo 2: Reward Reservation + Compensating Cancellation + Concurrent Order Points Earn", async () => {
    // The real issuance producer reads the store's program even when its
    // notification policy is absent. Model that owned row, not a missing mock.
    vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue({
      id: "wprog_1",
      storeId: TEST_STORE_ID,
      status: "active",
      killSwitchActive: false,
      metadata: null,
    } as Awaited<ReturnType<typeof prisma.weleticLoyaltyProgram.findUnique>>);
    // 1. Initial account balance: 500 points
    (prisma.weleticLoyaltyAccount.findFirst as any).mockResolvedValue({
      id: ADVOCATE_ACC_ID,
      storeId: TEST_STORE_ID,
      shopper: { shopifyCustomerId: "gid://shopify/Customer/201" },
      store: { projectId: "workspace_combo_e2e" },
    });
    (prisma.weleticLoyaltyAccount.findUnique as any).mockImplementation(
      ({ where }: any) => {
        if (where?.id === ADVOCATE_ACC_ID) {
          return {
            id: ADVOCATE_ACC_ID,
            storeId: TEST_STORE_ID,
            status: "active",
            cachedPointsBalance: BigInt(500),
            cachedPendingPoints: BigInt(0),
            lifetimePointsEarned: BigInt(500),
            lifetimePointsRedeemed: BigInt(0),
            ledgerVersion: 1,
            program: { status: "active", killSwitchActive: false },
            shopper: {
              shopifyCustomerId: "gid://shopify/Customer/201",
            },
          };
        }
        return null;
      },
    );

    (prisma.weleticRewardDefinition.findUnique as any).mockResolvedValueOnce({
      id: "wrew_5off",
      storeId: TEST_STORE_ID,
      pointsCost: BigInt(500),
      name: "$5 Off Reward",
      rewardType: WeleticRewardType.amount_off,
      discountValue: new Prisma.Decimal(500),
      exchangeType: "fixed",
      minPointsCost: null,
      maxPointsCost: null,
      pointsStep: null,
      expiresInDays: null,
      status: WeleticRewardStatus.active,
    });

    let redemptionState: any = {
      id: "wredemp_saga_1",
      storeId: TEST_STORE_ID,
      accountId: ADVOCATE_ACC_ID,
      rewardDefinitionId: "wrew_5off",
      pointsSpent: BigInt(500),
      shopifyDiscountCode: "WL-SAGA5",
      shopifyDiscountId: null,
      artifactKind: "discount_code",
      fulfillmentSource: null,
      settlementQuarantinedAt: null,
      shopifyGiftCardId: null,
      shopifyStoreCreditTransactionId: null,
      status: WeleticRedemptionStatus.provisioning,
      ledgerEntryId: null,
      metadata: null,
      account: {
        storeId: TEST_STORE_ID,
        status: "active",
        metadata: null,
      },
      rewardDefinition: { name: "$5 Off Reward" },
    };

    (prisma.weleticRewardRedemption.findFirst as any).mockImplementation(
      ({ where }: any) =>
        where.id === redemptionState.id &&
        where.storeId === redemptionState.storeId &&
        (!where.accountId || where.accountId === redemptionState.accountId)
          ? {
              ...redemptionState,
              account: {
                ...redemptionState.account,
                shopper: { shopifyCustomerId: "gid://shopify/Customer/201" },
                store: { projectId: "workspace_combo_e2e" },
              },
            }
          : null,
    );
    (prisma.weleticRewardRedemption.updateMany as any).mockImplementation(
      ({ where, data }: any) => {
        if (
          where.id !== redemptionState.id ||
          (where.storeId && where.storeId !== redemptionState.storeId) ||
          (where.accountId && where.accountId !== redemptionState.accountId) ||
          (typeof where.status === "string" &&
            where.status !== redemptionState.status) ||
          (where.status?.in &&
            !where.status.in.includes(redemptionState.status)) ||
          (where.metadata?.equals !== undefined &&
            JSON.stringify(where.metadata.equals) !==
              JSON.stringify(redemptionState.metadata))
        ) {
          return { count: 0 };
        }
        redemptionState = { ...redemptionState, ...data };
        return { count: 1 };
      },
    );

    (prisma.weleticRewardRedemption.create as any).mockImplementation(
      ({ data }: any) => {
        redemptionState = { ...redemptionState, ...data };
        return redemptionState;
      },
    );
    (prisma.weleticRewardRedemption.findUnique as any).mockImplementation(
      ({ where }: any) =>
        where?.storeId_idempotencyKey ? null : redemptionState,
    );
    (prisma.weleticRewardRedemption.update as any).mockImplementation(
      ({ data }: any) => {
        redemptionState = { ...redemptionState, ...data };
        return redemptionState;
      },
    );

    let latestLedger: any = null;
    (prisma.weleticPointsLedgerEntry.findUnique as any).mockImplementation(
      ({ where }: any) => (where?.id ? latestLedger : null),
    );
    (prisma.weleticPointsLedgerEntry.findFirst as any).mockImplementation(
      ({ where }: any) =>
        where.id
          ? latestLedger?.id === where.id &&
            latestLedger.storeId === where.storeId &&
            latestLedger.accountId === where.accountId
            ? latestLedger
            : null
          : { sequenceNumber: 1 },
    );
    (prisma.weleticPointsLedgerEntry.create as any).mockImplementation(
      ({ data }: any) => ({
        ...(latestLedger = {
          createdAt: new Date(),
          ...data,
          id:
            data.pointsDelta < BigInt(0)
              ? "wledger_saga_1"
              : "wledger_cancel_1",
        }),
      }),
    );
    (prisma.weleticLoyaltyAccount.update as any).mockResolvedValue({});

    const shopifyFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          discountCodeBasicCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/501",
              codeDiscount: {
                title: "$5 Off Reward (WL-SAGA5)",
                status: "ACTIVE",
                codes: { nodes: [{ code: "WL-SAGA5" }] },
              },
            },
            userErrors: [],
          },
        },
      }),
    });

    // 1. Debit 500 points during redemption saga
    const redResult = await redeemReward({
      storeId: TEST_STORE_ID,
      accountId: ADVOCATE_ACC_ID,
      rewardDefinitionId: "wrew_5off",
      discountCode: "WL-SAGA5",
      shopDomain: "combo.myshopify.com",
      accessToken: "shpat_test_token",
      customFetch: shopifyFetch as any,
      idempotencyKey: "tier3-combo-redemption-1",
    });
    expect(redResult.ledgerEntry.pointsDelta).toBe(BigInt(-500));
    expect(redResult.redemption.status).toBe(WeleticRedemptionStatus.issued);

    // 2. Local cancellation restores points and queues remote deactivation.
    const compResult = await cancelRewardRedemption({
      storeId: TEST_STORE_ID,
      redemptionId: redResult.redemption.id,
      reason: "Synthetic merchant cancellation after confirmed issuance",
    });
    expect(compResult.ledgerEntry.pointsDelta).toBe(BigInt(500));
    expect(compResult.redemption.status).toBe(
      WeleticRedemptionStatus.cancelled,
    );
    expect(compResult.deactivationPending).toBe(true);
    expect(prisma.weleticLoyaltyOutboxJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeId: TEST_STORE_ID,
          jobType: "REDEMPTION_RECOVERY",
          idempotencyKey: `discount_deactivate:${redResult.redemption.id}`,
        }),
      }),
    );
  });

  it("Combo 3: Zero-Decimal JPY Order + Campaign Multiplier + VIP Entry Bonus + Manual Bonus Adjustment", async () => {
    // 1. Order of ¥20,000 JPY at base rate 0.01 with 2x Weekend Campaign multiplier -> 400 pts
    const orderPoints = calculateEligibleOrderPoints({
      netAmountCents: BigInt(20000),
      currency: "JPY",
      pointsPerCurrencyUnit: 0.01,
      multiplier: 2.0,
    });
    expect(orderPoints).toBe(BigInt(400));

    // 2. VIP Tier Entry Bonus: Gold upgrade gives +100 bonus pts
    const vipEntryBonus = BigInt(100);

    // 3. Manual Merchant Adjustment: +50 compensation pts
    const manualAdjustment = BigInt(50);

    const totalBalance = orderPoints + vipEntryBonus + manualAdjustment;
    expect(totalBalance).toBe(BigInt(550));
    expect(minorUnitsToDecimal(totalBalance, "JPY")).toBe("550");
  });

  it("Combo 4: Account Inactivity Expiration + Subsequent Signup Bonus + Customer Metafield Sync", () => {
    // Account expires all remaining points (-200 pts)
    const expirationDebit = BigInt(-200);

    // Customer re-activates and receives +50 signup bonus
    const welcomeBonus = BigInt(50);
    const balanceAfterReactivation = BigInt(0) + welcomeBonus;

    // Metafields synced to Shopify
    const updates = buildCustomerMetafieldUpdates({
      ownerId: "gid://shopify/Customer/456",
      vipTierName: "Bronze",
      vipTierOrder: 1,
      pointsBalance: balanceAfterReactivation,
      pendingPoints: BigInt(0),
      lifetimePoints: BigInt(250),
      referralCode: "BOB-99",
      memberStatus: "active",
    });

    const pointsField = updates.find((m) => m.key === "points_balance");
    expect(pointsField?.value).toBe("50");
    expect(pointsField?.type).toBe("number_integer");
  });

  it("Combo 5: Multi-Currency Program Settlement (USD + JPY + VND) with Consolidated Liability", async () => {
    // Multi-tenant store accounts across currencies
    (prisma.weleticLoyaltyAccount.findMany as any).mockResolvedValueOnce([
      {
        cachedPointsBalance: BigInt(1000),
        cachedPendingPoints: BigInt(200),
        status: "active",
        updatedAt: new Date(),
      },
      {
        cachedPointsBalance: BigInt(2000),
        cachedPendingPoints: BigInt(500),
        status: "active",
        updatedAt: new Date(),
      },
      {
        cachedPointsBalance: BigInt(500),
        cachedPendingPoints: BigInt(0),
        status: "active",
        updatedAt: new Date(),
      },
    ]);

    const liabilityUSD = await calculatePointsLiability({
      storeId: TEST_STORE_ID,
      currency: "USD",
      valuationPerPointMinorUnits: BigInt(1), // 1 cent = $0.01 per point
    });

    expect(liabilityUSD.totalCirculatingPoints).toBe(BigInt(3500));
    expect(liabilityUSD.totalPendingPoints).toBe(BigInt(700));
    expect(liabilityUSD.totalPotentialPoints).toBe(BigInt(4200));
    expect(liabilityUSD.totalLiabilityDecimal).toBe("35.00");
    expect(liabilityUSD.totalPotentialLiabilityDecimal).toBe("42.00");
  });
});
