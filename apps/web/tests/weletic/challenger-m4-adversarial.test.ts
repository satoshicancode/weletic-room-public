import { prisma } from "@/lib/prisma";
import {
  buildCustomerMetafieldUpdates,
  syncCustomerMetafields,
  WELETIC_LOYALTY_NAMESPACE,
} from "@/lib/weletic/loyalty/metafield-sync";
import {
  bindShopperReferral,
  evaluateReferralQualification,
  hashAbuseSignal,
  reverseReferralPointsOnRefund,
} from "@/lib/weletic/loyalty/referrals";
import {
  batchEvaluateTierMaintenanceCycle,
  calculateTierReviewWindow,
  evaluateTierMaintenanceCycle,
} from "@/lib/weletic/loyalty/tier-lifecycle";
import {
  WeleticLoyaltyReferralStatus,
  WeleticLoyaltyTierChangeReason,
  WeleticVipMilestoneMode,
  WeleticVipTimeframe,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// This suite isolates accounting and storefront projections. Promotion-created
// notification transactions and privacy cleanup have separate SQL coverage.
vi.mock("@/lib/weletic/loyalty/vip-achievement-communication-producer", () => ({
  enqueueVipAchievementCommunication: vi.fn().mockResolvedValue(null),
}));

// Mock Prisma
vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticRewardDefinition: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticRewardRedemption: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    weleticLoyaltyProgram: {
      updateMany: vi.fn(),
    },
    weleticLoyaltyTier: {
      findMany: vi.fn(),
    },
    weleticLoyaltyTierHistory: {
      create: vi.fn(),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    weleticShopifyStore: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    project: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    installedIntegration: {
      findFirst: vi.fn(),
    },
    weleticShopifyAppSession: {
      findFirst: vi.fn(),
    },
    link: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => {
      if (typeof cb === "function") {
        return await cb(prisma);
      }
      return cb;
    }),
  },
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  OptimisticConcurrencyError: class OptimisticConcurrencyError extends Error {},
  appendPointsLedgerEntry: vi.fn().mockImplementation(async (params) => {
    return {
      id: `wpledger_mock_${Date.now()}`,
      sequenceNumber: 1,
      pointsDelta: params.pointsDelta,
      balanceAfter: BigInt(1000) + BigInt(params.pointsDelta),
      ...params,
    };
  }),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => {
  const enqueueOutboxJob = vi.fn().mockImplementation(async (params) => {
    return {
      id: `woutbox_mock_${Date.now()}`,
      ...params,
    };
  });
  return {
    enqueueOutboxJob,
    enqueueOutboxJobFromProgramTransaction: enqueueOutboxJob,
  };
});

describe("Challenger 2 Adversarial Stress Test Suite — Milestone 4", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      id: "store_adversarial_1",
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
      installationGeneration: null,
    } as any);
    vi.mocked(prisma.weleticLoyaltyProgram.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockImplementation(
      (async ({ where }: any) => ({
        count: Array.isArray(where?.id?.in) ? where.id.in.length : 1,
      })) as any,
    );
    vi.mocked(prisma.weleticLoyaltyReferral.updateMany).mockResolvedValue({
      count: 1,
    });
  });

  // ==========================================================================
  // 1. DUB REFERRALS ADVERSARIAL STRESS TESTING
  // ==========================================================================
  describe("1. Dub Referrals Adversarial Stress Testing", () => {
    const storeId = "store_adversarial_1";

    describe("1.1 Self-Referral Exploits & Evasion Vectors", () => {
      it("blocks self-referral when advocate and referee share identical account IDs", async () => {
        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: "acc_self_1",
            referralCode: "SELF-0001",
            status: "active",
            shopper: { id: "shopper_1", email: "user@example.com" },
            advocateReferrals: [],
          } as any,
        );

        await expect(
          bindShopperReferral({
            storeId,
            refereeAccountId: "acc_self_1",
            referralCode: "SELF-0001",
          }),
        ).rejects.toThrow("Self-referral is strictly prohibited.");
      });

      it("blocks self-referral when advocate and referee share identical shopper IDs across different accounts", async () => {
        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: "acc_advocate_primary",
            shopperId: "shopper_shared_id_999",
            referralCode: "ADV-9999",
            status: "active",
            shopper: { email: "shopper@domain.com" },
            advocateReferrals: [],
          } as any,
        );

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_referee_secondary",
          storeId,
          shopperId: "shopper_shared_id_999",
          status: "active",
          metadata: null,
          shopper: { email: "shopper_alt@domain.com" },
        } as any);

        await expect(
          bindShopperReferral({
            storeId,
            refereeAccountId: "acc_referee_secondary",
            referralCode: "ADV-9999",
          }),
        ).rejects.toThrow("Self-referral is strictly prohibited.");
      });

      it("blocks self-referral with obfuscated email variations (casing and leading/trailing whitespace)", async () => {
        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: "acc_advocate_email",
            shopperId: "shopper_a",
            referralCode: "CODE-CASE",
            status: "active",
            shopper: { email: "  Alice.Smith+Loyalty@Example.COM  " },
            advocateReferrals: [],
          } as any,
        );

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_referee_email",
          storeId,
          shopperId: "shopper_b",
          status: "active",
          metadata: null,
          shopper: { email: "alice.smith+loyalty@example.com" },
        } as any);

        await expect(
          bindShopperReferral({
            storeId,
            refereeAccountId: "acc_referee_email",
            referralCode: "CODE-CASE",
          }),
        ).rejects.toThrow(
          "Advocate and referee cannot share the same email address.",
        );
      });

      it("detects same-IP abuse signal and marks referral status as fraud_blocked without setting referee.referredById", async () => {
        const clientIp = "198.51.100.42";
        const ipHash = hashAbuseSignal({
          storeId,
          kind: "ip",
          signal: clientIp,
        });

        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: "acc_adv_ip_check",
            shopperId: "shopper_adv_ip",
            referralCode: "IP-MATCH",
            referralCount: 1,
            programId: "prog_ip_1",
            status: "active",
            shopper: { email: "advocate@test.com" },
            advocateReferrals: [{ ipHash }],
          } as any,
        );

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_ref_ip_check",
          storeId,
          shopperId: "shopper_ref_ip",
          status: "active",
          metadata: null,
          referredById: null,
          shopper: { email: "referee@test.com" },
        } as any);

        vi.mocked(
          prisma.weleticLoyaltyReferral.findUnique,
        ).mockResolvedValueOnce(null);

        vi.mocked(
          prisma.weleticLoyaltyReferralRule.findFirst,
        ).mockResolvedValueOnce({
          id: "rule_ip_1",
          programId: "prog_ip_1",
          fraudCheckSameIp: true,
          isActive: true,
        } as any);

        (prisma.weleticLoyaltyReferral.create as any).mockImplementationOnce(
          async (args: any) => args.data,
        );

        const referral = await bindShopperReferral({
          storeId,
          refereeAccountId: "acc_ref_ip_check",
          referralCode: "IP-MATCH",
          clientIp,
          userAgent: "Mozilla/5.0 StressTest/1.0",
        });

        expect(referral.status).toBe(
          WeleticLoyaltyReferralStatus.fraud_blocked,
        );
        expect(referral.fraudReason).toContain("Same IP address detected");
        expect(referral.ipHash).toBe(ipHash);
        expect(referral.userAgentHash).toBe(
          hashAbuseSignal({
            storeId,
            kind: "user_agent",
            signal: "Mozilla/5.0 StressTest/1.0",
          }),
        );

        // Crucial security invariant: referee account must NOT have referredById set when blocked for fraud
        expect(prisma.weleticLoyaltyAccount.update).not.toHaveBeenCalled();
      });
    });

    describe("1.2 Circular & Duplicate Referral Binding Protections", () => {
      it("blocks duplicate referee binding when account was already bound to an advocate", async () => {
        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: "acc_adv_second",
            shopperId: "shopper_adv_2",
            referralCode: "SECOND-1234",
            status: "active",
            shopper: { email: "adv2@test.com" },
            advocateReferrals: [],
          } as any,
        );

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_ref_bound",
          storeId,
          shopperId: "shopper_ref_bound",
          status: "active",
          metadata: null,
          referredById: "acc_first_advocate", // Already referred!
          shopper: { email: "ref_bound@test.com" },
        } as any);

        await expect(
          bindShopperReferral({
            storeId,
            refereeAccountId: "acc_ref_bound",
            referralCode: "SECOND-1234",
          }),
        ).rejects.toThrow(
          "Account has already been referred by another member.",
        );
      });

      it("returns existing referral idempotently when same advocate and referee bind repeatedly", async () => {
        const existingRecord = {
          id: "wreferral_existing_123",
          advocateAccountId: "acc_adv_repeat",
          refereeAccountId: "acc_ref_repeat",
          status: WeleticLoyaltyReferralStatus.pending,
        };

        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: "acc_adv_repeat",
            shopperId: "shopper_adv_rep",
            referralCode: "REPEAT-1234",
            status: "active",
            shopper: { email: "adv_rep@test.com" },
            advocateReferrals: [],
          } as any,
        );

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_ref_repeat",
          storeId,
          shopperId: "shopper_ref_rep",
          status: "active",
          metadata: null,
          referredById: null,
          shopper: { email: "ref_rep@test.com" },
        } as any);

        vi.mocked(
          prisma.weleticLoyaltyReferral.findUnique,
        ).mockResolvedValueOnce(existingRecord as any);

        const result = await bindShopperReferral({
          storeId,
          refereeAccountId: "acc_ref_repeat",
          referralCode: "REPEAT-1234",
        });

        expect(result).toEqual(existingRecord);
        expect(prisma.weleticLoyaltyReferral.create).not.toHaveBeenCalled();
      });

      it("enforces advocate maximum referral cap strictly on boundary", async () => {
        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: "acc_adv_cap",
            shopperId: "shopper_cap",
            referralCode: "CAP-1234",
            referralCount: 5,
            programId: "prog_cap",
            status: "active",
            shopper: { email: "adv_cap@test.com" },
            advocateReferrals: [],
          } as any,
        );

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_ref_cap",
          storeId,
          shopperId: "shopper_ref_cap",
          status: "active",
          metadata: null,
          referredById: null,
          shopper: { email: "ref_cap@test.com" },
        } as any);

        vi.mocked(
          prisma.weleticLoyaltyReferral.findUnique,
        ).mockResolvedValueOnce(null);

        vi.mocked(
          prisma.weleticLoyaltyReferralRule.findFirst,
        ).mockResolvedValueOnce({
          id: "rule_cap",
          programId: "prog_cap",
          maxReferralsPerAdvocate: 5, // Cap is 5
          isActive: true,
        } as any);

        await expect(
          bindShopperReferral({
            storeId,
            refereeAccountId: "acc_ref_cap",
            referralCode: "CAP-1234",
          }),
        ).rejects.toThrow(
          "Advocate has reached the maximum allowed referrals.",
        );
      });

      it("rejects referral binding if the loyalty program referral rule is inactive", async () => {
        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: "acc_adv_inactive",
            shopperId: "shopper_inact",
            referralCode: "INACT-1234",
            referralCount: 0,
            programId: "prog_inact",
            status: "active",
            shopper: { email: "adv_inact@test.com" },
            advocateReferrals: [],
          } as any,
        );

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_ref_inact",
          storeId,
          shopperId: "shopper_ref_inact",
          status: "active",
          metadata: null,
          referredById: null,
          shopper: { email: "ref_inact@test.com" },
        } as any);

        vi.mocked(
          prisma.weleticLoyaltyReferral.findUnique,
        ).mockResolvedValueOnce(null);

        vi.mocked(
          prisma.weleticLoyaltyReferralRule.findFirst,
        ).mockResolvedValueOnce({
          id: "rule_inact",
          programId: "prog_inact",
          isActive: false, // INACTIVE RULE
        } as any);

        await expect(
          bindShopperReferral({
            storeId,
            refereeAccountId: "acc_ref_inact",
            referralCode: "INACT-1234",
          }),
        ).rejects.toThrow("Customer referral program is currently inactive.");
      });
    });

    describe("1.3 Referral Fulfillment & Refund Clawback Verification", () => {
      it("enforces minimum qualifying order threshold for zero-decimal and decimal currencies", async () => {
        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_ref_thresh",
          storeId,
          shopperId: "shopper_thresh",
          status: "active",
          metadata: null,
        } as any);

        vi.mocked(
          prisma.weleticLoyaltyReferral.findFirst,
        ).mockResolvedValueOnce({
          id: "wreferral_thresh",
          advocateAccountId: "acc_adv_thresh",
          refereeAccountId: "acc_ref_thresh",
          status: WeleticLoyaltyReferralStatus.pending,
          advocateAccount: {
            id: "acc_adv_thresh",
            storeId,
            programId: "prog_1",
            status: "active",
            metadata: null,
          },
        } as any);

        vi.mocked(
          prisma.weleticLoyaltyReferralRule.findFirst,
        ).mockResolvedValueOnce({
          id: "rule_thresh",
          programId: "prog_1",
          advocatePointsReward: BigInt(200),
          refereePointsReward: BigInt(100),
          minQualifyingOrderSubtotal: 50.0, // $50.00 min requirement
          isActive: true,
        } as any);

        // Subtotal is $49.99 (4999 minor units) -> under threshold!
        const result = await evaluateReferralQualification({
          storeId,
          orderId: "order_under_thresh",
          refereeShopperId: "shopper_thresh",
          orderSubtotal: BigInt(4999),
          currency: "USD",
        });

        expect(result.qualified).toBe(false);
        expect(result.reason).toContain("below minimum qualifying amount");
      });

      it("prevents double qualification of the same order (idempotency)", async () => {
        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_ref_double",
          storeId,
          shopperId: "shopper_double",
          status: "active",
          metadata: null,
        } as any);

        // Referral is already 'rewarded' (not pending)
        vi.mocked(
          prisma.weleticLoyaltyReferral.findFirst,
        ).mockResolvedValueOnce(null);

        const result = await evaluateReferralQualification({
          storeId,
          orderId: "order_already_processed",
          refereeShopperId: "shopper_double",
          orderSubtotal: BigInt(10000),
          currency: "USD",
        });

        expect(result.qualified).toBe(false);
        expect(result.reason).toBe("No pending referral found");
      });

      it("reverses referral points correctly on refund even when advocate or referee has zero/spent points balance", async () => {
        const orderId = "order_clawback_100";
        const refundId = "refund_clawback_100";

        vi.mocked(
          prisma.weleticLoyaltyReferral.findFirst,
        ).mockResolvedValueOnce({
          id: "wreferral_clawback_100",
          storeId,
          advocateAccountId: "acc_adv_spent",
          refereeAccountId: "acc_ref_spent",
          status: WeleticLoyaltyReferralStatus.rewarded,
          qualifyingOrderId: orderId,
          advocatePointsAwarded: BigInt(300),
          refereePointsAwarded: BigInt(150),
        } as any);

        const clawbackResult = await reverseReferralPointsOnRefund({
          storeId,
          orderId,
          refundId,
        });

        expect(clawbackResult.reversed).toBe(true);
        expect(clawbackResult.advocateReversed).toBe(BigInt(300));
        expect(clawbackResult.refereeReversed).toBe(BigInt(150));

        // A fully refunded qualifying order is terminal so webhook replay cannot
        // reward the same referral again.
        expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              id: "wreferral_clawback_100",
              storeId,
              qualifyingOrderId: orderId,
              status: {
                in: [
                  WeleticLoyaltyReferralStatus.rewarded,
                  WeleticLoyaltyReferralStatus.qualified,
                ],
              },
            },
            data: expect.objectContaining({
              status: WeleticLoyaltyReferralStatus.cancelled,
              advocatePointsAwarded: BigInt(0),
              refereePointsAwarded: BigInt(0),
              metadata: expect.objectContaining({
                requalificationBlocked: true,
                requalificationBlockedReason: "qualifying_order_fully_refunded",
                invalidatedQualificationOrderIds: [orderId],
              }),
            }),
          }),
        );
      });

      it("returns reversed: false idempotently when refund is called on an unrewarded or already reversed referral", async () => {
        vi.mocked(
          prisma.weleticLoyaltyReferral.findFirst,
        ).mockResolvedValueOnce(null);

        const result = await reverseReferralPointsOnRefund({
          storeId,
          orderId: "order_non_existent",
          refundId: "refund_none",
        });

        expect(result.reversed).toBe(false);
        expect(result.advocateReversed).toBe(BigInt(0));
        expect(result.refereeReversed).toBe(BigInt(0));
      });
    });
  });

  // ==========================================================================
  // 2. VIP TIER ENGINE LIFECYCLE & BOUNDARY STRESS TESTING
  // ==========================================================================
  describe("2. VIP Tier Engine Lifecycle & Boundary Stress Testing", () => {
    const storeId = "store_vip_stress";

    const testTiers = [
      {
        id: "tier_1",
        name: "Bronze",
        tierOrder: 1,
        minSpendThreshold: BigInt(0),
        minPointsThreshold: BigInt(0),
        entryBonusPoints: BigInt(0),
      },
      {
        id: "tier_2",
        name: "Silver",
        tierOrder: 2,
        minSpendThreshold: BigInt(25000),
        minPointsThreshold: BigInt(500),
        entryBonusPoints: BigInt(100),
      },
      {
        id: "tier_3",
        name: "Gold",
        tierOrder: 3,
        minSpendThreshold: BigInt(50000),
        minPointsThreshold: BigInt(1000),
        entryBonusPoints: BigInt(250),
      },
      {
        id: "tier_4",
        name: "Platinum",
        tierOrder: 4,
        minSpendThreshold: BigInt(100000),
        minPointsThreshold: BigInt(2500),
        entryBonusPoints: BigInt(500),
      },
      {
        id: "tier_5",
        name: "Diamond",
        tierOrder: 5,
        minSpendThreshold: BigInt(250000),
        minPointsThreshold: BigInt(5000),
        entryBonusPoints: BigInt(1000),
      },
    ];

    describe("2.1 Boundary Spend & Points Edge Cases", () => {
      it("evaluates boundary spend: 49999 fails Gold, 50000 achieves Gold in amount_spent mode", async () => {
        const accountId = "acc_boundary_spend";

        // Subcase A: 49999 minor units ($499.99)
        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: accountId,
          storeId,
          shopperId: "shopper_b_1",
          currentTier: testTiers[1], // Silver
          currentTierId: "tier_2",
          program: {
            vipMilestoneMode: WeleticVipMilestoneMode.amount_spent,
            vipTimeframe: WeleticVipTimeframe.rolling_12m,
            vipAutoDowngradeEnabled: true,
            tiers: testTiers,
          },
        } as any);

        vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
          { presentmentNet: BigInt(49999) } as any,
        ]);
        vi.mocked(
          prisma.weleticPointsLedgerEntry.findMany,
        ).mockResolvedValueOnce([]);

        const resultUnder = await evaluateTierMaintenanceCycle({
          storeId,
          accountId,
        });

        expect(resultUnder.status).toBe("MAINTAINED");
        expect(resultUnder.newTierId).toBe("tier_2"); // Stays Silver

        // Subcase B: 50000 minor units ($500.00 exact threshold)
        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: accountId,
          storeId,
          shopperId: "shopper_b_1",
          currentTier: testTiers[1], // Silver
          currentTierId: "tier_2",
          program: {
            vipMilestoneMode: WeleticVipMilestoneMode.amount_spent,
            vipTimeframe: WeleticVipTimeframe.rolling_12m,
            vipAutoDowngradeEnabled: true,
            tiers: testTiers,
          },
        } as any);

        vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
          { presentmentNet: BigInt(50000) } as any,
        ]);
        vi.mocked(
          prisma.weleticPointsLedgerEntry.findMany,
        ).mockResolvedValueOnce([]);

        const resultExact = await evaluateTierMaintenanceCycle({
          storeId,
          accountId,
        });

        expect(resultExact.status).toBe("PROMOTED");
        expect(resultExact.newTierId).toBe("tier_3"); // Upgraded to Gold
      });

      it("evaluates milestoneMode: points_earned independently of spend", async () => {
        const accountId = "acc_points_mode";

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: accountId,
          storeId,
          shopperId: "shopper_pts",
          currentTier: testTiers[0],
          currentTierId: "tier_1",
          program: {
            vipMilestoneMode: WeleticVipMilestoneMode.points_earned,
            vipTimeframe: WeleticVipTimeframe.rolling_12m,
            vipAutoDowngradeEnabled: true,
            tiers: testTiers,
          },
        } as any);

        // $0 spend, but 5000 points earned -> qualifies for Diamond
        vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce(
          [],
        );
        vi.mocked(
          prisma.weleticPointsLedgerEntry.findMany,
        ).mockResolvedValueOnce([{ pointsDelta: BigInt(5000) } as any]);

        const result = await evaluateTierMaintenanceCycle({
          storeId,
          accountId,
        });

        expect(result.status).toBe("PROMOTED");
        expect(result.newTierId).toBe("tier_5"); // Diamond
      });

      it("handles extreme BigInt spend amounts without overflow", async () => {
        const accountId = "acc_extreme_bigint";
        const billionDollarsInCents = BigInt("100000000000"); // $1 Billion

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: accountId,
          storeId,
          shopperId: "shopper_whale",
          currentTier: testTiers[0],
          currentTierId: "tier_1",
          program: {
            vipMilestoneMode: "amount_spent",
            vipTimeframe: "lifetime",
            vipAutoDowngradeEnabled: true,
            tiers: testTiers,
          },
        } as any);

        vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
          { presentmentNet: billionDollarsInCents } as any,
        ]);
        vi.mocked(
          prisma.weleticPointsLedgerEntry.findMany,
        ).mockResolvedValueOnce([]);

        const result = await evaluateTierMaintenanceCycle({
          storeId,
          accountId,
          reviewPeriod: "LIFETIME",
        });

        expect(result.status).toBe("PROMOTED");
        expect(result.newTierId).toBe("tier_5"); // Top Diamond tier
        expect(result.qualifyingSpend).toBe(billionDollarsInCents);
      });
    });

    describe("2.2 Timeframe Windows & Multi-Year Transitions", () => {
      it("calculates exact calendar year boundaries for previous year when evaluated in January", () => {
        // Evaluated on Jan 10, 2026 -> should evaluate full calendar year 2025
        const janDate = new Date("2026-01-10T08:00:00.000Z");
        const { startDate, endDate } = calculateTierReviewWindow(
          "CALENDAR_YEAR",
          janDate,
        );

        expect(startDate.toISOString()).toBe("2025-01-01T00:00:00.000Z");
        expect(endDate.toISOString()).toBe("2025-12-31T23:59:59.999Z");
      });

      it("calculates exact calendar year boundaries for current year when evaluated later in the year", () => {
        // Evaluated on Aug 26, 2026 -> evaluates year 2026
        const augDate = new Date("2026-08-26T12:00:00.000Z");
        const { startDate, endDate } = calculateTierReviewWindow(
          "CALENDAR_YEAR",
          augDate,
        );

        expect(startDate.toISOString()).toBe("2026-01-01T00:00:00.000Z");
        expect(endDate.toISOString()).toBe("2026-12-31T23:59:59.999Z");
      });

      it("respects explicit cycleYear override for retroactive auditing", () => {
        const augDate = new Date("2026-08-26T12:00:00.000Z");
        const { startDate, endDate } = calculateTierReviewWindow(
          "CALENDAR_YEAR",
          augDate,
          2024,
        );

        expect(startDate.toISOString()).toBe("2024-01-01T00:00:00.000Z");
        expect(endDate.toISOString()).toBe("2024-12-31T23:59:59.999Z");
      });
    });

    describe("2.3 30-Day Grace Period Expiration & Re-qualification", () => {
      it("re-evaluating within active grace period preserves status IN_GRACE_PERIOD without demoting", async () => {
        const accountId = "acc_in_grace";
        const now = new Date("2026-08-26T12:00:00.000Z");
        const activeGraceDate = new Date("2026-09-10T12:00:00.000Z"); // 15 days left

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: accountId,
          storeId,
          shopperId: "shopper_grace_active",
          currentTier: testTiers[3], // Platinum (Order 4)
          currentTierId: "tier_4",
          tierExpiresAt: activeGraceDate,
          program: {
            vipMilestoneMode: "amount_spent",
            vipTimeframe: "rolling_12m",
            vipAutoDowngradeEnabled: true,
            tiers: testTiers,
          },
        } as any);

        vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce(
          [],
        );
        vi.mocked(
          prisma.weleticPointsLedgerEntry.findMany,
        ).mockResolvedValueOnce([]);

        const result = await evaluateTierMaintenanceCycle({
          storeId,
          accountId,
          now,
        });

        expect(result.status).toBe("IN_GRACE_PERIOD");
        expect(result.tierChanged).toBe(false);
        expect(result.newTierId).toBe("tier_4"); // Tier 4 preserved
        expect(result.gracePeriodExpiresAt).toEqual(activeGraceDate);
      });
    });

    describe("2.4 Single-Tier Step-Down Demotion Hierarchy", () => {
      it("demotes Diamond (Order 5) strictly to Platinum (Order 4) upon grace expiration, preventing catastrophic multi-tier collapse", async () => {
        const accountId = "acc_diamond_demote";
        const now = new Date("2026-08-26T12:00:00.000Z");
        const expiredGraceDate = new Date("2026-08-25T12:00:00.000Z"); // Expired yesterday

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: accountId,
          storeId,
          shopperId: "shopper_diamond",
          currentTier: testTiers[4], // Diamond (Order 5)
          currentTierId: "tier_5",
          tierExpiresAt: expiredGraceDate, // Grace period has expired!
          program: {
            vipMilestoneMode: "amount_spent",
            vipTimeframe: "rolling_12m",
            vipAutoDowngradeEnabled: true,
            tiers: testTiers,
          },
        } as any);

        // Shopper has $0 spend in 12m (qualifies only for Bronze order 1)
        vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce(
          [],
        );
        vi.mocked(
          prisma.weleticPointsLedgerEntry.findMany,
        ).mockResolvedValueOnce([]);

        const result = await evaluateTierMaintenanceCycle({
          storeId,
          accountId,
          now,
        });

        expect(result.status).toBe("DEMOTED");
        expect(result.tierChanged).toBe(true);
        expect(result.previousTierId).toBe("tier_5");
        expect(result.newTierId).toBe("tier_4"); // SINGLE-TIER STEP-DOWN: Platinum (Order 4)
        expect(result.newTierName).toBe("Platinum");

        // Verify tier history logged with changeReason: annual_downgrade
        expect(prisma.weleticLoyaltyTierHistory.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              accountId,
              fromTierId: "tier_5",
              toTierId: "tier_4",
              changeReason: WeleticLoyaltyTierChangeReason.annual_downgrade,
            }),
          }),
        );
      });

      it("respects vipAutoDowngradeEnabled: false and preserves VIP tier without demotion", async () => {
        const accountId = "acc_nodowngrade";

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: accountId,
          storeId,
          shopperId: "shopper_nodowngrade",
          currentTier: testTiers[3], // Platinum
          currentTierId: "tier_4",
          tierExpiresAt: null,
          program: {
            vipMilestoneMode: "amount_spent",
            vipTimeframe: "rolling_12m",
            vipAutoDowngradeEnabled: false, // DOWNGRADES DISABLED GLOBALLY
            tiers: testTiers,
          },
        } as any);

        vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce(
          [],
        );
        vi.mocked(
          prisma.weleticPointsLedgerEntry.findMany,
        ).mockResolvedValueOnce([]);

        const result = await evaluateTierMaintenanceCycle({
          storeId,
          accountId,
        });

        expect(result.status).toBe("MAINTAINED");
        expect(result.newTierId).toBe("tier_4");
        expect(result.tierChanged).toBe(false);
      });
    });

    describe("2.5 Batch VIP Tier Evaluation Runner", () => {
      it("evaluates multiple accounts in batch and tallies lifecycle statuses accurately", async () => {
        vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
          { id: "acc_1" },
          { id: "acc_2" },
        ] as any);

        // Account 1: Promoted
        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_1",
          storeId,
          shopperId: "shopper_1",
          currentTier: testTiers[0],
          currentTierId: "tier_1",
          program: {
            vipMilestoneMode: "amount_spent",
            vipTimeframe: "rolling_12m",
            tiers: testTiers,
          },
        } as any);
        vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
          { presentmentNet: BigInt(60000) } as any,
        ]);
        vi.mocked(
          prisma.weleticPointsLedgerEntry.findMany,
        ).mockResolvedValueOnce([]);

        // Account 2: Maintained
        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: "acc_2",
          storeId,
          shopperId: "shopper_2",
          currentTier: testTiers[0],
          currentTierId: "tier_1",
          program: {
            vipMilestoneMode: "amount_spent",
            vipTimeframe: "rolling_12m",
            tiers: testTiers,
          },
        } as any);
        vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce(
          [],
        );
        vi.mocked(
          prisma.weleticPointsLedgerEntry.findMany,
        ).mockResolvedValueOnce([]);

        const batch = await batchEvaluateTierMaintenanceCycle({
          storeId,
        });

        expect(batch.totalEvaluated).toBe(2);
        expect(batch.promoted).toBe(1);
        expect(batch.maintained).toBe(1);
        expect(batch.results).toHaveLength(2);
      });
    });
  });

  // ==========================================================================
  // 3. CUSTOMER METAFIELD SYNC & PII PRIVACY STRESS TESTING
  // ==========================================================================
  describe("3. Customer Metafield Sync & PII Privacy Stress Testing", () => {
    describe("3.1 Strict PII Exclusion & Data Typing", () => {
      it("STRICT PRIVACY INVARIANT: Customer metafield sync payload NEVER contains PII fields (email, phone, name, address, birth_date)", async () => {
        const storeId = "store_privacy_test";
        const accountId = "acc_privacy_1";
        const shopifyCustomerId = "gid://shopify/Customer/1122334455";

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: accountId,
          storeId,
          cachedPointsBalance: BigInt(850),
          cachedPendingPoints: BigInt(150),
          lifetimePointsEarned: BigInt(2000),
          referralCode: "PRIVACY01",
          status: "active",
          tierExpiresAt: null,
          currentTier: {
            id: "tier_gold",
            name: "Gold",
            tierOrder: 3,
            pointsMultiplier: 1.5,
          },
          shopper: {
            id: "shopper_priv_1",
            shopifyCustomerId: "1122334455",
            email: "sensitive.shopper@private.org",
            firstName: "Satoshi",
            lastName: "Nakamoto",
            phone: "+15550199283",
          },
          store: {
            id: storeId,
            shopDomain: "secure-shop.myshopify.com",
          },
        } as any);

        const result = await syncCustomerMetafields({
          storeId,
          accountId,
          shopifyCustomerId,
          customFetch: vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
              data: { metafieldsSet: { metafields: [], userErrors: [] } },
            }),
          }) as any,
        });

        expect(result.success).toBe(true);
        expect(result.syncedKeys).toHaveLength(9);

        // Verify explicit presence of 9 loyalty projection keys
        const expectedKeys = [
          "vip_tier",
          "vip_tier_order",
          "points_balance",
          "pending_points",
          "lifetime_points",
          "referral_code",
          "referral_link",
          "tier_multiplier",
          "member_status",
        ];
        expect(result.syncedKeys.sort()).toEqual(expectedKeys.sort());

        // Verify total ABSENCE of sensitive PII keys
        const forbiddenKeys = [
          "birth_date",
          "birthdate",
          "dob",
          "email",
          "phone",
          "first_name",
          "last_name",
          "name",
          "address",
          "street",
          "city",
          "country",
          "zip",
          "postal_code",
          "credit_card",
          "token",
          "password",
          "secret",
        ];

        for (const forbidden of forbiddenKeys) {
          expect(result.syncedKeys).not.toContain(forbidden);
        }

        // Verify all metafield namespaces are strictly "weletic_loyalty"
        for (const mf of result.metafields) {
          expect(mf.namespace).toBe(WELETIC_LOYALTY_NAMESPACE);
          expect(mf.ownerId).toBe("gid://shopify/Customer/1122334455");
        }
      });

      it("payload builder strictly ignores unknown or injected sensitive fields", () => {
        const maliciousPayload = {
          ownerId: "gid://shopify/Customer/999",
          vipTierName: "Silver",
          pointsBalance: 300,
          // Injected adversarial properties
          email: "victim@leak.com",
          passwordHash:
            "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8",
          creditCard: "4111111111111111",
          sessionToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
          nationalId: "123-45-6789",
        } as any;

        const metafields = buildCustomerMetafieldUpdates(maliciousPayload);

        const generatedKeys = metafields.map((m) => m.key);
        expect(generatedKeys).toEqual(["vip_tier", "points_balance"]);
        expect(generatedKeys).not.toContain("email");
        expect(generatedKeys).not.toContain("passwordHash");
        expect(generatedKeys).not.toContain("creditCard");
        expect(generatedKeys).not.toContain("sessionToken");
        expect(generatedKeys).not.toContain("nationalId");
      });
    });

    describe("3.2 Resilient Error & Edge Case Handling", () => {
      it("returns structured failure when no Shopify customer ID is linked", async () => {
        const storeId = "store_err_1";
        const accountId = "acc_no_shopify_id";

        vi.mocked(
          prisma.weleticLoyaltyAccount.findUnique,
        ).mockResolvedValueOnce({
          id: accountId,
          storeId,
          cachedPointsBalance: BigInt(0),
          shopper: null, // No shopper record
          store: { shopDomain: "test.myshopify.com" },
        } as any);

        const result = await syncCustomerMetafields({
          storeId,
          accountId,
          shopifyCustomerId: "",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("No Shopify Customer ID");
      });
    });
  });
});
