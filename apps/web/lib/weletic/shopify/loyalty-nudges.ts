import type { Prisma } from "@prisma/client";
import {
  loyaltyNudgeRequestSchema,
  loyaltyNudgeResponseSchema,
} from "../loyalty/nudge-contract";
import {
  LoyaltyNudgeConflictError,
  readLoyaltyNudgesInTransaction,
  saveLoyaltyNudgesInTransaction,
} from "../loyalty/nudge-service";
import { readSettingsCapabilities } from "./settings-capabilities";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";
import { assertShopifyStoreAcceptsOperationalWrites } from "./store-compliance-state";

/** Only the signature-verified route may supply this actor envelope. */
export async function manageShopifyLoyaltyNudgesInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = loyaltyNudgeRequestSchema.parse(request);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission:
      data.operation === "read" ? "loyalty.read" : "loyalty.configure",
  });
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: actor.storeId },
    select: { projectId: true },
  });
  if (!store || store.projectId !== actor.projectId)
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  if (data.operation === "save") {
    if (data.expectedInstallationGeneration !== actor.installationGeneration)
      throw new LoyaltyNudgeConflictError();
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId: actor.storeId,
      expectedInstallationGeneration: actor.installationGeneration,
      action: "loyalty_nudges_write",
    });
  }
  const state =
    data.operation === "read"
      ? await readLoyaltyNudgesInTransaction(tx, actor.storeId)
      : await saveLoyaltyNudgesInTransaction({
          tx,
          storeId: actor.storeId,
          installationGeneration: actor.installationGeneration,
          request: data,
        });
  const capabilities = await readSettingsCapabilities(tx, actor);
  return loyaltyNudgeResponseSchema.parse({
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    capabilities: { configure: capabilities.loyalty },
    ...state,
  });
}
