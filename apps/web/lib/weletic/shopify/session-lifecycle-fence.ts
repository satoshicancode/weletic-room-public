import { Prisma } from "@prisma/client";
import { deriveAllShopifyShopPrivacyIdentities } from "./privacy-identity";

export class SessionCredentialWriteBlockedError extends Error {}

export type LockedShopifySessionStore = {
  id: string;
  projectId: string;
  shopDomain: string;
  complianceState: string;
  installationGeneration: string | null;
};

/** The same lock order is used by credential publication and lifecycle cleanup. */
export async function lockShopifySessionLifecycle({
  tx,
  shop,
  storeId,
}: {
  tx: Prisma.TransactionClient;
  shop: string;
  storeId: string | null;
}) {
  const rows = storeId
    ? await tx.$queryRaw<LockedShopifySessionStore[]>(Prisma.sql`
        SELECT id, projectId, shopDomain, complianceState, installationGeneration
        FROM WeleticShopifyStore WHERE id = ${storeId} LIMIT 1 FOR UPDATE
      `)
    : await tx.$queryRaw<LockedShopifySessionStore[]>(Prisma.sql`
        SELECT id, projectId, shopDomain, complianceState, installationGeneration
        FROM WeleticShopifyStore WHERE shopDomain = ${shop} LIMIT 1 FOR UPDATE
      `);
  const store = rows[0];
  const identities = deriveAllShopifyShopPrivacyIdentities({
    shopDomain: shop,
  });
  const predicates = identities.map(
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
  if (tombstones.length) {
    throw new SessionCredentialWriteBlockedError(
      "A tombstoned Shopify domain cannot accept session credentials.",
    );
  }
  if (storeId && !store) {
    throw new SessionCredentialWriteBlockedError(
      "The retained Shopify store disappeared during session refresh.",
    );
  }
  if (!store) return undefined;
  if (store.complianceState === "redacted" || store.shopDomain !== shop) {
    throw new SessionCredentialWriteBlockedError(
      "A redacted Shopify store cannot accept session credentials.",
    );
  }
  const blockingRedacts = await tx.weleticShopifyComplianceRequest.count({
    where: {
      storeId: store.id,
      requestType: "shop_redact",
      status: { not: "completed" },
    },
  });
  if (blockingRedacts > 0) {
    throw new SessionCredentialWriteBlockedError(
      "Shopify session refresh is blocked by shop redaction.",
    );
  }
  const blockingUninstalls = await tx.weleticShopifyComplianceRequest.count({
    where: {
      storeId: store.id,
      requestType: "app_uninstalled",
      status: { not: "completed" },
    },
  });
  if (store.complianceState === "active" && blockingUninstalls > 0) {
    throw new SessionCredentialWriteBlockedError(
      "Shopify session refresh is waiting for the uninstall freeze.",
    );
  }
  // A lease is not a one-time, authenticated reconnect intent. An old OAuth
  // session cannot silently reopen a frozen installation.
  if (store.complianceState === "frozen") {
    throw new SessionCredentialWriteBlockedError(
      "Frozen Shopify session refresh requires an authorized reconnect intent.",
    );
  }
  if (store.complianceState !== "active") {
    throw new SessionCredentialWriteBlockedError(
      "Shopify installation is not active.",
    );
  }
  return store;
}
