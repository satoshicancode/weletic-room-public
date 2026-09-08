import { claimReferralFriendReward } from "@/lib/weletic/loyalty/referral-friend-claim";
import { sendBatchEmail } from "@dub/email";
import { WeleticLoyaltyReferralStatus } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const STORE_ID = "store_email_durability";
const SHOP_DOMAIN = "yamax-email.myshopify.com";
const ADVOCATE_CODE = "ALICE-EMAIL";
const FRIEND_EMAIL = "friend@example.com";
const NOW = new Date("2026-06-15T12:00:00.000Z");

const prismaMocks = vi.hoisted(() => ({
  storeFindUniqueOrThrow: vi.fn(),
  accountFindFirst: vi.fn(),
  referralFindFirst: vi.fn(),
  referralFindUnique: vi.fn(),
  referralCreate: vi.fn(),
  referralUpdateMany: vi.fn(),
  referralRuleFindFirst: vi.fn(),
  shopperFindFirst: vi.fn(),
  tombstoneFindFirst: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/prisma", () => {
  const client: any = {
    weleticMerchantSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    weleticShopifyStore: {
      findUnique: prismaMocks.storeFindUniqueOrThrow,
      findUniqueOrThrow: prismaMocks.storeFindUniqueOrThrow,
    },
    weleticLoyaltyAccount: {
      findFirst: prismaMocks.accountFindFirst,
    },
    weleticShopper: {
      findFirst: prismaMocks.shopperFindFirst,
    },
    weleticLoyaltyReferral: {
      findFirst: prismaMocks.referralFindFirst,
      findUnique: prismaMocks.referralFindUnique,
      create: prismaMocks.referralCreate,
      updateMany: prismaMocks.referralUpdateMany,
    },
    weleticLoyaltyReferralRule: {
      findFirst: prismaMocks.referralRuleFindFirst,
    },
    weleticShopifyCustomerPrivacyTombstone: {
      findFirst: prismaMocks.tombstoneFindFirst,
    },
    $transaction: prismaMocks.transaction,
  };
  return { prisma: client };
});

vi.mock("@dub/email", () => ({
  sendBatchEmail: vi.fn(),
}));

vi.mock("@/lib/weletic/shopify/discount-code", () => ({
  createOneTimeShopifyDiscountCode: vi.fn().mockResolvedValue({
    code: "WLF-TEST1234",
    remoteDiscountId: "gid://shopify/DiscountCodeNode/123",
  }),
  deactivateOneTimeShopifyDiscountCode: vi.fn().mockResolvedValue(true),
  lookupShopifyDiscountCodeByTitle: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/weletic/shopify/compliance-ingress", () => ({
  assertShopifyStoreAcceptsOperationalWrites: vi.fn().mockResolvedValue({
    id: "store_email_durability",
    shopDomain: "yamax-email.myshopify.com",
    accessToken: "shpat_test",
  }),
}));

vi.mock("@/lib/weletic/shopify/session-token", () => ({
  getShopifyStoreCredentials: vi.fn().mockResolvedValue({
    shopDomain: "yamax-email.myshopify.com",
    accessToken: "shpat_test",
  }),
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/weletic/loyalty/shopify-discounts")
    >();
  return {
    ...actual,
    resolveShopifyOfflineCredentials: vi.fn().mockResolvedValue({
      shopDomain: "yamax-email.myshopify.com",
      accessToken: "shpat_test",
      source: "installed_integration",
    }),
    shopifyAdminGraphqlRequest: vi.fn().mockResolvedValue({
      data: { customers: { edges: [] } },
    }),
    provisionLoyaltyRewardDiscount: vi.fn(),
    lookupDiscountByCode: vi.fn(),
    matchesLoyaltyRewardDiscountConfiguration: vi.fn().mockReturnValue(true),
    deactivateDiscount: vi.fn(),
  };
});

vi.mock("@/lib/weletic/loyalty/program-lock", () => ({
  lockLoyaltyProgramRow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/loyalty/rewards", () => ({
  getRewardDefinitionOrThrow: vi.fn().mockResolvedValue({
    id: "reward_1",
    storeId: "store_email_durability",
    name: "¥1000 off",
    rewardType: "amount_off",
    salesChannel: "online_store",
    exchangeType: "fixed",
    discountValue: "1000",
    minOrderAmount: "5000",
    expiresInDays: 30,
  }),
  isRewardDefinitionProvisionable: vi.fn().mockReturnValue(true),
  isReferralCouponProvisionable: vi.fn().mockReturnValue(true),
}));

describe("Referral Friend Email Delivery Durability & Lease State Machine", () => {
  let referralRecord: any = null;

  beforeEach(() => {
    vi.clearAllMocks();

    referralRecord = {
      id: "wreferral_test_1",
      storeId: STORE_ID,
      advocateAccountId: "wacc_advocate_1",
      friendEmailDigest: "digest_friend",
      friendShopifyDiscountCode: "WLF-TEST1234",
      friendShopifyDiscountCodeCanonical: "WLFTEST1234",
      friendShopifyDiscountId: "gid://shopify/DiscountCodeNode/123",
      friendRewardDefinitionId: "reward_1",
      friendRewardProvisionedAt: NOW,
      friendRewardEmailedAt: null,
      friendEmailLeaseToken: null,
      friendEmailLeaseReservedAt: null,
      friendEmailLeaseExpiresAt: new Date("1970-01-01T00:00:00.000Z"),
      friendEmailDeliveryAttempts: 0,
      friendEmailLastError: null,
      friendRewardExpiresAt: new Date(NOW.getTime() + 30 * 86400000),
      status: WeleticLoyaltyReferralStatus.pending,
      metadata: {
        friendRewardSnapshot: {
          rewardDefinition: {
            id: "reward_1",
            name: "¥1000 off",
            rewardType: "amount_off",
            discountValue: "1000",
            maxDiscountValue: null,
            minOrderAmount: "5000",
            appliesToResource: null,
            entitledProductIds: [],
            entitledVariantIds: [],
            entitledCollectionIds: [],
            combinesWithOrderDiscounts: false,
            combinesWithProductDiscounts: false,
            combinesWithShippingDiscounts: false,
            usageLimit: 1,
            usageLimitPerCustomer: 1,
            expiresInDays: 30,
          },
          startsAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + 30 * 86400000).toISOString(),
          shopCurrency: "JPY",
          currencyVerifiedAt: NOW.toISOString(),
        },
      },
      createdAt: NOW,
      updatedAt: NOW,
    };

    prismaMocks.storeFindUniqueOrThrow.mockResolvedValue({
      id: STORE_ID,
      shopDomain: SHOP_DOMAIN,
    });

    prismaMocks.accountFindFirst.mockResolvedValue({
      id: "wacc_advocate_1",
      storeId: STORE_ID,
      referralCode: ADVOCATE_CODE,
      status: "active",
      shopper: { firstName: "Alice", lastName: "Smith" },
      program: { name: "Yamax Club" },
    });

    prismaMocks.transaction.mockImplementation(async (callback: any) => {
      return callback({
        weleticShopifyStore: {
          findUniqueOrThrow: prismaMocks.storeFindUniqueOrThrow,
        },
        weleticLoyaltyAccount: {
          findFirst: prismaMocks.accountFindFirst,
        },
        weleticLoyaltyReferral: {
          findFirst: prismaMocks.referralFindFirst,
          create: prismaMocks.referralCreate,
        },
        weleticLoyaltyReferralRule: {
          findFirst: prismaMocks.referralRuleFindFirst,
        },
      });
    });

    prismaMocks.referralFindFirst.mockImplementation(
      async () => referralRecord,
    );
    prismaMocks.referralFindUnique.mockImplementation(
      async () => referralRecord,
    );
    prismaMocks.referralCreate.mockImplementation(async (args: any) => {
      referralRecord = { ...args.data };
      return referralRecord;
    });
    prismaMocks.referralRuleFindFirst.mockResolvedValue({
      id: "rule_1",
      refereeRewardKind: "coupon",
      refereeRewardDefinitionId: "reward_1",
    });

    prismaMocks.referralUpdateMany.mockImplementation(async (args: any) => {
      if (!referralRecord) return { count: 0 };
      if (
        args.where.friendRewardEmailedAt === null &&
        referralRecord.friendRewardEmailedAt
      ) {
        return { count: 0 };
      }
      if (
        args.where.friendEmailLeaseExpiresAt?.lte &&
        referralRecord.friendEmailLeaseExpiresAt >
          args.where.friendEmailLeaseExpiresAt.lte
      ) {
        return { count: 0 };
      }
      if (
        typeof args.where.friendEmailLeaseToken === "string" &&
        referralRecord.friendEmailLeaseToken !==
          args.where.friendEmailLeaseToken
      ) {
        return { count: 0 };
      }
      const data = { ...args.data };
      if (typeof data.friendEmailDeliveryAttempts === "object") {
        data.friendEmailDeliveryAttempts =
          referralRecord.friendEmailDeliveryAttempts +
          data.friendEmailDeliveryAttempts.increment;
      }
      referralRecord = { ...referralRecord, ...data };
      return { count: 1 };
    });

    prismaMocks.shopperFindFirst.mockResolvedValue(null);
    prismaMocks.tombstoneFindFirst.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1. Successfully delivers friend reward email and finalizes its dedicated lease", async () => {
    vi.mocked(sendBatchEmail).mockResolvedValueOnce({
      data: [{ id: "msg_123" }] as any,
      error: null,
    });

    const result = await claimReferralFriendReward({
      storeId: STORE_ID,
      referralCode: ADVOCATE_CODE,
      friendEmail: FRIEND_EMAIL,
      now: NOW,
    });

    expect(result).toMatchObject({
      status: "claimed",
      discountCode: "WLF-TEST1234",
      emailSent: true,
    });

    expect(sendBatchEmail).toHaveBeenCalledTimes(1);
    expect(referralRecord.friendRewardEmailedAt).toBeInstanceOf(Date);
    expect(referralRecord.friendEmailDeliveryAttempts).toBe(1);
    expect(referralRecord.friendEmailLeaseToken).toBeNull();
    expect(referralRecord.friendEmailLeaseReservedAt).toBeNull();
    expect(referralRecord.friendEmailLastError).toBeNull();
    expect(
      referralRecord.metadata.friendEmailDeliveryReservation,
    ).toBeUndefined();
    // PII invariant: Raw email must never be stored in metadata
    expect(JSON.stringify(referralRecord.metadata)).not.toContain(FRIEND_EMAIL);
  });

  it("2. Does not crash on email transport failure and returns provisioned discount code", async () => {
    vi.mocked(sendBatchEmail).mockRejectedValueOnce(
      new Error("SMTP Connection Timeout"),
    );

    const result = await claimReferralFriendReward({
      storeId: STORE_ID,
      referralCode: ADVOCATE_CODE,
      friendEmail: FRIEND_EMAIL,
      now: NOW,
    });

    expect(result).toMatchObject({
      status: "claimed",
      discountCode: "WLF-TEST1234",
      emailSent: false,
    });

    expect(referralRecord.friendRewardEmailedAt).toBeNull();
    expect(referralRecord.friendEmailDeliveryAttempts).toBe(1);
    expect(referralRecord.friendEmailLeaseToken).toBeNull();
    expect(referralRecord.friendEmailLeaseReservedAt).toBeNull();
    expect(referralRecord.friendEmailLastError).toContain("Timeout");
  });

  it("3. Prevents duplicate outbound emails when an active lease is held by a concurrent request", async () => {
    referralRecord.friendEmailLeaseToken = "active-worker";
    referralRecord.friendEmailLeaseReservedAt = NOW;
    referralRecord.friendEmailLeaseExpiresAt = new Date(NOW.getTime() + 60_000);
    referralRecord.friendEmailDeliveryAttempts = 1;

    const result = await claimReferralFriendReward({
      storeId: STORE_ID,
      referralCode: ADVOCATE_CODE,
      friendEmail: FRIEND_EMAIL,
      now: NOW,
    });

    // Skips second delivery call while lease is unexpired
    expect(sendBatchEmail).not.toHaveBeenCalled();
    expect(result.status).toBe("claimed");
    expect(result.emailSent).toBe(false);
  });

  it("4. Allows retry when previous reservation lease has expired", async () => {
    referralRecord.friendEmailLeaseToken = "expired-worker";
    referralRecord.friendEmailLeaseReservedAt = new Date(
      NOW.getTime() - 300_000,
    );
    referralRecord.friendEmailLeaseExpiresAt = new Date(
      NOW.getTime() - 240_000,
    );
    referralRecord.friendEmailDeliveryAttempts = 1;

    vi.mocked(sendBatchEmail).mockResolvedValueOnce({
      data: [{ id: "msg_retry" }] as any,
      error: null,
    });

    const result = await claimReferralFriendReward({
      storeId: STORE_ID,
      referralCode: ADVOCATE_CODE,
      friendEmail: FRIEND_EMAIL,
      now: NOW,
    });

    expect(sendBatchEmail).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("claimed");
    expect(result.emailSent).toBe(true);
    expect(referralRecord.friendRewardEmailedAt).toBeInstanceOf(Date);
    expect(referralRecord.friendEmailDeliveryAttempts).toBe(2);
    expect(referralRecord.friendEmailLeaseToken).toBeNull();
  });

  it("5. Never re-delivers email if friendRewardEmailedAt is already recorded", async () => {
    referralRecord.friendRewardEmailedAt = new Date(NOW.getTime() - 60_000);

    const result = await claimReferralFriendReward({
      storeId: STORE_ID,
      referralCode: ADVOCATE_CODE,
      friendEmail: FRIEND_EMAIL,
      now: NOW,
    });

    expect(sendBatchEmail).not.toHaveBeenCalled();
    expect(result.status).toBe("claimed");
    expect(result.emailSent).toBe(true);
  });
});
