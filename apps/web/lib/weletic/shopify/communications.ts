import type { Prisma } from "@prisma/client";
import {
  loyaltyCommunicationsRequestSchema,
  loyaltyCommunicationsResponseSchema,
} from "../loyalty/communications-contract";
import {
  readLoyaltyCommunicationsInTransaction,
  saveLoyaltyCommunicationsInTransaction,
} from "../loyalty/communications-service";
import { readSettingsCapabilities } from "./settings-capabilities";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";
import { assertShopifyStoreAcceptsOperationalWrites } from "./store-compliance-state";

export async function manageShopifyCommunicationsInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = loyaltyCommunicationsRequestSchema.parse(request);
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
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId: actor.storeId,
      expectedInstallationGeneration: data.expectedInstallationGeneration,
      action: "loyalty_communications_write",
    });
  }
  const state =
    data.operation === "read"
      ? await readLoyaltyCommunicationsInTransaction(tx, actor.storeId)
      : await saveLoyaltyCommunicationsInTransaction({
          tx,
          storeId: actor.storeId,
          installationGeneration: actor.installationGeneration,
          request: data,
        });
  const capabilities = await readSettingsCapabilities(tx, actor);
  return loyaltyCommunicationsResponseSchema.parse({
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    capabilities: { configure: capabilities.loyalty },
    deliveryIntegration:
      "purchase_signup_birthday_vip_redemption_and_expiry_policies",
    ...state,
  });
}
