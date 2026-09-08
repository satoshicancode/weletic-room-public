import type { Prisma } from "@prisma/client";
import { referralConfigurationRequestSchema } from "../loyalty/referral-configuration-contract";
import { manageReferralConfigurationInTransaction } from "../loyalty/referral-configuration-service";
import { RewardDefinitionConflictError } from "../loyalty/rewards";
import { readSettingsCapabilities } from "./settings-capabilities";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";
import { assertShopifyStoreAcceptsOperationalWrites } from "./store-compliance-state";

export async function manageShopifyReferralConfigurationInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = referralConfigurationRequestSchema.parse(request);
  const actor = await authorizeShopifyMerchantInTransaction({
    tx,
    envelope,
    permission:
      data.operation === "read" ? "loyalty.read" : "loyalty.configure",
  });
  if (data.operation !== "read") {
    if (
      data.input.expectedInstallationGeneration !== actor.installationGeneration
    )
      throw new RewardDefinitionConflictError();
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId: actor.storeId,
      expectedInstallationGeneration: actor.installationGeneration,
      action: "loyalty_referral_configuration_write",
    });
  }
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: actor.storeId },
    select: { projectId: true },
  });
  if (!store || store.projectId !== actor.projectId)
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  const capabilities = await readSettingsCapabilities(tx, actor);
  return manageReferralConfigurationInTransaction({
    tx,
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    configure: capabilities.loyalty,
    request: data,
  });
}
