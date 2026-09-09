import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { appendPointsLedgerEntry } from "@/lib/weletic/loyalty/ledger";
import type { VoucherPrivacyCleanupPayload } from "@/lib/weletic/loyalty/outbox";
import { enqueueOutboxJob } from "@/lib/weletic/loyalty/outbox";
import {
  assertLoyaltyDiscountLookupMissIsTerminal,
  getLoyaltyDiscountOwnershipFingerprint,
  getPersistedLoyaltyDiscountProvisioningIdentity,
  LoyaltyDiscountReconciliationPendingError,
} from "@/lib/weletic/loyalty/redemption-discount-identity";
import { getReferralCouponPrivacyCleanupExpectation } from "@/lib/weletic/loyalty/referral-coupon";
import { compensateDiscountSaga } from "@/lib/weletic/loyalty/saga";
import {
  deactivateDiscount,
  formatShopifyGid,
  lookupDiscountByCode,
  resolveShopifyOfflineCredentials,
  ShopifyDiscountError,
} from "@/lib/weletic/loyalty/shopify-discounts";
import { readFrozenStoreOwnedVoucherCredential } from "@/lib/weletic/shopify/store-owned-credential";
import { normalizeShopDomain } from "@/lib/weletic/shopify/store-resolver";
import {
  Prisma,
  WeleticPointsLedgerEntryType,
  WeleticRedemptionStatus,
  WeleticShopifyVoucherCleanup,
  WeleticVoucherCleanupSource,
  WeleticVoucherCleanupStatus,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  assertAccountBackedReward,
  DIRECT_REVIEW_REWARD_SOURCE,
} from "./reward-ownership";

const VOUCHER_CLEANUP_BATCH_SIZE = 100;
const VOUCHER_CLEANUP_MAX_ATTEMPTS = 10;
const VOUCHER_CLEANUP_LEASE_TIMEOUT_MS = 5 * 60_000;
const VOUCHER_USAGE_RECONCILIATION_GRACE_MS = 2 * 60_000;
const VOUCHER_ENUMERATION_DRAIN_GRACE_MS = 2 * 60_000;

const LegacyVoucherCleanupOwnershipSnapshotSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(["generic", "referral", "unverifiable"]),
    expectedCode: z.string().min(1),
    expectedTitle: z.string().nullable(),
    ownershipFingerprint: z.string().nullable(),
    remoteProvisionAttemptedAt: z.string().datetime().nullable(),
    remoteProvisionReconcileUntil: z.string().datetime().nullable(),
    captureError: z.string().nullable(),
  })
  .strict();

const ShopperVoucherCleanupOwnershipSnapshotSchema =
  LegacyVoucherCleanupOwnershipSnapshotSchema.extend({
    version: z.literal(2),
    kind: z.literal("shopper"),
    shopperId: z.string().min(1),
    claimId: z.string().min(1),
    installationGeneration: z.string().min(1).max(64),
  }).strict();
const VoucherCleanupOwnershipSnapshotSchema = z.union([
  LegacyVoucherCleanupOwnershipSnapshotSchema,
  ShopperVoucherCleanupOwnershipSnapshotSchema,
]);

type VoucherCleanupOwnershipSnapshot = z.infer<
  typeof VoucherCleanupOwnershipSnapshotSchema
>;

type VoucherCleanupRedemption = {
  id: string;
  storeId: string;
  accountId: string | null;
  shopperId?: string | null;
  fulfillmentSource?: string | null;
  fulfillmentReference?: string | null;
  ledgerEntryId?: string | null;
  artifactKind?: string;
  rewardDefinitionId: string;
  status: WeleticRedemptionStatus;
  pointsSpent: bigint;
  shopifyDiscountCode: string;
  shopifyDiscountId: string | null;
  expiresAt: Date | null;
  metadata: Prisma.JsonValue;
};

export type VoucherPrivacyCleanupOutcome =
  | "deactivated"
  | "verified_absent"
  | "used_preserved"
  | "manual_reconciliation";

export class VoucherCleanupManualReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoucherCleanupManualReconciliationError";
  }
}

export class VoucherCleanupRetryableError extends Error {
  constructor(
    message: string,
    public retryAt?: Date,
  ) {
    super(message);
    this.name = "VoucherCleanupRetryableError";
  }
}

function normalizeDiscountCode(value: string) {
  return value.trim().toUpperCase();
}

const VOUCHER_CLEANUP_SOURCE_RANK: Record<WeleticVoucherCleanupSource, number> =
  {
    [WeleticVoucherCleanupSource.customer_redact]: 0,
    [WeleticVoucherCleanupSource.review_invalidation]: 1,
    [WeleticVoucherCleanupSource.app_uninstalled]: 2,
    [WeleticVoucherCleanupSource.shop_redact]: 3,
  };

function stricterVoucherCleanupSources(source: WeleticVoucherCleanupSource) {
  const rank = VOUCHER_CLEANUP_SOURCE_RANK[source];
  return Object.values(WeleticVoucherCleanupSource).filter(
    (candidate) => VOUCHER_CLEANUP_SOURCE_RANK[candidate] < rank,
  );
}

function voucherCleanupOutboxPolicyKey({
  cleanupId,
  source,
}: {
  cleanupId: string;
  source: WeleticVoucherCleanupSource;
}) {
  return `voucher_privacy_cleanup:${cleanupId}:policy:${
    source === WeleticVoucherCleanupSource.customer_redact
      ? "base-v1"
      : "usage-grace-v1"
  }`;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readOptionalIsoTimestamp(
  value: unknown,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string" ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new Error(`${field} is not a valid timestamp.`);
  }
  return new Date(value).toISOString();
}

function isShopperCleanup(redemption: VoucherCleanupRedemption) {
  return redemption.accountId === null || redemption.fulfillmentSource != null;
}

function assertShopperCleanupReward(
  redemption: VoucherCleanupRedemption,
): asserts redemption is VoucherCleanupRedemption & {
  shopperId: string;
  fulfillmentSource: string;
  fulfillmentReference: string;
} {
  if (
    redemption.accountId !== null ||
    !redemption.shopperId ||
    redemption.fulfillmentSource !== DIRECT_REVIEW_REWARD_SOURCE ||
    !redemption.fulfillmentReference ||
    redemption.pointsSpent !== BigInt(0) ||
    redemption.ledgerEntryId !== null ||
    redemption.artifactKind !== "discount_code"
  )
    throw new VoucherCleanupManualReconciliationError(
      "Invalid direct shopper voucher ownership; points compensation is forbidden.",
    );
}

async function lockCleanupStore(tx: Prisma.TransactionClient, storeId: string) {
  // Cleanup is allowed while frozen, but never against a different installation.
  // Use the same store-first lock order as provisioning and reinstall.
  const rows = await tx.$queryRaw<
    Array<{ id: string; installationGeneration: string | null }>
  >(Prisma.sql`
    SELECT id, installationGeneration FROM WeleticShopifyStore
    WHERE id = ${storeId} LIMIT 1 FOR UPDATE
  `);
  if (!rows[0])
    throw new VoucherCleanupManualReconciliationError(
      "Shopper voucher store is unavailable.",
    );
  return rows[0];
}

function assertShopperSnapshotOwner(
  redemption: VoucherCleanupRedemption,
  snapshot: VoucherCleanupOwnershipSnapshot,
) {
  assertShopperCleanupReward(redemption);
  if (
    snapshot.kind !== "shopper" ||
    snapshot.shopperId !== redemption.shopperId ||
    snapshot.claimId !== redemption.fulfillmentReference ||
    snapshot.ownershipFingerprint !==
      getLoyaltyDiscountOwnershipFingerprint({
        storeId: redemption.storeId,
        redemptionId: redemption.id,
        ownerKind: "shopper",
        shopperId: redemption.shopperId,
        fulfillmentSource: redemption.fulfillmentSource,
        fulfillmentReference: redemption.fulfillmentReference,
        rewardDefinitionId: redemption.rewardDefinitionId,
        discountCode: redemption.shopifyDiscountCode,
      })
  )
    throw new VoucherCleanupManualReconciliationError(
      "Shopper cleanup ownership snapshot changed.",
    );
}

async function withShopperCleanupFence<T>({
  cleanup,
  snapshot,
  lockOwner,
  leaseVersion,
  operation,
  tx: existingTx,
}: {
  cleanup: WeleticShopifyVoucherCleanup;
  snapshot: VoucherCleanupOwnershipSnapshot;
  lockOwner: string;
  leaseVersion: number;
  operation: (tx?: Prisma.TransactionClient) => Promise<T>;
  tx?: Prisma.TransactionClient;
}): Promise<T> {
  if (snapshot.kind !== "shopper") return operation();
  // No automatic transaction retry around provider I/O. Each call rechecks the
  // durable owner, quarantine, generation and winning lease before using tokens.
  const run = async (tx: Prisma.TransactionClient) => {
    const store = await lockCleanupStore(tx, cleanup.storeId);
    if (store.installationGeneration !== snapshot.installationGeneration)
      throw new VoucherCleanupManualReconciliationError(
        "Shopper voucher cleanup belongs to an earlier installation.",
      );
    const redemption = await tx.weleticRewardRedemption.findUnique({
      where: { id: cleanup.redemptionId },
    });
    if (
      !redemption ||
      redemption.storeId !== cleanup.storeId ||
      !redemption.settlementQuarantinedAt
    )
      throw new VoucherCleanupManualReconciliationError(
        "Shopper voucher is not durably quarantined for cleanup.",
      );
    assertShopperSnapshotOwner(redemption, snapshot);
    const leases = await tx.$queryRaw<VoucherCleanupLeaseRow[]>(Prisma.sql`
      SELECT id, storeId, source, status, lockedBy, leaseVersion
      FROM WeleticShopifyVoucherCleanup WHERE id = ${cleanup.id} LIMIT 1 FOR UPDATE
    `);
    const lease = leases[0];
    if (
      !lease ||
      lease.storeId !== cleanup.storeId ||
      lease.source !== cleanup.source ||
      lease.status !== "processing" ||
      lease.lockedBy !== lockOwner ||
      lease.leaseVersion !== leaseVersion
    )
      throw new VoucherCleanupRetryableError(
        "Shopper voucher cleanup lost its lease before the fenced operation.",
      );
    return operation(tx);
  };
  if (existingTx) return run(existingTx);
  return prisma.$transaction(run, {
    maxWait: 10_000,
    timeout: 120_000,
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });
}

function createOwnershipSnapshot(
  redemption: VoucherCleanupRedemption,
): VoucherCleanupOwnershipSnapshot {
  try {
    if (isShopperCleanup(redemption)) {
      assertShopperCleanupReward(redemption);
      const metadata = readObject(redemption.metadata);
      const direct = readObject(metadata?.directFulfillment);
      if (
        direct?.version !== 1 ||
        direct.claimId !== redemption.fulfillmentReference
      )
        throw new Error("Shopper coupon has no immutable claim identity.");
      const identity = getPersistedLoyaltyDiscountProvisioningIdentity({
        identity: {
          storeId: redemption.storeId,
          redemptionId: redemption.id,
          ownerKind: "shopper",
          shopperId: redemption.shopperId,
          fulfillmentSource: redemption.fulfillmentSource,
          fulfillmentReference: redemption.fulfillmentReference,
          rewardDefinitionId: redemption.rewardDefinitionId,
          discountCode: redemption.shopifyDiscountCode,
        },
        metadata: redemption.metadata,
      });
      if (identity?.version !== 2)
        throw new Error("Shopper coupon ownership is unverifiable.");
      return ShopperVoucherCleanupOwnershipSnapshotSchema.parse({
        version: 2,
        kind: "shopper",
        shopperId: redemption.shopperId,
        claimId: redemption.fulfillmentReference,
        installationGeneration: direct.installationGeneration,
        expectedCode: normalizeDiscountCode(redemption.shopifyDiscountCode),
        expectedTitle: identity.expectedTitle,
        ownershipFingerprint: identity.fingerprint,
        remoteProvisionAttemptedAt: readOptionalIsoTimestamp(
          metadata?.remoteProvisionAttemptedAt,
          "remoteProvisionAttemptedAt",
        ),
        remoteProvisionReconcileUntil: readOptionalIsoTimestamp(
          metadata?.remoteProvisionReconcileUntil,
          "remoteProvisionReconcileUntil",
        ),
        captureError: null,
      });
    }
    assertAccountBackedReward(redemption);
    const referral = getReferralCouponPrivacyCleanupExpectation(redemption);
    if (referral) {
      return {
        version: 1,
        kind: "referral",
        expectedCode: normalizeDiscountCode(referral.expectedCode),
        expectedTitle: referral.expectedTitle,
        ownershipFingerprint: referral.ownershipFingerprint,
        remoteProvisionAttemptedAt: readOptionalIsoTimestamp(
          referral.remoteProvisionAttemptedAt,
          "remoteProvisionAttemptedAt",
        ),
        remoteProvisionReconcileUntil: readOptionalIsoTimestamp(
          referral.remoteProvisionReconcileUntil,
          "remoteProvisionReconcileUntil",
        ),
        captureError: null,
      };
    }

    const identity = getPersistedLoyaltyDiscountProvisioningIdentity({
      identity: {
        storeId: redemption.storeId,
        redemptionId: redemption.id,
        accountId: redemption.accountId,
        rewardDefinitionId: redemption.rewardDefinitionId,
        discountCode: redemption.shopifyDiscountCode,
      },
      metadata: redemption.metadata,
    });
    const metadata = readObject(redemption.metadata);
    if (!identity) {
      return {
        version: 1,
        kind: "unverifiable",
        expectedCode: normalizeDiscountCode(redemption.shopifyDiscountCode),
        expectedTitle: null,
        ownershipFingerprint: null,
        remoteProvisionAttemptedAt: readOptionalIsoTimestamp(
          metadata?.remoteProvisionAttemptedAt,
          "remoteProvisionAttemptedAt",
        ),
        remoteProvisionReconcileUntil: readOptionalIsoTimestamp(
          metadata?.remoteProvisionReconcileUntil,
          "remoteProvisionReconcileUntil",
        ),
        captureError:
          "Redemption has no immutable Shopify discount ownership identity.",
      };
    }
    return {
      version: 1,
      kind: "generic",
      expectedCode: normalizeDiscountCode(redemption.shopifyDiscountCode),
      expectedTitle: identity.expectedTitle,
      ownershipFingerprint: identity.fingerprint,
      remoteProvisionAttemptedAt: readOptionalIsoTimestamp(
        metadata?.remoteProvisionAttemptedAt,
        "remoteProvisionAttemptedAt",
      ),
      remoteProvisionReconcileUntil: readOptionalIsoTimestamp(
        metadata?.remoteProvisionReconcileUntil,
        "remoteProvisionReconcileUntil",
      ),
      captureError: null,
    };
  } catch (error) {
    const metadata = readObject(redemption.metadata);
    return {
      version: 1,
      kind: "unverifiable",
      expectedCode: normalizeDiscountCode(redemption.shopifyDiscountCode),
      expectedTitle: null,
      ownershipFingerprint: null,
      remoteProvisionAttemptedAt:
        typeof metadata?.remoteProvisionAttemptedAt === "string"
          ? metadata.remoteProvisionAttemptedAt
          : null,
      remoteProvisionReconcileUntil:
        typeof metadata?.remoteProvisionReconcileUntil === "string"
          ? metadata.remoteProvisionReconcileUntil
          : null,
      captureError:
        error instanceof Error
          ? error.message
          : "Immutable Shopify ownership identity could not be captured.",
    };
  }
}

function assertExistingCleanupMatches({
  cleanup,
  redemption,
}: {
  cleanup: {
    storeId: string;
    redemptionId: string;
    expectedDiscountCodeCanonical: string;
    expectedDiscountId: string | null;
  };
  redemption: VoucherCleanupRedemption;
}) {
  const persistedDiscountId = redemption.shopifyDiscountId
    ? formatShopifyGid("DiscountCodeNode", redemption.shopifyDiscountId)
    : null;
  if (
    cleanup.storeId !== redemption.storeId ||
    cleanup.redemptionId !== redemption.id ||
    cleanup.expectedDiscountCodeCanonical !==
      normalizeDiscountCode(redemption.shopifyDiscountCode) ||
    (cleanup.expectedDiscountId &&
      persistedDiscountId &&
      cleanup.expectedDiscountId !== persistedDiscountId)
  ) {
    throw new Error(
      `Voucher cleanup identity changed for redemption ${redemption.id}.`,
    );
  }
}

export async function enqueueVoucherPrivacyCleanup({
  redemption,
  source,
  sourceRequestId,
  tx,
}: {
  redemption: VoucherCleanupRedemption;
  source: WeleticVoucherCleanupSource;
  sourceRequestId?: string | null;
  tx?: Prisma.TransactionClient;
}): Promise<
  (WeleticShopifyVoucherCleanup & { requestLinkCreated: boolean }) | null
> {
  if (!tx) {
    return prisma.$transaction((transaction) =>
      enqueueVoucherPrivacyCleanup({
        redemption,
        source,
        sourceRequestId,
        tx: transaction,
      }),
    );
  }

  const db = tx;
  if (source === WeleticVoucherCleanupSource.review_invalidation) {
    if (sourceRequestId)
      throw new Error("Review invalidation is not a compliance request");
    assertShopperCleanupReward(redemption);
    const decision = await db.weleticReviewIncentiveInvalidation.findUnique({
      where: {
        storeId_claimId: {
          storeId: redemption.storeId,
          claimId: redemption.fulfillmentReference,
        },
      },
    });
    const claim = await db.weleticReviewIncentiveClaim.findFirst({
      where: {
        id: redemption.fulfillmentReference,
        storeId: redemption.storeId,
        shopperId: redemption.shopperId,
        status: "invalidated",
      },
    });
    const snapshot = readObject(decision?.decisionSnapshot);
    if (
      !decision ||
      !claim ||
      decision.shopperId !== redemption.shopperId ||
      decision.outcome !== "pending" ||
      snapshot?.redemptionId !== redemption.id
    )
      throw new VoucherCleanupManualReconciliationError(
        "Confirmed coupon invalidation is unavailable",
      );
  }
  if (isShopperCleanup(redemption)) {
    await lockCleanupStore(tx, redemption.storeId);
    const current = await db.weleticRewardRedemption.findUnique({
      where: { id: redemption.id },
    });
    if (
      !current ||
      current.storeId !== redemption.storeId ||
      current.shopperId !== redemption.shopperId
    )
      throw new VoucherCleanupManualReconciliationError(
        "Shopper cleanup owner changed before snapshot capture.",
      );
    // Capture the current attempted-create evidence, not a stale enumeration
    // copy. Provisioning holds this same store lock across prepare and remote I/O.
    redemption = current;
    if (!current.shopperId)
      throw new VoucherCleanupManualReconciliationError(
        "Shopper cleanup has no recipient.",
      );
    await db.weleticRewardRedemption.updateMany({
      where: { id: current.id, storeId: current.storeId },
      data: {
        settlementQuarantinedAt: current.settlementQuarantinedAt ?? new Date(),
        settlementQuarantineReason:
          source === "review_invalidation"
            ? "Confirmed review incentive recovery pending."
            : "Shopper voucher privacy cleanup pending.",
      },
    });
    await db.weleticLoyaltyOutboxJob.updateMany({
      where: {
        storeId: current.storeId,
        jobType: "SHOPPER_REWARD_PROVISION",
        idempotencyKey: `shopper_reward_provision:${current.id}`,
        status: { in: ["pending", "processing", "failed"] },
      },
      data: { status: "cancelled", lockedAt: null, lockedBy: null },
    });
  }
  if (sourceRequestId) {
    const expectedRequestType =
      source === WeleticVoucherCleanupSource.customer_redact
        ? "customer_redact"
        : source === WeleticVoucherCleanupSource.app_uninstalled
          ? "app_uninstalled"
          : "shop_redact";
    const sourceRequest = await db.weleticShopifyComplianceRequest.findUnique({
      where: {
        storeId_id: { storeId: redemption.storeId, id: sourceRequestId },
      },
      select: { requestType: true },
    });
    if (!sourceRequest || sourceRequest.requestType !== expectedRequestType) {
      throw new Error(
        "Voucher cleanup source request does not belong to the same Shopify store and lifecycle.",
      );
    }
  }
  const existing = await db.weleticShopifyVoucherCleanup.findUnique({
    where: {
      storeId_redemptionId: {
        storeId: redemption.storeId,
        redemptionId: redemption.id,
      },
    },
  });
  let cleanup = existing;
  const existingRequestLink =
    cleanup && sourceRequestId
      ? await db.weleticShopifyVoucherCleanupRequestLink.findUnique({
          where: {
            requestId_cleanupId: {
              requestId: sourceRequestId,
              cleanupId: cleanup.id,
            },
          },
          select: { id: true },
        })
      : null;
  if (cleanup) {
    assertExistingCleanupMatches({ cleanup, redemption });
    const previousSource = cleanup.source;
    const lowerPrioritySources = stricterVoucherCleanupSources(source);
    if (lowerPrioritySources.length > 0) {
      // Escalating a cleanup that is already in flight must fence the old
      // policy generation. Otherwise a customer-redact worker can pass its
      // no-grace decision, refund points, and mark the shared row completed
      // after uninstall/shop-redact has linked the stricter policy.
      await db.weleticShopifyVoucherCleanup.updateMany({
        where: {
          id: cleanup.id,
          storeId: redemption.storeId,
          redemptionId: redemption.id,
          source: { in: lowerPrioritySources },
          status: WeleticVoucherCleanupStatus.processing,
        },
        data: {
          source,
          status: WeleticVoucherCleanupStatus.retrying,
          leaseVersion: { increment: 1 },
          lockedAt: null,
          lockedBy: null,
          nextRetryAt: new Date(),
          lastError: null,
        },
      });
      await db.weleticShopifyVoucherCleanup.updateMany({
        where: {
          id: cleanup.id,
          storeId: redemption.storeId,
          redemptionId: redemption.id,
          source: { in: lowerPrioritySources },
        },
        data: { source },
      });
    }

    // A customer-redact cleanup can have completed before a later uninstall or
    // shop-redact request links it. Reopen a zero-usage deactivation exactly
    // once for the new strict request, so credential scrubbing cannot pass the
    // request-scoped M:N gate before the authoritative grace recheck.
    if (
      source !== WeleticVoucherCleanupSource.customer_redact &&
      !requiresUsageReconciliationGrace(previousSource) &&
      sourceRequestId &&
      !existingRequestLink
    ) {
      await db.weleticShopifyVoucherCleanup.updateMany({
        where: {
          id: cleanup.id,
          storeId: redemption.storeId,
          redemptionId: redemption.id,
          status: WeleticVoucherCleanupStatus.completed,
          source: {
            in: [
              WeleticVoucherCleanupSource.app_uninstalled,
              WeleticVoucherCleanupSource.shop_redact,
            ],
          },
          remoteUsageCount: 0,
          remoteUsageObservedAt: { not: null },
          remoteDeactivatedAt: { not: null },
        },
        data: {
          status: WeleticVoucherCleanupStatus.retrying,
          completedAt: null,
          nextRetryAt: new Date(),
          remoteOutcome: "deactivated_pending_usage_reconciliation",
          lastError: null,
        },
      });
    }
    cleanup =
      (await db.weleticShopifyVoucherCleanup.findUnique({
        where: { id: cleanup.id },
      })) ?? cleanup;
  } else {
    const ownershipSnapshot = createOwnershipSnapshot(redemption);
    cleanup = await db.weleticShopifyVoucherCleanup.create({
      data: {
        id: createWeleticId("wvclean_"),
        storeId: redemption.storeId,
        redemptionId: redemption.id,
        sourceRequestId: sourceRequestId ?? null,
        source,
        status: WeleticVoucherCleanupStatus.pending,
        expectedDiscountCode: redemption.shopifyDiscountCode,
        expectedDiscountCodeCanonical: normalizeDiscountCode(
          redemption.shopifyDiscountCode,
        ),
        expectedDiscountId: redemption.shopifyDiscountId
          ? formatShopifyGid("DiscountCodeNode", redemption.shopifyDiscountId)
          : null,
        ownershipSnapshot: ownershipSnapshot as Prisma.InputJsonValue,
        maxAttempts: VOUCHER_CLEANUP_MAX_ATTEMPTS,
      },
    });
  }

  let requestLinkCreated = false;
  if (sourceRequestId) {
    requestLinkCreated = !existingRequestLink;
    await db.weleticShopifyVoucherCleanupRequestLink.upsert({
      where: {
        requestId_cleanupId: {
          requestId: sourceRequestId,
          cleanupId: cleanup.id,
        },
      },
      create: {
        id: createWeleticId("wvclink_"),
        storeId: redemption.storeId,
        requestId: sourceRequestId,
        cleanupId: cleanup.id,
      },
      update: {},
    });
  }

  await enqueueOutboxJob({
    storeId: redemption.storeId,
    jobType: "VOUCHER_PRIVACY_CLEANUP",
    payload: {
      cleanupId: cleanup.id,
      redemptionId: redemption.id,
      ...(isShopperCleanup(redemption)
        ? { ownerKind: "shopper" as const, shopperId: redemption.shopperId! }
        : { accountId: redemption.accountId! }),
    },
    idempotencyKey: voucherCleanupOutboxPolicyKey({
      cleanupId: cleanup.id,
      source: cleanup.source,
    }),
    maxAttempts: cleanup.maxAttempts,
    priority: 100,
    tx,
  });
  return { ...cleanup, requestLinkCreated };
}

type VoucherEnumerationPosition = {
  afterCreatedAt?: Date;
  afterRedemptionId?: string;
};

function redemptionPositionWhere({
  afterCreatedAt,
  afterRedemptionId,
}: VoucherEnumerationPosition) {
  return afterCreatedAt && afterRedemptionId
    ? {
        OR: [
          { createdAt: { gt: afterCreatedAt } },
          { createdAt: afterCreatedAt, id: { gt: afterRedemptionId } },
        ],
      }
    : {};
}

export async function enqueueVoucherPrivacyCleanupsForAccount({
  storeId,
  accountId,
  shopperId,
  sourceRequestId,
}: {
  storeId: string;
  accountId?: string | null;
  shopperId?: string | null;
  sourceRequestId?: string | null;
}) {
  let scanned = 0;
  let enqueued = 0;
  let position: VoucherEnumerationPosition = {};
  do {
    const page = await enqueueVoucherPrivacyCleanupsForAccountPage({
      storeId,
      accountId,
      shopperId,
      sourceRequestId,
      ...position,
    });
    scanned += page.scanned;
    enqueued += page.enqueued;
    position = page.nextPosition ?? {};
  } while (position.afterCreatedAt && position.afterRedemptionId);
  return { scanned, enqueued };
}

export async function enqueueVoucherPrivacyCleanupsForAccountPage({
  storeId,
  accountId,
  shopperId,
  sourceRequestId,
  afterCreatedAt,
  afterRedemptionId,
  take = VOUCHER_CLEANUP_BATCH_SIZE,
}: {
  storeId: string;
  accountId?: string | null;
  shopperId?: string | null;
  sourceRequestId?: string | null;
  afterCreatedAt?: Date;
  afterRedemptionId?: string;
  take?: number;
}) {
  if (!accountId && !shopperId)
    throw new Error("Voucher enumeration requires a customer owner.");
  const redemptions = await prisma.weleticRewardRedemption.findMany({
    where: {
      storeId,
      AND: [
        {
          OR: [
            ...(accountId ? [{ accountId }] : []),
            ...(shopperId ? [{ accountId: null, shopperId }] : []),
          ],
        },
        redemptionPositionWhere({ afterCreatedAt, afterRedemptionId }),
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take,
  });
  let enqueued = 0;
  let newLinks = 0;
  for (const redemption of redemptions) {
    await prisma.$transaction(async (tx) => {
      const cleanup = await enqueueVoucherPrivacyCleanup({
        redemption,
        source: WeleticVoucherCleanupSource.customer_redact,
        sourceRequestId,
        tx,
      });
      if (cleanup) {
        enqueued++;
        if (cleanup.requestLinkCreated) newLinks++;
      }
    });
  }
  const last = redemptions.at(-1);
  return {
    scanned: redemptions.length,
    enqueued,
    newLinks,
    nextPosition:
      redemptions.length === take && last
        ? { afterCreatedAt: last.createdAt, afterRedemptionId: last.id }
        : undefined,
  };
}

export async function enqueueVoucherPrivacyCleanupsForStorePage({
  storeId,
  sourceRequestId,
  source,
  afterCreatedAt,
  afterRedemptionId,
  take = VOUCHER_CLEANUP_BATCH_SIZE,
}: {
  storeId: string;
  sourceRequestId: string;
  source: WeleticVoucherCleanupSource;
  afterCreatedAt?: Date;
  afterRedemptionId?: string;
  take?: number;
}) {
  const redemptions = await prisma.weleticRewardRedemption.findMany({
    where: {
      storeId,
      ...redemptionPositionWhere({ afterCreatedAt, afterRedemptionId }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take,
  });
  let newLinks = 0;
  for (const redemption of redemptions) {
    await prisma.$transaction(async (tx) => {
      const cleanup = await enqueueVoucherPrivacyCleanup({
        redemption,
        source,
        sourceRequestId,
        tx,
      });
      if (cleanup?.requestLinkCreated) newLinks++;
    });
  }
  const last = redemptions.at(-1);
  return {
    scanned: redemptions.length,
    newLinks,
    nextPosition:
      redemptions.length === take && last
        ? { afterCreatedAt: last.createdAt, afterRedemptionId: last.id }
        : undefined,
  };
}

function completedRedemptionMetadata({
  cleanupId,
  source,
  outcome,
  ownershipSnapshot,
  completedAt,
}: {
  cleanupId: string;
  source: WeleticVoucherCleanupSource;
  outcome: Exclude<
    VoucherPrivacyCleanupOutcome,
    "manual_reconciliation" | "used_preserved"
  >;
  ownershipSnapshot: VoucherCleanupOwnershipSnapshot;
  completedAt: Date;
}): Prisma.InputJsonObject {
  return {
    privacySafeCancellation: true,
    voucherPrivacyCleanup: {
      version: 1,
      cleanupId,
      source,
      outcome,
      completedAt: completedAt.toISOString(),
      ownershipFingerprint: ownershipSnapshot.ownershipFingerprint,
    },
  } as Prisma.InputJsonObject;
}

function usedRedemptionMetadata({
  cleanupId,
  source,
  ownershipSnapshot,
  remoteUsageCount,
  observedAt,
}: {
  cleanupId: string;
  source: WeleticVoucherCleanupSource;
  ownershipSnapshot: VoucherCleanupOwnershipSnapshot;
  remoteUsageCount: number;
  observedAt: Date;
}): Prisma.InputJsonObject {
  return {
    privacySafeFinancialAudit: true,
    voucherPrivacyCleanup: {
      version: 1,
      cleanupId,
      source,
      outcome: "used_preserved",
      remoteUsageCount,
      remoteUsageObservedAt: observedAt.toISOString(),
      ownershipFingerprint: ownershipSnapshot.ownershipFingerprint,
    },
  } as Prisma.InputJsonObject;
}

function assertRemoteOwnership({
  cleanupId,
  expectedCode,
  expectedTitle,
  expectedDiscountId,
  remote,
}: {
  cleanupId: string;
  expectedCode: string;
  expectedTitle: string | null;
  expectedDiscountId: string | null;
  remote: { id: string; code: string; title: string };
}) {
  if (!expectedTitle) {
    throw new VoucherCleanupManualReconciliationError(
      `Voucher cleanup ${cleanupId} has no immutable Shopify ownership title.`,
    );
  }
  if (
    normalizeDiscountCode(remote.code) !== expectedCode ||
    remote.title !== expectedTitle ||
    (expectedDiscountId && remote.id !== expectedDiscountId)
  ) {
    throw new VoucherCleanupManualReconciliationError(
      `Shopify voucher ownership mismatch for cleanup ${cleanupId}.`,
    );
  }
}

function getRetryAtFromSnapshot(
  snapshot: VoucherCleanupOwnershipSnapshot,
): Date | undefined {
  if (!snapshot.remoteProvisionReconcileUntil) return undefined;
  const retryAt = new Date(snapshot.remoteProvisionReconcileUntil);
  return Number.isFinite(retryAt.getTime()) ? retryAt : undefined;
}

async function finalizeLocalCancellation({
  cleanup,
  snapshot,
  outcome,
  tx,
}: {
  cleanup: {
    id: string;
    storeId: string;
    redemptionId: string;
    source: WeleticVoucherCleanupSource;
  };
  snapshot: VoucherCleanupOwnershipSnapshot;
  outcome: "deactivated" | "verified_absent";
  tx: Prisma.TransactionClient;
}) {
  const current = await tx.weleticRewardRedemption.findUnique({
    where: { id: cleanup.redemptionId },
  });
  if (!current || current.storeId !== cleanup.storeId) {
    throw new VoucherCleanupManualReconciliationError(
      `Redemption ${cleanup.redemptionId} is unavailable for privacy-safe cancellation.`,
    );
  }
  if (isShopperCleanup(current)) assertShopperSnapshotOwner(current, snapshot);
  if (current.status === WeleticRedemptionStatus.used) {
    return finalizeLocalUsedPreservation({
      cleanup,
      snapshot,
      remoteUsageCount: 0,
      observedAt: new Date(),
      tx,
    });
  }

  if (
    current.status === WeleticRedemptionStatus.provisioning ||
    current.status === WeleticRedemptionStatus.issued ||
    current.status === WeleticRedemptionStatus.active
  ) {
    if (current.pointsSpent > BigInt(0)) {
      await compensateDiscountSaga({
        redemptionId: current.id,
        reason: "Unused voucher cancelled after privacy or uninstall cleanup.",
        targetStatus: WeleticRedemptionStatus.cancelled,
        tx,
      });
    } else {
      const cancelled = await tx.weleticRewardRedemption.updateMany({
        where: {
          id: current.id,
          storeId: cleanup.storeId,
          status: {
            in: [
              WeleticRedemptionStatus.provisioning,
              WeleticRedemptionStatus.issued,
              WeleticRedemptionStatus.active,
            ],
          },
        },
        data: {
          status: WeleticRedemptionStatus.cancelled,
          compensationReason:
            cleanup.source === "review_invalidation"
              ? "Unused zero-cost voucher cancelled after confirmed review invalidation."
              : "Unused zero-cost voucher cancelled after privacy or uninstall cleanup.",
        },
      });
      if (cancelled.count !== 1) {
        const latest = await tx.weleticRewardRedemption.findUnique({
          where: { id: current.id },
          select: { status: true },
        });
        if (latest?.status === WeleticRedemptionStatus.used) {
          return "used_preserved" as const;
        }
        throw new VoucherCleanupRetryableError(
          `Redemption ${current.id} changed during privacy-safe cancellation.`,
        );
      }
    }
  }

  const completedAt = new Date();
  await tx.weleticRewardRedemption.updateMany({
    where: {
      id: current.id,
      storeId: cleanup.storeId,
      status: { not: WeleticRedemptionStatus.used },
    },
    data: {
      metadata: completedRedemptionMetadata({
        cleanupId: cleanup.id,
        source: cleanup.source,
        outcome,
        ownershipSnapshot: snapshot,
        completedAt,
      }),
    },
  });
  return outcome;
}

async function finalizeLocalUsedPreservation({
  cleanup,
  snapshot,
  remoteUsageCount,
  observedAt,
  tx,
}: {
  cleanup: {
    id: string;
    storeId: string;
    redemptionId: string;
    source: WeleticVoucherCleanupSource;
  };
  snapshot: VoucherCleanupOwnershipSnapshot;
  remoteUsageCount: number;
  observedAt: Date;
  tx: Prisma.TransactionClient;
}): Promise<"used_preserved"> {
  const current = await tx.weleticRewardRedemption.findUnique({
    where: { id: cleanup.redemptionId },
  });
  if (!current || current.storeId !== cleanup.storeId) {
    throw new VoucherCleanupManualReconciliationError(
      `Redemption ${cleanup.redemptionId} is unavailable for used-voucher preservation.`,
    );
  }
  if (isShopperCleanup(current)) assertShopperSnapshotOwner(current, snapshot);
  if (current.status === WeleticRedemptionStatus.used) {
    await tx.weleticRewardRedemption.updateMany({
      where: { id: current.id, storeId: cleanup.storeId, status: "used" },
      data: {
        metadata: usedRedemptionMetadata({
          cleanupId: cleanup.id,
          source: cleanup.source,
          ownershipSnapshot: snapshot,
          remoteUsageCount,
          observedAt,
        }),
      },
    });
    return "used_preserved";
  }
  if (
    current.status === WeleticRedemptionStatus.cancelled ||
    current.status === WeleticRedemptionStatus.expired ||
    current.status === WeleticRedemptionStatus.failed
  ) {
    const latest = await tx.weleticRewardRedemption.findUnique({
      where: { id: current.id },
    });
    if (!latest || latest.storeId !== cleanup.storeId) {
      throw new VoucherCleanupManualReconciliationError(
        `Redemption ${current.id} is unavailable for late-usage correction.`,
      );
    }
    if (latest.status === WeleticRedemptionStatus.used) return "used_preserved";
    if (
      latest.status !== WeleticRedemptionStatus.cancelled &&
      latest.status !== WeleticRedemptionStatus.expired &&
      latest.status !== WeleticRedemptionStatus.failed
    ) {
      throw new VoucherCleanupRetryableError(
        `Redemption ${current.id} changed during late-usage correction.`,
      );
    }

    const corrected = await tx.weleticRewardRedemption.updateMany({
      where: {
        id: latest.id,
        storeId: cleanup.storeId,
        status: latest.status,
      },
      data: {
        status: WeleticRedemptionStatus.used,
        usedAt: observedAt,
        metadata: usedRedemptionMetadata({
          cleanupId: cleanup.id,
          source: cleanup.source,
          ownershipSnapshot: snapshot,
          remoteUsageCount,
          observedAt,
        }),
      },
    });
    if (corrected.count !== 1) {
      throw new VoucherCleanupRetryableError(
        `Redemption ${current.id} changed during late-usage correction.`,
      );
    }
    if (latest.pointsSpent > BigInt(0)) {
      assertAccountBackedReward(latest);
      await appendPointsLedgerEntry({
        storeId: cleanup.storeId,
        accountId: latest.accountId,
        entryType: WeleticPointsLedgerEntryType.MANUAL_ADJUSTMENT,
        pointsDelta: -latest.pointsSpent,
        referenceType: "REDEMPTION_LATE_USE",
        referenceId: latest.id,
        idempotencyKey: `redemption_late_use:${latest.id}`,
        reason: "Shopify reported a compensated voucher as used.",
        metadata: { cleanupId: cleanup.id },
        tx,
      });
    }
    return "used_preserved";
  }
  if (
    current.status !== WeleticRedemptionStatus.provisioning &&
    current.status !== WeleticRedemptionStatus.issued &&
    current.status !== WeleticRedemptionStatus.active
  ) {
    throw new VoucherCleanupManualReconciliationError(
      `Remote usage conflicts with terminal redemption ${current.id} (${current.status}).`,
    );
  }

  const used = await tx.weleticRewardRedemption.updateMany({
    where: {
      id: current.id,
      storeId: cleanup.storeId,
      status: {
        in: [
          WeleticRedemptionStatus.provisioning,
          WeleticRedemptionStatus.issued,
          WeleticRedemptionStatus.active,
        ],
      },
    },
    data: {
      status: WeleticRedemptionStatus.used,
      usedAt: observedAt,
      metadata: usedRedemptionMetadata({
        cleanupId: cleanup.id,
        source: cleanup.source,
        ownershipSnapshot: snapshot,
        remoteUsageCount,
        observedAt,
      }),
    },
  });
  if (used.count !== 1) {
    const latest = await tx.weleticRewardRedemption.findUnique({
      where: { id: current.id },
      select: { status: true },
    });
    if (latest?.status === WeleticRedemptionStatus.used) {
      return "used_preserved";
    }
    throw new VoucherCleanupRetryableError(
      `Redemption ${current.id} changed during remote-usage preservation.`,
    );
  }
  return "used_preserved";
}

type VoucherCleanupLeaseRow = {
  id: string;
  storeId: string;
  source: WeleticVoucherCleanupSource;
  status: WeleticVoucherCleanupStatus;
  lockedBy: string | null;
  leaseVersion: number;
};

async function finalizeVoucherCleanupUnderLease({
  cleanup,
  lockOwner,
  leaseVersion,
  applyLocal,
  tx: existingTx,
}: {
  cleanup: Pick<WeleticShopifyVoucherCleanup, "id" | "storeId" | "source">;
  lockOwner: string;
  leaseVersion: number;
  tx?: Prisma.TransactionClient;
  applyLocal: (
    tx: Prisma.TransactionClient,
  ) => Promise<Exclude<VoucherPrivacyCleanupOutcome, "manual_reconciliation">>;
}) {
  const finalize = async (tx: Prisma.TransactionClient) => {
    const rows = await tx.$queryRaw<VoucherCleanupLeaseRow[]>(Prisma.sql`
      SELECT id, storeId, source, status, lockedBy, leaseVersion
      FROM WeleticShopifyVoucherCleanup
      WHERE id = ${cleanup.id}
      LIMIT 1
      FOR UPDATE
    `);
    const locked = rows[0];
    if (
      !locked ||
      locked.storeId !== cleanup.storeId ||
      locked.source !== cleanup.source ||
      locked.status !== WeleticVoucherCleanupStatus.processing ||
      locked.lockedBy !== lockOwner ||
      locked.leaseVersion !== leaseVersion
    ) {
      throw new VoucherCleanupRetryableError(
        `Voucher cleanup ${cleanup.id} lost its lease before policy-safe local settlement.`,
      );
    }

    const localOutcome = await applyLocal(tx);
    const completed = await tx.weleticShopifyVoucherCleanup.updateMany({
      where: {
        id: cleanup.id,
        storeId: cleanup.storeId,
        source: cleanup.source,
        status: WeleticVoucherCleanupStatus.processing,
        lockedBy: lockOwner,
        leaseVersion,
      },
      data: {
        status: WeleticVoucherCleanupStatus.completed,
        remoteOutcome: localOutcome,
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        nextRetryAt: null,
        lastError: null,
      },
    });
    if (completed.count !== 1) {
      throw new VoucherCleanupRetryableError(
        `Voucher cleanup ${cleanup.id} lost its lease before policy-safe completion.`,
      );
    }
    const { completeReviewInvalidationFromVoucherCleanup } = await import(
      "@/lib/weletic/reviews/incentive-invalidation-completion"
    );
    await completeReviewInvalidationFromVoucherCleanup({
      tx,
      storeId: cleanup.storeId,
      cleanupId: cleanup.id,
    });
    return localOutcome;
  };
  return existingTx ? finalize(existingTx) : prisma.$transaction(finalize);
}

function usageReconciliationRetryAt(remoteDeactivatedAt: Date) {
  return new Date(
    remoteDeactivatedAt.getTime() + VOUCHER_USAGE_RECONCILIATION_GRACE_MS,
  );
}

function requiresUsageReconciliationGrace(source: WeleticVoucherCleanupSource) {
  return (
    source === WeleticVoucherCleanupSource.review_invalidation ||
    source === WeleticVoucherCleanupSource.app_uninstalled ||
    source === WeleticVoucherCleanupSource.shop_redact
  );
}

async function readCurrentVoucherCleanupSource({
  cleanupId,
  fallback,
}: {
  cleanupId: string;
  fallback: WeleticVoucherCleanupSource;
}) {
  const current = await prisma.weleticShopifyVoucherCleanup.findUnique({
    where: { id: cleanupId },
    select: { source: true },
  });
  return current?.source ?? fallback;
}

function isPermanentCleanupError(error: unknown) {
  return (
    error instanceof VoucherCleanupManualReconciliationError ||
    (error instanceof ShopifyDiscountError && error.code === "INVALID_REQUEST")
  );
}

function calculateCleanupRetryAt(attempt: number, error: unknown) {
  if (error instanceof VoucherCleanupRetryableError && error.retryAt) {
    return error.retryAt;
  }
  if (
    error instanceof LoyaltyDiscountReconciliationPendingError &&
    error.retryUntil
  ) {
    return error.retryUntil;
  }
  const delay = Math.min(60 * 60_000, 2 ** Math.max(0, attempt - 1) * 5_000);
  return new Date(Date.now() + delay);
}

export async function handleVoucherPrivacyCleanup(
  input: VoucherPrivacyCleanupPayload & {
    storeId: string;
    outboxJobId: string;
  },
): Promise<VoucherPrivacyCleanupOutcome> {
  const { storeId, cleanupId, redemptionId, outboxJobId } = input;
  let cleanup = await prisma.weleticShopifyVoucherCleanup.findUnique({
    where: { id: cleanupId },
  });
  if (!cleanup) {
    throw new VoucherCleanupManualReconciliationError(
      `Voucher cleanup ${cleanupId} is unavailable.`,
    );
  }
  if (cleanup.storeId !== storeId || cleanup.redemptionId !== redemptionId) {
    throw new VoucherCleanupManualReconciliationError(
      `Voucher cleanup ${cleanupId} tenant or redemption identity mismatch.`,
    );
  }
  if (cleanup.status === WeleticVoucherCleanupStatus.completed) {
    return (
      (cleanup.remoteOutcome as VoucherPrivacyCleanupOutcome | null) ??
      "verified_absent"
    );
  }
  if (cleanup.status === WeleticVoucherCleanupStatus.dead_letter) {
    return "manual_reconciliation";
  }

  const now = new Date();
  if (
    cleanup.status === WeleticVoucherCleanupStatus.retrying &&
    cleanup.nextRetryAt &&
    cleanup.nextRetryAt > now
  ) {
    throw new VoucherCleanupRetryableError(
      `Voucher cleanup ${cleanup.id} is not due yet.`,
      cleanup.nextRetryAt,
    );
  }

  const lockOwner = `outbox:${outboxJobId}:${randomUUID()}`;
  const staleBefore = new Date(
    now.getTime() - VOUCHER_CLEANUP_LEASE_TIMEOUT_MS,
  );
  const claimed = await prisma.weleticShopifyVoucherCleanup.updateMany({
    where: {
      id: cleanup.id,
      storeId,
      redemptionId,
      OR: [
        { status: WeleticVoucherCleanupStatus.pending },
        {
          status: WeleticVoucherCleanupStatus.retrying,
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        },
        {
          status: WeleticVoucherCleanupStatus.processing,
          lockedAt: { lte: staleBefore },
        },
      ],
    },
    data: {
      status: WeleticVoucherCleanupStatus.processing,
      attempts: { increment: 1 },
      leaseVersion: { increment: 1 },
      lockedAt: new Date(),
      lockedBy: lockOwner,
      nextRetryAt: null,
      lastError: null,
    },
  });
  if (claimed.count !== 1) {
    throw new VoucherCleanupRetryableError(
      `Voucher cleanup ${cleanup.id} is owned by another worker.`,
    );
  }
  cleanup = await prisma.weleticShopifyVoucherCleanup.findUniqueOrThrow({
    where: { id: cleanup.id },
  });
  const leaseVersion = cleanup.leaseVersion;

  try {
    const redemption = await prisma.weleticRewardRedemption.findUnique({
      where: { id: redemptionId },
    });
    if (
      !redemption ||
      redemption.storeId !== storeId ||
      ("ownerKind" in input
        ? redemption.accountId !== null ||
          redemption.shopperId !== input.shopperId
        : redemption.accountId !== input.accountId ||
          redemption.fulfillmentSource != null)
    ) {
      throw new VoucherCleanupManualReconciliationError(
        `Redemption ${redemptionId} is unavailable or belongs to another cleanup identity.`,
      );
    }
    const snapshot = VoucherCleanupOwnershipSnapshotSchema.parse(
      cleanup.ownershipSnapshot,
    );
    if ("ownerKind" in input) assertShopperSnapshotOwner(redemption, snapshot);
    else if (snapshot.kind === "shopper")
      throw new VoucherCleanupManualReconciliationError(
        "Shopper cleanup cannot use account ownership.",
      );
    if (
      normalizeDiscountCode(cleanup.expectedDiscountCodeCanonical) !==
        snapshot.expectedCode ||
      normalizeDiscountCode(redemption.shopifyDiscountCode) !==
        snapshot.expectedCode
    ) {
      throw new VoucherCleanupManualReconciliationError(
        `Voucher cleanup ${cleanup.id} discount code identity changed.`,
      );
    }

    const fence = <T>(
      operation: (tx?: Prisma.TransactionClient) => Promise<T>,
    ) =>
      withShopperCleanupFence({
        cleanup,
        snapshot,
        lockOwner,
        leaseVersion,
        operation,
      });
    await fence(async () => undefined);
    // The integration credential resolver takes its own store-row lock. Never
    // call it inside our transaction; recheck generation after it returns.
    const credentialStore = await prisma.weleticShopifyStore.findUnique({
      where: { id: storeId },
      select: { complianceState: true },
    });
    const frozen = credentialStore?.complianceState === "frozen";
    const credentials = frozen
      ? null
      : await resolveShopifyOfflineCredentials({ storeId });
    const remoteOperation = <T>(
      operation: (credential: {
        shopDomain: string;
        accessToken: string;
      }) => Promise<T>,
    ) => {
      if (!frozen) return fence(() => operation(credentials!));
      return prisma.$transaction(
        async (tx) => {
          const cleanupCredential = await readFrozenStoreOwnedVoucherCredential(
            tx,
            {
              storeId,
              cleanupId: cleanup.id,
              redemptionId,
              lockOwner,
              leaseVersion,
              source: cleanup.source,
              expectedCode: cleanup.expectedDiscountCodeCanonical,
            },
          );
          // Reuse the same transaction; never open a nested Store lock while
          // resolving frozen credentials. Retain shopper ownership checks too.
          return withShopperCleanupFence({
            cleanup,
            snapshot,
            lockOwner,
            leaseVersion,
            tx,
            operation: () => operation(cleanupCredential),
          });
        },
        {
          maxWait: 10_000,
          timeout: 120_000,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    };
    const remote = await remoteOperation(async (credential) => {
      return lookupDiscountByCode(
        credential.shopDomain,
        credential.accessToken,
        cleanup.expectedDiscountCodeCanonical,
      );
    });
    let remoteOutcome: "deactivated" | "verified_absent";
    let remoteUsageCount = cleanup.remoteUsageCount;
    let remoteUsageObservedAt = cleanup.remoteUsageObservedAt;
    let remoteDeactivatedAt = cleanup.remoteDeactivatedAt;
    if (!remote) {
      if (
        cleanup.remoteVerifiedAt &&
        cleanup.remoteDeactivationStartedAt &&
        cleanup.remoteDeactivatedAt &&
        cleanup.expectedDiscountId &&
        cleanup.remoteUsageObservedAt &&
        cleanup.remoteUsageCount !== null
      ) {
        const currentSource = await readCurrentVoucherCleanupSource({
          cleanupId: cleanup.id,
          fallback: cleanup.source,
        });
        remoteUsageCount = cleanup.remoteUsageCount;
        remoteUsageObservedAt = cleanup.remoteUsageObservedAt;
        remoteDeactivatedAt = cleanup.remoteDeactivatedAt;
        if (
          remoteUsageCount === 0 &&
          requiresUsageReconciliationGrace(currentSource) &&
          usageReconciliationRetryAt(remoteDeactivatedAt) > new Date()
        ) {
          throw new VoucherCleanupRetryableError(
            `Voucher cleanup ${cleanup.id} is waiting for Shopify usage reconciliation.`,
            usageReconciliationRetryAt(remoteDeactivatedAt),
          );
        }
        remoteOutcome = "verified_absent";
      } else if (cleanup.expectedDiscountId || redemption.shopifyDiscountId) {
        throw new VoucherCleanupManualReconciliationError(
          `Persisted Shopify discount ID for cleanup ${cleanup.id} is absent without a prior exact deactivation marker.`,
        );
      } else {
        try {
          assertLoyaltyDiscountLookupMissIsTerminal({
            redemptionId: redemption.id,
            discountCode: redemption.shopifyDiscountCode,
            metadata: {
              remoteProvisionAttemptedAt:
                snapshot.remoteProvisionAttemptedAt ?? undefined,
              remoteProvisionReconcileUntil:
                snapshot.remoteProvisionReconcileUntil ?? undefined,
            },
          });
        } catch (error) {
          if (error instanceof LoyaltyDiscountReconciliationPendingError) {
            throw new VoucherCleanupRetryableError(
              error.message,
              error.retryUntil,
            );
          }
          throw error;
        }
        remoteOutcome = "verified_absent";
      }
    } else {
      const expectedDiscountId =
        cleanup.expectedDiscountId ||
        (redemption.shopifyDiscountId
          ? formatShopifyGid("DiscountCodeNode", redemption.shopifyDiscountId)
          : null);
      assertRemoteOwnership({
        cleanupId: cleanup.id,
        expectedCode: snapshot.expectedCode,
        expectedTitle: snapshot.expectedTitle,
        expectedDiscountId,
        remote,
      });
      if (
        !Number.isInteger(remote.asyncUsageCount) ||
        Number(remote.asyncUsageCount) < 0
      ) {
        throw new VoucherCleanupRetryableError(
          `Shopify did not return a valid usage count for cleanup ${cleanup.id}.`,
        );
      }
      remoteUsageCount = Number(remote.asyncUsageCount);
      // Shopify's async usage count is eventually consistent. Every retry
      // refreshes this observation, while the grace anchor remains the first
      // confirmed remote deactivation below.
      remoteUsageObservedAt = new Date();
      const deactivationStartedAt =
        cleanup.remoteDeactivationStartedAt ?? new Date();

      const marked = await prisma.weleticShopifyVoucherCleanup.updateMany({
        where: {
          id: cleanup.id,
          status: WeleticVoucherCleanupStatus.processing,
          lockedBy: lockOwner,
          leaseVersion,
        },
        data: {
          expectedDiscountId: remote.id,
          remoteVerifiedAt: cleanup.remoteVerifiedAt ?? new Date(),
          remoteUsageCount,
          remoteUsageObservedAt,
          remoteDeactivationStartedAt: deactivationStartedAt,
        },
      });
      if (marked.count !== 1) {
        throw new VoucherCleanupRetryableError(
          `Voucher cleanup ${cleanup.id} lost its lease before deactivation.`,
        );
      }
      await prisma.weleticRewardRedemption.updateMany({
        where: {
          id: redemption.id,
          storeId,
          status: { not: WeleticRedemptionStatus.used },
        },
        data: { shopifyDiscountId: remote.id },
      });
      const remoteStatus = remote.status.trim().toUpperCase();
      const alreadyInactive =
        remoteStatus === "INACTIVE" || remoteStatus === "EXPIRED";
      if (!alreadyInactive) {
        const deactivated = await remoteOperation(async (credential) => {
          return deactivateDiscount(
            credential.shopDomain,
            credential.accessToken,
            remote.id,
          );
        });
        if (!deactivated) {
          throw new VoucherCleanupRetryableError(
            `Shopify did not confirm voucher deactivation for cleanup ${cleanup.id}.`,
          );
        }
      }
      const confirmedDeactivatedAt = cleanup.remoteDeactivatedAt ?? new Date();
      const remotelyMarked =
        await prisma.weleticShopifyVoucherCleanup.updateMany({
          where: {
            id: cleanup.id,
            status: WeleticVoucherCleanupStatus.processing,
            lockedBy: lockOwner,
            leaseVersion,
          },
          data: {
            remoteDeactivatedAt: confirmedDeactivatedAt,
            remoteOutcome:
              redemption.status === WeleticRedemptionStatus.used ||
              remoteUsageCount > 0
                ? "used_preserved"
                : "deactivated_pending_usage_reconciliation",
          },
        });
      if (remotelyMarked.count !== 1) {
        throw new VoucherCleanupRetryableError(
          `Voucher cleanup ${cleanup.id} lost its lease after remote deactivation.`,
        );
      }
      remoteDeactivatedAt = confirmedDeactivatedAt;
      remoteOutcome = "deactivated";
      const currentSource = await readCurrentVoucherCleanupSource({
        cleanupId: cleanup.id,
        fallback: cleanup.source,
      });
      if (
        remoteUsageCount === 0 &&
        requiresUsageReconciliationGrace(currentSource) &&
        usageReconciliationRetryAt(remoteDeactivatedAt) > new Date()
      ) {
        throw new VoucherCleanupRetryableError(
          `Voucher cleanup ${cleanup.id} is waiting for Shopify usage reconciliation.`,
          usageReconciliationRetryAt(remoteDeactivatedAt),
        );
      }
    }

    const leaseHeartbeat = await prisma.weleticShopifyVoucherCleanup.updateMany(
      {
        where: {
          id: cleanup.id,
          status: WeleticVoucherCleanupStatus.processing,
          lockedBy: lockOwner,
          leaseVersion,
        },
        data: { lockedAt: new Date() },
      },
    );
    if (leaseHeartbeat.count !== 1) {
      throw new VoucherCleanupRetryableError(
        `Voucher cleanup ${cleanup.id} lost its lease before local compensation.`,
      );
    }

    return await fence((tx) =>
      finalizeVoucherCleanupUnderLease({
        cleanup,
        lockOwner,
        leaseVersion,
        tx,
        applyLocal: (tx) =>
          redemption.status === WeleticRedemptionStatus.used
            ? finalizeLocalUsedPreservation({
                cleanup,
                snapshot,
                remoteUsageCount: remoteUsageCount ?? 0,
                observedAt: remoteUsageObservedAt ?? new Date(),
                tx,
              })
            : remoteUsageCount !== null &&
                remoteUsageCount > 0 &&
                remoteUsageObservedAt
              ? finalizeLocalUsedPreservation({
                  cleanup,
                  snapshot,
                  remoteUsageCount,
                  observedAt: remoteUsageObservedAt,
                  tx,
                })
              : finalizeLocalCancellation({
                  cleanup,
                  snapshot,
                  outcome: remoteOutcome,
                  tx,
                }),
      }),
    );
  } catch (error) {
    const currentAttempt = cleanup.attempts;
    const permanent = isPermanentCleanupError(error);
    const exhausted = currentAttempt >= cleanup.maxAttempts;
    const message = error instanceof Error ? error.message : String(error);
    const transitioned = await prisma.weleticShopifyVoucherCleanup.updateMany({
      where: {
        id: cleanup.id,
        status: WeleticVoucherCleanupStatus.processing,
        lockedBy: lockOwner,
        leaseVersion,
      },
      data:
        permanent || exhausted
          ? {
              status: WeleticVoucherCleanupStatus.dead_letter,
              remoteOutcome: "manual_reconciliation",
              lockedAt: null,
              lockedBy: null,
              nextRetryAt: null,
              lastError: message,
            }
          : {
              status: WeleticVoucherCleanupStatus.retrying,
              lockedAt: null,
              lockedBy: null,
              nextRetryAt: calculateCleanupRetryAt(currentAttempt, error),
              lastError: message,
            },
    });
    if (transitioned.count !== 1) {
      throw new VoucherCleanupRetryableError(
        `Voucher cleanup ${cleanup.id} lost its lease while recording failure.`,
      );
    }
    if (permanent || exhausted) return "manual_reconciliation";
    throw new VoucherCleanupRetryableError(
      message,
      calculateCleanupRetryAt(currentAttempt, error),
    );
  }
}

export async function getVoucherCleanupTerminalCounts({
  storeId,
}: {
  storeId: string;
}) {
  const [outstanding, completed, deadLetter] = await Promise.all([
    prisma.weleticShopifyVoucherCleanup.count({
      where: {
        storeId,
        status: {
          in: [
            WeleticVoucherCleanupStatus.pending,
            WeleticVoucherCleanupStatus.processing,
            WeleticVoucherCleanupStatus.retrying,
          ],
        },
      },
    }),
    prisma.weleticShopifyVoucherCleanup.count({
      where: {
        storeId,
        status: WeleticVoucherCleanupStatus.completed,
      },
    }),
    prisma.weleticShopifyVoucherCleanup.count({
      where: {
        storeId,
        status: WeleticVoucherCleanupStatus.dead_letter,
      },
    }),
  ]);
  return { outstanding, completed, deadLetter };
}

export async function getVoucherCleanupRequestTerminalCounts({
  storeId,
  requestId,
}: {
  storeId: string;
  requestId: string;
}) {
  const requestScope = { storeId, requestId };
  const [outstanding, completed, deadLetter, cancelled, total] =
    await Promise.all([
      prisma.weleticShopifyVoucherCleanupRequestLink.count({
        where: {
          ...requestScope,
          cleanup: {
            status: {
              in: [
                WeleticVoucherCleanupStatus.pending,
                WeleticVoucherCleanupStatus.processing,
                WeleticVoucherCleanupStatus.retrying,
              ],
            },
          },
        },
      }),
      prisma.weleticShopifyVoucherCleanupRequestLink.count({
        where: {
          ...requestScope,
          cleanup: { status: WeleticVoucherCleanupStatus.completed },
        },
      }),
      prisma.weleticShopifyVoucherCleanupRequestLink.count({
        where: {
          ...requestScope,
          cleanup: { status: WeleticVoucherCleanupStatus.dead_letter },
        },
      }),
      prisma.weleticShopifyVoucherCleanupRequestLink.count({
        where: {
          ...requestScope,
          cleanup: { status: WeleticVoucherCleanupStatus.cancelled },
        },
      }),
      prisma.weleticShopifyVoucherCleanupRequestLink.count({
        where: requestScope,
      }),
    ]);
  return { outstanding, completed, deadLetter, cancelled, total };
}

type VoucherEnumerationCursor = {
  afterCreatedAt?: string;
  afterRedemptionId?: string;
  drainUntil?: string;
  newLinksInSweep?: number;
  sweep?: number;
};

function readEnumerationCursor(cursor: Prisma.JsonValue | null | undefined) {
  const value = readObject(cursor);
  const parsed = (value ?? {}) as VoucherEnumerationCursor;
  const afterCreatedAt = parsed.afterCreatedAt
    ? new Date(parsed.afterCreatedAt)
    : undefined;
  const drainUntil = parsed.drainUntil
    ? new Date(parsed.drainUntil)
    : new Date(Date.now() + VOUCHER_ENUMERATION_DRAIN_GRACE_MS);
  if (
    (afterCreatedAt && !Number.isFinite(afterCreatedAt.getTime())) ||
    !Number.isFinite(drainUntil.getTime())
  ) {
    throw new Error(
      "Voucher enumeration cursor contains an invalid timestamp.",
    );
  }
  return {
    afterCreatedAt,
    afterRedemptionId:
      typeof parsed.afterRedemptionId === "string"
        ? parsed.afterRedemptionId
        : undefined,
    drainUntil,
    newLinksInSweep:
      typeof parsed.newLinksInSweep === "number" &&
      Number.isSafeInteger(parsed.newLinksInSweep) &&
      parsed.newLinksInSweep >= 0
        ? parsed.newLinksInSweep
        : 0,
    sweep:
      typeof parsed.sweep === "number" &&
      Number.isSafeInteger(parsed.sweep) &&
      parsed.sweep >= 0
        ? parsed.sweep
        : 0,
  };
}

async function processConvergentVoucherEnumeration({
  cursor,
  enumeratePage,
}: {
  cursor?: Prisma.JsonValue | null;
  enumeratePage: (position: VoucherEnumerationPosition) => Promise<{
    scanned: number;
    newLinks: number;
    nextPosition?: VoucherEnumerationPosition;
  }>;
}) {
  const state = readEnumerationCursor(cursor);
  const page = await enumeratePage({
    afterCreatedAt: state.afterCreatedAt,
    afterRedemptionId: state.afterRedemptionId,
  });
  const newLinksInSweep = state.newLinksInSweep + page.newLinks;
  if (
    page.nextPosition?.afterCreatedAt &&
    page.nextPosition.afterRedemptionId
  ) {
    return {
      done: false,
      cursor: {
        afterCreatedAt: page.nextPosition.afterCreatedAt.toISOString(),
        afterRedemptionId: page.nextPosition.afterRedemptionId,
        drainUntil: state.drainUntil.toISOString(),
        newLinksInSweep,
        sweep: state.sweep,
      } satisfies Prisma.InputJsonObject,
      progress: {
        sweep: state.sweep,
        lastBatchScanned: page.scanned,
        newLinksInSweep,
        drainUntil: state.drainUntil.toISOString(),
      } satisfies Prisma.InputJsonObject,
    };
  }

  if (new Date() < state.drainUntil || newLinksInSweep > 0) {
    return {
      done: false,
      cursor: {
        drainUntil: state.drainUntil.toISOString(),
        newLinksInSweep: 0,
        sweep: state.sweep + 1,
      } satisfies Prisma.InputJsonObject,
      progress: {
        sweep: state.sweep,
        lastBatchScanned: page.scanned,
        linkedInCompletedSweep: newLinksInSweep,
        waitingForDrainUntil:
          new Date() < state.drainUntil ? state.drainUntil.toISOString() : null,
      } satisfies Prisma.InputJsonObject,
    };
  }

  return {
    done: true,
    cursor: Prisma.DbNull,
    progress: {
      sweep: state.sweep,
      lastBatchScanned: page.scanned,
      linkedInCompletedSweep: 0,
      convergedAt: new Date().toISOString(),
    } satisfies Prisma.InputJsonObject,
  };
}

export async function processAccountVoucherEnumerationComplianceStep({
  requestId,
  storeId,
  accountId,
  shopperId,
  cursor,
}: {
  requestId: string;
  storeId: string;
  accountId?: string | null;
  shopperId?: string | null;
  cursor?: Prisma.JsonValue | null;
}): Promise<{
  completed: false;
  phase: "enumerate_customer_vouchers" | "scrub_customer_identity";
  cursor: Prisma.InputJsonValue | typeof Prisma.DbNull;
  progress: Prisma.InputJsonValue;
}> {
  const enumeration = await processConvergentVoucherEnumeration({
    cursor,
    enumeratePage: (position) =>
      enqueueVoucherPrivacyCleanupsForAccountPage({
        storeId,
        accountId,
        shopperId,
        sourceRequestId: requestId,
        ...position,
      }),
  });
  return {
    completed: false,
    phase: enumeration.done
      ? "scrub_customer_identity"
      : "enumerate_customer_vouchers",
    cursor: enumeration.cursor,
    progress: enumeration.progress,
  };
}

/**
 * Bounded store-level voucher phase shared by app uninstall and shop erasure.
 * It performs no credential deletion. The owning compliance workflow may move
 * past `voucher_cleanup` only after this function reports every row terminal;
 * dead letters remain durable, explicit operator work instead of being lost.
 */
export async function processStoreVoucherCleanupComplianceStep({
  requestId,
  storeId,
  shopDomain,
  source,
  phase,
  cursor,
}: {
  requestId: string;
  storeId: string;
  shopDomain: string;
  source: WeleticVoucherCleanupSource;
  phase: "enumerate_vouchers" | "voucher_cleanup";
  cursor?: Prisma.JsonValue | null;
  progress?: Prisma.JsonValue | null;
  workerId: string;
}): Promise<{
  completed: boolean;
  phase: "enumerate_vouchers" | "voucher_cleanup" | "credential_scrub";
  cursor?: Prisma.InputJsonValue | typeof Prisma.DbNull;
  progress?: Prisma.InputJsonValue | typeof Prisma.DbNull;
}> {
  if (
    source !== WeleticVoucherCleanupSource.app_uninstalled &&
    source !== WeleticVoucherCleanupSource.shop_redact
  ) {
    throw new Error(`Unsupported store voucher cleanup source: ${source}.`);
  }
  const store = await prisma.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: { shopDomain: true },
  });
  if (
    !store ||
    normalizeShopDomain(store.shopDomain) !== normalizeShopDomain(shopDomain)
  ) {
    throw new Error(
      `Voucher compliance request does not match retained Shopify store ${storeId}.`,
    );
  }

  if (phase === "enumerate_vouchers") {
    const enumeration = await processConvergentVoucherEnumeration({
      cursor,
      enumeratePage: (position) =>
        enqueueVoucherPrivacyCleanupsForStorePage({
          storeId,
          sourceRequestId: requestId,
          source,
          ...position,
        }),
    });
    return {
      completed: false,
      phase: enumeration.done ? "voucher_cleanup" : "enumerate_vouchers",
      cursor: enumeration.cursor,
      progress: enumeration.progress,
    };
  }

  const counts = await getVoucherCleanupRequestTerminalCounts({
    storeId,
    requestId,
  });
  if (counts.outstanding > 0) {
    return {
      completed: false,
      phase: "voucher_cleanup",
      cursor: Prisma.DbNull,
      progress: counts,
    };
  }
  return {
    completed: false,
    phase: "credential_scrub",
    cursor: Prisma.DbNull,
    progress: {
      ...counts,
      unresolvedVoucherCleanup: counts.deadLetter > 0 || counts.cancelled > 0,
    },
  };
}
