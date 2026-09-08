import type { Prisma } from "@prisma/client";
import {
  vipCampaignRequestSchema,
  vipCampaignResponseSchema,
} from "../loyalty/vip-campaign-contract";
import {
  mutateVipCampaignStateInTransaction,
  readVipCampaignStateInTransaction,
  VipCampaignConflictError,
} from "../loyalty/vip-campaign-service";
import { readSettingsCapabilities } from "./settings-capabilities";
import {
  authorizeShopifyMerchantInTransaction,
  ShopifyStaffAuthorizationError,
} from "./staff-authorization";
import { assertShopifyStoreAcceptsOperationalWrites } from "./store-compliance-state";

export async function manageShopifyVipCampaignInTransaction({
  tx,
  envelope,
  request,
}: {
  tx: Prisma.TransactionClient;
  envelope: unknown;
  request: unknown;
}) {
  const data = vipCampaignRequestSchema.parse(request);
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
      throw new VipCampaignConflictError();
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId: actor.storeId,
      expectedInstallationGeneration: actor.installationGeneration,
      action: "loyalty_vip_campaign_write",
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
      ? await readVipCampaignStateInTransaction(tx, actor.storeId)
      : await mutateVipCampaignStateInTransaction({
          tx,
          storeId: actor.storeId,
          installationGeneration: actor.installationGeneration,
          request: data,
        });
  const capabilities = await readSettingsCapabilities(tx, actor);
  return vipCampaignResponseSchema.parse({
    storeId: actor.storeId,
    installationGeneration: actor.installationGeneration,
    revision: state.revision,
    affectedResourceId:
      "affectedResourceId" in state ? state.affectedResourceId : null,
    capabilities: { configure: capabilities.loyalty },
    policy: state.policy,
    tiers: state.tiers,
    campaigns: state.campaigns,
    tierHistory: state.tierHistory,
  });
}
