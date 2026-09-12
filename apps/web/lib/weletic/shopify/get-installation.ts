import { DubApiError } from "@/lib/api/errors";
import { decryptOrPassthrough } from "@/lib/encryption";
import { integrationCredentialsSchema } from "@/lib/integrations/shopify/schema";
import { prisma } from "@/lib/prisma";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { ShopifyCredentialUnavailableError } from "./credential-errors";
import { readShopifyCredentialSource } from "./credential-source";

export async function getWeleticShopifyInstallation(workspaceId: string) {
  const workspace = await prisma.project.findUniqueOrThrow({
    where: { id: workspaceId },
    select: {
      id: true,
      shopifyStoreId: true,
      defaultProgramId: true,
      weleticShopifyStore: {
        select: { id: true, shopDomain: true, installationGeneration: true },
      },
      installedIntegrations: {
        where: { integrationId: SHOPIFY_INTEGRATION_ID },
        take: 1,
        select: { credentials: true },
      },
    },
  });

  const store = workspace.weleticShopifyStore;
  const source = store
    ? await readShopifyCredentialSource({
        storeId: store.id,
        workspaceId: workspace.id,
        shop: store.shopDomain,
        installationGeneration: store.installationGeneration,
      }).catch((error: unknown) => {
        if (error instanceof ShopifyCredentialUnavailableError)
          throw new DubApiError({
            code: "bad_request",
            message: "Reconnect the Shopify app before accessing this store.",
          });
        throw error;
      })
    : { source: "legacy" as const };
  const installation = workspace.installedIntegrations[0];
  if (source.source === "legacy" && !installation) {
    throw new DubApiError({
      code: "bad_request",
      message: "The Shopify installation is missing for this workspace.",
    });
  }

  const credentials =
    source.source === "native"
      ? { ...source, shop: store!.shopDomain }
      : integrationCredentialsSchema.parse(installation.credentials ?? {});

  const effectiveShopDomain = credentials.shop || workspace.shopifyStoreId;
  if (!effectiveShopDomain || !workspace.defaultProgramId) {
    throw new DubApiError({
      code: "bad_request",
      message: "Connect Shopify and create a default partner program first.",
    });
  }

  if (!credentials.accessToken) {
    throw new DubApiError({
      code: "bad_request",
      message: "The Shopify installation has no access token.",
    });
  }

  const requiredScopes = [
    "read_products",
    "read_markets",
    "read_orders",
    "read_translations",
    "read_customers",
  ];
  const scopes = new Set(
    credentials.scope
      ?.split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  );
  const hasScope = (req: string) => {
    if (scopes.has(req)) return true;
    if (req.startsWith("read_")) {
      const writeEquivalent = req.replace("read_", "write_");
      if (scopes.has(writeEquivalent)) return true;
    }
    return false;
  };
  const missingScopes = requiredScopes.filter((scope) => !hasScope(scope));
  if (missingScopes.length) {
    throw new DubApiError({
      code: "forbidden",
      message: `Reinstall the Shopify app with scopes: ${missingScopes.join(", ")}.`,
    });
  }

  return {
    workspaceId: workspace.id,
    programId: workspace.defaultProgramId,
    shopDomain: effectiveShopDomain,
    accessToken:
      source.source === "native"
        ? source.accessToken
        : decryptOrPassthrough(credentials.accessToken),
    installationGeneration: credentials.installationGeneration ?? null,
  };
}
