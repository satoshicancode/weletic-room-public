import { prisma } from "@/lib/prisma";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import { getPrivacySafeLoyaltyDiscountMetadata } from "@/lib/weletic/loyalty/redemption-discount-identity";
import { cancelRewardRedemption } from "@/lib/weletic/loyalty/rewards";
import {
  deactivateDiscount,
  resolveShopifyOfflineCredentials,
} from "@/lib/weletic/loyalty/shopify-discounts";
import { withShopifyCustomerSettlementLocks } from "@/lib/weletic/shopify/customer-settlement-lock";
import {
  WeleticRedemptionStatus,
  WeleticRewardArtifactKind,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticRewardRedemption: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticPointsLedgerEntry: { findUnique: vi.fn() },
    weleticLoyaltyOutboxJob: { update: vi.fn() },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: vi.fn(),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: vi.fn(),
}));

vi.mock("@/lib/weletic/loyalty/saga", () => ({
  provisionDiscountSaga: vi.fn(),
}));

vi.mock("@/lib/weletic/loyalty/shopper-privacy", () => ({
  hasShopifyCustomerRedactionTombstone: vi.fn(
    (metadata: Record<string, unknown> | null) =>
      Boolean(metadata?.shopifyCustomerRedaction),
  ),
}));

vi.mock("@/lib/weletic/redis-lock", () => ({
  withDistributedLock: vi.fn(async ({ fn }) => fn()),
}));

vi.mock("@/lib/weletic/shopify/customer-settlement-lock", () => ({
  withShopifyCustomerSettlementLocks: vi.fn(async ({ fn }) => fn()),
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", () => ({
  deactivateDiscount: vi.fn(),
  lookupDiscountByCode: vi.fn(),
  resolveShopifyOfflineCredentials: vi.fn(),
}));

const storeId = "store_privacy";
const accountId = "account_privacy";
const redemptionId = "redemption_privacy";

function redemptionFixture({
  status = WeleticRedemptionStatus.active,
  accountStatus = "active",
  accountMetadata = null,
}: {
  status?: WeleticRedemptionStatus;
  accountStatus?: string;
  accountMetadata?: Record<string, unknown> | null;
} = {}) {
  return {
    id: redemptionId,
    storeId,
    accountId,
    rewardDefinitionId: "reward_10_off",
    pointsSpent: BigInt(500),
    status,
    metadata: { orderName: "#PII-ORDER", customerEmail: "pii@example.com" },
    shopifyDiscountCode: "PRIVATE-CODE",
    shopifyDiscountCodeCanonical: "PRIVATE-CODE",
    artifactKind: WeleticRewardArtifactKind.discount_code,
    settlementQuarantinedAt: null,
    shopifyDiscountId: "gid://shopify/DiscountCodeNode/123",
    account: {
      id: accountId,
      storeId,
      status: accountStatus,
      metadata: accountMetadata,
    },
    rewardDefinition: { id: "reward_10_off", name: "$10 off" },
  };
}

describe("reward cancellation customer-redaction serialization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticRewardRedemption.findFirst).mockResolvedValue({
      account: {
        storeId,
        shopper: { shopifyCustomerId: "shopify_customer_42" },
        store: { projectId: "workspace_privacy" },
      },
    } as any);
    vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) =>
      callback(prisma),
    );
    vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
      count: 1,
    } as any);
    vi.mocked(appendPointsLedgerEntry).mockImplementation(
      async (input: any) => ({ id: "ledger_privacy", ...input }) as any,
    );
    vi.mocked(enqueueOutboxJob).mockImplementation(
      async (input: any) =>
        ({
          job: {
            id:
              input.jobType === "REDEMPTION_RECOVERY"
                ? "cleanup_job_privacy"
                : "metafield_job_privacy",
            ...input,
          },
          created: true,
        }) as any,
    );
    vi.mocked(resolveShopifyOfflineCredentials).mockResolvedValue({
      shopDomain: "privacy.myshopify.com",
      accessToken: "test-token",
    } as any);
    vi.mocked(deactivateDiscount).mockResolvedValue(true);
    vi.mocked(prisma.weleticLoyaltyOutboxJob.update).mockResolvedValue(
      {} as any,
    );
  });

  it("scrubs the customer-derived provisioning digest after privacy cancellation", () => {
    const metadata = getPrivacySafeLoyaltyDiscountMetadata({
      provisioningSnapshot: {
        customerSelectionDigest: "CUSTOMER_DERIVED_DIGEST",
      },
      shopifyDiscountOwnership: {
        version: 1,
        fingerprint: "OWNERSHIP_FINGERPRINT",
      },
      remoteProvisionAttemptedAt: "2026-08-29T00:00:00.000Z",
    });

    expect(metadata).toEqual({
      privacySafeCancellation: true,
      shopifyDiscountOwnership: {
        version: 1,
        fingerprint: "OWNERSHIP_FINGERPRINT",
      },
      remoteProvisionAttemptedAt: "2026-08-29T00:00:00.000Z",
    });
    expect(metadata).not.toHaveProperty("provisioningSnapshot");
  });

  it("re-reads under the customer lock and keeps a post-redaction cancellation privacy-safe", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
      redemptionFixture({
        accountStatus: "closed",
        accountMetadata: {
          shopifyCustomerRedaction: {
            status: "redacted",
            redactedAt: "2026-08-29T00:00:00.000Z",
            source: "shopify_customers_redact",
          },
        },
      }) as any,
    );

    await cancelRewardRedemption({
      storeId,
      redemptionId,
      reason: "Customer supplied reason with pii@example.com",
    });

    expect(withShopifyCustomerSettlementLocks).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId,
        workspaceId: "workspace_privacy",
        shopifyCustomerId: "shopify_customer_42",
      }),
    );
    expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          compensationReason: "Reward cancellation after customer redaction.",
          metadata: { privacySafeCancellation: true },
        }),
      }),
    );
    expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId,
        reason: "Reward points restored after customer redaction.",
        metadata: { privacyRedacted: true },
      }),
    );

    const enqueuedJobs = vi
      .mocked(enqueueOutboxJob)
      .mock.calls.map(([input]) => input);
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]).toEqual(
      expect.objectContaining({
        jobType: "REDEMPTION_RECOVERY",
        payload: expect.objectContaining({
          accountId,
          shopifyDiscountCode: "PRIVATE-CODE",
          sagaPhase: "compensating",
        }),
      }),
    );
    // Inline deactivation is a latency optimization only. The durable worker
    // owns the audited CAS transition so cancellation cannot falsely complete
    // a cleanup job that another worker has leased.
    expect(prisma.weleticLoyaltyOutboxJob.update).not.toHaveBeenCalled();
  });

  it("retains the normal customer sync for an active account", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
      redemptionFixture() as any,
    );

    await cancelRewardRedemption({ storeId, redemptionId });

    expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "Cancelled reward redemption for $10 off",
        metadata: {
          redemptionId,
          discountCode: "PRIVATE-CODE",
        },
      }),
    );
    expect(enqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: "METAFIELD_SYNC" }),
    );
    expect(enqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: "REDEMPTION_RECOVERY" }),
    );
  });

  it("does not refund points for a redemption quarantined pending exact Shopify identity reconciliation", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      ...redemptionFixture(),
      settlementQuarantinedAt: new Date("2026-08-29T00:00:00.000Z"),
      settlementQuarantineReason: "canonical_collision",
    } as any);

    await expect(
      cancelRewardRedemption({ storeId, redemptionId }),
    ).rejects.toThrow(
      `Cannot cancel quarantined redemption ${redemptionId}; exact Shopify identity reconciliation is required before points can be restored.`,
    );

    expect(prisma.weleticRewardRedemption.updateMany).not.toHaveBeenCalled();
    expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
    expect(enqueueOutboxJob).not.toHaveBeenCalled();
    expect(deactivateDiscount).not.toHaveBeenCalled();
  });
});
