import { prisma } from "@/lib/prisma";
import { MerchantSettingsError } from "@/lib/weletic/merchant-settings/contracts";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import { referralConfigurationRequestSchema } from "./referral-configuration-contract";
import { manageReferralConfigurationInTransaction } from "./referral-configuration-service";
import type { WorkspaceConfigurationAuthority } from "./workspace-configuration";

export async function manageWorkspaceReferralConfigurationInTransaction({
  tx,
  authority,
  request,
}: {
  tx: Prisma.TransactionClient;
  authority: WorkspaceConfigurationAuthority;
  request: unknown;
}) {
  const data = referralConfigurationRequestSchema.parse(request);
  if (
    !authority.permissions.includes(
      data.operation === "read" ? "loyalty.read" : "loyalty.write",
    )
  )
    throw new MerchantSettingsError("forbidden");
  const readStore = () =>
    tx.weleticShopifyStore.findUnique({
      where: { projectId: authority.workspaceId },
      select: {
        id: true,
        projectId: true,
        installationGeneration: true,
        complianceState: true,
      },
    });
  let store = await readStore();
  if (
    !store?.installationGeneration ||
    store.complianceState !== "active" ||
    store.projectId !== authority.workspaceId
  )
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
      expectedInstallationGeneration: data.input.expectedInstallationGeneration,
      action: "loyalty_referral_configuration_write",
    });
    store = await readStore();
    if (
      !store ||
      store.id !== storeId ||
      store.projectId !== authority.workspaceId ||
      store.installationGeneration !==
        data.input.expectedInstallationGeneration ||
      store.complianceState !== "active"
    )
      throw new MerchantSettingsError("conflict");
  }
  return manageReferralConfigurationInTransaction({
    tx,
    storeId: store.id,
    installationGeneration: store.installationGeneration!,
    configure: authority.permissions.includes("loyalty.write"),
    request: data,
  });
}
export function manageWorkspaceReferralConfiguration(
  authority: WorkspaceConfigurationAuthority,
  request: unknown,
) {
  return prisma.$transaction(
    (tx) =>
      manageWorkspaceReferralConfigurationInTransaction({
        tx,
        authority,
        request,
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
