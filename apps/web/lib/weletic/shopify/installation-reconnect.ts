import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { readPendingInstallation } from "./installation-admission";
import { assertFreshInstallationStatusIdentity } from "./installation-admission-contract";
import {
  assertMappedInstallationReconnectReady,
  reopenMappedInstallation,
  type ReconnectStore,
} from "./mapped-installation-reconnect";
import { deriveAllShopifyShopPrivacyIdentities } from "./privacy-identity";
import {
  ensureShopifySessionCoordination,
  observeShopifySessionCoordination,
  revokeShopifySessionCoordination,
} from "./session-coordination";

// This observation travels only across the service-signed merchant gateway,
// never in the browser status projection. A revision is not authorization.
export const installationReconnectObservationSchema = z
  .object({
    expectedRevision: z.number().int().positive().max(2147483645),
    expectedInstallationGeneration: z.string().min(1).max(64).nullable(),
    expectedStoreAccessRevision: z
      .number()
      .int()
      .positive()
      .max(2147483645)
      .optional(),
  })
  .strict();

async function lockReconnectCandidate(
  tx: Prisma.TransactionClient,
  identity: unknown,
  prepare: boolean,
) {
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  const actor = assertFreshInstallationStatusIdentity(
    identity,
    process.env.SHOPIFY_API_KEY?.trim() || "",
    clock.now,
  );
  const stores = await tx.$queryRaw<ReconnectStore[]>(Prisma.sql`
    SELECT id, projectId, shopDomain, installationGeneration, complianceState,
           uninstalledAt, redactedAt, storeAccessState, storeAccessRevision
    FROM WeleticShopifyStore WHERE shopDomain = ${actor.shop} LIMIT 1 FOR UPDATE
  `);
  const store = stores[0];
  const predicates = deriveAllShopifyShopPrivacyIdentities({
    shopDomain: actor.shop,
  }).map(
    ({ identityKeyId, shopDomainDigest }) =>
      Prisma.sql`(identityKeyId = ${identityKeyId} AND shopDomainDigest = ${shopDomainDigest})`,
  );
  const tombstones = predicates.length
    ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyShopPrivacyTombstone
    WHERE expiresAt > CURRENT_TIMESTAMP(3) AND (${Prisma.join(predicates, " OR ")})
    LIMIT 1 FOR UPDATE
  `)
    : [];
  if (tombstones.length)
    throw new Error("A redacted installation cannot reconnect");
  if (prepare) await ensureShopifySessionCoordination(tx, actor);
  else await observeShopifySessionCoordination(tx, actor);
  const pending = await readPendingInstallation(tx, actor);
  if (
    !pending ||
    pending.state !== "uninstalled" ||
    (!store && pending.mappedStoreId !== null) ||
    pending.redactedAt ||
    !pending.uninstalledAt ||
    actor.issuedAt <= Math.floor(pending.uninstalledAt.getTime() / 1000) ||
    pending.revision >= 2147483646
  )
    throw new Error("Installation reconnect is unavailable or stale");
  if (store)
    await assertMappedInstallationReconnectReady(tx, store, pending, actor);
  const [lockedClock] = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  assertFreshInstallationStatusIdentity(identity, actor.appId, lockedClock.now);
  return { actor, pending, store };
}

export async function observePendingInstallationReconnect(
  tx: Prisma.TransactionClient,
  identity: unknown,
) {
  const { pending, store } = await lockReconnectCandidate(tx, identity, false);
  return installationReconnectObservationSchema.parse({
    expectedRevision: pending.revision,
    expectedInstallationGeneration: pending.installationGeneration,
    ...(store
      ? { expectedStoreAccessRevision: store.storeAccessRevision }
      : {}),
  });
}

/** Explicit authenticated intent, not ordinary token refresh. Caller owns an
 * interactive transaction and has verified the service signature on SDK claims.
 * Resetting authentication creates no merchant/customer authority. Provider
 * exchange must still succeed through normal coordinated offline publication.
 */
export async function preparePendingInstallationReconnect(
  tx: Prisma.TransactionClient,
  identity: unknown,
  observation: unknown,
) {
  const expected = installationReconnectObservationSchema.parse(observation);
  const { actor, pending, store } = await lockReconnectCandidate(
    tx,
    identity,
    true,
  );
  if (
    pending.revision !== expected.expectedRevision ||
    pending.installationGeneration !==
      expected.expectedInstallationGeneration ||
    expected.expectedStoreAccessRevision !== store?.storeAccessRevision
  )
    throw new Error("Installation reconnect observation changed");
  await revokeShopifySessionCoordination(tx, actor);
  await tx.weleticShopifyAppSession.deleteMany({ where: { shop: actor.shop } });
  const generation = randomUUID();
  if (store)
    await reopenMappedInstallation(tx, store, pending, actor, generation);
  await tx.weleticShopifyPendingInstallation.update({
    where: { id: pending.id },
    data: {
      state: store ? "mapped" : "pending_approval",
      installationGeneration: generation,
      // Verified authentication-start time is strictly after the uninstall and
      // remains bound to this intent's fresh JWT, including after provider delay.
      authenticatedAt: new Date(actor.issuedAt * 1000),
      uninstalledAt: null,
      expiresAt: null,
      revision: pending.revision + 1,
    },
  });
  return { status: "pending_approval" as const };
}
