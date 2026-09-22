import type { Prisma } from "@prisma/client";

/** Explicit scope prevents a missing customer ID from widening an erasure to
 * the whole shop. Whole-store callers must separately hold the frozen-store
 * fence; customer callers must hold the customer settlement/privacy fence.
 * These builders do not acquire locks or certify database erasure.
 */
export type StoreReviewPrivacyScope =
  | { kind: "customer"; storeId: string; shopperId: string }
  | { kind: "frozen_store"; storeId: string };

function ownerWhere(scope: StoreReviewPrivacyScope) {
  assertOwnerId(scope.storeId);
  if (scope.kind === "customer") {
    assertOwnerId(scope.shopperId);
    return { storeId: scope.storeId, shopperId: scope.shopperId };
  }
  if (scope.kind !== "frozen_store") throw new Error("Invalid privacy scope");
  return { storeId: scope.storeId };
}

function assertOwnerId(value: string) {
  if (!value || value !== value.trim() || value.length > 191)
    throw new Error("Invalid store-review privacy identity");
}

export function storeReviewContentRedactionWhere(
  scope: StoreReviewPrivacyScope,
) {
  return {
    ...ownerWhere(scope),
    OR: [
      { status: { not: "redacted" as const } },
      { redactedAt: null },
      { title: { not: "" } },
      { body: { not: "" } },
      { displayName: { not: "Redacted customer" } },
      { merchantReply: { not: null } },
      { participationStatus: { not: "privacy_redacted" } },
      { participationValidatedAt: { not: null } },
      { participationValidationRevision: { not: null } },
      { participationContentDigest: { not: null } },
    ],
  } satisfies Prisma.WeleticStoreReviewWhereInput;
}

export function storeReviewContentRedactionData(
  row: { version: number; redactedAt: Date | null },
  now: Date,
) {
  if (
    !Number.isInteger(row.version) ||
    row.version < 1 ||
    row.version > 2147483647
  )
    throw new Error("Invalid store review version during privacy erasure");
  return {
    status: "redacted" as const,
    version: Math.min(row.version + 1, 2147483647),
    title: "",
    body: "",
    displayName: "Redacted customer",
    merchantReply: null,
    participationStatus: "privacy_redacted",
    participationValidatedAt: null,
    participationValidationRevision: null,
    participationContentDigest: null,
    redactedAt: row.redactedAt ?? now,
  } satisfies Prisma.WeleticStoreReviewUpdateManyMutationInput;
}

export function storeReviewRequestRedactionWhere(
  scope: StoreReviewPrivacyScope,
) {
  return {
    ...ownerWhere(scope),
    OR: [
      { status: { not: "cancelled" as const } },
      { cancelledAt: null },
      { cancellationReason: null },
      { cancellationReason: { not: "privacy_redaction" } },
      { tokenHash: { not: null } },
      { encryptedDeliveryToken: { not: null } },
      { encryptedDeliverySnapshot: { not: null } },
      { deliveryToken: { not: null } },
      { deliveryLeaseExpiresAt: { not: null } },
      { deliveryReservedAt: { not: null } },
      { lastError: { not: null } },
    ],
  } satisfies Prisma.WeleticStoreReviewRequestWhereInput;
}

export function storeReviewRequestRedactionData(
  row: { cancelledAt: Date | null },
  now: Date,
) {
  return {
    status: "cancelled" as const,
    cancelledAt: row.cancelledAt ?? now,
    cancellationReason: "privacy_redaction",
    tokenHash: null,
    encryptedDeliveryToken: null,
    encryptedDeliverySnapshot: null,
    deliveryToken: null,
    deliveryLeaseExpiresAt: null,
    deliveryReservedAt: null,
    lastError: null,
  } satisfies Prisma.WeleticStoreReviewRequestUpdateManyMutationInput;
}

export function storeReviewAuditRedactionWhere(scope: StoreReviewPrivacyScope) {
  const owner = ownerWhere(scope);
  return {
    storeId: scope.storeId,
    // Whole-shop erasure must also find orphaned audits. A customer erasure
    // requires a same-store content owner; it must not touch other shoppers.
    ...(scope.kind === "customer" ? { review: owner } : {}),
    OR: [
      { redactedAt: null },
      { reasonDetails: { not: null } },
      { actorUserId: { not: null } },
      { merchantActionId: { not: null } },
    ],
  } satisfies Prisma.WeleticStoreReviewModerationAuditWhereInput;
}

export function storeReviewAuditRedactionData(
  row: { redactedAt: Date | null },
  now: Date,
) {
  return {
    reasonDetails: null,
    actorUserId: null,
    merchantActionId: null,
    redactedAt: row.redactedAt ?? now,
  } satisfies Prisma.WeleticStoreReviewModerationAuditUpdateManyMutationInput;
}
