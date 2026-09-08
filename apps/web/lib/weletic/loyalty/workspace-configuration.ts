import type { PermissionAction } from "@/lib/api/rbac/permissions";
import { prisma } from "@/lib/prisma";
import { MerchantSettingsError } from "@/lib/weletic/merchant-settings/contracts";
import { normalizeCurrency } from "@/lib/weletic/money";
import { assertShopifyStoreAcceptsOperationalWrites } from "@/lib/weletic/shopify/store-compliance-state";
import { Prisma } from "@prisma/client";
import {
  loyaltyConfigurationResponseSchema,
  loyaltyConfigurationUpdateSchema,
  requiresLoyaltyConfigurationOwner,
} from "./configuration-contract";
import {
  readLoyaltyConfigurationInTransaction,
  writeLoyaltyConfigurationInTransaction,
} from "./configuration-service";

/** Only pass authority supplied by withWorkspace, never request body fields.
 * Token scopes may narrow permissions even when the membership role is owner.
 */
export type WorkspaceConfigurationAuthority = {
  workspaceId: string;
  role: string;
  permissions: readonly PermissionAction[];
};

export async function manageWorkspaceLoyaltyConfigurationInTransaction({
  tx,
  authority,
  update,
}: {
  tx: Prisma.TransactionClient;
  authority: WorkspaceConfigurationAuthority;
  update?: unknown;
}) {
  const permission = update === undefined ? "loyalty.read" : "loyalty.write";
  if (!authority.permissions.includes(permission))
    throw new MerchantSettingsError("forbidden");
  const data =
    update === undefined
      ? undefined
      : loyaltyConfigurationUpdateSchema.parse(update);
  const owner = authority.role === "owner";
  if (data && requiresLoyaltyConfigurationOwner(data.settings) && !owner)
    throw new MerchantSettingsError("forbidden");
  const readStore = () =>
    tx.weleticShopifyStore.findFirst({
      where: {
        projectId: authority.workspaceId,
        complianceState: "active",
        installationGeneration: { not: null },
      },
      select: {
        id: true,
        projectId: true,
        installationGeneration: true,
        program: { select: { accountingCurrency: true } },
      },
    });
  let store = await readStore();
  if (
    !store?.installationGeneration ||
    store.projectId !== authority.workspaceId
  )
    throw new MerchantSettingsError("not_found");
  if (data) {
    if (data.expectedInstallationGeneration !== store.installationGeneration)
      throw new MerchantSettingsError("conflict");
    const storeId = store.id;
    await assertShopifyStoreAcceptsOperationalWrites({
      tx,
      storeId,
      action: "loyalty_admin_settings_update",
      expectedInstallationGeneration: data.expectedInstallationGeneration,
    });
    // Check the authoritative workspace binding again after acquiring the fence.
    store = await readStore();
    if (
      !store ||
      store.id !== storeId ||
      store.projectId !== authority.workspaceId ||
      store.installationGeneration !== data.expectedInstallationGeneration
    )
      throw new MerchantSettingsError("conflict");
  }
  const accountingCurrency = normalizeCurrency(
    store.program.accountingCurrency,
  );
  const configuration = data
    ? await writeLoyaltyConfigurationInTransaction({
        tx,
        storeId: store.id,
        accountingCurrency,
        input: data,
      })
    : await readLoyaltyConfigurationInTransaction(tx, store.id);
  const response = loyaltyConfigurationResponseSchema.safeParse({
    storeId: store.id,
    installationGeneration: store.installationGeneration,
    accountingCurrency,
    ...configuration,
    capabilities: {
      configure: authority.permissions.includes("loyalty.write"),
      owner,
    },
  });
  if (!response.success)
    throw new Error("Loyalty configuration is unavailable");
  return response.data;
}

export function manageWorkspaceLoyaltyConfiguration(
  authority: WorkspaceConfigurationAuthority,
  update?: unknown,
) {
  return prisma.$transaction(
    (tx) =>
      manageWorkspaceLoyaltyConfigurationInTransaction({
        tx,
        authority,
        update,
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
