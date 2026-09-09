import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { enqueueFlowTriggerJob } from "@/lib/weletic/loyalty/flow-trigger-outbox";
import {
  assertLoyaltyMaintenanceWriteAllowed,
  isLoyaltyMaintenanceBlockedError,
  type LoyaltyMaintenancePermit,
} from "@/lib/weletic/loyalty/maintenance-write-fence";
import {
  assertLockedLoyaltyProgramActive,
  assertLockedLoyaltyProgramCurrencyGeneration,
  isLockedLoyaltyProgramActive,
  type LockedLoyaltyProgram,
  type LoyaltyProgramRowLockMode,
  withLoyaltyProgramRowLock,
} from "@/lib/weletic/loyalty/program-write-fence";
import {
  canonicalizeLoyaltyDiscountCode,
  clearLoyaltyDiscountRemoteProvisionAttempt,
} from "@/lib/weletic/loyalty/redemption-discount-identity";
import { matchesShopifyCustomerSelectionDigest } from "@/lib/weletic/loyalty/redemption-provisioning-snapshot";
import {
  getReferralCouponDiscountCode,
  getReferralCouponIdentityFingerprint,
  getReferralCouponProvisioningIdentity,
  parseReferralCouponRewardSnapshotForIdentity,
  ReferralCouponIdentity,
  ReferralCouponRewardSnapshot,
} from "@/lib/weletic/loyalty/referral-coupon-snapshot";
import { isReferralCouponProvisionable } from "@/lib/weletic/loyalty/rewards";
import {
  deactivateDiscount,
  isInactiveShopifyDiscountStatus,
  lookupDiscountByCode,
  matchesLoyaltyRewardDiscountConfiguration,
  provisionLoyaltyRewardDiscount,
  resolveShopifyOfflineCredentials,
  SHOPIFY_ADMIN_GRAPHQL_REQUEST_TIMEOUT_MS,
  ShopifyDiscountError,
  ShopifyDiscountResult,
} from "@/lib/weletic/loyalty/shopify-discounts";
import { nanoid } from "@dub/utils";
import {
  Prisma,
  WeleticLoyaltyReferralStatus,
  WeleticRedemptionStatus,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { assertAccountBackedReward } from "./reward-ownership";

export { getReferralCouponDiscountCode } from "@/lib/weletic/loyalty/referral-coupon-snapshot";

const COMPENSATED_REFERRAL_COUPON_STATUSES = new Set<WeleticRedemptionStatus>([
  WeleticRedemptionStatus.cancelled,
  WeleticRedemptionStatus.expired,
  WeleticRedemptionStatus.failed,
]);
const LIVE_REFERRAL_COUPON_STATUSES = new Set<WeleticRedemptionStatus>([
  WeleticRedemptionStatus.issued,
  WeleticRedemptionStatus.active,
  WeleticRedemptionStatus.used,
]);
export const REFERRAL_COUPON_RECONCILIATION_HORIZON_MS = Math.max(
  120_000,
  SHOPIFY_ADMIN_GRAPHQL_REQUEST_TIMEOUT_MS * 4,
);
const REFERRAL_COUPON_PROGRAM_LOCK_TIMEOUT_MS = Math.max(
  60_000,
  SHOPIFY_ADMIN_GRAPHQL_REQUEST_TIMEOUT_MS * 4,
);

async function withReferralCouponProgramLock<T>(
  storeId: string,
  mode: LoyaltyProgramRowLockMode,
  operation: (
    tx: Prisma.TransactionClient,
    program: LockedLoyaltyProgram,
  ) => Promise<T>,
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit,
) {
  return withLoyaltyProgramRowLock({
    storeId,
    mode,
    loyaltyMaintenancePermit,
    operation,
    // Remote Shopify mutation is intentionally serialized beneath the program
    // row lock. A merchant disable therefore commits either before this
    // operation (and blocks active writes) or after its durable result.
    timeoutMs: REFERRAL_COUPON_PROGRAM_LOCK_TIMEOUT_MS,
  });
}

export class ReferralCouponReconciliationPendingError extends Error {
  constructor(
    message: string,
    public retryUntil: Date,
  ) {
    super(message);
    this.name = "ReferralCouponReconciliationPendingError";
  }
}

export class ReferralCouponReconciliationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReferralCouponReconciliationRequiredError";
  }
}

export function getReferralCouponIdempotencyKey({
  referralId,
  qualificationOrderId,
  side,
}: {
  referralId: string;
  qualificationOrderId: string;
  side: "advocate" | "referee";
}) {
  const digest = createHash("sha256")
    .update(`${referralId}:${qualificationOrderId}:${side}`)
    .digest("hex")
    .slice(0, 24);
  return `referral_coupon:${digest}`;
}

function getReferralCouponMetadata(metadata: Prisma.JsonValue) {
  const value =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : {};
  return {
    value,
    isReferralCoupon:
      typeof value.referralId === "string" &&
      typeof value.qualificationOrderId === "string" &&
      (value.referralSide === "advocate" || value.referralSide === "referee"),
  };
}

type ReferralCouponRedemptionForRecovery = {
  id: string;
  storeId: string;
  accountId: string | null;
  rewardDefinitionId: string;
  status: WeleticRedemptionStatus;
  shopifyDiscountCode: string;
  shopifyDiscountCodeCanonical?: string | null;
  shopifyDiscountId: string | null;
  settlementQuarantinedAt?: Date | null;
  expiresAt: Date | null;
  metadata: Prisma.JsonValue;
};

function getReferralCouponCanonicalWriteFence(
  redemption: ReferralCouponRedemptionForRecovery,
  { allowQuarantined = false }: { allowQuarantined?: boolean } = {},
) {
  const expectedCanonical = canonicalizeLoyaltyDiscountCode(
    redemption.shopifyDiscountCode,
  );
  if (
    (redemption.shopifyDiscountCodeCanonical != null &&
      redemption.shopifyDiscountCodeCanonical !== expectedCanonical) ||
    (!allowQuarantined && redemption.settlementQuarantinedAt != null)
  ) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${redemption.id} changed or quarantined its canonical Shopify identity.`,
    );
  }

  return {
    shopifyDiscountCode: redemption.shopifyDiscountCode,
    shopifyDiscountCodeCanonical:
      redemption.shopifyDiscountCodeCanonical ?? expectedCanonical,
    settlementQuarantinedAt: redemption.settlementQuarantinedAt ?? null,
  } as const;
}

export type ReferralCouponPrivacyCleanupExpectation = {
  kind: "referral";
  expectedCode: string;
  expectedTitle: string;
  ownershipFingerprint: string;
  remoteProvisionAttemptedAt: string | null;
  remoteProvisionReconcileUntil: string | null;
};

type ReferralForCouponAuthority = {
  id: string;
  storeId: string;
  advocateAccountId: string;
  refereeAccountId: string | null;
  metadata: Prisma.JsonValue;
};

function getRewardSnapshotName(metadata: Record<string, unknown>) {
  const snapshot = metadata.rewardSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  return typeof (snapshot as Record<string, unknown>).name === "string"
    ? ((snapshot as Record<string, unknown>).name as string)
    : null;
}

function getPersistedReferralCouponRewardSnapshot(
  metadata: Record<string, unknown>,
  identity: ReferralCouponIdentity,
  redemptionId: string,
): ReferralCouponRewardSnapshot | null {
  const snapshot = metadata.rewardSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  if (!("version" in snapshot)) {
    // Legacy referral coupons only stored name/description/type. They remain
    // recoverable through the compatibility path below, but all new coupons
    // use the complete versioned snapshot.
    return null;
  }
  try {
    return parseReferralCouponRewardSnapshotForIdentity(snapshot, identity);
  } catch {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${redemptionId} has an invalid immutable reward snapshot.`,
    );
  }
}

function getAuthoritativeReferralCouponRewardSnapshot(
  referral: ReferralForCouponAuthority,
  identity: ReferralCouponIdentity,
): ReferralCouponRewardSnapshot | null {
  if (referral.storeId !== identity.storeId) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral ${referral.id} belongs to another Shopify store.`,
    );
  }
  const expectedAccountId =
    identity.side === "advocate"
      ? referral.advocateAccountId
      : referral.refereeAccountId;
  if (expectedAccountId !== identity.accountId) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${identity.side} account does not match the qualified referral.`,
    );
  }

  const metadata = getReferralCouponMetadata(referral.metadata).value;
  const requiredCouponSides = Array.isArray(metadata.requiredCouponSides)
    ? metadata.requiredCouponSides.filter(
        (value): value is "advocate" | "referee" =>
          value === "advocate" || value === "referee",
      )
    : [];
  const snapshots =
    metadata.referralCouponRewardSnapshots &&
    typeof metadata.referralCouponRewardSnapshots === "object" &&
    !Array.isArray(metadata.referralCouponRewardSnapshots)
      ? (metadata.referralCouponRewardSnapshots as Record<string, unknown>)
      : null;
  const rawSnapshot = snapshots?.[identity.side];
  if (rawSnapshot === undefined) {
    if (snapshots) {
      throw new ShopifyDiscountError(
        "INVALID_REQUEST",
        `Referral ${referral.id} is missing its authoritative ${identity.side} coupon snapshot.`,
      );
    }
    return null;
  }
  if (!requiredCouponSides.includes(identity.side)) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${identity.side} is not part of the qualified reward generation.`,
    );
  }

  try {
    return parseReferralCouponRewardSnapshotForIdentity(rawSnapshot, identity);
  } catch {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral ${referral.id} has an invalid authoritative coupon snapshot.`,
    );
  }
}

function assertRewardSnapshotsEqual(
  authoritative: ReferralCouponRewardSnapshot,
  candidate: ReferralCouponRewardSnapshot,
) {
  if (!isDeepStrictEqual(authoritative, candidate)) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Referral coupon payload does not match the immutable qualification snapshot.",
    );
  }
}

function assertSnapshotExpirationMatchesRedemption(
  snapshot: ReferralCouponRewardSnapshot,
  expiresAt: Date | null | undefined,
  redemptionId: string,
) {
  const redemptionExpiresAt = expiresAt?.toISOString() ?? null;
  if (redemptionExpiresAt !== snapshot.expiresAt) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${redemptionId} expiration does not match its immutable reward snapshot.`,
    );
  }
}

function assertSnapshotProvisioningContext({
  snapshot,
  storeId,
  shopCurrency,
  currencyVerifiedAt,
  shopifyCustomerId,
  redemptionId,
}: {
  snapshot: ReferralCouponRewardSnapshot;
  storeId: string;
  shopCurrency: string;
  currencyVerifiedAt: Date | null | undefined;
  shopifyCustomerId: string;
  redemptionId: string;
}) {
  if (shopCurrency.trim().toUpperCase() !== snapshot.shopCurrency) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${redemptionId} store currency no longer matches its immutable qualification snapshot.`,
    );
  }
  if (
    !snapshot.currencyVerifiedAt ||
    currencyVerifiedAt?.toISOString() !== snapshot.currencyVerifiedAt
  ) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${redemptionId} Shopify currency generation no longer matches its immutable qualification snapshot.`,
    );
  }
  if (
    !matchesShopifyCustomerSelectionDigest({
      digest: snapshot.customerSelectionDigest,
      storeId,
      shopifyCustomerId,
    })
  ) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${redemptionId} resolved a different Shopify customer than its immutable qualification snapshot.`,
    );
  }
}

function getRewardDefinitionFromSnapshot(
  snapshot: ReferralCouponRewardSnapshot,
) {
  return {
    id: snapshot.rewardDefinitionId,
    name: snapshot.provisioningName,
    rewardType: snapshot.rewardType,
    salesChannel: snapshot.salesChannel,
    purchasePolicy: snapshot.purchasePolicy,
    discountValue: snapshot.discountValue,
    maxDiscountValue: snapshot.maxDiscountValue,
    minOrderAmount: snapshot.minOrderAmount,
    appliesToResource: snapshot.appliesToResource,
    entitledCollectionIds: snapshot.entitledCollectionIds,
    entitledProductIds: snapshot.entitledProductIds,
    entitledVariantIds: snapshot.entitledVariantIds,
    combinesWithProductDiscounts: snapshot.combinesWithProductDiscounts,
    combinesWithOrderDiscounts: snapshot.combinesWithOrderDiscounts,
    combinesWithShippingDiscounts: snapshot.combinesWithShippingDiscounts,
    usageLimit: snapshot.usageLimit,
    usageLimitPerCustomer: snapshot.usageLimitPerCustomer,
    expiresInDays: snapshot.expiresInDays,
  };
}

function getReferralCouponOwnershipExpectation(
  redemption: ReferralCouponRedemptionForRecovery,
) {
  assertAccountBackedReward(redemption);
  const metadata = getReferralCouponMetadata(redemption.metadata);
  if (!metadata.isReferralCoupon) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Redemption ${redemption.id} is not a valid referral coupon.`,
    );
  }
  const identity: ReferralCouponIdentity = {
    storeId: redemption.storeId,
    referralId: metadata.value.referralId as string,
    qualificationOrderId: metadata.value.qualificationOrderId as string,
    accountId: redemption.accountId,
    rewardDefinitionId: redemption.rewardDefinitionId,
    side: metadata.value.referralSide as "advocate" | "referee",
  };
  const persistedSnapshot = getPersistedReferralCouponRewardSnapshot(
    metadata.value,
    identity,
    redemption.id,
  );
  if (persistedSnapshot) {
    assertSnapshotExpirationMatchesRedemption(
      persistedSnapshot,
      redemption.expiresAt,
      redemption.id,
    );
    const recordedFingerprint =
      typeof metadata.value.shopifyDiscountOwnershipFingerprint === "string"
        ? metadata.value.shopifyDiscountOwnershipFingerprint
        : null;
    const recordedProvisioningName =
      typeof metadata.value.shopifyDiscountProvisioningName === "string"
        ? metadata.value.shopifyDiscountProvisioningName
        : null;
    const recordedExpectedTitle =
      typeof metadata.value.shopifyDiscountExpectedTitle === "string"
        ? metadata.value.shopifyDiscountExpectedTitle
        : null;
    if (
      redemption.shopifyDiscountCode !== persistedSnapshot.discountCode ||
      recordedFingerprint !== persistedSnapshot.ownershipFingerprint ||
      recordedProvisioningName !== persistedSnapshot.provisioningName ||
      recordedExpectedTitle !== persistedSnapshot.expectedTitle
    ) {
      throw new ShopifyDiscountError(
        "INVALID_REQUEST",
        `Referral coupon ${redemption.id} has conflicting immutable Shopify ownership metadata.`,
      );
    }
    return {
      expectedCode: persistedSnapshot.discountCode,
      expectedTitle: persistedSnapshot.expectedTitle,
      snapshot: persistedSnapshot,
    };
  }
  const rewardName = getRewardSnapshotName(metadata.value);
  if (!rewardName) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${redemption.id} has no reward snapshot for ownership validation.`,
    );
  }

  const recordedFingerprint =
    typeof metadata.value.shopifyDiscountOwnershipFingerprint === "string"
      ? metadata.value.shopifyDiscountOwnershipFingerprint
      : null;
  const expectation = getReferralCouponProvisioningIdentity({
    ...identity,
    rewardName,
    discountCode: redemption.shopifyDiscountCode,
  });
  const recordedProvisioningName =
    typeof metadata.value.shopifyDiscountProvisioningName === "string"
      ? metadata.value.shopifyDiscountProvisioningName
      : null;
  const recordedExpectedTitle =
    typeof metadata.value.shopifyDiscountExpectedTitle === "string"
      ? metadata.value.shopifyDiscountExpectedTitle
      : null;
  if (
    recordedFingerprint !== expectation.fingerprint ||
    recordedProvisioningName !== expectation.provisioningName ||
    recordedExpectedTitle !== expectation.expectedTitle
  ) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${redemption.id} lacks strong immutable Shopify ownership metadata.`,
    );
  }
  return {
    expectedCode: redemption.shopifyDiscountCode,
    expectedTitle: expectation.expectedTitle,
    snapshot: null,
  };
}

/**
 * Returns the minimum immutable identity required to deactivate a referral
 * voucher after its customer context has been redacted. The expectation is
 * derived through the same strict snapshot validation used by normal referral
 * recovery; callers must never infer ownership from a code alone.
 */
export function getReferralCouponPrivacyCleanupExpectation(
  redemption: ReferralCouponRedemptionForRecovery,
): ReferralCouponPrivacyCleanupExpectation | null {
  const metadata = getReferralCouponMetadata(redemption.metadata);
  if (!metadata.isReferralCoupon) return null;

  const expectation = getReferralCouponOwnershipExpectation(redemption);
  const fingerprint =
    typeof metadata.value.shopifyDiscountOwnershipFingerprint === "string"
      ? metadata.value.shopifyDiscountOwnershipFingerprint
      : null;
  if (!fingerprint) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${redemption.id} has no immutable Shopify ownership fingerprint.`,
    );
  }

  return {
    kind: "referral",
    expectedCode: expectation.expectedCode,
    expectedTitle: expectation.expectedTitle,
    ownershipFingerprint: fingerprint,
    remoteProvisionAttemptedAt:
      typeof metadata.value.remoteProvisionAttemptedAt === "string"
        ? metadata.value.remoteProvisionAttemptedAt
        : null,
    remoteProvisionReconcileUntil:
      typeof metadata.value.remoteProvisionReconcileUntil === "string"
        ? metadata.value.remoteProvisionReconcileUntil
        : null,
  };
}

function isShopifyDiscountOwned(params: {
  discount: ShopifyDiscountResult;
  expectedCode: string;
  expectedTitle: string;
}) {
  return (
    params.discount.code.trim().toUpperCase() ===
      params.expectedCode.trim().toUpperCase() &&
    params.discount.title === params.expectedTitle
  );
}

function assertShopifyDiscountOwnership(params: {
  redemptionId: string;
  discount: ShopifyDiscountResult;
  expectedCode: string;
  expectedTitle: string;
  requireActive?: boolean;
}) {
  if (
    !isShopifyDiscountOwned(params) ||
    (params.requireActive && params.discount.status !== "ACTIVE")
  ) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Shopify discount code collision for referral coupon ${params.redemptionId}; the existing discount is not owned by the intended referral configuration.`,
    );
  }
}

function getReferralCouponReconciliationDeadline(
  metadata: Record<string, unknown>,
) {
  const explicitDeadline =
    typeof metadata.remoteProvisionReconcileUntil === "string"
      ? new Date(metadata.remoteProvisionReconcileUntil)
      : null;
  if (explicitDeadline && Number.isFinite(explicitDeadline.getTime())) {
    return explicitDeadline;
  }
  const attemptedAt =
    typeof metadata.remoteProvisionAttemptedAt === "string"
      ? new Date(metadata.remoteProvisionAttemptedAt)
      : null;
  if (!attemptedAt || !Number.isFinite(attemptedAt.getTime())) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      "Referral coupon remote provisioning marker is invalid.",
    );
  }
  return new Date(
    attemptedAt.getTime() + REFERRAL_COUPON_RECONCILIATION_HORIZON_MS,
  );
}

async function deactivateReferralDiscount(params: {
  shopDomain: string;
  accessToken: string;
  discountId: string;
}) {
  const deactivated = await deactivateDiscount(
    params.shopDomain,
    params.accessToken,
    params.discountId,
  );
  if (!deactivated) {
    throw new Error(
      `Shopify did not deactivate discount ${params.discountId}.`,
    );
  }
}

/**
 * Recovers and deactivates a compensated referral coupon.
 *
 * A missing remote ID is only safe to ignore when provisioning never reached
 * Shopify. Once remote provisioning was attempted, a lookup miss remains
 * retryable because Shopify may still contain a coupon created immediately
 * before the worker crashed.
 */
export async function recoverCompensatedReferralCouponDiscount({
  storeId,
  redemption,
}: {
  storeId: string;
  redemption: ReferralCouponRedemptionForRecovery;
}): Promise<boolean> {
  if (redemption.storeId !== storeId) {
    throw new Error(
      `Referral coupon recovery tenant mismatch for ${redemption.id}.`,
    );
  }

  const metadata = getReferralCouponMetadata(redemption.metadata);
  if (
    !metadata.isReferralCoupon ||
    !COMPENSATED_REFERRAL_COUPON_STATUSES.has(redemption.status)
  ) {
    return false;
  }

  const remoteProvisionAttempted =
    typeof metadata.value.remoteProvisionAttemptedAt === "string";
  if (!redemption.shopifyDiscountId && !remoteProvisionAttempted) {
    // Compensation won before any Shopify call began, so there cannot be a
    // remote coupon to clean up and the outbox job may complete.
    return true;
  }

  const credentials = await resolveShopifyOfflineCredentials({ storeId });
  return withReferralCouponProgramLock(storeId, "lock_only", async (tx) => {
    const latest = await tx.weleticRewardRedemption.findUnique({
      where: { id: redemption.id },
    });
    if (!latest || latest.storeId !== storeId) {
      throw new Error(
        `Referral coupon recovery tenant changed for ${redemption.id}.`,
      );
    }
    assertAccountBackedReward(latest);
    const latestMetadata = getReferralCouponMetadata(latest.metadata);
    if (
      !latestMetadata.isReferralCoupon ||
      !COMPENSATED_REFERRAL_COUPON_STATUSES.has(latest.status)
    ) {
      return false;
    }
    const latestRemoteProvisionAttempted =
      typeof latestMetadata.value.remoteProvisionAttemptedAt === "string";
    if (!latest.shopifyDiscountId && !latestRemoteProvisionAttempted) {
      return true;
    }
    const canonicalWriteFence = getReferralCouponCanonicalWriteFence(latest, {
      // Cleanup remains available for a quarantined row, but every local write
      // must still compare-and-swap the exact quarantine generation.
      allowQuarantined: true,
    });

    let discountId = latest.shopifyDiscountId;
    if (discountId) {
      const ownership = getReferralCouponOwnershipExpectation(latest);
      if (!ownership.snapshot) {
        throw new ShopifyDiscountError(
          "INVALID_REQUEST",
          `Cannot deactivate stored Shopify discount ${discountId} for legacy referral coupon ${latest.id} without a complete immutable reward snapshot; manual reconciliation is required.`,
        );
      }
      const recovered = await lookupDiscountByCode(
        credentials.shopDomain,
        credentials.accessToken,
        ownership.expectedCode,
      );
      if (
        !recovered?.id ||
        recovered.id !== discountId ||
        !isShopifyDiscountOwned({
          discount: recovered,
          expectedCode: ownership.expectedCode,
          expectedTitle: ownership.expectedTitle,
        })
      ) {
        throw new ShopifyDiscountError(
          "INVALID_REQUEST",
          `Stored Shopify discount ${discountId} for referral coupon ${latest.id} could not be verified against its immutable ownership identity; manual reconciliation is required.`,
        );
      }
    }
    if (!discountId) {
      const recovered = await lookupDiscountByCode(
        credentials.shopDomain,
        credentials.accessToken,
        latest.shopifyDiscountCode,
      );
      if (!recovered?.id) {
        const retryUntil = getReferralCouponReconciliationDeadline(
          latestMetadata.value,
        );
        if (Date.now() < retryUntil.getTime()) {
          throw new ReferralCouponReconciliationPendingError(
            `Shopify referral discount ${latest.shopifyDiscountCode} is not visible yet; reconciliation remains pending.`,
            retryUntil,
          );
        }
        throw new ReferralCouponReconciliationRequiredError(
          `Shopify referral discount ${latest.shopifyDiscountCode} is still absent after an uncertain create for referral coupon ${latest.id}; manual reconciliation is required.`,
        );
      }
      const ownership = getReferralCouponOwnershipExpectation(latest);
      if (
        !isShopifyDiscountOwned({
          discount: recovered,
          expectedCode: ownership.expectedCode,
          expectedTitle: ownership.expectedTitle,
        })
      ) {
        throw new ShopifyDiscountError(
          "INVALID_REQUEST",
          `Shopify discount code collision for referral coupon ${latest.id}; the existing discount is not owned by the intended referral configuration.`,
        );
      }

      let matchesImmutableConfiguration = false;
      if (ownership.snapshot && recovered.status === "ACTIVE") {
        const [account, store] = await Promise.all([
          tx.weleticLoyaltyAccount.findFirst({
            where: {
              id: latest.accountId,
              storeId,
              status: "active",
            },
            include: { shopper: true },
          }),
          tx.weleticShopifyStore.findUnique({
            where: { id: storeId },
            select: { shopCurrency: true },
          }),
        ]);
        if (account && store?.shopCurrency) {
          const contextMatches =
            store.shopCurrency.trim().toUpperCase() ===
              ownership.snapshot.shopCurrency &&
            matchesShopifyCustomerSelectionDigest({
              digest: ownership.snapshot.customerSelectionDigest,
              storeId,
              shopifyCustomerId: account.shopper.shopifyCustomerId,
            });
          matchesImmutableConfiguration =
            contextMatches &&
            matchesLoyaltyRewardDiscountConfiguration({
              remote: recovered,
              rewardDefinition: getRewardDefinitionFromSnapshot(
                ownership.snapshot,
              ),
              startsAt: new Date(ownership.snapshot.startsAt),
              expiresAt: ownership.snapshot.expiresAt
                ? new Date(ownership.snapshot.expiresAt)
                : null,
              expectedShopCurrency: ownership.snapshot.shopCurrency,
              shopifyCustomerId: account.shopper.shopifyCustomerId,
            });
        }
      }

      if (!matchesImmutableConfiguration) {
        // The tenant-bound title proves ownership, but status/economics/scope
        // or customer eligibility no longer matches the qualification
        // snapshot. Do not adopt the remote ID; deactivate it before
        // compensation closes.
        await deactivateReferralDiscount({
          shopDomain: credentials.shopDomain,
          accessToken: credentials.accessToken,
          discountId: recovered.id,
        });
        return true;
      }
      discountId = recovered.id;
      const adoptedForCleanup = await tx.weleticRewardRedemption.updateMany({
        where: {
          id: latest.id,
          storeId,
          status: {
            in: [
              WeleticRedemptionStatus.cancelled,
              WeleticRedemptionStatus.expired,
              WeleticRedemptionStatus.failed,
            ],
          },
          shopifyDiscountId: null,
          ...canonicalWriteFence,
        },
        data: { shopifyDiscountId: discountId },
      });
      if (adoptedForCleanup.count !== 1) {
        throw new Error(
          `Referral coupon ${latest.id} changed state before remote cleanup.`,
        );
      }
    }

    await deactivateReferralDiscount({
      shopDomain: credentials.shopDomain,
      accessToken: credentials.accessToken,
      discountId,
    });
    return true;
  });
}

function assertReferralCouponRedemptionIntent<
  T extends ReferralCouponRedemptionForRecovery,
>(
  redemption: T,
  identity: ReferralCouponIdentity,
): asserts redemption is T & { accountId: string } {
  assertAccountBackedReward(redemption);
  const metadata = getReferralCouponMetadata(redemption.metadata);
  if (
    redemption.storeId !== identity.storeId ||
    redemption.accountId !== identity.accountId ||
    redemption.rewardDefinitionId !== identity.rewardDefinitionId ||
    !metadata.isReferralCoupon ||
    metadata.value.referralId !== identity.referralId ||
    metadata.value.qualificationOrderId !== identity.qualificationOrderId ||
    metadata.value.referralSide !== identity.side
  ) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${redemption.id} does not match the intended tenant, account, or referral configuration.`,
    );
  }
  const persistedSnapshot = getPersistedReferralCouponRewardSnapshot(
    metadata.value,
    identity,
    redemption.id,
  );
  if (persistedSnapshot) {
    assertSnapshotExpirationMatchesRedemption(
      persistedSnapshot,
      redemption.expiresAt,
      redemption.id,
    );
    if (
      persistedSnapshot.discountCode !== redemption.shopifyDiscountCode ||
      metadata.value.shopifyDiscountOwnershipFingerprint !==
        persistedSnapshot.ownershipFingerprint ||
      metadata.value.shopifyDiscountProvisioningName !==
        persistedSnapshot.provisioningName ||
      metadata.value.shopifyDiscountExpectedTitle !==
        persistedSnapshot.expectedTitle
    ) {
      throw new ShopifyDiscountError(
        "INVALID_REQUEST",
        `Referral coupon ${redemption.id} has conflicting immutable provisioning metadata.`,
      );
    }
    return;
  }
  const recordedFingerprint =
    typeof metadata.value.shopifyDiscountOwnershipFingerprint === "string"
      ? metadata.value.shopifyDiscountOwnershipFingerprint
      : null;
  if (
    recordedFingerprint &&
    recordedFingerprint !== getReferralCouponIdentityFingerprint(identity)
  ) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${redemption.id} has a conflicting ownership fingerprint.`,
    );
  }
}

async function completeReferralWhenCouponsAreFulfilled(params: {
  storeId: string;
  referralId: string;
  qualificationOrderId: string;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  await withReferralCouponProgramLock(
    params.storeId,
    "lock_only",
    async (tx, program) => {
      assertLoyaltyMaintenanceWriteAllowed({
        storeId: params.storeId,
        metadata: program.metadata,
        permit: params.loyaltyMaintenancePermit,
      });
      const referral = await tx.weleticLoyaltyReferral.findFirst({
        where: {
          id: params.referralId,
          storeId: params.storeId,
          qualifyingOrderId: params.qualificationOrderId,
        },
      });
      if (!referral) return;
      const metadata =
        referral.metadata &&
        typeof referral.metadata === "object" &&
        !Array.isArray(referral.metadata)
          ? (referral.metadata as Record<string, unknown>)
          : {};
      const requiredCouponSides = Array.isArray(metadata.requiredCouponSides)
        ? metadata.requiredCouponSides.filter(
            (value): value is "advocate" | "referee" =>
              value === "advocate" || value === "referee",
          )
        : [];
      const requiredKeys = requiredCouponSides.map((requiredSide) =>
        getReferralCouponIdempotencyKey({
          referralId: params.referralId,
          qualificationOrderId: params.qualificationOrderId,
          side: requiredSide,
        }),
      );
      const fulfilledCoupons = requiredKeys.length
        ? await tx.weleticRewardRedemption.count({
            where: {
              storeId: params.storeId,
              idempotencyKey: { in: requiredKeys },
              status: {
                in: [
                  WeleticRedemptionStatus.issued,
                  WeleticRedemptionStatus.active,
                  WeleticRedemptionStatus.used,
                ],
              },
            },
          })
        : 0;
      if (requiredKeys.length > 0 && fulfilledCoupons === requiredKeys.length) {
        const completed = await tx.weleticLoyaltyReferral.updateMany({
          where: {
            id: params.referralId,
            storeId: params.storeId,
            qualifyingOrderId: params.qualificationOrderId,
            status: WeleticLoyaltyReferralStatus.qualified,
          },
          data: {
            status: WeleticLoyaltyReferralStatus.rewarded,
            rewardedAt: new Date(),
          },
        });
        if (completed.count === 1) {
          await enqueueFlowTriggerJob({
            storeId: params.storeId,
            eventId: referral.id,
            payload: {
              handle: "weletic-referral-completed",
              accountId: referral.advocateAccountId,
              referralId: referral.id,
              orderId: params.qualificationOrderId,
              advocatePoints: referral.advocatePointsAwarded.toString(),
              friendPoints: referral.refereePointsAwarded.toString(),
            },
            loyaltyMaintenancePermit: params.loyaltyMaintenancePermit,
            tx,
          });
        }
      }
    },
    params.loyaltyMaintenancePermit,
  );
}

export async function issueReferralRewardCoupon({
  storeId,
  referralId,
  qualificationOrderId,
  accountId,
  rewardDefinitionId,
  side,
  rewardSnapshot,
  loyaltyMaintenancePermit,
}: {
  storeId: string;
  referralId: string;
  qualificationOrderId: string;
  accountId: string;
  rewardDefinitionId: string;
  side: "advocate" | "referee";
  rewardSnapshot?: ReferralCouponRewardSnapshot;
  loyaltyMaintenancePermit?: LoyaltyMaintenancePermit;
}) {
  const idempotencyKey = getReferralCouponIdempotencyKey({
    referralId,
    qualificationOrderId,
    side,
  });
  const intendedIdentity: ReferralCouponIdentity = {
    storeId,
    referralId,
    qualificationOrderId,
    accountId,
    rewardDefinitionId,
    side,
  };
  const generatedDiscountCode = getReferralCouponDiscountCode(intendedIdentity);
  let transportedRewardSnapshot: ReferralCouponRewardSnapshot | null = null;
  if (rewardSnapshot) {
    try {
      transportedRewardSnapshot = parseReferralCouponRewardSnapshotForIdentity(
        rewardSnapshot,
        intendedIdentity,
      );
    } catch {
      throw new ShopifyDiscountError(
        "INVALID_REQUEST",
        "Referral coupon outbox payload has an invalid immutable reward snapshot.",
      );
    }
  }

  const { redemption, authorityReferral } = await withReferralCouponProgramLock(
    storeId,
    "lock_only",
    async (tx, program) => {
      const existing = await tx.weleticRewardRedemption.findUnique({
        where: { storeId_idempotencyKey: { storeId, idempotencyKey } },
      });
      if (existing) {
        const referral = await tx.weleticLoyaltyReferral.findFirst({
          where: {
            id: referralId,
            storeId,
            qualifyingOrderId: qualificationOrderId,
          },
        });
        return { redemption: existing, authorityReferral: referral };
      }

      // Existing terminal/live rows remain inspectable while disabled so
      // cleanup and idempotent bookkeeping can finish. Only a new reservation
      // consumes the active program generation.
      assertLockedLoyaltyProgramActive(program, loyaltyMaintenancePermit);

      const [referral, account, store] = await Promise.all([
        tx.weleticLoyaltyReferral.findFirst({
          where: {
            id: referralId,
            storeId,
            qualifyingOrderId: qualificationOrderId,
            status: {
              in: [
                WeleticLoyaltyReferralStatus.qualified,
                WeleticLoyaltyReferralStatus.rewarded,
              ],
            },
          },
        }),
        tx.weleticLoyaltyAccount.findFirst({
          where: { id: accountId, storeId, status: "active" },
          include: { shopper: true },
        }),
        tx.weleticShopifyStore.findUnique({
          where: { id: storeId },
          select: { shopCurrency: true, currencyVerifiedAt: true },
        }),
      ]);
      const currencyMarkerMissingFromLegacyTestMock =
        process.env.NODE_ENV === "test" &&
        store !== null &&
        store?.currencyVerifiedAt === undefined;
      if (
        !referral ||
        !account ||
        !store?.shopCurrency ||
        (!store.currencyVerifiedAt && !currencyMarkerMissingFromLegacyTestMock)
      ) {
        throw new Error(
          "Referral coupon configuration or verified Shopify currency is no longer available.",
        );
      }
      const authoritativeRewardSnapshot =
        getAuthoritativeReferralCouponRewardSnapshot(
          referral,
          intendedIdentity,
        );
      if (transportedRewardSnapshot) {
        if (!authoritativeRewardSnapshot) {
          throw new ShopifyDiscountError(
            "INVALID_REQUEST",
            "Referral coupon payload has no authoritative qualification snapshot.",
          );
        }
        assertRewardSnapshotsEqual(
          authoritativeRewardSnapshot,
          transportedRewardSnapshot,
        );
      }
      if (!authoritativeRewardSnapshot) {
        throw new ShopifyDiscountError(
          "INVALID_REQUEST",
          "Referral coupon qualification has no immutable Shopify provisioning snapshot.",
        );
      }
      const persistedRewardSnapshot = authoritativeRewardSnapshot;
      assertSnapshotProvisioningContext({
        snapshot: persistedRewardSnapshot,
        storeId,
        shopCurrency: store.shopCurrency,
        currencyVerifiedAt: store.currencyVerifiedAt,
        shopifyCustomerId: account.shopper.shopifyCustomerId,
        redemptionId: "new referral coupon",
      });
      if (
        !isReferralCouponProvisionable(
          getRewardDefinitionFromSnapshot(persistedRewardSnapshot),
        )
      ) {
        throw new ShopifyDiscountError(
          "INVALID_REQUEST",
          "Referral coupon qualification snapshot cannot be provisioned in Shopify.",
        );
      }
      const expiresAt = persistedRewardSnapshot.expiresAt
        ? new Date(persistedRewardSnapshot.expiresAt)
        : null;
      const created = await tx.weleticRewardRedemption.create({
        data: {
          id: createWeleticId("wredemp_"),
          storeId,
          accountId,
          rewardDefinitionId,
          pointsSpent: BigInt(0),
          shopifyDiscountCode: generatedDiscountCode,
          shopifyDiscountCodeCanonical: canonicalizeLoyaltyDiscountCode(
            generatedDiscountCode,
          ),
          idempotencyKey,
          status: WeleticRedemptionStatus.provisioning,
          expiresAt,
          metadata: {
            referralId,
            qualificationOrderId,
            referralSide: side,
            shopifyDiscountOwnershipFingerprint:
              persistedRewardSnapshot.ownershipFingerprint,
            shopifyDiscountProvisioningName:
              persistedRewardSnapshot.provisioningName,
            shopifyDiscountExpectedTitle: persistedRewardSnapshot.expectedTitle,
            rewardSnapshot: persistedRewardSnapshot,
          } as Prisma.InputJsonValue,
        },
      });
      return { redemption: created, authorityReferral: referral };
    },
    loyaltyMaintenancePermit,
  );

  assertReferralCouponRedemptionIntent(redemption, intendedIdentity);
  if (authorityReferral) {
    const authoritativeRewardSnapshot =
      getAuthoritativeReferralCouponRewardSnapshot(
        authorityReferral,
        intendedIdentity,
      );
    const persistedRewardSnapshot = getPersistedReferralCouponRewardSnapshot(
      getReferralCouponMetadata(redemption.metadata).value,
      intendedIdentity,
      redemption.id,
    );
    if (authoritativeRewardSnapshot) {
      if (!persistedRewardSnapshot) {
        throw new ShopifyDiscountError(
          "INVALID_REQUEST",
          `Referral coupon ${redemption.id} is missing its persisted qualification snapshot.`,
        );
      }
      assertRewardSnapshotsEqual(
        authoritativeRewardSnapshot,
        persistedRewardSnapshot,
      );
      if (transportedRewardSnapshot) {
        assertRewardSnapshotsEqual(
          authoritativeRewardSnapshot,
          transportedRewardSnapshot,
        );
      }
    }
  }

  if (await recoverCompensatedReferralCouponDiscount({ storeId, redemption })) {
    return redemption;
  }

  if (LIVE_REFERRAL_COUPON_STATUSES.has(redemption.status)) {
    await completeReferralWhenCouponsAreFulfilled({
      storeId,
      referralId,
      qualificationOrderId,
      loyaltyMaintenancePermit,
    });
    return redemption;
  }

  if (redemption.status !== WeleticRedemptionStatus.provisioning) {
    throw new ShopifyDiscountError(
      "INVALID_REQUEST",
      `Referral coupon ${redemption.id} is in unresolved status ${redemption.status}.`,
    );
  }

  if (redemption.status === WeleticRedemptionStatus.provisioning) {
    const existingMetadata = getReferralCouponMetadata(redemption.metadata);
    const persistedRewardSnapshot = getPersistedReferralCouponRewardSnapshot(
      existingMetadata.value,
      intendedIdentity,
      redemption.id,
    );
    if (!persistedRewardSnapshot) {
      throw new ShopifyDiscountError(
        "INVALID_REQUEST",
        `Referral coupon ${redemption.id} cannot provision without an immutable Shopify snapshot.`,
      );
    }
    assertSnapshotExpirationMatchesRedemption(
      persistedRewardSnapshot,
      redemption.expiresAt,
      redemption.id,
    );
    const [account, credentials, store] = await Promise.all([
      prisma.weleticLoyaltyAccount.findFirst({
        where: { id: accountId, storeId, status: "active" },
        include: { shopper: true },
      }),
      resolveShopifyOfflineCredentials({ storeId }),
      prisma.weleticShopifyStore.findUnique({
        where: { id: storeId },
        select: { shopCurrency: true, currencyVerifiedAt: true },
      }),
    ]);
    if (!account || !store?.shopCurrency) {
      throw new Error("Referral coupon configuration is no longer available.");
    }
    assertSnapshotProvisioningContext({
      snapshot: persistedRewardSnapshot,
      storeId,
      shopCurrency: store.shopCurrency,
      currencyVerifiedAt: store.currencyVerifiedAt,
      shopifyCustomerId: account.shopper.shopifyCustomerId,
      redemptionId: redemption.id,
    });
    const discountCode = redemption.shopifyDiscountCode;
    const priorRemoteAttempt =
      typeof existingMetadata.value.remoteProvisionAttemptedAt === "string"
        ? existingMetadata.value.remoteProvisionAttemptedAt
        : null;
    const recordedFingerprint =
      typeof existingMetadata.value.shopifyDiscountOwnershipFingerprint ===
      "string"
        ? existingMetadata.value.shopifyDiscountOwnershipFingerprint
        : null;
    const recordedProvisioningName =
      typeof existingMetadata.value.shopifyDiscountProvisioningName === "string"
        ? existingMetadata.value.shopifyDiscountProvisioningName
        : null;
    const recordedExpectedTitle =
      typeof existingMetadata.value.shopifyDiscountExpectedTitle === "string"
        ? existingMetadata.value.shopifyDiscountExpectedTitle
        : null;
    const ownership = {
      fingerprint: persistedRewardSnapshot.ownershipFingerprint,
      provisioningName: persistedRewardSnapshot.provisioningName,
      expectedTitle: persistedRewardSnapshot.expectedTitle,
    };
    if (
      recordedFingerprint !== ownership.fingerprint ||
      recordedProvisioningName !== ownership.provisioningName ||
      recordedExpectedTitle !== ownership.expectedTitle
    ) {
      throw new ShopifyDiscountError(
        "INVALID_REQUEST",
        `Referral coupon ${redemption.id} has conflicting immutable Shopify ownership metadata.`,
      );
    }
    const rewardDefinitionForProvisioning = getRewardDefinitionFromSnapshot(
      persistedRewardSnapshot,
    );
    const canProvisionOnline = isReferralCouponProvisionable(
      rewardDefinitionForProvisioning,
    );
    const remoteProvisionAttemptedAt =
      priorRemoteAttempt || new Date().toISOString();
    const remoteProvisionPreparationId = priorRemoteAttempt
      ? null
      : `rp_${nanoid(16)}`;
    const parsedAttemptedAt = new Date(remoteProvisionAttemptedAt);
    const existingReconcileUntil =
      typeof existingMetadata.value.remoteProvisionReconcileUntil === "string"
        ? new Date(existingMetadata.value.remoteProvisionReconcileUntil)
        : null;
    const remoteProvisionReconcileUntil =
      existingReconcileUntil &&
      Number.isFinite(existingReconcileUntil.getTime())
        ? existingReconcileUntil.toISOString()
        : new Date(
            (Number.isFinite(parsedAttemptedAt.getTime())
              ? parsedAttemptedAt.getTime()
              : Date.now()) + REFERRAL_COUPON_RECONCILIATION_HORIZON_MS,
          ).toISOString();
    const provisioningMetadata = {
      ...existingMetadata.value,
      referralId,
      qualificationOrderId,
      referralSide: side,
      ...(ownership.fingerprint
        ? {
            shopifyDiscountOwnershipFingerprint: ownership.fingerprint,
            shopifyDiscountProvisioningName: ownership.provisioningName,
            shopifyDiscountExpectedTitle: ownership.expectedTitle,
          }
        : {}),
      remoteProvisionAttemptedAt,
      remoteProvisionReconcileUntil,
      ...(remoteProvisionPreparationId ? { remoteProvisionPreparationId } : {}),
    };
    const provisioningDecision = await withReferralCouponProgramLock(
      storeId,
      "lock_only",
      async (tx, program) => {
        const current = await tx.weleticRewardRedemption.findUnique({
          where: { id: redemption.id },
        });
        if (!current || current.storeId !== storeId) {
          throw new ShopifyDiscountError(
            "INVALID_REQUEST",
            `Referral coupon ${redemption.id} changed tenant during provisioning.`,
          );
        }
        assertReferralCouponRedemptionIntent(current, intendedIdentity);
        if (current.status !== WeleticRedemptionStatus.provisioning) {
          return {
            kind: "resolved" as const,
            redemption: current,
            cleanupComplete: false,
          };
        }
        const canonicalWriteFence =
          getReferralCouponCanonicalWriteFence(current);

        assertLoyaltyMaintenanceWriteAllowed({
          storeId,
          metadata: program.metadata,
          permit: loyaltyMaintenancePermit,
        });

        if (
          isLockedLoyaltyProgramActive(program, loyaltyMaintenancePermit) &&
          canProvisionOnline
        ) {
          assertLockedLoyaltyProgramActive(program, loyaltyMaintenancePermit);
          const marked = await tx.weleticRewardRedemption.updateMany({
            where: {
              id: redemption.id,
              storeId,
              status: WeleticRedemptionStatus.provisioning,
              ...canonicalWriteFence,
            },
            data: { metadata: provisioningMetadata as Prisma.InputJsonValue },
          });
          return { kind: "provision" as const, marked };
        }

        // A previous create may have committed in Shopify before its response
        // was lost. Disabled programs cannot adopt that coupon, but must still
        // reconcile and deactivate it before closing the local reservation.
        const currentMetadata = getReferralCouponMetadata(
          current.metadata,
        ).value;
        const currentRemoteAttempt =
          typeof currentMetadata.remoteProvisionAttemptedAt === "string";
        if (!current.shopifyDiscountId && !currentRemoteAttempt) {
          if (canProvisionOnline) {
            // Nothing reached Shopify, so disabling is a pause rather than a
            // destructive cancellation. A later retry may continue after the
            // merchant re-enables the program.
            assertLockedLoyaltyProgramActive(program, loyaltyMaintenancePermit);
          }
        }
        let remoteDiscount: ShopifyDiscountResult | null = null;
        if (current.shopifyDiscountId || currentRemoteAttempt) {
          remoteDiscount = await lookupDiscountByCode(
            credentials.shopDomain,
            credentials.accessToken,
            current.shopifyDiscountCode,
          );
          if (!remoteDiscount) {
            if (current.shopifyDiscountId) {
              throw new ShopifyDiscountError(
                "INVALID_REQUEST",
                `Stored Shopify discount ${current.shopifyDiscountId} for referral coupon ${current.id} could not be verified; manual reconciliation is required.`,
              );
            }
            const retryUntil =
              getReferralCouponReconciliationDeadline(currentMetadata);
            if (Date.now() < retryUntil.getTime()) {
              throw new ReferralCouponReconciliationPendingError(
                `Shopify referral discount ${current.shopifyDiscountCode} is not visible yet; reconciliation remains pending.`,
                retryUntil,
              );
            }
            throw new ReferralCouponReconciliationRequiredError(
              `Shopify referral discount ${current.shopifyDiscountCode} is still absent after an uncertain create for referral coupon ${current.id}; manual reconciliation is required.`,
            );
          }
        }

        if (remoteDiscount) {
          const expectation = getReferralCouponOwnershipExpectation(current);
          if (
            (current.shopifyDiscountId &&
              current.shopifyDiscountId !== remoteDiscount.id) ||
            !isShopifyDiscountOwned({
              discount: remoteDiscount,
              expectedCode: expectation.expectedCode,
              expectedTitle: expectation.expectedTitle,
            })
          ) {
            throw new ShopifyDiscountError(
              "INVALID_REQUEST",
              `Shopify discount code collision for disabled referral coupon ${current.id}; manual reconciliation is required.`,
            );
          }
        }

        const cancelled = await tx.weleticRewardRedemption.updateMany({
          where: {
            id: current.id,
            storeId,
            status: WeleticRedemptionStatus.provisioning,
            ...canonicalWriteFence,
          },
          data: {
            status: WeleticRedemptionStatus.cancelled,
            shopifyDiscountId:
              remoteDiscount?.id || current.shopifyDiscountId || null,
            compensationReason: canProvisionOnline
              ? "Loyalty program was disabled before referral coupon issuance."
              : "Referral coupon snapshot is not authorized for online-store provisioning.",
            metadata: {
              ...currentMetadata,
              cancelledAt: new Date().toISOString(),
              cancellationReason: canProvisionOnline
                ? "program_disabled"
                : "sales_channel_not_online_store",
            } as Prisma.InputJsonValue,
          },
        });
        if (
          cancelled.count === 1 &&
          remoteDiscount &&
          !isInactiveShopifyDiscountStatus(remoteDiscount.status)
        ) {
          await deactivateReferralDiscount({
            shopDomain: credentials.shopDomain,
            accessToken: credentials.accessToken,
            discountId: remoteDiscount.id,
          });
        }
        const latest = await tx.weleticRewardRedemption.findUnique({
          where: { id: current.id },
        });
        return {
          kind: "resolved" as const,
          redemption: latest || current,
          cleanupComplete: cancelled.count === 1,
        };
      },
      loyaltyMaintenancePermit,
    );
    if (provisioningDecision.kind === "resolved") {
      const latest = provisioningDecision.redemption;
      if (provisioningDecision.cleanupComplete) return latest;
      if (
        await recoverCompensatedReferralCouponDiscount({
          storeId,
          redemption: latest,
        })
      ) {
        return latest;
      }
      if (LIVE_REFERRAL_COUPON_STATUSES.has(latest.status)) {
        await completeReferralWhenCouponsAreFulfilled({
          storeId,
          referralId,
          qualificationOrderId,
          loyaltyMaintenancePermit,
        });
      }
      return latest;
    }
    const markedForRemoteProvision = provisioningDecision.marked;
    if (markedForRemoteProvision.count === 0) {
      const latest = await prisma.weleticRewardRedemption.findUnique({
        where: { id: redemption.id },
      });
      if (
        latest &&
        (await recoverCompensatedReferralCouponDiscount({
          storeId,
          redemption: latest,
        }))
      ) {
        return latest;
      }
      if (latest && LIVE_REFERRAL_COUPON_STATUSES.has(latest.status)) {
        await completeReferralWhenCouponsAreFulfilled({
          storeId,
          referralId,
          qualificationOrderId,
          loyaltyMaintenancePermit,
        });
      }
      return latest || redemption;
    }

    let remoteCreateStarted = false;
    let phaseTwoResult:
      | {
          issued: { count: number };
          latestAfterFinalization: Awaited<
            ReturnType<typeof prisma.weleticRewardRedemption.findUnique>
          >;
        }
      | undefined;
    try {
      phaseTwoResult = await withReferralCouponProgramLock(
        storeId,
        "active",
        async (tx) => {
          const currentBeforeRemote =
            await tx.weleticRewardRedemption.findUnique({
              where: { id: redemption.id },
            });
          if (!currentBeforeRemote || currentBeforeRemote.storeId !== storeId) {
            throw new ShopifyDiscountError(
              "INVALID_REQUEST",
              `Referral coupon ${redemption.id} changed tenant before Shopify provisioning.`,
            );
          }
          assertReferralCouponRedemptionIntent(
            currentBeforeRemote,
            intendedIdentity,
          );
          if (
            currentBeforeRemote.status !== WeleticRedemptionStatus.provisioning
          ) {
            return {
              issued: { count: 0 },
              latestAfterFinalization: currentBeforeRemote,
            };
          }
          const canonicalWriteFence =
            getReferralCouponCanonicalWriteFence(currentBeforeRemote);
          const currentShopCurrency =
            await assertLockedLoyaltyProgramCurrencyGeneration({
              tx,
              storeId,
              expectedCurrency: persistedRewardSnapshot.shopCurrency,
              expectedCurrencyVerifiedAt:
                persistedRewardSnapshot.currencyVerifiedAt,
            });

          const existingDiscount = await lookupDiscountByCode(
            credentials.shopDomain,
            credentials.accessToken,
            discountCode,
          );
          if (existingDiscount) {
            if (
              !isShopifyDiscountOwned({
                discount: existingDiscount,
                expectedCode: discountCode,
                expectedTitle: ownership.expectedTitle,
              })
            ) {
              throw new ShopifyDiscountError(
                "INVALID_REQUEST",
                `Shopify discount code collision for referral coupon ${redemption.id}; the existing discount is not owned by the intended referral configuration.`,
              );
            }
            const matchesImmutableConfiguration =
              persistedRewardSnapshot !== null &&
              existingDiscount.status === "ACTIVE" &&
              matchesLoyaltyRewardDiscountConfiguration({
                remote: existingDiscount,
                rewardDefinition: rewardDefinitionForProvisioning,
                startsAt: new Date(persistedRewardSnapshot.startsAt),
                expiresAt: persistedRewardSnapshot.expiresAt
                  ? new Date(persistedRewardSnapshot.expiresAt)
                  : null,
                expectedShopCurrency: persistedRewardSnapshot.shopCurrency,
                shopifyCustomerId: account.shopper.shopifyCustomerId,
              });
            if (!matchesImmutableConfiguration) {
              if (!isInactiveShopifyDiscountStatus(existingDiscount.status)) {
                await deactivateReferralDiscount({
                  shopDomain: credentials.shopDomain,
                  accessToken: credentials.accessToken,
                  discountId: existingDiscount.id,
                });
              }
              const cancelled = await tx.weleticRewardRedemption.updateMany({
                where: {
                  id: redemption.id,
                  storeId,
                  status: WeleticRedemptionStatus.provisioning,
                  ...canonicalWriteFence,
                },
                data: {
                  status: WeleticRedemptionStatus.cancelled,
                  shopifyDiscountId: existingDiscount.id,
                  compensationReason:
                    "Owned Shopify referral discount is inactive or no longer matches its immutable configuration.",
                  metadata: {
                    ...provisioningMetadata,
                    cancelledAt: new Date().toISOString(),
                    cancellationReason: "remote_configuration_invalid",
                  } as Prisma.InputJsonValue,
                },
              });
              const latestAfterFinalization =
                await tx.weleticRewardRedemption.findUnique({
                  where: { id: redemption.id },
                });
              return {
                issued: { count: 0 },
                latestAfterFinalization:
                  cancelled.count === 1
                    ? latestAfterFinalization || currentBeforeRemote
                    : latestAfterFinalization,
              };
            }
          }
          let provisioned = existingDiscount;
          if (!provisioned) {
            remoteCreateStarted = true;
            provisioned = await provisionLoyaltyRewardDiscount({
              storeId,
              shopDomain: credentials.shopDomain,
              accessToken: credentials.accessToken,
              resolvedCredentials: credentials,
              rewardDefinition: rewardDefinitionForProvisioning,
              discountCode,
              expiresAt: persistedRewardSnapshot?.expiresAt
                ? new Date(persistedRewardSnapshot.expiresAt)
                : redemption.expiresAt,
              startsAt: persistedRewardSnapshot
                ? new Date(persistedRewardSnapshot.startsAt)
                : undefined,
              expectedShopCurrency: persistedRewardSnapshot?.shopCurrency,
              currentShopCurrency,
              shopifyCustomerId: account.shopper.shopifyCustomerId,
            });
          }
          assertShopifyDiscountOwnership({
            redemptionId: redemption.id,
            discount: provisioned,
            expectedCode: discountCode,
            expectedTitle: ownership.expectedTitle,
            requireActive: true,
          });

          // This transaction already owns the program row lock. The guarded
          // referral update then serializes qualification invalidation before
          // the provisioning -> issued transition.
          const validGeneration = await tx.weleticLoyaltyReferral.updateMany({
            where: {
              id: referralId,
              storeId,
              qualifyingOrderId: qualificationOrderId,
              status: {
                in: [
                  WeleticLoyaltyReferralStatus.qualified,
                  WeleticLoyaltyReferralStatus.rewarded,
                ],
              },
            },
            data: { updatedAt: new Date() },
          });
          let issued: { count: number };
          if (validGeneration.count !== 1) {
            await tx.weleticRewardRedemption.updateMany({
              where: {
                id: redemption.id,
                storeId,
                status: WeleticRedemptionStatus.provisioning,
                ...canonicalWriteFence,
              },
              data: {
                status: WeleticRedemptionStatus.cancelled,
                shopifyDiscountId: provisioned.id,
                compensationReason:
                  "Referral generation became invalid during coupon provisioning",
                metadata: {
                  ...provisioningMetadata,
                  cancelledAt: new Date().toISOString(),
                  cancellationReason: "referral_generation_invalid",
                } as Prisma.InputJsonValue,
              },
            });
            issued = { count: 0 };
          } else {
            issued = await tx.weleticRewardRedemption.updateMany({
              where: {
                id: redemption.id,
                storeId,
                status: WeleticRedemptionStatus.provisioning,
                ...canonicalWriteFence,
              },
              data: {
                status: WeleticRedemptionStatus.issued,
                shopifyDiscountId: provisioned.id,
              },
            });
          }

          if (issued.count !== 0) {
            return { issued, latestAfterFinalization: null };
          }

          const latestAfterFinalization =
            await tx.weleticRewardRedemption.findUnique({
              where: { id: redemption.id },
            });
          if (
            latestAfterFinalization &&
            LIVE_REFERRAL_COUPON_STATUSES.has(latestAfterFinalization.status)
          ) {
            return { issued, latestAfterFinalization };
          }

          await tx.weleticRewardRedemption.updateMany({
            where: {
              id: redemption.id,
              storeId,
              status: {
                in: [
                  WeleticRedemptionStatus.cancelled,
                  WeleticRedemptionStatus.expired,
                  WeleticRedemptionStatus.failed,
                ],
              },
              shopifyDiscountId: null,
              ...canonicalWriteFence,
            },
            data: { shopifyDiscountId: provisioned.id },
          });
          // Persisting the remote ID makes a failed deactivation recoverable on
          // the next outbox retry through the compensated-state branch above.
          await deactivateReferralDiscount({
            shopDomain: credentials.shopDomain,
            accessToken: credentials.accessToken,
            discountId: provisioned.id,
          });
          return { issued, latestAfterFinalization };
        },
        loyaltyMaintenancePermit,
      );
    } catch (error) {
      if (isLoyaltyMaintenanceBlockedError(error)) {
        // A maintenance deferral must leave the exact ambiguity marker intact;
        // only the authorized owner or a later post-lease retry may advance it.
        throw error;
      }
      if (remoteProvisionPreparationId && !remoteCreateStarted) {
        await withReferralCouponProgramLock(
          storeId,
          "lock_only",
          async (tx) => {
            const current = await tx.weleticRewardRedemption.findUnique({
              where: { id: redemption.id },
            });
            if (!current || current.storeId !== storeId) return;
            assertReferralCouponRedemptionIntent(current, intendedIdentity);
            if (current.status !== WeleticRedemptionStatus.provisioning) return;
            const clearedMetadata = clearLoyaltyDiscountRemoteProvisionAttempt({
              metadata: current.metadata,
              preparationId: remoteProvisionPreparationId,
            });
            if (!clearedMetadata) return;
            await tx.weleticRewardRedemption.updateMany({
              where: {
                id: current.id,
                storeId,
                status: WeleticRedemptionStatus.provisioning,
                ...getReferralCouponCanonicalWriteFence(current),
              },
              data: { metadata: clearedMetadata },
            });
          },
        );
      }
      throw error;
    }
    if (!phaseTwoResult) {
      throw new ShopifyDiscountError(
        "INVALID_REQUEST",
        `Referral coupon ${redemption.id} did not produce a provisioning result.`,
      );
    }
    const { issued, latestAfterFinalization } = phaseTwoResult;
    if (issued.count === 0) {
      if (
        latestAfterFinalization &&
        LIVE_REFERRAL_COUPON_STATUSES.has(latestAfterFinalization.status)
      ) {
        // Another idempotent worker finalized the same deterministic coupon.
        await completeReferralWhenCouponsAreFulfilled({
          storeId,
          referralId,
          qualificationOrderId,
          loyaltyMaintenancePermit,
        });
        return latestAfterFinalization;
      }
      return latestAfterFinalization || redemption;
    }
  }

  await completeReferralWhenCouponsAreFulfilled({
    storeId,
    referralId,
    qualificationOrderId,
    loyaltyMaintenancePermit,
  });

  return redemption;
}
