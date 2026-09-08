import { Prisma } from "@prisma/client";
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Reserved system metadata. The key carries the lease schema version so the
 * stored value itself can remain limited to digests and timestamps.
 */
export const LOYALTY_MAINTENANCE_METADATA_KEY =
  "__weleticLoyaltyMaintenanceLeaseV1" as const;

export const LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG =
  "weletic-a1-disposable" as const;

const SHA_256_PATTERN = /^[a-f0-9]{64}$/;
const LOYALTY_MAINTENANCE_PERMIT_BRAND = Symbol(
  "WeleticLoyaltyMaintenancePermit",
);

export type LoyaltyMaintenanceLease = {
  acquiredAt: string;
  baselineMetadataSha256: string;
  fixtureDisposableTagSha256: string;
  fixtureEmailSha256: readonly string[];
  fixtureRunMarkerTagSha256: string;
  ownerTokenSha256: string;
  recoveryAfter: string;
};

export type LoyaltyMaintenancePermit = {
  readonly [LOYALTY_MAINTENANCE_PERMIT_BRAND]: true;
  readonly authorization: "owner_token" | "fixture_customer_create";
  readonly leaseSha256: string;
  readonly storeId: string;
};

export class LoyaltyMaintenanceBlockedError extends Error {
  readonly reason: "active_lease" | "invalid_metadata" | "invalid_permit";
  readonly storeId?: string;

  constructor({
    reason = "active_lease",
    storeId,
  }: {
    reason?: LoyaltyMaintenanceBlockedError["reason"];
    storeId?: string;
  } = {}) {
    super("Loyalty operational writes are blocked by a maintenance lease.");
    this.name = "LoyaltyMaintenanceBlockedError";
    this.reason = reason;
    this.storeId = storeId;
  }
}

export function isLoyaltyMaintenanceBlockedError(
  error: unknown,
): error is LoyaltyMaintenanceBlockedError {
  return error instanceof LoyaltyMaintenanceBlockedError;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }
  return serialized;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalMetadataSha256(metadata: unknown) {
  return sha256(canonicalJson(metadata ?? null));
}

function normalizedOwnerToken(ownerToken: string) {
  if (
    typeof ownerToken !== "string" ||
    ownerToken.length < 32 ||
    ownerToken !== ownerToken.trim()
  ) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_permit" });
  }
  return ownerToken;
}

function normalizedRunMarker(runMarker: string) {
  const normalized = runMarker.trim();
  if (!normalized) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }
  return normalized;
}

function normalizedEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }
  return normalized;
}

function normalizedTags(tags: string | readonly string[]) {
  const values = typeof tags === "string" ? tags.split(",") : [...tags];
  return Array.from(new Set(values.map((tag) => tag.trim()).filter(Boolean)));
}

function exactIsoTimestamp(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }
  return value.toISOString();
}

function safeDigestEquals(left: string, right: string) {
  if (!SHA_256_PATTERN.test(left) || !SHA_256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function assertExactIdentifier(value: string, storeId?: string) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_metadata",
      storeId,
    });
  }
  return value;
}

function leaseSha256(lease: LoyaltyMaintenanceLease) {
  return sha256(canonicalJson(lease));
}

function assertStoreId(storeId: string) {
  const normalized = storeId.trim();
  if (!normalized || normalized !== storeId) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_permit",
      storeId: normalized || undefined,
    });
  }
  return normalized;
}

function createPermit({
  authorization,
  lease,
  storeId,
}: {
  authorization: LoyaltyMaintenancePermit["authorization"];
  lease: LoyaltyMaintenanceLease;
  storeId: string;
}): LoyaltyMaintenancePermit {
  return Object.freeze({
    [LOYALTY_MAINTENANCE_PERMIT_BRAND]: true as const,
    authorization,
    leaseSha256: leaseSha256(lease),
    storeId: assertStoreId(storeId),
  });
}

function isValidLeaseTimestamp(value: unknown) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function parseLease(value: unknown): LoyaltyMaintenanceLease {
  if (!isPlainObject(value)) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }
  const expectedKeys = [
    "acquiredAt",
    "baselineMetadataSha256",
    "fixtureDisposableTagSha256",
    "fixtureEmailSha256",
    "fixtureRunMarkerTagSha256",
    "ownerTokenSha256",
    "recoveryAfter",
  ];
  if (
    Object.keys(value).length !== expectedKeys.length ||
    !expectedKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key),
    )
  ) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }

  const fixtureEmailSha256 = value.fixtureEmailSha256;
  const digests = [
    value.baselineMetadataSha256,
    value.fixtureDisposableTagSha256,
    value.fixtureRunMarkerTagSha256,
    value.ownerTokenSha256,
    ...(Array.isArray(fixtureEmailSha256) ? fixtureEmailSha256 : []),
  ];
  if (
    !Array.isArray(fixtureEmailSha256) ||
    fixtureEmailSha256.length === 0 ||
    fixtureEmailSha256.some(
      (digest) => typeof digest !== "string" || !SHA_256_PATTERN.test(digest),
    ) ||
    new Set(fixtureEmailSha256).size !== fixtureEmailSha256.length ||
    digests.some(
      (digest) => typeof digest !== "string" || !SHA_256_PATTERN.test(digest),
    ) ||
    !isValidLeaseTimestamp(value.acquiredAt) ||
    !isValidLeaseTimestamp(value.recoveryAfter) ||
    Date.parse(value.recoveryAfter as string) <=
      Date.parse(value.acquiredAt as string)
  ) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }

  return Object.freeze({
    acquiredAt: value.acquiredAt as string,
    baselineMetadataSha256: value.baselineMetadataSha256 as string,
    fixtureDisposableTagSha256: value.fixtureDisposableTagSha256 as string,
    fixtureEmailSha256: Object.freeze([...(fixtureEmailSha256 as string[])]),
    fixtureRunMarkerTagSha256: value.fixtureRunMarkerTagSha256 as string,
    ownerTokenSha256: value.ownerTokenSha256 as string,
    recoveryAfter: value.recoveryAfter as string,
  });
}

function metadataObject(metadata: unknown) {
  if (metadata === null || metadata === undefined) return {};
  if (!isPlainObject(metadata)) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }
  return metadata;
}

export function createLoyaltyMaintenanceLeaseMetadata({
  existingMetadata,
  ownerToken,
  runMarker,
  fixtureEmails,
  acquiredAt,
  recoveryAfter,
}: {
  existingMetadata: Prisma.JsonValue | null | undefined;
  ownerToken: string;
  runMarker: string;
  fixtureEmails: readonly string[];
  acquiredAt: Date;
  recoveryAfter: Date;
}): Prisma.InputJsonObject {
  const metadata = metadataObject(existingMetadata);
  if (
    Object.prototype.hasOwnProperty.call(
      metadata,
      LOYALTY_MAINTENANCE_METADATA_KEY,
    )
  ) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "active_lease" });
  }
  const acquiredAtIso = exactIsoTimestamp(acquiredAt);
  const recoveryAfterIso = exactIsoTimestamp(recoveryAfter);
  if (recoveryAfter.getTime() <= acquiredAt.getTime()) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }
  const fixtureEmailSha256 = Array.from(
    new Set(fixtureEmails.map((email) => sha256(normalizedEmail(email)))),
  ).sort();
  if (fixtureEmailSha256.length === 0) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }

  const lease: LoyaltyMaintenanceLease = {
    acquiredAt: acquiredAtIso,
    baselineMetadataSha256: canonicalMetadataSha256(existingMetadata ?? null),
    fixtureDisposableTagSha256: sha256(
      LOYALTY_MAINTENANCE_DISPOSABLE_CUSTOMER_TAG,
    ),
    fixtureEmailSha256,
    fixtureRunMarkerTagSha256: sha256(normalizedRunMarker(runMarker)),
    ownerTokenSha256: sha256(normalizedOwnerToken(ownerToken)),
    recoveryAfter: recoveryAfterIso,
  };

  return {
    ...(metadata as Prisma.InputJsonObject),
    [LOYALTY_MAINTENANCE_METADATA_KEY]: lease,
  };
}

export function readLoyaltyMaintenanceLease(
  metadata: Prisma.JsonValue | null | undefined,
): LoyaltyMaintenanceLease | null {
  if (metadata === null || metadata === undefined) return null;
  if (!isPlainObject(metadata)) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }
  if (
    !Object.prototype.hasOwnProperty.call(
      metadata,
      LOYALTY_MAINTENANCE_METADATA_KEY,
    )
  ) {
    return null;
  }
  return parseLease(metadata[LOYALTY_MAINTENANCE_METADATA_KEY]);
}

export function assertLoyaltyMaintenanceBaselineMetadata({
  baselineMetadata,
  leaseMetadata,
}: {
  baselineMetadata: Prisma.JsonValue | null | undefined;
  leaseMetadata: Prisma.JsonValue | null | undefined;
}) {
  const lease = readLoyaltyMaintenanceLease(leaseMetadata);
  if (
    !lease ||
    !safeDigestEquals(
      lease.baselineMetadataSha256,
      canonicalMetadataSha256(baselineMetadata ?? null),
    )
  ) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }
}

export function readLoyaltyMaintenanceFixtureCustomerOwnership({
  metadata,
  email,
  tags,
}: {
  metadata: Prisma.JsonValue | null | undefined;
  email: string;
  tags: string | readonly string[];
}): { owned: boolean; partialMatch: boolean; runMarkerTag?: string } {
  const lease = readLoyaltyMaintenanceLease(metadata);
  if (!lease) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }
  const normalized = normalizedTags(tags);
  let emailDigest: string | null = null;
  try {
    emailDigest = sha256(normalizedEmail(email));
  } catch {
    // Shopify may redact protected customer data. A redacted candidate can
    // never be adopted, but tag matches still make it a partial ownership
    // collision that recovery must fail closed on.
  }
  const emailMatches = Boolean(
    emailDigest &&
      lease.fixtureEmailSha256.some((digest) =>
        safeDigestEquals(digest, emailDigest!),
      ),
  );
  const disposableTagMatches = normalized.some((tag) =>
    safeDigestEquals(lease.fixtureDisposableTagSha256, sha256(tag)),
  );
  const runMarkerTags = normalized.filter((tag) =>
    safeDigestEquals(lease.fixtureRunMarkerTagSha256, sha256(tag)),
  );
  const runMarkerMatches = runMarkerTags.length === 1;
  const owned = emailMatches && disposableTagMatches && runMarkerMatches;
  return Object.freeze({
    owned,
    // The disposable tag is intentionally shared by every A1 run, so it is
    // only a search partition. An email or run-marker collision is the
    // ownership ambiguity that must stop recovery.
    partialMatch: !owned && (emailMatches || runMarkerTags.length > 0),
    ...(owned ? { runMarkerTag: runMarkerTags[0] } : {}),
  });
}

export function createExpiredLoyaltyMaintenanceLeaseTakeoverMetadata({
  existingMetadata,
  newOwnerToken,
  now,
  recoveryAfter,
}: {
  existingMetadata: Prisma.JsonValue | null | undefined;
  newOwnerToken: string;
  now: Date;
  recoveryAfter: Date;
}): Prisma.InputJsonObject {
  const metadata = metadataObject(existingMetadata);
  const lease = readLoyaltyMaintenanceLease(
    metadata as unknown as Prisma.JsonValue,
  );
  const nowIso = exactIsoTimestamp(now);
  const recoveryAfterIso = exactIsoTimestamp(recoveryAfter);
  if (!lease || Date.parse(nowIso) < Date.parse(lease.recoveryAfter)) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "active_lease" });
  }
  if (recoveryAfter.getTime() <= now.getTime()) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_metadata" });
  }
  const nextOwnerTokenSha256 = sha256(normalizedOwnerToken(newOwnerToken));
  if (safeDigestEquals(lease.ownerTokenSha256, nextOwnerTokenSha256)) {
    throw new LoyaltyMaintenanceBlockedError({ reason: "invalid_permit" });
  }

  return {
    ...(metadata as Prisma.InputJsonObject),
    [LOYALTY_MAINTENANCE_METADATA_KEY]: {
      ...lease,
      ownerTokenSha256: nextOwnerTokenSha256,
      recoveryAfter: recoveryAfterIso,
    },
  };
}

type LoyaltyMaintenanceTakeoverProgramRow = {
  id: string;
  storeId: string;
  updatedAt: Date;
  metadata: Prisma.JsonValue | null;
};

/**
 * Takes over one expired abandoned lease under the canonical store -> program
 * row-lock order. The caller must retain the returned owner token privately;
 * only its digest is persisted. `expectedMetadata` and `expectedUpdatedAt`
 * bind the mutation to the exact preflight generation instead of adopting a
 * row that changed while remote ownership proofs were being collected.
 */
export async function takeOverExpiredLoyaltyMaintenanceLeaseWithCas({
  tx,
  storeId,
  programId,
  expectedUpdatedAt,
  expectedMetadata,
  newOwnerToken,
  now,
  recoveryAfter,
}: {
  tx: Prisma.TransactionClient;
  storeId: string;
  programId: string;
  expectedUpdatedAt: Date;
  expectedMetadata: Prisma.JsonValue | null;
  newOwnerToken: string;
  now: Date;
  recoveryAfter: Date;
}) {
  const exactStoreId = assertStoreId(storeId);
  const exactProgramId = assertExactIdentifier(programId, exactStoreId);
  const expectedUpdatedAtIso = exactIsoTimestamp(expectedUpdatedAt);
  const queryRaw = (tx as { $queryRaw?: Prisma.TransactionClient["$queryRaw"] })
    .$queryRaw;
  if (!queryRaw) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_metadata",
      storeId: exactStoreId,
    });
  }

  const stores = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM WeleticShopifyStore
    WHERE id = ${exactStoreId}
    LIMIT 1
    FOR UPDATE
  `);
  if (stores.length !== 1 || stores[0].id !== exactStoreId) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_metadata",
      storeId: exactStoreId,
    });
  }
  const programs = await tx.$queryRaw<LoyaltyMaintenanceTakeoverProgramRow[]>(
    Prisma.sql`
      SELECT id, storeId, updatedAt, metadata
      FROM WeleticLoyaltyProgram
      WHERE id = ${exactProgramId} AND storeId = ${exactStoreId}
      LIMIT 1
      FOR UPDATE
    `,
  );
  const current = programs[0];
  if (
    programs.length !== 1 ||
    !current ||
    current.id !== exactProgramId ||
    current.storeId !== exactStoreId ||
    exactIsoTimestamp(current.updatedAt) !== expectedUpdatedAtIso ||
    !safeDigestEquals(
      canonicalMetadataSha256(current.metadata),
      canonicalMetadataSha256(expectedMetadata),
    )
  ) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_metadata",
      storeId: exactStoreId,
    });
  }

  const metadata = createExpiredLoyaltyMaintenanceLeaseTakeoverMetadata({
    existingMetadata: current.metadata,
    newOwnerToken,
    now,
    recoveryAfter,
  });
  const updated = await tx.weleticLoyaltyProgram.updateMany({
    where: {
      id: exactProgramId,
      storeId: exactStoreId,
      updatedAt: current.updatedAt,
    },
    data: { metadata },
  });
  if (updated.count !== 1) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_metadata",
      storeId: exactStoreId,
    });
  }

  return Object.freeze({
    metadata,
    permit: createLoyaltyMaintenanceOwnerPermit({
      storeId: exactStoreId,
      metadata: metadata as unknown as Prisma.JsonValue,
      ownerToken: newOwnerToken,
    }),
  });
}

export function createLoyaltyMaintenanceOwnerPermit({
  storeId,
  metadata,
  ownerToken,
}: {
  storeId: string;
  metadata: Prisma.JsonValue | null | undefined;
  ownerToken: string;
}): LoyaltyMaintenancePermit {
  const lease = readLoyaltyMaintenanceLease(metadata);
  const presentedDigest = sha256(normalizedOwnerToken(ownerToken));
  if (!lease || !safeDigestEquals(lease.ownerTokenSha256, presentedDigest)) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_permit",
      storeId,
    });
  }
  return createPermit({ authorization: "owner_token", lease, storeId });
}

export function createAuthenticatedFixtureCustomerCreateMaintenancePermit({
  storeId,
  metadata,
  topic,
  webhookAuthenticated,
  email,
  tags,
}: {
  storeId: string;
  metadata: Prisma.JsonValue | null | undefined;
  topic: string;
  webhookAuthenticated: boolean;
  email: string;
  tags: string | readonly string[];
}): LoyaltyMaintenancePermit {
  const lease = readAuthenticatedFixtureCustomerCreateMaintenanceIdentity({
    storeId,
    metadata,
    topic,
    webhookAuthenticated,
    email,
  });
  const tagDigests = normalizedTags(tags).map((tag) => sha256(tag));
  if (
    !tagDigests.some((digest) =>
      safeDigestEquals(lease.fixtureDisposableTagSha256, digest),
    ) ||
    !tagDigests.some((digest) =>
      safeDigestEquals(lease.fixtureRunMarkerTagSha256, digest),
    )
  ) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_permit",
      storeId,
    });
  }
  return createPermit({
    authorization: "fixture_customer_create",
    lease,
    storeId,
  });
}

function readAuthenticatedFixtureCustomerCreateMaintenanceIdentity({
  storeId,
  metadata,
  topic,
  webhookAuthenticated,
  email,
}: {
  storeId: string;
  metadata: Prisma.JsonValue | null | undefined;
  topic: string;
  webhookAuthenticated: boolean;
  email: string;
}): LoyaltyMaintenanceLease {
  const lease = readLoyaltyMaintenanceLease(metadata);
  const emailDigest = sha256(normalizedEmail(email));
  if (
    !lease ||
    !webhookAuthenticated ||
    topic !== "customers/create" ||
    !lease.fixtureEmailSha256.some((digest) =>
      safeDigestEquals(digest, emailDigest),
    )
  ) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_permit",
      storeId,
    });
  }
  return lease;
}

export function assertAuthenticatedFixtureCustomerCreateMaintenanceIdentity(
  input: Parameters<
    typeof readAuthenticatedFixtureCustomerCreateMaintenanceIdentity
  >[0],
) {
  void readAuthenticatedFixtureCustomerCreateMaintenanceIdentity(input);
}

export function assertLoyaltyMaintenanceWriteAllowed({
  storeId,
  metadata,
  permit,
}: {
  storeId: string;
  metadata: Prisma.JsonValue | null | undefined;
  permit?: LoyaltyMaintenancePermit | null;
}) {
  const lease = readLoyaltyMaintenanceLease(metadata);
  if (!lease) {
    if (permit) {
      throw new LoyaltyMaintenanceBlockedError({
        reason: "invalid_permit",
        storeId,
      });
    }
    return;
  }
  const validPermit =
    permit?.[LOYALTY_MAINTENANCE_PERMIT_BRAND] === true &&
    permit.storeId === storeId &&
    safeDigestEquals(permit.leaseSha256, leaseSha256(lease));
  if (!validPermit) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: permit ? "invalid_permit" : "active_lease",
      storeId,
    });
  }
}

/**
 * Fixture permits are deliberately limited to the synchronous
 * customers/create projection. Queued maintenance work requires the stronger
 * owner capability, whose private brand prevents a structurally similar object
 * from widening that boundary.
 */
export function assertLoyaltyMaintenanceOwnerPermitAuthorization(
  permit: LoyaltyMaintenancePermit,
) {
  if (
    !permit ||
    permit[LOYALTY_MAINTENANCE_PERMIT_BRAND] !== true ||
    permit.authorization !== "owner_token"
  ) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_permit",
      storeId:
        permit && typeof permit.storeId === "string"
          ? permit.storeId
          : undefined,
    });
  }
}

export function removeLoyaltyMaintenanceLeaseMetadata({
  existingMetadata,
  permit,
}: {
  existingMetadata: Prisma.JsonValue | null | undefined;
  permit: LoyaltyMaintenancePermit;
}): Prisma.InputJsonValue | Prisma.NullTypes.DbNull {
  if (permit.authorization !== "owner_token") {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_permit",
      storeId: permit.storeId,
    });
  }
  const metadata = metadataObject(existingMetadata);
  const lease = readLoyaltyMaintenanceLease(
    metadata as unknown as Prisma.JsonValue,
  );
  if (!lease) {
    throw new LoyaltyMaintenanceBlockedError({
      reason: "invalid_metadata",
      storeId: permit.storeId,
    });
  }
  assertLoyaltyMaintenanceWriteAllowed({
    storeId: permit.storeId,
    metadata: metadata as unknown as Prisma.JsonValue,
    permit,
  });
  const {
    [LOYALTY_MAINTENANCE_METADATA_KEY]: _removedLease,
    ...remainingMetadata
  } = metadata;
  void _removedLease;
  if (
    safeDigestEquals(
      lease.baselineMetadataSha256,
      canonicalMetadataSha256(remainingMetadata),
    )
  ) {
    return remainingMetadata as Prisma.InputJsonObject;
  }
  if (
    Object.keys(remainingMetadata).length === 0 &&
    safeDigestEquals(
      lease.baselineMetadataSha256,
      canonicalMetadataSha256(null),
    )
  ) {
    return Prisma.DbNull;
  }
  throw new LoyaltyMaintenanceBlockedError({
    reason: "invalid_metadata",
    storeId: permit.storeId,
  });
}
