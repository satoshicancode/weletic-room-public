import { DubApiError } from "@/lib/api/errors";
import { prisma } from "@/lib/prisma";
import { deriveAllShopifyShopPrivacyIdentities } from "@/lib/weletic/shopify/privacy-identity";
import { canonicalizeShopifyDomain } from "@/lib/weletic/shopify/store-resolver";

export type ShopifyConnectLifecycle =
  | {
      mode: "new";
      storeId: null;
      observedInstallationGeneration: null;
    }
  | {
      mode: "active" | "frozen_refresh" | "reactivate";
      storeId: string;
      observedInstallationGeneration: string | null;
    };

export async function inspectShopifyConnectLifecycle({
  workspaceId,
  currentProjectShopDomain,
  canonicalShopDomain,
}: {
  workspaceId: string;
  currentProjectShopDomain?: string | null;
  canonicalShopDomain: string;
}): Promise<ShopifyConnectLifecycle> {
  const privacyIdentities = deriveAllShopifyShopPrivacyIdentities({
    shopDomain: canonicalShopDomain,
  });
  const [store, globalExactStore, retainedTombstones] = await Promise.all([
    prisma.weleticShopifyStore.findUnique({
      where: { projectId: workspaceId },
      select: {
        id: true,
        projectId: true,
        shopDomain: true,
        complianceState: true,
        installationGeneration: true,
      },
    }),
    prisma.weleticShopifyStore.findFirst({
      where: { shopDomain: canonicalShopDomain },
      select: { id: true, projectId: true },
    }),
    prisma.weleticShopifyShopPrivacyTombstone.findMany({
      where: {
        OR: privacyIdentities.map(({ identityKeyId, shopDomainDigest }) => ({
          identityKeyId,
          shopDomainDigest,
        })),
        expiresAt: { gt: new Date() },
      },
      orderBy: { id: "asc" },
      take: 2,
      select: { storeId: true },
    }),
  ]);
  if (retainedTombstones.length > 0) {
    throw new DubApiError({
      code: "conflict",
      message:
        "This Shopify domain is retained by a redacted privacy lifecycle and cannot be rebound.",
    });
  }
  if (globalExactStore && globalExactStore.projectId !== workspaceId) {
    throw new DubApiError({
      code: "conflict",
      message: "This Shopify domain is already bound to another workspace.",
    });
  }
  if (!store) {
    const currentCanonical = currentProjectShopDomain
      ? canonicalizeShopifyDomain(currentProjectShopDomain)
      : null;
    if (currentCanonical && currentCanonical !== canonicalShopDomain) {
      throw new DubApiError({
        code: "conflict",
        message:
          "Disconnect the existing Shopify store lifecycle before connecting another domain.",
      });
    }
    return {
      mode: "new",
      storeId: null,
      observedInstallationGeneration: null,
    };
  }
  if (globalExactStore && globalExactStore.id !== store.id) {
    throw new DubApiError({
      code: "conflict",
      message:
        "This Shopify domain is already bound to another retained store.",
    });
  }
  if (canonicalizeShopifyDomain(store.shopDomain) !== canonicalShopDomain) {
    throw new DubApiError({
      code: "conflict",
      message:
        "This workspace retains loyalty and financial history for a different Shopify store.",
    });
  }
  if (store.complianceState === "redacted") {
    throw new DubApiError({
      code: "conflict",
      message: "A redacted Shopify store record cannot be reactivated.",
    });
  }
  if (store.complianceState === "active") {
    const blockingRequests = await prisma.weleticShopifyComplianceRequest.count(
      {
        where: {
          storeId: store.id,
          requestType: { in: ["app_uninstalled", "shop_redact"] },
          status: { not: "completed" },
        },
      },
    );
    if (blockingRequests > 0) {
      throw new DubApiError({
        code: "conflict",
        message:
          "Shopify connection is blocked while an uninstall or shop-redact request freezes the store.",
      });
    }
    return {
      mode: "active",
      storeId: store.id,
      observedInstallationGeneration: store.installationGeneration ?? null,
    };
  }

  const [
    blockingShopRedacts,
    blockingUninstalls,
    nonCompletedCleanups,
    completedUninstalls,
  ] = await Promise.all([
    prisma.weleticShopifyComplianceRequest.count({
      where: {
        storeId: store.id,
        requestType: "shop_redact",
        status: { not: "completed" },
      },
    }),
    prisma.weleticShopifyComplianceRequest.count({
      where: {
        storeId: store.id,
        requestType: "app_uninstalled",
        status: { not: "completed" },
      },
    }),
    prisma.weleticShopifyVoucherCleanup.count({
      where: { storeId: store.id, status: { not: "completed" } },
    }),
    prisma.weleticShopifyComplianceRequest.count({
      where: {
        storeId: store.id,
        requestType: "app_uninstalled",
        status: "completed",
      },
    }),
  ]);
  if (blockingShopRedacts > 0) {
    throw new DubApiError({
      code: "conflict",
      message:
        "Shopify connection is blocked while shop-redact permanently erases the retained store.",
    });
  }
  return {
    mode:
      blockingUninstalls === 0 &&
      nonCompletedCleanups === 0 &&
      completedUninstalls > 0
        ? "reactivate"
        : "frozen_refresh",
    storeId: store.id,
    observedInstallationGeneration: store.installationGeneration ?? null,
  };
}
