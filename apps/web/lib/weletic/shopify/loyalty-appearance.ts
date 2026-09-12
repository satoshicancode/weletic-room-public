import type { Prisma } from "@prisma/client";
import {
  loyaltyAppearanceRequestSchema,
  loyaltyAppearanceResponseSchema,
} from "../loyalty/appearance-contract";
import {
  LoyaltyAppearanceConflictError,
  readLoyaltyAppearanceInTransaction,
  saveLoyaltyAppearanceInTransaction,
} from "../loyalty/appearance-service";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";
import { assertShopifyStoreAcceptsOperationalWrites } from "./store-compliance-state";

/** The route must verify the signature over actor and request before entering
 * this transaction. Appearance permission cannot change program activation. */
export async function manageShopifyLoyaltyAppearanceInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = loyaltyAppearanceRequestSchema.parse(request);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission: "appearance.configure",
  });
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: actor.storeId },
    select: { projectId: true },
  });
  if (!store || store.projectId !== actor.projectId)
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  if (data.operation === "save") {
    if (data.expectedInstallationGeneration !== actor.installationGeneration)
      throw new LoyaltyAppearanceConflictError();
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId: actor.storeId,
      expectedInstallationGeneration: actor.installationGeneration,
      action: "loyalty_appearance_write",
    });
  }
  const state =
    data.operation === "read"
      ? await readLoyaltyAppearanceInTransaction(tx, actor.storeId)
      : await saveLoyaltyAppearanceInTransaction({
          tx,
          storeId: actor.storeId,
          installationGeneration: actor.installationGeneration,
          request: data,
        });
  return loyaltyAppearanceResponseSchema.parse({
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    capabilities: { configure: true },
    ...state,
  });
}
