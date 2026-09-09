import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { Prisma, type WeleticShopifyPendingInstallation } from "@prisma/client";
import { randomUUID } from "node:crypto";
import type { z } from "zod/v4";
import type { installationStatusIdentitySchema } from "./installation-admission-contract";

export type ReconnectStore = {
  id: string;
  projectId: string;
  shopDomain: string;
  installationGeneration: string | null;
  complianceState: string;
  uninstalledAt: Date | null;
  redactedAt: Date | null;
  storeAccessState: "active" | "pending_approval" | "suspended";
  storeAccessRevision: number;
};
type Actor = z.infer<typeof installationStatusIdentitySchema>;

/** Caller holds Store -> tombstone -> coordinator -> admission locks. A
 * retained company mapping may reopen only after the exact uninstall cutoff
 * completed and all old credentials/vouchers were drained. No User is selected.
 */
export async function assertMappedInstallationReconnectReady(
  tx: Prisma.TransactionClient,
  store: ReconnectStore,
  pending: WeleticShopifyPendingInstallation,
  actor: Actor,
) {
  if (
    store.shopDomain !== actor.shop ||
    !store.projectId ||
    store.complianceState !== "frozen" ||
    store.redactedAt ||
    !store.uninstalledAt ||
    !store.installationGeneration ||
    pending.mappedStoreId !== store.id ||
    pending.installationGeneration !== store.installationGeneration ||
    !pending.authenticatedAt ||
    pending.authenticatedAt > store.uninstalledAt ||
    pending.uninstalledAt?.getTime() !== store.uninstalledAt.getTime() ||
    !["active", "pending_approval", "suspended"].includes(
      store.storeAccessState,
    ) ||
    !Number.isInteger(store.storeAccessRevision) ||
    store.storeAccessRevision < 1 ||
    store.storeAccessRevision >= 2147483646
  )
    throw new Error("Mapped installation lifecycle is unavailable or stale");
  const workspace = await tx.project.findUnique({
    where: { id: store.projectId },
    select: { id: true },
  });
  if (!workspace)
    throw new Error("Mapped installation workspace is unavailable");
  const blocking = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyComplianceRequest
    WHERE storeId = ${store.id} AND requestType IN ('app_uninstalled', 'shop_redact')
      AND status <> 'completed' LIMIT 1 FOR UPDATE
  `);
  const completed = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyComplianceRequest
    WHERE storeId = ${store.id} AND shopDomain = ${actor.shop}
      AND requestType = 'app_uninstalled' AND status = 'completed' AND phase = 'completed'
      AND COALESCE(triggeredAt, receivedAt) = ${store.uninstalledAt}
      AND receivedAt >= ${pending.authenticatedAt} AND completedAt >= receivedAt
      AND completedAt <= CURRENT_TIMESTAMP(3)
    LIMIT 1 FOR UPDATE
  `);
  const cleanups = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyVoucherCleanup
    WHERE storeId = ${store.id} AND status <> 'completed' LIMIT 1 FOR UPDATE
  `);
  if (blocking.length || !completed.length || cleanups.length)
    throw new Error("Mapped installation cleanup is incomplete");
  const native = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyInstallationCredential
    WHERE storeId = ${store.id} AND appId = ${actor.appId} LIMIT 1 FOR UPDATE
  `);
  const legacy = await tx.installedIntegration.count({
    where: {
      projectId: store.projectId,
      integrationId: SHOPIFY_INTEGRATION_ID,
    },
  });
  if (native.length || legacy)
    throw new Error("Mapped installation credential cleanup is incomplete");
  const programs = await tx.$queryRaw<
    Array<{ status: string; killSwitchActive: number | boolean | bigint }>
  >(Prisma.sql`
    SELECT status, killSwitchActive FROM WeleticLoyaltyProgram
    WHERE storeId = ${store.id} LIMIT 1 FOR UPDATE
  `);
  if (
    programs.some(
      (program) =>
        program.status !== "disabled" || !Boolean(program.killSwitchActive),
    )
  )
    throw new Error("Mapped installation loyalty must remain disabled");
}

/** Preparation creates no token or merchant grant. Publication must still use
 * the SDK lease protocol, and operator activation requires that fresh token.
 */
export async function reopenMappedInstallation(
  tx: Prisma.TransactionClient,
  store: ReconnectStore,
  pending: WeleticShopifyPendingInstallation,
  actor: Actor,
  generation: string,
) {
  const changed = await tx.$executeRaw(Prisma.sql`
    UPDATE WeleticShopifyStore
    SET installationGeneration = ${generation}, complianceState = 'active', uninstalledAt = NULL,
        storeAccessState = 'pending_approval', storeAccessRevision = ${store.storeAccessRevision + 1},
        syncStatus = 'pending', lastSyncError = NULL, updatedAt = CURRENT_TIMESTAMP(3)
    WHERE id = ${store.id} AND projectId = ${store.projectId} AND shopDomain = ${actor.shop}
      AND installationGeneration = ${store.installationGeneration} AND complianceState = 'frozen'
      AND storeAccessRevision = ${store.storeAccessRevision} AND uninstalledAt = ${store.uninstalledAt}
      AND redactedAt IS NULL
  `);
  if (changed !== 1)
    throw new Error("Mapped reconnect lost its Store revision fence");
  await tx.weleticShopifyStaffGrant.deleteMany({
    where: { storeId: store.id, appId: actor.appId },
  });
  await tx.weleticShopifyStoreAccessChange.create({
    data: {
      id: randomUUID(),
      storeId: store.id,
      installationGeneration: generation,
      previousState: store.storeAccessState,
      nextState: "pending_approval",
      revision: store.storeAccessRevision + 1,
      operator: "shopify-reconnect",
      reason:
        "Fresh Shopify reconnect intent; authentication and company approval are required again.",
    },
  });
  await tx.weleticShopifyPendingInstallationChange.create({
    data: {
      id: randomUUID(),
      pendingInstallationId: pending.id,
      mappedStoreId: store.id,
      installationGeneration: generation,
      revision: pending.revision + 1,
      operation: "reconnect",
      operator: `shopify:${actor.userId}`,
      reason:
        "Verified Shopify reconnect intent preserves the existing company mapping without reusing credentials or staff grants.",
    },
  });
}
