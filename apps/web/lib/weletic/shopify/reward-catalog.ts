import type { Prisma } from "@prisma/client";
import {
  rewardCatalogRequestSchema,
  rewardCatalogResponseSchema,
} from "../loyalty/reward-catalog-contract";
import { projectRewardCatalogEntry } from "../loyalty/reward-catalog-projection";
import {
  containRewardCatalogInTransaction,
  readRewardCatalogInTransaction,
  saveRewardCatalogInTransaction,
} from "../loyalty/reward-catalog-service";
import { RewardDefinitionConflictError } from "../loyalty/rewards";
import { readSettingsCapabilities } from "./settings-capabilities";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";
import { assertShopifyStoreAcceptsOperationalWrites } from "./store-compliance-state";

/** Signed route owns the Serializable transaction. Installation is not authority. */
export async function manageShopifyRewardCatalogInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = rewardCatalogRequestSchema.parse(request);
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
      action: "loyalty_reward_catalog_write",
    });
  }
  const store = await tx.weleticShopifyStore.findUnique({
    where: { id: actor.storeId },
    select: { projectId: true },
  });
  if (!store || store.projectId !== actor.projectId)
    throw new ShopifyStaffAuthorizationError("invalid_actor");
  const state =
    data.operation === "read"
      ? await readRewardCatalogInTransaction(tx, actor.storeId)
      : await (
          data.operation === "save"
            ? saveRewardCatalogInTransaction
            : containRewardCatalogInTransaction
        )({
          tx,
          storeId: actor.storeId,
          installationGeneration: actor.installationGeneration,
          input: data.input,
        });
  const capabilities = await readSettingsCapabilities(tx, actor);
  return rewardCatalogResponseSchema.parse({
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    shopCurrency: state.shopCurrency,
    revision: state.revision,
    affectedRewardId:
      "affectedRewardId" in state ? state.affectedRewardId : null,
    capabilities: { configure: capabilities.loyalty },
    rewards: state.rewards.map(projectRewardCatalogEntry),
  });
}
