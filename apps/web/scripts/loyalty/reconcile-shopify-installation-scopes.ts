import { decryptOrPassthrough } from "@/lib/encryption";
import { integrationCredentialsSchema } from "@/lib/integrations/shopify/schema";
import { prisma } from "@/lib/prisma";
import { shopifyAdminGraphqlRequest } from "@/lib/weletic/loyalty/shopify-discounts";
import { canonicalizeShopifyDomain } from "@/lib/weletic/shopify/store-resolver";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { Prisma } from "@prisma/client";

type CliOptions = {
  storeDomain: string;
  confirmStaging: boolean;
  apply: boolean;
};

function parseCli(argv: string[]): CliOptions {
  let storeDomain = "";
  let confirmStaging = false;
  let apply = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--store") storeDomain = argv[++index] || "";
    else if (argument === "--confirm-staging") confirmStaging = true;
    else if (argument === "--apply") apply = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return { storeDomain, confirmStaging, apply };
}

function assertSafety(options: CliOptions) {
  if (!options.confirmStaging) {
    throw new Error("Missing explicit staging confirmation.");
  }
  if (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production"
  ) {
    throw new Error("Shopify scope reconciliation is forbidden in production.");
  }
  const storeDomain = canonicalizeShopifyDomain(options.storeDomain);
  if (!storeDomain) {
    throw new Error("A canonical myshopify.com test-store domain is required.");
  }
  const allowlist = new Set(
    (process.env.WELETIC_LOYALTY_TEST_STORE_ALLOWLIST || "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  if (!allowlist.has(storeDomain)) {
    throw new Error(
      "The requested store is not in the explicit test allowlist.",
    );
  }
  return storeDomain;
}

function normalizeScopes(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) =>
          entry && typeof entry === "object" && "handle" in entry
            ? String((entry as { handle?: unknown }).handle || "").trim()
            : "",
        )
        .filter(Boolean),
    ),
  ).sort();
}

async function run() {
  const options = parseCli(process.argv.slice(2));
  const storeDomain = assertSafety(options);
  const store = await prisma.weleticShopifyStore.findUnique({
    where: { shopDomain: storeDomain },
    select: { id: true, projectId: true, complianceState: true },
  });
  if (!store || store.complianceState !== "active") {
    throw new Error("The exact active Shopify store could not be resolved.");
  }

  const installations = await prisma.installedIntegration.findMany({
    where: {
      projectId: store.projectId,
      integrationId: SHOPIFY_INTEGRATION_ID,
    },
    orderBy: { id: "asc" },
    take: 2,
    select: { id: true, updatedAt: true, credentials: true },
  });
  if (installations.length !== 1) {
    throw new Error(
      `Expected one Shopify credential authority; found ${installations.length}.`,
    );
  }

  const installation = installations[0];
  const credentials = integrationCredentialsSchema.parse(
    installation.credentials || {},
  );
  if (
    canonicalizeShopifyDomain(credentials.shop || "") !== storeDomain ||
    !credentials.accessToken
  ) {
    throw new Error(
      "The retained Shopify credential is missing or belongs to another store.",
    );
  }

  const response = await shopifyAdminGraphqlRequest<{
    currentAppInstallation: {
      accessScopes: Array<{ handle: string }>;
    } | null;
  }>({
    shopDomain: storeDomain,
    accessToken: decryptOrPassthrough(credentials.accessToken),
    query: `query WeleticReconcileInstallationScopes {
      currentAppInstallation {
        accessScopes { handle }
      }
    }`,
  });
  const authoritativeScopes = normalizeScopes(
    response.currentAppInstallation?.accessScopes,
  );
  if (authoritativeScopes.length === 0) {
    throw new Error("Shopify returned no authoritative access scopes.");
  }

  const cachedScopes = Array.from(
    new Set(
      String(credentials.scope || "")
        .split(/[\s,]+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ).sort();
  const result = {
    storeDomain,
    dryRun: !options.apply,
    cachedScopeCount: cachedScopes.length,
    authoritativeScopeCount: authoritativeScopes.length,
    added: authoritativeScopes.filter((scope) => !cachedScopes.includes(scope)),
    removed: cachedScopes.filter(
      (scope) => !authoritativeScopes.includes(scope),
    ),
    updated: false,
  };

  if (options.apply && (result.added.length > 0 || result.removed.length > 0)) {
    if (
      !installation.credentials ||
      typeof installation.credentials !== "object" ||
      Array.isArray(installation.credentials)
    ) {
      throw new Error("The credential authority has an invalid JSON shape.");
    }
    const nextCredentials: Prisma.InputJsonObject = {
      ...(installation.credentials as Prisma.JsonObject),
      scope: authoritativeScopes.join(","),
    };
    const updated = await prisma.installedIntegration.updateMany({
      where: {
        id: installation.id,
        projectId: store.projectId,
        integrationId: SHOPIFY_INTEGRATION_ID,
        updatedAt: installation.updatedAt,
      },
      data: { credentials: nextCredentials },
    });
    if (updated.count !== 1) {
      throw new Error(
        "The credential authority changed concurrently; no scope metadata was updated.",
      );
    }
    result.updated = true;
  }

  process.stdout.write(`${JSON.stringify(result)}\n`);
  await prisma.$disconnect();
}

void run();
