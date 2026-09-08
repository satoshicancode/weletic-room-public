import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

const LOYALTY_DISCOUNT_IDENTITY_HEX_LENGTH = 24;
const SHOPIFY_DISCOUNT_TITLE_MAX_LENGTH = 255;
const SHOPIFY_DISCOUNT_CODE_MAX_LENGTH = 191;
export const LOYALTY_DISCOUNT_RECONCILIATION_HORIZON_MS = 120_000;

export class LoyaltyDiscountReconciliationPendingError extends Error {
  constructor(
    message: string,
    public retryUntil: Date,
  ) {
    super(message);
    this.name = "LoyaltyDiscountReconciliationPendingError";
  }
}

export class LoyaltyDiscountReconciliationRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoyaltyDiscountReconciliationRequiredError";
  }
}

export type LoyaltyDiscountOwnershipIdentity = {
  storeId: string;
  redemptionId: string;
  rewardDefinitionId: string;
  discountCode: string;
} & (
  | { accountId: string; ownerKind?: never }
  | {
      ownerKind: "shopper";
      shopperId: string;
      fulfillmentSource: string;
      fulfillmentReference: string;
      accountId?: never;
    }
);

export type LoyaltyDiscountProvisioningIdentity = {
  version: 1 | 2;
  fingerprint: string;
  provisioningName: string;
  expectedTitle: string;
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function canonicalizeLoyaltyDiscountCode(code: string) {
  const canonical = code.normalize("NFKC").trim().toUpperCase();
  if (
    !canonical ||
    canonical.length > SHOPIFY_DISCOUNT_CODE_MAX_LENGTH ||
    /[\u0000-\u001F\u007F]/.test(canonical)
  ) {
    throw new Error("Shopify loyalty discount code is invalid.");
  }
  return canonical;
}

export function markLoyaltyDiscountRemoteProvisionAttempt({
  metadata,
  now = new Date(),
  reset = false,
  preparationId,
}: {
  metadata: unknown;
  now?: Date;
  reset?: boolean;
  preparationId?: string;
}): Prisma.InputJsonValue {
  const root = asObject(metadata) ?? {};
  const existingAttempt =
    !reset && typeof root.remoteProvisionAttemptedAt === "string"
      ? new Date(root.remoteProvisionAttemptedAt)
      : null;
  const attemptedAt =
    existingAttempt && Number.isFinite(existingAttempt.getTime())
      ? existingAttempt
      : now;
  const existingDeadline =
    !reset && typeof root.remoteProvisionReconcileUntil === "string"
      ? new Date(root.remoteProvisionReconcileUntil)
      : null;
  const reconcileUntil =
    existingDeadline && Number.isFinite(existingDeadline.getTime())
      ? existingDeadline
      : new Date(
          attemptedAt.getTime() + LOYALTY_DISCOUNT_RECONCILIATION_HORIZON_MS,
        );

  return {
    ...root,
    remoteProvisionAttemptedAt: attemptedAt.toISOString(),
    remoteProvisionReconcileUntil: reconcileUntil.toISOString(),
    ...(preparationId ? { remoteProvisionPreparationId: preparationId } : {}),
  } as Prisma.InputJsonValue;
}

/**
 * Clears only the marker prepared by the same invocation. A later worker may
 * replace the preparation id before this worker observes its pre-dispatch
 * fence failure; preserving the marker in that case is deliberately safer
 * than declaring a possibly dispatched create absent.
 */
export function clearLoyaltyDiscountRemoteProvisionAttempt({
  metadata,
  preparationId,
}: {
  metadata: unknown;
  preparationId: string;
}): Prisma.InputJsonValue | null {
  const root = asObject(metadata);
  if (root?.remoteProvisionPreparationId !== preparationId) return null;
  const cleared = { ...root };
  delete cleared.remoteProvisionAttemptedAt;
  delete cleared.remoteProvisionReconcileUntil;
  delete cleared.remoteProvisionPreparationId;
  return cleared as Prisma.InputJsonValue;
}

export function assertLoyaltyDiscountLookupMissIsTerminal({
  redemptionId,
  discountCode,
  metadata,
  now = new Date(),
}: {
  redemptionId: string;
  discountCode: string;
  metadata: unknown;
  now?: Date;
}) {
  const root = asObject(metadata);
  if (!root || typeof root.remoteProvisionAttemptedAt !== "string") {
    // Compensation completed before any Shopify create call began.
    return;
  }

  const attemptedAt = new Date(root.remoteProvisionAttemptedAt);
  if (!Number.isFinite(attemptedAt.getTime())) {
    throw new Error(
      `Redemption ${redemptionId} has an invalid remote provisioning marker.`,
    );
  }
  const explicitDeadline =
    typeof root.remoteProvisionReconcileUntil === "string"
      ? new Date(root.remoteProvisionReconcileUntil)
      : null;
  const retryUntil =
    explicitDeadline && Number.isFinite(explicitDeadline.getTime())
      ? explicitDeadline
      : new Date(
          attemptedAt.getTime() + LOYALTY_DISCOUNT_RECONCILIATION_HORIZON_MS,
        );
  if (now.getTime() < retryUntil.getTime()) {
    throw new LoyaltyDiscountReconciliationPendingError(
      `Shopify loyalty discount ${discountCode} is not visible yet; reconciliation remains pending.`,
      retryUntil,
    );
  }
  throw new LoyaltyDiscountReconciliationRequiredError(
    `Shopify loyalty discount ${discountCode} is still absent after an uncertain create for redemption ${redemptionId}; absence cannot prove that no remote voucher exists, so manual reconciliation is required.`,
  );
}

export function getLoyaltyDiscountOwnershipFingerprint(
  identity: LoyaltyDiscountOwnershipIdentity,
) {
  // Preserve historical v1 fingerprints byte-for-byte. Shopper identities use
  // an explicitly separated domain, not a fabricated loyalty account ID.
  const parts =
    identity.ownerKind === "shopper"
      ? [
          "shopper-fulfillment-v2",
          identity.storeId,
          identity.redemptionId,
          identity.shopperId,
          identity.fulfillmentSource,
          identity.fulfillmentReference,
          identity.rewardDefinitionId,
          canonicalizeLoyaltyDiscountCode(identity.discountCode),
        ]
      : [
          identity.storeId,
          identity.redemptionId,
          identity.accountId,
          identity.rewardDefinitionId,
          canonicalizeLoyaltyDiscountCode(identity.discountCode),
        ];
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, LOYALTY_DISCOUNT_IDENTITY_HEX_LENGTH)
    .toUpperCase();
}

export function createLoyaltyDiscountProvisioningIdentity({
  identity,
  rewardName,
}: {
  identity: LoyaltyDiscountOwnershipIdentity;
  rewardName: string;
}): LoyaltyDiscountProvisioningIdentity {
  const fingerprint = getLoyaltyDiscountOwnershipFingerprint(identity);
  const ownershipSuffix = ` [WL:${fingerprint}]`;
  const codeSuffix = ` (${canonicalizeLoyaltyDiscountCode(identity.discountCode)})`;
  const maximumBaseLength =
    SHOPIFY_DISCOUNT_TITLE_MAX_LENGTH -
    ownershipSuffix.length -
    codeSuffix.length;
  const normalizedRewardName = rewardName.trim() || "Loyalty reward";
  const baseName = normalizedRewardName.slice(0, maximumBaseLength).trimEnd();
  const provisioningName = `${baseName}${ownershipSuffix}`;

  return {
    version: identity.ownerKind === "shopper" ? 2 : 1,
    fingerprint,
    provisioningName,
    expectedTitle: `${provisioningName}${codeSuffix}`,
  };
}

export function getPersistedLoyaltyDiscountProvisioningIdentity({
  identity,
  metadata,
}: {
  identity: LoyaltyDiscountOwnershipIdentity;
  metadata: unknown;
}): LoyaltyDiscountProvisioningIdentity | null {
  const root = asObject(metadata);
  if (!root) return null;

  const ownership = asObject(root.shopifyDiscountOwnership);
  if (ownership) {
    const rewardSnapshot = asObject(root.rewardSnapshot);
    const rewardName = rewardSnapshot?.name;
    if (typeof rewardName !== "string") {
      throw new Error(
        `Redemption ${identity.redemptionId} is missing its immutable reward name.`,
      );
    }
    const expected = createLoyaltyDiscountProvisioningIdentity({
      identity,
      rewardName,
    });
    if (
      ownership.version !== expected.version ||
      ownership.fingerprint !== expected.fingerprint ||
      ownership.provisioningName !== expected.provisioningName ||
      ownership.expectedTitle !== expected.expectedTitle
    ) {
      throw new Error(
        `Redemption ${identity.redemptionId} has invalid Shopify discount ownership metadata.`,
      );
    }
    return expected;
  }

  // Legacy rows lack the tenant/redemption-bound fingerprint. Even an exact
  // old-style title can be recreated by a merchant, so code-based automation
  // must fail closed and route those rows to manual reconciliation.
  return null;
}

export function mergeLoyaltyDiscountOwnershipMetadata({
  metadata,
  ownership,
}: {
  metadata: unknown;
  ownership: LoyaltyDiscountProvisioningIdentity;
}): Prisma.InputJsonValue {
  return {
    ...(asObject(metadata) ?? {}),
    shopifyDiscountOwnership: ownership,
  } as Prisma.InputJsonValue;
}

export function getPrivacySafeLoyaltyDiscountMetadata(
  metadata: unknown,
): Prisma.InputJsonObject {
  const root = asObject(metadata) ?? {};
  const rewardSnapshot = asObject(root.rewardSnapshot);
  const ownership = asObject(root.shopifyDiscountOwnership);

  return {
    privacySafeCancellation: true,
    ...(rewardSnapshot ? { rewardSnapshot } : {}),
    ...(ownership ? { shopifyDiscountOwnership: ownership } : {}),
    ...(typeof root.remoteProvisionAttemptedAt === "string"
      ? { remoteProvisionAttemptedAt: root.remoteProvisionAttemptedAt }
      : {}),
    ...(typeof root.remoteProvisionReconcileUntil === "string"
      ? { remoteProvisionReconcileUntil: root.remoteProvisionReconcileUntil }
      : {}),
  } as Prisma.InputJsonObject;
}

export function assertExpectedLoyaltyDiscountNode({
  identity,
  metadata,
  remote,
  requireActive = false,
}: {
  identity: LoyaltyDiscountOwnershipIdentity;
  metadata: unknown;
  remote: { code: string; title: string; status?: string };
  requireActive?: boolean;
}): LoyaltyDiscountProvisioningIdentity {
  const expected = getPersistedLoyaltyDiscountProvisioningIdentity({
    identity,
    metadata,
  });
  if (!expected) {
    throw new Error(
      `Cannot verify Shopify discount ownership for redemption ${identity.redemptionId}.`,
    );
  }
  if (
    !matchesExpectedLoyaltyDiscountNode({
      identity,
      expected,
      remote,
      requireActive,
    })
  ) {
    throw new Error(
      `Shopify discount ownership mismatch for redemption ${identity.redemptionId}.`,
    );
  }
  return expected;
}

export function matchesExpectedLoyaltyDiscountNode({
  identity,
  expected,
  remote,
  requireActive = false,
}: {
  identity: LoyaltyDiscountOwnershipIdentity;
  expected: LoyaltyDiscountProvisioningIdentity;
  remote: { code: string; title: string; status?: string };
  requireActive?: boolean;
}) {
  let codesMatch = false;
  try {
    codesMatch =
      canonicalizeLoyaltyDiscountCode(remote.code) ===
      canonicalizeLoyaltyDiscountCode(identity.discountCode);
  } catch {
    return false;
  }
  return (
    codesMatch &&
    remote.title === expected.expectedTitle &&
    (!requireActive || remote.status === "ACTIVE")
  );
}
