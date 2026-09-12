import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";

export const SHOPIFY_SESSION_LEASE_MS = 60_000;

export type ShopifySessionScope = { appId: string; shop: string };
export type ShopifySessionObservation = { epoch: string; revision: string };
export type ShopifySessionLease = ShopifySessionScope & {
  token: string;
  epoch: string;
  revision: string;
};

export class ShopifySessionCoordinationError extends Error {
  constructor(readonly code: "invalid_scope" | "lease_busy" | "stale_session") {
    // Fixed messages: never attach SDK sessions, tokens, SQL, or provider errors.
    super(`Shopify session coordination: ${code}`);
    this.name = "ShopifySessionCoordinationError";
  }
}

export function shopifySessionCoordinationId({
  appId,
  shop,
}: ShopifySessionScope) {
  if (
    !/^[a-z0-9_-]{1,191}$/.test(appId) ||
    shop.length > 255 ||
    !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)
  ) {
    throw new ShopifySessionCoordinationError("invalid_scope");
  }
  return createHash("sha256").update(`${appId}\n${shop}`).digest("hex");
}

function tokenDigest(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) {
    throw new ShopifySessionCoordinationError("invalid_scope");
  }
  return createHash("sha256").update(token).digest("hex");
}

function counter(value: string) {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(value)) {
    throw new ShopifySessionCoordinationError("invalid_scope");
  }
  const result = BigInt(value);
  if (result > BigInt("9223372036854775806")) {
    throw new ShopifySessionCoordinationError("invalid_scope");
  }
  return result;
}

type CoordinationRow = {
  revision: bigint;
  leaseEpoch: bigint;
  leaseOwnerHash: string | null;
  live: bigint | number;
};

export async function observeShopifySessionCoordination(
  tx: Prisma.TransactionClient,
  scope: ShopifySessionScope,
): Promise<ShopifySessionObservation> {
  const rows = await tx.$queryRaw<
    Array<{ revision: bigint; leaseEpoch: bigint }>
  >(Prisma.sql`
    SELECT revision, leaseEpoch FROM WeleticShopifySessionCoordination
    WHERE id = ${shopifySessionCoordinationId(scope)} FOR UPDATE
  `);
  return {
    epoch: String(rows[0]?.leaseEpoch ?? BigInt(0)),
    revision: String(rows[0]?.revision ?? BigInt(0)),
  };
}

export async function ensureShopifySessionCoordination(
  tx: Prisma.TransactionClient,
  scope: ShopifySessionScope,
) {
  const id = shopifySessionCoordinationId(scope);
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO WeleticShopifySessionCoordination
      (id, appId, shop, revision, leaseEpoch, createdAt, updatedAt)
    VALUES (${id}, ${scope.appId}, ${scope.shop}, 0, 0,
      CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
    ON DUPLICATE KEY UPDATE id = id
  `);
}

/** Required privacy/auth lifecycle mutation only, in the same transaction as
 * credential deletion. Revokes active and delayed leases without deleting the
 * durable coordinator (which would allow old epoch/revision proofs to recur).
 */
export async function revokeShopifySessionCoordination(
  tx: Prisma.TransactionClient,
  scope: ShopifySessionScope,
) {
  await ensureShopifySessionCoordination(tx, scope);
  const changed = await tx.$executeRaw(Prisma.sql`
    UPDATE WeleticShopifySessionCoordination
    SET revision = revision + 1, leaseEpoch = leaseEpoch + 1,
        leaseOwnerHash = NULL, leaseExpiresAt = NULL, updatedAt = CURRENT_TIMESTAMP(3)
    WHERE id = ${shopifySessionCoordinationId(scope)}
      AND revision < 9223372036854775806 AND leaseEpoch < 9223372036854775806
  `);
  if (changed !== 1) throw new ShopifySessionCoordinationError("stale_session");
}

/** Transition window: a legacy writer can never bypass a promoted coordinator. */
export async function advanceLegacyShopifySessionRevision(
  tx: Prisma.TransactionClient,
  scope: ShopifySessionScope,
) {
  // Anchor even an unpromoted store so first acquisition and legacy publication
  // serialize on the same durable row, including before a merchant binding.
  await ensureShopifySessionCoordination(tx, scope);
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE WeleticShopifySessionCoordination
    SET revision = revision + 1, updatedAt = CURRENT_TIMESTAMP(3)
    WHERE id = ${shopifySessionCoordinationId(scope)}
      AND leaseEpoch = 0 AND revision < 9223372036854775806
  `);
  if (updated !== 1) throw new ShopifySessionCoordinationError("stale_session");
}

/** Call inside a short transaction, after any store/lifecycle row locks. */
export async function acquireShopifySessionLease(
  tx: Prisma.TransactionClient,
  scope: ShopifySessionScope,
  token: string,
  observed: ShopifySessionObservation,
): Promise<ShopifySessionLease> {
  const id = shopifySessionCoordinationId(scope);
  const owner = tokenDigest(token);
  const epoch = counter(observed.epoch);
  const revision = counter(observed.revision);
  // An upsert locks the one durable row, including concurrent first creation.
  // No SDK payload or merchant binding is fabricated to reserve ownership.
  await ensureShopifySessionCoordination(tx, scope);
  // Database time is authoritative. A released/expired token cannot reacquire
  // itself; a new owner gets a new epoch, fencing delayed renew/release requests.
  await tx.$executeRaw(Prisma.sql`
    UPDATE WeleticShopifySessionCoordination
    SET leaseOwnerHash = ${owner}, leaseEpoch = leaseEpoch + 1,
      leaseExpiresAt = TIMESTAMPADD(MICROSECOND, ${SHOPIFY_SESSION_LEASE_MS * 1000}, CURRENT_TIMESTAMP(3)),
      updatedAt = CURRENT_TIMESTAMP(3)
    WHERE id = ${id}
      AND (leaseExpiresAt IS NULL OR leaseExpiresAt <= CURRENT_TIMESTAMP(3))
      AND (leaseOwnerHash IS NULL OR leaseOwnerHash <> ${owner})
      AND leaseEpoch = ${epoch} AND revision = ${revision}
      AND leaseEpoch < 9223372036854775806
  `);
  const rows = await tx.$queryRaw<CoordinationRow[]>(Prisma.sql`
    SELECT revision, leaseEpoch, leaseOwnerHash,
      (leaseExpiresAt > CURRENT_TIMESTAMP(3)) AS live
    FROM WeleticShopifySessionCoordination WHERE id = ${id} FOR UPDATE
  `);
  const row = rows[0];
  if (!row || !row.live || row.leaseOwnerHash !== owner) {
    throw new ShopifySessionCoordinationError("lease_busy");
  }
  // A replay may return the same untouched acquisition, never a fresh epoch or
  // a revision published since that original observation (including A/B/A).
  if (row.leaseEpoch !== epoch + BigInt(1) || row.revision !== revision) {
    throw new ShopifySessionCoordinationError("stale_session");
  }
  return {
    ...scope,
    token,
    epoch: String(row.leaseEpoch),
    revision: String(row.revision),
  };
}

/** Never revive an expired lease, including when the old token still matches. */
export async function renewShopifySessionLease(
  tx: Prisma.TransactionClient,
  lease: ShopifySessionLease,
) {
  await lockShopifySessionCoordination(tx, lease);
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE WeleticShopifySessionCoordination
    SET leaseExpiresAt = TIMESTAMPADD(MICROSECOND, ${SHOPIFY_SESSION_LEASE_MS * 1000}, CURRENT_TIMESTAMP(3)),
      updatedAt = CURRENT_TIMESTAMP(3)
    WHERE id = ${shopifySessionCoordinationId(lease)}
      AND leaseOwnerHash = ${tokenDigest(lease.token)}
      AND leaseEpoch = ${counter(lease.epoch)}
      AND leaseExpiresAt > CURRENT_TIMESTAMP(3)
  `);
  if (updated !== 1) {
    throw new ShopifySessionCoordinationError("stale_session");
  }
}

export async function releaseShopifySessionLease(
  tx: Prisma.TransactionClient,
  lease: ShopifySessionLease,
) {
  // Keep the last token digest, so replaying the acquisition after release does
  // not reopen that ownership epoch. Release cannot affect a subsequent owner.
  return (
    (await tx.$executeRaw(Prisma.sql`
      UPDATE WeleticShopifySessionCoordination
      SET leaseExpiresAt = NULL, updatedAt = CURRENT_TIMESTAMP(3)
      WHERE id = ${shopifySessionCoordinationId(lease)}
        AND leaseOwnerHash = ${tokenDigest(lease.token)}
        AND leaseEpoch = ${counter(lease.epoch)}
    `)) === 1
  );
}

/** Same transaction as the SDK payload and credential projection mutation. */
export async function advanceShopifySessionRevision(
  tx: Prisma.TransactionClient,
  lease: ShopifySessionLease,
): Promise<ShopifySessionLease> {
  const revision = counter(lease.revision);
  await lockShopifySessionCoordination(tx, lease);
  const updated = await tx.$executeRaw(Prisma.sql`
    UPDATE WeleticShopifySessionCoordination
    SET revision = revision + 1, updatedAt = CURRENT_TIMESTAMP(3)
    WHERE id = ${shopifySessionCoordinationId(lease)}
      AND leaseOwnerHash = ${tokenDigest(lease.token)}
      AND leaseEpoch = ${counter(lease.epoch)}
      AND revision = ${revision}
      AND leaseExpiresAt > CURRENT_TIMESTAMP(3)
  `);
  if (updated !== 1) {
    throw new ShopifySessionCoordinationError("stale_session");
  }
  return { ...lease, revision: String(revision + BigInt(1)) };
}

async function lockShopifySessionCoordination(
  tx: Prisma.TransactionClient,
  scope: ShopifySessionScope,
) {
  // CURRENT_TIMESTAMP is fixed at statement start in MySQL. Wait for the row
  // lock here; the following conditional UPDATE then evaluates a fresh time.
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM WeleticShopifySessionCoordination
    WHERE id = ${shopifySessionCoordinationId(scope)} FOR UPDATE
  `);
}
