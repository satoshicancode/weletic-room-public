import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { readPendingInstallation } from "./installation-admission";
import { revokeShopifySessionCoordination } from "./session-coordination";
import { lockShopifySessionLifecycle } from "./session-lifecycle-fence";
import {
  assertShopifySessionObservation,
  configuredShopifySessionScope,
  readShopifySessionSnapshot,
} from "./session-snapshot";
import { fetchVerifiedShopifyShopDetails } from "./store-resolver";

const operatorText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\u0000-\u001f\u007f]+$/);

export const companyStoreBootstrapInputSchema = z
  .object({
    appId: z.string().regex(/^[a-z0-9_-]{1,191}$/),
    shop: z
      .string()
      .max(255)
      .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    pendingInstallationId: z.string().min(1).max(64),
    expectedInstallationGeneration: z.string().min(1).max(64),
    expectedRevision: z.number().int().positive().max(2147483646),
    operator: operatorText(191),
    reason: operatorText(400),
    apply: z.boolean().default(false),
    expectedPreview: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict()
  .refine((value) => !value.apply || Boolean(value.expectedPreview), {
    message: "Apply requires the reviewed preview digest",
  });

type BootstrapInput = z.infer<typeof companyStoreBootstrapInputSchema>;
const fail = () =>
  new Error("Company-store bootstrap identity or revision changed");
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Trusted operator only. No merchant route imports this module. Locks follow
 * publication: absent/existing store + privacy -> coordinator -> admission -> SDK.
 * No network request or SDK refresh occurs while these locks are held. */
async function capture(tx: Prisma.TransactionClient, input: BootstrapInput) {
  const scope = configuredShopifySessionScope(input.shop);
  if (scope.appId !== input.appId) throw fail();
  const store = await lockShopifySessionLifecycle({
    tx,
    shop: input.shop,
    storeId: null,
  });
  if (store) throw fail();
  const snapshot = await readShopifySessionSnapshot(tx, scope, undefined);
  const pending = await readPendingInstallation(tx, scope);
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>(
    Prisma.sql`SELECT CURRENT_TIMESTAMP(3) AS now`,
  );
  if (
    !pending ||
    pending.id !== input.pendingInstallationId ||
    pending.appId !== input.appId ||
    pending.state !== "pending_approval" ||
    pending.mappedStoreId !== null ||
    pending.installationGeneration !== input.expectedInstallationGeneration ||
    pending.revision !== input.expectedRevision ||
    !pending.authenticatedAt ||
    pending.uninstalledAt ||
    pending.redactedAt ||
    (pending.expiresAt && pending.expiresAt <= clock.now)
  )
    throw fail();
  const [session] = await tx.$queryRaw<Array<{ expiresAt: Date | null }>>(
    Prisma.sql`SELECT expiresAt FROM WeleticShopifyAppSession
      WHERE id = ${`offline_${input.shop}`} FOR UPDATE`,
  );
  const properties = Object.fromEntries(snapshot.properties ?? []);
  if (
    !session ||
    (session.expiresAt && session.expiresAt <= clock.now) ||
    properties.id !== `offline_${input.shop}` ||
    properties.shop !== input.shop ||
    properties.isOnline !== false ||
    typeof properties.accessToken !== "string" ||
    !properties.accessToken.trim() ||
    snapshot.observed.installationGeneration !==
      input.expectedInstallationGeneration ||
    BigInt(snapshot.observed.epoch) <= BigInt(0)
  )
    throw fail();
  return {
    observed: snapshot.observed,
    accessToken: properties.accessToken,
    now: clock.now,
  };
}

function preview(input: BootstrapInput, shopCurrency: string) {
  const key = digest([
    input.appId,
    input.pendingInstallationId,
    input.expectedInstallationGeneration,
  ]);
  const records = {
    workspaceId: `ws_${key.slice(0, 32)}`,
    programId: `prog_${key.slice(0, 32)}`,
    folderId: `fold_${key.slice(0, 32)}`,
    groupId: `grp_${key.slice(0, 32)}`,
    storeId: `wstore_${key.slice(0, 32)}`,
    slug: `weletic-store-${key.slice(0, 32)}`,
    name: `Weletic ${input.shop.split(".")[0]}`,
  };
  const plan = {
    appId: input.appId,
    shop: input.shop,
    pendingInstallationId: input.pendingInstallationId,
    installationGeneration: input.expectedInstallationGeneration,
    revision: input.expectedRevision,
    shopCurrency,
    operator: input.operator,
    reason: input.reason,
    records,
    storeAccessState: "pending_approval" as const,
    loyaltyActivated: false as const,
    createsUser: false as const,
  };
  return { ...plan, previewDigest: digest(plan) };
}

/** Local CLI boundary. A preview is not authorization to send or activate.
 * Apply obtains new Shopify evidence and matches the reviewed plan; evidence
 * never comes from caller JSON and cannot be replayed across process calls. */
export async function bootstrapCompanyStore(
  value: unknown,
  customFetch: typeof fetch = fetch,
) {
  const input = companyStoreBootstrapInputSchema.parse(value);
  const first = await prisma.$transaction((tx) => capture(tx, input));
  const details = await fetchVerifiedShopifyShopDetails({
    shopDomain: input.shop,
    accessToken: first.accessToken,
    customFetch: (url, init) =>
      customFetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }),
  });
  if (!details) throw fail();
  const plan = preview(input, details.shopCurrency);
  if (input.apply && input.expectedPreview !== plan.previewDigest) throw fail();
  return prisma.$transaction(async (tx) => {
    const current = await capture(tx, input);
    assertShopifySessionObservation(current.observed, first.observed);
    if (
      current.observed.epoch !== first.observed.epoch ||
      current.now.getTime() < first.now.getTime() ||
      current.now.getTime() - first.now.getTime() > 60_000
    )
      throw fail();
    const r = plan.records;
    // Never adopt existing records, including orphaned deterministic IDs.
    const conflicts = await Promise.all([
      tx.project.count({
        where: {
          OR: [
            { id: r.workspaceId },
            { slug: r.slug },
            { shopifyStoreId: input.shop },
          ],
        },
      }),
      tx.program.count({
        where: {
          OR: [
            { id: r.programId },
            { slug: r.slug },
            { workspaceId: r.workspaceId },
          ],
        },
      }),
      tx.folder.count({
        where: { OR: [{ id: r.folderId }, { projectId: r.workspaceId }] },
      }),
      tx.partnerGroup.count({
        where: { OR: [{ id: r.groupId }, { programId: r.programId }] },
      }),
      // relationMode=prisma permits orphan references in SQL. Never turn
      // retained membership/integration/token records into new authority.
      tx.projectUsers.count({ where: { projectId: r.workspaceId } }),
      tx.projectInvite.count({ where: { projectId: r.workspaceId } }),
      tx.installedIntegration.count({ where: { projectId: r.workspaceId } }),
      tx.restrictedToken.count({ where: { projectId: r.workspaceId } }),
      tx.oAuthCode.count({ where: { projectId: r.workspaceId } }),
      tx.weleticShopifyStore.count({
        where: {
          OR: [
            { id: r.storeId },
            { projectId: r.workspaceId },
            { programId: r.programId },
          ],
        },
      }),
    ]);
    if (conflicts.some(Boolean)) throw fail();
    if (!input.apply) return { ...plan, applied: false };

    // Direct minimal records only: no generic onboarding, invites or billing.
    await tx.project.create({
      data: {
        id: r.workspaceId,
        name: r.name,
        slug: r.slug,
        shopifyStoreId: input.shop,
        defaultProgramId: r.programId,
        billingCycleStart: 1,
        plan: "free",
        defaultProduct: "program",
      },
    });
    await tx.folder.create({
      data: {
        id: r.folderId,
        projectId: r.workspaceId,
        name: "Internal program records",
      },
    });
    await tx.program.create({
      data: {
        id: r.programId,
        workspaceId: r.workspaceId,
        name: r.name,
        slug: r.slug,
        defaultFolderId: r.folderId,
        defaultGroupId: r.groupId,
        accountingCurrency: plan.shopCurrency,
        payoutMode: "external",
      },
    });
    await tx.partnerGroup.create({
      data: {
        id: r.groupId,
        programId: r.programId,
        name: "Internal default",
        slug: "default",
      },
    });
    await tx.weleticShopifyStore.create({
      data: {
        id: r.storeId,
        projectId: r.workspaceId,
        programId: r.programId,
        shopDomain: input.shop,
        shopCurrency: plan.shopCurrency,
        currencyVerifiedAt: first.now,
        apiVersion: "2026-07",
        installationGeneration: input.expectedInstallationGeneration,
        storeAccessState: "pending_approval",
        storeAccessRevision: 1,
      },
    });
    const revision = input.expectedRevision + 1;
    const changed = await tx.$executeRaw(Prisma.sql`
      UPDATE WeleticShopifyPendingInstallation
      SET mappedStoreId = ${r.storeId}, state = 'mapped', revision = ${revision}, updatedAt = CURRENT_TIMESTAMP(3)
      WHERE id = ${input.pendingInstallationId} AND appId = ${input.appId}
        AND installationGeneration = ${input.expectedInstallationGeneration}
        AND revision = ${input.expectedRevision} AND state = 'pending_approval'
        AND mappedStoreId IS NULL
    `);
    if (changed !== 1) throw fail();
    await tx.weleticShopifyPendingInstallationChange.create({
      data: {
        id: randomUUID(),
        pendingInstallationId: input.pendingInstallationId,
        mappedStoreId: r.storeId,
        installationGeneration: input.expectedInstallationGeneration,
        revision,
        operation: "bootstrap",
        operator: input.operator,
        reason: `${plan.previewDigest}: ${input.reason}`,
      },
    });
    // Mapping changes credential authority even though the pending generation
    // is retained. A pre-mapping SDK exchange must not publish afterward.
    await revokeShopifySessionCoordination(tx, {
      appId: input.appId,
      shop: input.shop,
    });
    return { ...plan, revision, applied: true };
  });
}
