import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import {
  addRetentionDays,
  getShopifyFinancialRetentionDays,
} from "./compliance-config";
import type { ShopifyDurableComplianceTopic } from "./compliance-types";
import { readPendingInstallation } from "./installation-admission";
import { deriveAllShopifyShopPrivacyIdentities } from "./privacy-identity";
import {
  ensureShopifySessionCoordination,
  revokeShopifySessionCoordination,
  type ShopifySessionScope,
} from "./session-coordination";

/** Call only after the real webhook HMAC, payload schema and exact header/body
 * tenant match have been verified. No customer payload or recipient is stored.
 * Returning mapped tells ingress to retry through the mapped-store lifecycle.
 */
export async function handlePendingInstallationPrivacy(
  tx: Prisma.TransactionClient,
  scope: ShopifySessionScope,
  topic: ShopifyDurableComplianceTopic,
  triggeredAt: Date | null,
) {
  const stores = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM WeleticShopifyStore WHERE shopDomain = ${scope.shop}
    LIMIT 1 FOR UPDATE
  `);
  if (stores.length) return { disposition: "mapped" as const };
  const customerTopic =
    topic === "customers/data_request" || topic === "customers/redact";
  // Customer-only privacy handling cannot create or revoke authentication.
  // The store gap lock keeps its empty-data result independent of auth races.
  if (!customerTopic) await ensureShopifySessionCoordination(tx, scope);
  const pending = await readPendingInstallation(tx, scope);
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  const now = clock.now;
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid privacy clock");
  if (pending?.state === "mapped" || pending?.mappedStoreId)
    throw new Error("Ambiguous pending installation mapping");
  if (customerTopic) {
    // This branch owns no store/customer/account rows. The store gap lock
    // prevents a mapper creating customer authority during the empty result.
    return { disposition: "no_customer_data" as const };
  }
  if (pending?.state === "redacted") {
    // ensure above may have recreated an erased coordinator just to serialize
    // this request. A replay must not commit that raw-domain identity again.
    await tx.weleticShopifySessionCoordination.deleteMany({
      where: {
        appId: scope.appId,
        shop: scope.shop,
      },
    });
    return { disposition: "already_redacted" as const };
  }
  if (topic === "app/uninstalled") {
    if (
      !triggeredAt ||
      !Number.isFinite(triggeredAt.getTime()) ||
      triggeredAt > now
    )
      throw new Error("Invalid pending uninstall cutoff");
    if (pending?.authenticatedAt && pending.authenticatedAt > triggeredAt)
      return { disposition: "stale_generation" as const };
    if (
      pending?.state === "uninstalled" &&
      pending.uninstalledAt &&
      pending.uninstalledAt >= triggeredAt
    )
      return { disposition: "already_uninstalled" as const };
  }
  if (pending?.revision && pending.revision >= 2147483646)
    throw new Error("Pending installation revision exhausted");
  await revokeShopifySessionCoordination(tx, scope);
  await tx.weleticShopifyAppSession.deleteMany({ where: { shop: scope.shop } });
  const redacting = topic === "shop/redact";
  if (redacting) {
    // The retained keyed admission tombstone now owns replay suppression. As
    // with mapped-shop erasure, remove raw-domain coordinator state as well as
    // SDK sessions; no personal shop identity belongs in an expired lease row.
    await tx.weleticShopifySessionCoordination.deleteMany({
      where: {
        appId: scope.appId,
        shop: scope.shop,
      },
    });
  }
  const data = redacting
    ? {
        state: "redacted" as const,
        installationGeneration: null,
        authenticatedAt: null,
        mappedStoreId: null,
        uninstalledAt: null,
        redactedAt: now,
        expiresAt: addRetentionDays(now, getShopifyFinancialRetentionDays()),
      }
    : {
        state: "uninstalled" as const,
        uninstalledAt: triggeredAt,
      };
  if (pending) {
    if (redacting)
      await tx.weleticShopifyPendingInstallationChange.deleteMany({
        where: { pendingInstallationId: pending.id },
      });
    await tx.weleticShopifyPendingInstallation.update({
      where: { id: pending.id },
      data: { ...data, revision: pending.revision + 1 },
    });
  } else {
    await tx.weleticShopifyPendingInstallation.create({
      data: {
        id: randomUUID(),
        appId: scope.appId,
        ...deriveAllShopifyShopPrivacyIdentities({ shopDomain: scope.shop })[0],
        ...data,
      },
    });
  }
  return {
    disposition: redacting ? ("redacted" as const) : ("uninstalled" as const),
  };
}
