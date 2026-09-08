import { prisma } from "@/lib/prisma";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import { settleRewardRedemptionsUsedByOrder } from "@/lib/weletic/loyalty/redemption-settlement";
import { WeleticRedemptionStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticRewardRedemption: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticReconciliationIssue: { upsert: vi.fn() },
    weleticShopifyCustomerPrivacyTombstone: { findFirst: vi.fn() },
    weleticShopifyStore: { findUnique: vi.fn() },
    $transaction: vi.fn(async (callback: any) => callback(prisma)),
  },
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  OptimisticConcurrencyError: class OptimisticConcurrencyError extends Error {},
  appendPointsLedgerEntry: vi.fn().mockResolvedValue({ id: "ledger_1" }),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: vi.fn().mockResolvedValue({ id: "outbox_1" }),
}));

describe("loyalty redemption order settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
      count: 1,
    } as any);
    vi.mocked(prisma.weleticRewardRedemption.count).mockResolvedValue(1);
    vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
      id: "account_1",
      shopper: { shopifyCustomerId: "customer_1" },
    } as any);
    vi.mocked(prisma.weleticLoyaltyReferral.updateMany).mockResolvedValue({
      count: 1,
    } as any);
    vi.mocked(prisma.weleticLoyaltyAccount.update).mockResolvedValue({} as any);
    vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockImplementation(
      (async ({ where }: any) =>
        where.id.in.map((id: string) => ({
          id,
          status: "active",
          metadata: null,
          updatedAt: new Date("2026-08-29T00:00:00.000Z"),
        }))) as any,
    );
    vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValue({
      count: 1,
    } as any);
    vi.mocked(
      prisma.weleticShopifyCustomerPrivacyTombstone.findFirst,
    ).mockResolvedValue(null);
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      id: "store_1",
      complianceState: "active",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date(0),
      installationGeneration: null,
    } as any);
  });

  it("re-reads a migrated raw code by canonical non-quarantined identity", async () => {
    const redemption = {
      id: "redemption_migrated_code",
      storeId: "store_1",
      accountId: "account_1",
      pointsSpent: BigInt(500),
      shopifyDiscountCode: " code-10 ",
      shopifyDiscountCodeCanonical: "CODE-10",
      settlementQuarantinedAt: null,
      status: WeleticRedemptionStatus.issued,
      metadata: null,
    };
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
      redemption,
    ] as any);
    vi.mocked(prisma.weleticRewardRedemption.findFirst).mockResolvedValueOnce(
      redemption as any,
    );

    const result = await settleRewardRedemptionsUsedByOrder({
      storeId: "store_1",
      discountCodes: ["CODE-10"],
      orderId: "order_migrated_code",
      shopifyCustomerId: "customer_1",
      usedAt: new Date("2026-08-30T00:00:00.000Z"),
    });

    expect(result.markedUsed).toBe(1);
    expect(prisma.weleticRewardRedemption.findFirst).toHaveBeenCalledWith({
      where: {
        storeId: "store_1",
        shopifyDiscountCodeCanonical: "CODE-10",
        settlementQuarantinedAt: null,
      },
    });
  });

  it("uses a rotation-aware linked tombstone to verify a pseudonymized voucher owner", async () => {
    const redemption = {
      id: "redemption_private_owner",
      storeId: "store_1",
      accountId: "account_private",
      pointsSpent: BigInt(500),
      shopifyDiscountCode: "PRIVATE-OWNER",
      shopifyDiscountCodeCanonical: "PRIVATE-OWNER",
      settlementQuarantinedAt: null,
      status: WeleticRedemptionStatus.issued,
      metadata: null,
    };
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
      redemption,
    ] as any);
    vi.mocked(prisma.weleticRewardRedemption.findFirst).mockResolvedValueOnce(
      redemption as any,
    );
    vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
      id: "account_private",
      shopper: {
        id: "shopper_private",
        shopifyCustomerId:
          "redacted:v1:previous-2025:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    } as any);
    vi.mocked(
      prisma.weleticShopifyCustomerPrivacyTombstone.findFirst,
    ).mockResolvedValueOnce({ id: "tombstone_previous_key" } as any);

    const result = await settleRewardRedemptionsUsedByOrder({
      storeId: "store_1",
      discountCodes: ["private-owner"],
      orderId: "order_private_owner",
      shopifyCustomerId: "gid://shopify/Customer/customer-private-42",
      usedAt: new Date("2026-08-30T00:00:00.000Z"),
    });

    expect(result.markedUsed).toBe(1);
    const tombstoneLookup = vi.mocked(
      prisma.weleticShopifyCustomerPrivacyTombstone.findFirst,
    ).mock.calls[0][0] as any;
    expect(tombstoneLookup.where).toMatchObject({
      storeId: "store_1",
      AND: [
        { OR: expect.any(Array) },
        {
          OR: [
            { shopperId: "shopper_private" },
            { accountId: "account_private" },
          ],
        },
      ],
    });
    expect(JSON.stringify(tombstoneLookup)).not.toContain(
      "customer-private-42",
    );
  });

  it("re-debits a compensated redemption when a late order webhook proves use", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
      {
        id: "redemption_late_1",
        storeId: "store_1",
        accountId: "account_1",
        pointsSpent: BigInt(500),
        shopifyDiscountCode: "WL-LATE01",
        status: WeleticRedemptionStatus.cancelled,
        metadata: { compensationReason: "merchant_cancelled" },
      },
    ] as any);
    vi.mocked(prisma.weleticRewardRedemption.findFirst).mockResolvedValueOnce({
      id: "redemption_late_1",
      storeId: "store_1",
      accountId: "account_1",
      pointsSpent: BigInt(500),
      shopifyDiscountCode: "WL-LATE01",
      status: WeleticRedemptionStatus.cancelled,
      metadata: {
        compensationReason: "merchant_cancelled",
        remoteProvisionAttemptedAt: "2026-08-26T23:59:59.000Z",
      },
    } as any);

    const result = await settleRewardRedemptionsUsedByOrder({
      storeId: "store_1",
      discountCodes: ["wl-late01"],
      orderId: "order_1",
      shopifyCustomerId: "customer_1",
      usedAt: new Date("2026-08-27T00:00:00Z"),
      orderMetadata: { orderName: "#1001" },
    });

    expect(result).toEqual({
      matched: 1,
      markedUsed: 1,
      lateUseCorrections: 1,
    });
    expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store_1",
        accountId: "account_1",
        pointsDelta: BigInt(-500),
        idempotencyKey: "redemption_late_use:redemption_late_1",
      }),
    );
    expect(enqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId: "store_1",
        idempotencyKey: "metafield_sync:used:redemption_late_1",
      }),
    );
    expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: {
            compensationReason: "merchant_cancelled",
            remoteProvisionAttemptedAt: "2026-08-26T23:59:59.000Z",
            orderName: "#1001",
          },
        }),
      }),
    );
  });

  it.each([
    ["issued", WeleticRedemptionStatus.issued, false],
    ["ambiguous provisioning", WeleticRedemptionStatus.provisioning, false],
    ["compensated", WeleticRedemptionStatus.cancelled, true],
  ] as const)(
    "settles %s redacted-owner coupon use without restoring customer context",
    async (_caseName, status, expectsLateUseCorrection) => {
      const redactedAt = new Date("2026-08-29T00:00:00.000Z");
      const metadata = expectsLateUseCorrection
        ? { compensationReason: "merchant_cancelled" }
        : null;
      vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
        {
          id: "redemption_redacted_owner",
          storeId: "store_1",
          accountId: "account_redacted_owner",
          pointsSpent: BigInt(500),
          shopifyDiscountCode: "WL-REDACTED",
          status,
          metadata,
        },
      ] as any);
      vi.mocked(prisma.weleticRewardRedemption.findFirst).mockResolvedValueOnce(
        {
          id: "redemption_redacted_owner",
          storeId: "store_1",
          accountId: "account_redacted_owner",
          pointsSpent: BigInt(500),
          shopifyDiscountCode: "WL-REDACTED",
          status,
          metadata,
        } as any,
      );
      vi.mocked(prisma.weleticLoyaltyAccount.findMany).mockResolvedValueOnce([
        {
          id: "account_redacted_owner",
          status: "closed",
          metadata: {
            shopifyCustomerRedaction: {
              status: "redacted",
              redactedAt: redactedAt.toISOString(),
              source: "shopify_customers_redact",
            },
          },
          updatedAt: redactedAt,
        },
      ] as any);

      const result = await settleRewardRedemptionsUsedByOrder({
        storeId: "store_1",
        discountCodes: ["WL-REDACTED"],
        orderId: "order_redacted_owner_coupon",
        shopifyCustomerId: "customer_1",
        usedAt: new Date("2026-08-29T00:00:01.000Z"),
        orderMetadata: {
          orderName: "#PRIVATE",
          totalAmount: "123.45",
          currency: "USD",
        },
      });

      expect(result).toEqual({
        matched: 1,
        markedUsed: 1,
        lateUseCorrections: expectsLateUseCorrection ? 1 : 0,
      });
      expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: "account_redacted_owner",
            storeId: "store_1",
            status: "closed",
            updatedAt: redactedAt,
          },
        }),
      );
      const transition = vi.mocked(prisma.weleticRewardRedemption.updateMany)
        .mock.calls[0][0] as any;
      expect(transition.data).toMatchObject({
        status: WeleticRedemptionStatus.used,
        orderId: "order_redacted_owner_coupon",
      });
      expect(transition.data.metadata).toBeUndefined();
      if (expectsLateUseCorrection) {
        expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId: "account_redacted_owner",
            pointsDelta: BigInt(-500),
            reason:
              "Compensated reward financial correction after customer redaction",
            metadata: null,
          }),
        );
      } else {
        expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
      }
      expect(enqueueOutboxJob).not.toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: "METAFIELD_SYNC",
          payload: expect.objectContaining({
            accountId: "account_redacted_owner",
          }),
        }),
      );
    },
  );

  it("treats an active account with an independent tombstone as privacy-redacted", async () => {
    const redemption = {
      id: "redemption_independent_tombstone",
      storeId: "store_1",
      accountId: "account_1",
      pointsSpent: BigInt(500),
      shopifyDiscountCode: "WL-TOMBSTONE",
      status: WeleticRedemptionStatus.issued,
      metadata: null,
    };
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
      redemption,
    ] as any);
    vi.mocked(prisma.weleticRewardRedemption.findFirst).mockResolvedValueOnce(
      redemption as any,
    );
    vi.mocked(
      prisma.weleticShopifyCustomerPrivacyTombstone.findFirst,
    ).mockResolvedValue({ id: "independent_tombstone" } as any);

    const result = await settleRewardRedemptionsUsedByOrder({
      storeId: "store_1",
      discountCodes: ["WL-TOMBSTONE"],
      orderId: "late_order_after_shop_redact",
      shopifyCustomerId: "customer_1",
      usedAt: new Date("2026-08-30T00:00:00.000Z"),
      orderMetadata: {
        orderName: "#RAW-LATE",
        customerEmail: "must-not-persist@example.com",
      },
    });

    expect(result.markedUsed).toBe(1);
    const transition = vi.mocked(prisma.weleticRewardRedemption.updateMany).mock
      .calls[0][0] as any;
    expect(transition.data.status).toBe(WeleticRedemptionStatus.used);
    expect(transition.data.metadata).toBeUndefined();
    expect(JSON.stringify(transition)).not.toContain("must-not-persist");
    expect(enqueueOutboxJob).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobType: "METAFIELD_SYNC" }),
    );
  });

  it("marks an issued redemption used without debiting points twice", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
      {
        id: "redemption_issued_1",
        storeId: "store_1",
        accountId: "account_1",
        pointsSpent: BigInt(500),
        shopifyDiscountCode: "WL-ISSUED01",
        status: WeleticRedemptionStatus.issued,
        metadata: null,
      },
    ] as any);
    vi.mocked(prisma.weleticRewardRedemption.findFirst).mockResolvedValueOnce({
      id: "redemption_issued_1",
      storeId: "store_1",
      accountId: "account_1",
      pointsSpent: BigInt(500),
      shopifyDiscountCode: "WL-ISSUED01",
      status: WeleticRedemptionStatus.issued,
      metadata: null,
    } as any);

    const result = await settleRewardRedemptionsUsedByOrder({
      storeId: "store_1",
      discountCodes: ["WL-ISSUED01"],
      orderId: "order_2",
      shopifyCustomerId: "customer_1",
      usedAt: new Date("2026-08-27T00:00:00Z"),
    });

    expect(result.lateUseCorrections).toBe(0);
    expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("fails closed and opens reconciliation when one code maps to two accounts", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
      {
        id: "redemption_duplicate_1",
        storeId: "store_1",
        accountId: "account_1",
        shopifyDiscountCode: "WL-DUPLICATE",
        status: WeleticRedemptionStatus.issued,
      },
      {
        id: "redemption_duplicate_2",
        storeId: "store_1",
        accountId: "account_2",
        shopifyDiscountCode: "wl-duplicate",
        status: WeleticRedemptionStatus.cancelled,
      },
    ] as any);
    vi.mocked(prisma.weleticRewardRedemption.count).mockResolvedValueOnce(2);

    const result = await settleRewardRedemptionsUsedByOrder({
      storeId: "store_1",
      discountCodes: ["wl-duplicate", "WL-DUPLICATE"],
      orderId: "order_duplicate",
      shopifyCustomerId: "customer_1",
      usedAt: new Date("2026-08-29T02:00:00.000Z"),
    });

    expect(result).toEqual({
      matched: 2,
      markedUsed: 0,
      lateUseCorrections: 0,
    });
    expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          storeId: "store_1",
          externalKey: "order_duplicate:WL-DUPLICATE",
          kind: "redemption_settlement_ambiguity",
          severity: "critical",
          status: "open",
          details: expect.objectContaining({
            reason: "redemption_code_cardinality_mismatch",
            candidateCount: 2,
            candidateRedemptionIds: [
              "redemption_duplicate_1",
              "redemption_duplicate_2",
            ],
            candidateAccountIds: ["account_1", "account_2"],
            resolutionMarker: "manual_redemption_settlement_required",
          }),
        }),
      }),
    );
    expect(prisma.weleticRewardRedemption.findFirst).not.toHaveBeenCalled();
    expect(prisma.weleticRewardRedemption.updateMany).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyReferral.updateMany).not.toHaveBeenCalled();
    expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
    expect(enqueueOutboxJob).not.toHaveBeenCalled();
  });

  it("fails closed and opens reconciliation when the order customer does not own the redemption", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
      {
        id: "redemption_wrong_customer",
        storeId: "store_1",
        accountId: "account_owner",
        shopifyDiscountCode: "WL-CUSTOMER",
        status: WeleticRedemptionStatus.cancelled,
      },
    ] as any);
    vi.mocked(prisma.weleticRewardRedemption.findFirst).mockResolvedValueOnce({
      id: "redemption_wrong_customer",
      storeId: "store_1",
      accountId: "account_owner",
      pointsSpent: BigInt(500),
      shopifyDiscountCode: "WL-CUSTOMER",
      status: WeleticRedemptionStatus.cancelled,
      metadata: null,
    } as any);
    vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
      id: "account_owner",
      shopper: { shopifyCustomerId: "customer_owner" },
    } as any);

    const result = await settleRewardRedemptionsUsedByOrder({
      storeId: "store_1",
      discountCodes: ["WL-CUSTOMER"],
      orderId: "order_wrong_customer",
      shopifyCustomerId: "customer_attacker",
      usedAt: new Date("2026-08-29T02:01:00.000Z"),
    });

    expect(result).toEqual({
      matched: 1,
      markedUsed: 0,
      lateUseCorrections: 0,
    });
    expect(prisma.weleticReconciliationIssue.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          storeId: "store_1",
          externalKey: "order_wrong_customer:WL-CUSTOMER",
          kind: "redemption_settlement_ambiguity",
          severity: "critical",
          status: "open",
          details: expect.objectContaining({
            reason: "redemption_customer_mismatch",
            candidateCount: 1,
            candidateRedemptionIds: ["redemption_wrong_customer"],
            candidateAccountIds: ["account_owner"],
            orderCustomerIdPresent: true,
          }),
        }),
      }),
    );
    expect(prisma.weleticRewardRedemption.updateMany).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyReferral.updateMany).not.toHaveBeenCalled();
    expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
    expect(enqueueOutboxJob).not.toHaveBeenCalled();
  });

  it("retries from cancelled when settlement loses the inverse refund CAS race", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
      {
        id: "redemption_inverse_race",
        storeId: "store_1",
        accountId: "account_advocate",
        pointsSpent: BigInt(0),
        shopifyDiscountCode: "WLR-INVERSE",
        status: WeleticRedemptionStatus.issued,
        metadata: {
          referralId: "referral_inverse_race",
          qualificationOrderId: "qualification_order_race",
          referralSide: "advocate",
        },
      },
    ] as any);
    vi.mocked(prisma.weleticRewardRedemption.updateMany)
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 1 } as any);
    vi.mocked(prisma.weleticRewardRedemption.findFirst)
      .mockResolvedValueOnce({
        id: "redemption_inverse_race",
        storeId: "store_1",
        accountId: "account_advocate",
        pointsSpent: BigInt(0),
        shopifyDiscountCode: "WLR-INVERSE",
        status: WeleticRedemptionStatus.issued,
        metadata: {
          referralId: "referral_inverse_race",
          qualificationOrderId: "qualification_order_race",
          referralSide: "advocate",
          remoteProvisionAttemptedAt: "2026-08-29T00:59:58.000Z",
        },
      } as any)
      .mockResolvedValueOnce({
        id: "redemption_inverse_race",
        storeId: "store_1",
        accountId: "account_advocate",
        pointsSpent: BigInt(0),
        shopifyDiscountCode: "WLR-INVERSE",
        status: WeleticRedemptionStatus.cancelled,
        metadata: {
          referralId: "referral_inverse_race",
          qualificationOrderId: "qualification_order_race",
          referralSide: "advocate",
          refundId: "refund_race",
          remoteProvisionAttemptedAt: "2026-08-29T00:59:58.000Z",
        },
      } as any);
    vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
      id: "referral_inverse_race",
      storeId: "store_1",
      advocateAccountId: "account_advocate",
      refereeAccountId: "account_referee",
      qualifyingOrderId: "qualification_order_race",
      status: "pending",
      metadata: {
        qualificationOrderId: "qualification_order_race",
        invalidatedQualificationOrderIds: ["qualification_order_race"],
      },
    } as any);

    const result = await settleRewardRedemptionsUsedByOrder({
      storeId: "store_1",
      discountCodes: ["WLR-INVERSE"],
      orderId: "coupon_use_order_race",
      shopifyCustomerId: "customer_1",
      usedAt: new Date("2026-08-29T01:00:00.000Z"),
      orderMetadata: { orderName: "#RACE" },
    });

    expect(result).toEqual({
      matched: 1,
      markedUsed: 1,
      lateUseCorrections: 1,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenLastCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: "Serializable" }),
    );
    expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          id: "redemption_inverse_race",
          status: WeleticRedemptionStatus.issued,
        }),
      }),
    );
    expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: "redemption_inverse_race",
          status: WeleticRedemptionStatus.cancelled,
        }),
        data: expect.objectContaining({
          status: WeleticRedemptionStatus.used,
          metadata: expect.objectContaining({
            refundId: "refund_race",
            remoteProvisionAttemptedAt: "2026-08-29T00:59:58.000Z",
            orderName: "#RACE",
          }),
        }),
      }),
    );
    expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "cancelled",
          metadata: expect.objectContaining({
            requalificationBlocked: true,
            requalificationBlockedReason: "referral_coupon_used",
          }),
        }),
      }),
    );
  });

  it("blocks referral requalification when a refunded coupon is reported used late", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
      {
        id: "redemption_referral_late_1",
        storeId: "store_1",
        accountId: "account_1",
        pointsSpent: BigInt(0),
        shopifyDiscountCode: "WLR-LATE01",
        status: WeleticRedemptionStatus.cancelled,
        metadata: {
          referralId: "referral_1",
          qualificationOrderId: "qualification_order_1",
          referralSide: "advocate",
        },
      },
    ] as any);
    vi.mocked(prisma.weleticRewardRedemption.findFirst).mockResolvedValueOnce({
      id: "redemption_referral_late_1",
      storeId: "store_1",
      accountId: "account_1",
      pointsSpent: BigInt(0),
      shopifyDiscountCode: "WLR-LATE01",
      status: WeleticRedemptionStatus.cancelled,
      metadata: {
        referralId: "referral_1",
        qualificationOrderId: "qualification_order_1",
        referralSide: "advocate",
      },
    } as any);
    vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
      id: "referral_1",
      storeId: "store_1",
      advocateAccountId: "account_advocate",
      refereeAccountId: "account_referee",
      qualifyingOrderId: "qualification_order_1",
      status: "pending",
      metadata: { reversedAt: "2026-08-26T00:00:00.000Z" },
    } as any);

    await settleRewardRedemptionsUsedByOrder({
      storeId: "store_1",
      discountCodes: ["WLR-LATE01"],
      orderId: "coupon_use_order_2",
      shopifyCustomerId: "customer_1",
      usedAt: new Date("2026-08-28T00:00:00.000Z"),
    });

    expect(prisma.weleticLoyaltyReferral.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "referral_1",
        storeId: "store_1",
      }),
    });
    expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "referral_1",
        storeId: "store_1",
        status: "pending",
      }),
      data: expect.objectContaining({
        status: "cancelled",
        metadata: expect.objectContaining({
          requalificationBlocked: true,
          requalificationBlockedReason: "referral_coupon_used",
          lateCouponUseOrderId: "coupon_use_order_2",
          lateCouponUseRedemptionId: "redemption_referral_late_1",
          lateCouponUseSide: "advocate",
        }),
      }),
    });
    expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenCalledWith({
      where: {
        id: "account_advocate",
        storeId: "store_1",
      },
      data: { referralCount: { increment: 1 } },
    });
  });

  it("keeps the cap slot and cleanup while frozen settlement suppresses operational sync", async () => {
    // The newer generation already consumed the advocate's final cap slot.
    // Late use of the older coupon is irreversible, so correcting the newer
    // rewards must not make that slot available for another referral.
    let referralCount = 1;
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValueOnce({
      id: "store_1",
      complianceState: "frozen",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date(0),
      installationGeneration: null,
    } as any);
    vi.mocked(prisma.weleticLoyaltyAccount.update).mockImplementationOnce(
      (async ({ data }: any) => {
        referralCount -= Number(data.referralCount?.decrement ?? 0);
        return { referralCount };
      }) as any,
    );
    vi.mocked(prisma.weleticRewardRedemption.findMany)
      .mockResolvedValueOnce([
        {
          id: "redemption_old_late",
          storeId: "store_1",
          accountId: "account_advocate",
          pointsSpent: BigInt(0),
          shopifyDiscountCode: "WLR-OLD",
          status: WeleticRedemptionStatus.cancelled,
          metadata: {
            referralId: "referral_1",
            qualificationOrderId: "qualification_order_old",
            referralSide: "advocate",
          },
        },
      ] as any)
      .mockResolvedValueOnce([
        {
          id: "redemption_new_generation",
          storeId: "store_1",
          accountId: "account_referee",
          rewardDefinitionId: "reward_1",
          pointsSpent: BigInt(0),
          shopifyDiscountCode: "WLR-NEW",
          status: WeleticRedemptionStatus.issued,
          metadata: {
            referralId: "referral_1",
            qualificationOrderId: "qualification_order_new",
            referralSide: "referee",
          },
        },
      ] as any);
    vi.mocked(prisma.weleticRewardRedemption.findFirst).mockResolvedValueOnce({
      id: "redemption_old_late",
      storeId: "store_1",
      accountId: "account_advocate",
      pointsSpent: BigInt(0),
      shopifyDiscountCode: "WLR-OLD",
      status: WeleticRedemptionStatus.cancelled,
      metadata: {
        referralId: "referral_1",
        qualificationOrderId: "qualification_order_old",
        referralSide: "advocate",
      },
    } as any);
    vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValueOnce({
      id: "referral_1",
      storeId: "store_1",
      advocateAccountId: "account_advocate",
      refereeAccountId: "account_referee",
      qualifyingOrderId: "qualification_order_new",
      status: "qualified",
      advocatePointsAwarded: BigInt(100),
      refereePointsAwarded: BigInt(50),
      metadata: {
        qualificationOrderId: "qualification_order_new",
        requiredCouponSides: ["referee"],
      },
    } as any);

    await settleRewardRedemptionsUsedByOrder({
      storeId: "store_1",
      discountCodes: ["WLR-OLD"],
      orderId: "coupon_use_order",
      shopifyCustomerId: "customer_1",
      usedAt: new Date("2026-08-29T00:00:00.000Z"),
    });

    expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "referral_1",
          qualifyingOrderId: "qualification_order_new",
          status: "qualified",
        }),
        data: expect.objectContaining({
          status: "cancelled",
          advocatePointsAwarded: BigInt(0),
          refereePointsAwarded: BigInt(0),
        }),
      }),
    );
    expect(appendPointsLedgerEntry).toHaveBeenCalledTimes(2);
    expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account_advocate",
        pointsDelta: BigInt(-100),
      }),
    );
    expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account_referee",
        pointsDelta: BigInt(-50),
      }),
    );
    expect(prisma.weleticLoyaltyAccount.update).toHaveBeenCalledWith({
      where: { id: "account_advocate" },
      data: {
        referralPointsEarned: { decrement: BigInt(100) },
      },
    });
    expect(referralCount).toBe(1);
    expect(referralCount < 1).toBe(false);
    expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "redemption_new_generation",
          status: WeleticRedemptionStatus.issued,
        }),
        data: expect.objectContaining({
          status: WeleticRedemptionStatus.cancelled,
        }),
      }),
    );
    expect(enqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "REDEMPTION_RECOVERY",
        idempotencyKey: "discount_deactivate:redemption_new_generation",
      }),
    );
    expect(enqueueOutboxJob).not.toHaveBeenCalledWith(
      expect.objectContaining({ jobType: "METAFIELD_SYNC" }),
    );
  });

  it("retries a redaction CAS race and keeps closed-counterpart corrections privacy-safe", async () => {
    const beforeRedaction = new Date("2026-08-29T00:00:00.000Z");
    const afterRedaction = new Date("2026-08-29T00:00:01.000Z");
    const redactionMetadata = {
      shopifyCustomerRedaction: {
        status: "redacted",
        redactedAt: afterRedaction.toISOString(),
        source: "shopify_customers_redact",
      },
    };

    vi.mocked(prisma.weleticRewardRedemption.findMany)
      .mockResolvedValueOnce([
        {
          id: "redemption_old_late",
          storeId: "store_1",
          accountId: "account_advocate",
          pointsSpent: BigInt(0),
          shopifyDiscountCode: "WLR-OLD",
          status: WeleticRedemptionStatus.cancelled,
          metadata: {
            referralId: "referral_1",
            qualificationOrderId: "qualification_order_old",
            referralSide: "advocate",
          },
        },
      ] as any)
      .mockResolvedValueOnce([
        {
          id: "redemption_new_generation",
          storeId: "store_1",
          accountId: "account_referee",
          rewardDefinitionId: "reward_1",
          pointsSpent: BigInt(0),
          shopifyDiscountCode: "WLR-NEW",
          status: WeleticRedemptionStatus.issued,
          metadata: {
            referralId: "referral_1",
            qualificationOrderId: "qualification_order_new",
            referralSide: "referee",
            orderName: "#PRIVATE-REDEMPTION",
            customerEmail: "redacted@example.com",
          },
        },
      ] as any);
    vi.mocked(prisma.weleticRewardRedemption.findFirst)
      .mockResolvedValueOnce({
        id: "redemption_old_late",
        storeId: "store_1",
        accountId: "account_advocate",
        pointsSpent: BigInt(0),
        shopifyDiscountCode: "WLR-OLD",
        status: WeleticRedemptionStatus.cancelled,
        metadata: {
          referralId: "referral_1",
          qualificationOrderId: "qualification_order_old",
          referralSide: "advocate",
        },
      } as any)
      .mockResolvedValueOnce({
        id: "redemption_old_late",
        storeId: "store_1",
        accountId: "account_advocate",
        pointsSpent: BigInt(0),
        shopifyDiscountCode: "WLR-OLD",
        status: WeleticRedemptionStatus.cancelled,
        metadata: {
          referralId: "referral_1",
          qualificationOrderId: "qualification_order_old",
          referralSide: "advocate",
        },
      } as any);
    vi.mocked(prisma.weleticLoyaltyReferral.findFirst)
      .mockResolvedValueOnce({
        id: "referral_1",
        storeId: "store_1",
        advocateAccountId: "account_advocate",
        refereeAccountId: "account_referee",
        qualifyingOrderId: "qualification_order_new",
        status: "qualified",
        advocatePointsAwarded: BigInt(100),
        refereePointsAwarded: BigInt(50),
        metadata: {
          qualificationOrderId: "qualification_order_new",
          requiredCouponSides: ["referee"],
          orderName: "#PRIVATE-REFERRAL",
          customerEmail: "redacted@example.com",
        },
      } as any)
      .mockResolvedValueOnce({
        id: "referral_1",
        storeId: "store_1",
        advocateAccountId: "account_advocate",
        refereeAccountId: "account_referee",
        qualifyingOrderId: "qualification_order_new",
        status: "qualified",
        advocatePointsAwarded: BigInt(100),
        refereePointsAwarded: BigInt(50),
        metadata: {
          qualificationOrderId: "qualification_order_new",
          requiredCouponSides: ["referee"],
          orderName: "#PRIVATE-REFERRAL",
          customerEmail: "redacted@example.com",
        },
      } as any);
    vi.mocked(prisma.weleticLoyaltyAccount.findMany)
      .mockResolvedValueOnce([
        {
          id: "account_advocate",
          status: "active",
          metadata: null,
          updatedAt: beforeRedaction,
        },
        {
          id: "account_referee",
          status: "active",
          metadata: null,
          updatedAt: beforeRedaction,
        },
      ] as any)
      .mockResolvedValueOnce([
        {
          id: "account_advocate",
          status: "active",
          metadata: null,
          updatedAt: beforeRedaction,
        },
        {
          id: "account_referee",
          status: "closed",
          metadata: redactionMetadata,
          updatedAt: afterRedaction,
        },
      ] as any);
    vi.mocked(prisma.weleticLoyaltyAccount.updateMany)
      .mockResolvedValueOnce({ count: 1 } as any)
      .mockResolvedValueOnce({ count: 0 } as any)
      .mockResolvedValueOnce({ count: 1 } as any)
      .mockResolvedValueOnce({ count: 1 } as any);

    const result = await settleRewardRedemptionsUsedByOrder({
      storeId: "store_1",
      discountCodes: ["WLR-OLD"],
      orderId: "coupon_use_order",
      shopifyCustomerId: "customer_1",
      usedAt: new Date("2026-08-29T00:00:02.000Z"),
    });

    expect(result).toEqual({
      matched: 1,
      markedUsed: 1,
      lateUseCorrections: 1,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          id: "account_referee",
          storeId: "store_1",
          status: "active",
          updatedAt: beforeRedaction,
        },
      }),
    );
    expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        where: {
          id: "account_referee",
          storeId: "store_1",
          status: "closed",
          updatedAt: afterRedaction,
        },
      }),
    );

    const referralUpdate = vi.mocked(prisma.weleticLoyaltyReferral.updateMany)
      .mock.calls[0][0] as any;
    expect(referralUpdate.data.metadata).toMatchObject({
      requalificationBlocked: true,
      requalificationBlockedReason: "referral_coupon_used",
      lateCouponUsePrivacyRedacted: true,
    });
    expect(referralUpdate.data.metadata).not.toHaveProperty(
      "lateCouponUseOrderId",
    );
    expect(referralUpdate.data.metadata).not.toHaveProperty(
      "lateCouponUseRedemptionId",
    );
    expect(referralUpdate.data.metadata).not.toHaveProperty(
      "lateCouponUseOriginalQualificationOrderId",
    );
    expect(referralUpdate.data.metadata).not.toHaveProperty("orderName");
    expect(referralUpdate.data.metadata).not.toHaveProperty("customerEmail");

    expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account_advocate",
        pointsDelta: BigInt(-100),
        reason: "Referral reward financial correction after customer redaction",
        metadata: null,
      }),
    );
    expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account_referee",
        pointsDelta: BigInt(-50),
        reason: "Referral reward financial correction after customer redaction",
        metadata: null,
      }),
    );
    const currentRedemptionUpdate = vi
      .mocked(prisma.weleticRewardRedemption.updateMany)
      .mock.calls.find(
        ([input]: any[]) => input.where.id === "redemption_new_generation",
      )?.[0] as any;
    expect(currentRedemptionUpdate.data.metadata).toMatchObject({
      lateCouponUsePrivacyRedacted: true,
    });
    expect(currentRedemptionUpdate.data.metadata).not.toHaveProperty(
      "lateCouponRedemptionId",
    );
    expect(currentRedemptionUpdate.data.metadata).not.toHaveProperty(
      "orderName",
    );
    expect(currentRedemptionUpdate.data.metadata).not.toHaveProperty(
      "customerEmail",
    );

    expect(enqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "REDEMPTION_RECOVERY",
        payload: expect.objectContaining({
          redemptionId: "redemption_new_generation",
          accountId: "account_referee",
          sagaPhase: "compensating",
        }),
      }),
    );
    expect(enqueueOutboxJob).not.toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "METAFIELD_SYNC",
        payload: expect.objectContaining({ accountId: "account_referee" }),
      }),
    );
  });
});
