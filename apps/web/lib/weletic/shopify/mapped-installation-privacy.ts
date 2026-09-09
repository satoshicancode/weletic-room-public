import { Prisma, type WeleticShopifyPendingInstallation } from "@prisma/client";
import { readPendingInstallation } from "./installation-admission";
import { deriveAllShopifyShopPrivacyIdentities } from "./privacy-identity";

type MappedLifecycle = {
  storeId: string;
  shop: string;
  installationGeneration: string | null;
};

/** Caller owns the exact mapped Store row and has validated its lifecycle.
 * Store -> admission -> dependent rows is shared with mapping and approval.
 * No admission record means a legacy company installation, not implicit creation.
 */
async function lockMappedAdmission(
  tx: Prisma.TransactionClient,
  scope: MappedLifecycle,
) {
  const [linked] = await tx.$queryRaw<
    WeleticShopifyPendingInstallation[]
  >(Prisma.sql`
    SELECT * FROM WeleticShopifyPendingInstallation
    WHERE mappedStoreId = ${scope.storeId} LIMIT 1 FOR UPDATE
  `);
  // Provisioning intentionally precedes mapping. The Store may already route
  // privacy here while its same-shop admission still has no mappedStoreId.
  const row =
    linked ??
    (await readPendingInstallation(tx, {
      appId: process.env.SHOPIFY_API_KEY?.trim() || "",
      shop: scope.shop,
    }));
  if (!row) return null;
  const identities = deriveAllShopifyShopPrivacyIdentities({
    shopDomain: scope.shop,
  });
  if (
    row.appId !== process.env.SHOPIFY_API_KEY?.trim() ||
    (linked
      ? row.mappedStoreId !== scope.storeId
      : row.mappedStoreId !== null) ||
    !scope.installationGeneration ||
    row.installationGeneration !== scope.installationGeneration ||
    !(
      linked ? ["mapped", "uninstalled"] : ["pending_approval", "uninstalled"]
    ).includes(row.state) ||
    !row.authenticatedAt ||
    row.redactedAt ||
    !identities.some(
      (identity) =>
        identity.identityKeyId === row.identityKeyId &&
        identity.shopDomainDigest === row.shopDomainDigest,
    )
  )
    throw new Error("Mapped installation privacy identity changed");
  return row;
}

export async function freezeMappedInstallationAdmission(
  tx: Prisma.TransactionClient,
  scope: MappedLifecycle & { cutoff: Date },
) {
  if (!Number.isFinite(scope.cutoff.getTime()))
    throw new Error("Invalid uninstall cutoff");
  const row = await lockMappedAdmission(tx, scope);
  if (!row) return "legacy" as const;
  if (row.authenticatedAt! > scope.cutoff) return "stale_generation" as const;
  const cutoff =
    row.uninstalledAt && row.uninstalledAt < scope.cutoff
      ? row.uninstalledAt
      : scope.cutoff;
  if (
    row.state === "uninstalled" &&
    row.uninstalledAt?.getTime() === cutoff.getTime()
  )
    return "unchanged" as const;
  if (row.revision >= 2147483646)
    throw new Error("Admission revision exhausted");
  await tx.weleticShopifyPendingInstallation.update({
    where: { id: row.id },
    data: {
      state: "uninstalled",
      uninstalledAt: cutoff,
      revision: row.revision + 1,
    },
  });
  // Keep mapping and credentials available to the existing voucher cleanup;
  // the Store's frozen lifecycle rejects ordinary session/loyalty publication.
  return "frozen" as const;
}

export async function redactMappedInstallationAdmission(
  tx: Prisma.TransactionClient,
  scope: MappedLifecycle & { redactedAt: Date; expiresAt: Date },
) {
  if (
    !Number.isFinite(scope.redactedAt.getTime()) ||
    !Number.isFinite(scope.expiresAt.getTime()) ||
    scope.expiresAt < scope.redactedAt
  )
    throw new Error("Invalid admission erasure retention");
  const row = await lockMappedAdmission(tx, scope);
  if (!row) return;
  if (row.revision >= 2147483646)
    throw new Error("Admission revision exhausted");
  await tx.weleticShopifyPendingInstallationChange.deleteMany({
    where: { pendingInstallationId: row.id },
  });
  await tx.weleticShopifyPendingInstallation.update({
    where: { id: row.id },
    data: {
      state: "redacted",
      mappedStoreId: null,
      installationGeneration: null,
      authenticatedAt: null,
      uninstalledAt: null,
      redactedAt: scope.redactedAt,
      expiresAt: scope.expiresAt,
      revision: row.revision + 1,
    },
  });
}
