import { prisma } from "@/lib/prisma";
import { releaseHoldingPeriodGrant } from "@/lib/weletic/loyalty/holding-period";
import { reconcileAccountPoints } from "@/lib/weletic/loyalty/ledger";
import {
  PreflightRedemptionDiscrepancyError,
  provisionDiscountSaga,
} from "@/lib/weletic/loyalty/saga";
import {
  WeleticLoyaltyAccountStatus,
  WeleticPointsLedgerEntryType,
  WeleticRewardStatus,
  WeleticRewardType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyProgram: {
      findUnique: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    weleticRewardDefinition: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    weleticRewardRedemption: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    weleticLoyaltyEarnGrant: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    weleticCommerceOrder: {
      findUnique: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
    },
    weleticShopifyStore: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (cb) => {
      if (typeof cb === "function") {
        return await cb(prisma);
      }
      return Promise.all(cb);
    }),
  },
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

describe("Adversarial Hardening & Remediation Verification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Area 1: Pre-flight Redemption Discrepancy & Quarantine", () => {
    it("rejects redemption and permanently quarantines account when cached balance drifts above authoritative ledger", async () => {
      const storeId = "store_adv_1";
      const accountId = "acc_drift_1";
      const rewardDefinitionId = "rw_def_1";

      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: storeId,
        myshopifyDomain: "adv1.myshopify.com",
        primaryDomain: "adv1.myshopify.com",
        operationalWritesBlockedAt: null,
      } as any);

      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue({
        id: "prog_adv_1",
        storeId,
        status: "active",
        killSwitchActive: false,
        metadata: null,
      } as any);

      const accountMock = {
        id: accountId,
        storeId,
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(500), // Cached says 500
        lifetimePointsEarned: BigInt(500),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 1,
        metadata: { tier: "VIP" },
        shopper: { id: "shop_1", shopifyCustomerId: "12345" },
        store: { id: storeId, projectId: "ws_adv_1" },
        program: { id: "prog_adv_1", storeId },
      };
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue(
        accountMock as any,
      );
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue(
        accountMock as any,
      );

      vi.mocked(prisma.weleticRewardDefinition.findUnique).mockResolvedValue({
        id: rewardDefinitionId,
        storeId,
        pointsCost: BigInt(100),
        rewardType: WeleticRewardType.amount_off,
        discountValue: 1000,
        status: WeleticRewardStatus.active,
      } as any);

      // But authoritative ledger sum is only 50 (insufficient and drifted!)
      vi.mocked(prisma.weleticPointsLedgerEntry.aggregate).mockResolvedValue({
        _sum: { pointsDelta: BigInt(50) },
        _count: { id: 1 },
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.count).mockResolvedValue(1);

      await expect(
        provisionDiscountSaga({
          storeId,
          accountId,
          rewardDefinitionId,
          discountCode: "WL-DRIFT-TEST",
          idempotencyKey: "drift-test-key-1",
          shopDomain: "adv1.myshopify.com",
          accessToken: "shpat_test",
        }),
      ).rejects.toThrow(PreflightRedemptionDiscrepancyError);

      // Verify quarantine was committed to DB outside the transaction
      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            status: "suspended",
            metadata: expect.objectContaining({
              tier: "VIP",
              quarantine: expect.objectContaining({
                isQuarantined: true,
                cachedBalance: "500",
                ledgerSum: "50",
                requiredPoints: "100",
              }),
            }),
          }),
        }),
      );
    });

    it("rejects redemption and quarantines account when cross-tenant entries are detected", async () => {
      const storeId = "store_adv_1";
      const accountId = "acc_tenant_leak";
      const rewardDefinitionId = "rw_def_1";

      vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
        id: storeId,
        myshopifyDomain: "adv1.myshopify.com",
        primaryDomain: "adv1.myshopify.com",
        operationalWritesBlockedAt: null,
      } as any);

      vi.mocked(prisma.weleticLoyaltyProgram.findUnique).mockResolvedValue({
        id: "prog_adv_1",
        storeId,
        status: "active",
        killSwitchActive: false,
        metadata: null,
      } as any);

      const accountMock = {
        id: accountId,
        storeId,
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(100),
        lifetimePointsEarned: BigInt(100),
        lifetimePointsRedeemed: BigInt(0),
        ledgerVersion: 2,
        metadata: {},
        shopper: { id: "shop_2", shopifyCustomerId: "12345" },
        store: { id: storeId, projectId: "ws_adv_1" },
        program: { id: "prog_adv_1", storeId },
      };
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue(
        accountMock as any,
      );
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue(
        accountMock as any,
      );

      vi.mocked(prisma.weleticRewardDefinition.findUnique).mockResolvedValue({
        id: rewardDefinitionId,
        storeId,
        pointsCost: BigInt(100),
        rewardType: WeleticRewardType.amount_off,
        discountValue: 1000,
        status: WeleticRewardStatus.active,
      } as any);

      // Store-specific entries count is 1, but total account entries across stores is 2!
      vi.mocked(prisma.weleticPointsLedgerEntry.aggregate).mockResolvedValue({
        _sum: { pointsDelta: BigInt(100) },
        _count: { id: 1 },
      } as any);
      vi.mocked(prisma.weleticPointsLedgerEntry.count).mockResolvedValue(2);

      await expect(
        provisionDiscountSaga({
          storeId,
          accountId,
          rewardDefinitionId,
          discountCode: "WL-CROSS-STORE",
          idempotencyKey: "cross-store-key-1",
          shopDomain: "adv1.myshopify.com",
          accessToken: "shpat_test",
        }),
      ).rejects.toThrow(PreflightRedemptionDiscrepancyError);

      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            status: "suspended",
            metadata: expect.objectContaining({
              quarantine: expect.objectContaining({
                isQuarantined: true,
                reason: expect.stringContaining(
                  "contains cross-tenant entries",
                ),
              }),
            }),
          }),
        }),
      );
    });
  });

  describe("Area 2: ReconcileAccountPoints Tamper-Evident Ledger Anomaly Detection", () => {
    it("quarantines account upon sequence collision in reconcileAccountPoints", async () => {
      const accountId = "acc_collision";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: accountId,
        storeId: "store_adv_2",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(200),
        metadata: {},
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "e1",
          sequenceNumber: 1,
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(100),
        },
        {
          id: "e2",
          sequenceNumber: 1,
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(200),
        }, // Duplicate sequence 1!
      ] as any);

      await expect(reconcileAccountPoints(accountId)).rejects.toThrow(
        "Sequence collision detected",
      );

      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            status: "suspended",
            metadata: expect.objectContaining({
              quarantine: expect.objectContaining({
                isQuarantined: true,
                reason: expect.stringContaining("Sequence collision detected"),
              }),
            }),
          }),
        }),
      );
    });

    it("quarantines account upon cross-tenant entry in reconcileAccountPoints", async () => {
      const accountId = "acc_cross_tenant_recon";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: accountId,
        storeId: "store_target",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(200),
        metadata: {},
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "e1",
          sequenceNumber: 1,
          storeId: "store_target",
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(100),
        },
        {
          id: "e2",
          sequenceNumber: 2,
          storeId: "alien_store",
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(200),
        }, // Cross-tenant!
      ] as any);

      await expect(reconcileAccountPoints(accountId)).rejects.toThrow(
        "Cross-tenant entry detected",
      );

      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            status: "suspended",
            metadata: expect.objectContaining({
              quarantine: expect.objectContaining({
                isQuarantined: true,
                reason: expect.stringContaining("Cross-tenant entry detected"),
              }),
            }),
          }),
        }),
      );
    });

    it("quarantines account upon illegal positive delta on REDEEM_REWARD in reconcileAccountPoints", async () => {
      const accountId = "acc_illegal_delta";
      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: accountId,
        storeId: "store_target",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(200),
        metadata: {},
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([
        {
          id: "e1",
          sequenceNumber: 1,
          storeId: "store_target",
          pointsDelta: BigInt(100),
          balanceAfter: BigInt(100),
        },
        {
          id: "e2",
          sequenceNumber: 2,
          storeId: "store_target",
          entryType: WeleticPointsLedgerEntryType.REDEEM_REWARD,
          pointsDelta: BigInt(100), // Positive delta on REDEEM_REWARD!
          balanceAfter: BigInt(200),
        },
      ] as any);

      await expect(reconcileAccountPoints(accountId)).rejects.toThrow(
        "Illegal positive points delta",
      );

      expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: accountId },
          data: expect.objectContaining({
            status: "suspended",
            metadata: expect.objectContaining({
              quarantine: expect.objectContaining({
                isQuarantined: true,
                reason: expect.stringContaining(
                  "Illegal positive points delta",
                ),
              }),
            }),
          }),
        }),
      );
    });
  });

  describe("Area 4: Referral Holding Period Release & Voiding", () => {
    it("releases matured referral points when qualifying order is paid", async () => {
      const referralId = "ref_holding_1";
      const orderId = "order_paid_1";
      const advocateAccountId = "acc_advocate_1";

      vi.mocked(prisma.weleticLoyaltyReferral.findUnique).mockResolvedValue({
        id: referralId,
        storeId: "store_ref_1",
        advocateAccountId,
        status: "qualified",
      } as any);

      vi.mocked(prisma.weleticCommerceOrder.findUnique).mockResolvedValue({
        id: orderId,
        storeId: "store_ref_1",
        status: "paid",
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: advocateAccountId,
        storeId: "store_ref_1",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(500),
        ledgerVersion: 1,
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findFirst).mockResolvedValue(
        null,
      );
      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValue({
        id: "wpledger_matured_1",
        sequenceNumber: 2,
        balanceAfter: BigInt(500),
      } as any);

      const result = await releaseHoldingPeriodGrant({
        storeId: "store_ref_1",
        jobId: "job_release_1",
        payload: {
          referralId,
          orderId,
          accountId: advocateAccountId,
          pendingPoints: "500",
          holdingPeriodDays: 14,
          availableAt: new Date(Date.now() - 1000).toISOString(),
        },
      });

      expect(result.released).toBe(true);
      expect(result.reason).toBe("matured");
      expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entryType: WeleticPointsLedgerEntryType.EARN_REFERRAL,
            pointsDelta: BigInt(500),
            pendingDelta: -BigInt(500),
          }),
        }),
      );
    });

    it("voids pending referral points when qualifying order was refunded or cancelled", async () => {
      const referralId = "ref_holding_refunded";
      const orderId = "order_refunded_1";
      const advocateAccountId = "acc_advocate_2";

      vi.mocked(prisma.weleticLoyaltyReferral.findUnique).mockResolvedValue({
        id: referralId,
        storeId: "store_ref_1",
        advocateAccountId,
        status: "qualified",
      } as any);

      vi.mocked(prisma.weleticCommerceOrder.findUnique).mockResolvedValue({
        id: orderId,
        storeId: "store_ref_1",
        status: "refunded",
      } as any);

      vi.mocked(prisma.weleticLoyaltyAccount.findUnique).mockResolvedValue({
        id: advocateAccountId,
        storeId: "store_ref_1",
        status: WeleticLoyaltyAccountStatus.active,
        cachedPointsBalance: BigInt(0),
        cachedPendingPoints: BigInt(500),
        ledgerVersion: 1,
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findFirst).mockResolvedValue(
        null,
      );
      vi.mocked(prisma.weleticPointsLedgerEntry.create).mockResolvedValue({
        id: "wpledger_void_1",
        sequenceNumber: 2,
        balanceAfter: BigInt(0),
      } as any);

      const result = await releaseHoldingPeriodGrant({
        storeId: "store_ref_1",
        jobId: "job_release_2",
        payload: {
          referralId,
          orderId,
          accountId: advocateAccountId,
          pendingPoints: "500",
          holdingPeriodDays: 14,
          availableAt: new Date(Date.now() - 1000).toISOString(),
        },
      });

      expect(result.released).toBe(false);
      expect(result.reason).toBe("qualifying_order_refunded");
      expect(prisma.weleticPointsLedgerEntry.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            entryType: WeleticPointsLedgerEntryType.REFUND_REVERSAL,
            pointsDelta: BigInt(0),
            pendingDelta: -BigInt(500),
          }),
        }),
      );
    });
  });
});
