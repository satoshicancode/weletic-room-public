import { compensateDiscountSaga } from "@/lib/weletic/loyalty/saga";
import {
  deactivateDiscount,
  lookupDiscountByCode,
  resolveShopifyOfflineCredentials,
  ShopifyDiscountError,
} from "@/lib/weletic/loyalty/shopify-discounts";
import {
  enqueueVoucherPrivacyCleanup,
  handleVoucherPrivacyCleanup,
  processStoreVoucherCleanupComplianceStep,
  VoucherCleanupRetryableError,
} from "@/lib/weletic/loyalty/voucher-privacy-cleanup";
import {
  WeleticRedemptionStatus,
  WeleticVoucherCleanupSource,
  WeleticVoucherCleanupStatus,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cleanupFindUnique: vi.fn(),
  cleanupFindUniqueOrThrow: vi.fn(),
  cleanupUpdateMany: vi.fn(),
  cleanupCreate: vi.fn(),
  cleanupLinkFindUnique: vi.fn(),
  cleanupLinkUpsert: vi.fn(),
  sourceRequestFindUnique: vi.fn(),
  redemptionFindUnique: vi.fn(),
  redemptionFindMany: vi.fn(),
  redemptionUpdateMany: vi.fn(),
  storeFindUnique: vi.fn(),
  transaction: vi.fn(),
  enqueueOutbox: vi.fn(),
  resolveCredentials: vi.fn(),
  frozenCredentials: vi.fn(),
  lookupDiscount: vi.fn(),
  deactivateDiscount: vi.fn(),
  compensate: vi.fn(),
  appendLedger: vi.fn(),
  operationOrder: [] as string[],
}));
vi.mock("@/lib/weletic/shopify/store-owned-credential", () => ({
  readFrozenStoreOwnedVoucherCredential: mocks.frozenCredentials,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    weleticShopifyVoucherCleanup: {
      findUnique: mocks.cleanupFindUnique,
      findUniqueOrThrow: mocks.cleanupFindUniqueOrThrow,
      updateMany: mocks.cleanupUpdateMany,
      create: mocks.cleanupCreate,
    },
    weleticShopifyVoucherCleanupRequestLink: {
      findUnique: mocks.cleanupLinkFindUnique,
      upsert: mocks.cleanupLinkUpsert,
    },
    weleticShopifyComplianceRequest: {
      findUnique: mocks.sourceRequestFindUnique,
    },
    weleticRewardRedemption: {
      findUnique: mocks.redemptionFindUnique,
      findMany: mocks.redemptionFindMany,
      updateMany: mocks.redemptionUpdateMany,
    },
    weleticShopifyStore: { findUnique: mocks.storeFindUnique },
  },
}));

vi.mock("@/lib/weletic/loyalty/outbox", () => ({
  enqueueOutboxJob: mocks.enqueueOutbox,
}));

vi.mock("@/lib/weletic/loyalty/ledger", () => ({
  appendPointsLedgerEntry: mocks.appendLedger,
}));

vi.mock("@/lib/weletic/loyalty/referral-coupon", () => ({
  getReferralCouponPrivacyCleanupExpectation: vi.fn(() => null),
}));

vi.mock("@/lib/weletic/loyalty/saga", () => ({
  compensateDiscountSaga: mocks.compensate,
}));

vi.mock("@/lib/weletic/loyalty/shopify-discounts", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/weletic/loyalty/shopify-discounts")
  >("@/lib/weletic/loyalty/shopify-discounts");
  return {
    ...actual,
    resolveShopifyOfflineCredentials: mocks.resolveCredentials,
    lookupDiscountByCode: mocks.lookupDiscount,
    deactivateDiscount: mocks.deactivateDiscount,
  };
});

const storeId = "store_privacy_cleanup";
const accountId = "account_privacy_cleanup";
const redemptionId = "redemption_privacy_cleanup";
const cleanupId = "cleanup_privacy_cleanup";
const discountId = "gid://shopify/DiscountCodeNode/4242";

function ownershipSnapshot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    version: 1,
    kind: "generic",
    expectedCode: "WL-PRIVATE-10",
    expectedTitle: "Private reward (WL-PRIVATE-10) [WL:ABC123]",
    ownershipFingerprint: "ABC123",
    remoteProvisionAttemptedAt: null,
    remoteProvisionReconcileUntil: null,
    captureError: null,
    ...overrides,
  };
}

function cleanupFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: cleanupId,
    storeId,
    redemptionId,
    sourceRequestId: "compliance_request_1",
    source: WeleticVoucherCleanupSource.customer_redact,
    status: WeleticVoucherCleanupStatus.pending,
    expectedDiscountCode: "WL-PRIVATE-10",
    expectedDiscountCodeCanonical: "WL-PRIVATE-10",
    expectedDiscountId: discountId,
    ownershipSnapshot: ownershipSnapshot(),
    attempts: 0,
    maxAttempts: 10,
    leaseVersion: 0,
    lockedAt: null,
    lockedBy: null,
    nextRetryAt: null,
    lastError: null,
    remoteVerifiedAt: null,
    remoteUsageCount: null,
    remoteUsageObservedAt: null,
    remoteDeactivationStartedAt: null,
    remoteDeactivatedAt: null,
    remoteOutcome: null,
    completedAt: null,
    ...overrides,
  };
}

function redemptionFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: redemptionId,
    storeId,
    accountId,
    rewardDefinitionId: "reward_private_10",
    pointsSpent: BigInt(500),
    shopifyDiscountCode: "WL-PRIVATE-10",
    shopifyDiscountId: discountId,
    status: WeleticRedemptionStatus.issued,
    metadata: {},
    expiresAt: null,
    ...overrides,
  };
}

function installMutableCleanup(initial = cleanupFixture()) {
  const cleanup = { ...initial } as Record<string, any>;
  mocks.cleanupFindUnique.mockImplementation(async () => ({ ...cleanup }));
  mocks.cleanupFindUniqueOrThrow.mockImplementation(async () => ({
    ...cleanup,
  }));
  mocks.cleanupUpdateMany.mockImplementation(async ({ data }: any) => {
    if (data.attempts?.increment) {
      cleanup.attempts += data.attempts.increment;
    }
    if (data.leaseVersion?.increment) {
      cleanup.leaseVersion += data.leaseVersion.increment;
    }
    for (const [key, value] of Object.entries(data)) {
      if (key !== "attempts" && key !== "leaseVersion" && value !== undefined) {
        cleanup[key] = value;
      }
    }
    if (data.remoteDeactivationStartedAt) {
      mocks.operationOrder.push("remote_marked");
    }
    return { count: 1 };
  });
  return cleanup;
}

async function execute() {
  return handleVoucherPrivacyCleanup({
    storeId,
    cleanupId,
    redemptionId,
    accountId,
    outboxJobId: "outbox_cleanup_1",
  });
}

describe("durable privacy voucher cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeFindUnique.mockReset().mockResolvedValue({
      complianceState: "active",
      shopDomain: "privacy-cleanup.myshopify.com",
    });
    mocks.frozenCredentials.mockReset().mockResolvedValue({
      shopDomain: "privacy-cleanup.myshopify.com",
      accessToken: "frozen-token",
      installationGeneration: "generation",
    });
    mocks.operationOrder.length = 0;
    installMutableCleanup();
    mocks.redemptionFindUnique.mockResolvedValue(redemptionFixture());
    mocks.redemptionUpdateMany.mockResolvedValue({ count: 1 });
    mocks.resolveCredentials.mockResolvedValue({
      shopDomain: "privacy-cleanup.myshopify.com",
      accessToken: "offline-token",
    });
    mocks.lookupDiscount.mockResolvedValue({
      id: discountId,
      code: "wl-private-10",
      title: "Private reward (WL-PRIVATE-10) [WL:ABC123]",
      status: "ACTIVE",
      asyncUsageCount: 0,
    });
    mocks.deactivateDiscount.mockImplementation(async () => {
      mocks.operationOrder.push("remote_deactivated");
      return true;
    });
    mocks.compensate.mockImplementation(async () => {
      mocks.operationOrder.push("local_compensated");
    });
    mocks.sourceRequestFindUnique.mockImplementation(async ({ where }: any) => {
      const requestId = where.storeId_id.id as string;
      return {
        requestType: requestId.includes("uninstall")
          ? "app_uninstalled"
          : requestId.includes("shop")
            ? "shop_redact"
            : "customer_redact",
      };
    });
    mocks.transaction.mockImplementation(async (callback: any) =>
      callback({
        weleticReviewIncentiveInvalidation: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
        $queryRaw: vi.fn(async () => {
          const cleanup = await mocks.cleanupFindUnique({
            where: { id: cleanupId },
          });
          return cleanup ? [cleanup] : [];
        }),
        weleticShopifyVoucherCleanup: {
          findUnique: mocks.cleanupFindUnique,
          create: mocks.cleanupCreate,
          updateMany: mocks.cleanupUpdateMany,
        },
        weleticShopifyVoucherCleanupRequestLink: {
          findUnique: mocks.cleanupLinkFindUnique,
          upsert: mocks.cleanupLinkUpsert,
        },
        weleticShopifyComplianceRequest: {
          findUnique: mocks.sourceRequestFindUnique,
        },
        weleticRewardRedemption: {
          findUnique: mocks.redemptionFindUnique,
          findMany: mocks.redemptionFindMany,
          updateMany: mocks.redemptionUpdateMany,
        },
        weleticLoyaltyOutboxJob: {
          upsert: vi.fn(),
        },
      }),
    );
  });

  it("deactivates an issued non-expiring voucher before restoring points", async () => {
    const cleanup = installMutableCleanup();

    await expect(execute()).resolves.toBe("deactivated");

    expect(deactivateDiscount).toHaveBeenCalledWith(
      "privacy-cleanup.myshopify.com",
      "offline-token",
      discountId,
    );
    expect(compensateDiscountSaga).toHaveBeenCalledWith(
      expect.objectContaining({
        redemptionId,
        reason: "Unused voucher cancelled after privacy or uninstall cleanup.",
        targetStatus: WeleticRedemptionStatus.cancelled,
        tx: expect.any(Object),
      }),
    );
    expect(mocks.operationOrder).toEqual([
      "remote_marked",
      "remote_deactivated",
      "local_compensated",
    ]);
    expect(cleanup.status).toBe(WeleticVoucherCleanupStatus.completed);
    expect(cleanup.remoteOutcome).toBe("deactivated");
  });

  it("uses the same exact ownership gate for a referral voucher", async () => {
    installMutableCleanup(
      cleanupFixture({
        ownershipSnapshot: ownershipSnapshot({
          kind: "referral",
          ownershipFingerprint: "REFERRALABC",
        }),
      }),
    );

    await expect(execute()).resolves.toBe("deactivated");
    expect(deactivateDiscount).toHaveBeenCalledOnce();
  });

  it("keeps ambiguous provisioning retryable until its visibility horizon", async () => {
    const retryAt = new Date(Date.now() + 60_000);
    const cleanup = installMutableCleanup(
      cleanupFixture({
        expectedDiscountId: null,
        ownershipSnapshot: ownershipSnapshot({
          remoteProvisionAttemptedAt: new Date().toISOString(),
          remoteProvisionReconcileUntil: retryAt.toISOString(),
        }),
      }),
    );
    mocks.redemptionFindUnique.mockResolvedValue(
      redemptionFixture({
        status: WeleticRedemptionStatus.provisioning,
        shopifyDiscountId: null,
      }),
    );
    vi.mocked(lookupDiscountByCode).mockResolvedValue(null);

    await expect(execute()).rejects.toBeInstanceOf(
      VoucherCleanupRetryableError,
    );

    expect(cleanup.status).toBe(WeleticVoucherCleanupStatus.retrying);
    expect(cleanup.nextRetryAt).toEqual(retryAt);
    expect(deactivateDiscount).not.toHaveBeenCalled();
    expect(compensateDiscountSaga).not.toHaveBeenCalled();
  });

  it("does not reclaim a retrying cleanup before its durable retry horizon", async () => {
    const retryAt = new Date(Date.now() + 60_000);
    installMutableCleanup(
      cleanupFixture({
        status: WeleticVoucherCleanupStatus.retrying,
        attempts: 1,
        nextRetryAt: retryAt,
      }),
    );

    await expect(execute()).rejects.toMatchObject({ retryAt });

    expect(mocks.cleanupUpdateMany).not.toHaveBeenCalled();
    expect(resolveShopifyOfflineCredentials).not.toHaveBeenCalled();
    expect(lookupDiscountByCode).not.toHaveBeenCalled();
  });

  it("deactivates a reusable remote voucher even when the local redemption is already used", async () => {
    const cleanup = installMutableCleanup();
    mocks.redemptionFindUnique.mockResolvedValue(
      redemptionFixture({ status: WeleticRedemptionStatus.used }),
    );
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: discountId,
      code: "WL-PRIVATE-10",
      title: "Private reward (WL-PRIVATE-10) [WL:ABC123]",
      status: "ACTIVE",
      asyncUsageCount: 1,
    });

    await expect(execute()).resolves.toBe("used_preserved");

    expect(cleanup.status).toBe(WeleticVoucherCleanupStatus.completed);
    expect(cleanup.remoteOutcome).toBe("used_preserved");
    expect(resolveShopifyOfflineCredentials).toHaveBeenCalledOnce();
    expect(deactivateDiscount).toHaveBeenCalledWith(
      "privacy-cleanup.myshopify.com",
      "offline-token",
      discountId,
    );
    expect(compensateDiscountSaga).not.toHaveBeenCalled();
  });

  it("enqueues remote cleanup for a used redemption because the Shopify code may remain reusable", async () => {
    const usedRedemption = redemptionFixture({
      status: WeleticRedemptionStatus.used,
    });
    const createdCleanup = cleanupFixture({
      sourceRequestId: null,
      source: WeleticVoucherCleanupSource.customer_redact,
    });
    mocks.cleanupFindUnique.mockResolvedValue(null);
    mocks.cleanupCreate.mockResolvedValue(createdCleanup);

    await expect(
      enqueueVoucherPrivacyCleanup({
        redemption: usedRedemption,
        source: WeleticVoucherCleanupSource.customer_redact,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: cleanupId,
        redemptionId,
        requestLinkCreated: false,
      }),
    );

    expect(mocks.cleanupCreate).toHaveBeenCalledOnce();
    expect(mocks.enqueueOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "VOUCHER_PRIVACY_CLEANUP",
        payload: expect.objectContaining({ cleanupId, redemptionId }),
      }),
    );
  });

  it("preserves remotely-used voucher value during uninstall without refunding points", async () => {
    const cleanup = installMutableCleanup(
      cleanupFixture({
        source: WeleticVoucherCleanupSource.app_uninstalled,
      }),
    );
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: discountId,
      code: "WL-PRIVATE-10",
      title: "Private reward (WL-PRIVATE-10) [WL:ABC123]",
      status: "ACTIVE",
      asyncUsageCount: 1,
    });

    await expect(execute()).resolves.toBe("used_preserved");

    expect(deactivateDiscount).toHaveBeenCalledOnce();
    expect(compensateDiscountSaga).not.toHaveBeenCalled();
    expect(mocks.redemptionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: redemptionId, storeId }),
        data: expect.objectContaining({
          status: WeleticRedemptionStatus.used,
          metadata: expect.objectContaining({
            privacySafeFinancialAudit: true,
          }),
        }),
      }),
    );
    expect(cleanup.remoteUsageCount).toBe(1);
    expect(cleanup.remoteOutcome).toBe("used_preserved");
  });

  it("deactivates but delays uninstall compensation while zero usage can still settle", async () => {
    const cleanup = installMutableCleanup(
      cleanupFixture({
        source: WeleticVoucherCleanupSource.app_uninstalled,
      }),
    );

    await expect(execute()).rejects.toBeInstanceOf(
      VoucherCleanupRetryableError,
    );

    expect(deactivateDiscount).toHaveBeenCalledOnce();
    expect(compensateDiscountSaga).not.toHaveBeenCalled();
    expect(cleanup.status).toBe(WeleticVoucherCleanupStatus.retrying);
    expect(cleanup.remoteUsageCount).toBe(0);
    expect(cleanup.remoteDeactivationStartedAt).toBeInstanceOf(Date);
    expect(cleanup.nextRetryAt).toBeInstanceOf(Date);
  });
  it("resolves frozen native credentials under each remote-operation transaction without ordinary refresh", async () => {
    installMutableCleanup(
      cleanupFixture({ source: WeleticVoucherCleanupSource.app_uninstalled }),
    );
    mocks.storeFindUnique.mockResolvedValue({ complianceState: "frozen" });
    await expect(execute()).rejects.toBeInstanceOf(
      VoucherCleanupRetryableError,
    );
    expect(mocks.resolveCredentials).not.toHaveBeenCalled();
    expect(mocks.frozenCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.frozenCredentials).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        storeId,
        cleanupId,
        redemptionId,
        source: "app_uninstalled",
        leaseVersion: 1,
        expectedCode: "WL-PRIVATE-10",
      }),
    );
    expect(mocks.lookupDiscount).toHaveBeenCalledWith(
      "privacy-cleanup.myshopify.com",
      "frozen-token",
      "WL-PRIVATE-10",
    );
    expect(mocks.deactivateDiscount).toHaveBeenCalledWith(
      "privacy-cleanup.myshopify.com",
      "frozen-token",
      discountId,
    );
    expect(mocks.compensate).not.toHaveBeenCalled();
  });
  it("stops before deactivation if frozen cleanup credential authority is lost after lookup", async () => {
    installMutableCleanup(
      cleanupFixture({ source: WeleticVoucherCleanupSource.app_uninstalled }),
    );
    mocks.storeFindUnique.mockResolvedValue({ complianceState: "frozen" });
    mocks.frozenCredentials
      .mockResolvedValueOnce({
        shopDomain: "privacy-cleanup.myshopify.com",
        accessToken: "frozen-token",
      })
      .mockRejectedValueOnce(new Error("cleanup authority lost"));
    await expect(execute()).rejects.toThrow();
    expect(mocks.lookupDiscount).toHaveBeenCalledOnce();
    expect(mocks.deactivateDiscount).not.toHaveBeenCalled();
    expect(mocks.compensate).not.toHaveBeenCalled();
  });

  it("starts the strict two-minute reconciliation window only after confirmed deactivation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T00:00:00.000Z"));
    try {
      const cleanup = installMutableCleanup(
        cleanupFixture({
          source: WeleticVoucherCleanupSource.app_uninstalled,
        }),
      );
      vi.mocked(deactivateDiscount)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true);

      await expect(execute()).rejects.toBeInstanceOf(
        VoucherCleanupRetryableError,
      );
      expect(cleanup.remoteDeactivatedAt).toBeNull();

      vi.advanceTimersByTime(3 * 60_000);
      await expect(execute()).rejects.toMatchObject({
        retryAt: new Date("2026-08-30T00:05:00.000Z"),
      });

      expect(cleanup.remoteUsageObservedAt).toEqual(
        new Date("2026-08-30T00:03:00.000Z"),
      );
      expect(cleanup.remoteDeactivatedAt).toEqual(
        new Date("2026-08-30T00:03:00.000Z"),
      );
      expect(compensateDiscountSaga).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the first confirmed deactivation anchor when Shopify continues returning an inactive node", async () => {
    vi.useFakeTimers();
    const firstConfirmedAt = new Date("2026-08-30T00:00:00.000Z");
    vi.setSystemTime(new Date("2026-08-30T00:03:00.000Z"));
    try {
      const cleanup = installMutableCleanup(
        cleanupFixture({
          source: WeleticVoucherCleanupSource.app_uninstalled,
          status: WeleticVoucherCleanupStatus.retrying,
          attempts: 1,
          remoteVerifiedAt: firstConfirmedAt,
          remoteUsageCount: 0,
          remoteUsageObservedAt: firstConfirmedAt,
          remoteDeactivationStartedAt: firstConfirmedAt,
          remoteDeactivatedAt: firstConfirmedAt,
        }),
      );
      vi.mocked(lookupDiscountByCode).mockResolvedValue({
        id: discountId,
        code: "WL-PRIVATE-10",
        title: "Private reward (WL-PRIVATE-10) [WL:ABC123]",
        status: "INACTIVE",
        asyncUsageCount: 0,
      });

      await expect(execute()).resolves.toBe("deactivated");

      expect(deactivateDiscount).not.toHaveBeenCalled();
      expect(compensateDiscountSaga).toHaveBeenCalledOnce();
      expect(cleanup.remoteDeactivatedAt).toEqual(firstConfirmedAt);
      expect(cleanup.remoteUsageObservedAt).toEqual(
        new Date("2026-08-30T00:03:00.000Z"),
      );
      expect(cleanup.status).toBe(WeleticVoucherCleanupStatus.completed);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-debits a previously compensated cleanup when the strict recheck observes late Shopify usage", async () => {
    const observedAt = new Date("2026-08-30T00:00:00.000Z");
    installMutableCleanup(
      cleanupFixture({
        source: WeleticVoucherCleanupSource.app_uninstalled,
        status: WeleticVoucherCleanupStatus.retrying,
        attempts: 1,
        remoteVerifiedAt: observedAt,
        remoteUsageCount: 0,
        remoteUsageObservedAt: observedAt,
        remoteDeactivationStartedAt: observedAt,
        remoteDeactivatedAt: observedAt,
      }),
    );
    const cancelled = redemptionFixture({
      status: WeleticRedemptionStatus.cancelled,
    });
    mocks.redemptionFindUnique.mockResolvedValue(cancelled);
    vi.mocked(lookupDiscountByCode).mockResolvedValue({
      id: discountId,
      code: "WL-PRIVATE-10",
      title: "Private reward (WL-PRIVATE-10) [WL:ABC123]",
      status: "INACTIVE",
      asyncUsageCount: 1,
    });
    await expect(execute()).resolves.toBe("used_preserved");

    expect(mocks.appendLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        storeId,
        accountId,
        pointsDelta: BigInt(-500),
        idempotencyKey: `redemption_late_use:${redemptionId}`,
      }),
    );
    expect(mocks.redemptionUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: WeleticRedemptionStatus.used }),
      }),
    );
  });

  it.each([
    {
      name: "remote ownership mismatch",
      remote: {
        id: discountId,
        code: "WL-PRIVATE-10",
        title: "Merchant-owned discount",
        status: "ACTIVE",
      },
    },
    { name: "persisted GID lookup absence", remote: null },
  ])("dead-letters $name without financial mutation", async ({ remote }) => {
    const cleanup = installMutableCleanup();
    vi.mocked(lookupDiscountByCode).mockResolvedValue(remote as any);

    await expect(execute()).resolves.toBe("manual_reconciliation");

    expect(cleanup.status).toBe(WeleticVoucherCleanupStatus.dead_letter);
    expect(cleanup.remoteOutcome).toBe("manual_reconciliation");
    expect(deactivateDiscount).not.toHaveBeenCalled();
    expect(compensateDiscountSaga).not.toHaveBeenCalled();
  });

  it("accepts remote deletion on retry only after the exact pre-mutation marker", async () => {
    const cleanup = installMutableCleanup(
      cleanupFixture({
        status: WeleticVoucherCleanupStatus.retrying,
        attempts: 1,
        remoteVerifiedAt: new Date("2026-08-30T00:00:00.000Z"),
        remoteUsageCount: 0,
        remoteUsageObservedAt: new Date("2026-08-30T00:00:00.000Z"),
        remoteDeactivationStartedAt: new Date("2026-08-30T00:00:01.000Z"),
        remoteDeactivatedAt: new Date("2026-08-30T00:00:02.000Z"),
      }),
    );
    vi.mocked(lookupDiscountByCode).mockResolvedValue(null);

    await expect(execute()).resolves.toBe("verified_absent");

    expect(cleanup.status).toBe(WeleticVoucherCleanupStatus.completed);
    expect(cleanup.remoteOutcome).toBe("verified_absent");
    expect(deactivateDiscount).not.toHaveBeenCalled();
    expect(compensateDiscountSaga).toHaveBeenCalledOnce();
  });

  it("retains a retryable audit row when uninstall credentials are revoked", async () => {
    const cleanup = installMutableCleanup();
    vi.mocked(resolveShopifyOfflineCredentials).mockRejectedValue(
      new ShopifyDiscountError("AUTH_EXPIRED", "Offline token was revoked."),
    );

    await expect(execute()).rejects.toThrow("Offline token was revoked.");

    expect(cleanup.status).toBe(WeleticVoucherCleanupStatus.retrying);
    expect(cleanup.lastError).toBe("Offline token was revoked.");
    expect(deactivateDiscount).not.toHaveBeenCalled();
    expect(compensateDiscountSaga).not.toHaveBeenCalled();
  });

  it("fences duplicate delivery of the same outbox job with a distinct lease", async () => {
    installMutableCleanup();
    const applyUpdate = mocks.cleanupUpdateMany.getMockImplementation()!;
    let claimAttempts = 0;
    mocks.cleanupUpdateMany.mockImplementation(async (input: any) => {
      if (input.data.attempts?.increment) {
        claimAttempts++;
        if (claimAttempts > 1) return { count: 0 };
      }
      return applyUpdate(input);
    });

    const results = await Promise.allSettled([execute(), execute()]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejected = results.find(({ status }) => status === "rejected");
    expect(rejected).toEqual(
      expect.objectContaining({
        reason: expect.objectContaining({
          message: expect.stringContaining("owned by another worker"),
        }),
      }),
    );
    expect(deactivateDiscount).toHaveBeenCalledOnce();
    expect(compensateDiscountSaga).toHaveBeenCalledOnce();

    const fencedTransitions = mocks.cleanupUpdateMany.mock.calls
      .map(([input]) => input)
      .filter((input) => !input.data.attempts?.increment);
    expect(fencedTransitions.length).toBeGreaterThan(0);
    for (const transition of fencedTransitions) {
      expect(transition.where).toEqual(
        expect.objectContaining({ leaseVersion: 1 }),
      );
    }
  });

  it("fails closed when the lease is lost while recording a used voucher", async () => {
    installMutableCleanup();
    const applyUpdate = mocks.cleanupUpdateMany.getMockImplementation()!;
    mocks.cleanupUpdateMany.mockImplementation(async (input: any) => {
      if (input.data.remoteOutcome === "used_preserved") return { count: 0 };
      return applyUpdate(input);
    });
    mocks.redemptionFindUnique.mockResolvedValue(
      redemptionFixture({ status: WeleticRedemptionStatus.used }),
    );

    await expect(execute()).rejects.toThrow("lost its lease");

    expect(resolveShopifyOfflineCredentials).toHaveBeenCalledOnce();
    expect(deactivateDiscount).toHaveBeenCalledOnce();
    expect(compensateDiscountSaga).not.toHaveBeenCalled();
  });

  it("reopens a completed customer cleanup when uninstall links the stricter M:N policy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-30T01:00:00.000Z"));
    try {
      const redemption = {
        ...redemptionFixture({ shopifyDiscountId: discountId }),
        createdAt: new Date("2026-08-30T00:59:59.000Z"),
      };
      const existingCleanup = cleanupFixture({
        sourceRequestId: "older_customer_request",
        source: WeleticVoucherCleanupSource.customer_redact,
        status: WeleticVoucherCleanupStatus.completed,
        remoteUsageCount: 0,
        remoteUsageObservedAt: new Date("2026-08-30T00:59:30.000Z"),
        remoteDeactivationStartedAt: new Date("2026-08-30T00:59:31.000Z"),
        completedAt: new Date("2026-08-30T00:59:32.000Z"),
        remoteOutcome: "deactivated",
      });
      const mutableCleanup = installMutableCleanup(existingCleanup);
      let linked = false;
      mocks.storeFindUnique.mockResolvedValue({
        shopDomain: "privacy-cleanup.myshopify.com",
      });
      mocks.redemptionFindMany.mockResolvedValue([redemption]);
      mocks.cleanupLinkFindUnique.mockImplementation(async () =>
        linked ? { id: "wvclink_existing" } : null,
      );
      mocks.cleanupLinkUpsert.mockImplementation(async () => {
        linked = true;
        return { id: "wvclink_new" };
      });

      const first = await processStoreVoucherCleanupComplianceStep({
        requestId: "uninstall_request_new",
        storeId,
        shopDomain: "privacy-cleanup.myshopify.com",
        source: WeleticVoucherCleanupSource.app_uninstalled,
        phase: "enumerate_vouchers",
        cursor: null,
        progress: null,
        workerId: "worker_1",
      });
      expect(first.phase).toBe("enumerate_vouchers");
      expect(first.cursor).toEqual(
        expect.objectContaining({ sweep: 1, newLinksInSweep: 0 }),
      );

      vi.advanceTimersByTime(3 * 60_000);
      const second = await processStoreVoucherCleanupComplianceStep({
        requestId: "uninstall_request_new",
        storeId,
        shopDomain: "privacy-cleanup.myshopify.com",
        source: WeleticVoucherCleanupSource.app_uninstalled,
        phase: "enumerate_vouchers",
        cursor: first.cursor as any,
        progress: first.progress as any,
        workerId: "worker_1",
      });

      expect(second.phase).toBe("voucher_cleanup");
      expect(mocks.cleanupLinkUpsert).toHaveBeenCalledTimes(2);
      expect(mutableCleanup.sourceRequestId).toBe("older_customer_request");
      expect(mutableCleanup.source).toBe(
        WeleticVoucherCleanupSource.app_uninstalled,
      );
      expect(mutableCleanup.status).toBe(WeleticVoucherCleanupStatus.retrying);
      expect(mutableCleanup.completedAt).toBeNull();
      expect(mocks.enqueueOutbox).toHaveBeenCalledWith(
        expect.objectContaining({
          idempotencyKey: expect.stringContaining("usage-grace-v1"),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences an in-flight customer cleanup when uninstall escalates its shared policy", async () => {
    const redemption = redemptionFixture();
    const mutableCleanup = installMutableCleanup(
      cleanupFixture({
        source: WeleticVoucherCleanupSource.customer_redact,
        status: WeleticVoucherCleanupStatus.processing,
        leaseVersion: 7,
        lockedAt: new Date("2026-08-30T01:00:00.000Z"),
        lockedBy: "customer-worker",
      }),
    );
    mocks.cleanupLinkFindUnique.mockResolvedValue(null);
    mocks.cleanupLinkUpsert.mockResolvedValue({ id: "wvclink_strict" });

    await enqueueVoucherPrivacyCleanup({
      redemption,
      source: WeleticVoucherCleanupSource.app_uninstalled,
      sourceRequestId: "uninstall_request_strict",
    });

    expect(mocks.cleanupUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: WeleticVoucherCleanupStatus.processing,
          source: {
            in: [
              WeleticVoucherCleanupSource.customer_redact,
              WeleticVoucherCleanupSource.review_invalidation,
            ],
          },
        }),
        data: expect.objectContaining({
          source: WeleticVoucherCleanupSource.app_uninstalled,
          status: WeleticVoucherCleanupStatus.retrying,
          leaseVersion: { increment: 1 },
          lockedAt: null,
          lockedBy: null,
        }),
      }),
    );
    expect(mutableCleanup.source).toBe(
      WeleticVoucherCleanupSource.app_uninstalled,
    );
    expect(mutableCleanup.status).toBe(WeleticVoucherCleanupStatus.retrying);
    expect(mutableCleanup.leaseVersion).toBe(8);
  });

  it("aborts local compensation when a stricter source wins after the lease heartbeat", async () => {
    const mutableCleanup = installMutableCleanup();
    const applyUpdate = mocks.cleanupUpdateMany.getMockImplementation()!;
    let escalated = false;
    mocks.cleanupUpdateMany.mockImplementation(async (input: any) => {
      if (
        !escalated &&
        input.data.lockedAt instanceof Date &&
        Object.keys(input.data).length === 1
      ) {
        const result = await applyUpdate(input);
        mutableCleanup.source = WeleticVoucherCleanupSource.app_uninstalled;
        mutableCleanup.status = WeleticVoucherCleanupStatus.retrying;
        mutableCleanup.leaseVersion += 1;
        mutableCleanup.lockedAt = null;
        mutableCleanup.lockedBy = null;
        escalated = true;
        return result;
      }
      if (
        typeof input.where?.leaseVersion === "number" &&
        input.where.leaseVersion !== mutableCleanup.leaseVersion
      ) {
        return { count: 0 };
      }
      return applyUpdate(input);
    });

    await expect(execute()).rejects.toThrow("lost its lease");

    expect(escalated).toBe(true);
    expect(compensateDiscountSaga).not.toHaveBeenCalled();
    expect(mutableCleanup.source).toBe(
      WeleticVoucherCleanupSource.app_uninstalled,
    );
  });

  it("validates a cleanup request's tenant and lifecycle before linking it", async () => {
    mocks.sourceRequestFindUnique.mockResolvedValueOnce(null);

    await expect(
      enqueueVoucherPrivacyCleanup({
        redemption: redemptionFixture(),
        source: WeleticVoucherCleanupSource.shop_redact,
        sourceRequestId: "shop_request_from_another_store",
      }),
    ).rejects.toThrow("does not belong to the same Shopify store");

    expect(mocks.sourceRequestFindUnique).toHaveBeenCalledWith({
      where: {
        storeId_id: {
          storeId,
          id: "shop_request_from_another_store",
        },
      },
      select: { requestType: true },
    });
    expect(mocks.cleanupLinkUpsert).not.toHaveBeenCalled();
  });
});
