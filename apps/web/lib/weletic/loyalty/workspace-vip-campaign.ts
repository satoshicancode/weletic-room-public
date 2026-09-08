import { prisma } from "@/lib/prisma";
import { MerchantSettingsError } from "@/lib/weletic/merchant-settings/contracts";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import {
  vipCampaignRequestSchema,
  vipCampaignResponseSchema,
} from "./vip-campaign-contract";
import {
  mutateVipCampaignStateInTransaction,
  readVipCampaignStateInTransaction,
} from "./vip-campaign-service";
import type { WorkspaceConfigurationAuthority } from "./workspace-configuration";

export async function manageWorkspaceVipCampaignInTransaction({
  tx,
  authority,
  request,
}: {
  tx: Prisma.TransactionClient;
  authority: WorkspaceConfigurationAuthority;
  request: unknown;
}) {
  const data = vipCampaignRequestSchema.parse(request);
  const permission =
    data.operation === "read" ? "loyalty.read" : "loyalty.write";
  if (!authority.permissions.includes(permission))
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
  if (!store?.installationGeneration)
    throw new MerchantSettingsError("not_found");
  if (data.operation !== "read") {
    if (
      data.input.expectedInstallationGeneration !== store.installationGeneration
    )
      throw new MerchantSettingsError("conflict");
    const storeId = store.id;
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId,
      action: "loyalty_vip_campaign_write",
      expectedInstallationGeneration: store.installationGeneration,
    });
    store = await readStore();
    if (
      !store?.installationGeneration ||
      store.id !== storeId ||
      store.installationGeneration !== data.input.expectedInstallationGeneration
    )
      throw new MerchantSettingsError("conflict");
  }
  const state =
    data.operation === "read"
      ? await readVipCampaignStateInTransaction(tx, store.id)
      : await mutateVipCampaignStateInTransaction({
          tx,
          storeId: store.id,
          installationGeneration: store.installationGeneration!,
          request: data,
        });
  return vipCampaignResponseSchema.parse({
    storeId: store.id,
    installationGeneration: store.installationGeneration,
    revision: state.revision,
    affectedResourceId:
      "affectedResourceId" in state ? state.affectedResourceId : null,
    capabilities: {
      configure: authority.permissions.includes("loyalty.write"),
    },
    policy: state.policy,
    tiers: state.tiers,
    campaigns: state.campaigns,
    tierHistory: state.tierHistory,
  });
}

export function manageWorkspaceVipCampaign(
  authority: WorkspaceConfigurationAuthority,
  request: unknown,
) {
  return prisma.$transaction(
    (tx) => manageWorkspaceVipCampaignInTransaction({ tx, authority, request }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
