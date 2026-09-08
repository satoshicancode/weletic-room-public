import { decrypt, decryptOrPassthrough } from "@/lib/encryption";
import { integrationCredentialsSchema } from "@/lib/integrations/shopify/schema";
import { prisma } from "@/lib/prisma";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { Prisma } from "@prisma/client";
import { createHash } from "crypto";

export interface ResolvedShopifyStore {
  shopId: string;
  primaryDomain: string;
  myshopifyDomain: string;
  allDomains: string[];
  workspaceId: string;
  programId: string;
  accessToken: string;
  storeId?: string;
}

/**
 * Kept as a lifecycle boundary for existing callers. Credential-bearing
 * resolver results are deliberately no longer cached: installation generation
 * does not change for every OAuth token refresh, so a process-local token cache
 * cannot prove that its raw credential is still current across instances.
 */
export function invalidateShopifyStoreDomainCache(domains: readonly string[]) {
  // Normalize to retain input validation/telemetry breakpoints without ever
  // retaining a raw access token in process memory.
  domains.forEach(normalizeShopDomain);
}

/**
 * Normalizes any Shopify domain string by removing protocol and trailing slashes.
 */
export function normalizeShopDomain(domain: string): string {
  if (!domain) return "";
  return domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
}

export function canonicalizeShopifyDomain(domain: string): string | null {
  const normalized = normalizeShopDomain(domain);
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(normalized)
    ? normalized
    : null;
}

export function shopifyCredentialVerificationHash(accessToken: string) {
  return createHash("sha256").update(accessToken).digest("hex");
}

/**
 * Returns the digest of the credential that is actually persisted, rather
 * than trusting its mutable verification metadata. This is the optimistic
 * concurrency token used by callback and session refresh writers.
 */
export function readShopifyCredentialTokenHash(
  credentials: unknown,
): string | null {
  const parsed = integrationCredentialsSchema.safeParse(credentials || {}).data;
  if (!parsed?.accessToken) return null;
  try {
    return shopifyCredentialVerificationHash(
      decryptOrPassthrough(parsed.accessToken),
    );
  } catch {
    return null;
  }
}

export async function fetchVerifiedShopifyShopDetails({
  shopDomain,
  accessToken,
  customFetch = fetch,
}: {
  shopDomain: string;
  accessToken: string;
  customFetch?: typeof fetch;
}) {
  const expectedShop = canonicalizeShopifyDomain(shopDomain);
  if (!expectedShop || !accessToken.trim()) return null;

  try {
    const response = await customFetch(
      `https://${expectedShop}/admin/api/2026-07/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({
          query:
            "query VerifyCredentialShop { shop { myshopifyDomain currencyCode } }",
        }),
      },
    );
    if (!response.ok) return null;

    const payload = await response.json();
    const verifiedDomain = canonicalizeShopifyDomain(
      payload?.data?.shop?.myshopifyDomain || "",
    );
    const shopCurrency = String(payload?.data?.shop?.currencyCode || "")
      .trim()
      .toUpperCase();
    if (
      payload?.errors?.length ||
      verifiedDomain !== expectedShop ||
      !/^[A-Z]{3}$/.test(shopCurrency)
    ) {
      return null;
    }
    return { shopDomain: verifiedDomain, shopCurrency };
  } catch {
    return null;
  }
}

export async function verifyShopifyAccessTokenForDomain({
  shopDomain,
  accessToken,
  customFetch = fetch,
}: {
  shopDomain: string;
  accessToken: string;
  customFetch?: typeof fetch;
}) {
  return Boolean(
    await fetchVerifiedShopifyShopDetails({
      shopDomain,
      accessToken,
      customFetch,
    }),
  );
}

export async function verifyAndBindShopifyIntegrationCredential({
  installation,
  expectedStore,
  expectedShopDomain,
  customFetch = fetch,
  bindingAttempt = 0,
}: {
  installation: { id: string; credentials: unknown };
  expectedStore: { id: string; installationGeneration: string | null };
  expectedShopDomain: string;
  customFetch?: typeof fetch;
  bindingAttempt?: number;
}) {
  const expectedShop = canonicalizeShopifyDomain(expectedShopDomain);
  const expectedGeneration = expectedStore.installationGeneration;
  if (!expectedShop || !expectedGeneration) return null;

  let credentials: ReturnType<typeof integrationCredentialsSchema.parse>;
  try {
    credentials = integrationCredentialsSchema.parse(
      installation.credentials || {},
    );
  } catch {
    return null;
  }

  if (!credentials.accessToken) return null;

  const accessToken = decryptOrPassthrough(credentials.accessToken);
  const tokenHash = shopifyCredentialVerificationHash(accessToken);
  const credentialShop = canonicalizeShopifyDomain(credentials.shop || "");
  if (
    credentials.installationGeneration &&
    credentials.installationGeneration !== expectedGeneration
  ) {
    return null;
  }
  if (
    credentialShop === expectedShop &&
    credentials.shopVerificationTokenHash === tokenHash &&
    credentials.installationGeneration === expectedGeneration
  ) {
    return prisma.$transaction(async (tx) => {
      const stores = await tx.$queryRaw<
        Array<{
          id: string;
          projectId: string;
          installationGeneration: string | null;
        }>
      >(Prisma.sql`
        SELECT id, projectId, installationGeneration
        FROM WeleticShopifyStore
        WHERE id = ${expectedStore.id}
        LIMIT 1
        FOR UPDATE
      `);
      const store = stores[0];
      if (!store || store.installationGeneration !== expectedGeneration) {
        return null;
      }
      const currentInstallation = await tx.installedIntegration.findUnique({
        where: { id: installation.id },
        select: { id: true, projectId: true, credentials: true },
      });
      if (
        !currentInstallation ||
        currentInstallation.projectId !== store.projectId
      ) {
        return null;
      }
      const currentCredentials = integrationCredentialsSchema.safeParse(
        currentInstallation.credentials || {},
      ).data;
      if (
        !currentCredentials?.accessToken ||
        currentCredentials.accessToken !== credentials.accessToken ||
        currentCredentials.installationGeneration !== expectedGeneration ||
        currentCredentials.shopVerificationTokenHash !== tokenHash ||
        canonicalizeShopifyDomain(currentCredentials.shop || "") !==
          expectedShop
      ) {
        return null;
      }
      return currentCredentials;
    });
  }
  if (!installation.id) return null;

  const verified = await verifyShopifyAccessTokenForDomain({
    shopDomain: expectedShop,
    accessToken,
    customFetch,
  });
  if (!verified) return null;

  // The live verification result is published only while holding the exact
  // store row. Callback credential rotation holds the same row, so token and
  // generation cannot change between this current read and the bookkeeping
  // write. Mutable InstalledIntegration.updatedAt is deliberately not install
  // authority and may advance without changing the generation.
  const publication = await prisma.$transaction(async (tx) => {
    const stores = await tx.$queryRaw<
      Array<{
        id: string;
        projectId: string;
        installationGeneration: string | null;
      }>
    >(Prisma.sql`
      SELECT id, projectId, installationGeneration
      FROM WeleticShopifyStore
      WHERE id = ${expectedStore.id}
      LIMIT 1
      FOR UPDATE
    `);
    const store = stores[0];
    if (!store || store.installationGeneration !== expectedGeneration) {
      return { kind: "rejected" as const };
    }
    const currentInstallation = await tx.installedIntegration.findUnique({
      where: { id: installation.id },
      select: { id: true, projectId: true, credentials: true },
    });
    if (
      !currentInstallation ||
      currentInstallation.projectId !== store.projectId
    ) {
      return { kind: "rejected" as const };
    }
    const currentCredentials = integrationCredentialsSchema.safeParse(
      currentInstallation.credentials || {},
    ).data;
    if (!currentCredentials?.accessToken) {
      return { kind: "rejected" as const };
    }
    if (currentCredentials.accessToken !== credentials.accessToken) {
      return {
        kind: "retry" as const,
        installation: currentInstallation,
      };
    }
    if (
      currentCredentials.installationGeneration &&
      currentCredentials.installationGeneration !== expectedGeneration
    ) {
      return { kind: "rejected" as const };
    }
    const upgradedCredentials = {
      ...(currentInstallation.credentials &&
      typeof currentInstallation.credentials === "object" &&
      !Array.isArray(currentInstallation.credentials)
        ? currentInstallation.credentials
        : {}),
      shop: expectedShop,
      installationGeneration: expectedGeneration,
      shopVerifiedAt: new Date().toISOString(),
      shopVerificationTokenHash: tokenHash,
    };
    await tx.installedIntegration.update({
      where: { id: currentInstallation.id },
      data: { credentials: upgradedCredentials },
    });
    return {
      kind: "bound" as const,
      credentials: integrationCredentialsSchema.parse(upgradedCredentials),
    };
  });
  if (publication.kind === "bound") return publication.credentials;
  if (publication.kind !== "retry" || bindingAttempt >= 2) return null;
  return verifyAndBindShopifyIntegrationCredential({
    installation: publication.installation,
    expectedStore,
    expectedShopDomain: expectedShop,
    customFetch,
    bindingAttempt: bindingAttempt + 1,
  });
}

function readOfflineSessionAccessToken(payload: string): string | null {
  try {
    const decrypted = JSON.parse(decrypt(payload));
    const values: Record<string, unknown> = Array.isArray(decrypted)
      ? Object.fromEntries(decrypted)
      : decrypted;
    return typeof values.accessToken === "string" && values.accessToken
      ? values.accessToken
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolves a Shopify store and associated Weletic workspace by ANY of its domains
 * (legacy myshopifyDomain, renamed myshopifyDomain, custom primary domain, or Shop ID).
 */
export async function resolveShopifyStoreByDomain(
  rawDomain: string,
): Promise<ResolvedShopifyStore | null> {
  const domain = normalizeShopDomain(rawDomain);
  if (!domain) return null;

  // 1. Direct database lookup by project.shopifyStoreId or
  // weleticShopifyStore.shopDomain. Every invocation re-reads the credential;
  // no raw token survives a same-generation refresh in a process-local cache.
  let matchingProject: any = null;
  if (typeof prisma?.project?.findUnique === "function") {
    matchingProject = await prisma.project.findUnique({
      where: { shopifyStoreId: domain },
      select: {
        id: true,
        shopifyStoreId: true,
        defaultProgramId: true,
        installedIntegrations: {
          where: { integrationId: SHOPIFY_INTEGRATION_ID },
          take: 1,
          select: { id: true, credentials: true, updatedAt: true },
        },
        weleticShopifyStore: {
          select: {
            id: true,
            shopDomain: true,
            installationGeneration: true,
          },
        },
      },
    });
  }

  if (!matchingProject && typeof prisma?.project?.findFirst === "function") {
    matchingProject = await prisma.project.findFirst({
      where: {
        OR: [
          { shopifyStoreId: domain },
          {
            shopifyStoreId:
              domain.replace(".myshopify.com", "") + ".myshopify.com",
          },
          { weleticShopifyStore: { shopDomain: domain } },
        ],
      },
      select: {
        id: true,
        shopifyStoreId: true,
        defaultProgramId: true,
        installedIntegrations: {
          where: { integrationId: SHOPIFY_INTEGRATION_ID },
          take: 1,
          select: { id: true, credentials: true, updatedAt: true },
        },
        weleticShopifyStore: {
          select: {
            id: true,
            shopDomain: true,
            installationGeneration: true,
          },
        },
      },
    });
  }

  // 2. A renamed/legacy myshopify domain may live only in credentials.shop.
  // Query that exact JSON value instead of scanning every tenant or probing live APIs.
  let exactIntegration: any = matchingProject?.installedIntegrations[0] ?? null;
  let matchedOnlyByCredentialAlias = false;
  if (!exactIntegration && !matchingProject) {
    exactIntegration = await prisma.installedIntegration.findFirst({
      where: {
        integrationId: SHOPIFY_INTEGRATION_ID,
        credentials: { path: "$.shop", equals: domain },
      },
      select: {
        id: true,
        credentials: true,
        updatedAt: true,
        project: {
          select: {
            id: true,
            shopifyStoreId: true,
            defaultProgramId: true,
            weleticShopifyStore: {
              select: {
                id: true,
                shopDomain: true,
                installationGeneration: true,
              },
            },
          },
        },
      },
    });

    if (exactIntegration?.project) {
      matchingProject = exactIntegration.project;
      matchedOnlyByCredentialAlias = true;
    }
  }

  if (!matchingProject?.defaultProgramId) {
    return null;
  }

  const projectShop = normalizeShopDomain(matchingProject.shopifyStoreId || "");
  const storeShop = normalizeShopDomain(
    matchingProject.weleticShopifyStore?.shopDomain || "",
  );
  let accessToken: string | null = null;
  let installedShop = "";

  if (exactIntegration?.credentials) {
    // Every credential-derived alias must carry a token-bound verification
    // marker or pass Shopify's live identity check before it can resolve.
    const credentialStore = matchingProject.weleticShopifyStore;
    if (!credentialStore?.id) return null;
    const creds = await verifyAndBindShopifyIntegrationCredential({
      installation: exactIntegration,
      expectedStore: {
        id: credentialStore.id,
        installationGeneration: credentialStore.installationGeneration ?? null,
      },
      expectedShopDomain: domain,
    });

    if (creds) {
      installedShop = normalizeShopDomain(creds.shop || "");
      if (creds.accessToken && installedShop === domain) {
        accessToken = decryptOrPassthrough(creds.accessToken);
      }
    } else if (matchedOnlyByCredentialAlias) {
      return null;
    }
  }

  // The Remix app session is only a bootstrap authority before an integration
  // exists. Once InstalledIntegration exists it is the versioned credential
  // source; falling back to a possibly stale session would bypass its CAS.
  if (!accessToken && !exactIntegration) {
    const offlineSession = await prisma.weleticShopifyAppSession.findFirst({
      where: {
        isOnline: false,
        shop: domain,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { updatedAt: "desc" },
      select: { shop: true, payload: true },
    });

    if (
      offlineSession?.payload &&
      normalizeShopDomain(offlineSession.shop || "") === domain
    ) {
      accessToken = readOfflineSessionAccessToken(offlineSession.payload);
      installedShop = domain;
    }
  }

  if (!accessToken) {
    return null;
  }

  const resolved: ResolvedShopifyStore = {
    shopId: `shop_${matchingProject.id}`,
    primaryDomain: projectShop || storeShop || installedShop || domain,
    myshopifyDomain: installedShop || domain,
    allDomains: Array.from(
      new Set([domain, installedShop, projectShop, storeShop].filter(Boolean)),
    ),
    workspaceId: matchingProject.id,
    programId: matchingProject.defaultProgramId,
    accessToken,
    storeId: matchingProject.weleticShopifyStore?.id,
  };

  return resolved;
}
