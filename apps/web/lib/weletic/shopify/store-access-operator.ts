import { prisma } from "@/lib/prisma";
import { createWeleticId } from "@/lib/weletic/ids";
import { lockLoyaltyProgramRowIfPresent } from "@/lib/weletic/loyalty/program-write-fence";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { readPendingInstallation } from "./installation-admission";
import { observeShopifySessionCoordination } from "./session-coordination";
import { configuredShopifySessionScope } from "./session-snapshot";
import {
  assertLegacyShopifyCredentialAuthority,
  readStoreOwnedShopifyCredential,
} from "./store-owned-credential";

export const storeAccessChangeInput = z
  .object({
    storeId: z.string().min(1).max(191),
    shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
    expectedInstallationGeneration: z.string().min(1).max(64),
    expectedRevision: z.number().int().positive().max(2147483646),
    nextState: z.enum(["active", "suspended"]),
    operator: z.string().trim().min(1).max(191),
    reason: z.string().trim().min(1).max(500),
    apply: z.boolean().default(false),
  })
  .strict();

// Called only by the local operator CLI. Do not expose through merchant APIs:
// possession of a Shopify owner session is not company-store admission.
export async function changeShopifyStoreAccess(input: unknown) {
  const options = storeAccessChangeInput.parse(input);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        projectId: string;
        shopDomain: string;
        installationGeneration: string | null;
        complianceState: string;
        storeAccessState: "pending_approval" | "active" | "suspended";
        storeAccessRevision: number;
      }>
    >(Prisma.sql`
      SELECT id, projectId, shopDomain, installationGeneration, complianceState,
             storeAccessState, storeAccessRevision
      FROM WeleticShopifyStore WHERE id = ${options.storeId}
      LIMIT 1 FOR UPDATE
    `);
    const store = rows[0];
    if (
      !store ||
      store.id !== options.storeId ||
      store.shopDomain !== options.shopDomain
    ) {
      throw new Error("The exact company store identity does not match.");
    }
    if (
      store.installationGeneration !== options.expectedInstallationGeneration ||
      store.storeAccessRevision !== options.expectedRevision
    ) {
      throw new Error(
        "Store approval changed; inspect the current installation and revision.",
      );
    }
    if (store.complianceState !== "active") {
      throw new Error("Store approval cannot override the privacy lifecycle.");
    }
    if (options.nextState === "active") {
      // Admission is checked under the store lock before the program lock.
      // Legacy company stores without a pending record retain their explicit
      // operator path; a public installation cannot skip its reviewed mapping.
      // Suspension must remain possible even if admission is inconsistent.
      const scope = configuredShopifySessionScope(store.shopDomain);
      await observeShopifySessionCoordination(tx, scope);
      const pending = await readPendingInstallation(tx, scope);
      if (
        pending &&
        (pending.state !== "mapped" ||
          pending.mappedStoreId !== store.id ||
          pending.installationGeneration !== store.installationGeneration ||
          !pending.authenticatedAt ||
          pending.uninstalledAt !== null ||
          pending.redactedAt !== null)
      ) {
        throw new Error(
          "Store approval requires the current reviewed installation mapping.",
        );
      }
      if (pending) {
        const credential = await readStoreOwnedShopifyCredential(tx, {
          ...scope,
          storeId: store.id,
          workspaceId: store.projectId,
          installationGeneration: store.installationGeneration,
        });
        if (!credential)
          throw new Error(
            "Store approval requires fresh Shopify authentication.",
          );
      } else
        await assertLegacyShopifyCredentialAuthority(tx, store.id, scope.appId);
    }
    const blocking = await tx.weleticShopifyComplianceRequest.count({
      where: {
        storeId: store.id,
        requestType: { in: ["app_uninstalled", "shop_redact"] },
        status: { not: "completed" },
      },
    });
    if (blocking)
      throw new Error("Store approval is blocked by pending privacy work.");
    if (store.storeAccessState === options.nextState) {
      throw new Error("The store already has the requested access state.");
    }
    if (
      !["pending_approval", "active", "suspended"].includes(
        store.storeAccessState,
      )
    ) {
      throw new Error("Unknown store access state.");
    }
    await lockLoyaltyProgramRowIfPresent({ tx, storeId: store.id });
    const revision = store.storeAccessRevision + 1;
    const result = {
      storeId: store.id,
      previousState: store.storeAccessState,
      nextState: options.nextState,
      revision,
      applied: options.apply,
    };
    if (!options.apply) return result;
    // Exact scalar CAS avoids Prisma's emulated relation-update traversal;
    // admission does not modify identity or any dependent financial record.
    const updated = await tx.$executeRaw(Prisma.sql`
      UPDATE WeleticShopifyStore
      SET storeAccessState = ${options.nextState}, storeAccessRevision = ${revision}, updatedAt = CURRENT_TIMESTAMP(3)
      WHERE id = ${store.id}
        AND installationGeneration = ${options.expectedInstallationGeneration}
        AND storeAccessRevision = ${options.expectedRevision}
        AND storeAccessState = ${store.storeAccessState}
    `);
    if (updated !== 1)
      throw new Error("Store approval lost its revision fence.");
    await tx.weleticShopifyStoreAccessChange.create({
      data: {
        id: createWeleticId("saccess_"),
        storeId: store.id,
        installationGeneration: options.expectedInstallationGeneration,
        previousState: store.storeAccessState,
        nextState: options.nextState,
        revision,
        operator: options.operator,
        reason: options.reason,
      },
    });
    return result;
  });
}
