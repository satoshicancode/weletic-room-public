import { prisma } from "@/lib/prisma";
import { deriveAllShopifyShopPrivacyIdentities } from "@/lib/weletic/shopify/privacy-identity";
import { canonicalizeShopifyDomain } from "@/lib/weletic/shopify/store-resolver";

export interface ComplianceResolvedShopifyStore {
  storeId: string;
  workspaceId: string;
  programId: string;
  canonicalShopDomain: string;
  storageShopDomain: string;
  complianceState: "active" | "frozen" | "redacted";
  resolvedFromTombstone: boolean;
}

const storeSelection = {
  id: true,
  projectId: true,
  programId: true,
  shopDomain: true,
  complianceState: true,
} as const;

/**
 * Compliance-only resolver. It intentionally never reads, decrypts, validates,
 * or refreshes Shopify Admin credentials. Active/frozen stores resolve by the
 * exact canonical shop domain. Redacted stores resolve through a keyed-HMAC
 * tombstone so the raw domain does not need to survive erasure.
 */
export async function resolveComplianceShopifyStoreByDomain(
  rawDomain: string,
): Promise<ComplianceResolvedShopifyStore | null> {
  const canonicalShopDomain = canonicalizeShopifyDomain(rawDomain);
  if (!canonicalShopDomain) return null;

  const exact = await prisma.weleticShopifyStore.findUnique({
    where: { shopDomain: canonicalShopDomain },
    select: storeSelection,
  });
  const tombstoneStores = new Map<string, NonNullable<typeof exact>>();
  for (const identity of deriveAllShopifyShopPrivacyIdentities({
    shopDomain: canonicalShopDomain,
  })) {
    const tombstones = await prisma.weleticShopifyShopPrivacyTombstone.findMany(
      {
        where: {
          identityKeyId: identity.identityKeyId,
          shopDomainDigest: identity.shopDomainDigest,
          expiresAt: { gt: new Date() },
        },
        orderBy: { id: "asc" },
        take: 2,
        select: { store: { select: storeSelection } },
      },
    );
    for (const tombstone of tombstones) {
      tombstoneStores.set(tombstone.store.id, tombstone.store);
    }
  }

  // A recycled Shopify domain must not silently route a late compliance or
  // financial event to either the new exact owner or an older redacted owner.
  // Different key versions that point to different stores are equally
  // ambiguous and fail closed.
  if (
    tombstoneStores.size > 1 ||
    (exact && tombstoneStores.size === 1 && !tombstoneStores.has(exact.id))
  ) {
    return null;
  }
  if (exact) {
    return {
      storeId: exact.id,
      workspaceId: exact.projectId,
      programId: exact.programId,
      canonicalShopDomain,
      storageShopDomain: exact.shopDomain,
      complianceState: exact.complianceState,
      resolvedFromTombstone: false,
    };
  }
  const tombstoneStore = tombstoneStores.values().next().value;
  if (tombstoneStore) {
    return {
      storeId: tombstoneStore.id,
      workspaceId: tombstoneStore.projectId,
      programId: tombstoneStore.programId,
      canonicalShopDomain,
      storageShopDomain: tombstoneStore.shopDomain,
      complianceState: tombstoneStore.complianceState,
      resolvedFromTombstone: true,
    };
  }

  return null;
}
