import { Prisma, type WeleticShopifyPendingInstallation } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  assertFreshInstallationStatusIdentity,
  type InstallationAdmissionStatus,
} from "./installation-admission-contract";
import { deriveAllShopifyShopPrivacyIdentities } from "./privacy-identity";
import {
  shopifySessionCoordinationId,
  type ShopifySessionScope,
} from "./session-coordination";

/** Caller owns the same shop lifecycle/coordination locks used by session
 * publication. HMAC lookup covers retained key versions and fails on ambiguity.
 * No raw shop domain or merchant/user identity is written to this record.
 */
export async function readPendingInstallation(
  tx: Prisma.TransactionClient,
  scope: ShopifySessionScope,
): Promise<WeleticShopifyPendingInstallation | null> {
  shopifySessionCoordinationId(scope);
  const identities = deriveAllShopifyShopPrivacyIdentities({
    shopDomain: scope.shop,
  });
  const predicates = identities.map(
    ({ identityKeyId, shopDomainDigest }) =>
      Prisma.sql`(identityKeyId = ${identityKeyId} AND shopDomainDigest = ${shopDomainDigest})`,
  );
  const rows = await tx.$queryRaw<
    WeleticShopifyPendingInstallation[]
  >(Prisma.sql`
    SELECT * FROM WeleticShopifyPendingInstallation
    WHERE appId = ${scope.appId} AND (${Prisma.join(predicates, " OR ")})
    LIMIT 2 FOR UPDATE
  `);
  if (rows.length > 1) throw new Error("Ambiguous installation admission");
  return rows[0] ?? null;
}

/** Only call after coordinated offline credential publication has been
 * authorized. This creates admission, never a workspace, store, or program.
 * A refresh must NOT reopen uninstall/redaction or silently inherit a mapping.
 */
export async function ensurePendingInstallationAfterAuthentication(
  tx: Prisma.TransactionClient,
  scope: ShopifySessionScope,
  now: Date,
) {
  if (!Number.isFinite(now.getTime()))
    throw new Error("Invalid admission clock");
  const current = await readPendingInstallation(tx, scope);
  if (current) {
    if (
      current.state !== "pending_approval" ||
      current.mappedStoreId !== null ||
      !current.installationGeneration ||
      current.uninstalledAt !== null ||
      current.redactedAt !== null
    )
      throw new Error("Installation authentication requires lifecycle review");
    return current;
  }
  const identity = deriveAllShopifyShopPrivacyIdentities({
    shopDomain: scope.shop,
  })[0];
  return tx.weleticShopifyPendingInstallation.create({
    data: {
      id: randomUUID(),
      appId: scope.appId,
      ...identity,
      installationGeneration: randomUUID(),
      authenticatedAt: now,
      state: "pending_approval",
      revision: 1,
    },
  });
}

/** Minimal signed status, not a staff authorization primitive. The API must
 * verify the signature over the whole identity payload before calling this.
 */
export async function readInstallationAdmissionStatus(
  tx: Prisma.TransactionClient,
  identity: unknown,
): Promise<InstallationAdmissionStatus> {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  const actor = assertFreshInstallationStatusIdentity(
    identity,
    process.env.SHOPIFY_API_KEY?.trim() || "",
    clock.now,
  );
  const stores = await tx.$queryRaw<
    Array<{
      id: string;
      installationGeneration: string | null;
      complianceState: string;
      storeAccessState: string;
    }>
  >(Prisma.sql`
    SELECT id, installationGeneration, complianceState, storeAccessState
    FROM WeleticShopifyStore WHERE shopDomain = ${actor.shop}
    LIMIT 1 FOR UPDATE
  `);
  const store = stores[0];
  const pending = await readPendingInstallation(tx, actor);
  const [lockedClock] = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  assertFreshInstallationStatusIdentity(identity, actor.appId, lockedClock.now);
  if (pending?.state === "redacted") return { status: "unavailable" };
  if (pending?.state === "uninstalled") return { status: "reauthenticate" };
  if (
    pending &&
    (pending.uninstalledAt !== null ||
      pending.redactedAt !== null ||
      !pending.authenticatedAt ||
      actor.issuedAt < Math.floor(pending.authenticatedAt.getTime() / 1000))
  )
    return { status: "unavailable" };
  if (store) {
    if (store.complianceState !== "active" || !store.installationGeneration)
      return { status: "unavailable" };
    if (
      pending &&
      (pending.state !== "mapped" ||
        pending.mappedStoreId !== store.id ||
        pending.installationGeneration !== store.installationGeneration)
    )
      return { status: "unavailable" };
    if (
      store.storeAccessState === "active" ||
      store.storeAccessState === "suspended" ||
      store.storeAccessState === "pending_approval"
    )
      return { status: store.storeAccessState };
    return { status: "unavailable" };
  }
  if (
    !pending ||
    pending.state !== "pending_approval" ||
    pending.mappedStoreId !== null ||
    !pending.installationGeneration ||
    !pending.authenticatedAt ||
    actor.issuedAt < Math.floor(pending.authenticatedAt.getTime() / 1000)
  )
    return { status: "unavailable" };
  return { status: "pending_approval" };
}
