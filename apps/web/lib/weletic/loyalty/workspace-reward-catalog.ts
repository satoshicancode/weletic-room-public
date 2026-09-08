import { prisma } from "@/lib/prisma";
import { MerchantSettingsError } from "@/lib/weletic/merchant-settings/contracts";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import {
  rewardCatalogRequestSchema,
  rewardCatalogResponseSchema,
} from "./reward-catalog-contract";
import { projectRewardCatalogEntry } from "./reward-catalog-projection";
import {
  containRewardCatalogInTransaction,
  readRewardCatalogInTransaction,
  saveRewardCatalogInTransaction,
} from "./reward-catalog-service";
import type { WorkspaceConfigurationAuthority } from "./workspace-configuration";

/** Authority is supplied by withWorkspace, including narrowed API token scopes. */
export async function manageWorkspaceRewardCatalogInTransaction({
  tx,
  authority,
  request,
}: {
  tx: Prisma.TransactionClient;
  authority: WorkspaceConfigurationAuthority;
  request: unknown;
}) {
  const data = rewardCatalogRequestSchema.parse(request);
  if (
    !authority.permissions.includes(
      data.operation === "read" ? "loyalty.read" : "loyalty.write",
    )
  )
    throw new MerchantSettingsError("forbidden");
  const readStore = () =>
    tx.weleticShopifyStore.findFirst({
      where: {
        projectId: authority.workspaceId,
        complianceState: "active",
        installationGeneration: { not: null },
      },
      select: { id: true, projectId: true, installationGeneration: true },
    });
  let store = await readStore();
  if (
    !store?.installationGeneration ||
    store.projectId !== authority.workspaceId
  )
    throw new MerchantSettingsError("not_found");
  if (data.operation !== "read") {
    if (
      store.installationGeneration !== data.input.expectedInstallationGeneration
    )
      throw new MerchantSettingsError("conflict");
    const storeId = store.id;
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId,
      action: "loyalty_reward_catalog_write",
      expectedInstallationGeneration: data.input.expectedInstallationGeneration,
    });
    store = await readStore();
    if (
      !store ||
      store.id !== storeId ||
      store.projectId !== authority.workspaceId ||
      store.installationGeneration !== data.input.expectedInstallationGeneration
    )
      throw new MerchantSettingsError("conflict");
  }
  const state =
    data.operation === "read"
      ? await readRewardCatalogInTransaction(tx, store.id)
      : await (
          data.operation === "save"
            ? saveRewardCatalogInTransaction
            : containRewardCatalogInTransaction
        )({
          tx,
          storeId: store.id,
          installationGeneration: store.installationGeneration!,
          input: data.input,
        });
  return rewardCatalogResponseSchema.parse({
    storeId: store.id,
    installationGeneration: store.installationGeneration,
    shopCurrency: state.shopCurrency,
    revision: state.revision,
    affectedRewardId:
      "affectedRewardId" in state ? state.affectedRewardId : null,
    capabilities: {
      configure: authority.permissions.includes("loyalty.write"),
    },
    rewards: state.rewards.map(projectRewardCatalogEntry),
  });
}
export function manageWorkspaceRewardCatalog(
  authority: WorkspaceConfigurationAuthority,
  request: unknown,
) {
  return prisma.$transaction(
    (tx) =>
      manageWorkspaceRewardCatalogInTransaction({ tx, authority, request }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
