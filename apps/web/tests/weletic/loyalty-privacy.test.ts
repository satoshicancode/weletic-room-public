import { linkCache } from "@/lib/api/links/cache";
import { prisma } from "@/lib/prisma";
import {
  anonymizeWeleticShopper,
  getShopperDataExport,
} from "@/lib/weletic/loyalty/shopper";
import {
  SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY,
  SHOPPER_DATA_EXPORT_RECORD_LIMIT,
  scrubBirthdayRewardOutboxJobs,
  scrubCustomerContextJsonValue,
} from "@/lib/weletic/loyalty/shopper-privacy";
import {
  Prisma,
  WeleticLoyaltyOutboxJobStatus,
  WeleticLoyaltyOutboxJobType,
  WeleticPointsLedgerEntryType,
  WeleticRedemptionStatus,
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticProductReview: { findMany: vi.fn().mockResolvedValue([]) },
    weleticReviewModerationAudit: { findMany: vi.fn().mockResolvedValue([]) },
    weleticReviewRequest: { findMany: vi.fn().mockResolvedValue([]) },
    weleticReviewIncentiveClaim: { findMany: vi.fn().mockResolvedValue([]) },
    weleticReviewIncentiveInvalidation: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    weleticRewardCouponUse: { findMany: vi.fn().mockResolvedValue([]) },
    weleticShopper: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticShopifyVoucherCleanup: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticRewardRedemption: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyTierHistory: { findMany: vi.fn() },
    weleticLoyaltyReferral: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticCommerceOrder: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticCommissionCalculation: { updateMany: vi.fn() },
    weleticShopifyStore: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    customer: { findUnique: vi.fn() },
    link: { findFirst: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn((fn) => (typeof fn === "function" ? fn(prisma) : fn)),
  },
}));

vi.mock("@/lib/api/links/cache", () => ({
  linkCache: { invalidateMany: vi.fn() },
}));

// These pre-native fixtures contain no reviews. Native row/media redaction is
// exercised separately against real MySQL in native-reviews-db.integration.
vi.mock("@/lib/weletic/reviews/privacy", () => ({
  redactNativeReviewsBatch: vi.fn().mockResolvedValue({ hasMore: false }),
}));

// The new shared HMAC/store-lock fence is exercised with real MySQL in the
// shopper database suite; these legacy fixtures test downstream account scrubs.
vi.mock("@/lib/weletic/reviews/incentive-privacy-fence", () => ({
  fenceShopperIncentiveRedaction: vi.fn().mockResolvedValue(undefined),
}));

describe("Shopify GDPR & Privacy Compliance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticLoyaltyTierHistory.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValue([]);
    vi.mocked(prisma.weleticLoyaltyOutboxJob.findUnique).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.weleticLoyaltyOutboxJob.create).mockImplementation(
      (async ({ data }: any) => ({
        ...data,
        id: "outbox_voucher_cleanup",
        attempts: 0,
        maxAttempts: data.maxAttempts ?? 10,
      })) as any,
    );
    vi.mocked(prisma.weleticShopifyVoucherCleanup.findUnique).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.weleticShopifyVoucherCleanup.create).mockImplementation(
      (async ({ data }: any) => ({ ...data, attempts: 0 })) as any,
    );
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      projectId: "workspace_gdpr_1",
    } as any);
    vi.mocked(prisma.customer.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.weleticShopifyStore.findUniqueOrThrow).mockResolvedValue({
      projectId: "workspace_gdpr_1",
      shopDomain: "gdpr.myshopify.com",
    } as any);
    vi.mocked(prisma.link.findFirst).mockResolvedValue(null);
    vi.mocked(linkCache.invalidateMany).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Customers Data Request Export", () => {
    it("exports complete shopper profile, loyalty balances, ledger history, redemptions, and orders", async () => {
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
        id: "shop_gdpr_1",
        storeId: "store_gdpr_1",
        shopifyCustomerId: "cust_shopify_99",
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
        phone: "+15551234567",
        locale: "en",
        tags: ["vip"],
        segmentIds: ["gid://shopify/Segment/1"],
        acceptsMarketing: true,
        ordersCount: 4,
        totalSpent: BigInt(45000),
        createdAt: new Date("2025-06-01"),
        loyaltyAccount: {
          id: "acc_gdpr_1",
          status: "active",
          ledgerVersion: 1,
          cachedPointsBalance: BigInt(450),
          cachedPendingPoints: BigInt(0),
          lifetimePointsEarned: BigInt(650),
          lifetimePointsRedeemed: BigInt(200),
          lastQualifyingActivityAt: new Date("2025-07-01"),
          nextExpiryDate: null,
          referralCode: "ALICE99",
          referredById: null,
          referralCount: 1,
          referralPointsEarned: BigInt(100),
          tierExpiresAt: null,
          tierSpendRolling12Months: BigInt(45000),
          tierPointsRolling12Months: BigInt(650),
          metadata: {
            birthday: {
              birthDate: "2000-06-15",
              registeredAt: "2025-06-01T00:00:00.000Z",
              nextEligibleYear: 2026,
            },
            campaignEnrollment: "summer-2025",
          },
          enrolledAt: new Date("2025-06-01"),
          createdAt: new Date("2025-06-01"),
          updatedAt: new Date("2025-07-20"),
          currentTier: {
            id: "tier_gold",
            name: "Gold VIP",
          },
          ledgerEntries: [
            {
              id: "ledger_1",
              entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
              pointsDelta: BigInt(450),
              balanceAfter: BigInt(450),
              reason: "Order points",
              createdAt: new Date("2025-06-02"),
            },
          ],
          redemptions: [
            {
              id: "redemp_1",
              pointsSpent: BigInt(200),
              shopifyDiscountCode: "WL-ALICE10",
              status: WeleticRedemptionStatus.active,
              createdAt: new Date("2025-07-01"),
              rewardDefinition: {
                name: "$10 off",
                rewardType: "amount_off",
              },
            },
          ],
          tierHistory: [
            {
              id: "th_1",
              toTierId: "tier_gold",
              changeReason: "threshold_reached",
              effectiveAt: new Date("2025-06-02"),
            },
          ],
          advocateReferrals: [
            {
              id: "ref_advocate_1",
              status: "rewarded",
              advocatePointsAwarded: BigInt(100),
              rewardedAt: new Date("2025-07-10"),
              createdAt: new Date("2025-07-01"),
            },
          ],
          refereeReferrals: [
            {
              id: "ref_referee_1",
              status: "rewarded",
              refereePointsAwarded: BigInt(50),
              rewardedAt: new Date("2025-07-20"),
              createdAt: new Date("2025-07-15"),
            },
          ],
        },
        orders: [
          {
            id: "order_1",
            externalId: "shopify_ord_101",
            orderName: "#1001",
            status: "paid",
            presentmentTotal: BigInt(15000),
            presentmentCurrency: "USD",
            occurredAt: new Date("2025-06-02"),
          },
        ],
      } as any);

      vi.mocked(prisma.weleticPointsLedgerEntry.findMany).mockResolvedValueOnce(
        [
          {
            id: "ledger_1",
            sequenceNumber: 1,
            entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
            pointsDelta: BigInt(450),
            pendingDelta: BigInt(0),
            balanceAfter: BigInt(450),
            grantId: null,
            referenceType: "COMMERCE_ORDER",
            referenceId: "order_1",
            reason: "Order points",
            metadata: { orderName: "#1001" },
            createdAt: new Date("2025-06-02"),
          },
        ] as any,
      );
      vi.mocked(prisma.weleticRewardRedemption.findMany).mockResolvedValueOnce([
        {
          id: "redemp_1",
          pointsSpent: BigInt(200),
          shopifyDiscountCode: "WL-ALICE10",
          shopifyDiscountId: "gid://shopify/Discount/1",
          shopifyPriceRuleId: null,
          status: WeleticRedemptionStatus.active,
          compensationReason: null,
          orderId: null,
          expiresAt: null,
          usedAt: null,
          ledgerEntryId: null,
          metadata: null,
          createdAt: new Date("2025-07-01"),
          updatedAt: new Date("2025-07-01"),
          rewardDefinition: {
            name: "$10 off",
            rewardType: "amount_off",
          },
        },
      ] as any);
      vi.mocked(
        prisma.weleticLoyaltyTierHistory.findMany,
      ).mockResolvedValueOnce([
        {
          id: "th_1",
          fromTierId: null,
          toTierId: "tier_gold",
          changeReason: "threshold_reached",
          notes: null,
          qualifyingSpendSnapshot: BigInt(45000),
          qualifyingPointsSnapshot: BigInt(650),
          effectiveAt: new Date("2025-06-02"),
        },
      ] as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findMany)
        .mockResolvedValueOnce([
          {
            id: "ref_advocate_1",
            refereeAccountId: "acc_friend",
            status: "rewarded",
            qualifyingOrderId: "order_friend",
            advocatePointsAwarded: BigInt(100),
            refereePointsAwarded: BigInt(50),
            ipHash: null,
            userAgentHash: null,
            fraudReason: null,
            fraudSignals: null,
            metadata: null,
            rewardedAt: new Date("2025-07-10"),
            createdAt: new Date("2025-07-01"),
            updatedAt: new Date("2025-07-10"),
          },
        ] as any)
        .mockResolvedValueOnce([
          {
            id: "ref_referee_1",
            advocateAccountId: "acc_advocate",
            status: "rewarded",
            qualifyingOrderId: "order_1",
            advocatePointsAwarded: BigInt(100),
            refereePointsAwarded: BigInt(50),
            ipHash: null,
            userAgentHash: null,
            fraudReason: null,
            fraudSignals: null,
            metadata: null,
            rewardedAt: new Date("2025-07-20"),
            createdAt: new Date("2025-07-15"),
            updatedAt: new Date("2025-07-20"),
          },
        ] as any);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        {
          id: "order_1",
          externalId: "shopify_ord_101",
          orderName: "#1001",
          checkoutToken: "checkout_1",
          customerOrderSequence: 1,
          customerClassification: "new",
          customerSegmentIds: ["gid://shopify/Segment/1"],
          status: "paid",
          presentmentCurrency: "USD",
          presentmentSubtotal: BigInt(15000),
          presentmentDiscount: BigInt(0),
          presentmentNet: BigInt(15000),
          presentmentTax: BigInt(0),
          presentmentShipping: BigInt(0),
          presentmentTotal: BigInt(15000),
          shopCurrency: "USD",
          shopTotal: BigInt(15000),
          accountingCurrency: "USD",
          accountingNet: BigInt(15000),
          accountingTotal: BigInt(15000),
          occurredAt: new Date("2025-06-02"),
          processedAt: new Date("2025-06-02"),
          createdAt: new Date("2025-06-02"),
          updatedAt: new Date("2025-06-02"),
          lines: [],
          refunds: [],
        },
      ] as any);

      const exported = await getShopperDataExport({
        storeId: "store_gdpr_1",
        shopifyCustomerId: "cust_shopify_99",
      });

      expect(exported).not.toBeNull();
      expect(exported?.firstName).toBe("Alice");
      expect(exported?.email).toBe("alice@example.com");
      expect(exported?.tags).toEqual(["vip"]);
      expect(exported?.segmentIds).toEqual(["gid://shopify/Segment/1"]);
      expect(exported?.acceptsMarketing).toBe(true);
      expect(exported?.loyaltyAccount?.pointsBalance).toBe("450");
      expect(exported?.loyaltyAccount?.currentTier?.name).toBe("Gold VIP");
      expect(exported?.loyaltyAccount?.birthday).toEqual({
        birthDate: "2000-06-15",
        registeredAt: "2025-06-01T00:00:00.000Z",
        nextEligibleYear: 2026,
      });
      expect(exported?.loyaltyAccount?.ledgerEntries).toHaveLength(1);
      expect(exported?.loyaltyAccount?.redemptions).toHaveLength(1);
      expect(exported?.loyaltyAccount?.redemptions[0]).toMatchObject({
        rewardName: "$10 off",
        rewardType: "amount_off",
      });
      expect(exported?.loyaltyAccount?.tierHistory).toHaveLength(1);
      expect(exported?.loyaltyAccount?.referrals.asAdvocate).toEqual([
        expect.objectContaining({
          id: "ref_advocate_1",
          advocatePointsAwarded: "100",
        }),
      ]);
      expect(exported?.loyaltyAccount?.referrals.asReferee).toEqual([
        expect.objectContaining({
          id: "ref_referee_1",
          refereePointsAwarded: "50",
        }),
      ]);
      expect(
        exported?.loyaltyAccount?.referrals.asAdvocate[0],
      ).not.toHaveProperty("refereeAccountId");
      expect(
        exported?.loyaltyAccount?.referrals.asAdvocate[0],
      ).not.toHaveProperty("qualifyingOrderId");
      expect(
        exported?.loyaltyAccount?.referrals.asAdvocate[0],
      ).not.toHaveProperty("refereePointsAwarded");
      expect(
        exported?.loyaltyAccount?.referrals.asReferee[0],
      ).not.toHaveProperty("advocateAccountId");
      expect(
        exported?.loyaltyAccount?.referrals.asReferee[0],
      ).not.toHaveProperty("advocatePointsAwarded");
      for (const referral of [
        ...(exported?.loyaltyAccount?.referrals.asAdvocate ?? []),
        ...(exported?.loyaltyAccount?.referrals.asReferee ?? []),
      ]) {
        expect(referral).not.toHaveProperty("ipHash");
        expect(referral).not.toHaveProperty("userAgentHash");
        expect(referral).not.toHaveProperty("fraudReason");
        expect(referral).not.toHaveProperty("fraudSignals");
        expect(referral).not.toHaveProperty("metadata");
      }
      expect(exported?.orders).toHaveLength(1);
      expect(exported?.exportCompleteness.pageSize).toBe(
        SHOPPER_DATA_EXPORT_RECORD_LIMIT,
      );
      expect(prisma.weleticShopper.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            storeId_shopifyCustomerId: {
              storeId: "store_gdpr_1",
              shopifyCustomerId: "cust_shopify_99",
            },
          },
          select: expect.objectContaining({
            loyaltyAccount: expect.anything(),
          }),
        }),
      );
    });

    it("returns null when customer is not found", async () => {
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce(null);

      const exported = await getShopperDataExport({
        storeId: "store_gdpr_1",
        shopifyCustomerId: "non_existent",
      });

      expect(exported).toBeNull();
    });

    it("internally paginates beyond 100 retained ledger records", async () => {
      const account = {
        id: "acc_many",
        status: "active",
        ledgerVersion: 101,
        cachedPointsBalance: BigInt(101),
        cachedPendingPoints: BigInt(0),
        lifetimePointsEarned: BigInt(101),
        lifetimePointsRedeemed: BigInt(0),
        lastQualifyingActivityAt: null,
        nextExpiryDate: null,
        referralCode: null,
        referredById: null,
        referralCount: 0,
        referralPointsEarned: BigInt(0),
        tierExpiresAt: null,
        tierSpendRolling12Months: BigInt(0),
        tierPointsRolling12Months: BigInt(0),
        metadata: null,
        enrolledAt: new Date("2025-01-01"),
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        currentTier: null,
      };
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
        id: "shop_many",
        shopifyCustomerId: "customer_many",
        firstName: "Many",
        lastName: "Entries",
        email: "many@example.com",
        phone: null,
        locale: "en",
        tags: null,
        segmentIds: null,
        acceptsMarketing: false,
        ordersCount: 0,
        totalSpent: BigInt(0),
        createdAt: new Date("2025-01-01"),
        updatedAt: new Date("2025-01-01"),
        loyaltyAccount: account,
      } as any);
      const entries = Array.from({ length: 101 }, (_, index) => ({
        id: `ledger_${String(index).padStart(3, "0")}`,
        sequenceNumber: 101 - index,
        entryType: WeleticPointsLedgerEntryType.EARN_ORDER,
        pointsDelta: BigInt(1),
        pendingDelta: BigInt(0),
        balanceAfter: BigInt(101 - index),
        grantId: null,
        referenceType: "COMMERCE_ORDER",
        referenceId: `order_${index}`,
        reason: "Order points",
        metadata: null,
        createdAt: new Date("2025-01-01"),
      }));
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany)
        .mockResolvedValueOnce(entries.slice(0, 100) as any)
        .mockResolvedValueOnce(entries.slice(100) as any);

      const exported = await getShopperDataExport({
        storeId: "store_gdpr_1",
        shopifyCustomerId: "customer_many",
      });

      expect(exported?.loyaltyAccount?.ledgerEntries).toHaveLength(101);
      expect(exported?.exportCompleteness.recordCounts.ledgerEntries).toBe(101);
      expect(prisma.weleticPointsLedgerEntry.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          cursor: { id: entries[99].id },
          skip: 1,
          take: SHOPPER_DATA_EXPORT_RECORD_LIMIT,
        }),
      );
    });

    it("exports an explicitly requested old order even when no shopper row exists", async () => {
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce(null);
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        {
          id: "order_old_internal",
          externalId: "9001",
          orderName: "#OLD-9001",
          checkoutToken: "old_checkout",
          customerOrderSequence: null,
          customerClassification: "unknown",
          customerSegmentIds: null,
          status: "paid",
          presentmentCurrency: "USD",
          presentmentSubtotal: BigInt(2500),
          presentmentDiscount: BigInt(0),
          presentmentNet: BigInt(2500),
          presentmentTax: BigInt(0),
          presentmentShipping: BigInt(0),
          presentmentTotal: BigInt(2500),
          shopCurrency: "USD",
          shopTotal: BigInt(2500),
          accountingCurrency: "USD",
          accountingNet: BigInt(2500),
          accountingTotal: BigInt(2500),
          occurredAt: new Date("2020-01-01"),
          processedAt: new Date("2020-01-01"),
          createdAt: new Date("2020-01-01"),
          updatedAt: new Date("2020-01-01"),
          lines: [],
          refunds: [],
        },
      ] as any);

      const exported = await getShopperDataExport({
        storeId: "store_gdpr_1",
        shopifyCustomerId: "customer_without_shopper",
        orderExternalIds: ["9001"],
      });

      expect(exported?.shopperId).toBeNull();
      expect(exported?.orders).toEqual([
        expect.objectContaining({ externalId: "9001", orderName: "#OLD-9001" }),
      ]);
      expect(prisma.weleticCommerceOrder.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { storeId: "store_gdpr_1", externalId: { in: ["9001"] } },
        }),
      );
    });

    it("exports the complete tenant-bound legacy customer record when no loyalty shopper exists", async () => {
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce(null);
      vi.mocked(prisma.customer.findUnique).mockResolvedValueOnce({
        id: "legacy_customer_42",
        name: "Legacy Customer",
        email: "legacy@example.com",
        avatar: "https://cdn.example.com/avatar.png",
        externalId: "42",
        stripeCustomerId: "cus_legacy_42",
        linkId: "link_42",
        clickId: "click_42",
        clickedAt: new Date("2025-01-02T00:00:00.000Z"),
        country: "JP",
        sales: 3,
        saleAmount: BigInt(12_345),
        firstSaleAt: new Date("2025-01-03T00:00:00.000Z"),
        subscriptionCanceledAt: null,
        projectConnectId: "connected_customer_42",
        programId: "program_42",
        partnerId: "partner_42",
        createdAt: new Date("2025-01-01T00:00:00.000Z"),
        updatedAt: new Date("2025-01-04T00:00:00.000Z"),
      } as any);

      const exported = await getShopperDataExport({
        storeId: "store_gdpr_1",
        shopifyCustomerId: "42",
      });

      expect(exported?.legacyCustomer).toEqual(
        expect.objectContaining({
          id: "legacy_customer_42",
          externalId: "42",
          stripeCustomerId: "cus_legacy_42",
          clickId: "click_42",
          country: "JP",
          sales: 3,
          saleAmount: "12345",
        }),
      );
      expect(prisma.customer.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            projectId_externalId: {
              projectId: "workspace_gdpr_1",
              externalId: "42",
            },
          },
        }),
      );
    });
  });

  describe("Customers Redact & PII Anonymization", () => {
    it("disables and fully invalidates the old referral URL before scrubbing its lookup identity", async () => {
      const redactionOrder: string[] = [];
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
        id: "shop_link_redact",
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "account_link_redact",
        metadata: null,
        updatedAt: new Date("2026-08-29T03:00:00.000Z"),
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValueOnce({
        count: 1,
      });
      vi.mocked(prisma.weleticShopper.updateMany).mockResolvedValueOnce({
        count: 1,
      });
      vi.mocked(prisma.link.findFirst).mockResolvedValueOnce({
        id: "link_link_redact",
        domain: "go.example.com",
        key: "ALICE-PRIVATE",
        externalId: "loyalty_referral:account_link_redact",
      } as any);
      vi.mocked(prisma.link.updateMany).mockImplementation((async ({
        data,
      }) => {
        redactionOrder.push(data.externalId === null ? "scrub" : "disable");
        return { count: 1 };
      }) as any);
      vi.mocked(linkCache.invalidateMany).mockImplementationOnce(async () => {
        redactionOrder.push("invalidate");
      });

      await anonymizeWeleticShopper({
        storeId: "store_gdpr_1",
        shopifyCustomerId: "cust_link_redact",
      });

      expect(redactionOrder).toEqual(["disable", "invalidate", "scrub"]);
      expect(prisma.link.updateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            externalId: "loyalty_referral:account_link_redact",
            key: "ALICE-PRIVATE",
          }),
          data: expect.not.objectContaining({
            externalId: null,
            key: "redacted-link_link_redact",
          }),
        }),
      );
      expect(linkCache.invalidateMany).toHaveBeenCalledWith([
        expect.objectContaining({
          domain: "go.example.com",
          key: "ALICE-PRIVATE",
        }),
      ]);
      expect(prisma.link.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            externalId: null,
            key: "redacted-link_link_redact",
            archived: true,
            disabledAt: expect.any(Date),
          }),
        }),
      );
    });

    it("retains the old referral-link lookup identity when cache invalidation fails", async () => {
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
        id: "shop_link_retry",
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "account_link_retry",
        metadata: null,
        updatedAt: new Date("2026-08-29T03:00:00.000Z"),
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValueOnce({
        count: 1,
      });
      vi.mocked(prisma.weleticShopper.updateMany).mockResolvedValueOnce({
        count: 1,
      });
      vi.mocked(prisma.link.findFirst).mockResolvedValueOnce({
        id: "link_link_retry",
        domain: "go.example.com",
        key: "RETRY-PRIVATE",
        externalId: "loyalty_referral:account_link_retry",
      } as any);
      vi.mocked(prisma.link.updateMany).mockResolvedValue({ count: 1 });
      vi.mocked(linkCache.invalidateMany).mockRejectedValueOnce(
        new Error("cache unavailable"),
      );

      await expect(
        anonymizeWeleticShopper({
          storeId: "store_gdpr_1",
          shopifyCustomerId: "cust_link_retry",
        }),
      ).rejects.toThrow("cache unavailable");

      expect(prisma.link.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.link.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            externalId: "loyalty_referral:account_link_retry",
            key: "RETRY-PRIVATE",
          }),
          data: expect.not.objectContaining({ externalId: null }),
        }),
      );
    });

    it("reloads and scrubs a completed job after losing the processing-state CAS", async () => {
      const processingUpdatedAt = new Date("2026-08-29T04:00:00.000Z");
      const completedUpdatedAt = new Date("2026-08-29T04:01:00.000Z");
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany).mockResolvedValueOnce([
        { id: "birthday_job_racing_worker" },
      ] as any);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findFirst)
        .mockResolvedValueOnce({
          id: "birthday_job_racing_worker",
          status: WeleticLoyaltyOutboxJobStatus.processing,
          payload: {
            accountId: "acc_to_redact",
            birthDate: "2000-08-29",
            registeredAt: "2026-01-01T00:00:00.000Z",
            calendarYear: 2027,
          },
          updatedAt: processingUpdatedAt,
        } as any)
        .mockResolvedValueOnce({
          id: "birthday_job_racing_worker",
          status: WeleticLoyaltyOutboxJobStatus.completed,
          payload: {
            accountId: "acc_to_redact",
            birthDate: "2000-08-29",
            registeredAt: "2026-01-01T00:00:00.000Z",
            calendarYear: 2027,
          },
          updatedAt: completedUpdatedAt,
        } as any);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });

      await scrubBirthdayRewardOutboxJobs({
        storeId: "store_gdpr_1",
        accountId: "acc_to_redact",
        redactedAt: new Date("2026-08-29T05:00:00.000Z"),
      });

      expect(
        prisma.weleticLoyaltyOutboxJob.updateMany,
      ).toHaveBeenLastCalledWith({
        where: {
          id: "birthday_job_racing_worker",
          storeId: "store_gdpr_1",
          jobType: WeleticLoyaltyOutboxJobType.BIRTHDAY_REWARD,
          status: WeleticLoyaltyOutboxJobStatus.completed,
          updatedAt: completedUpdatedAt,
          payload: { path: "$.accountId", equals: "acc_to_redact" },
        },
        data: {
          payload: {
            accountId: "acc_to_redact",
            calendarYear: 2027,
            birthdayRedactedAt: "2026-08-29T05:00:00.000Z",
            redactionReason: "shopify_customer_redact",
          },
          createdAt: new Date("2026-08-29T05:00:00.000Z"),
          scheduledFor: new Date("2026-08-29T05:00:00.000Z"),
          processedAt: new Date("2026-08-29T05:00:00.000Z"),
          completedAt: new Date("2026-08-29T05:00:00.000Z"),
          nextRetryAt: null,
          lockedAt: null,
          lockedBy: null,
          errorLog: expect.anything(),
          lastError: null,
        },
      });
    });

    it.each([
      WeleticLoyaltyOutboxJobType.METAFIELD_SYNC,
      WeleticLoyaltyOutboxJobType.INACTIVITY_EXPIRY,
    ])(
      "re-reads a %s job after a CAS miss and scrubs the terminal row in place",
      async (jobType) => {
        const processingUpdatedAt = new Date("2026-08-29T04:00:00.000Z");
        const completedUpdatedAt = new Date("2026-08-29T04:01:00.000Z");
        const scheduledFor = new Date("2026-08-29T03:00:00.000Z");
        vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
          id: "shop_outbox_cas_retry",
        } as any);
        vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce(
          {
            id: "account_outbox_cas_retry",
            metadata: null,
            updatedAt: new Date("2026-08-29T03:30:00.000Z"),
          } as any,
        );
        vi.mocked(
          prisma.weleticLoyaltyAccount.updateMany,
        ).mockResolvedValueOnce({
          count: 1,
        });
        vi.mocked(prisma.weleticShopper.updateMany).mockResolvedValueOnce({
          count: 1,
        });
        vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany)
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ id: "account_job_racing_worker" }] as any);
        vi.mocked(prisma.weleticLoyaltyOutboxJob.findFirst)
          .mockResolvedValueOnce({
            id: "account_job_racing_worker",
            jobType,
            status: WeleticLoyaltyOutboxJobStatus.processing,
            payload: {
              accountId: "account_outbox_cas_retry",
              shopifyCustomerId: "customer_private",
              customerEmail: "private@example.com",
              expiryDeliverySnapshot: "encrypted-customer-envelope",
              triggerReason: "redeem",
            },
            scheduledFor,
            updatedAt: processingUpdatedAt,
          } as any)
          .mockResolvedValueOnce({
            id: "account_job_racing_worker",
            jobType,
            status: WeleticLoyaltyOutboxJobStatus.completed,
            payload: {
              accountId: "account_outbox_cas_retry",
              shopifyCustomerId: "customer_private",
              customerEmail: "private@example.com",
              expiryDeliverySnapshot: "encrypted-customer-envelope",
              triggerReason: "redeem",
            },
            scheduledFor,
            updatedAt: completedUpdatedAt,
          } as any);
        vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
          .mockResolvedValueOnce({ count: 0 })
          .mockResolvedValueOnce({ count: 1 });

        await anonymizeWeleticShopper({
          storeId: "store_gdpr_1",
          shopifyCustomerId: "customer_private",
        });

        expect(prisma.weleticLoyaltyOutboxJob.findFirst).toHaveBeenCalledTimes(
          2,
        );
        expect(
          prisma.weleticLoyaltyOutboxJob.updateMany,
        ).toHaveBeenLastCalledWith({
          where: {
            id: "account_job_racing_worker",
            storeId: "store_gdpr_1",
            status: WeleticLoyaltyOutboxJobStatus.completed,
            updatedAt: completedUpdatedAt,
            payload: {
              path: "$.accountId",
              equals: "account_outbox_cas_retry",
            },
          },
          data: {
            payload: {
              accountId: "account_outbox_cas_retry",
              triggerReason: "redeem",
            },
            lastError: null,
            errorLog: Prisma.DbNull,
          },
        });
      },
    );

    it("scrubs encrypted delivery evidence recursively without retaining ciphertext", () => {
      expect(
        scrubCustomerContextJsonValue({
          accountId: "account",
          expiryDeliverySnapshot: "ciphertext",
          nested: [
            { expiryDeliverySnapshot: "nested-ciphertext", stage: "warning" },
          ],
        }),
      ).toEqual({ accountId: "account", nested: [{ stage: "warning" }] });
    });

    it("fails redaction after bounded CAS misses leave an account-scoped job unsanitized", async () => {
      const updatedAt = new Date("2026-08-29T04:00:00.000Z");
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
        id: "shop_outbox_cas_failure",
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValueOnce({
        id: "account_outbox_cas_failure",
        metadata: null,
        updatedAt: new Date("2026-08-29T03:30:00.000Z"),
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValueOnce({
        count: 1,
      });
      vi.mocked(prisma.weleticShopper.updateMany).mockResolvedValueOnce({
        count: 1,
      });
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "account_job_never_stable" }] as any);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findFirst).mockResolvedValue({
        id: "account_job_never_stable",
        jobType: WeleticLoyaltyOutboxJobType.METAFIELD_SYNC,
        status: WeleticLoyaltyOutboxJobStatus.pending,
        payload: {
          accountId: "account_outbox_cas_failure",
          customerEmail: "still-private@example.com",
        },
        scheduledFor: new Date("2026-08-29T03:00:00.000Z"),
        updatedAt,
      } as any);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mockResolvedValue({
        count: 0,
      });

      await expect(
        anonymizeWeleticShopper({
          storeId: "store_gdpr_1",
          shopifyCustomerId: "customer_private",
        }),
      ).rejects.toThrow(
        "Loyalty outbox job account_job_never_stable kept changing during customer redaction.",
      );

      expect(prisma.weleticLoyaltyOutboxJob.findFirst).toHaveBeenCalledTimes(5);
      expect(prisma.weleticLoyaltyOutboxJob.updateMany).toHaveBeenCalledTimes(
        5,
      );
    });

    it("CAS-preserves concurrent non-PII metadata and scrubs every birthday job", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-29T05:00:00.000Z"));
      const firstUpdatedAt = new Date("2026-08-29T04:00:00.000Z");
      const concurrentUpdatedAt = new Date("2026-08-29T04:30:00.000Z");
      vi.mocked(prisma.weleticShopper.findUnique).mockResolvedValueOnce({
        id: "shop_redact_1",
        storeId: "store_gdpr_1",
        shopifyCustomerId: "cust_to_redact",
        firstName: "John",
        lastName: "Doe",
        email: "john@example.com",
      } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.findFirst)
        .mockResolvedValueOnce({
          id: "acc_to_redact",
          status: "active",
          updatedAt: firstUpdatedAt,
          metadata: {
            birthday: {
              birthDate: "2000-08-29",
              registeredAt: "2026-01-01T00:00:00.000Z",
            },
            preferredLanguage: "en",
          },
        } as any)
        .mockResolvedValueOnce({
          id: "acc_to_redact",
          status: "active",
          updatedAt: concurrentUpdatedAt,
          metadata: {
            birthday: {
              birthDate: "2000-08-29",
              registeredAt: "2026-01-01T00:00:00.000Z",
            },
            preferredLanguage: "en",
            concurrentCampaign: "autumn-2026",
          },
        } as any);
      vi.mocked(prisma.weleticLoyaltyAccount.updateMany)
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      const jobStatuses = [
        WeleticLoyaltyOutboxJobStatus.pending,
        WeleticLoyaltyOutboxJobStatus.failed,
        WeleticLoyaltyOutboxJobStatus.processing,
        WeleticLoyaltyOutboxJobStatus.dead_letter,
        WeleticLoyaltyOutboxJobStatus.completed,
      ];
      const accountScopedJobs = [
        {
          id: "referral_coupon_job",
          jobType: WeleticLoyaltyOutboxJobType.REFERRAL_REWARD_PROVISION,
          status: WeleticLoyaltyOutboxJobStatus.processing,
          payload: {
            accountId: "acc_to_redact",
            referralId: "referral_1",
            qualificationOrderId: "order_1",
            rewardDefinitionId: "reward_1",
            side: "advocate",
            rewardSnapshot: {
              customerSelectionDigest: "CUSTOMER_DERIVED_DIGEST",
            },
            shopifyCustomerId: "cust_to_redact",
          },
          updatedAt: new Date("2026-08-29T04:55:00.000Z"),
        },
        {
          id: "provisioning_recovery_job",
          jobType: WeleticLoyaltyOutboxJobType.REDEMPTION_RECOVERY,
          status: WeleticLoyaltyOutboxJobStatus.failed,
          payload: {
            redemptionId: "redemption_ambiguous",
            accountId: "acc_to_redact",
            rewardDefinitionId: "reward_1",
            pointsCost: "500",
            shopifyDiscountCode: "WL-AMBIGUOUS",
            attemptCount: 2,
            sagaPhase: "provisioning",
            shopifyCustomerId: "cust_to_redact",
          },
          updatedAt: new Date("2026-08-29T04:56:00.000Z"),
        },
        {
          id: "metafield_sync_job",
          jobType: WeleticLoyaltyOutboxJobType.METAFIELD_SYNC,
          status: WeleticLoyaltyOutboxJobStatus.pending,
          payload: {
            accountId: "acc_to_redact",
            shopifyCustomerId: "cust_to_redact",
            triggerReason: "redeem",
          },
          updatedAt: new Date("2026-08-29T04:57:00.000Z"),
        },
        {
          id: "expiry_recovery_job",
          jobType: WeleticLoyaltyOutboxJobType.REDEMPTION_RECOVERY,
          status: WeleticLoyaltyOutboxJobStatus.pending,
          payload: {
            redemptionId: "redemption_future_expiry",
            accountId: "acc_to_redact",
            rewardDefinitionId: "reward_1",
            pointsCost: "500",
            shopifyDiscountCode: "WL-FUTURE-EXPIRY",
            attemptCount: 0,
            sagaPhase: "expiry",
          },
          scheduledFor: new Date("2026-09-30T00:00:00.000Z"),
          updatedAt: new Date("2026-08-29T04:58:00.000Z"),
        },
      ];
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findMany)
        .mockResolvedValueOnce(
          jobStatuses.map((_, index) => ({
            id: `birthday_job_${index}`,
          })) as any,
        )
        .mockResolvedValueOnce(accountScopedJobs as any);
      vi.mocked(prisma.weleticLoyaltyOutboxJob.findFirst).mockImplementation(
        (async (args: any) => {
          const accountScopedJob = accountScopedJobs.find(
            (job) => job.id === args.where.id,
          );
          if (accountScopedJob) return accountScopedJob as any;

          const index = Number(args.where.id.split("_").at(-1));
          return {
            id: args.where.id,
            status: jobStatuses[index],
            payload: {
              accountId: "acc_to_redact",
              birthDate: "2000-08-29",
              registeredAt: "2026-01-01T00:00:00.000Z",
              calendarYear: 2027,
              unsafeUnknownField: "drop-me",
            },
            updatedAt: new Date(`2026-08-29T04:4${index}:00.000Z`),
          } as any;
        }) as any,
      );
      vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany).mockResolvedValue({
        count: 1,
      });
      vi.mocked(prisma.weleticPointsLedgerEntry.findMany)
        .mockResolvedValueOnce([{ id: "legacy_birthday_ledger" }] as any)
        .mockResolvedValueOnce([
          {
            id: "ledger_order_context",
            metadata: {
              orderName: "#PRIVATE",
              customerEmail: "private@example.com",
              financialContext: "preserve",
            },
          },
        ] as any);
      vi.mocked(
        prisma.weleticPointsLedgerEntry.findFirst,
      ).mockResolvedValueOnce({
        id: "legacy_birthday_ledger",
        metadata: {
          bonusType: "BIRTHDAY_REWARD",
          calendarYear: 2026,
          birthDate: "2000-08-29",
          registeredAt: "2026-01-01T00:00:00.000Z",
          earningRuleId: "birthday_rule",
        },
      } as any);
      vi.mocked(
        prisma.weleticPointsLedgerEntry.updateMany,
      ).mockResolvedValueOnce({ count: 1 });
      vi.mocked(prisma.weleticShopper.updateMany).mockResolvedValueOnce({
        count: 1,
      });
      vi.mocked(prisma.weleticCommerceOrder.updateMany).mockResolvedValueOnce({
        count: 1,
      });
      vi.mocked(prisma.weleticCommerceOrder.findMany).mockResolvedValueOnce([
        {
          id: "order_internal_1",
          lines: [
            {
              calculations: [
                {
                  id: "calculation_1",
                  inputs: {
                    customerOrderSequence: 2,
                    customerClassification: "returning",
                    customerSegmentIds: ["segment_private"],
                    productTags: ["financially-relevant-tag"],
                    shopifyReward: {
                      matchedSegmentId: "segment_private",
                      configHash: "config_hash",
                    },
                  },
                },
              ],
            },
          ],
          refunds: [],
        },
      ] as any);
      vi.mocked(
        prisma.weleticCommissionCalculation.updateMany,
      ).mockResolvedValueOnce({ count: 1 });
      vi.mocked(prisma.weleticRewardRedemption.findMany)
        .mockResolvedValueOnce([
          {
            id: "redemption_cleanup",
            storeId: "store_gdpr_1",
            accountId: "acc_to_redact",
            rewardDefinitionId: "reward_1",
            status: WeleticRedemptionStatus.issued,
            pointsSpent: BigInt(500),
            shopifyDiscountCode: "WL-PRIVATE",
            shopifyDiscountId: null,
            expiresAt: null,
            metadata: {
              rewardSnapshot: { name: "Private reward" },
              shopifyDiscountOwnership: {
                version: 1,
                fingerprint: "INVALID_TEST_FINGERPRINT",
                provisioningName: "Private reward",
                expectedTitle: "Private reward (WL-PRIVATE)",
              },
            },
          },
        ] as any)
        .mockResolvedValueOnce([
          {
            id: "redemption_context",
            metadata: {
              orderName: "#PRIVATE",
              checkoutToken: "checkout_private",
              provisioningPhase: "issued",
            },
          },
        ] as any);
      vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockResolvedValueOnce([
        {
          id: "referral_context",
          metadata: {
            referralCode: "PRIVATE42",
            orderId: "order_1",
          },
        },
      ] as any);

      const result = await anonymizeWeleticShopper({
        storeId: "store_gdpr_1",
        shopifyCustomerId: "cust_to_redact",
        orderExternalIds: ["order_external_1"],
      });

      expect(result.found).toBe(true);
      expect(result.shopperId).toBe("shop_redact_1");
      expect(prisma.weleticShopper.updateMany).toHaveBeenCalledWith({
        where: {
          id: "shop_redact_1",
          storeId: "store_gdpr_1",
          shopifyCustomerId: {
            in: ["cust_to_redact", expect.stringMatching(/^redacted:v1:/)],
          },
        },
        data: expect.objectContaining({
          shopifyCustomerId: expect.stringMatching(/^redacted:v1:/),
          firstName: "Redacted",
          lastName: "Customer",
          email: null,
          phone: null,
        }),
      });
      expect(prisma.weleticLoyaltyAccount.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: "acc_to_redact",
          storeId: "store_gdpr_1",
          updatedAt: concurrentUpdatedAt,
          shopper: {
            storeId: "store_gdpr_1",
            shopifyCustomerId: "cust_to_redact",
          },
        },
        data: {
          status: "closed",
          referralCode: null,
          referredById: null,
          lastQualifyingActivityAt: null,
          nextExpiryDate: null,
          metadata: {
            preferredLanguage: "en",
            concurrentCampaign: "autumn-2026",
            [SHOPIFY_CUSTOMER_REDACTION_TOMBSTONE_KEY]: {
              status: "redacted",
              redactedAt: "2026-08-29T05:00:00.000Z",
              source: "shopify_customers_redact",
            },
          },
        },
      });
      expect(prisma.weleticCommerceOrder.updateMany).toHaveBeenCalledWith({
        where: {
          storeId: "store_gdpr_1",
          id: { in: ["order_internal_1"] },
        },
        data: {
          checkoutToken: null,
          orderName: null,
          customerOrderSequence: null,
          customerClassification: "unknown",
          customerSegmentIds: Prisma.DbNull,
        },
      });
      expect(
        prisma.weleticCommissionCalculation.updateMany,
      ).toHaveBeenCalledWith({
        where: {
          id: "calculation_1",
          inputs: {
            equals: expect.objectContaining({
              customerOrderSequence: 2,
              customerSegmentIds: ["segment_private"],
            }),
          },
        },
        data: {
          inputs: {
            productTags: ["financially-relevant-tag"],
            shopifyReward: { configHash: "config_hash" },
          },
        },
      });
      expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenCalledWith({
        where: {
          id: "ledger_order_context",
          storeId: "store_gdpr_1",
          accountId: "acc_to_redact",
        },
        data: {
          reason: "Customer context redacted.",
          metadata: { financialContext: "preserve" },
        },
      });
      expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith({
        where: {
          id: "redemption_context",
          storeId: "store_gdpr_1",
          accountId: "acc_to_redact",
        },
        data: { metadata: { provisioningPhase: "issued" } },
      });
      expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith({
        where: { id: "referral_context", storeId: "store_gdpr_1" },
        data: {
          dubLinkId: null,
          ipHash: null,
          userAgentHash: null,
          fraudReason: null,
          fraudSignals: Prisma.DbNull,
          metadata: { orderId: "order_1" },
        },
      });
      expect(prisma.weleticLoyaltyOutboxJob.findMany).toHaveBeenCalledWith({
        where: {
          storeId: "store_gdpr_1",
          jobType: WeleticLoyaltyOutboxJobType.BIRTHDAY_REWARD,
          payload: { path: "$.accountId", equals: "acc_to_redact" },
        },
        select: { id: true },
      });

      const jobUpdates = vi.mocked(prisma.weleticLoyaltyOutboxJob.updateMany)
        .mock.calls;
      expect(jobUpdates).toHaveLength(jobStatuses.length + 4);
      for (const [index, [update]] of jobUpdates
        .slice(0, jobStatuses.length)
        .entries()) {
        expect(update.where).toEqual(
          expect.objectContaining({
            id: `birthday_job_${index}`,
            storeId: "store_gdpr_1",
            jobType: WeleticLoyaltyOutboxJobType.BIRTHDAY_REWARD,
            status: jobStatuses[index],
            payload: { path: "$.accountId", equals: "acc_to_redact" },
          }),
        );
        expect(update.data.payload).toEqual({
          accountId: "acc_to_redact",
          calendarYear: 2027,
          birthdayRedactedAt: "2026-08-29T05:00:00.000Z",
          redactionReason: "shopify_customer_redact",
        });
        expect(update.data.scheduledFor).toEqual(
          new Date("2026-08-29T05:00:00.000Z"),
        );
        expect(update.data.createdAt).toEqual(
          new Date("2026-08-29T05:00:00.000Z"),
        );
        expect(update.data.nextRetryAt).toBeNull();
        expect(update.data.errorLog).toBe(Prisma.DbNull);
        expect(JSON.stringify(update.data.payload)).not.toContain("birthDate");
        expect(JSON.stringify(update.data.payload)).not.toContain(
          "registeredAt",
        );
        if (jobStatuses[index] === WeleticLoyaltyOutboxJobStatus.completed) {
          expect(update.data.status).toBeUndefined();
        } else {
          expect(update.data).toEqual(
            expect.objectContaining({
              status: WeleticLoyaltyOutboxJobStatus.cancelled,
              lockedAt: null,
              lockedBy: null,
              nextRetryAt: null,
            }),
          );
        }
      }
      expect(jobUpdates.at(-4)?.[0]).toEqual({
        where: {
          id: "referral_coupon_job",
          storeId: "store_gdpr_1",
          status: WeleticLoyaltyOutboxJobStatus.processing,
          updatedAt: new Date("2026-08-29T04:55:00.000Z"),
          payload: { path: "$.accountId", equals: "acc_to_redact" },
        },
        data: expect.objectContaining({
          status: WeleticLoyaltyOutboxJobStatus.pending,
          payload: {
            accountId: "acc_to_redact",
            referralId: "referral_1",
            qualificationOrderId: "order_1",
            rewardDefinitionId: "reward_1",
            side: "advocate",
          },
          attempts: 0,
          processedAt: null,
          completedAt: null,
          lockedAt: null,
          lockedBy: null,
          lastError:
            "Queued for audited Shopify discount cleanup after customer redaction.",
        }),
      });
      expect(jobUpdates.at(-3)?.[0]).toEqual({
        where: {
          id: "provisioning_recovery_job",
          storeId: "store_gdpr_1",
          status: WeleticLoyaltyOutboxJobStatus.failed,
          updatedAt: new Date("2026-08-29T04:56:00.000Z"),
          payload: { path: "$.accountId", equals: "acc_to_redact" },
        },
        data: expect.objectContaining({
          status: WeleticLoyaltyOutboxJobStatus.pending,
          payload: {
            redemptionId: "redemption_ambiguous",
            accountId: "acc_to_redact",
            rewardDefinitionId: "reward_1",
            pointsCost: "500",
            shopifyDiscountCode: "WL-AMBIGUOUS",
            attemptCount: 2,
            sagaPhase: "provisioning",
          },
          attempts: 0,
          processedAt: null,
          completedAt: null,
          lockedAt: null,
          lockedBy: null,
          lastError:
            "Queued for audited Shopify discount cleanup after customer redaction.",
        }),
      });
      expect(jobUpdates.at(-2)?.[0]).toEqual({
        where: {
          id: "metafield_sync_job",
          storeId: "store_gdpr_1",
          status: WeleticLoyaltyOutboxJobStatus.pending,
          updatedAt: new Date("2026-08-29T04:57:00.000Z"),
          payload: { path: "$.accountId", equals: "acc_to_redact" },
        },
        data: expect.objectContaining({
          status: WeleticLoyaltyOutboxJobStatus.cancelled,
          payload: {
            accountId: "acc_to_redact",
            triggerReason: "redeem",
          },
          processedAt: new Date("2026-08-29T05:00:00.000Z"),
          completedAt: new Date("2026-08-29T05:00:00.000Z"),
          lockedAt: null,
          lockedBy: null,
          lastError: "Cancelled after Shopify customer redaction.",
        }),
      });
      expect(jobUpdates.at(-1)?.[0]).toEqual({
        where: {
          id: "expiry_recovery_job",
          storeId: "store_gdpr_1",
          status: WeleticLoyaltyOutboxJobStatus.pending,
          updatedAt: new Date("2026-08-29T04:58:00.000Z"),
          payload: { path: "$.accountId", equals: "acc_to_redact" },
        },
        data: expect.objectContaining({
          status: WeleticLoyaltyOutboxJobStatus.pending,
          scheduledFor: new Date("2026-09-30T00:00:00.000Z"),
          attempts: 0,
          processedAt: null,
          completedAt: null,
          lockedAt: null,
          lockedBy: null,
          lastError:
            "Queued for audited Shopify discount cleanup after customer redaction.",
        }),
      });
      expect(prisma.weleticPointsLedgerEntry.updateMany).toHaveBeenCalledWith({
        where: {
          id: "legacy_birthday_ledger",
          storeId: "store_gdpr_1",
          accountId: "acc_to_redact",
          referenceType: "BIRTHDAY_REWARD",
          metadata: {
            equals: {
              bonusType: "BIRTHDAY_REWARD",
              calendarYear: 2026,
              birthDate: "2000-08-29",
              registeredAt: "2026-01-01T00:00:00.000Z",
              earningRuleId: "birthday_rule",
            },
          },
        },
        data: {
          metadata: {
            bonusType: "BIRTHDAY_REWARD",
            calendarYear: 2026,
            earningRuleId: "birthday_rule",
          },
          reason: "Birthday reward details redacted.",
          createdAt: new Date("2026-08-29T05:00:00.000Z"),
        },
      });
    });
  });
});
