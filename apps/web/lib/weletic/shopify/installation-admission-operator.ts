import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import * as z from "zod/v4";
import { readPendingInstallation } from "./installation-admission";
import { observeShopifySessionCoordination } from "./session-coordination";
import { lockShopifySessionLifecycle } from "./session-lifecycle-fence";
import { configuredShopifySessionScope } from "./session-snapshot";

export const mapPendingInstallationInputSchema = z
  .object({
    shop: z
      .string()
      .max(255)
      .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    storeId: z.string().min(1).max(191),
    pendingInstallationId: z.string().min(1).max(64),
    expectedInstallationGeneration: z.string().min(1).max(64),
    expectedRevision: z.number().int().positive().max(2147483646),
    expectedStoreAccessRevision: z.number().int().positive().max(2147483646),
    operator: z.string().trim().min(1).max(191),
    reason: z.string().trim().min(1).max(500),
    apply: z.boolean().default(false),
  })
  .strict();

// Trusted local CLI only. Mapping is not approval and never creates a project,
// program, store, credential projection, or loyalty account. The target must
// have been provisioned separately with the exact reviewed generation.
export async function mapPendingInstallationInTransaction(
  tx: Prisma.TransactionClient,
  input: unknown,
) {
  const options = mapPendingInstallationInputSchema.parse(input);
  const scope = configuredShopifySessionScope(options.shop);
  const store = await lockShopifySessionLifecycle({
    tx,
    shop: options.shop,
    storeId: options.storeId,
  });
  if (
    !store ||
    store.installationGeneration !== options.expectedInstallationGeneration
  )
    throw new Error("Pending installation target generation does not match");
  const [access] = await tx.$queryRaw<
    Array<{ storeAccessState: string; storeAccessRevision: number }>
  >(Prisma.sql`
    SELECT storeAccessState, storeAccessRevision FROM WeleticShopifyStore
    WHERE id = ${store.id} FOR UPDATE
  `);
  if (
    access?.storeAccessState !== "pending_approval" ||
    access.storeAccessRevision !== options.expectedStoreAccessRevision
  )
    throw new Error(
      "Target store must remain pending at the reviewed revision",
    );
  // Match publication order: store/lifecycle -> coordinator -> admission.
  await observeShopifySessionCoordination(tx, scope);
  const pending = await readPendingInstallation(tx, scope);
  if (
    !pending ||
    pending.id !== options.pendingInstallationId ||
    pending.state !== "pending_approval" ||
    pending.mappedStoreId !== null ||
    pending.installationGeneration !== options.expectedInstallationGeneration ||
    pending.revision !== options.expectedRevision ||
    !pending.authenticatedAt ||
    pending.uninstalledAt ||
    pending.redactedAt
  )
    throw new Error("Pending installation identity or lifecycle changed");
  const result = {
    applied: options.apply,
    state: "mapped" as const,
    revision: pending.revision + 1,
    loyaltyActivated: false as const,
  };
  if (!options.apply) return result;
  const count = await tx.$executeRaw(Prisma.sql`
    UPDATE WeleticShopifyPendingInstallation
    SET mappedStoreId = ${store.id}, state = 'mapped', revision = ${result.revision}, updatedAt = CURRENT_TIMESTAMP(3)
    WHERE id = ${pending.id} AND appId = ${scope.appId}
      AND installationGeneration = ${options.expectedInstallationGeneration}
      AND revision = ${options.expectedRevision} AND state = 'pending_approval'
      AND mappedStoreId IS NULL
  `);
  if (count !== 1)
    throw new Error("Pending installation mapping lost its fence");
  await tx.weleticShopifyPendingInstallationChange.create({
    data: {
      id: randomUUID(),
      pendingInstallationId: pending.id,
      mappedStoreId: store.id,
      installationGeneration: options.expectedInstallationGeneration,
      revision: result.revision,
      operation: "map",
      operator: options.operator,
      reason: options.reason,
    },
  });
  return result;
}

export const mapPendingInstallation = (input: unknown) =>
  prisma.$transaction((tx) => mapPendingInstallationInTransaction(tx, input));
