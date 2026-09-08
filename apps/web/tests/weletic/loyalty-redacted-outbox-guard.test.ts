import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  redemptionFindUnique: vi.fn(),
  withDistributedLock: vi.fn(),
  issueReferralRewardCoupon: vi.fn(),
  recoverCompensatedReferralCouponDiscount: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticLoyaltyAccount: { findFirst: mocks.accountFindFirst },
    weleticRewardRedemption: { findUnique: mocks.redemptionFindUnique },
  },
}));
vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: mocks.withDistributedLock,
}));
vi.mock("@/lib/weletic/loyalty/referral-coupon", () => ({
  issueReferralRewardCoupon: mocks.issueReferralRewardCoupon,
  recoverCompensatedReferralCouponDiscount:
    mocks.recoverCompensatedReferralCouponDiscount,
  getReferralCouponIdempotencyKey: vi.fn(() => "referral:key"),
  ReferralCouponReconciliationPendingError: class extends Error {},
}));

import { executeOutboxJob } from "@/lib/weletic/loyalty/outbox-worker";
import { shopifyCustomerSettlementLockKeys } from "@/lib/weletic/shopify/customer-settlement-lock";

const job = {
  id: "job_referral_coupon",
  storeId: "store_target",
  jobType: "REFERRAL_REWARD_PROVISION",
  status: "processing",
  payload: {
    referralId: "referral_1",
    qualificationOrderId: "order_1",
    accountId: "account_1",
    rewardDefinitionId: "reward_1",
    side: "advocate",
  },
};

describe("redacted loyalty outbox guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.withDistributedLock.mockImplementation(async ({ fn }) => fn());
    mocks.redemptionFindUnique.mockResolvedValue(null);
  });

  it("serializes with customer redaction and fails closed after account closure", async () => {
    mocks.accountFindFirst
      .mockResolvedValueOnce({
        status: "active",
        shopper: { shopifyCustomerId: "customer_42" },
        store: { projectId: "workspace_target" },
      })
      .mockResolvedValueOnce({ status: "closed" });

    await executeOutboxJob(job as any);

    const expectedLockKeys = shopifyCustomerSettlementLockKeys({
      workspaceId: "workspace_target",
      storeId: "store_target",
      shopifyCustomerId: "customer_42",
    });
    expect(mocks.withDistributedLock).toHaveBeenCalledTimes(
      expectedLockKeys.length,
    );
    for (const key of expectedLockKeys) {
      expect(mocks.withDistributedLock).toHaveBeenCalledWith({
        key,
        ttlSeconds: 1_800,
        fn: expect.any(Function),
      });
      expect(key).not.toContain("customer_42");
    }
    expect(mocks.issueReferralRewardCoupon).not.toHaveBeenCalled();
    expect(mocks.redemptionFindUnique).toHaveBeenCalledWith({
      where: {
        storeId_idempotencyKey: {
          storeId: "store_target",
          idempotencyKey: "referral:key",
        },
      },
    });
  });

  it("runs only compensated coupon cleanup after account closure", async () => {
    const compensatedRedemption = {
      id: "redemption_compensated",
      status: "cancelled",
    };
    mocks.accountFindFirst
      .mockResolvedValueOnce({
        status: "active",
        shopper: { shopifyCustomerId: "customer_42" },
        store: { projectId: "workspace_target" },
      })
      .mockResolvedValueOnce({ status: "closed" });
    mocks.redemptionFindUnique.mockResolvedValue(compensatedRedemption);
    mocks.recoverCompensatedReferralCouponDiscount.mockResolvedValue(true);

    await executeOutboxJob(job as any);

    expect(mocks.issueReferralRewardCoupon).not.toHaveBeenCalled();
    expect(mocks.recoverCompensatedReferralCouponDiscount).toHaveBeenCalledWith(
      {
        storeId: "store_target",
        redemption: compensatedRedemption,
      },
    );
  });

  it("continues an account-scoped job only when the account is still active inside the lock", async () => {
    mocks.accountFindFirst
      .mockResolvedValueOnce({
        status: "active",
        shopper: { shopifyCustomerId: "customer_42" },
        store: { projectId: "workspace_target" },
      })
      .mockResolvedValueOnce({ status: "active" });
    mocks.issueReferralRewardCoupon.mockResolvedValue(undefined);

    await executeOutboxJob(job as any);

    expect(mocks.issueReferralRewardCoupon).toHaveBeenCalledWith({
      storeId: "store_target",
      ...job.payload,
    });
  });
});
