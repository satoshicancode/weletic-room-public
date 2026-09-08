import { qstash } from "@/lib/cron";
import { encrypt } from "@/lib/encryption";
import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { publishLoyaltyEarnPolicyRevision } from "@/lib/weletic/loyalty/earn-policy-revision";
import {
  createAllShopifyWebhookBodyDigests,
  deriveShopifyCustomerPrivacyIdentity,
  VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN,
} from "@/lib/weletic/shopify/privacy-identity";
import { canonicalizeShopifyDomain } from "@/lib/weletic/shopify/store-resolver";
import { APP_DOMAIN_WITH_NGROK } from "@dub/utils";
import { Prisma } from "@prisma/client";
import { dispatchDurableShopifyComplianceRequest } from "./compliance-dispatch";
import {
  complianceRequestTypeForTopic,
  DurableComplianceSubject,
  parseShopifyComplianceSubject,
  ShopifyDurableComplianceTopic,
} from "./compliance-types";

export const SHOPIFY_COMPLIANCE_WORKER_PATH =
  "/api/cron/weletic/shopify/compliance";

export interface PersistedShopifyComplianceRequest {
  requestId: string;
  created: boolean;
  status: string;
  receivedAt: Date;
  triggeredAt: Date | null;
  installationGeneration: string | null;
}

type LockedShopifyStoreLifecycle = {
  id: string;
  projectId: string;
  shopDomain: string;
  complianceState: "active" | "frozen" | "redacted";
  uninstalledAt: Date | null;
  installationGeneration: string | null;
};

type UninstallFreezeResult = {
  complianceState: "frozen" | "redacted" | "stale_reinstall";
  cutoff: Date;
};

type LockedLoyaltyProgram = {
  id: string;
  disabledAt: Date | null;
};

function earlierDate(left: Date | null, right: Date) {
  return left && left.getTime() <= right.getTime() ? left : right;
}

/**
 * Linearizes an uninstall freeze against store reactivation/shop erasure and
 * keeps the earliest authenticated uninstall cutoff. Authority created after
 * that cutoff belongs to a later reinstall generation and must never be
 * deleted by this request.
 */
export async function freezeShopifyStoreForUninstall({
  storeId,
  canonicalShopDomain,
  cutoff,
  expectedInstallationGeneration,
  workspaceId,
}: {
  storeId: string;
  canonicalShopDomain: string;
  cutoff: Date;
  expectedInstallationGeneration: string | null;
  workspaceId?: string;
}): Promise<UninstallFreezeResult> {
  if (!Number.isFinite(cutoff.getTime())) {
    throw new Error("A valid Shopify uninstall lifecycle cutoff is required.");
  }
  const normalizedShopDomain = canonicalizeShopifyDomain(canonicalShopDomain);
  if (!normalizedShopDomain) {
    throw new Error("A valid Shopify uninstall shop domain is required.");
  }

  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedShopifyStoreLifecycle[]>(Prisma.sql`
      SELECT id, projectId, shopDomain, complianceState, uninstalledAt, installationGeneration
      FROM WeleticShopifyStore
      WHERE id = ${storeId}
      LIMIT 1
      FOR UPDATE
    `);
    const store = rows[0];
    if (!store) {
      throw new Error("The retained Shopify store is unavailable.");
    }
    if (store.complianceState === "redacted") {
      return { complianceState: "redacted", cutoff };
    }
    if (
      (workspaceId && store.projectId !== workspaceId) ||
      canonicalizeShopifyDomain(store.shopDomain) !== normalizedShopDomain
    ) {
      throw new Error(
        "The uninstall lifecycle does not match the retained Shopify store.",
      );
    }
    if (
      !expectedInstallationGeneration ||
      store.installationGeneration !== expectedInstallationGeneration
    ) {
      return { complianceState: "stale_reinstall", cutoff };
    }

    const transitionsToFrozen = store.complianceState === "active";
    const effectiveCutoff = earlierDate(store.uninstalledAt, cutoff);
    const programs = await tx.$queryRaw<LockedLoyaltyProgram[]>(Prisma.sql`
      SELECT id, disabledAt
      FROM WeleticLoyaltyProgram
      WHERE storeId = ${store.id}
      LIMIT 1
      FOR UPDATE
    `);
    const effectiveDisabledAt = earlierDate(
      programs[0]?.disabledAt ?? null,
      effectiveCutoff,
    );
    await tx.weleticShopifyStore.update({
      where: { id: store.id },
      data: {
        complianceState: "frozen",
        uninstalledAt: effectiveCutoff,
        syncStatus: "failed",
        lastSyncError:
          "Shopify app uninstalled; loyalty writes are frozen pending voucher cleanup.",
      },
    });
    const disabledPrograms = await tx.weleticLoyaltyProgram.updateMany({
      where: { storeId: store.id },
      data: {
        status: "disabled",
        killSwitchActive: true,
        disabledAt: effectiveDisabledAt,
      },
    });
    if (transitionsToFrozen && programs[0] && disabledPrograms.count === 1) {
      // The durable lifecycle cutoff is historical evidence; the policy
      // revision represents this transaction and must not backdate over a head.
      await publishLoyaltyEarnPolicyRevision({
        tx,
        storeId: store.id,
        programId: programs[0].id,
        reason: "shopify_uninstall_frozen",
      });
    }
    return { complianceState: "frozen", cutoff: effectiveCutoff };
  });
}

export async function freezeShopifyStoreForShopRedact({
  storeId,
  canonicalShopDomain,
  frozenAt,
}: {
  storeId: string;
  canonicalShopDomain: string;
  frozenAt: Date;
}) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedShopifyStoreLifecycle[]>(Prisma.sql`
      SELECT id, projectId, shopDomain, complianceState, uninstalledAt, installationGeneration
      FROM WeleticShopifyStore
      WHERE id = ${storeId}
      LIMIT 1
      FOR UPDATE
    `);
    const store = rows[0];
    if (!store) throw new Error("The retained Shopify store is unavailable.");
    if (store.complianceState === "redacted") return "redacted" as const;
    if (
      canonicalizeShopifyDomain(store.shopDomain) !==
      canonicalizeShopifyDomain(canonicalShopDomain)
    ) {
      throw new Error(
        "The shop-redact lifecycle does not match the retained Shopify store.",
      );
    }
    const transitionsToFrozen = store.complianceState === "active";
    const programs = await tx.$queryRaw<LockedLoyaltyProgram[]>(Prisma.sql`
      SELECT id, disabledAt
      FROM WeleticLoyaltyProgram
      WHERE storeId = ${store.id}
      LIMIT 1
      FOR UPDATE
    `);
    const effectiveDisabledAt = earlierDate(
      programs[0]?.disabledAt ?? null,
      frozenAt,
    );
    await tx.weleticShopifyStore.update({
      where: { id: store.id },
      data: {
        complianceState: "frozen",
        syncStatus: "failed",
        lastSyncError:
          "Shopify shop redaction is in progress; operational writes are frozen.",
      },
    });
    const disabledPrograms = await tx.weleticLoyaltyProgram.updateMany({
      where: { storeId: store.id },
      data: {
        status: "disabled",
        killSwitchActive: true,
        disabledAt: effectiveDisabledAt,
      },
    });
    if (transitionsToFrozen && programs[0] && disabledPrograms.count === 1) {
      // The durable lifecycle cutoff is historical evidence; the policy
      // revision represents this transaction and must not backdate over a head.
      await publishLoyaltyEarnPolicyRevision({
        tx,
        storeId: store.id,
        programId: programs[0].id,
        reason: "shopify_shop_redact_frozen",
      });
    }
    return "frozen" as const;
  });
}

function subjectDigest({
  storeId,
  subject,
}: {
  storeId: string;
  subject: DurableComplianceSubject;
}) {
  const identityKind = subject.customerId
    ? ("customer_id" as const)
    : subject.customerEmail
      ? ("customer_email" as const)
      : null;
  const identity = subject.customerId ?? subject.customerEmail;
  if (!identityKind || !identity) return null;
  return deriveShopifyCustomerPrivacyIdentity({
    storeId,
    identityKind,
    identity,
  });
}

export async function enqueueShopifyComplianceWorker(
  requestId: string,
  { delaySeconds = 0 }: { delaySeconds?: number } = {},
) {
  try {
    await qstash.publishJSON({
      url: `${APP_DOMAIN_WITH_NGROK}${SHOPIFY_COMPLIANCE_WORKER_PATH}`,
      body: { requestId },
      retries: 3,
      ...(delaySeconds > 0
        ? { notBefore: Math.floor(Date.now() / 1000) + delaySeconds }
        : {}),
    });
    return true;
  } catch (error) {
    // The request is already durable. A duplicate delivery or the periodic
    // worker sweep can safely enqueue it again, so queue transport failure must
    // not turn a persisted Shopify webhook into data loss.
    console.error("[Shopify compliance] Failed to enqueue durable request", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function persistShopifyComplianceRequest({
  storeId,
  canonicalShopDomain,
  storageShopDomain = canonicalShopDomain,
  alreadyRedacted = false,
  triggeredAt,
  webhookId,
  authenticatedBodyDigests,
  topic,
  payload,
}: {
  storeId: string;
  canonicalShopDomain: string;
  storageShopDomain?: string;
  alreadyRedacted?: boolean;
  triggeredAt?: Date | null;
  webhookId: string;
  authenticatedBodyDigests: readonly string[];
  topic: ShopifyDurableComplianceTopic;
  payload: unknown;
}): Promise<PersistedShopifyComplianceRequest> {
  const normalizedWebhookId = webhookId.trim();
  if (!normalizedWebhookId || normalizedWebhookId.length > 255) {
    throw new Error("A valid x-shopify-webhook-id header is required.");
  }
  const uniqueBodyDigests = [...new Set(authenticatedBodyDigests)];
  if (
    uniqueBodyDigests.length === 0 ||
    uniqueBodyDigests.some(
      (digest) => !VERSIONED_SHOPIFY_PRIVACY_DIGEST_PATTERN.test(digest),
    )
  ) {
    throw new Error(
      "A valid rotation-aware authenticated Shopify body digest is required.",
    );
  }
  const authenticatedBodyDigest = uniqueBodyDigests[0];

  const parsedSubject = parseShopifyComplianceSubject({ topic, payload });
  const signedShopDomain = canonicalizeShopifyDomain(parsedSubject.shopDomain);
  if (signedShopDomain !== canonicalShopDomain) {
    throw new Error(
      "The signed Shopify payload domain does not match the canonical webhook domain.",
    );
  }
  const subject = { ...parsedSubject, shopDomain: canonicalShopDomain };
  const requestId = createWeleticId("wcomp_");
  return prisma.$transaction(async (tx) => {
    const stores = await tx.$queryRaw<LockedShopifyStoreLifecycle[]>(Prisma.sql`
      SELECT id, projectId, shopDomain, complianceState, uninstalledAt, installationGeneration
      FROM WeleticShopifyStore
      WHERE id = ${storeId}
      LIMIT 1
      FOR UPDATE
    `);
    const store = stores[0];
    if (!store) {
      throw new Error("The retained Shopify store is unavailable.");
    }
    const lockedDomain = canonicalizeShopifyDomain(store.shopDomain);
    const isRedacted = store.complianceState === "redacted";
    if (
      (!isRedacted && lockedDomain !== canonicalShopDomain) ||
      (alreadyRedacted && !isRedacted) ||
      (!isRedacted && storageShopDomain !== store.shopDomain)
    ) {
      throw new Error(
        "The compliance request does not match the locked Shopify store lifecycle.",
      );
    }
    // The locked store row is the only storage-domain authority. If erasure
    // finalized after token-free resolution but before this insert, force a
    // terminal privacy-safe row using the persisted pseudonym. Conversely, a
    // successful pending insert holds the lock until commit, so finalization's
    // subsequent request scrub necessarily includes it.
    if (
      topic === "app/uninstalled" &&
      !isRedacted &&
      !store.installationGeneration
    ) {
      throw new Error(
        "The Shopify installation generation is unavailable for uninstall persistence.",
      );
    }
    const durableSubject =
      topic === "app/uninstalled"
        ? {
            ...subject,
            installationGeneration: store.installationGeneration ?? undefined,
          }
        : subject;
    const identity = isRedacted
      ? null
      : subjectDigest({ storeId, subject: durableSubject });
    const persisted = await tx.weleticShopifyComplianceRequest.upsert({
      where: { webhookId: normalizedWebhookId },
      create: {
        id: requestId,
        storeId,
        webhookId: normalizedWebhookId,
        shopDomain: store.shopDomain,
        requestType: complianceRequestTypeForTopic[topic],
        authenticatedBodyDigest,
        status: isRedacted ? "completed" : "pending",
        phase: isRedacted ? "already_redacted" : "received",
        subjectKind: isRedacted ? null : identity?.identityKind ?? null,
        subjectKeyId: isRedacted ? null : identity?.identityKeyId ?? null,
        subjectDigest: isRedacted ? null : identity?.customerDigest ?? null,
        payloadCiphertext: isRedacted
          ? null
          : encrypt(JSON.stringify(durableSubject)),
        triggeredAt: triggeredAt ?? null,
        attempts: 0,
        maxAttempts: 10,
        completedAt: isRedacted ? new Date() : null,
      },
      update: {},
      select: {
        id: true,
        storeId: true,
        requestType: true,
        authenticatedBodyDigest: true,
        shopDomain: true,
        status: true,
        receivedAt: true,
        triggeredAt: true,
      },
    });
    if (persisted.id === requestId) {
      return {
        requestId: persisted.id,
        created: true,
        status: persisted.status,
        receivedAt: persisted.receivedAt,
        triggeredAt: persisted.triggeredAt,
        installationGeneration: store.installationGeneration,
      };
    }
    if (
      persisted.storeId !== storeId ||
      persisted.requestType !== complianceRequestTypeForTopic[topic] ||
      !persisted.authenticatedBodyDigest ||
      !uniqueBodyDigests.includes(persisted.authenticatedBodyDigest) ||
      persisted.shopDomain !== store.shopDomain ||
      (persisted.triggeredAt?.getTime() ?? null) !==
        (triggeredAt?.getTime() ?? null)
    ) {
      throw new Error(
        "The Shopify webhook identifier belongs to another tenant, topic, or shop domain.",
      );
    }
    return {
      requestId: persisted.id,
      created: false,
      status: persisted.status,
      receivedAt: persisted.receivedAt,
      triggeredAt: persisted.triggeredAt,
      installationGeneration: store.installationGeneration,
    };
  });
}

export async function persistAndQueueShopifyComplianceRequest(
  input: Parameters<typeof persistShopifyComplianceRequest>[0],
) {
  let result = await persistShopifyComplianceRequest(input);
  if (result.status !== "completed" && input.topic === "app/uninstalled") {
    const freeze = await freezeShopifyStoreForUninstall({
      storeId: input.storeId,
      canonicalShopDomain: input.canonicalShopDomain,
      cutoff: result.triggeredAt ?? result.receivedAt,
      expectedInstallationGeneration: result.installationGeneration,
    });
    if (freeze.complianceState === "stale_reinstall") {
      const completedAt = new Date();
      await prisma.weleticShopifyComplianceRequest.updateMany({
        where: {
          id: result.requestId,
          storeId: input.storeId,
          status: { in: ["pending", "retrying"] },
        },
        data: {
          status: "completed",
          phase: "stale_after_reinstall",
          payloadCiphertext: null,
          subjectKind: null,
          subjectKeyId: null,
          subjectDigest: null,
          completedAt,
          nextRetryAt: null,
          lastError: null,
        },
      });
      result = { ...result, status: "completed" };
    }
  }
  if (result.status !== "completed" && input.topic === "shop/redact") {
    await freezeShopifyStoreForShopRedact({
      storeId: input.storeId,
      canonicalShopDomain: input.canonicalShopDomain,
      frozenAt: result.receivedAt,
    });
  }
  if (result.status !== "completed") {
    await dispatchDurableShopifyComplianceRequest({
      requestId: result.requestId,
      dispatch: () => enqueueShopifyComplianceWorker(result.requestId),
      failurePolicy: "make-immediately-due",
    });
  }
  return result;
}

/**
 * Workspace-authenticated manual disconnects enter the same durable uninstall
 * lifecycle as Shopify's signed webhook. The installation lifecycle key must
 * change after a reinstall so a later disconnect cannot coalesce with an old,
 * completed request.
 */
export async function persistAndQueueInternalShopifyDisconnect({
  storeId,
  canonicalShopDomain,
  idempotencyKey,
}: {
  storeId: string;
  canonicalShopDomain: string;
  idempotencyKey: string;
}) {
  const normalizedKey = idempotencyKey.trim();
  if (!normalizedKey || normalizedKey.length > 180) {
    throw new Error("A bounded installation lifecycle key is required.");
  }
  const retainedStore = await prisma.weleticShopifyStore.findUnique({
    where: { id: storeId },
    select: {
      shopDomain: true,
      complianceState: true,
    },
  });
  if (
    !retainedStore ||
    retainedStore.complianceState === "redacted" ||
    canonicalizeShopifyDomain(retainedStore.shopDomain) !==
      canonicalizeShopifyDomain(canonicalShopDomain)
  ) {
    throw new Error(
      "Manual disconnect does not match an active retained Shopify store.",
    );
  }
  const result = await persistShopifyComplianceRequest({
    storeId,
    canonicalShopDomain,
    webhookId: `internal-disconnect:${normalizedKey}`,
    authenticatedBodyDigests: createAllShopifyWebhookBodyDigests({
      topic: "app/uninstalled",
      rawBodyBytes: new TextEncoder().encode(
        JSON.stringify({ myshopify_domain: canonicalShopDomain }),
      ),
    }),
    topic: "app/uninstalled",
    payload: { myshopify_domain: canonicalShopDomain },
  });

  if (result.status === "completed") return result;

  // Freeze immediately before the authenticated route acknowledges the manual
  // disconnect. The row lock makes a concurrent shop-redact visible instead of
  // returning a false "frozen" response after a no-op conditional update.
  const freeze = await freezeShopifyStoreForUninstall({
    storeId,
    canonicalShopDomain,
    cutoff: result.receivedAt,
    expectedInstallationGeneration: result.installationGeneration,
  });
  if (freeze.complianceState !== "frozen") {
    throw new Error(
      "The Shopify store was redacted while the disconnect was being persisted.",
    );
  }
  if (result.status !== "completed") {
    await dispatchDurableShopifyComplianceRequest({
      requestId: result.requestId,
      dispatch: () => enqueueShopifyComplianceWorker(result.requestId),
      failurePolicy: "make-immediately-due",
    });
  }
  return result;
}
