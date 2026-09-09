import { prisma } from "@/lib/prisma";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import { createLoyaltyMaintenanceLeaseMetadata } from "@/lib/weletic/loyalty/maintenance-write-fence";
import {
  getReferralCouponDiscountCode,
  getReferralCouponIdempotencyKey,
  issueReferralRewardCoupon,
  recoverCompensatedReferralCouponDiscount,
} from "@/lib/weletic/loyalty/referral-coupon";
import {
  createReferralCouponRewardSnapshot,
  getReferralCouponRewardSnapshotContentDigest,
} from "@/lib/weletic/loyalty/referral-coupon-snapshot";
import {
  deactivateDiscount,
  lookupDiscountByCode,
  provisionLoyaltyRewardDiscount,
  resolveShopifyOfflineCredentials,
} from "@/lib/weletic/loyalty/shopify-discounts";
import {
  WeleticLoyaltyReferralStatus,
  WeleticRedemptionStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    weleticRewardRedemption: {
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    weleticLoyaltyReferral: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
    weleticLoyaltyAccount: { findFirst: vi.fn() },
    weleticRewardDefinition: { findFirst: vi.fn() },
    weleticShopifyStore: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (callback) => callback(prisma)),
  },
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/weletic/loyalty/shopify-discounts")
  >()),
  deactivateDiscount: vi.fn(),
  lookupDiscountByCode: vi.fn(),
  provisionLoyaltyRewardDiscount: vi.fn(),
  resolveShopifyOfflineCredentials: vi.fn(),
}));

const storeId = "store_coupon";
vi.mock("@/lib/weletic/loyalty/flow-trigger-outbox", () => ({
  enqueueFlowTriggerJob: vi.fn().mockResolvedValue({ created: true }),
}));
const referralId = "wreferral_coupon";
const qualificationOrderId = "worder_coupon";
const accountId = "wacc_coupon";
const rewardDefinitionId = "wreward_coupon";

function remoteConfigurationForSnapshot(
  snapshot: ReturnType<typeof createReferralCouponRewardSnapshot>,
  shopifyCustomerId = "123",
) {
  const asUsd = (minorUnits: string | null) =>
    minorUnits === null ? null : (Number(minorUnits) / 100).toFixed(2);
  return {
    kind: "basic" as const,
    startsAt: snapshot.startsAt,
    endsAt: snapshot.expiresAt,
    usageLimit: snapshot.usageLimit || 1,
    appliesOncePerCustomer: snapshot.usageLimitPerCustomer === 1,
    appliesOnOneTimePurchase: true,
    appliesOnSubscription: false,
    recurringCycleLimit: 1,
    combinesWith: {
      orderDiscounts: snapshot.combinesWithOrderDiscounts,
      productDiscounts: snapshot.combinesWithProductDiscounts,
      shippingDiscounts: snapshot.combinesWithShippingDiscounts,
    },
    customerSelection: {
      kind: "customers" as const,
      customerIds: [`gid://shopify/Customer/${shopifyCustomerId}`],
    },
    minimumRequirement:
      snapshot.minOrderAmount && Number(snapshot.minOrderAmount) > 0
        ? {
            kind: "subtotal" as const,
            amount: asUsd(snapshot.minOrderAmount)!,
            currencyCode: snapshot.shopCurrency,
          }
        : null,
    basicValue: {
      kind: "amount" as const,
      amount: asUsd(snapshot.discountValue)!,
      currencyCode: snapshot.shopCurrency,
      appliesOnEachItem: false,
    },
    basicItems: { kind: "all" as const },
  };
}

function createTestReferralCouponSnapshot({
  qualifiedAt = new Date("2026-08-29T00:00:00.000Z"),
  shopifyCustomerId = "123",
}: {
  qualifiedAt?: Date;
  shopifyCustomerId?: string;
} = {}) {
  return createReferralCouponRewardSnapshot({
    identity: {
      storeId,
      referralId,
      qualificationOrderId,
      accountId,
      rewardDefinitionId,
      side: "advocate",
    },
    reward: {
      id: rewardDefinitionId,
      name: "$10 referral reward",
      description: null,
      rewardType: "amount_off",
      salesChannel: "online_store",
      discountValue: 1000,
      maxDiscountValue: null,
      minOrderAmount: null,
      appliesToResource: "entire_order",
      entitledCollectionIds: ["gid://shopify/Collection/stale"],
      entitledProductIds: ["gid://shopify/Product/stale"],
      entitledVariantIds: ["gid://shopify/ProductVariant/stale"],
      combinesWithProductDiscounts: false,
      combinesWithOrderDiscounts: false,
      combinesWithShippingDiscounts: false,
      usageLimit: 1,
      usageLimitPerCustomer: 1,
      expiresInDays: 30,
    },
    qualifiedAt,
    shopCurrency: "USD",
    currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
    shopifyCustomerId,
  });
}

function createLegacyReferralCouponSnapshotWithoutSalesChannel() {
  const snapshot = createTestReferralCouponSnapshot();
  const {
    salesChannel: _salesChannel,
    contentDigest: _contentDigest,
    ...legacyContent
  } = snapshot;
  return {
    ...legacyContent,
    contentDigest: getReferralCouponRewardSnapshotContentDigest(legacyContent),
  };
}

function immutableReferralCouponMetadata(
  snapshot: ReturnType<typeof createTestReferralCouponSnapshot>,
  extra: Record<string, unknown> = {},
) {
  return {
    referralId,
    qualificationOrderId,
    referralSide: "advocate",
    rewardSnapshot: snapshot,
    shopifyDiscountOwnershipFingerprint: snapshot.ownershipFingerprint,
    shopifyDiscountProvisioningName: snapshot.provisioningName,
    shopifyDiscountExpectedTitle: snapshot.expectedTitle,
    ...extra,
  };
}

function referralCouponMetadata(extra: Record<string, unknown> = {}) {
  return {
    referralId,
    qualificationOrderId,
    referralSide: "advocate",
    rewardSnapshot: {
      name: "$10 referral reward",
      description: null,
      rewardType: "amount_off",
    },
    ...extra,
  };
}

function mockProvisioningDependencies() {
  vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValue({
    id: referralId,
    storeId,
    advocateAccountId: accountId,
    advocatePointsAwarded: BigInt(0),
    refereePointsAwarded: BigInt(0),
    refereeAccountId: "wacc_referee_coupon",
    status: WeleticLoyaltyReferralStatus.qualified,
    metadata: { requiredCouponSides: ["advocate"] },
  } as any);
  vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
    id: accountId,
    storeId,
    status: "active",
    shopper: { shopifyCustomerId: "123" },
  } as any);
  vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValue({
    id: rewardDefinitionId,
    storeId,
    status: "active",
    exchangeType: "fixed",
    name: "$10 referral reward",
    description: null,
    rewardType: "amount_off",
    discountValue: 1000,
    maxDiscountValue: null,
    minOrderAmount: null,
    appliesToResource: "entire_order",
    entitledCollectionIds: [],
    entitledProductIds: [],
    entitledVariantIds: [],
    combinesWithProductDiscounts: false,
    combinesWithOrderDiscounts: false,
    combinesWithShippingDiscounts: false,
    usageLimit: 1,
    usageLimitPerCustomer: 1,
    expiresInDays: 30,
  } as any);
  vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
    shopCurrency: "USD",
    currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
    complianceState: "active",
  } as any);
  vi.mocked(resolveShopifyOfflineCredentials).mockResolvedValue({
    shopDomain: "test.myshopify.com",
    accessToken: "test-token",
  } as any);
  vi.mocked(lookupDiscountByCode).mockResolvedValue(null);
  vi.mocked(provisionLoyaltyRewardDiscount).mockImplementation(
    async (params) =>
      ({
        id: "gid://shopify/DiscountCodeNode/1",
        code: params.discountCode,
        title: `${params.rewardDefinition.name} (${params.discountCode})`,
        status: "ACTIVE",
      }) as any,
  );
}

describe("referral coupon provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      {
        id: "wloyalty_program_coupon",
        storeId,
        status: "active",
        killSwitchActive: false,
      },
    ] as never);
    mockProvisioningDependencies();
    vi.mocked(prisma.weleticLoyaltyReferral.updateMany).mockResolvedValue({
      count: 1,
    });
  });

  it.each(["disabled", "pending_approval", "suspended"])(
    "rejects %s before reserving a referral coupon",
    async (state) => {
      vi.mocked(prisma.$queryRaw).mockImplementation((async (query: any) => {
        if (query.sql.includes("FROM WeleticShopifyStore"))
          return [
            {
              id: storeId,
              storeAccessState: state === "disabled" ? "active" : state,
            },
          ];
        return [
          {
            id: "wloyalty_program_coupon",
            storeId,
            status: state === "disabled" ? "disabled" : "active",
            killSwitchActive: false,
          },
        ];
      }) as any);

      await expect(
        issueReferralRewardCoupon({
          storeId,
          referralId,
          qualificationOrderId,
          accountId,
          rewardDefinitionId,
          side: "advocate",
        }),
      ).rejects.toThrow("Loyalty program is currently disabled or inactive");

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      const [programLockStatement] = vi.mocked(prisma.$queryRaw).mock.calls[1];
      const programLockSql = (
        programLockStatement as { strings: readonly string[] }
      ).strings.join(" ");
      expect(programLockSql).toContain("FROM WeleticLoyaltyProgram");
      expect(programLockSql).toContain("FOR UPDATE");
      expect(prisma.weleticRewardRedemption.create).not.toHaveBeenCalled();
      expect(lookupDiscountByCode).not.toHaveBeenCalled();
      expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    },
  );

  it("re-locks and rejects a program disabled before remote provisioning", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    let redemption = {
      id: "wredemp_disabled_before_remote",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.provisioning,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountId: null,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot),
    } as any;
    (prisma.weleticRewardRedemption.findUnique as any).mockImplementation(
      async () => redemption,
    );
    (prisma.weleticRewardRedemption.updateMany as any).mockImplementation(
      async ({ data }: any) => {
        redemption = { ...redemption, ...data };
        return { count: 1 };
      },
    );
    let programReads = 0;
    vi.mocked(prisma.$queryRaw).mockImplementation((async (query: any) => {
      if (query.sql.includes("FROM WeleticShopifyStore"))
        return [{ id: storeId, storeAccessState: "active" }];
      programReads += 1;
      return [
        {
          id: "wloyalty_program_coupon",
          storeId,
          status: programReads >= 3 ? "disabled" : "active",
          killSwitchActive: false,
        },
      ];
    }) as any);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).rejects.toThrow("Loyalty program is currently disabled or inactive");

    expect(programReads).toBe(4);
    expect(lookupDiscountByCode).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    expect(redemption.metadata).not.toHaveProperty(
      "remoteProvisionAttemptedAt",
    );
    expect(redemption.metadata).not.toHaveProperty(
      "remoteProvisionPreparationId",
    );
  });

  it("defers for maintenance before the remote call without rewriting ambiguity metadata", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    const maintenanceMetadata = createLoyaltyMaintenanceLeaseMetadata({
      existingMetadata: null,
      ownerToken: "m".repeat(64),
      runMarker: "referral-coupon-metadata-deferral",
      fixtureEmails: ["referral-maintenance@example.test"],
      acquiredAt: new Date("2026-08-30T00:00:00.000Z"),
      recoveryAfter: new Date("2026-08-30T01:00:00.000Z"),
    });
    let redemption = {
      id: "wredemp_maintenance_before_remote",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.provisioning,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountCodeCanonical: snapshot.discountCode,
      shopifyDiscountId: null,
      settlementQuarantinedAt: null,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot),
    } as any;
    const persistedMetadataWrites: string[] = [];
    (prisma.weleticRewardRedemption.findUnique as any).mockImplementation(
      async () => redemption,
    );
    (prisma.weleticRewardRedemption.updateMany as any).mockImplementation(
      async ({ data }: any) => {
        if (data.metadata !== undefined) {
          persistedMetadataWrites.push(JSON.stringify(data.metadata));
        }
        redemption = { ...redemption, ...data };
        return { count: 1 };
      },
    );
    let programReads = 0;
    vi.mocked(prisma.$queryRaw).mockImplementation((async (query: any) => {
      if (query.sql.includes("FROM WeleticShopifyStore"))
        return [{ id: storeId, storeAccessState: "active" }];
      programReads += 1;
      return [
        {
          id: "wloyalty_program_coupon",
          storeId,
          status: "active",
          killSwitchActive: false,
          metadata: programReads >= 3 ? maintenanceMetadata : null,
        },
      ];
    }) as any);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).rejects.toThrow(
      "Loyalty operational writes are blocked by a maintenance lease",
    );

    expect(programReads).toBe(3);
    expect(lookupDiscountByCode).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    expect(persistedMetadataWrites).toHaveLength(1);
    expect(JSON.stringify(redemption.metadata)).toBe(
      persistedMetadataWrites[0],
    );
    expect(redemption.metadata).toMatchObject({
      remoteProvisionAttemptedAt: expect.any(String),
      remoteProvisionPreparationId: expect.any(String),
    });
  });

  it("allows compensated remote cleanup while the program is disabled", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_disabled_recovery",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.cancelled,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountCodeCanonical: snapshot.discountCode,
      shopifyDiscountId: "gid://shopify/DiscountCodeNode/disabled",
      settlementQuarantinedAt: null,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot),
    } as any);
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([
      {
        id: "wloyalty_program_coupon",
        storeId,
        status: "active",
        killSwitchActive: true,
      },
    ] as never);
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: "gid://shopify/DiscountCodeNode/disabled",
      code: snapshot.discountCode,
      title: snapshot.expectedTitle,
      status: "ACTIVE",
    });
    vi.mocked(deactivateDiscount).mockResolvedValue(true);

    await expect(
      recoverCompensatedReferralCouponDiscount({
        storeId,
        redemption: {
          id: "wredemp_disabled_recovery",
          storeId,
          accountId,
          rewardDefinitionId,
          status: WeleticRedemptionStatus.cancelled,
          shopifyDiscountCode: snapshot.discountCode,
          shopifyDiscountId: "gid://shopify/DiscountCodeNode/disabled",
          expiresAt: new Date(snapshot.expiresAt!),
          metadata: immutableReferralCouponMetadata(snapshot),
        },
      }),
    ).resolves.toBe(true);

    expect(lookupDiscountByCode).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      snapshot.discountCode,
    );
    expect(deactivateDiscount).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/disabled",
    );
  });

  it("deactivates a provisioning orphan instead of adopting it after the program is disabled", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    const provisioning = {
      id: "wredemp_disabled_orphan",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.provisioning,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountId: null,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot, {
        remoteProvisionAttemptedAt: "2026-08-29T00:00:00.000Z",
        remoteProvisionReconcileUntil: "2026-08-29T00:02:00.000Z",
      }),
    } as any;
    const cancelled = {
      ...provisioning,
      status: WeleticRedemptionStatus.cancelled,
      shopifyDiscountId:
        "gid://shopify/DiscountCodeNode/disabled-provisioning-orphan",
    } as any;
    vi.mocked(prisma.weleticRewardRedemption.findUnique)
      .mockResolvedValueOnce(provisioning)
      .mockResolvedValueOnce(provisioning)
      .mockResolvedValueOnce(cancelled);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      {
        id: "wloyalty_program_coupon",
        storeId,
        status: "disabled",
        killSwitchActive: true,
      },
    ] as never);
    vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: "gid://shopify/DiscountCodeNode/disabled-provisioning-orphan",
      code: snapshot.discountCode,
      title: snapshot.expectedTitle,
      status: "ACTIVE",
    });
    vi.mocked(deactivateDiscount).mockResolvedValue(true);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).resolves.toMatchObject({
      id: provisioning.id,
      status: WeleticRedemptionStatus.cancelled,
    });

    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: provisioning.id,
          storeId,
          status: WeleticRedemptionStatus.provisioning,
        }),
        data: expect.objectContaining({
          status: WeleticRedemptionStatus.cancelled,
          shopifyDiscountId:
            "gid://shopify/DiscountCodeNode/disabled-provisioning-orphan",
          compensationReason:
            "Loyalty program was disabled before referral coupon issuance.",
        }),
      }),
    );
    expect(deactivateDiscount).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/disabled-provisioning-orphan",
    );
  });

  it("cancels an active legacy channel-less reservation before any Shopify effect", async () => {
    const snapshot = createLegacyReferralCouponSnapshotWithoutSalesChannel();
    let redemption = {
      id: "wredemp_legacy_channel_less",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.provisioning,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountId: null,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot),
    } as any;
    (prisma.weleticRewardRedemption.findUnique as any).mockImplementation(
      async () => redemption,
    );
    (prisma.weleticRewardRedemption.updateMany as any).mockImplementation(
      async ({ data }: any) => {
        redemption = { ...redemption, ...data };
        return { count: 1 };
      },
    );

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).resolves.toMatchObject({
      id: redemption.id,
      status: WeleticRedemptionStatus.cancelled,
    });

    expect(lookupDiscountByCode).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    expect(deactivateDiscount).not.toHaveBeenCalled();
    expect(redemption).toMatchObject({
      status: WeleticRedemptionStatus.cancelled,
      compensationReason:
        "Referral coupon snapshot is not authorized for online-store provisioning.",
      metadata: expect.objectContaining({
        cancellationReason: "sales_channel_not_online_store",
      }),
    });
  });

  it("reconciles and deactivates an owned remote coupon for a legacy channel-less reservation", async () => {
    const snapshot = createLegacyReferralCouponSnapshotWithoutSalesChannel();
    const remoteDiscountId =
      "gid://shopify/DiscountCodeNode/legacy-channel-less";
    let redemption = {
      id: "wredemp_legacy_channel_less_orphan",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.provisioning,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountId: null,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot, {
        remoteProvisionAttemptedAt: "2026-08-29T00:00:00.000Z",
        remoteProvisionReconcileUntil: "2026-08-29T00:02:00.000Z",
      }),
    } as any;
    (prisma.weleticRewardRedemption.findUnique as any).mockImplementation(
      async () => redemption,
    );
    (prisma.weleticRewardRedemption.updateMany as any).mockImplementation(
      async ({ data }: any) => {
        redemption = { ...redemption, ...data };
        return { count: 1 };
      },
    );
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: remoteDiscountId,
      code: snapshot.discountCode,
      title: snapshot.expectedTitle,
      status: "ACTIVE",
    });
    vi.mocked(deactivateDiscount).mockResolvedValue(true);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).resolves.toMatchObject({
      id: redemption.id,
      status: WeleticRedemptionStatus.cancelled,
      shopifyDiscountId: remoteDiscountId,
    });

    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    expect(deactivateDiscount).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      remoteDiscountId,
    );
    expect(redemption.metadata).toMatchObject({
      cancellationReason: "sales_channel_not_online_store",
    });
  });

  it("completes idempotent referral bookkeeping after issuance even when the program is disabled", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    const issuedRedemption = {
      id: "wredemp_issued_before_disable",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.issued,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountId: "gid://shopify/DiscountCodeNode/already-issued",
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot),
    } as any;
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
      issuedRedemption,
    );
    vi.mocked(prisma.weleticRewardRedemption.count).mockResolvedValue(1);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      {
        id: "wloyalty_program_coupon",
        storeId,
        status: "disabled",
        killSwitchActive: true,
      },
    ] as never);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).resolves.toBe(issuedRedemption);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
    expect(enqueueFlowTriggerJob).toHaveBeenCalledWith({
      storeId,
      eventId: referralId,
      payload: {
        handle: "weletic-referral-completed",
        accountId,
        referralId,
        orderId: qualificationOrderId,
        advocatePoints: "0",
        friendPoints: "0",
      },
      loyaltyMaintenancePermit: undefined,
      tx: prisma,
    });
    expect(prisma.weleticRewardRedemption.create).not.toHaveBeenCalled();
    expect(lookupDiscountByCode).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: referralId,
          storeId,
          status: WeleticLoyaltyReferralStatus.qualified,
        }),
        data: expect.objectContaining({
          status: WeleticLoyaltyReferralStatus.rewarded,
        }),
      }),
    );
  });

  it("issues an idempotent zero-point coupon and completes the referral", async () => {
    const authoritativeSnapshot = createTestReferralCouponSnapshot();
    vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValue({
      id: referralId,
      storeId,
      advocateAccountId: accountId,
      advocatePointsAwarded: BigInt(0),
      refereePointsAwarded: BigInt(0),
      refereeAccountId: "wacc_referee_coupon",
      status: WeleticLoyaltyReferralStatus.qualified,
      metadata: {
        requiredCouponSides: ["advocate"],
        referralCouponRewardSnapshots: {
          advocate: authoritativeSnapshot,
        },
      },
    } as any);
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
      null,
    );
    (prisma.weleticRewardRedemption.create as any).mockImplementation(
      async ({ data }: any) => {
        const created = {
          ...data,
          status: WeleticRedemptionStatus.provisioning,
        };
        vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
          created,
        );
        return created;
      },
    );
    vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(prisma.weleticRewardRedemption.count).mockResolvedValue(1);

    await issueReferralRewardCoupon({
      storeId,
      referralId,
      qualificationOrderId,
      accountId,
      rewardDefinitionId,
      side: "advocate",
    });

    expect(prisma.weleticRewardRedemption.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storeId,
          accountId,
          pointsSpent: BigInt(0),
          status: WeleticRedemptionStatus.provisioning,
        }),
      }),
    );
    const createdRedemption = vi.mocked(prisma.weleticRewardRedemption.create)
      .mock.calls[0][0].data as any;
    expect(createdRedemption.shopifyDiscountCode).toMatch(/^WLR-[A-F0-9]{24}$/);
    expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storeId,
          status: WeleticRedemptionStatus.provisioning,
        }),
        data: expect.objectContaining({
          status: WeleticRedemptionStatus.issued,
        }),
      }),
    );
    const remoteAttemptMarkerCall = vi
      .mocked(prisma.weleticRewardRedemption.updateMany)
      .mock.calls.find(
        ([args]) =>
          typeof (args.data as any)?.metadata?.remoteProvisionAttemptedAt ===
          "string",
      );
    expect(remoteAttemptMarkerCall).toBeDefined();
    expect(
      (remoteAttemptMarkerCall?.[0].data as any).metadata
        .remoteProvisionReconcileUntil,
    ).toEqual(expect.any(String));
    expect(
      vi.mocked(prisma.weleticRewardRedemption.updateMany).mock
        .invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(lookupDiscountByCode).mock.invocationCallOrder[0]);
    expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WeleticLoyaltyReferralStatus.rewarded,
        }),
      }),
    );
  });

  it.each(["coupon_pending", "lost_completion_claim"] as const)(
    "does not emit completion for %s",
    async (scenario) => {
      const snapshot = createTestReferralCouponSnapshot();
      vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
        id: "wredemp_completion_guard",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.issued,
        shopifyDiscountCode: snapshot.discountCode,
        shopifyDiscountId: "gid://shopify/DiscountCodeNode/already-issued",
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot),
      } as any);
      vi.mocked(prisma.weleticRewardRedemption.count).mockResolvedValue(
        scenario === "coupon_pending" ? 0 : 1,
      );
      vi.mocked(prisma.weleticLoyaltyReferral.updateMany).mockResolvedValue({
        count: 0,
      });
      await issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      });
      expect(enqueueFlowTriggerJob).not.toHaveBeenCalled();
      expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
      if (scenario === "coupon_pending") {
        expect(prisma.weleticLoyaltyReferral.updateMany).not.toHaveBeenCalled();
      } else {
        expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              id: referralId,
              storeId,
              qualifyingOrderId: qualificationOrderId,
              status: WeleticLoyaltyReferralStatus.qualified,
            }),
          }),
        );
      }
    },
  );

  it("snapshots the immutable Shopify context and clears stale entire-order entitlements", () => {
    const snapshot = createTestReferralCouponSnapshot();
    const otherCustomerSnapshot = createTestReferralCouponSnapshot({
      shopifyCustomerId: "456",
    });

    expect(snapshot).toMatchObject({
      shopCurrency: "USD",
      startsAt: "2026-08-29T00:00:00.000Z",
      qualifiedAt: "2026-08-29T00:00:00.000Z",
      appliesToResource: "entire_order",
      entitledCollectionIds: [],
      entitledProductIds: [],
      entitledVariantIds: [],
    });
    expect(snapshot.customerSelectionDigest).toMatch(
      /^hmac:v1:[A-Za-z0-9._-]+:[A-F0-9]{64}$/,
    );
    expect(otherCustomerSnapshot.customerSelectionDigest).not.toBe(
      snapshot.customerSelectionDigest,
    );
  });

  it("fails closed before creating a redemption when qualification has no immutable snapshot", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
      null,
    );

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).rejects.toThrow("has no immutable Shopify provisioning snapshot");

    expect(prisma.weleticRewardRedemption.create).not.toHaveBeenCalled();
    expect(lookupDiscountByCode).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("fails closed before lookup or create when a provisioning redemption has no immutable snapshot", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_legacy_snapshot_null",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.provisioning,
      shopifyDiscountCode: "WLR-LEGACY",
      shopifyDiscountId: null,
      expiresAt: null,
      metadata: referralCouponMetadata(),
    } as any);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).rejects.toThrow("cannot provision without an immutable Shopify snapshot");

    expect(prisma.weleticRewardRedemption.updateMany).not.toHaveBeenCalled();
    expect(lookupDiscountByCode).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("provisions the immutable qualification snapshot after the live reward is deleted", async () => {
    const originalReward = {
      id: rewardDefinitionId,
      storeId,
      name: "Original referral reward",
      description: "Original terms",
      rewardType: "amount_off",
      salesChannel: "online_store",
      discountValue: 1000,
      maxDiscountValue: 2500,
      minOrderAmount: 5000,
      appliesToResource: "entire_order",
      entitledCollectionIds: ["gid://shopify/Collection/1"],
      entitledProductIds: ["gid://shopify/Product/1"],
      entitledVariantIds: ["gid://shopify/ProductVariant/1"],
      combinesWithProductDiscounts: true,
      combinesWithOrderDiscounts: false,
      combinesWithShippingDiscounts: true,
      usageLimit: 2,
      usageLimitPerCustomer: 1,
      expiresInDays: 30,
    };
    const rewardSnapshot = createReferralCouponRewardSnapshot({
      identity: {
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      },
      reward: originalReward,
      qualifiedAt: new Date("2026-08-29T00:00:00.000Z"),
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
      shopifyCustomerId: "123",
    });
    vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValue({
      id: referralId,
      storeId,
      advocateAccountId: accountId,
      advocatePointsAwarded: BigInt(0),
      refereePointsAwarded: BigInt(0),
      refereeAccountId: "wacc_referee_coupon",
      status: WeleticLoyaltyReferralStatus.qualified,
      metadata: {
        requiredCouponSides: ["advocate"],
        referralCouponRewardSnapshots: { advocate: rewardSnapshot },
      },
    } as any);
    vi.mocked(prisma.weleticRewardDefinition.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
      null,
    );
    (prisma.weleticRewardRedemption.create as any).mockImplementation(
      async ({ data }: any) => {
        const created = {
          ...data,
          status: WeleticRedemptionStatus.provisioning,
        };
        vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
          created,
        );
        return created;
      },
    );
    vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(prisma.weleticRewardRedemption.count).mockResolvedValue(1);

    await issueReferralRewardCoupon({
      storeId,
      referralId,
      qualificationOrderId,
      accountId,
      rewardDefinitionId,
      side: "advocate",
      rewardSnapshot,
    });

    expect(prisma.weleticRewardDefinition.findFirst).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).toHaveBeenCalledWith(
      expect.objectContaining({
        discountCode: rewardSnapshot.discountCode,
        startsAt: new Date("2026-08-29T00:00:00.000Z"),
        expiresAt: new Date("2026-09-28T00:00:00.000Z"),
        expectedShopCurrency: "USD",
        shopifyCustomerId: "123",
        rewardDefinition: expect.objectContaining({
          id: rewardDefinitionId,
          name: rewardSnapshot.provisioningName,
          rewardType: "amount_off",
          discountValue: "1000",
          maxDiscountValue: "2500",
          minOrderAmount: "5000",
          appliesToResource: "entire_order",
          entitledCollectionIds: [],
          entitledProductIds: [],
          entitledVariantIds: [],
          combinesWithProductDiscounts: true,
          combinesWithShippingDiscounts: true,
          usageLimit: 2,
          usageLimitPerCustomer: 1,
        }),
      }),
    );
    const created = vi.mocked(prisma.weleticRewardRedemption.create).mock
      .calls[0][0].data as any;
    expect(created.metadata.rewardSnapshot).toEqual(rewardSnapshot);
    expect(created.metadata.shopifyDiscountExpectedTitle).toBe(
      rewardSnapshot.expectedTitle,
    );
  });

  it("adopts only an active owned discount with the complete immutable configuration", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_owned_match",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.provisioning,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountId: null,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot),
    } as any);
    vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: "gid://shopify/DiscountCodeNode/owned-match",
      code: snapshot.discountCode,
      title: snapshot.expectedTitle,
      status: "ACTIVE",
      configuration: remoteConfigurationForSnapshot(snapshot),
    });

    await issueReferralRewardCoupon({
      storeId,
      referralId,
      qualificationOrderId,
      accountId,
      rewardDefinitionId,
      side: "advocate",
    });

    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    expect(deactivateDiscount).not.toHaveBeenCalled();
    expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "wredemp_owned_match",
          status: WeleticRedemptionStatus.provisioning,
        }),
        data: expect.objectContaining({
          status: WeleticRedemptionStatus.issued,
          shopifyDiscountId: "gid://shopify/DiscountCodeNode/owned-match",
        }),
      }),
    );
  });

  it("deactivates and durably cancels an owned coupon whose economics were altered", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    const alteredConfiguration = remoteConfigurationForSnapshot(snapshot);
    alteredConfiguration.basicValue.amount = "99.00";
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_owned_altered",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.provisioning,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountId: null,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot),
    } as any);
    vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: "gid://shopify/DiscountCodeNode/owned-altered",
      code: snapshot.discountCode,
      title: snapshot.expectedTitle,
      status: "ACTIVE",
      configuration: alteredConfiguration,
    });
    vi.mocked(deactivateDiscount).mockResolvedValue(true);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).resolves.toBeDefined();

    expect(deactivateDiscount).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/owned-altered",
    );
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "wredemp_owned_altered",
          status: WeleticRedemptionStatus.provisioning,
        }),
        data: expect.objectContaining({
          status: WeleticRedemptionStatus.cancelled,
          shopifyDiscountId: "gid://shopify/DiscountCodeNode/owned-altered",
        }),
      }),
    );
  });

  it("converges an owned inactive coupon to cancelled without another remote mutation", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_owned_inactive",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.provisioning,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountId: null,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot),
    } as any);
    vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: "gid://shopify/DiscountCodeNode/owned-inactive",
      code: snapshot.discountCode,
      title: snapshot.expectedTitle,
      status: "INACTIVE",
      configuration: remoteConfigurationForSnapshot(snapshot),
    });

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).resolves.toBeDefined();

    expect(deactivateDiscount).not.toHaveBeenCalled();
    expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WeleticRedemptionStatus.cancelled,
          shopifyDiscountId: "gid://shopify/DiscountCodeNode/owned-inactive",
        }),
      }),
    );
  });

  it("rejects store-currency and Shopify-customer drift before provisioning", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    const existing = {
      id: "wredemp_context_drift",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.provisioning,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountId: null,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot),
    } as any;
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
      existing,
    );
    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      shopCurrency: "JPY",
      currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
      complianceState: "active",
    } as any);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).rejects.toThrow("store currency no longer matches");
    expect(lookupDiscountByCode).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();

    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
      complianceState: "active",
    } as any);
    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).rejects.toThrow("currency generation no longer matches");
    expect(lookupDiscountByCode).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();

    vi.mocked(prisma.weleticShopifyStore.findUnique).mockResolvedValue({
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
      complianceState: "active",
    } as any);
    vi.mocked(prisma.weleticLoyaltyAccount.findFirst).mockResolvedValue({
      id: accountId,
      storeId,
      status: "active",
      shopper: { shopifyCustomerId: "999" },
    } as any);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).rejects.toThrow("resolved a different Shopify customer");
    expect(lookupDiscountByCode).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("rejects a re-signed outbox snapshot that differs from the authoritative referral snapshot", async () => {
    const originalSnapshot = createReferralCouponRewardSnapshot({
      identity: {
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      },
      reward: {
        id: rewardDefinitionId,
        name: "Original referral reward",
        description: null,
        rewardType: "amount_off",
        salesChannel: "online_store",
        discountValue: 1000,
        maxDiscountValue: null,
        minOrderAmount: null,
        appliesToResource: "entire_order",
        entitledCollectionIds: [],
        entitledProductIds: [],
        entitledVariantIds: [],
        combinesWithProductDiscounts: false,
        combinesWithOrderDiscounts: false,
        combinesWithShippingDiscounts: false,
        usageLimit: 1,
        usageLimitPerCustomer: 1,
        expiresInDays: 30,
      },
      qualifiedAt: new Date("2026-08-29T00:00:00.000Z"),
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
      shopifyCustomerId: "123",
    });
    const { contentDigest: _originalDigest, ...changedContent } = {
      ...originalSnapshot,
      discountValue: "9000",
    };
    const changedSnapshot = {
      ...changedContent,
      contentDigest:
        getReferralCouponRewardSnapshotContentDigest(changedContent),
    };
    vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValue({
      id: referralId,
      storeId,
      advocateAccountId: accountId,
      advocatePointsAwarded: BigInt(0),
      refereePointsAwarded: BigInt(0),
      refereeAccountId: "wacc_referee_coupon",
      status: WeleticLoyaltyReferralStatus.qualified,
      metadata: {
        requiredCouponSides: ["advocate"],
        referralCouponRewardSnapshots: { advocate: originalSnapshot },
      },
    } as any);
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
      null,
    );

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
        rewardSnapshot: changedSnapshot,
      }),
    ).rejects.toThrow(
      "Referral coupon payload does not match the immutable qualification snapshot.",
    );
    expect(prisma.weleticRewardRedemption.create).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("rejects a coupon payload whose account does not match its referral side", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue(
      null,
    );

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId: "wacc_wrong_recipient",
        rewardDefinitionId,
        side: "advocate",
      }),
    ).rejects.toThrow(
      "Referral coupon advocate account does not match the qualified referral.",
    );
    expect(prisma.weleticRewardRedemption.create).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("never resurrects a coupon cancelled during remote provisioning", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    vi.mocked(prisma.weleticRewardRedemption.findUnique)
      .mockResolvedValueOnce({
        id: "wredemp_race",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.provisioning,
        shopifyDiscountCode: snapshot.discountCode,
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot),
      } as any)
      .mockResolvedValueOnce({
        id: "wredemp_race",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.provisioning,
        shopifyDiscountCode: snapshot.discountCode,
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot),
      } as any)
      .mockResolvedValueOnce({
        id: "wredemp_race",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.provisioning,
        shopifyDiscountCode: snapshot.discountCode,
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot),
      } as any)
      .mockResolvedValueOnce({
        id: "wredemp_race",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.cancelled,
        shopifyDiscountCode: snapshot.discountCode,
        shopifyDiscountId: null,
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot, {
          remoteProvisionAttemptedAt: new Date().toISOString(),
          remoteProvisionReconcileUntil: new Date(
            Date.now() + 120_000,
          ).toISOString(),
        }),
      } as any);
    vi.mocked(prisma.weleticRewardRedemption.updateMany)
      .mockResolvedValueOnce({ count: 1 }) // persist remote-attempt marker
      .mockResolvedValue({ count: 0 });
    vi.mocked(deactivateDiscount).mockResolvedValue(true);

    await issueReferralRewardCoupon({
      storeId,
      referralId,
      qualificationOrderId,
      accountId,
      rewardDefinitionId,
      side: "advocate",
    });

    expect(deactivateDiscount).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/1",
    );
    expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: referralId,
          qualifyingOrderId: qualificationOrderId,
          status: {
            in: [
              WeleticLoyaltyReferralStatus.qualified,
              WeleticLoyaltyReferralStatus.rewarded,
            ],
          },
        }),
      }),
    );
  });

  it("cancels and deactivates a coupon when its referral generation became terminal", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    vi.mocked(prisma.weleticRewardRedemption.findUnique)
      .mockResolvedValueOnce({
        id: "wredemp_terminal_race",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.provisioning,
        shopifyDiscountCode: snapshot.discountCode,
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot),
      } as any)
      .mockResolvedValueOnce({
        id: "wredemp_terminal_race",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.provisioning,
        shopifyDiscountCode: snapshot.discountCode,
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot),
      } as any)
      .mockResolvedValueOnce({
        id: "wredemp_terminal_race",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.provisioning,
        shopifyDiscountCode: snapshot.discountCode,
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot),
      } as any)
      .mockResolvedValueOnce({
        id: "wredemp_terminal_race",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.cancelled,
        shopifyDiscountCode: snapshot.discountCode,
        shopifyDiscountId: "gid://shopify/DiscountCodeNode/1",
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot, {
          cancellationReason: "referral_generation_invalid",
        }),
      } as any);
    vi.mocked(prisma.weleticLoyaltyReferral.updateMany).mockResolvedValueOnce({
      count: 0,
    });
    vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(deactivateDiscount).mockResolvedValue(true);

    await issueReferralRewardCoupon({
      storeId,
      referralId,
      qualificationOrderId,
      accountId,
      rewardDefinitionId,
      side: "advocate",
    });

    expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "wredemp_terminal_race",
          status: WeleticRedemptionStatus.provisioning,
        }),
        data: expect.objectContaining({
          status: WeleticRedemptionStatus.cancelled,
          compensationReason:
            "Referral generation became invalid during coupon provisioning",
        }),
      }),
    );
    expect(deactivateDiscount).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/1",
    );
  });

  it("never deactivates a legacy stored Shopify GID without an immutable ownership snapshot", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_retry_deactivation",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.cancelled,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountId: "gid://shopify/DiscountCodeNode/retry",
      expiresAt: null,
      metadata: referralCouponMetadata({
        cancellationReason: "referral_generation_invalid",
        shopifyDiscountOwnershipFingerprint: snapshot.ownershipFingerprint,
        shopifyDiscountProvisioningName: snapshot.provisioningName,
        shopifyDiscountExpectedTitle: snapshot.expectedTitle,
      }),
    } as any);
    vi.mocked(deactivateDiscount).mockResolvedValue(true);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).rejects.toThrow("manual reconciliation is required");

    expect(lookupDiscountByCode).not.toHaveBeenCalled();
    expect(deactivateDiscount).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("never deactivates a stored Shopify GID that is misbound to another discount", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_misbound_deactivation",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.cancelled,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountId: "gid://shopify/DiscountCodeNode/foreign",
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot),
    } as any);
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: "gid://shopify/DiscountCodeNode/owned",
      code: snapshot.discountCode,
      title: snapshot.expectedTitle,
      status: "ACTIVE",
      configuration: remoteConfigurationForSnapshot(snapshot),
    } as any);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).rejects.toThrow("could not be verified");

    expect(lookupDiscountByCode).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      snapshot.discountCode,
    );
    expect(deactivateDiscount).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("retries deactivation only after verifying a stored Shopify GID against immutable ownership", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    const discountId = "gid://shopify/DiscountCodeNode/retry";
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_retry_deactivation",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.cancelled,
      shopifyDiscountCode: snapshot.discountCode,
      shopifyDiscountId: discountId,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot),
    } as any);
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: discountId,
      code: snapshot.discountCode,
      title: snapshot.expectedTitle,
      status: "ACTIVE",
      configuration: remoteConfigurationForSnapshot(snapshot),
    } as any);
    vi.mocked(deactivateDiscount).mockResolvedValue(true);

    await issueReferralRewardCoupon({
      storeId,
      referralId,
      qualificationOrderId,
      accountId,
      rewardDefinitionId,
      side: "advocate",
    });

    expect(lookupDiscountByCode).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      snapshot.discountCode,
    );
    expect(deactivateDiscount).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      discountId,
    );
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("uses the persisted expected title when compensating after a reward rename", async () => {
    const rewardSnapshot = createReferralCouponRewardSnapshot({
      identity: {
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      },
      reward: {
        id: rewardDefinitionId,
        name: "Original referral reward",
        description: null,
        rewardType: "amount_off",
        salesChannel: "online_store",
        discountValue: 1000,
        maxDiscountValue: null,
        minOrderAmount: null,
        appliesToResource: "entire_order",
        entitledCollectionIds: [],
        entitledProductIds: [],
        entitledVariantIds: [],
        combinesWithProductDiscounts: false,
        combinesWithOrderDiscounts: false,
        combinesWithShippingDiscounts: false,
        usageLimit: 1,
        usageLimitPerCustomer: 1,
        expiresInDays: 30,
      },
      qualifiedAt: new Date("2026-08-29T00:00:00.000Z"),
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
      shopifyCustomerId: "123",
    });
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_snapshot_compensation",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.cancelled,
      shopifyDiscountCode: rewardSnapshot.discountCode,
      shopifyDiscountId: null,
      expiresAt: new Date(rewardSnapshot.expiresAt!),
      metadata: {
        referralId,
        qualificationOrderId,
        referralSide: "advocate",
        rewardSnapshot,
        shopifyDiscountOwnershipFingerprint:
          rewardSnapshot.ownershipFingerprint,
        shopifyDiscountProvisioningName: rewardSnapshot.provisioningName,
        shopifyDiscountExpectedTitle: rewardSnapshot.expectedTitle,
        remoteProvisionAttemptedAt: "2026-08-29T00:00:01.000Z",
        remoteProvisionReconcileUntil: new Date(
          Date.now() + 120_000,
        ).toISOString(),
      },
    } as any);
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: "gid://shopify/DiscountCodeNode/snapshot",
      code: rewardSnapshot.discountCode,
      title: rewardSnapshot.expectedTitle,
      status: "ACTIVE",
    });
    vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(deactivateDiscount).mockResolvedValue(true);

    await issueReferralRewardCoupon({
      storeId,
      referralId,
      qualificationOrderId,
      accountId,
      rewardDefinitionId,
      side: "advocate",
    });

    expect(lookupDiscountByCode).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      rewardSnapshot.discountCode,
    );
    expect(deactivateDiscount).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/snapshot",
    );
    expect(prisma.weleticRewardDefinition.findFirst).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("keeps an orphan lookup miss retryable, then persists and deactivates the recovered coupon", async () => {
    const rewardSnapshot = createReferralCouponRewardSnapshot({
      identity: {
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      },
      reward: {
        id: rewardDefinitionId,
        name: "$10 referral reward",
        description: null,
        rewardType: "amount_off",
        salesChannel: "online_store",
        discountValue: 1000,
        maxDiscountValue: null,
        minOrderAmount: null,
        appliesToResource: "entire_order",
        entitledCollectionIds: [],
        entitledProductIds: [],
        entitledVariantIds: [],
        combinesWithProductDiscounts: false,
        combinesWithOrderDiscounts: false,
        combinesWithShippingDiscounts: false,
        usageLimit: 1,
        usageLimitPerCustomer: 1,
        expiresInDays: 30,
      },
      qualifiedAt: new Date("2026-08-29T04:00:00.000Z"),
      shopCurrency: "USD",
      currencyVerifiedAt: new Date("2026-08-28T00:00:00.000Z"),
      shopifyCustomerId: "123",
    });
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_orphan_recovery",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.cancelled,
      shopifyDiscountCode: rewardSnapshot.discountCode,
      shopifyDiscountId: null,
      expiresAt: new Date(rewardSnapshot.expiresAt!),
      metadata: {
        referralId,
        qualificationOrderId,
        referralSide: "advocate",
        rewardSnapshot,
        shopifyDiscountOwnershipFingerprint:
          rewardSnapshot.ownershipFingerprint,
        shopifyDiscountProvisioningName: rewardSnapshot.provisioningName,
        shopifyDiscountExpectedTitle: rewardSnapshot.expectedTitle,
        remoteProvisionAttemptedAt: "2026-08-29T04:00:00.000Z",
        remoteProvisionReconcileUntil: new Date(
          Date.now() + 120_000,
        ).toISOString(),
      },
    } as any);
    vi.mocked(lookupDiscountByCode)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "gid://shopify/DiscountCodeNode/orphan",
        code: rewardSnapshot.discountCode,
        title: rewardSnapshot.expectedTitle,
        status: "ACTIVE",
        configuration: remoteConfigurationForSnapshot(rewardSnapshot),
      } as any);
    vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(deactivateDiscount).mockResolvedValue(true);

    const issue = () =>
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      });

    await expect(issue()).rejects.toThrow(
      `Shopify referral discount ${rewardSnapshot.discountCode} is not visible yet; reconciliation remains pending.`,
    );
    expect(deactivateDiscount).not.toHaveBeenCalled();

    await expect(issue()).resolves.toBeDefined();

    expect(lookupDiscountByCode).toHaveBeenCalledTimes(2);
    expect(lookupDiscountByCode).toHaveBeenLastCalledWith(
      "test.myshopify.com",
      "test-token",
      rewardSnapshot.discountCode,
    );
    expect(prisma.weleticRewardRedemption.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "wredemp_orphan_recovery",
        storeId,
        status: {
          in: [
            WeleticRedemptionStatus.cancelled,
            WeleticRedemptionStatus.expired,
            WeleticRedemptionStatus.failed,
          ],
        },
        shopifyDiscountId: null,
      }),
      data: {
        shopifyDiscountId: "gid://shopify/DiscountCodeNode/orphan",
      },
    });
    expect(deactivateDiscount).toHaveBeenCalledWith(
      "test.myshopify.com",
      "test-token",
      "gid://shopify/DiscountCodeNode/orphan",
    );
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("requires manual reconciliation when uncertain-create absence persists past the horizon", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_absent_after_horizon",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.cancelled,
      shopifyDiscountCode: "WLR-ABSENT",
      shopifyDiscountId: null,
      expiresAt: null,
      metadata: referralCouponMetadata({
        remoteProvisionAttemptedAt: "2026-01-01T00:00:00.000Z",
        remoteProvisionReconcileUntil: "2026-01-01T00:02:00.000Z",
      }),
    } as any);
    vi.mocked(lookupDiscountByCode).mockResolvedValue(null);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).rejects.toThrow("manual reconciliation is required");

    expect(lookupDiscountByCode).toHaveBeenCalledTimes(1);
    expect(deactivateDiscount).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("refuses to adopt a deterministic code owned by another configuration", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    const discountCode = snapshot.discountCode;
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_collision",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.provisioning,
      shopifyDiscountCode: discountCode,
      shopifyDiscountId: null,
      expiresAt: new Date(snapshot.expiresAt!),
      metadata: immutableReferralCouponMetadata(snapshot),
    } as any);
    vi.mocked(prisma.weleticRewardRedemption.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: "gid://shopify/DiscountCodeNode/collision",
      code: discountCode,
      title: `Unrelated campaign (${discountCode})`,
      status: "ACTIVE",
    });

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).rejects.toThrow("the existing discount is not owned");

    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
  });

  it("completes compensation without Shopify calls when cancellation won before remote provisioning", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_cancelled_before_remote",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.cancelled,
      shopifyDiscountCode: "WLR-NOT-ATTEMPTED",
      shopifyDiscountId: null,
      expiresAt: null,
      metadata: referralCouponMetadata(),
    } as any);

    await expect(
      issueReferralRewardCoupon({
        storeId,
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    ).resolves.toBeDefined();

    expect(resolveShopifyOfflineCredentials).not.toHaveBeenCalled();
    expect(lookupDiscountByCode).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    expect(deactivateDiscount).not.toHaveBeenCalled();
  });

  it("completes without deactivation when settlement uses the coupon during finalization", async () => {
    const snapshot = createTestReferralCouponSnapshot();
    vi.mocked(prisma.weleticRewardRedemption.findUnique)
      .mockResolvedValueOnce({
        id: "wredemp_concurrent",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.provisioning,
        shopifyDiscountCode: snapshot.discountCode,
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot),
      } as any)
      .mockResolvedValueOnce({
        id: "wredemp_concurrent",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.provisioning,
        shopifyDiscountCode: snapshot.discountCode,
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot),
      } as any)
      .mockResolvedValueOnce({
        id: "wredemp_concurrent",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.provisioning,
        shopifyDiscountCode: snapshot.discountCode,
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot),
      } as any)
      .mockResolvedValueOnce({
        id: "wredemp_concurrent",
        storeId,
        accountId,
        rewardDefinitionId,
        status: WeleticRedemptionStatus.used,
        shopifyDiscountCode: snapshot.discountCode,
        shopifyDiscountId: "gid://shopify/DiscountCodeNode/1",
        expiresAt: new Date(snapshot.expiresAt!),
        metadata: immutableReferralCouponMetadata(snapshot),
      } as any);
    vi.mocked(prisma.weleticRewardRedemption.updateMany)
      .mockResolvedValueOnce({ count: 1 }) // persist remote-attempt marker
      .mockResolvedValue({ count: 0 });
    vi.mocked(prisma.weleticRewardRedemption.count).mockResolvedValue(1);

    await issueReferralRewardCoupon({
      storeId,
      referralId,
      qualificationOrderId,
      accountId,
      rewardDefinitionId,
      side: "advocate",
    });

    expect(deactivateDiscount).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).toHaveBeenCalledTimes(1);
    expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WeleticLoyaltyReferralStatus.rewarded,
        }),
      }),
    );
  });

  it("uses a new coupon identity for each legitimate requalification", () => {
    const first = getReferralCouponIdempotencyKey({
      referralId,
      qualificationOrderId: "worder_first",
      side: "advocate",
    });
    const replacement = getReferralCouponIdempotencyKey({
      referralId,
      qualificationOrderId: "worder_requalified",
      side: "advocate",
    });

    expect(first).not.toBe(replacement);
    expect(first.length).toBeLessThan(64);
    expect(replacement.length).toBeLessThan(64);
  });

  it("uses at least 96 bits for the tenant-bound Shopify coupon identity", () => {
    const code = getReferralCouponDiscountCode({
      storeId,
      referralId,
      qualificationOrderId,
      accountId,
      rewardDefinitionId,
      side: "advocate",
    });

    expect(code).toMatch(/^WLR-[A-F0-9]{24}$/);
    expect(code).not.toBe(
      getReferralCouponDiscountCode({
        storeId: "another_store",
        referralId,
        qualificationOrderId,
        accountId,
        rewardDefinitionId,
        side: "advocate",
      }),
    );
  });

  it("completes a referral when settlement already moved the coupon to used", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_used_during_finalize",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.used,
      shopifyDiscountCode: "WLR-USED-DURING-FINALIZE",
      shopifyDiscountId: "gid://shopify/DiscountCodeNode/used",
      expiresAt: null,
      metadata: referralCouponMetadata(),
    } as any);
    vi.mocked(prisma.weleticRewardRedemption.count).mockResolvedValue(1);

    await issueReferralRewardCoupon({
      storeId,
      referralId,
      qualificationOrderId,
      accountId,
      rewardDefinitionId,
      side: "advocate",
    });

    expect(lookupDiscountByCode).not.toHaveBeenCalled();
    expect(provisionLoyaltyRewardDiscount).not.toHaveBeenCalled();
    expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WeleticLoyaltyReferralStatus.rewarded,
        }),
      }),
    );
  });

  it("completes a two-sided referral when prior coupons are active or used", async () => {
    vi.mocked(prisma.weleticRewardRedemption.findUnique).mockResolvedValue({
      id: "wredemp_referee",
      storeId,
      accountId,
      rewardDefinitionId,
      status: WeleticRedemptionStatus.issued,
      shopifyDiscountCode: "WLR-REFEREE",
      expiresAt: null,
      metadata: {
        ...referralCouponMetadata(),
        referralSide: "referee",
      },
    } as any);
    vi.mocked(prisma.weleticLoyaltyReferral.findFirst).mockResolvedValue({
      id: referralId,
      storeId,
      advocateAccountId: "wacc_advocate_coupon",
      advocatePointsAwarded: BigInt(0),
      refereePointsAwarded: BigInt(0),
      refereeAccountId: accountId,
      status: WeleticLoyaltyReferralStatus.qualified,
      metadata: { requiredCouponSides: ["advocate", "referee"] },
    } as any);
    vi.mocked(prisma.weleticRewardRedemption.count).mockResolvedValue(2);

    await issueReferralRewardCoupon({
      storeId,
      referralId,
      qualificationOrderId,
      accountId,
      rewardDefinitionId,
      side: "referee",
    });

    expect(prisma.weleticRewardRedemption.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: {
          in: [
            WeleticRedemptionStatus.issued,
            WeleticRedemptionStatus.active,
            WeleticRedemptionStatus.used,
          ],
        },
      }),
    });
    expect(prisma.weleticLoyaltyReferral.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: WeleticLoyaltyReferralStatus.rewarded,
        }),
      }),
    );
  });
});
