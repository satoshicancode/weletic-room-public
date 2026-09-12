import { decryptOrPassthrough } from "@/lib/encryption";
import { SHOPIFY_ADMIN_API_VERSION } from "@/lib/integrations/shopify/admin-graphql";
import { integrationCredentialsSchema } from "@/lib/integrations/shopify/schema";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { lockLoyaltyProgramRowIfPresent } from "@/lib/weletic/loyalty/program-write-fence";
import { lockLegacyShopifyConnection } from "@/lib/weletic/shopify/legacy-connection-fence";
import {
  ensureShopifyWebhooksRegistered,
  SHOPIFY_CANONICAL_WEBHOOK_TOPICS,
} from "@/lib/weletic/shopify/provision-webhooks";
import { advanceLegacyShopifySessionRevision } from "@/lib/weletic/shopify/session-coordination";
import { configuredShopifySessionScope } from "@/lib/weletic/shopify/session-snapshot";
import {
  canonicalizeShopifyDomain,
  fetchVerifiedShopifyShopDetails,
  readShopifyCredentialTokenHash,
  shopifyCredentialVerificationHash,
} from "@/lib/weletic/shopify/store-resolver";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { Prisma } from "@prisma/client";

export const SHOPIFY_INSTALLATION_ACTIVATION_MAINTENANCE_FENCE =
  "loyalty-writers-paused-and-drained";

const BLOCKING_OUTBOX_JOB_STATUSES = [
  "pending",
  "processing",
  "failed",
  "dead_letter",
] as const;

type ActivationClient = typeof prisma | Prisma.TransactionClient;

async function inspectMaintenanceFence(
  client: ActivationClient,
  storeId: string,
) {
  const [
    fencedActivePrograms,
    writeEnabledPrograms,
    provisioningRedemptions,
    blockingOutboxJobs,
    committingBackfills,
    blockingLifecycleRequests,
  ] = await Promise.all([
    client.weleticLoyaltyProgram.count({
      where: { storeId, status: "active", killSwitchActive: true },
    }),
    client.weleticLoyaltyProgram.count({
      where: { storeId, status: "active", killSwitchActive: false },
    }),
    client.weleticRewardRedemption.count({
      where: { storeId, status: "provisioning" },
    }),
    client.weleticLoyaltyOutboxJob.count({
      where: {
        storeId,
        status: { in: [...BLOCKING_OUTBOX_JOB_STATUSES] },
      },
    }),
    client.weleticLoyaltyBackfillJob.count({
      where: { storeId, status: "committing" },
    }),
    client.weleticShopifyComplianceRequest.count({
      where: {
        storeId,
        requestType: { in: ["app_uninstalled", "shop_redact"] },
        status: { not: "completed" },
      },
    }),
  ]);

  return {
    fencedActivePrograms,
    writeEnabledPrograms,
    provisioningRedemptions,
    blockingOutboxJobs,
    committingBackfills,
    blockingLifecycleRequests,
  };
}

function isMaintenanceFenceReady(
  state: Awaited<ReturnType<typeof inspectMaintenanceFence>>,
) {
  return (
    state.fencedActivePrograms === 1 &&
    state.writeEnabledPrograms === 0 &&
    state.provisioningRedemptions === 0 &&
    state.blockingOutboxJobs === 0 &&
    state.committingBackfills === 0 &&
    state.blockingLifecycleRequests === 0
  );
}

function assertMaintenanceFence(
  maintenanceFence: string | undefined,
  state: Awaited<ReturnType<typeof inspectMaintenanceFence>>,
) {
  if (maintenanceFence !== SHOPIFY_INSTALLATION_ACTIVATION_MAINTENANCE_FENCE) {
    throw new Error(
      `Refusing installation-generation activation without --maintenance-fence=${SHOPIFY_INSTALLATION_ACTIVATION_MAINTENANCE_FENCE}.`,
    );
  }
  if (!isMaintenanceFenceReady(state)) {
    throw new Error(
      `Shopify installation activation fence is not drained (${Object.entries(
        state,
      )
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}).`,
    );
  }
}

export async function activateShopifyInstallationGeneration({
  storeDomain,
  apply = false,
  maintenanceFence,
}: {
  storeDomain: string;
  apply?: boolean;
  maintenanceFence?: string;
}) {
  const canonicalStoreDomain = canonicalizeShopifyDomain(storeDomain);
  if (!canonicalStoreDomain) {
    throw new Error("A valid *.myshopify.com --store is required.");
  }

  const store = await prisma.weleticShopifyStore.findUnique({
    where: { shopDomain: canonicalStoreDomain },
    select: {
      id: true,
      projectId: true,
      shopDomain: true,
      shopCurrency: true,
      complianceState: true,
      installationGeneration: true,
    },
  });
  if (!store || store.complianceState !== "active") {
    throw new Error(
      "The exact active Shopify store lifecycle could not be resolved.",
    );
  }

  // This maintenance command is not a public-app authentication alternative.
  // Reject native ownership before reading or remotely using legacy credentials.
  await prisma.$transaction((tx) =>
    lockLegacyShopifyConnection(tx, {
      workspaceId: store.projectId,
      shop: canonicalStoreDomain,
    }),
  );

  const installations = await prisma.installedIntegration.findMany({
    where: {
      projectId: store.projectId,
      integrationId: SHOPIFY_INTEGRATION_ID,
    },
    orderBy: { id: "asc" },
    take: 2,
    select: { id: true, projectId: true, credentials: true },
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
    canonicalizeShopifyDomain(credentials.shop || "") !==
      canonicalStoreDomain ||
    !credentials.accessToken
  ) {
    throw new Error(
      "The retained Shopify credential is missing or belongs to another store.",
    );
  }
  const accessToken = decryptOrPassthrough(credentials.accessToken);
  const observedTokenHash = shopifyCredentialVerificationHash(accessToken);

  if (store.installationGeneration || credentials.installationGeneration) {
    if (
      store.installationGeneration &&
      credentials.installationGeneration === store.installationGeneration &&
      credentials.shopVerificationTokenHash === observedTokenHash
    ) {
      return {
        dryRun: !apply,
        storeId: store.id,
        storeDomain: canonicalStoreDomain,
        alreadyActive: true,
        readyToApply: false,
        installationGeneration: store.installationGeneration,
      };
    }
    throw new Error(
      "The store and credential installation generations are inconsistent.",
    );
  }

  const fence = await inspectMaintenanceFence(prisma, store.id);
  if (apply) assertMaintenanceFence(maintenanceFence, fence);

  if (!apply) {
    const verifiedShop = await fetchVerifiedShopifyShopDetails({
      shopDomain: canonicalStoreDomain,
      accessToken,
    });
    if (!verifiedShop) {
      throw new Error(
        "Shopify rejected the retained credential or did not return an authoritative currency.",
      );
    }
    return {
      dryRun: true,
      storeId: store.id,
      storeDomain: canonicalStoreDomain,
      alreadyActive: false,
      readyToApply: isMaintenanceFenceReady(fence),
      verifiedCurrency: verifiedShop.shopCurrency,
      maintenanceFence: fence,
    };
  }

  const activation = await prisma.$transaction(
    async (tx) => {
      const lockedStores = await tx.$queryRaw<
        Array<{
          id: string;
          projectId: string;
          shopDomain: string;
          complianceState: string;
          installationGeneration: string | null;
        }>
      >(Prisma.sql`
      SELECT id, projectId, shopDomain, complianceState, installationGeneration
      FROM WeleticShopifyStore
      WHERE id = ${store.id}
      LIMIT 1
      FOR UPDATE
    `);
      const lockedStore = lockedStores[0];
      if (
        !lockedStore ||
        lockedStore.projectId !== store.projectId ||
        lockedStore.shopDomain !== canonicalStoreDomain ||
        lockedStore.complianceState !== "active" ||
        lockedStore.installationGeneration !== null
      ) {
        throw new Error(
          "The Shopify store lifecycle changed during generation activation.",
        );
      }

      await lockLegacyShopifyConnection(tx, {
        workspaceId: store.projectId,
        shop: canonicalStoreDomain,
      });
      // Fence observations and reject SDK-promoted coordinators before any
      // provider mutation. Revision advancement rolls back with local writes.
      await advanceLegacyShopifySessionRevision(
        tx,
        configuredShopifySessionScope(canonicalStoreDomain),
      );

      const lockedProgram = await lockLoyaltyProgramRowIfPresent({
        tx,
        storeId: store.id,
      });
      if (
        !lockedProgram ||
        lockedProgram.status !== "active" ||
        !Boolean(lockedProgram.killSwitchActive)
      ) {
        throw new Error(
          "The loyalty program must remain active with its kill switch enabled.",
        );
      }

      assertMaintenanceFence(
        maintenanceFence,
        await inspectMaintenanceFence(tx, store.id),
      );

      const currentInstallation = await tx.installedIntegration.findUnique({
        where: { id: installation.id },
        select: { id: true, projectId: true, credentials: true },
      });
      const currentCredentials = integrationCredentialsSchema.safeParse(
        currentInstallation?.credentials || {},
      ).data;
      if (
        !currentInstallation ||
        currentInstallation.projectId !== store.projectId ||
        !currentCredentials?.accessToken ||
        currentCredentials.accessToken !== credentials.accessToken ||
        currentCredentials.installationGeneration != null ||
        canonicalizeShopifyDomain(currentCredentials.shop || "") !==
          canonicalStoreDomain ||
        readShopifyCredentialTokenHash(currentInstallation.credentials) !==
          observedTokenHash
      ) {
        throw new Error(
          "The Shopify credential changed during generation activation.",
        );
      }

      // Compliance ingress freezes the same store row. Keep it locked across
      // the remote mutations so webhook provisioning cannot race an uninstall
      // or shop-redact lifecycle transition.
      const verifiedShop = await fetchVerifiedShopifyShopDetails({
        shopDomain: canonicalStoreDomain,
        accessToken,
      });
      if (!verifiedShop) {
        throw new Error(
          "Shopify rejected the retained credential or did not return an authoritative currency.",
        );
      }
      const webhookProvisioning = await ensureShopifyWebhooksRegistered({
        shopDomain: canonicalStoreDomain,
        accessToken,
        allowSdkFallback: false,
      });
      const provisionedTopics = new Set([
        ...webhookProvisioning.registered,
        ...webhookProvisioning.skipped,
      ]);
      const missingTopics = SHOPIFY_CANONICAL_WEBHOOK_TOPICS.filter(
        (topic) => !provisionedTopics.has(topic),
      );
      if (
        !webhookProvisioning.success ||
        webhookProvisioning.failed.length > 0 ||
        missingTopics.length > 0
      ) {
        const failedTopics = webhookProvisioning.failed
          .map(({ topic }) => topic)
          .concat(missingTopics)
          .join(", ");
        throw new Error(
          `Shopify webhook provisioning failed${failedTopics ? ` for: ${failedTopics}` : "."}`,
        );
      }

      const activatedAt = new Date();
      const installationGeneration = createWeleticId("sgen_");

      const updatedStore = await tx.weleticShopifyStore.updateMany({
        where: {
          id: store.id,
          projectId: store.projectId,
          shopDomain: canonicalStoreDomain,
          complianceState: "active",
          installationGeneration: null,
        },
        data: {
          shopCurrency: verifiedShop.shopCurrency,
          currencyVerifiedAt: activatedAt,
          installationGeneration,
          apiVersion: SHOPIFY_ADMIN_API_VERSION,
          syncStatus: "pending",
          lastSyncError: null,
        },
      });
      if (updatedStore.count !== 1) {
        throw new Error(
          "The Shopify store lifecycle changed before generation publication.",
        );
      }

      const priorCredentials =
        currentInstallation.credentials &&
        typeof currentInstallation.credentials === "object" &&
        !Array.isArray(currentInstallation.credentials)
          ? currentInstallation.credentials
          : {};
      await tx.installedIntegration.update({
        where: { id: currentInstallation.id },
        data: {
          credentials: {
            ...priorCredentials,
            installationGeneration,
            shopVerifiedAt: activatedAt.toISOString(),
            shopVerificationTokenHash: observedTokenHash,
          } as Prisma.InputJsonObject,
        },
      });
      return {
        installationGeneration,
        verifiedCurrency: verifiedShop.shopCurrency,
      };
    },
    {
      maxWait: 10_000,
      timeout: 60_000,
    },
  );

  return {
    dryRun: false,
    storeId: store.id,
    storeDomain: canonicalStoreDomain,
    alreadyActive: false,
    readyToApply: false,
    installationGeneration: activation.installationGeneration,
    verifiedCurrency: activation.verifiedCurrency,
    webhookTopics: SHOPIFY_CANONICAL_WEBHOOK_TOPICS.length,
  };
}

if (typeof require !== "undefined" && require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const storeArg = args.find((arg) => arg.startsWith("--store="));
  const maintenanceFenceArg = args.find((arg) =>
    arg.startsWith("--maintenance-fence="),
  );

  activateShopifyInstallationGeneration({
    storeDomain: storeArg?.slice("--store=".length) || "",
    apply,
    maintenanceFence: maintenanceFenceArg?.slice("--maintenance-fence=".length),
  })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
