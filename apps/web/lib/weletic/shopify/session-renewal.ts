import { prisma } from "@/lib/prisma";
import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import type { ShopifySessionObservation } from "./session-contract";
import { ShopifySessionCoordinationError } from "./session-coordination";
import { SHOPIFY_SESSION_MISSING_ISSUE_KIND } from "./session-health-contract";
import {
  lockShopifySessionLifecycle,
  SessionCredentialWriteBlockedError,
} from "./session-lifecycle-fence";
import {
  assertShopifySessionObservation,
  configuredShopifySessionScope,
  readShopifySessionSnapshot,
} from "./session-snapshot";
import {
  fetchShopifyTokenAuthorityCredential,
  ShopifyTokenAuthorityError,
} from "./token-authority";

export const SHOPIFY_RENEWAL_PAGE_SIZE = 100;
// Inside the installed Remix SDK's five-minute automatic refresh threshold.
export const SHOPIFY_RENEWAL_LEAD_MS = 4 * 60_000;
const MAX_JOB_AGE_MS = 15 * 60_000;
const generation = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const shopifyRenewalJobSchema = z
  .object({
    storeId: z.string().min(1).max(100),
    installationGeneration: generation,
    appId: z.string().min(1).max(191),
    scheduledAt: z.iso.datetime(),
  })
  .strict();
export type ShopifyRenewalJob = z.infer<typeof shopifyRenewalJobSchema>;
export const shopifyRenewalSweepSchema = z
  .object({
    afterId: z.string().min(1).max(100).optional(),
    scheduledAt: z.iso.datetime(),
    appId: z.string().min(1).max(191),
  })
  .strict();

export function shopifySessionRenewalEnabled() {
  if (process.env.WELETIC_SHOPIFY_RENEWAL_ENABLED !== "1") return false;
  if (
    process.env.VERCEL !== "1" &&
    process.env.WELETIC_ENFORCE_CRON_AUTH !== "1"
  )
    throw new Error("Shopify renewal requires authenticated worker operation");
  return true;
}

function currentEnvelope(
  input: { appId: string; scheduledAt: string },
  now: Date,
) {
  const age = now.getTime() - Date.parse(input.scheduledAt);
  return (
    input.appId === process.env.SHOPIFY_API_KEY?.trim() &&
    age >= -60_000 &&
    age <= MAX_JOB_AGE_MS
  );
}

/** Stable store-key pages advance independently of individual renewal failures.
 * No session payload or credential is placed on the queue.
 */
export async function listDueShopifySessionRenewals(
  input: z.infer<typeof shopifyRenewalSweepSchema>,
  now = new Date(),
) {
  const parsed = shopifyRenewalSweepSchema.parse(input);
  if (!shopifySessionRenewalEnabled() || !currentEnvelope(parsed, now))
    return {
      jobs: [] as ShopifyRenewalJob[],
      nextCursor: null as string | null,
    };
  const stores = await prisma.weleticShopifyStore.findMany({
    where: {
      complianceState: "active",
      installationGeneration: { not: null },
      ...(parsed.afterId ? { id: { gt: parsed.afterId } } : {}),
    },
    select: { id: true, shopDomain: true, installationGeneration: true },
    orderBy: { id: "asc" },
    take: SHOPIFY_RENEWAL_PAGE_SIZE,
  });
  const sessions = stores.length
    ? await prisma.weleticShopifyAppSession.findMany({
        where: {
          id: { in: stores.map((store) => `offline_${store.shopDomain}`) },
          isOnline: false,
        },
        select: { id: true, shop: true, expiresAt: true },
      })
    : [];
  const byId = new Map(sessions.map((session) => [session.id, session]));
  // An interactive SDK operation may repair a missing session without changing
  // its installation generation. Reconcile the outstanding alert on the next
  // sweep, not hours later when the newly issued credential becomes due.
  const incidents = stores.length
    ? await prisma.weleticReconciliationIssue.findMany({
        where: {
          kind: SHOPIFY_SESSION_MISSING_ISSUE_KIND,
          status: "open",
          OR: stores.map((store) => ({
            storeId: store.id,
            externalKey: store.installationGeneration ?? "",
          })),
        },
        select: { storeId: true },
      })
    : [];
  const needsReconciliation = new Set(incidents.map((issue) => issue.storeId));
  const dueAt = Date.parse(parsed.scheduledAt) + SHOPIFY_RENEWAL_LEAD_MS;
  const jobs: ShopifyRenewalJob[] = [];
  for (const store of stores) {
    if (
      !generation.safeParse(store.installationGeneration).success ||
      !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store.shopDomain)
    )
      continue;
    const session = byId.get(`offline_${store.shopDomain}`);
    if (
      session &&
      (session.shop !== store.shopDomain ||
        (!needsReconciliation.has(store.id) &&
          (session.expiresAt === null || session.expiresAt.getTime() > dueAt)))
    )
      continue;
    jobs.push({
      storeId: store.id,
      installationGeneration: store.installationGeneration!,
      appId: parsed.appId,
      scheduledAt: parsed.scheduledAt,
    });
  }
  return {
    jobs,
    nextCursor:
      stores.length === SHOPIFY_RENEWAL_PAGE_SIZE
        ? stores[stores.length - 1].id
        : null,
  };
}

/** A queued job cannot adopt a new installation, even before reaching the SDK. */
export async function renewInstalledShopifySession(input: ShopifyRenewalJob) {
  const parsed = shopifyRenewalJobSchema.parse(input);
  if (!shopifySessionRenewalEnabled()) return { status: "disabled" as const };
  if (!currentEnvelope(parsed, new Date())) return { status: "stale" as const };
  try {
    const target = await prisma.$transaction(async (tx) => {
      const candidate = await tx.weleticShopifyStore.findUnique({
        where: { id: parsed.storeId },
        select: { shopDomain: true },
      });
      if (!candidate) return null;
      const store = await lockShopifySessionLifecycle({
        tx,
        shop: candidate.shopDomain,
        storeId: parsed.storeId,
      });
      if (
        !store ||
        store.installationGeneration !== parsed.installationGeneration
      )
        return null;
      const snapshot = await readShopifySessionSnapshot(
        tx,
        configuredShopifySessionScope(store.shopDomain),
        store,
      );
      if (!snapshot.observed.credentialTokenHash) return null;
      return { shop: store.shopDomain, observed: snapshot.observed };
    });
    if (!target) return { status: "stale" as const };
    let credential;
    try {
      credential = await fetchShopifyTokenAuthorityCredential({
        shopDomain: target.shop,
        installationGeneration: parsed.installationGeneration,
      });
    } catch (error) {
      if (
        !(error instanceof ShopifyTokenAuthorityError) ||
        error.code !== "AUTH_EXPIRED"
      )
        throw error;
      const recorded = await reconcileRenewalIncident(parsed, target, {
        kind: "missing",
      });
      return {
        status: recorded ? ("reconnect_required" as const) : ("stale" as const),
      };
    }
    const reconciled = await reconcileRenewalIncident(parsed, target, {
      kind: "healthy",
      tokenHash: createHash("sha256")
        .update(credential.accessToken)
        .digest("hex"),
      expiresAt: credential.expiresAt,
    });
    if (!reconciled) return { status: "stale" as const };
    // Access tokens are neither returned to the queue executor nor logged.
    return {
      status: "healthy" as const,
      expiresAt: credential.expiresAt?.toISOString() ?? null,
    };
  } catch (error) {
    if (
      error instanceof SessionCredentialWriteBlockedError ||
      error instanceof ShopifySessionCoordinationError
    )
      return { status: "stale" as const };
    // The executor may retry; never leak provider, SQL, or secret-bearing text.
    throw new Error("Shopify session renewal temporarily unavailable");
  }
}

/** Result arrival order is not installation order. Recheck authoritative state
 * under the same store/coordinator locks as publication before changing alerts.
 * Neither the observation nor token hashes are persisted in incident details.
 */
async function reconcileRenewalIncident(
  input: ShopifyRenewalJob,
  target: { shop: string; observed: ShopifySessionObservation },
  result:
    | { kind: "missing" }
    | { kind: "healthy"; tokenHash: string; expiresAt: Date | null },
) {
  return prisma.$transaction(async (tx) => {
    const store = await lockShopifySessionLifecycle({
      tx,
      shop: target.shop,
      storeId: input.storeId,
    });
    if (!store || store.installationGeneration !== input.installationGeneration)
      return false;
    const current = await readShopifySessionSnapshot(
      tx,
      configuredShopifySessionScope(target.shop),
      store,
    );
    const identity = {
      storeId: store.id,
      kind: SHOPIFY_SESSION_MISSING_ISSUE_KIND,
      externalKey: input.installationGeneration,
    };
    if (result.kind === "missing") {
      assertShopifySessionObservation(current.observed, target.observed);
      if (current.properties !== null) return false;
      await tx.weleticReconciliationIssue.upsert({
        where: { storeId_kind_externalKey: identity },
        create: {
          id: randomUUID(),
          ...identity,
          severity: "warning",
          status: "open",
          details: { reason: "session_missing", appId: input.appId },
        },
        // Keep first detection time stable across repeated sweep deliveries.
        update: { status: "open", resolvedAt: null },
      });
      return true;
    }
    const accessToken = current.properties?.find(
      ([key]) => key === "accessToken",
    )?.[1];
    if (
      typeof accessToken !== "string" ||
      !accessToken ||
      current.observed.credentialTokenHash !== result.tokenHash ||
      createHash("sha256").update(accessToken).digest("hex") !==
        result.tokenHash ||
      (result.expiresAt !== null && result.expiresAt.getTime() <= Date.now())
    )
      return false;
    await tx.weleticReconciliationIssue.updateMany({
      where: { ...identity, status: "open" },
      data: { status: "resolved", resolvedAt: new Date() },
    });
    return true;
  });
}
