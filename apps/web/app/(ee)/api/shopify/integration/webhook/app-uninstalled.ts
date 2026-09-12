import { prisma } from "@/lib/prisma";
import { redactReferralFriendClaimsForShopBatch } from "@/lib/weletic/loyalty/referral-friend-claim";
import { processStoreVoucherCleanupComplianceStep } from "@/lib/weletic/loyalty/voucher-privacy-cleanup";
import { freezeShopifyStoreForUninstall } from "@/lib/weletic/shopify/compliance-ingress";
import {
  invalidateShopifyStoreDomainCache,
  normalizeShopDomain,
} from "@/lib/weletic/shopify/store-resolver";
import { SHOPIFY_INTEGRATION_ID } from "@dub/utils";
import { Prisma, WeleticVoucherCleanupSource } from "@prisma/client";

type AppUninstalledPhase =
  | "received"
  | "enumerate_vouchers"
  | "voucher_cleanup"
  | "scrub_friend_referral_claims"
  | "credential_scrub"
  | "finalize"
  | "completed";

type AppUninstalledStep = {
  completed: boolean;
  phase: AppUninstalledPhase;
  cursor?: Prisma.InputJsonValue | typeof Prisma.DbNull;
  progress?: Prisma.InputJsonValue | typeof Prisma.DbNull;
};

function normalizedAliases(values: readonly (string | null | undefined)[]) {
  return Array.from(
    new Set(
      values.map((value) => normalizeShopDomain(value || "")).filter(Boolean),
    ),
  );
}

async function assertUninstallStoreIdentity({
  workspaceId,
  storeId,
  shopDomain,
}: {
  workspaceId: string;
  storeId: string;
  shopDomain: string;
}) {
  const store = await prisma.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: {
      id: true,
      projectId: true,
      shopDomain: true,
      complianceState: true,
      uninstalledAt: true,
      installationGeneration: true,
    },
  });
  if (
    !store ||
    store.projectId !== workspaceId ||
    normalizeShopDomain(store.shopDomain) !== normalizeShopDomain(shopDomain)
  ) {
    throw new Error(
      "The app-uninstalled compliance request does not match the retained Shopify store.",
    );
  }
  if (store.complianceState === "redacted") {
    throw new Error("A redacted Shopify store cannot process app uninstall.");
  }
  return store;
}

async function freezeUninstalledStore({
  workspaceId,
  storeId,
  shopDomain,
  cutoff,
  installationGeneration,
}: {
  workspaceId: string;
  storeId: string;
  shopDomain: string;
  cutoff: Date;
  installationGeneration: string;
}) {
  const freeze = await freezeShopifyStoreForUninstall({
    workspaceId,
    storeId,
    canonicalShopDomain: shopDomain,
    cutoff,
    expectedInstallationGeneration: installationGeneration,
  });
  if (freeze.complianceState !== "frozen") {
    throw new Error("A redacted Shopify store cannot process app uninstall.");
  }
}

function integrationShopDomain(credentials: Prisma.JsonValue | null) {
  if (
    !credentials ||
    typeof credentials !== "object" ||
    Array.isArray(credentials)
  ) {
    return null;
  }
  return typeof credentials.shop === "string" ? credentials.shop : null;
}

function integrationGeneration(credentials: Prisma.JsonValue | null) {
  if (
    !credentials ||
    typeof credentials !== "object" ||
    Array.isArray(credentials)
  ) {
    return null;
  }
  return typeof credentials.installationGeneration === "string"
    ? credentials.installationGeneration
    : null;
}

async function scrubUninstalledCredentials({
  workspaceId,
  storeId,
  shopDomain,
  credentialCutoff,
  installationGeneration,
}: {
  workspaceId: string;
  storeId: string;
  shopDomain: string;
  credentialCutoff: Date;
  installationGeneration: string;
}) {
  let aliases: string[];
  try {
    aliases = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          projectId: string;
          shopDomain: string;
          complianceState: string;
          uninstalledAt: Date | null;
          installationGeneration: string | null;
        }>
      >(Prisma.sql`
      SELECT id, projectId, shopDomain, complianceState, uninstalledAt, installationGeneration
      FROM WeleticShopifyStore
      WHERE id = ${storeId}
      LIMIT 1
      FOR UPDATE
    `);
      const store = rows[0];
      if (
        !store ||
        store.projectId !== workspaceId ||
        normalizeShopDomain(store.shopDomain) !==
          normalizeShopDomain(shopDomain)
      ) {
        throw new Error(
          "The app-uninstalled compliance request does not match the retained Shopify store.",
        );
      }
      if (store.complianceState !== "frozen" || !store.uninstalledAt) {
        throw new Error(
          "Cannot scrub uninstall credentials without the authoritative frozen generation.",
        );
      }
      if (store.installationGeneration !== installationGeneration) {
        throw new Error(
          "Cannot scrub credentials from a different Shopify installation generation.",
        );
      }
      if (store.uninstalledAt.getTime() > credentialCutoff.getTime()) {
        throw new Error(
          "The authenticated uninstall cutoff predates the retained frozen generation.",
        );
      }
      const [project, installations] = await Promise.all([
        tx.project.findUnique({
          where: { id: workspaceId },
          select: { shopifyStoreId: true },
        }),
        tx.installedIntegration.findMany({
          where: {
            projectId: workspaceId,
            integrationId: SHOPIFY_INTEGRATION_ID,
          },
          select: { id: true, credentials: true },
        }),
      ]);
      const generationInstallations = installations.filter(
        ({ credentials }) =>
          integrationGeneration(credentials) === installationGeneration,
      );
      if (generationInstallations.length !== installations.length) {
        throw new Error(
          "The retained Shopify credential generation is ambiguous.",
        );
      }
      const retainedAliases = normalizedAliases([
        shopDomain,
        project?.shopifyStoreId,
        ...generationInstallations.map(({ credentials }) =>
          integrationShopDomain(credentials),
        ),
      ]);
      if (retainedAliases.length === 0) {
        throw new Error(
          "Cannot scrub an app uninstall without an exact Shopify domain.",
        );
      }

      await tx.weleticShopifyAppSession.deleteMany({
        where: { shop: { in: retainedAliases } },
      });
      await tx.weleticShopifyInstallIntent.deleteMany({
        where: { workspaceId },
      });
      await tx.installedIntegration.deleteMany({
        where: {
          projectId: workspaceId,
          id: { in: generationInstallations.map(({ id }) => id) },
        },
      });
      // This Store lock and generation check also fence Shopify-native tokens.
      // Uninstall erases only this app's completed generation; retained shop
      // redaction has its separate all-generation final drain.
      const appId = process.env.SHOPIFY_API_KEY?.trim();
      if (!appId || !/^[a-z0-9_-]{1,191}$/.test(appId))
        throw new Error("Shopify credential cleanup app identity is missing.");
      await tx.weleticShopifyInstallationCredential.deleteMany({
        where: { storeId, appId, installationGeneration },
      });
      // Project.updatedAt is shared by unrelated workspace changes and cannot
      // act as an installation-generation clock. The store row lock and exact
      // frozen cutoff are the lifecycle authority for clearing this alias.
      await tx.project.updateMany({
        where: { id: workspaceId, shopifyStoreId: { in: retainedAliases } },
        data: { shopifyStoreId: null },
      });
      return retainedAliases;
    });
  } catch (error) {
    // A failed database scrub remains retryable, but an already-authenticated
    // uninstall must not leave the primary domain's credential cache warm.
    invalidateShopifyStoreDomainCache(normalizedAliases([shopDomain]));
    throw error;
  }
  invalidateShopifyStoreDomainCache(aliases);
}

/** Executes one bounded phase after durable webhook acknowledgement. */
export async function processAppUninstalledComplianceStep({
  requestId,
  workspaceId,
  storeId,
  shopDomain,
  phase,
  cursor,
  progress,
  workerId,
  receivedAt,
  installationGeneration,
}: {
  requestId: string;
  workspaceId: string;
  storeId: string;
  shopDomain: string;
  phase: string;
  cursor?: Prisma.JsonValue | null;
  progress?: Prisma.JsonValue | null;
  workerId: string;
  receivedAt: Date;
  installationGeneration: string;
}): Promise<AppUninstalledStep> {
  const currentPhase = phase as AppUninstalledPhase;
  if (currentPhase === "received") {
    await freezeUninstalledStore({
      workspaceId,
      storeId,
      shopDomain,
      cutoff: receivedAt,
      installationGeneration,
    });
    return {
      completed: false,
      phase: "enumerate_vouchers",
      cursor: Prisma.DbNull,
      progress: { frozen: true },
    };
  }
  if (
    currentPhase === "enumerate_vouchers" ||
    currentPhase === "voucher_cleanup"
  ) {
    const gate = await processStoreVoucherCleanupComplianceStep({
      requestId,
      storeId,
      shopDomain,
      source: WeleticVoucherCleanupSource.app_uninstalled,
      phase: currentPhase,
      cursor,
      progress,
      workerId,
    });
    return gate.phase === "credential_scrub"
      ? { ...gate, phase: "scrub_friend_referral_claims" }
      : gate;
  }
  if (currentPhase === "scrub_friend_referral_claims") {
    const progressObject =
      progress && typeof progress === "object" && !Array.isArray(progress)
        ? (progress as Prisma.InputJsonObject)
        : {};
    const afterId =
      cursor &&
      typeof cursor === "object" &&
      !Array.isArray(cursor) &&
      typeof cursor.lastId === "string"
        ? cursor.lastId
        : undefined;
    const result = await redactReferralFriendClaimsForShopBatch({
      storeId,
      afterId,
      batchSize: 20,
      redactedAt: receivedAt,
    });
    return {
      completed: false,
      phase: result.hasMore
        ? "scrub_friend_referral_claims"
        : "credential_scrub",
      cursor: result.hasMore
        ? ({ lastId: result.lastId } as Prisma.InputJsonObject)
        : Prisma.DbNull,
      progress: {
        ...progressObject,
        friendReferralClaimsScrubbed:
          Number(progressObject.friendReferralClaimsScrubbed ?? 0) +
          result.scrubbed,
      },
    };
  }
  if (currentPhase === "credential_scrub") {
    // Older in-flight uninstall requests may already be at credential_scrub
    // when this phase is deployed. Recheck anonymous friend vouchers before
    // deleting the only credentials capable of deactivating them.
    const friendGate = await redactReferralFriendClaimsForShopBatch({
      storeId,
      batchSize: 20,
      redactedAt: receivedAt,
    });
    const existingProgress =
      progress && typeof progress === "object" && !Array.isArray(progress)
        ? (progress as Prisma.InputJsonObject)
        : {};
    const friendProgress = {
      ...existingProgress,
      friendReferralClaimsScrubbed:
        Number(existingProgress.friendReferralClaimsScrubbed ?? 0) +
        friendGate.scrubbed,
    } as Prisma.InputJsonObject;
    if (friendGate.hasMore) {
      return {
        completed: false,
        phase: "scrub_friend_referral_claims",
        cursor: { lastId: friendGate.lastId },
        progress: friendProgress,
      };
    }
    const gate = await processStoreVoucherCleanupComplianceStep({
      requestId,
      storeId,
      shopDomain,
      source: WeleticVoucherCleanupSource.app_uninstalled,
      phase: "voucher_cleanup",
      cursor,
      progress,
      workerId,
    });
    if (gate.phase !== "credential_scrub") return gate;

    await scrubUninstalledCredentials({
      workspaceId,
      storeId,
      shopDomain,
      credentialCutoff: receivedAt,
      installationGeneration,
    });
    return {
      completed: false,
      phase: "finalize",
      cursor: Prisma.DbNull,
      progress: {
        ...((gate.progress &&
        typeof gate.progress === "object" &&
        !Array.isArray(gate.progress)
          ? gate.progress
          : {}) as Prisma.InputJsonObject),
        ...friendProgress,
      },
    };
  }
  if (currentPhase === "finalize") {
    const store = await assertUninstallStoreIdentity({
      workspaceId,
      storeId,
      shopDomain,
    });
    if (store.complianceState !== "frozen") {
      throw new Error("App uninstall cannot finalize before store freeze.");
    }
    return {
      completed: true,
      phase: "completed",
      cursor: Prisma.DbNull,
      progress: progress ?? Prisma.DbNull,
    };
  }
  if (currentPhase === "completed") {
    return {
      completed: true,
      phase: "completed",
      progress: progress ?? Prisma.DbNull,
    };
  }
  throw new Error(`Unsupported app uninstall phase: ${phase}`);
}

export async function appUninstalled({
  workspaceId,
  storeId,
  shopDomains,
}: {
  workspaceId: string;
  storeId?: string;
  shopDomains: string[];
}) {
  const aliases = normalizedAliases(shopDomains);
  if (!storeId || aliases.length === 0) {
    throw new Error(
      "Cannot process app/uninstalled without a verified store and Shopify domain.",
    );
  }
  const store = await assertUninstallStoreIdentity({
    workspaceId,
    storeId,
    shopDomain: aliases[0],
  });
  if (!store.installationGeneration) {
    throw new Error(
      "Cannot process app/uninstalled without an installation generation.",
    );
  }
  await freezeUninstalledStore({
    workspaceId,
    storeId,
    shopDomain: aliases[0],
    cutoff: new Date(),
    installationGeneration: store.installationGeneration,
  });
  return "[Shopify] App Uninstalled received; durable cleanup scheduled.";
}
