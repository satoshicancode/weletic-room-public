import { prisma } from "@/lib/prisma";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import {
  claimReferralFriendReward,
  deactivateCancelledReferralFriendReward,
  deliverReferralEmailUnderLease,
  evaluateReferralFriendClaimQualification,
  redactReferralFriendClaimsForEmail,
  redactReferralFriendClaimsForShopBatch,
} from "@/lib/weletic/loyalty/referral-friend-claim";
import {
  createReferralPrivacySnapshot,
  readReferralPrivacySnapshot,
} from "@/lib/weletic/loyalty/referral-privacy-snapshot";
import {
  provisionLoyaltyRewardDiscount,
  shopifyAdminGraphqlRequest,
} from "@/lib/weletic/loyalty/shopify-discounts";
import { sendBatchEmail } from "@dub/email";
import { WeleticLoyaltyReferralStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  referral: null as any,
  inTransaction: false,
}));
const compliance = vi.hoisted(() => ({ assertWrites: vi.fn() }));
const discountMocks = vi.hoisted(() => ({
  provision: vi.fn(),
  lookup: vi.fn(),
  graphql: vi.fn(),
  deactivate: vi.fn(),
}));
const emailMocks = vi.hoisted(() => ({ sendBatch: vi.fn() }));

vi.mock("@/lib/prisma", () => {
  const prismaMock: any = {
    $queryRaw: vi.fn(async (query: { sql: string; values: unknown[] }) => {
      if (query.values[0] !== "store_1") return [];
      if (query.sql.includes("FROM WeleticLoyaltyProgram"))
        return [
          {
            id: "program_1",
            storeId: "store_1",
            status: "active",
            killSwitchActive: false,
            metadata: null,
          },
        ];
      if (query.sql.includes("FROM WeleticShopifyStore"))
        return [{ id: "store_1", storeAccessState: "active" }];
      throw new Error("Unexpected friend-claim SQL query");
    }),
    weleticLoyaltyProgram: {
      findUnique: vi.fn().mockResolvedValue({
        id: "program_1",
        storeId: "store_1",
        status: "active",
        killSwitchActive: false,
        metadata: null,
      }),
    },
    weleticMerchantSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    $executeRaw: vi.fn(),
    weleticShopifyStore: {
      findUniqueOrThrow: vi.fn(),
    },
    weleticShopper: {
      findFirst: vi.fn(),
    },
    weleticShopifyCustomerPrivacyTombstone: {
      findFirst: vi.fn(),
    },
    weleticLoyaltyAccount: {
      findFirst: vi.fn(),
      findFirstOrThrow: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findFirstOrThrow: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyReferralRule: {
      findFirst: vi.fn(),
    },
    weleticRewardDefinition: {
      findFirst: vi.fn(),
    },
    weleticPointsLedgerEntry: {
      findUnique: vi.fn(),
    },
    weleticLoyaltyOutboxJob: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(async (operation: any) => {
      state.inTransaction = true;
      try {
        return await operation(prismaMock);
      } finally {
        state.inTransaction = false;
      }
    }),
  };
  return { prisma: prismaMock };
});

vi.mock("@/lib/weletic/shopify/store-compliance-state", () => ({
  assertShopifyStoreAcceptsOperationalWrites: compliance.assertWrites,
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", () => ({
  resolveShopifyOfflineCredentials: vi.fn().mockResolvedValue({
    shopDomain: "yamax.myshopify.com",
    accessToken: "test-token",
    source: "installed_integration",
  }),
  shopifyAdminGraphqlRequest: discountMocks.graphql,
  provisionLoyaltyRewardDiscount: discountMocks.provision,
  lookupDiscountByCode: discountMocks.lookup,
  matchesLoyaltyRewardDiscountConfiguration: vi.fn().mockReturnValue(true),
  deactivateDiscount: discountMocks.deactivate,
}));

vi.mock("@/lib/email/get-email-domain-block-flags", () => ({
  getEmailDomainBlockFlags: vi.fn().mockResolvedValue({
    isDisposable: false,
    matchesBlockedTerms: false,
  }),
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  OptimisticConcurrencyError: class OptimisticConcurrencyError extends Error {},
  appendPointsLedgerEntry: vi.fn().mockResolvedValue({
    id: "ledger_1",
    balanceAfter: BigInt(1_000),
  }),
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: vi.fn().mockResolvedValue({ id: "job_1" }),
}));

vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/weletic/loyalty/rewards", () => ({
  isRewardDefinitionProvisionable: vi.fn().mockReturnValue(true),
  isReferralCouponProvisionable: vi.fn(
    (reward: { salesChannel?: string }) =>
      reward.salesChannel === "online_store" || reward.salesChannel === "both",
  ),
}));

vi.mock("@/lib/weletic/loyalty/referral-coupon", () => ({
  getReferralCouponIdempotencyKey: vi.fn(
    ({ referralId, qualificationOrderId, side }) =>
      `referral:${referralId}:${qualificationOrderId}:${side}`,
  ),
}));

vi.mock("@/lib/weletic/loyalty/referral-coupon-snapshot", () => ({
  createReferralCouponRewardSnapshot: vi.fn().mockReturnValue({
    version: 1,
    discountCode: "WLR-TEST",
  }),
}));

vi.mock("@dub/email", () => ({
  sendBatchEmail: emailMocks.sendBatch,
}));

const advocate = {
  id: "account_advocate",
  storeId: "store_1",
  programId: "program_1",
  status: "active",
  referralCode: "ALICE-1234",
  referralCount: 0,
  shopper: {
    email: "alice@example.com",
    firstName: "Alice",
    lastName: "Member",
  },
  program: {
    id: "program_1",
    storeId: "store_1",
    name: "Yamax Points",
  },
};

const friendReward = {
  id: "reward_friend",
  storeId: "store_1",
  name: "$10 welcome reward",
  description: null,
  rewardType: "amount_off",
  salesChannel: "online_store",
  exchangeType: "fixed",
  status: "active",
  pointsCost: BigInt(0),
  discountValue: { toString: () => "1000" },
  maxDiscountValue: null,
  minOrderAmount: null,
  appliesToResource: "entire_order",
  entitledCollectionIds: [],
  entitledProductIds: [],
  entitledVariantIds: [],
  combinesWithProductDiscounts: false,
  combinesWithOrderDiscounts: false,
  combinesWithShippingDiscounts: false,
  usageLimit: null,
  usageLimitPerCustomer: null,
  expiresInDays: 30,
};

function installStatefulReferralMocks() {
  vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockImplementation(
    (async ({ where }: any) => {
      if (!state.referral) return null;
      if (where?.id && where.id !== state.referral.id) return null;
      if (
        where?.status &&
        typeof where.status === "string" &&
        where.status !== state.referral.status
      ) {
        return null;
      }
      if (
        where?.friendEmailDigest?.in &&
        !where.friendEmailDigest.in.includes(state.referral.friendEmailDigest)
      ) {
        return null;
      }
      if (
        typeof where?.friendShopifyDiscountId === "string" &&
        where.friendShopifyDiscountId !== state.referral.friendShopifyDiscountId
      ) {
        return null;
      }
      if (
        where?.friendShopifyDiscountId?.not === null &&
        !state.referral.friendShopifyDiscountId
      ) {
        return null;
      }
      if (
        where?.friendRewardProvisionedAt?.not === null &&
        !state.referral.friendRewardProvisionedAt
      ) {
        return null;
      }
      return {
        ...state.referral,
        advocateAccount: advocate,
      };
    }) as any,
  );
  vi.mocked(prisma.weleticLoyaltyReferral.create).mockImplementation((async ({
    data,
  }: any) => {
    state.referral = {
      ...data,
      metadata: data.metadata ?? null,
      friendRewardProvisionedAt: data.friendRewardProvisionedAt ?? null,
      friendRewardEmailedAt: data.friendRewardEmailedAt ?? null,
      friendEmailLeaseToken: data.friendEmailLeaseToken ?? null,
      friendEmailLeaseReservedAt: data.friendEmailLeaseReservedAt ?? null,
      friendEmailLeaseExpiresAt:
        data.friendEmailLeaseExpiresAt ?? new Date("1970-01-01T00:00:00.000Z"),
      friendEmailDeliveryAttempts: data.friendEmailDeliveryAttempts ?? 0,
      friendEmailLastError: data.friendEmailLastError ?? null,
      friendShopifyDiscountId: data.friendShopifyDiscountId ?? null,
      qualifyingOrderId: data.qualifyingOrderId ?? null,
      refereeShopperId: data.refereeShopperId ?? null,
      refereeAccountId: data.refereeAccountId ?? null,
      advocatePointsAwarded: data.advocatePointsAwarded ?? BigInt(0),
      refereePointsAwarded: data.refereePointsAwarded ?? BigInt(0),
      rewardedAt: data.rewardedAt ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    return state.referral;
  }) as any);
  vi.mocked(prisma.weleticLoyaltyReferral.updateMany).mockImplementation(
    (async ({ where, data }: any) => {
      if (!state.referral || (where.id && where.id !== state.referral.id)) {
        return { count: 0 };
      }
      if (
        typeof where.status === "string" &&
        where.status !== state.referral.status
      ) {
        return { count: 0 };
      }
      if (
        where.friendRewardProvisionedAt === null &&
        state.referral.friendRewardProvisionedAt
      ) {
        return { count: 0 };
      }
      if (
        typeof where.friendShopifyDiscountId === "string" &&
        where.friendShopifyDiscountId !== state.referral.friendShopifyDiscountId
      ) {
        return { count: 0 };
      }
      if (
        where.friendRewardEmailedAt === null &&
        state.referral.friendRewardEmailedAt
      ) {
        return { count: 0 };
      }
      if (
        typeof where.friendEmailLeaseToken === "string" &&
        where.friendEmailLeaseToken !== state.referral.friendEmailLeaseToken
      ) {
        return { count: 0 };
      }
      if (
        where.friendEmailLeaseExpiresAt?.lte &&
        state.referral.friendEmailLeaseExpiresAt >
          where.friendEmailLeaseExpiresAt.lte
      ) {
        return { count: 0 };
      }
      const nextData = { ...data };
      if (typeof data.friendEmailDeliveryAttempts === "object") {
        nextData.friendEmailDeliveryAttempts =
          state.referral.friendEmailDeliveryAttempts +
          data.friendEmailDeliveryAttempts.increment;
      }
      state.referral = {
        ...state.referral,
        ...nextData,
        updatedAt: new Date(),
      };
      return { count: 1 };
    }) as any,
  );
  vi.mocked(prisma.weleticLoyaltyReferral.findFirstOrThrow).mockImplementation(
    (async () => state.referral) as any,
  );
  vi.mocked(prisma.weleticLoyaltyReferral.findUnique).mockImplementation(
    (async () => state.referral) as any,
  );
  vi.mocked(prisma.$executeRaw).mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = strings.join("?");
    if (sql.includes("`friendEmailDeliveryAttempts` + 1")) {
      const [
        leaseToken,
        reservedAt,
        leaseExpiresAt,
        updatedAt,
        id,
        storeId,
        now,
      ] = values as [string, Date, Date, Date, string, string, Date];
      if (
        state.referral.id !== id ||
        state.referral.storeId !== storeId ||
        state.referral.friendRewardEmailedAt ||
        state.referral.friendEmailLeaseExpiresAt > now
      ) {
        return 0;
      }
      state.referral = {
        ...state.referral,
        friendEmailLeaseToken: leaseToken,
        friendEmailLeaseReservedAt: reservedAt,
        friendEmailLeaseExpiresAt: leaseExpiresAt,
        friendEmailDeliveryAttempts:
          state.referral.friendEmailDeliveryAttempts + 1,
        friendEmailLastError: null,
        updatedAt,
      };
      return 1;
    }

    const leaseToken = values.at(-1);
    if (state.referral.friendEmailLeaseToken !== leaseToken) return 0;
    if (sql.includes("`friendRewardEmailedAt` =")) {
      const [deliveredAt] = values as [Date];
      state.referral = {
        ...state.referral,
        friendRewardEmailedAt: deliveredAt,
        friendEmailLeaseToken: null,
        friendEmailLeaseReservedAt: null,
        friendEmailLeaseExpiresAt: deliveredAt,
        friendEmailLastError: null,
      };
    } else {
      const [now, error] = values as [Date, string];
      state.referral = {
        ...state.referral,
        friendEmailLeaseToken: null,
        friendEmailLeaseReservedAt: null,
        friendEmailLeaseExpiresAt: now,
        friendEmailLastError: error,
      };
    }
    return 1;
  }) as any);
  vi.mocked(prisma.weleticLoyaltyReferral.findMany).mockImplementation((async ({
    where,
  }: any) =>
    state.referral &&
    (where.OR ||
      where.friendEmailDigest?.in?.includes(state.referral.friendEmailDigest))
      ? [state.referral]
      : []) as any);
}

describe("Smile-compatible anonymous referral friend claims", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.referral = null;
    state.inTransaction = false;
    compliance.assertWrites.mockResolvedValue({
      id: "store_1",
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      installationGeneration: "generation_1",
    });
    vi.mocked(prisma.weleticShopifyStore.findUniqueOrThrow).mockResolvedValue({
      shopDomain: "yamax.myshopify.com",
    } as any);
    vi.mocked(prisma.weleticShopper.findFirst).mockResolvedValue(null);
    vi.mocked(
      prisma.weleticShopifyCustomerPrivacyTombstone.findFirst,
    ).mockResolvedValue(null);
    vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue(
      advocate as any,
    );
    vi.mocked(prisma.weleticLoyaltyAccount.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(prisma.weleticLoyaltyReferralRule.findFirst).mockResolvedValue({
      id: "rule_1",
      programId: "program_1",
      isActive: true,
      advocateRewardKind: "points",
      advocatePointsReward: BigInt(500),
      advocateRewardDefinitionId: null,
      refereeRewardKind: "coupon",
      refereeRewardDefinitionId: "reward_friend",
      minQualifyingOrderSubtotal: null,
      maxReferralsPerAdvocate: null,
      fraudCheckSameIp: true,
    } as any);
    vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValue(
      friendReward as any,
    );
    vi.mocked(prisma.weleticPointsLedgerEntry.findUnique).mockResolvedValue(
      null,
    );
    vi.mocked(prisma.weleticLoyaltyOutboxJob.findUnique).mockResolvedValue(
      null,
    );
    discountMocks.graphql.mockResolvedValue({ customers: { nodes: [] } });
    discountMocks.provision.mockResolvedValue({
      id: "gid://shopify/DiscountCodeNode/friend-1",
      code: "WLF-TEST",
      title: "Friend reward",
      status: "ACTIVE",
    });
    discountMocks.lookup.mockResolvedValue(null);
    emailMocks.sendBatch.mockResolvedValue({
      data: { data: [{ id: "email_1" }] },
      error: null,
    });
    installStatefulReferralMocks();
  });

  it.each(["resend", "smtp"])(
    "allows exactly one %s delivery through the token-owned lease",
    async () => {
      state.referral = {
        id: "referral_email_lease",
        storeId: "store_1",
        friendRewardEmailedAt: null,
        friendEmailLeaseToken: null,
        friendEmailLeaseReservedAt: null,
        friendEmailLeaseExpiresAt: new Date("1970-01-01T00:00:00.000Z"),
        friendEmailDeliveryAttempts: 0,
        friendEmailLastError: null,
      };
      let sends = 0;
      let releaseDelivery!: () => void;
      const deliveryStarted = new Promise<void>((resolve) => {
        releaseDelivery = resolve;
      });
      const deliver = vi.fn(async () => {
        sends++;
        await deliveryStarted;
        return { success: true };
      });

      const attempts = Array.from({ length: 20 }, () =>
        deliverReferralEmailUnderLease({
          referralId: state.referral.id,
          storeId: state.referral.storeId,
          now: new Date("2026-09-04T00:00:00.000Z"),
          deliver,
        }),
      );
      await vi.waitFor(() => expect(sends).toBe(1));
      releaseDelivery();
      const results = await Promise.all(attempts);

      expect(deliver).toHaveBeenCalledTimes(1);
      expect(results.filter((result) => result.acquired)).toHaveLength(1);
      expect(state.referral.friendRewardEmailedAt).toBeInstanceOf(Date);
      expect(state.referral.friendEmailDeliveryAttempts).toBe(1);
    },
  );

  it.each(["returned", "thrown", "empty"])(
    "sanitizes %s provider failures before referral persistence or logging",
    async (mode) => {
      const privateDetail = "friend@example.com secret-provider-token";
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        if (mode === "thrown")
          emailMocks.sendBatch.mockRejectedValue(new Error(privateDetail));
        else
          emailMocks.sendBatch.mockResolvedValue(
            mode === "returned"
              ? { error: { message: privateDetail }, data: null }
              : undefined,
          );
        const result = await claimReferralFriendReward({
          storeId: "store_1",
          referralCode: "alice-1234",
          friendEmail: "friend@example.com",
          now: new Date("2026-08-31T00:00:00.000Z"),
        });
        expect(result).toMatchObject({ status: "claimed", emailSent: false });
        expect(state.referral.friendEmailLastError).toBe(
          "Referral email delivery failed",
        );
        expect(log).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain(privateDetail);
      } finally {
        log.mockRestore();
      }
    },
  );

  it.each(["returned", "thrown"])(
    "sanitizes %s callback errors at the lease persistence boundary",
    async (mode) => {
      state.referral = {
        id: "referral_email_lease",
        storeId: "store_1",
        friendRewardEmailedAt: null,
        friendEmailLeaseToken: null,
        friendEmailLeaseExpiresAt: new Date(0),
        friendEmailDeliveryAttempts: 0,
      };
      await deliverReferralEmailUnderLease({
        referralId: state.referral.id,
        storeId: "store_1",
        deliver: async () => {
          if (mode === "thrown")
            throw new Error("friend@example.com secret-provider-token");
          return {
            success: false,
            error: "friend@example.com secret-provider-token",
          };
        },
      });
      expect(state.referral.friendEmailLastError).toBe(
        "Referral email delivery failed",
      );
      expect(state.referral.friendEmailLeaseToken).toBeNull();
      expect(state.referral.friendRewardEmailedAt).toBeNull();
    },
  );

  it("issues a one-time Shopify voucher without storing raw friend email", async () => {
    const result = await claimReferralFriendReward({
      storeId: "store_1",
      referralCode: "alice-1234",
      friendEmail: " Friend@Example.com ",
      clientIp: "203.0.113.10",
      userAgent: "Test Browser",
      now: new Date("2026-08-31T00:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "claimed",
      emailSent: true,
      applyUrl: expect.stringContaining("/discount/WLF-"),
    });
    expect(state.referral.friendEmailDigest).toMatch(
      /^hmac:v1:[A-Za-z0-9._-]+:[A-F0-9]{64}$/,
    );
    expect(
      JSON.stringify(state.referral, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain("friend@example.com");
    expect(provisionLoyaltyRewardDiscount).toHaveBeenCalledWith(
      expect.objectContaining({
        shopifyCustomerId: null,
        rewardDefinition: expect.objectContaining({
          salesChannel: "online_store",
          usageLimit: 1,
          usageLimitPerCustomer: 1,
        }),
      }),
    );
    expect(
      state.referral.metadata.friendRewardSnapshot.rewardDefinition
        .salesChannel,
    ).toBe("online_store");
    expect(sendBatchEmail).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "legacy channel-less", salesChannel: undefined },
    { label: "POS-only", salesChannel: "pos" },
  ])(
    "fails closed without releasing a $label reservation when its retry has no remote voucher",
    async ({ salesChannel }) => {
      const claim = {
        storeId: "store_1",
        referralCode: "ALICE-1234",
        friendEmail: "friend@example.com",
        clientIp: "203.0.113.20",
      };
      await claimReferralFriendReward(claim);

      const snapshot = state.referral.metadata.friendRewardSnapshot;
      const {
        salesChannel: _persistedSalesChannel,
        ...legacyRewardDefinition
      } = snapshot.rewardDefinition;
      state.referral = {
        ...state.referral,
        friendRewardProvisionedAt: null,
        friendRewardEmailedAt: null,
        friendShopifyDiscountId: null,
        metadata: {
          ...state.referral.metadata,
          friendRewardSnapshot: {
            ...snapshot,
            rewardDefinition:
              salesChannel === undefined
                ? legacyRewardDefinition
                : { ...legacyRewardDefinition, salesChannel },
          },
        },
      };
      discountMocks.provision.mockClear();
      discountMocks.lookup.mockClear();
      discountMocks.deactivate.mockClear();
      emailMocks.sendBatch.mockClear();

      await expect(claimReferralFriendReward(claim)).rejects.toThrow(
        "Friend reward snapshot is not authorized for online-store provisioning.",
      );

      expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
      expect(discountMocks.lookup).toHaveBeenCalledWith(
        "yamax.myshopify.com",
        "test-token",
        state.referral.friendShopifyDiscountCode,
      );
      expect(discountMocks.deactivate).not.toHaveBeenCalled();
      expect(sendBatchEmail).not.toHaveBeenCalled();
      expect(state.referral).toMatchObject({
        status: WeleticLoyaltyReferralStatus.pending,
        friendRewardProvisionedAt: null,
        friendRewardEmailedAt: null,
      });
      expect(state.referral.friendEmailDigest).not.toBeNull();
      expect(state.referral.friendShopifyDiscountCode).not.toBeNull();
    },
  );

  it("resumes channel-less crash-window cleanup without adopting or emailing the voucher", async () => {
    const claim = {
      storeId: "store_1",
      referralCode: "ALICE-1234",
      friendEmail: "friend@example.com",
      clientIp: "203.0.113.21",
    };
    await claimReferralFriendReward(claim);

    const snapshot = state.referral.metadata.friendRewardSnapshot;
    const { salesChannel: _persistedSalesChannel, ...legacyRewardDefinition } =
      snapshot.rewardDefinition;
    const discountCode = state.referral.friendShopifyDiscountCode;
    state.referral = {
      ...state.referral,
      friendRewardProvisionedAt: null,
      friendRewardEmailedAt: null,
      friendShopifyDiscountId: null,
      metadata: {
        ...state.referral.metadata,
        friendRewardSnapshot: {
          ...snapshot,
          rewardDefinition: legacyRewardDefinition,
        },
      },
    };
    discountMocks.provision.mockClear();
    discountMocks.lookup.mockReset().mockResolvedValueOnce({
      id: "gid://shopify/DiscountCodeNode/legacy-orphan",
      code: discountCode,
      title: "Friend reward",
      status: "ACTIVE",
    });
    discountMocks.deactivate.mockReset().mockImplementationOnce(async () => {
      expect(state.inTransaction).toBe(false);
      expect(state.referral).toMatchObject({
        status: WeleticLoyaltyReferralStatus.cancelled,
        friendShopifyDiscountId: "gid://shopify/DiscountCodeNode/legacy-orphan",
        friendRewardProvisionedAt: null,
      });
      return false;
    });
    emailMocks.sendBatch.mockClear();

    await expect(claimReferralFriendReward(claim)).rejects.toThrow(
      "Legacy friend reward voucher could not be deactivated.",
    );

    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    expect(discountMocks.lookup).toHaveBeenCalledWith(
      "yamax.myshopify.com",
      "test-token",
      discountCode,
    );
    expect(discountMocks.deactivate).toHaveBeenCalledWith(
      "yamax.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/legacy-orphan",
    );
    expect(sendBatchEmail).not.toHaveBeenCalled();
    expect(state.referral).toMatchObject({
      status: WeleticLoyaltyReferralStatus.cancelled,
      friendShopifyDiscountCode: discountCode,
      friendShopifyDiscountId: "gid://shopify/DiscountCodeNode/legacy-orphan",
      friendRewardProvisionedAt: null,
      friendRewardEmailedAt: null,
    });
    expect(state.referral.friendEmailDigest).not.toBeNull();

    discountMocks.lookup.mockClear();
    discountMocks.graphql.mockClear();
    discountMocks.deactivate.mockImplementationOnce(async () => {
      expect(state.inTransaction).toBe(false);
      return true;
    });
    compliance.assertWrites
      .mockReset()
      .mockRejectedValue(new Error("Loyalty program is disabled"));

    await expect(claimReferralFriendReward(claim)).resolves.toEqual({
      status: "review",
    });

    expect(discountMocks.lookup).not.toHaveBeenCalled();
    expect(discountMocks.graphql).not.toHaveBeenCalled();
    expect(compliance.assertWrites).not.toHaveBeenCalled();
    expect(discountMocks.deactivate).toHaveBeenLastCalledWith(
      "yamax.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/legacy-orphan",
    );
    expect(discountMocks.deactivate).toHaveBeenCalledTimes(2);
    expect(sendBatchEmail).not.toHaveBeenCalled();
    expect(state.referral).toMatchObject({
      status: WeleticLoyaltyReferralStatus.cancelled,
      friendEmailDigest: null,
      friendShopifyDiscountCode: null,
      friendShopifyDiscountCodeCanonical: null,
      friendShopifyDiscountId: null,
      friendRewardDefinitionId: null,
      friendRewardProvisionedAt: null,
      friendRewardEmailedAt: null,
    });
  });

  it.each([
    { rewardType: "amount_off", discountValue: "1000" },
    { rewardType: "percentage_off", discountValue: "10" },
  ])(
    "fails closed for a POS-only $rewardType friend coupon",
    async ({ rewardType, discountValue }) => {
      vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValueOnce(
        {
          ...friendReward,
          rewardType,
          salesChannel: "pos",
          discountValue,
        } as any,
      );

      await expect(
        claimReferralFriendReward({
          storeId: "store_1",
          referralCode: "ALICE-1234",
          friendEmail: "friend@example.com",
          clientIp: "203.0.113.18",
        }),
      ).rejects.toThrow("configured friend reward is not provisionable");

      expect(prisma.weleticLoyaltyReferral.create).not.toHaveBeenCalled();
      expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
      expect(sendBatchEmail).not.toHaveBeenCalled();
      expect(state.referral).toBeNull();
    },
  );

  it("adopts the concurrently-created claim after a unique email race", async () => {
    vi.mocked(prisma.weleticLoyaltyReferral.create).mockImplementationOnce(
      (async ({ data }: any) => {
        state.referral = {
          ...data,
          friendRewardProvisionedAt: null,
          friendRewardEmailedAt: null,
          friendShopifyDiscountId: null,
          qualifyingOrderId: null,
          refereeShopperId: null,
          refereeAccountId: null,
          advocatePointsAwarded: BigInt(0),
          refereePointsAwarded: BigInt(0),
          rewardedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
      }) as any,
    );

    await expect(
      claimReferralFriendReward({
        storeId: "store_1",
        referralCode: "ALICE-1234",
        friendEmail: "friend@example.com",
        clientIp: "203.0.113.19",
      }),
    ).resolves.toMatchObject({ status: "claimed", emailSent: true });

    expect(provisionLoyaltyRewardDiscount).toHaveBeenCalledTimes(1);
    expect(sendBatchEmail).toHaveBeenCalledTimes(1);
  });

  it("fraud-blocks an email that already belongs to a Shopify customer", async () => {
    discountMocks.graphql.mockResolvedValueOnce({
      customers: {
        nodes: [
          {
            id: "gid://shopify/Customer/99",
            email: "friend@example.com",
            numberOfOrders: "0",
          },
        ],
      },
    });

    await expect(
      claimReferralFriendReward({
        storeId: "store_1",
        referralCode: "ALICE-1234",
        friendEmail: "friend@example.com",
        clientIp: "203.0.113.11",
      }),
    ).resolves.toEqual({ status: "review" });
    expect(state.referral.status).toBe(
      WeleticLoyaltyReferralStatus.fraud_blocked,
    );
    expect(state.referral.fraudSignals).toMatchObject({
      existingCustomer: true,
    });
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    expect(sendBatchEmail).not.toHaveBeenCalled();
  });

  it("never recreates a referral digest after customer privacy erasure", async () => {
    vi.mocked(
      prisma.weleticShopifyCustomerPrivacyTombstone.findFirst,
    ).mockResolvedValue({ id: "privacy_tombstone_1" } as any);

    await expect(
      claimReferralFriendReward({
        storeId: "store_1",
        referralCode: "ALICE-1234",
        friendEmail: "erased@example.com",
      }),
    ).rejects.toThrow("cannot participate in referrals");

    expect(prisma.weleticLoyaltyReferral.create).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("does not deliver a voucher when privacy erasure begins after provisioning", async () => {
    vi.mocked(
      prisma.weleticShopifyCustomerPrivacyTombstone.findFirst,
    ).mockReset();
    vi.mocked(prisma.weleticShopifyCustomerPrivacyTombstone.findFirst)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "privacy_tombstone_late" } as any);

    await expect(
      claimReferralFriendReward({
        storeId: "store_1",
        referralCode: "ALICE-1234",
        friendEmail: "friend@example.com",
      }),
    ).rejects.toThrow("cannot participate in referrals");

    expect(provisionLoyaltyRewardDiscount).toHaveBeenCalledTimes(1);
    expect(sendBatchEmail).not.toHaveBeenCalled();
  });

  it.each(["generation_1", null])(
    "qualifies the matching first paid order and rewards only the advocate (generation=%s)",
    async (generation) => {
      compliance.assertWrites.mockResolvedValue({
        id: "store_1",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
        installationGeneration: generation,
      });
      await claimReferralFriendReward({
        storeId: "store_1",
        referralCode: "ALICE-1234",
        friendEmail: "friend@example.com",
        clientIp: "203.0.113.12",
      });
      vi.mocked(prisma.weleticShopper.findFirst).mockResolvedValue({
        ordersCount: 1,
      } as any);

      const result = await evaluateReferralFriendClaimQualification({
        storeId: "store_1",
        orderId: "order_1",
        friendEmail: "friend@example.com",
        refereeShopperId: "shopper_friend",
        orderSubtotal: BigInt(5000),
        currency: "USD",
        customerOrderSequence: 1,
      });

      expect(result).toMatchObject({
        qualified: true,
        advocatePointsAwarded: BigInt(500),
        couponProvisioning: false,
      });
      expect(state.referral.status).toBe(WeleticLoyaltyReferralStatus.rewarded);
      expect(state.referral.refereePointsAwarded).toBe(BigInt(0));
      expect(
        readReferralPrivacySnapshot({
          value: state.referral.metadata.friendPrivacySnapshot,
          storeId: "store_1",
          referralId: state.referral.id,
          friendEmailDigest: state.referral.friendEmailDigest,
        }),
      ).toEqual([expect.objectContaining({ identityKind: "customer_email" })]);
      expect(JSON.stringify(state.referral.metadata)).not.toContain(
        "friend@example.com",
      );
      expect(
        vi
          .mocked(enqueueFlowTriggerJob)
          .mock.calls.filter(
            ([input]) => input.payload.handle === "weletic-referral-completed",
          ),
      ).toHaveLength(1);
      expect(enqueueFlowTriggerJob).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: "store_1",
          eventId: state.referral.id,
          payload: {
            handle: "weletic-referral-completed",
            referralId: state.referral.id,
            accountId: "account_advocate",
            orderId: "order_1",
            advocatePoints: "500",
            friendPoints: "0",
          },
        }),
      );
      expect(appendPointsLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "account_advocate",
          pointsDelta: BigInt(500),
        }),
      );
      expect(enqueueFlowTriggerJob).toHaveBeenCalledWith(
        expect.objectContaining({
          storeId: "store_1",
          payload: expect.objectContaining({
            accountId: "account_advocate",
            handle: "weletic-points-earned",
            pointsDelta: "500",
            reason: "referral_friend_reward",
          }),
        }),
      );
      expect(enqueueOutboxJob).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: "METAFIELD_SYNC",
        }),
      );
    },
  );

  it("does not qualify a different checkout email", async () => {
    await claimReferralFriendReward({
      storeId: "store_1",
      referralCode: "ALICE-1234",
      friendEmail: "friend@example.com",
      clientIp: "203.0.113.13",
    });

    await expect(
      evaluateReferralFriendClaimQualification({
        storeId: "store_1",
        orderId: "order_wrong_email",
        friendEmail: "someone-else@example.com",
        orderSubtotal: BigInt(5000),
        currency: "USD",
      }),
    ).resolves.toMatchObject({ qualified: false });
    expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("blocks a claim observed on a returning customer's order", async () => {
    await claimReferralFriendReward({
      storeId: "store_1",
      referralCode: "ALICE-1234",
      friendEmail: "friend@example.com",
      clientIp: "203.0.113.14",
    });

    const result = await evaluateReferralFriendClaimQualification({
      storeId: "store_1",
      orderId: "order_2",
      friendEmail: "friend@example.com",
      orderSubtotal: BigInt(5000),
      currency: "USD",
      customerOrderSequence: 2,
    });

    expect(result).toEqual({ qualified: false, reason: "Not first order" });
    expect(state.referral.status).toBe(
      WeleticLoyaltyReferralStatus.fraud_blocked,
    );
    expect(state.referral.fraudSignals).toMatchObject({
      nonFirstOrder: true,
      observedOrdersCount: 2,
    });
    expect(appendPointsLedgerEntry).not.toHaveBeenCalled();
  });

  it("queries Shopify using the exact canonicalized email", async () => {
    await claimReferralFriendReward({
      storeId: "store_1",
      referralCode: "ALICE-1234",
      friendEmail: " FRIEND@EXAMPLE.COM ",
      clientIp: "203.0.113.15",
    });

    expect(shopifyAdminGraphqlRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        variables: { query: 'email:"friend@example.com"' },
      }),
    );
  });

  it("deactivates the voucher before erasing the friend digest", async () => {
    await claimReferralFriendReward({
      storeId: "store_1",
      referralCode: "ALICE-1234",
      friendEmail: "friend@example.com",
      clientIp: "203.0.113.16",
    });
    state.referral.metadata.friendPrivacySnapshot =
      createReferralPrivacySnapshot({
        storeId: "store_1",
        referralId: state.referral.id,
        friendEmailDigest: state.referral.friendEmailDigest,
        email: "friend@example.com",
      });
    discountMocks.deactivate.mockResolvedValueOnce(true);

    await expect(
      redactReferralFriendClaimsForEmail({
        storeId: "store_1",
        email: "friend@example.com",
        redactedAt: new Date("2026-08-31T12:00:00.000Z"),
      }),
    ).resolves.toBe(1);

    expect(discountMocks.deactivate).toHaveBeenCalledWith(
      "yamax.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/friend-1",
    );
    expect(state.referral.friendEmailDigest).toBeNull();
    expect(state.referral.metadata).not.toHaveProperty("friendPrivacySnapshot");
    expect(state.referral.ipHash).toBeNull();
    expect(state.referral.status).toBe(WeleticLoyaltyReferralStatus.cancelled);
  });

  it("preserves privacy identity when a newer voucher appears during redaction", async () => {
    await claimReferralFriendReward({
      storeId: "store_1",
      referralCode: "ALICE-1234",
      friendEmail: "friend@example.com",
      clientIp: "203.0.113.19",
    });
    const friendEmailDigest = state.referral.friendEmailDigest;
    discountMocks.deactivate.mockImplementationOnce(async () => {
      state.referral = {
        ...state.referral,
        friendShopifyDiscountId:
          "gid://shopify/DiscountCodeNode/newer-friend-voucher",
      };
      return true;
    });

    await expect(
      redactReferralFriendClaimsForEmail({
        storeId: "store_1",
        email: "friend@example.com",
        redactedAt: new Date("2026-08-31T12:30:00.000Z"),
      }),
    ).rejects.toThrow("acquired a newer voucher during privacy redaction");

    expect(state.referral).toMatchObject({
      friendEmailDigest,
      friendShopifyDiscountId:
        "gid://shopify/DiscountCodeNode/newer-friend-voucher",
    });
  });

  it("marks cancellation only while the exact unsanitized voucher identity still exists", async () => {
    state.referral = {
      id: "wreferral_cancelled_friend",
      storeId: "store_1",
      advocateAccountId: "account_advocate",
      status: WeleticLoyaltyReferralStatus.cancelled,
      friendShopifyDiscountId:
        "gid://shopify/DiscountCodeNode/friend-cancelled",
      metadata: { claimKind: "anonymous_email" },
    };
    discountMocks.deactivate.mockResolvedValueOnce(true);

    await expect(
      deactivateCancelledReferralFriendReward({
        storeId: "store_1",
        referralId: state.referral.id,
      }),
    ).resolves.toBe(true);

    expect(discountMocks.deactivate).toHaveBeenCalledWith(
      "yamax.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/friend-cancelled",
    );
    expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "wreferral_cancelled_friend",
          status: WeleticLoyaltyReferralStatus.cancelled,
          friendShopifyDiscountId:
            "gid://shopify/DiscountCodeNode/friend-cancelled",
        }),
      }),
    );
  });

  it("rolls back a remote voucher when local adoption becomes blocked", async () => {
    compliance.assertWrites
      .mockResolvedValueOnce({
        id: "store_1",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      })
      .mockResolvedValueOnce({
        id: "store_1",
        shopCurrency: "USD",
        currencyVerifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      })
      .mockRejectedValueOnce(new Error("Loyalty program is disabled"));
    discountMocks.deactivate.mockResolvedValueOnce(true);

    await expect(
      claimReferralFriendReward({
        storeId: "store_1",
        referralCode: "ALICE-1234",
        friendEmail: "friend@example.com",
        clientIp: "203.0.113.17",
      }),
    ).rejects.toThrow("Loyalty program is disabled");

    expect(discountMocks.deactivate).toHaveBeenCalledWith(
      "yamax.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/friend-1",
    );
    expect(state.referral).toMatchObject({
      status: WeleticLoyaltyReferralStatus.cancelled,
      friendEmailDigest: null,
      friendShopifyDiscountCode: null,
      friendShopifyDiscountId: null,
    });
  });

  it("scrubs every anonymous friend voucher before shop erasure continues", async () => {
    await claimReferralFriendReward({
      storeId: "store_1",
      referralCode: "ALICE-1234",
      friendEmail: "friend@example.com",
      clientIp: "203.0.113.18",
    });
    state.referral.metadata.friendPrivacySnapshot =
      createReferralPrivacySnapshot({
        storeId: "store_1",
        referralId: state.referral.id,
        friendEmailDigest: state.referral.friendEmailDigest,
        email: "friend@example.com",
      });
    discountMocks.deactivate.mockResolvedValueOnce(true);

    await expect(
      redactReferralFriendClaimsForShopBatch({
        storeId: "store_1",
        batchSize: 20,
        redactedAt: new Date("2026-08-31T13:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ scrubbed: 1, hasMore: false });
    expect(state.referral.metadata).not.toHaveProperty("friendPrivacySnapshot");

    expect(discountMocks.deactivate).toHaveBeenCalledWith(
      "yamax.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/friend-1",
    );
    expect(state.referral).toMatchObject({
      friendEmailDigest: null,
      friendShopifyDiscountCode: null,
      friendShopifyDiscountId: null,
      ipHash: null,
      userAgentHash: null,
    });
  });
});
